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
  if (type === 'chart')        return handleChart(req, res);
  if (type === 'fundamentals') return handleFundamentals(req, res);
  if (type === 'investors')    return handleInvestors(req, res);
  return handlePrice(req, res);
}

// ─── 현재가 + 시총 (DB 캐시 1시간) ────────────────────────
async function handlePrice(req, res) {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  const { data: cached } = await supabase
    .from('companies')
    .select('current_price, market_cap, price_updated_at, currency')
    .eq('ticker', ticker)
    .single();

  if (cached?.price_updated_at) {
    const age = Date.now() - new Date(cached.price_updated_at).getTime();
    if (age < 3600000) {
      return res.status(200).json({
        ticker,
        price: cached.current_price,
        marketCap: cached.market_cap,
        currency: cached.currency,
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
    const changePercent = meta.regularMarketChangePercent ?? null;
    const change = meta.regularMarketChange ?? null;

    await supabase.from('companies').update({
      current_price: price,
      market_cap: marketCap,
      currency,
      price_updated_at: new Date().toISOString(),
    }).eq('ticker', ticker);

    return res.status(200).json({ ticker, price, marketCap, currency, changePercent, change, source: 'yahoo' });
  } catch (err) {
    if (cached?.current_price) {
      return res.status(200).json({
        ticker,
        price: cached.current_price,
        marketCap: cached.market_cap,
        currency: cached.currency,
        source: 'cache_fallback',
      });
    }
    return res.status(500).json({ error: err.message });
  }
}

// ─── 펀더멘털 (FMP stable + DB 캐시 24h) ──────────────────────────
const FUND_CACHE_TTL_MS = 24 * 60 * 60 * 1000;  // 24시간

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
      // nocache=1이 아니면 캐시 있는 즉시 반환 (24h 넘었어도 stale 라벨로 표시)
      if (!nocache) {
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

  // 모든 엔드포인트 실패(429 등)면 stale 캐시라도 반환
  const allFailed = !profile && !quote && !incomeQ && !balanceQ && !cashflowQ;
  if (allFailed && cached) {
    const is429 = Object.values(status).some(v => String(v).includes('429'));
    return res.status(200).json({
      ...cached,
      source: 'db-cache-stale',
      cachedAt: new Date(Date.now() - cachedAge).toISOString(),
      cacheAgeHours: Math.round(cachedAge / 3600000 * 10) / 10,
      warning: is429 ? 'FMP 일일 한도 초과 — 캐시 데이터 반환' : 'FMP API 호출 실패 — 캐시 데이터 반환',
      endpointStatus: status,
    });
  }
  if (allFailed) {
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

  // DB 캐시 저장 (다음 24h 동안 FMP 호출 절약)
  try {
    await supabase.from('companies').update({
      fundamentals: fundData,
      fundamentals_updated_at: new Date().toISOString(),
    }).eq('ticker', ticker);
  } catch {}

  return res.status(200).json({
    ...fundData,
    source: 'fmp-stable',
    endpointStatus: status,
  });
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

    return res.status(200).json({
      ok: true,
      ticker,
      currency: 'KRW',
      source: 'naver',
      company: integ?.stockName || null,
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
