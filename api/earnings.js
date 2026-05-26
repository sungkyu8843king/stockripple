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

// ─── FMP earning_calendar: 실적일정 + EPS + 매출 예상 ────────────
async function fetchFMP(fromStr, toStr) {
  const key = process.env.FMP_API_KEY;
  if (!key) return { data: null, error: 'no-key' };
  try {
    const url = `https://financialmodelingprep.com/api/v3/earning_calendar?from=${fromStr}&to=${toStr}&apikey=${key}`;
    const r = await fetch(url, { headers: BASE, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { data: null, error: 'http-' + r.status };
    const arr = await r.json();
    if (!Array.isArray(arr)) return { data: null, error: 'not-array' };

    // 심볼별로 가장 가까운 미래 일정 우선, 없으면 가장 최근 과거
    const todayMs = Date.now();
    const bySym = {};
    for (const e of arr) {
      if (!e?.symbol || !e?.date) continue;
      const cur = bySym[e.symbol];
      if (!cur) { bySym[e.symbol] = e; continue; }
      const curMs = new Date(cur.date).getTime();
      const newMs = new Date(e.date).getTime();
      const curFuture = curMs >= todayMs;
      const newFuture = newMs >= todayMs;
      if (newFuture && !curFuture) bySym[e.symbol] = e;
      else if (newFuture && curFuture && newMs < curMs) bySym[e.symbol] = e;
      else if (!newFuture && !curFuture && newMs > curMs) bySym[e.symbol] = e;
    }
    return { data: bySym, error: null, count: arr.length };
  } catch (e) {
    return { data: null, error: e.message || 'fetch-failed' };
  }
}

// ─── Earnings handler ─────────────────────────────────────────────
async function handleEarnings() {
  const corsH = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200',
  };

  const pastDate = new Date(); pastDate.setDate(pastDate.getDate() - 14);
  const futDate  = new Date(); futDate.setDate(futDate.getDate() + 21);
  const pastStr  = pastDate.toISOString().split('T')[0];
  const futStr   = futDate.toISOString().split('T')[0];

  // FMP 한 번 호출로 전체 캘린더 수집
  const fmpRes = await fetchFMP(pastStr, futStr);
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
    fmp: { ok: !!fmpRes.data, error: fmpRes.error, count: fmpRes.count || 0 },
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
