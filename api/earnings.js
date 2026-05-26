/**
 * earnings.js — Vercel Edge Function
 * GET /api/earnings            → 기업실적 + 애널리스트 기본 정보
 * GET /api/earnings?type=analyst → 투자의견 (YF insights 엔드포인트 사용)
 *
 * 데이터 전략:
 *  - v8/finance/chart    → 현재가, 회사명 (항상 작동)
 *  - ws/insights/v2      → 목표주가, 투자의견, 밸류에이션, 기술적 전망 (항상 작동)
 *  - v10/quoteSummary    → 실적날짜, EPS, 매출 (크럼 필요, 실패 시 graceful fallback)
 *  - v7/options          → 내재변동성 (실패 시 생략)
 */
export const config = { runtime: 'edge' };

const BASE = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type');
  if (type === 'analyst') return handleAnalyst();
  return handleEarnings();
}

// ─── Crumb (공유 helper) ──────────────────────────────────────────
async function getCrumb() {
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
  return { crumb, cookieStr };
}

// ─── quoteSummary (crumb 있으면 사용, 없어도 graceful 실패) ──────
async function fetchQS(ticker, modules, crumb, cookieStr) {
  const enc  = encodeURIComponent(ticker);
  const mods = encodeURIComponent(modules);
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${enc}?modules=${mods}`,
      { headers: BASE, signal: AbortSignal.timeout(7000) }
    );
    if (r.ok) { const j = await r.json(); const res = j.quoteSummary?.result?.[0]; if (res) return res; }
  } catch {}
  if (crumb) {
    try {
      const r = await fetch(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${enc}?modules=${mods}&crumb=${encodeURIComponent(crumb)}`,
        { headers: { ...BASE, ...(cookieStr ? { Cookie: cookieStr } : {}) }, signal: AbortSignal.timeout(7000) }
      );
      if (r.ok) { const j = await r.json(); const res = j.quoteSummary?.result?.[0]; if (res) return res; }
    } catch {}
  }
  return null;
}

