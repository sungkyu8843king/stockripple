/**
 * earnings.js — Vercel Edge Function
 * GET /api/earnings            → 기업실적 (FMP 메인 + Yahoo 보조)
 * GET /api/earnings?type=analyst → 투자의견 (Yahoo insights)
 */
export const config = { runtime: 'edge' };

const TICKERS = ['AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','INTC','QCOM','NFLX','ORCL'];

const BASE = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get('type') === 'analyst') return handleAnalyst();
  return handleEarnings();
}

// ─── Yahoo v8/chart: 현재가, 회사명 ─────────────────────────────────
async function fetchChart(ticker) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
      { headers: BASE, signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return j?.chart?.result?.[0]?.meta || null;
  } catch { return null; }
}

// ─── Yahoo insights: 목표가, 투자의견 ─────────────────────────────
async function fetchInsights(ticker) {
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/ws/insights/v2/finance/insights?symbol=${encodeURIComponent(ticker)}`,
      { headers: BASE, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return j?.finance?.result || null;
  } catch { return null; }
}

// ─── FMP Stable API (2025년 9월 이후 신규) ────────────────────────
// 무료 티어 호환 엔드포인트만 사용
async function fetchFMPForTicker(sym, key) {
  const tryEndpoint = async (path, parser) => {
    try {
      const url = `https://financialmodelingprep.com${path}${path.includes('?') ? '&' : '?'}apikey=${key}`;
      const r = await fetch(url, { headers: BASE, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return { ok: false, status: r.status };
      const data = await r.json();
      const result = parser(data);
      return { ok: !!result, data: result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // 1) /stable/earnings — 통합 실적 (유료 402)
  const earnings = await tryEndpoint(
    `/stable/earnings?symbol=${encodeURIComponent(sym)}&limit=8`,
    (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null;
      const todayMs = Date.now();
      const sorted = arr.slice().sort((a,b) => new Date(a.date) - new Date(b.date));
      const future = sorted.find(e => new Date(e.date).getTime() >= todayMs);
      const past   = sorted.filter(e => new Date(e.date).getTime() < todayMs).pop();
      const e = future || past;
      if (!e) return null;
      return {
        symbol: sym, date: e.date,
        eps: e.epsActual ?? e.eps ?? null,
        epsEstimated: e.epsEstimated ?? e.epsEstimate ?? null,
        revenue: e.revenueActual ?? e.revenue ?? null,
        revenueEstimated: e.revenueEstimated ?? e.revenueEstimate ?? null,
        time: null, source: 'stable-earnings',
      };
    }
  );
  if (earnings.ok) return { ok: true, data: earnings.data, source: 'stable-earnings' };

  // 2) /stable/income-statement — 분기 손익계산서 (과거 EPS + 매출)
  const income = await tryEndpoint(
    `/stable/income-statement?symbol=${encodeURIComponent(sym)}&period=quarter&limit=1`,
    (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null;
      const i = arr[0];
      return {
        symbol: sym,
        date: i.date || i.fillingDate || null,
        eps: i.eps ?? i.epsDiluted ?? i.epsdiluted ?? null,
        epsEstimated: null,
        revenue: i.revenue ?? null,
        revenueEstimated: null,
        time: null, source: 'income-statement',
      };
    }
  );
  if (income.ok) return { ok: true, data: income.data, source: 'income-statement' };

  // 3) /stable/key-metrics — TTM 메트릭
  const km = await tryEndpoint(
    `/stable/key-metrics?symbol=${encodeURIComponent(sym)}&period=quarter&limit=1`,
    (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null;
      const k = arr[0];
      return {
        symbol: sym,
        date: k.date || null,
        eps: k.netIncomePerShare ?? k.eps ?? null,
        epsEstimated: null,
        revenue: k.revenuePerShare ? null : (k.revenue ?? null),
        revenueEstimated: null,
        time: null, source: 'key-metrics',
      };
    }
  );
  if (km.ok) return { ok: true, data: km.data, source: 'key-metrics' };

  return {
    ok: false,
    earningsStatus: earnings.status,
    incomeStatus:   income.status,
    kmStatus:       km.status,
  };
}

async function fetchFMP(tickers) {
  const key = process.env.FMP_API_KEY;
  if (!key) return { data: null, error: 'no-key' };

  const results = await Promise.all(tickers.map(t => fetchFMPForTicker(t, key)));
  const bySym = {};
  let count = 0;
  results.forEach((res, i) => {
    if (res.ok && res.data) { bySym[tickers[i]] = res.data; count++; }
  });
  return { data: bySym, error: count ? null : 'all-failed', count };
}

// ─── Earnings handler ─────────────────────────────────────────────
async function handleEarnings() {
  const corsH = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200',
  };

  const fmpRes = await fetchFMP(TICKERS);
  const fmpBySym = fmpRes.data || {};

  const enrich = async (ticker) => {
    const fmp  = fmpBySym[ticker] || null;
    const meta = await fetchChart(ticker);
    const ins  = await fetchInsights(ticker);

    const company      = meta?.shortName || meta?.longName || ticker;
    const currentPrice = meta?.regularMarketPrice ?? null;

    let priceTarget = null, recKey = null;
    if (ins?.recommendation) {
      priceTarget = ins.recommendation.targetPrice ?? null;
      const rStr  = (ins.recommendation.rating || '').toLowerCase();
      recKey = rStr === 'buy' ? 'buy' : rStr === 'sell' ? 'sell' : rStr === 'hold' ? 'hold' : null;
    }

    return {
      ticker,
      company,
      date:         fmp?.date || null,
      epsActual:    fmp?.eps ?? null,
      epsConsensus: fmp?.epsEstimated ?? null,
      revActual:    fmp?.revenue ?? null,
      revEstimate:  fmp?.revenueEstimated ?? null,
      callTime:     fmp?.time === 'bmo' ? 'BMO' : fmp?.time === 'amc' ? 'AMC' : null,
      priceTarget,
      recKey,
      currentPrice,
    };
  };

  const settled = await Promise.allSettled(TICKERS.map(enrich));
  const items = settled
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)
    .sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(a.date) - new Date(b.date);
    });

  return new Response(JSON.stringify({
    ok: true,
    items,
    fmp: { ok: !!fmpRes.data, count: fmpRes.count || 0 },
    ts: Date.now(),
  }), { headers: corsH });
}

