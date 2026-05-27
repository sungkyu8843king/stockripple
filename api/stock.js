/**
 * stock.js — stock-price + stock-chart 통합
 *  GET /api/stock?type=price&ticker=X       → 현재가, 시총 (캐시 1시간)
 *  GET /api/stock?type=chart&ticker=X&range=3mo → 차트 데이터 (raw points)
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

// ─── 펀더멘털 (FMP stable API 무료 엔드포인트들 조합 + 자체 계산) ──
async function handleFundamentals(req, res) {
  const { ticker, nocache } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  // nocache=1 이면 캐시 무시 (수동 새로고침용)
  if (nocache) {
    res.setHeader('Cache-Control', 'no-store');
  } else {
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
  }

  // 한국 종목은 FMP 무료 미지원
  if (/\.KS$|\.KQ$/i.test(ticker)) {
    return res.status(200).json({
      ok: false,
      ticker,
      error: '한국 종목은 FMP 무료 티어 미지원',
      hint: '미국 종목(AAPL, MSFT 등)만 펀더멘털 데이터 제공됩니다.',
    });
  }

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

  return res.status(200).json({
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
    source: 'fmp-stable',
    endpointStatus: status,
  });
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