// ─── Nasdaq scraping fallback (EPS 컨센서스 + 다음 실적일) ────────
async function fetchNasdaqEarningsInfo(ticker) {
  if (/\.KS$|\.KQ$/i.test(ticker)) return null;
  try {
    const r = await fetch(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/eps?assetclass=stocks`,
      {
        headers: {
          ...BASE,
          'Accept': 'application/json, text/plain, */*',
          'Origin':  'https://www.nasdaq.com',
          'Referer': 'https://www.nasdaq.com/',
        },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const earnings = j?.data?.earningsPerShare;
    if (!Array.isArray(earnings) || !earnings.length) return null;

    const parse = (s) => {
      if (!s || s === 'N/A') return null;
      const m = String(s).match(/-?\$?([\d.]+)/);
      return m ? parseFloat(m[1]) * (String(s).startsWith('-') ? -1 : 1) : null;
    };

    // Past quarters: actual reported
    // Future quarters: consensus only
    let lastActual = null, nextConsensus = null, nextDate = null;
    for (const e of earnings) {
      const epsActual = parse(e.eps);
      const epsCons   = parse(e.consensusEPSForecast);
      if (epsActual != null && lastActual == null) {
        lastActual = { actual: epsActual, consensus: epsCons, date: e.fiscalQuarterEnd || null };
      }
      if (epsActual == null && epsCons != null && nextConsensus == null) {
        nextConsensus = epsCons;
        nextDate = e.fiscalQuarterEnd || null;
      }
    }

    return { lastActual, nextConsensus, nextDate };
  } catch { return null; }
}

// ─── Yahoo Finance Insights (auth 없이 작동) ─────────────────────
async function fetchInsights(ticker) {
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/ws/insights/v2/finance/insights?symbol=${encodeURIComponent(ticker)}`,
      { headers: BASE, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    return (await r.json())?.finance?.result ?? null;
  } catch { return null; }
}

// ─── v8/chart (auth 없이 작동, 현재가+회사명) ────────────────────
async function fetchChart(ticker) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
      { headers: BASE, signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return null;
    return (await r.json())?.chart?.result?.[0]?.meta ?? null;
  } catch { return null; }
}

// ─── Earnings handler ─────────────────────────────────────────────
async function handleEarnings() {
  const corsH = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
  };

  const TICKERS = ['AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','INTC','QCOM','NFLX','ORCL'];
  const todayStr = new Date().toISOString().split('T')[0];
  const pastDate = new Date(); pastDate.setDate(pastDate.getDate() - 10);
  const futDate  = new Date(); futDate.setDate(futDate.getDate() + 10);
  const pastStr  = pastDate.toISOString().split('T')[0];
  const futStr   = futDate.toISOString().split('T')[0];

  const { crumb, cookieStr } = await getCrumb();

  const enrichTicker = async (ticker) => {
    const enc = encodeURIComponent(ticker);
    let company = ticker, currentPrice = null;
    let date = null, epsActual = null, epsConsensus = null;
    let whisper = null, epsGrowth = null, revEstimate = null;
    let priceTarget = null, targetHigh = null, targetLow = null, recKey = null, iv = null;

    // ① v8/chart — 현재가, 회사명 (항상 작동)
    const chartMeta = await fetchChart(ticker);
    if (chartMeta) {
      company      = chartMeta.shortName || chartMeta.longName || ticker;
      currentPrice = chartMeta.regularMarketPrice ?? null;
    }

    // ② quoteSummary — EPS, 실적날짜 (실패 OK)
    const qs = await fetchQS(ticker, 'calendarEvents,earningsTrend,earningsHistory,financialData', crumb, cookieStr);
    if (qs) {
      const ce = qs.calendarEvents, et = qs.earningsTrend?.trend;
      const eh = qs.earningsHistory?.history || [], fd = qs.financialData;

      if (ce?.earningsDate?.[0]?.fmt) date = ce.earningsDate[0].fmt;

      const recentH = eh
        .filter(h => h.quarter?.fmt >= pastStr && h.quarter?.fmt <= todayStr)
        .sort((a, b) => (b.quarter?.fmt || '').localeCompare(a.quarter?.fmt || ''));
      if (recentH.length) {
        const lt = recentH[0];
        if (!date || date < pastStr) date = lt.quarter?.fmt || date;
        epsActual    = lt.epsActual?.raw   ?? null;
        epsConsensus = lt.epsEstimate?.raw ?? null;
      }

      const cq = et?.find(t => t.period === '0q') || et?.[0];
      if (cq?.earningsEstimate) {
        const est = cq.earningsEstimate;
        if (epsConsensus == null) epsConsensus = est.avg?.raw ?? null;
        whisper   = est.high?.raw ?? null;
        epsGrowth = cq.growth?.raw ?? null;
      }
      if (cq?.revenueEstimate) revEstimate = cq.revenueEstimate.avg?.raw ?? null;

      priceTarget  = fd?.targetMeanPrice?.raw ?? null;
      targetHigh   = fd?.targetHighPrice?.raw ?? null;
      targetLow    = fd?.targetLowPrice?.raw  ?? null;
      if (!currentPrice) currentPrice = fd?.currentPrice?.raw ?? null;
      recKey = fd?.recommendationKey ?? null;
    }

    // ③ insights — 투자의견, 목표주가 (quoteSummary 실패 시 보완, 항상 작동)
    const ins = await fetchInsights(ticker);
    if (ins) {
      const rec = ins.recommendation;
      if (rec) {
        if (!priceTarget) priceTarget = rec.targetPrice ?? null;
        if (!recKey) {
          const rStr = (rec.rating || '').toLowerCase();
          recKey = rStr === 'buy' ? 'buy' : rStr === 'sell' ? 'sell' : rStr === 'hold' ? 'hold' : null;
        }
      }
    }

    // ④ v7/options — 내재변동성 (실패 OK)
    try {
      const r = await fetch(
        `https://query2.finance.yahoo.com/v7/finance/options/${enc}`,
        { headers: BASE, signal: AbortSignal.timeout(5000) }
      );
      if (r.ok) {
        const j = await r.json();
        const opt = j.optionChain?.result?.[0];
        if (opt) {
          const price = opt.quote?.regularMarketPrice ?? currentPrice;
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

    // ⑤ Nasdaq 폴백 — EPS / 다음 실적일 (Yahoo가 막혔을 때만)
    if (!epsConsensus && !epsActual && !date) {
      const nd = await fetchNasdaqEarningsInfo(ticker);
      if (nd) {
        if (nd.lastActual?.actual != null) {
          epsActual    = nd.lastActual.actual;
          epsConsensus = nd.lastActual.consensus ?? epsConsensus;
          date         = nd.lastActual.date || date;
        } else if (nd.nextConsensus != null) {
          epsConsensus = nd.nextConsensus;
          date         = nd.nextDate || date;
        }
      }
    }

    return { ticker, company, date, epsConsensus, epsActual, whisper, epsGrowth, revEstimate,
             priceTarget, targetHigh, targetLow, currentPrice, recKey, iv };
  };

  const enriched = await Promise.allSettled(TICKERS.map(t => enrichTicker(t)));
  const items = enriched
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)
    .filter(it => !it.date || (it.date >= pastStr && it.date <= futStr))
    .sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(a.date) - new Date(b.date);
    });

  return new Response(JSON.stringify({ ok: true, items, source: 'edge', ts: Date.now() }), { headers: corsH });
}

