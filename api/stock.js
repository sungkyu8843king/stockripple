/**
 * stock.js — stock-price + stock-chart 통합
 *  GET /api/stock?type=price&ticker=X       → 현재가, 시총 (캐시 1시간)
 *  GET /api/stock?type=chart&ticker=X&range=3mo → 차트 데이터 (raw points)
 *  GET /api/stock?type=investors&ticker=005930.KS&count=20 → 투자자별 일별 순매수 (KR 전용)
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const type = (req.query?.type || 'price').toString();
  if (type === 'chart')         return handleChart(req, res);
  if (type === 'fundamentals')  return handleFundamentals(req, res);
  if (type === 'investors')     return handleInvestors(req, res);
  if (type === 'score-factors') return handleScoreFactors(req, res);
  if (type === 'search-kr')     return handleSearchKr(req, res);
  return handlePrice(req, res);
}

// ─── 한국 종목명 검색 (네이버 자동완성 프록시) ──────────────
// companies 테이블은 방문/분석으로 자동등록된 종목만 있는 부분집합이라, "SK네트웍스"
// 처럼 아직 한 번도 등록된 적 없는 종목은 로컬 검색으로 못 찾는다. Yahoo Finance
// 검색은 한글 질의를 잘 못 찾지만(예: "SK네트웍스"→SK하이닉스로 오매칭), 네이버
// 자동완성은 한국 상장사 이름을 정확히 인덱싱하고 있어 이걸로 티커를 알아낸다.
async function handleSearchKr(req, res) {
  const q = (req.query?.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const r = await fetch(
      `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock,index,marketindicator`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return res.status(200).json({ ok: true, items: [] });
    const data = await r.json();
    const items = (data.items || [])
      .filter(it => it.category === 'stock' && it.code && (it.typeCode === 'KOSPI' || it.typeCode === 'KOSDAQ'))
      .map(it => ({
        ticker: `${it.code}.${it.typeCode === 'KOSDAQ' ? 'KQ' : 'KS'}`,
        name: it.name,
        market: 'KR',
      }))
      .slice(0, 10);
    return res.status(200).json({ ok: true, items });
  } catch (e) {
    return res.status(200).json({ ok: true, items: [], error: e.message });
  }
}

// ─── 현재가 + 시총 (DB 캐시 1시간) ────────────────────────
async function handlePrice(req, res) {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  // price_change_pct 컬럼 미적용(마이그레이션 전)에도 죽지 않도록 방어적 select
  let cached;
  {
    const r = await supabase.from('companies')
      .select('current_price, market_cap, price_updated_at, currency, price_change_pct')
      .eq('ticker', ticker).single();
    if (r.error && /price_change_pct/i.test(r.error.message || '')) {
      cached = (await supabase.from('companies')
        .select('current_price, market_cap, price_updated_at, currency')
        .eq('ticker', ticker).single()).data;
    } else {
      cached = r.data;
    }
  }

  if (cached?.price_updated_at) {
    const age = Date.now() - new Date(cached.price_updated_at).getTime();
    const hasChg = cached.price_change_pct != null;
    // 등락률이 이미 있으면 1시간 캐시. 등락률 없는 구버전 캐시는 60초 지나면 새로 받아 채운다
    // (수동 캐시 만료 없이도 자동 치유 — 단 60초 가드로 Yahoo 과호출 방지)
    if (age < 3600000 && (hasChg || age < 60000)) {
      return res.status(200).json({
        ticker,
        price: cached.current_price,
        marketCap: cached.market_cap,
        currency: cached.currency,
        changePercent: cached.price_change_pct ?? null,
        source: 'cache',
      });
    }
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockRipple/1.0)' },
    });
    if (!response.ok) throw new Error(`Yahoo Finance HTTP ${response.status}`);
    const data = await response.json();
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta) throw new Error('No data from Yahoo Finance');

    const price = meta.regularMarketPrice || meta.previousClose;
    const marketCap = meta.marketCap || null;
    const currency = meta.currency || 'USD';
    // Yahoo 차트 API meta에는 regularMarketChangePercent/previousClose가 없다(그건 quote API 필드).
    // 전일 종가(chartPreviousClose)로 당일 등락을 직접 계산한다.
    const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? null;
    let changePercent = meta.regularMarketChangePercent ?? null;
    if (changePercent == null && price != null && prevClose) {
      changePercent = Math.round(((price - prevClose) / prevClose) * 10000) / 100;
    }
    let change = meta.regularMarketChange ?? null;
    if (change == null && price != null && prevClose) {
      change = Math.round((price - prevClose) * 100) / 100;
    }

    const upd = {
      current_price: price,
      market_cap: marketCap,
      currency,
      price_updated_at: new Date().toISOString(),
      price_change_pct: changePercent,
    };
    const ue = (await supabase.from('companies').update(upd).eq('ticker', ticker)).error;
    if (ue && /price_change_pct/i.test(ue.message || '')) {
      delete upd.price_change_pct;   // 마이그레이션 전이면 컬럼 없이 재시도
      await supabase.from('companies').update(upd).eq('ticker', ticker);
    }

    return res.status(200).json({ ticker, price, marketCap, currency, changePercent, change, source: 'yahoo' });
  } catch (err) {
    if (cached?.current_price) {
      return res.status(200).json({
        ticker,
        price: cached.current_price,
        marketCap: cached.market_cap,
        currency: cached.currency,
        changePercent: cached.price_change_pct ?? null,
        source: 'cache_fallback',
      });
    }
    return res.status(500).json({ error: err.message });
  }
}

// ─── 펀더멘털 (FMP stable + DB 캐시 24h) ──────────────────────────
const FUND_CACHE_TTL_MS = 24 * 60 * 60 * 1000;  // 24시간

// FMP 한도 초과(429) 시 기본 밸류에이션 폴백 — Nasdaq은 쿼터 없음
async function fetchNasdaqBasics(ticker) {
  const H = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
  };
  const num = (v) => {
    if (v == null) return null;
    const x = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return isNaN(x) ? null : x;
  };
  try {
    const [sumR, infoR] = await Promise.all([
      fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/summary?assetclass=stocks`, { headers: H, signal: AbortSignal.timeout(6000) }),
      fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/info?assetclass=stocks`, { headers: H, signal: AbortSignal.timeout(6000) }),
    ]);
    const sum  = sumR.ok  ? (await sumR.json())?.data?.summaryData : null;
    const info = infoR.ok ? (await infoR.json())?.data : null;
    if (!sum && !info) return null;
    const val = (o) => (o && typeof o === 'object') ? o.value : o;
    return {
      price:     num(info?.primaryData?.lastSalePrice) ?? num(val(sum?.PreviousClose)),
      marketCap: num(val(sum?.MarketCap)),
      company:   info?.companyName || null,
      sector:    val(sum?.Sector) || null,
      industry:  val(sum?.Industry) || null,
    };
  } catch { return null; }
}

// 새 결과의 null 필드를 기존 캐시 값으로 채움 (부분 실패가 캐시를 오염시키지 않도록)
function mergeFundamentals(fresh, cached) {
  if (!cached) return fresh;
  const out = { ...fresh };
  for (const k of Object.keys(cached)) {
    if (out[k] == null && cached[k] != null) out[k] = cached[k];
  }
  return out;
}

async function handleFundamentals(req, res) {
  const { ticker, nocache } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  if (nocache) res.setHeader('Cache-Control', 'no-store');
  else         res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');

  // 한국 종목은 FMP 무료 미지원 → 네이버 증권 데이터로 제공
  if (/\.KS$|\.KQ$/i.test(ticker)) return handleFundamentalsKR(req, res, ticker);

  // DB 캐시 확인 — nocache가 아니면 캐시 있으면 무조건 사용 (FMP 절약)
  let cached = null;
  let cachedAge = null;
  try {
    const { data } = await supabase
      .from('companies')
      .select('fundamentals, fundamentals_updated_at')
      .eq('ticker', ticker)
      .maybeSingle();
    if (data?.fundamentals && data?.fundamentals_updated_at) {
      cached = data.fundamentals;
      cachedAge = Date.now() - new Date(data.fundamentals_updated_at).getTime();
      // 핵심 수치가 전무한 캐시(과거 부분 실패로 오염)는 조기반환하지 않고 아래서 재시도
      const cacheUsable = cached.marketCap != null || cached.revenue != null || cached.pe != null;
      // nocache=1이 아니면 캐시 있는 즉시 반환 (24h 넘었어도 stale 라벨로 표시)
      if (!nocache && cacheUsable) {
        const isFresh = cachedAge < FUND_CACHE_TTL_MS;
        return res.status(200).json({
          ...cached,
          source: isFresh ? 'db-cache' : 'db-cache-stale',
          cachedAt: data.fundamentals_updated_at,
          cacheAgeHours: Math.round(cachedAge / 3600000 * 10) / 10,
          ...(isFresh ? {} : { warning: '캐시가 오래되었습니다. 🔄 새로고침으로 최신 데이터 가져오기' }),
        });
      }
    }
  } catch {}

  const key = process.env.FMP_API_KEY;
  if (!key) return res.status(500).json({ error: 'FMP_API_KEY missing on server' });

  // 각 엔드포인트별 상태 추적
  const status = {};
  const fmp = async (path, name) => {
    try {
      const url = `https://financialmodelingprep.com${path}${path.includes('?') ? '&' : '?'}apikey=${key}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        status[name] = `HTTP ${r.status}${body.includes('Premium') ? ' (유료)' : ''}`;
        return null;
      }
      const j = await r.json();
      if (Array.isArray(j) ? !j.length : !j) { status[name] = 'empty'; return null; }
      status[name] = 'ok';
      return j;
    } catch (e) {
      status[name] = 'error: ' + e.message;
      return null;
    }
  };

  // 병렬 호출 (5개 무료 엔드포인트)
  const [profile, quote, incomeQ, balanceQ, cashflowQ] = await Promise.all([
    fmp(`/stable/profile?symbol=${encodeURIComponent(ticker)}`, 'profile'),
    fmp(`/stable/quote?symbol=${encodeURIComponent(ticker)}`, 'quote'),
    fmp(`/stable/income-statement?symbol=${encodeURIComponent(ticker)}&period=quarter&limit=5`, 'income'),
    fmp(`/stable/balance-sheet-statement?symbol=${encodeURIComponent(ticker)}&period=quarter&limit=2`, 'balance'),
    fmp(`/stable/cash-flow-statement?symbol=${encodeURIComponent(ticker)}&period=quarter&limit=1`, 'cashflow'),
  ]);

  // 모든 엔드포인트 실패(429 등)면 Nasdaq 기본 시세로 보강 후 stale 캐시라도 반환
  const allFailed = !profile && !quote && !incomeQ && !balanceQ && !cashflowQ;
  if (allFailed && cached) {
    const is429 = Object.values(status).some(v => String(v).includes('429'));
    const nb = await fetchNasdaqBasics(ticker);
    const enriched = nb ? mergeFundamentals({
      ...cached,
      price: nb.price ?? cached.price,
      marketCap: nb.marketCap ?? cached.marketCap,
      company: cached.company || nb.company,
      sector: cached.sector || nb.sector,
      industry: cached.industry || nb.industry,
    }, cached) : cached;
    return res.status(200).json({
      ...enriched,
      source: nb ? 'db-cache-stale+nasdaq' : 'db-cache-stale',
      cachedAt: new Date(Date.now() - cachedAge).toISOString(),
      cacheAgeHours: Math.round(cachedAge / 3600000 * 10) / 10,
      warning: is429 ? 'FMP 일일 한도 초과 — 캐시 데이터 반환' : 'FMP API 호출 실패 — 캐시 데이터 반환',
      endpointStatus: status,
    });
  }
  if (allFailed) {
    // 캐시조차 없으면 Nasdaq 기본 시세라도 반환
    const nb = await fetchNasdaqBasics(ticker);
    if (nb && (nb.price != null || nb.marketCap != null)) {
      return res.status(200).json({
        ok: true, ticker,
        company: nb.company, sector: nb.sector, industry: nb.industry,
        price: nb.price, marketCap: nb.marketCap,
        source: 'nasdaq-basic',
        warning: 'FMP 한도 초과 — Nasdaq 기본 시세만 표시 (재무제표는 한도 리셋 후 새로고침)',
        endpointStatus: status,
      });
    }
    const is429 = Object.values(status).some(v => String(v).includes('429'));
    // 다음 UTC 00:00 = 한국 시간 다음날 09:00
    const now = new Date();
    const nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
    const minsUntilReset = Math.round((nextReset - now) / 60000);
    const hoursUntilReset = Math.round(minsUntilReset / 60 * 10) / 10;
    const resetKstStr = new Date(nextReset.getTime() + 9*3600*1000).toISOString().replace('T', ' ').slice(0, 16) + ' KST';
    return res.status(429).json({
      ok: false, ticker,
      error: is429 ? 'FMP 일일 한도 초과 (250req/day, 무료 티어)' : 'FMP API 호출 실패',
      hint: is429 ? `${hoursUntilReset}시간 후 자동 리셋 (${resetKstStr})` : '잠시 후 재시도',
      resetAt:  nextReset.toISOString(),
      resetKst: resetKstStr,
      minsUntilReset,
      endpointStatus: status,
    });
  }

  const prof = Array.isArray(profile) ? profile[0] : profile;
  const qt   = Array.isArray(quote)   ? quote[0]   : quote;
  const incList = Array.isArray(incomeQ)   ? incomeQ   : [];
  const balList = Array.isArray(balanceQ)  ? balanceQ  : [];
  const cfList  = Array.isArray(cashflowQ) ? cashflowQ : [];

  const inc      = incList[0] || null;
  const incPrev  = incList[1] || null;
  const incYoY   = incList[3] || incList[4] || null;  // 4 분기 전
  const bal      = balList[0] || null;
  const balPrev  = balList[1] || null;
  const cf       = cfList[0]  || null;

  // 안전한 숫자 변환
  const n = v => (v == null || isNaN(Number(v))) ? null : Number(v);
  const pct = (a, b) => (n(a) != null && n(b) != null && n(b) !== 0) ? ((n(a) - n(b)) / Math.abs(n(b)) * 100) : null;
  const safeDiv = (a, b) => (n(a) != null && n(b) != null && n(b) !== 0) ? (n(a) / n(b)) : null;

  const price       = n(qt?.price) || n(prof?.price);
  const marketCap   = n(qt?.marketCap) || n(prof?.mktCap);
  const eps         = n(qt?.eps) || n(qt?.epsTtm);
  const pe          = n(qt?.pe) || safeDiv(price, eps);
  const revenue     = n(inc?.revenue);
  const opIncome    = n(inc?.operatingIncome);
  const netIncome   = n(inc?.netIncome);
  const grossProfit = n(inc?.grossProfit);
  const opMargin    = safeDiv(opIncome, revenue);
  const netMargin   = safeDiv(netIncome, revenue);
  const grossMargin = safeDiv(grossProfit, revenue);

  const totalEquity      = n(bal?.totalStockholdersEquity) || n(bal?.totalEquity);
  const totalAssets      = n(bal?.totalAssets);
  const totalDebt        = n(bal?.totalDebt) || n(bal?.longTermDebt);
  const totalCash        = n(bal?.cashAndCashEquivalents) || n(bal?.cashAndShortTermInvestments);
  const currentAssets    = n(bal?.totalCurrentAssets);
  const currentLiab      = n(bal?.totalCurrentLiabilities);
  const sharesOut        = n(qt?.sharesOutstanding) || n(prof?.sharesOutstanding);

  const bookValuePerShare = safeDiv(totalEquity, sharesOut);
  const pb              = safeDiv(price, bookValuePerShare);
  const ps              = safeDiv(marketCap, revenue ? revenue * 4 : null);  // 분기 매출 × 4 = 연환산
  const roe             = safeDiv(netIncome, totalEquity);
  const roa             = safeDiv(netIncome, totalAssets);
  const debtToEquity    = safeDiv(totalDebt, totalEquity);
  const currentRatio    = safeDiv(currentAssets, currentLiab);

  // 매출 YoY 성장률
  const revYoY  = incYoY ? pct(revenue, incYoY.revenue) : null;
  const niYoY   = incYoY ? pct(netIncome, incYoY.netIncome) : null;
  const opYoY   = incYoY ? pct(opIncome, incYoY.operatingIncome) : null;

  const fcf = cf ? n(cf.freeCashFlow) : null;

  const fundData = {
    ok: true,
    ticker,
    company:    prof?.companyName || qt?.name || null,
    sector:     prof?.sector  || null,
    industry:   prof?.industry || null,
    beta:       n(prof?.beta),
    dividendYield: n(prof?.lastDividend) && price ? n(prof.lastDividend) / price : null,
    // 가격/시총
    price, marketCap, sharesOutstanding: sharesOut,
    // 밸류에이션
    pe, pb, ps, eps,
    // 수익성
    roe:  roe  != null ? roe  * 100 : null,
    roa:  roa  != null ? roa  * 100 : null,
    grossMargin: grossMargin != null ? grossMargin * 100 : null,
    operatingMargin: opMargin != null ? opMargin * 100 : null,
    netMargin: netMargin != null ? netMargin * 100 : null,
    // 재무 안정성
    debtToEquity, currentRatio,
    totalDebt, totalCash, totalEquity, totalAssets,
    // 실적
    revenue, operatingIncome: opIncome, netIncome, grossProfit, freeCashFlow: fcf,
    revenueGrowthYoY:    revYoY,
    netIncomeGrowthYoY:  niYoY,
    operatingGrowthYoY:  opYoY,
    reportDate: inc?.date || inc?.fillingDate || null,
    fiscalPeriod: inc?.period || null,
  };

  // 일부 엔드포인트 실패로 시총/현재가가 비면 Nasdaq으로 보강
  if (fundData.marketCap == null || fundData.price == null) {
    const nb = await fetchNasdaqBasics(ticker);
    if (nb) {
      fundData.price     = fundData.price     ?? nb.price;
      fundData.marketCap = fundData.marketCap ?? nb.marketCap;
      fundData.company   = fundData.company   || nb.company;
      fundData.sector    = fundData.sector    || nb.sector;
      fundData.industry  = fundData.industry  || nb.industry;
    }
  }

  // 기존 캐시와 병합 (이번에 실패한 필드는 기존 값 유지)
  const finalData = mergeFundamentals(fundData, cached);

  // DB 캐시 저장 — 핵심 수치가 있을 때만 (부분 실패 결과로 캐시 오염 방지)
  const hasCore = finalData.marketCap != null || finalData.revenue != null || finalData.pe != null;
  if (hasCore) {
    try {
      await supabase.from('companies').update({
        fundamentals: finalData,
        fundamentals_updated_at: new Date().toISOString(),
      }).eq('ticker', ticker);
    } catch {}
  }

  return res.status(200).json({
    ...finalData,
    source: 'fmp-stable',
    endpointStatus: status,
  });
}

// ─── 매수 후보 스코어링 팩터 배치 (수급 + 펀더멘털) ─────────────────
// GET /api/stock?type=score-factors&tickers=005930.KS,AAPL,...  (최대 24개)
// KR: 네이버 trend(수급 — 외인/기관 5일 누적·연속일) + finance/quarter(펀더멘털)
// US: DB에 캐시된 FMP 펀더멘털만 사용 (FMP 일일 한도를 스코어링에 소모하지 않음)
async function handleScoreFactors(req, res) {
  const tickers = [...new Set(String(req.query.tickers || '').split(',').map(t => t.trim()).filter(Boolean))].slice(0, 24);
  if (!tickers.length) return res.status(400).json({ error: 'tickers required' });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=1800');

  const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; StockRipple/1.0)' };
  const num = v => {
    const n = parseFloat(String(v ?? '').replace(/[+,%원배주\s]/g, ''));
    return isNaN(n) ? null : n;
  };

  const krTickers = tickers.filter(t => /^\d{6}\.(KS|KQ)$/i.test(t));
  const usTickers = tickers.filter(t => !krTickers.includes(t));

  const data = {};

  // ── US: DB 캐시된 펀더멘털 일괄 조회 ──
  const usFundPromise = (async () => {
    if (!usTickers.length) return;
    try {
      const { data: rows } = await supabase.from('companies')
        .select('ticker, fundamentals').in('ticker', usTickers);
      for (const row of rows || []) {
        const f = row.fundamentals;
        if (!f) continue;
        data[row.ticker] = {
          fund: {
            roe: f.roe ?? null,
            opMargin: f.operatingMargin ?? null,
            netMargin: f.netMargin ?? null,
            revYoY: f.revenueGrowthYoY ?? null,
            debtToEquity: f.debtToEquity ?? null,
          },
        };
      }
    } catch {}
  })();

  // ── KR: 종목별 수급(trend) + 분기 펀더멘털 병렬 조회 ──
  const krPromises = krTickers.map(async ticker => {
    const code = ticker.slice(0, 6);
    const out = { flow: null, fund: null };

    const [trend, quart] = await Promise.all([
      fetch(`https://m.stock.naver.com/api/stock/${code}/trend?pageSize=10&page=1`, { headers: HEADERS, signal: AbortSignal.timeout(7000) })
        .then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`https://m.stock.naver.com/api/stock/${code}/finance/quarter`, { headers: HEADERS, signal: AbortSignal.timeout(7000) })
        .then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    if (Array.isArray(trend) && trend.length) {
      const days = trend.map(d => ({
        foreign: num(d.foreignerPureBuyQuant),
        inst: num(d.organPureBuyQuant),
        indiv: num(d.individualPureBuyQuant),
        vol: num(d.accumulatedTradingVolume),
      }));
      const sum5 = k => days.slice(0, 5).reduce((a, d) => a + (d[k] || 0), 0);
      // 최근일부터 같은 방향(순매수/순매도)이 이어진 일수 — 양수=매수 연속, 음수=매도 연속
      const streak = k => {
        let n = 0;
        const sign = Math.sign(days[0]?.[k] || 0);
        if (!sign) return 0;
        for (const d of days) { if (Math.sign(d[k] || 0) === sign) n++; else break; }
        return sign * n;
      };
      const vol5 = days.slice(0, 5).reduce((a, d) => a + (d.vol || 0), 0);
      const smart5 = sum5('foreign') + sum5('inst');
      out.flow = {
        foreign5d: sum5('foreign'),
        inst5d: sum5('inst'),
        indiv5d: sum5('indiv'),
        foreignStreak: streak('foreign'),
        instStreak: streak('inst'),
        // 5일 거래량 대비 외인+기관 순매수 비중(%) — 수급 강도 (종목 크기 무관 비교 가능)
        smartRatio: vol5 ? Math.round(smart5 / vol5 * 1000) / 10 : null,
      };
    }

    const fi = quart?.financeInfo;
    if (fi?.trTitleList?.length && fi?.rowList?.length) {
      const actuals = fi.trTitleList.filter(t => t.isConsensus !== 'Y');
      const last = actuals[actuals.length - 1];
      const yoy  = actuals[actuals.length - 5] || null;
      if (last) {
        const pick = key => {
          const o = {};
          for (const row of fi.rowList) o[row.title] = num(row.columns?.[key]?.value);
          return o;
        };
        const fin = pick(last.key);
        const prev = yoy ? pick(yoy.key) : null;
        const pct = (a, b) => (a != null && b != null && b !== 0) ? Math.round((a - b) / Math.abs(b) * 1000) / 10 : null;
        out.fund = {
          roe: fin['ROE'] ?? null,
          opMargin: fin['영업이익률'] ?? null,
          netMargin: fin['순이익률'] ?? null,
          revYoY: pct(fin['매출액'], prev?.['매출액']),
          debtRatioPct: fin['부채비율'] ?? null,
        };
      }
    }

    if (out.flow || out.fund) data[ticker] = out;
  });

  await Promise.all([usFundPromise, ...krPromises]);
  return res.status(200).json({ ok: true, data });
}

// ─── 펀더멘털 KR (네이버 증권 — integration + finance/quarter) ──────
// FMP 무료 티어가 한국 종목을 지원하지 않아 네이버 데이터로 대체한다.
// 밸류에이션(PER/PBR/EPS/BPS/배당)은 integration, 실적·재무비율은 분기 재무제표에서.
async function handleFundamentalsKR(req, res, ticker) {
  const code = String(ticker).match(/^(\d{6})\./)?.[1];
  if (!code) return res.status(400).json({ ok: false, ticker, error: 'invalid KR ticker' });

  res.setHeader('Cache-Control', req.query.nocache ? 'no-store' : 'public, s-maxage=3600, stale-while-revalidate=86400');

  const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; StockRipple/1.0)' };
  const getJson = async url => {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Naver HTTP ${r.status}`);
    return r.json();
  };

  try {
    const [integ, quart] = await Promise.all([
      getJson(`https://m.stock.naver.com/api/stock/${code}/integration`),
      getJson(`https://m.stock.naver.com/api/stock/${code}/finance/quarter`).catch(() => null),
    ]);

    // "24.53배" / "12,372원" / "0.55%" / "3,336,059" → 숫자
    const num = v => {
      const n = parseFloat(String(v ?? '').replace(/[+,%원배주\s]/g, ''));
      return isNaN(n) ? null : n;
    };
    // "1,774조 3,456억" / "9,053억" → 원 단위
    const krMoney = s => {
      if (!s) return null;
      let t = 0;
      const jo  = String(s).match(/([\d,.]+)\s*조/);
      const eok = String(s).match(/([\d,.]+)\s*억/);
      if (jo)  t += parseFloat(jo[1].replace(/,/g, '')) * 1e12;
      if (eok) t += parseFloat(eok[1].replace(/,/g, '')) * 1e8;
      return t || null;
    };

    const info = {};
    for (const it of integ?.totalInfos || []) info[it.code] = it.value;

    // 분기 재무제표 — 마지막 실적 분기(컨센서스 제외)와 4분기 전(YoY 비교용)
    let fin = null, finPrev = null, fiscalPeriod = null;
    const fi = quart?.financeInfo;
    if (fi?.trTitleList?.length && fi?.rowList?.length) {
      const actuals = fi.trTitleList.filter(t => t.isConsensus !== 'Y');
      const last = actuals[actuals.length - 1];
      const yoy  = actuals[actuals.length - 5] || null;  // 4분기 전
      fiscalPeriod = last ? `${last.title} 분기` : null;
      const pick = key => {
        const out = {};
        for (const row of fi.rowList) out[row.title] = num(row.columns?.[key]?.value);
        return out;
      };
      if (last) fin = pick(last.key);
      if (yoy)  finPrev = pick(yoy.key);
    }

    const pct = (a, b) => (a != null && b != null && b !== 0) ? ((a - b) / Math.abs(b) * 100) : null;
    const eokToKrw = v => v != null ? v * 1e8 : null;

    const marketCap = krMoney(info.marketValue);
    const revenue = eokToKrw(fin?.['매출액']);
    const dividendYieldPct = num(info.dividendYieldRatio);

    // 애널리스트 컨센서스 (네이버 증권 — 국내 증권사 리포트 집계, recommMean 1=적극매수~5=적극매도)
    const cons = integ?.consensusInfo;
    const priceTargetMean = cons?.priceTargetMean ? num(cons.priceTargetMean) : null;
    const recommMean = cons?.recommMean != null ? Number(cons.recommMean) : null;

    // 동종업계 비교 (같은 화면에서 이미 받아온 데이터, 최대 5개)
    // 주의: industryCompareInfo.marketValue는 totalInfos.marketValue("1,730조 4,985억" 텍스트)와 달리
    // "조/억" 단위 표기가 없는 순수 숫자 문자열이며 단위는 백만원(×1e6) — 억원(×1e8)으로 오인하면
    // 시총이 1만 배 부풀려짐 (실측: SK하이닉스 1,568,657,905 × 1e6 ≈ 157조원, 실제 규모와 일치)
    const peers = (integ?.industryCompareInfo || []).slice(0, 5).map(p => ({
      ticker: `${p.itemCode}.${p.sosok === '1' ? 'KQ' : 'KS'}`,
      name: p.stockName,
      price: num(p.closePrice),
      changePercent: num(p.fluctuationsRatio),
      marketCap: num(p.marketValue) != null ? num(p.marketValue) * 1e6 : null,
    })).filter(p => p.price != null);

    return res.status(200).json({
      ok: true,
      ticker,
      currency: 'KRW',
      source: 'naver',
      company: integ?.stockName || null,
      // 당일 시세 (헤더 레인지 바 · 거래량/거래대금용)
      openPrice: num(info.openPrice),
      dayHigh:   num(info.highPrice),
      dayLow:    num(info.lowPrice),
      volume:      num(info.accumulatedTradingVolume),
      tradingValue: krMoney(info.accumulatedTradingValue),
      // 애널리스트 컨센서스 (상승여력%는 프런트에서 화면에 표시 중인 실시간가 기준으로 계산 —
      // Naver 자체 시세와 소폭 어긋날 수 있어 페이지 내 다른 가격 표시와 일관성 유지)
      priceTargetMean,
      recommMean,
      // 동종업계 비교
      peers,
      // 밸류에이션
      marketCap,
      pe:  num(info.per),
      pb:  num(info.pbr),
      eps: num(info.eps),
      bps: num(info.bps),
      ps:  (marketCap && revenue) ? marketCap / (revenue * 4) : null,  // 분기 매출 × 4 연환산
      cnsPer: num(info.cnsPer),
      cnsEps: num(info.cnsEps),
      // 수익성 (분기)
      roe:             fin?.['ROE'] ?? null,
      operatingMargin: fin?.['영업이익률'] ?? null,
      netMargin:       fin?.['순이익률'] ?? null,
      // 재무 안정성 (KR식 %)
      debtRatioPct:      fin?.['부채비율'] ?? null,
      quickRatioPct:     fin?.['당좌비율'] ?? null,
      retentionRatioPct: fin?.['유보율'] ?? null,
      // 실적 (분기, 원 단위)
      revenue,
      operatingIncome: eokToKrw(fin?.['영업이익']),
      netIncome:       eokToKrw(fin?.['당기순이익']),
      revenueGrowthYoY:   pct(fin?.['매출액'],   finPrev?.['매출액']),
      operatingGrowthYoY: pct(fin?.['영업이익'], finPrev?.['영업이익']),
      netIncomeGrowthYoY: pct(fin?.['당기순이익'], finPrev?.['당기순이익']),
      // 배당·기타
      dividendYield: dividendYieldPct != null ? dividendYieldPct / 100 : null,
      dividendPerShare: num(info.dividend),
      high52w: num(info.highPriceOf52Weeks),
      low52w:  num(info.lowPriceOf52Weeks),
      foreignRatePct: num(info.foreignRate),
      fiscalPeriod,
      reportDate: null,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, ticker, error: 'Naver 데이터 조회 실패: ' + err.message });
  }
}

// ─── 투자자별 매매동향 (KR 전용 — 네이버 증권 비공식 API) ──────────
// 개인/기관/외국인 일별 순매수 수량 + 외국인 보유율. 미국 종목은 이런
// 투자자 구분 데이터 자체가 없으므로 ok:false로 응답한다.
async function handleInvestors(req, res) {
  const { ticker, count } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  const m = String(ticker).match(/^(\d{6})\.(KS|KQ)$/i);
  if (!m) {
    return res.status(200).json({
      ok: false, ticker,
      error: '투자자별 매매동향은 한국 종목(.KS/.KQ)만 제공됩니다.',
    });
  }
  const code = m[1];
  const pageSize = Math.min(Math.max(parseInt(count, 10) || 20, 1), 60);

  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');

  try {
    const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/trend?pageSize=${pageSize}&page=1`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockRipple/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`Naver HTTP ${r.status}`);
    const list = await r.json();
    if (!Array.isArray(list)) throw new Error('unexpected response shape');

    // "+6,951,718" / "-5,007,053" / "46.76%" → 숫자
    const num = v => {
      const n = parseFloat(String(v ?? '').replace(/[+,%\s]/g, ''));
      return isNaN(n) ? null : n;
    };

    const days = list.map(d => ({
      date: `${d.bizdate.slice(0, 4)}-${d.bizdate.slice(4, 6)}-${d.bizdate.slice(6, 8)}`,
      close: num(d.closePrice),
      change: num(d.compareToPreviousClosePrice),
      individual: num(d.individualPureBuyQuant),
      institution: num(d.organPureBuyQuant),
      foreign: num(d.foreignerPureBuyQuant),
      foreignHoldRatio: num(d.foreignerHoldRatio),
      volume: num(d.accumulatedTradingVolume),
    }));

    return res.status(200).json({ ok: true, ticker, code, days, source: 'naver' });
  } catch (err) {
    return res.status(500).json({ ok: false, ticker, error: err.message });
  }
}

// ─── 차트 데이터 (일봉 N개월) ─────────────────────────────
async function handleChart(req, res) {
  const { ticker, range = '3mo' } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${range}`;
    const yf = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockRipple/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!yf.ok) throw new Error(`Yahoo Finance HTTP ${yf.status}`);
    const data = await yf.json();
    const result = data.chart?.result?.[0];
    if (!result) throw new Error('No data');

    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const meta = result.meta || {};

    const points = timestamps
      .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
      .filter(p => p.close != null);

    return res.status(200).json({
      ticker,
      currency: meta.currency || 'USD',
      currentPrice: meta.regularMarketPrice || meta.previousClose,
      longName: meta.longName || meta.shortName || ticker,
      points,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
