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

// ─── FMP — 여러 엔드포인트 시도 (무료 티어 호환) ──────────────────
// 단일 티커에 대해 가장 가까운 실적 데이터 가져오기
async function fetchFMPForTicker(sym, key) {
  const tryEndpoint = async (path, parser) => {
    try {
      const url = `https://financialmodelingprep.com${path}${path.includes('?') ? '&' : '?'}apikey=${key}`;
      const r = await fetch(url, { headers: BASE, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return { ok: false, status: r.status };
      const data = await r.json();
      const result = parser(data);
      return { ok: !!result, data: result, raw: Array.isArray(data) ? data.length : (data ? 1 : 0) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // 1) earnings-surprises: 과거 실적 EPS actual + estimate + date
  const surprises = await tryEndpoint(
    `/api/v3/earnings-surprises/${encodeURIComponent(sym)}`,
    (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null;
      // 가장 최근 발표 (date 내림차순)
      const sorted = arr.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
      const latest = sorted[0];
      return {
        symbol: sym,
        date: latest.date,
        eps: latest.actualEarningResult,
        epsEstimated: latest.estimatedEarning,
        revenue: null,
        revenueEstimated: null,
        time: null,
        source: 'surprises',
      };
    }
  );
  if (surprises.ok) return { ok: true, data: surprises.data, source: 'surprises' };

  // 2) income-statement: 분기 손익계산서 (EPS + 매출)
  const income = await tryEndpoint(
    `/api/v3/income-statement/${encodeURIComponent(sym)}?period=quarter&limit=1`,
    (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null;
      const i = arr[0];
      return {
        symbol: sym,
        date: i.date || i.fillingDate || null,
        eps: i.eps ?? i.epsdiluted ?? null,
        epsEstimated: null,
        revenue: i.revenue ?? null,
        revenueEstimated: null,
        time: null,
        source: 'income',
      };
    }
  );
  if (income.ok) return { ok: true, data: income.data, source: 'income', surprisesStatus: surprises.status };

  return { ok: false, surprisesStatus: surprises.status, incomeStatus: income.status };
}

async function fetchFMP(tickers) {
  const key = process.env.FMP_API_KEY;
  if (!key) return { data: null, error: 'no-key', keyLength: 0 };

  // ⓪ 키 유효성 진단 — /quote/AAPL은 항상 무료
  let keyCheck = 'unknown';
  let keyCheckBody = '';
  try {
    const r = await fetch(`https://financialmodelingprep.com/api/v3/quote/AAPL?apikey=${key}`,
      { headers: BASE, signal: AbortSignal.timeout(5000) });
    keyCheck = `${r.status}`;
    if (!r.ok) keyCheckBody = (await r.text().catch(() => '')).slice(0, 200);
  } catch (e) {
    keyCheck = 'error: ' + e.message;
  }

  const results = await Promise.all(tickers.map(t => fetchFMPForTicker(t, key)));
  const bySym = {};
  const statusByTicker = {};
  let count = 0;
  results.forEach((res, i) => {
    const sym = tickers[i];
    if (res.ok && res.data) {
      bySym[sym] = res.data;
      count++;
      statusByTicker[sym] = res.source;
    } else {
      statusByTicker[sym] = `fail (surprises=${res.surprisesStatus}, income=${res.incomeStatus})`;
    }
  });
  return {
    data: bySym,
    error: count ? null : 'all-failed',
    count,
    mode: 'per-symbol-v2',
    statusByTicker,
    keyCheck,
    keyCheckBody,
    keyLength: key.length,
  };
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
    fmp: {
      ok:        !!fmpRes.data,
      error:     fmpRes.error,
      count:     fmpRes.count || 0,
      mode:      fmpRes.mode || null,
      keyLength: fmpRes.keyLength,
      keyCheck:  fmpRes.keyCheck,
      keyCheckBody: fmpRes.keyCheckBody,
      statusByTicker: fmpRes.statusByTicker || null,
    },
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
