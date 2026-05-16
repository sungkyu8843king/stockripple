export default async function handler(req, res) {
  const type = req.query?.type;
  if (type === 'analyst') return handleAnalyst(req, res);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');

  const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const WATCH_TICKERS = [
    'AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','INTC','QCOM',
    'NFLX','ORCL','CRM','AVGO','MU',
  ];

  const today    = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const pastDate = new Date(today); pastDate.setDate(today.getDate() - 10);
  const futDate  = new Date(today); futDate.setDate(today.getDate() + 10);
  const pastStr  = pastDate.toISOString().split('T')[0];
  const futStr   = futDate.toISOString().split('T')[0];

  // quoteSummary: query1 없이 크럼 불필요 시도, 실패 시 query2+크럼
  let crumb = '', cookieStr = '';
  try {
    const consent = await fetch('https://finance.yahoo.com/', {
      headers: BASE_HEADERS, signal: AbortSignal.timeout(6000),
    });
    const raw = consent.headers.get('set-cookie') || '';
    cookieStr = raw.split(/,(?=[^ ])/).map(s => s.split(';')[0].trim()).filter(Boolean).join('; ');
    const cr = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...BASE_HEADERS, Cookie: cookieStr }, signal: AbortSignal.timeout(5000),
    });
    if (cr.ok) crumb = (await cr.text()).trim();
  } catch {}

  const fetchQS = async (ticker, modules) => {
    const encoded = encodeURIComponent(ticker);
    // 1st: query1 without crumb
    try {
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encoded}?modules=${encodeURIComponent(modules)}`;
      const r = await fetch(url, { headers: BASE_HEADERS, signal: AbortSignal.timeout(7000) });
      if (r.ok) {
        const j = await r.json();
        const result = j.quoteSummary?.result?.[0];
        if (result) return result;
      }
    } catch {}
    // 2nd: query2 with crumb
    if (crumb) {
      try {
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encoded}?modules=${encodeURIComponent(modules)}&crumb=${encodeURIComponent(crumb)}`;
        const r = await fetch(url, {
          headers: { ...BASE_HEADERS, ...(cookieStr ? { Cookie: cookieStr } : {}) },
          signal: AbortSignal.timeout(7000),
        });
        if (r.ok) {
          const j = await r.json();
          const result = j.quoteSummary?.result?.[0];
          if (result) return result;
        }
      } catch {}
    }
    return null;
  };

  const enrichTicker = async (ticker, base = {}) => {
    try {
      const qs = await fetchQS(ticker, 'calendarEvents,earningsTrend,earningsHistory,financialData');
      if (!qs) return base;

      const ce = qs.calendarEvents;
      const et = qs.earningsTrend?.trend;
      const eh = qs.earningsHistory?.history || [];
      const fd = qs.financialData;

      // 날짜: base.date → calendarEvents → earningsHistory 최신
      let date = base.date ?? null;
      let epsActual = base.epsActual ?? null;

      if (!date && ce?.earningsDate?.[0]?.fmt) {
        date = ce.earningsDate[0].fmt;
      }

      // earningsHistory에서 과거 10일 이내 결과 찾기
      const recentH = eh
        .filter(h => h.quarter?.fmt >= pastStr && h.quarter?.fmt <= todayStr)
        .sort((a, b) => (b.quarter?.fmt || '').localeCompare(a.quarter?.fmt || ''));
      if (recentH.length > 0) {
        const latest = recentH[0];
        if (!date || date < pastStr) date = latest.quarter?.fmt || date;
        epsActual = epsActual ?? latest.epsActual?.raw ?? null;
        if (!base.epsEstimate) base = { ...base, epsEstimate: latest.epsEstimate?.raw ?? null };
      }

      // EPS 추정치
      let epsConsensus = base.epsEstimate ?? null;
      let whisper = null, epsGrowth = null, revEstimate = null;
      const currentQ = et?.find(t => t.period === '0q') || et?.[0];
      if (currentQ?.earningsEstimate) {
        const est = currentQ.earningsEstimate;
        if (epsConsensus == null) epsConsensus = est.avg?.raw ?? null;
        whisper   = est.high?.raw ?? null;
        epsGrowth = currentQ.growth?.raw ?? null;
      }
      if (currentQ?.revenueEstimate) {
        revEstimate = currentQ.revenueEstimate.avg?.raw ?? null;
      }

      const priceTarget  = fd?.targetMeanPrice?.raw ?? null;
      const targetHigh   = fd?.targetHighPrice?.raw ?? null;
      const targetLow    = fd?.targetLowPrice?.raw  ?? null;
      const currentPrice = fd?.currentPrice?.raw    ?? null;
      const recKey       = fd?.recommendationKey    ?? null;
      const analystCount = fd?.numberOfAnalystOpinions?.raw ?? null;

      // IV: ATM 콜 내재변동성
      let iv = null;
      try {
        const optR = await fetch(
          `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}`,
          { headers: BASE_HEADERS, signal: AbortSignal.timeout(5000) }
        );
        if (optR.ok) {
          const optJ = await optR.json();
          const opt = optJ.optionChain?.result?.[0];
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

      return { ...base, ticker, date, epsConsensus, epsActual, whisper, epsGrowth,
               revEstimate, priceTarget, targetHigh, targetLow, currentPrice,
               recKey, analystCount, iv };
    } catch { return base; }
  };

  // 티커별 상세 조회 (earningscalendar API 제거 - 불안정하므로)
  const enriched = await Promise.allSettled(
    WATCH_TICKERS.slice(0, 12).map(t => enrichTicker(t, { ticker: t, company: t }))
  );

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

  // company명 보완 (v8 chart API)
  const fillNames = items.filter(it => it.company === it.ticker || !it.company).map(async it => {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(it.ticker)}?interval=1d&range=1d`,
        { headers: BASE_HEADERS, signal: AbortSignal.timeout(4000) }
      );
      if (!r.ok) return;
      const j = await r.json();
      const meta = j.chart?.result?.[0]?.meta;
      if (meta?.shortName || meta?.longName) it.company = meta.shortName || meta.longName;
    } catch {}
  });
  await Promise.allSettled(fillNames);

  return res.status(200).json({ ok: true, items, source: 'tickers', ts: Date.now() });
}

// ─── Analyst ratings (?type=analyst) ─────────────────────────────────────
async function handleAnalyst(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');

  const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const TICKERS = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN', 'TSLA', 'AMD', 'QCOM', 'NFLX'];

  // 크럼 취득 시도 (실패해도 query1으로 폴백)
  let crumb = '', cookieStr = '';
  try {
    const consent = await fetch('https://finance.yahoo.com/', {
      headers: BASE_HEADERS, signal: AbortSignal.timeout(6000),
    });
    const raw = consent.headers.get('set-cookie') || '';
    cookieStr = raw.split(/,(?=[^ ])/).map(s => s.split(';')[0].trim()).filter(Boolean).join('; ');
    const cr = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...BASE_HEADERS, Cookie: cookieStr }, signal: AbortSignal.timeout(5000),
    });
    if (cr.ok) crumb = (await cr.text()).trim();
  } catch {}

  const fetchQS = async (ticker, modules) => {
    const encoded = encodeURIComponent(ticker);
    // query1 without crumb
    try {
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encoded}?modules=${encodeURIComponent(modules)}`;
      const r = await fetch(url, { headers: BASE_HEADERS, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j = await r.json();
        const result = j.quoteSummary?.result?.[0];
        if (result) return result;
      }
    } catch {}
    // query2 with crumb
    if (crumb) {
      try {
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encoded}?modules=${encodeURIComponent(modules)}&crumb=${encodeURIComponent(crumb)}`;
        const r = await fetch(url, {
          headers: { ...BASE_HEADERS, ...(cookieStr ? { Cookie: cookieStr } : {}) },
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          const j = await r.json();
          const result = j.quoteSummary?.result?.[0];
          if (result) return result;
        }
      } catch {}
    }
    return null;
  };

  const fetchAnalyst = async (ticker) => {
    try {
      const encoded = encodeURIComponent(ticker);
      const qs = await fetchQS(ticker, 'financialData,recommendationTrend,upgradeDowngradeHistory');
      if (!qs) return null;

      const fd  = qs.financialData;
      const rt  = qs.recommendationTrend?.trend?.[0];
      const udh = qs.upgradeDowngradeHistory?.history?.slice(0, 5) || [];

      // 회사명은 v8 chart에서
      let shortName = ticker;
      try {
        const cr2 = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=1d`,
          { headers: BASE_HEADERS, signal: AbortSignal.timeout(4000) }
        );
        if (cr2.ok) {
          const cj = await cr2.json();
          const meta = cj.chart?.result?.[0]?.meta;
          shortName = meta?.shortName || meta?.longName || ticker;
        }
      } catch {}

      const price      = fd?.currentPrice?.raw    ?? null;
      const targetMean = fd?.targetMeanPrice?.raw  ?? null;
      const recKey     = fd?.recommendationKey     ?? null;

      if (!price && !targetMean && !rt) return null;

      return {
        ticker,
        shortName,
        price,
        targetMean,
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
  const items = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  return res.status(200).json({ ok: true, items, ts: Date.now() });
}
