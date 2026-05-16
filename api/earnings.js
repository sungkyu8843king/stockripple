export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  // 주요 관심 종목 실적발표 일정
  const WATCH_TICKERS = [
    'AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','INTC','QCOM',
    'NFLX','ORCL','CRM','AVGO','MU','TSM','ASML',
    '005930.KS','000660.KS','035420.KS','051910.KS','035720.KS','005380.KS',
  ];

  try {
    // Yahoo Finance earnings calendar (today ± 7 days)
    const today = new Date();
    const startDate = new Date(today); startDate.setDate(today.getDate() - 3);
    const endDate = new Date(today);   endDate.setDate(today.getDate() + 7);

    const fmt = d => d.toISOString().split('T')[0];
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=earnings&newsCount=0&enableEnhancedTrivialQuery=true`;

    // Use screener for earnings
    const earningsUrl = `https://query2.finance.yahoo.com/v1/finance/screener?formatted=false&lang=ko-KR&region=KR&crumb=&count=25&offset=0`;

    // Fetch individual tickers' earnings dates
    const fetchEarnings = async (ticker) => {
      try {
        const encoded = encodeURIComponent(ticker);
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=3mo&range=1y`,
          { headers, signal: AbortSignal.timeout(5000) }
        );
        if (!r.ok) return null;
        const json = await r.json();
        const meta = json.chart?.result?.[0]?.meta;
        if (!meta) return null;
        return {
          ticker,
          name: meta.shortName || meta.longName || ticker,
          currency: meta.currency || 'USD',
          price: meta.regularMarketPrice,
          changePercent: meta.regularMarketChangePercent,
        };
      } catch { return null; }
    };

    // Try Yahoo Finance earnings calendar endpoint
    const calUrl = `https://query1.finance.yahoo.com/v1/finance/visualization/earningscalendar?startDate=${fmt(startDate)}&endDate=${fmt(endDate)}&size=20&offset=0`;
    let calData = [];
    try {
      const cr = await fetch(calUrl, { headers, signal: AbortSignal.timeout(8000) });
      if (cr.ok) {
        const cj = await cr.json();
        calData = cj.finance?.result?.[0]?.rows || [];
      }
    } catch {}

    if (calData.length > 0) {
      const items = calData.slice(0, 15).map(row => ({
        ticker: row.ticker,
        company: row.companyshortName || row.company || row.ticker,
        date: row.startdatetime?.split('T')[0],
        epsEstimate: row.epsestimate,
        epsActual: row.epsactual,
        revenueEstimate: row.revenueestimate,
        revenueActual: row.surprisePercent,
        callTime: row.startdatetimetype, // 'AMC' = after market close, 'BMO' = before market open
      }));
      return res.status(200).json({ ok: true, items, source: 'calendar', ts: Date.now() });
    }

    // Fallback: fetch earnings info from watched tickers
    const subset = WATCH_TICKERS.slice(0, 10);
    const results = await Promise.allSettled(subset.map(fetchEarnings));
    const items = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    return res.status(200).json({ ok: true, items, source: 'tickers', ts: Date.now() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