// ─── Analyst handler ──────────────────────────────────────────────
async function handleAnalyst() {
  const corsH = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200',
  };

  const ANALYST_TICKERS = ['AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','QCOM','NFLX'];

  const fetchOne = async (ticker) => {
    const meta = await fetchChart(ticker);
    const ins  = await fetchInsights(ticker);

    const shortName = meta?.shortName || meta?.longName || ticker;
    const price     = meta?.regularMarketPrice ?? null;

    let targetMean = null, recKey = null, provider = null, valuation = null, techDir = null;
    if (ins?.recommendation) {
      targetMean = ins.recommendation.targetPrice ?? null;
      provider   = ins.recommendation.provider   ?? null;
      const rStr = (ins.recommendation.rating || '').toLowerCase();
      recKey = rStr === 'buy' ? 'buy' : rStr === 'sell' ? 'sell' : rStr === 'hold' ? 'hold' : null;
    }
    if (ins?.instrumentInfo) {
      valuation = ins.instrumentInfo.valuation?.description ?? null;
      const iDir = ins.instrumentInfo.technicalEvents?.intermediateTermOutlook?.direction;
      const sDir = ins.instrumentInfo.technicalEvents?.shortTermOutlook?.direction;
      techDir = iDir || sDir || null;
    }

    if (!price && !targetMean) return null;

    return {
      ticker, shortName, price, targetMean,
      targetHigh: null, targetLow: null,
      recKey, analystCount: null,
      provider, valuation, techDir,
      dist: null, recent: [],
    };
  };

  const settled = await Promise.allSettled(ANALYST_TICKERS.map(fetchOne));
  const items = settled.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);

  return new Response(JSON.stringify({ ok: true, items, ts: Date.now() }), { headers: corsH });
}
