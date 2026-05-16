export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');

  const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const TICKERS = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN', 'TSLA', 'AMD', 'QCOM', 'NFLX'];

  // Yahoo Finance 크럼 취득
  let crumb = '';
  let cookieStr = '';
  try {
    const consent = await fetch('https://finance.yahoo.com/', {
      headers: BASE_HEADERS,
      signal: AbortSignal.timeout(6000),
    });
    const raw = consent.headers.get('set-cookie') || '';
    cookieStr = raw
      .split(/,(?=[^ ])/)
      .map(s => s.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');

    const cr = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...BASE_HEADERS, Cookie: cookieStr },
      signal: AbortSignal.timeout(5000),
    });
    if (cr.ok) crumb = (await cr.text()).trim();
  } catch {}

  const qsHeaders = { ...BASE_HEADERS, ...(cookieStr ? { Cookie: cookieStr } : {}) };

  const fetchAnalyst = async (ticker) => {
    try {
      const encoded = encodeURIComponent(ticker);
      let url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encoded}?modules=${encodeURIComponent('recommendationTrend,upgradeDowngradeHistory,financialData')}`;
      if (crumb) url += `&crumb=${encodeURIComponent(crumb)}`;

      const r = await fetch(url, { headers: qsHeaders, signal: AbortSignal.timeout(7000) });
      if (!r.ok) return null;
      const json = await r.json();
      const qs = json.quoteSummary?.result?.[0];
      if (!qs) return null;

      const rt = qs.recommendationTrend?.trend?.[0];
      const fd = qs.financialData;
      const udHistory = qs.upgradeDowngradeHistory?.history?.slice(0, 4) || [];

      // 기업명 추가 (v8 chart로 보완)
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

      return {
        ticker,
        shortName,
        price:        fd?.currentPrice?.raw    ?? null,
        targetMean:   fd?.targetMeanPrice?.raw  ?? null,
        targetHigh:   fd?.targetHighPrice?.raw  ?? null,
        targetLow:    fd?.targetLowPrice?.raw   ?? null,
        recKey:       fd?.recommendationKey     ?? null,
        analystCount: fd?.numberOfAnalystOpinions?.raw ?? null,
        dist: rt ? {
          strongBuy:  rt.strongBuy  ?? 0,
          buy:        rt.buy        ?? 0,
          hold:       rt.hold       ?? 0,
          sell:       rt.sell       ?? 0,
          strongSell: rt.strongSell ?? 0,
        } : null,
        recent: udHistory.map(h => ({
          firm:      h.firm      || '',
          toGrade:   h.toGrade   || '',
          fromGrade: h.fromGrade || '',
          action:    h.action    || 'main',
          date:      h.epochGradeDate
            ? new Date(h.epochGradeDate * 1000).toISOString().split('T')[0]
            : null,
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