// ─── Analyst handler ──────────────────────────────────────────────
async function handleAnalyst() {
  const corsH = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200',
  };

  const TICKERS = ['AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','QCOM','NFLX'];

  const fetchAnalyst = async (ticker) => {
    const enc = encodeURIComponent(ticker);
    let shortName = ticker, price = null;
    let targetMean = null, recKey = null, valuation = null, techDir = null, provider = null;

    // ① v8/chart — 현재가, 회사명
    const chartMeta = await fetchChart(ticker);
    if (chartMeta) {
      shortName = chartMeta.shortName || chartMeta.longName || ticker;
      price     = chartMeta.regularMarketPrice ?? null;
    }

    // ② insights — 투자의견, 목표주가, 밸류에이션, 기술전망 (항상 작동)
    const ins = await fetchInsights(ticker);
    if (ins) {
      const rec     = ins.recommendation;
      const valInfo = ins.instrumentInfo?.valuation;
      const techInfo = ins.instrumentInfo?.technicalEvents;

      if (rec) {
        targetMean = rec.targetPrice ?? null;
        provider   = rec.provider   ?? null;
        const rStr = (rec.rating || '').toLowerCase();
        recKey = rStr === 'buy' ? 'buy' : rStr === 'sell' ? 'sell' : rStr === 'hold' ? 'hold' : null;
      }

      valuation = valInfo?.description ?? null;   // 'Overvalued' | 'Undervalued' | 'Fairly Valued'
      const iDir = techInfo?.intermediateTermOutlook?.direction;
      const sDir = techInfo?.shortTermOutlook?.direction;
      techDir = iDir || sDir || null;             // 'Bullish' | 'Bearish' | 'Neutral'
    }

    if (!price && !targetMean) return null;

    return {
      ticker, shortName, price, targetMean,
      targetHigh: null, targetLow: null,
      recKey,
      analystCount: null,
      provider,    // e.g. 'Argus Research'
      valuation,   // 'Overvalued' | 'Undervalued'
      techDir,     // 'Bullish' | 'Bearish'
      dist: null,
      recent: [],
    };
  };

  const results = await Promise.allSettled(TICKERS.map(fetchAnalyst));
  const items   = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);

  return new Response(JSON.stringify({ ok: true, items, ts: Date.now() }), { headers: corsH });
}
