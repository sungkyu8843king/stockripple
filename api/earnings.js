/**
 * earnings.js — Vercel Edge Function
 * Cloudflare IP로 실행되어 Yahoo Finance IP 차단 우회
 * GET /api/earnings            → 기업실적 발표 일정 + EPS 실적
 * GET /api/earnings?type=analyst → 애널리스트 투자의견
 */
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type');
  if (type === 'analyst') return handleAnalyst();
  return handleEarnings();
}

// ─── Earnings ─────────────────────────────────────────────────────
async function handleEarnings() {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
  };
  const ok  = (data) => new Response(JSON.stringify(data), { headers: corsHeaders });
  const err = (msg)  => new Response(JSON.stringify({ ok: false, error: msg, items: [] }), { headers: corsHeaders });

  const BASE = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const WATCH_TICKERS = [
    'AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','INTC','QCOM','NFLX','ORCL',
  ];

  const today    = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const pastDate = new Date(today); pastDate.setDate(today.getDate() - 10);
  const futDate  = new Date(today); futDate.setDate(today.getDate() + 10);
  const pastStr  = pastDate.toISOString().split('T')[0];
  const futStr   = futDate.toISOString().split('T')[0];

  // Yahoo Finance 크럼 취득
  let crumb = '', cookieStr = '';
  try {
    const consent = await fetch('https://finance.yahoo.com/', {
      headers: BASE, signal: AbortSignal.timeout(8000),
    });
    const raw = consent.headers.get('set-cookie') || '';
    cookieStr = raw.split(/,(?=[^ ])/).map(s => s.split(';')[0].trim()).filter(Boolean).join('; ');
    const cr = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...BASE, Cookie: cookieStr }, signal: AbortSignal.timeout(6000),
    });
    if (cr.ok) crumb = (await cr.text()).trim();
  } catch {}

  const fetchQS = async (ticker, modules) => {
    const enc = encodeURIComponent(ticker);
    const mods = encodeURIComponent(modules);
    // 1차: query1 crumb 없이
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${enc}?modules=${mods}`,
        { headers: BASE, signal: AbortSignal.timeout(8000) }
      );
      if (r.ok) {
        const j = await r.json();
        const res = j.quoteSummary?.result?.[0];
        if (res) return res;
      }
    } catch {}
    // 2차: query2 + crumb
    if (crumb) {
      try {
        const r = await fetch(
          `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${enc}?modules=${mods}&crumb=${encodeURIComponent(crumb)}`,
          { headers: { ...BASE, ...(cookieStr ? { Cookie: cookieStr } : {}) }, signal: AbortSignal.timeout(8000) }
        );
        if (r.ok) {
          const j = await r.json();
          const res = j.quoteSummary?.result?.[0];
          if (res) return res;
        }
      } catch {}
    }
    return null;
  };

  const enrichTicker = async (ticker) => {
    try {
      const qs = await fetchQS(ticker, 'calendarEvents,earningsTrend,earningsHistory,financialData');
      if (!qs) return { ticker, company: ticker };

      const ce = qs.calendarEvents;
      const et = qs.earningsTrend?.trend;
      const eh = qs.earningsHistory?.history || [];
      const fd = qs.financialData;

      let date = ce?.earningsDate?.[0]?.fmt || null;
      let epsActual = null, epsEstimate = null;

      const recentH = eh
        .filter(h => h.quarter?.fmt >= pastStr && h.quarter?.fmt <= todayStr)
        .sort((a, b) => (b.quarter?.fmt || '').localeCompare(a.quarter?.fmt || ''));
      if (recentH.length > 0) {
        const lt = recentH[0];
        if (!date || date < pastStr) date = lt.quarter?.fmt || date;
        epsActual   = lt.epsActual?.raw   ?? null;
        epsEstimate = lt.epsEstimate?.raw  ?? null;
      }

      const currentQ = et?.find(t => t.period === '0q') || et?.[0];
      let epsConsensus = epsEstimate, whisper = null, epsGrowth = null, revEstimate = null;
      if (currentQ?.earningsEstimate) {
        const est = currentQ.earningsEstimate;
        if (epsConsensus == null) epsConsensus = est.avg?.raw ?? null;
        whisper   = est.high?.raw ?? null;
        epsGrowth = currentQ.growth?.raw ?? null;
      }
      if (currentQ?.revenueEstimate) revEstimate = currentQ.revenueEstimate.avg?.raw ?? null;

      // IV
      let iv = null;
      try {
        const optR = await fetch(
          `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}`,
          { headers: BASE, signal: AbortSignal.timeout(6000) }
        );
        if (optR.ok) {
          const optJ = await optR.json();
          const opt  = optJ.optionChain?.result?.[0];
          if (opt) {
            const price = opt.quote?.regularMarketPrice ?? fd?.currentPrice?.raw;
            const calls = opt.options?.[0]?.calls || [];
            if (calls.length && price) {
              const atm = calls.reduce((b, c) =>
                Math.abs(c.strike - price) < Math.abs(b.strike - price) ? c : b);
              if (atm.impliedVolatility != null)
                iv = Math.round(atm.impliedVolatility * 1000) / 10;
            }
          }
        }
      } catch {}

      // 회사명
      let company = ticker;
      try {
        const cr = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
          { headers: BASE, signal: AbortSignal.timeout(5000) }
        );
        if (cr.ok) {
          const cj = await cr.json();
          const m  = cj.chart?.result?.[0]?.meta;
          company  = m?.shortName || m?.longName || ticker;
        }
      } catch {}

      return {
        ticker, company, date, epsConsensus, epsActual, whisper, epsGrowth, revEstimate,
        priceTarget:  fd?.targetMeanPrice?.raw ?? null,
        targetHigh:   fd?.targetHighPrice?.raw ?? null,
        targetLow:    fd?.targetLowPrice?.raw  ?? null,
        currentPrice: fd?.currentPrice?.raw    ?? null,
        recKey:       fd?.recommendationKey    ?? null,
        iv,
      };
    } catch { return { ticker, company: ticker }; }
  };

  const enriched = await Promise.allSettled(WATCH_TICKERS.map(t => enrichTicker(t)));

  let items = enriched
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)
    .filter(it => !it.date || (it.date >= pastStr && it.date <= futStr))
    .sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(a.date) - new Date(b.date);
    });

  return ok({ ok: true, items, source: 'edge', ts: Date.now() });
}

// ─── Analyst ──────────────────────────────────────────────────────
async function handleAnalyst() {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200',
  };

  const BASE = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const TICKERS = ['AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','QCOM','NFLX'];

  let crumb = '', cookieStr = '';
  try {
    const consent = await fetch('https://finance.yahoo.com/', {
      headers: BASE, signal: AbortSignal.timeout(8000),
    });
    const raw = consent.headers.get('set-cookie') || '';
    cookieStr = raw.split(/,(?=[^ ])/).map(s => s.split(';')[0].trim()).filter(Boolean).join('; ');
    const cr = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...BASE, Cookie: cookieStr }, signal: AbortSignal.timeout(6000),
    });
    if (cr.ok) crumb = (await cr.text()).trim();
  } catch {}

  const fetchQS = async (ticker, modules) => {
    const enc  = encodeURIComponent(ticker);
    const mods = encodeURIComponent(modules);
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${enc}?modules=${mods}`,
        { headers: BASE, signal: AbortSignal.timeout(8000) }
      );
      if (r.ok) {
        const j = await r.json();
        const res = j.quoteSummary?.result?.[0];
        if (res) return res;
      }
    } catch {}
    if (crumb) {
      try {
        const r = await fetch(
          `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${enc}?modules=${mods}&crumb=${encodeURIComponent(crumb)}`,
          { headers: { ...BASE, ...(cookieStr ? { Cookie: cookieStr } : {}) }, signal: AbortSignal.timeout(8000) }
        );
        if (r.ok) {
          const j = await r.json();
          const res = j.quoteSummary?.result?.[0];
          if (res) return res;
        }
      } catch {}
    }
    return null;
  };

  const fetchAnalyst = async (ticker) => {
    try {
      const enc = encodeURIComponent(ticker);
      const qs  = await fetchQS(ticker, 'financialData,recommendationTrend,upgradeDowngradeHistory');
      if (!qs) return null;

      const fd  = qs.financialData;
      const rt  = qs.recommendationTrend?.trend?.[0];
      const udh = qs.upgradeDowngradeHistory?.history?.slice(0, 5) || [];

      let shortName = ticker;
      try {
        const cr2 = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1d&range=1d`,
          { headers: BASE, signal: AbortSignal.timeout(5000) }
        );
        if (cr2.ok) {
          const cj  = await cr2.json();
          const meta = cj.chart?.result?.[0]?.meta;
          shortName  = meta?.shortName || meta?.longName || ticker;
        }
      } catch {}

      const price      = fd?.currentPrice?.raw    ?? null;
      const targetMean = fd?.targetMeanPrice?.raw  ?? null;
      const recKey     = fd?.recommendationKey     ?? null;
      if (!price && !targetMean && !rt) return null;

      return {
        ticker, shortName, price, targetMean,
        targetHigh:   fd?.targetHighPrice?.raw ?? null,
        targetLow:    fd?.targetLowPrice?.raw  ?? null,
        recKey,
        analystCount: fd?.numberOfAnalystOpinions?.raw ?? null,
        dist: rt ? {
          strongBuy:  rt.strongBuy  ?? 0,
          buy:        rt.buy        ?? 0,
          hold:       rt.hold       ?? 0,
          sell:       rt.sell       ?? 0,
          strongSell: rt.strongSell ?? 0,
        } : null,
        recent: udh.map(h => ({
          firm:      h.firm      || '',
          toGrade:   h.toGrade   || '',
          fromGrade: h.fromGrade || '',
          action:    h.action    || 'main',
          date:      h.epochGradeDate
            ? new Date(h.epochGradeDate * 1000).toISOString().split('T')[0] : null,
        })),
      };
    } catch { return null; }
  };

  const results = await Promise.allSettled(TICKERS.map(fetchAnalyst));
  const items   = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);

  return new Response(JSON.stringify({ ok: true, items, ts: Date.now() }), { headers: corsHeaders });
}
