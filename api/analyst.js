export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  const TICKERS = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN', 'TSLA', 'AMD', 'QCOM', 'NFLX'];

  const fetchAnalyst = async (ticker) => {
    try {
      const encoded = encodeURIComponent(ticker);
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encoded}?modules=recommendationTrend%2CupgradeDowngradeHistory%2CfinancialData`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(7000) });
      if (!r.ok) return null;
      const json = await r.json();
      const qs = json.quoteSummary?.result?.[0];
      if (!qs) return null;

      const rt = qs.recommendationTrend?.trend?.[0];
      const fd = qs.financialData;
      const udHistory = qs.upgradeDowngradeHistory?.history?.slice(0, 4) || [];

      const price       = fd?.currentPrice?.raw    ?? null;
      const targetMean  = fd?.targetMeanPrice?.raw  ?? null;
      const targetHigh  = fd?.targetHighPrice?.raw  ?? null;
      const targetLow   = fd?.targetLowPrice?.raw   ?? null;
      const recKey      = fd?.recommendationKey     ?? null;
      const analystCount = fd?.numberOfAnalystOpinions?.raw ?? null;
      const shortName   = fd?.shortName ?? ticker;

      // Buy/Hold/Sell distribution
      const dist = rt ? {
        strongBuy:  rt.strongBuy  ?? 0,
        buy:        rt.buy        ?? 0,
        hold:       rt.hold       ?? 0,
        sell:       rt.sell       ?? 0,
        strongSell: rt.strongSell ?? 0,
      } : null;

      // Recent analyst actions
      const recent = udHistory.map(h => ({
        firm:      h.firm       || '',
        toGrade:   h.toGrade    || '',
        fromGrade: h.fromGrade  || '',
        action:    h.action     || 'main', // 'up' | 'down' | 'main' | 'init' | 'reit'
        date:      h.epochGradeDate
          ? new Date(h.epochGradeDate * 1000).toISOString().split('T')[0]
          : null,
      }));

      return {
        ticker,
        shortName,
        price,
        targetMean,
        targetHigh,
        targetLow,
        recKey,
        analystCount,
        dist,
        recent,
      };
    } catch { return null; }
  };

  const results = await Promise.allSettled(TICKERS.map(fetchAnalyst));
  const items = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  return res.status(200).json({ ok: true, items, ts: Date.now() });
}
