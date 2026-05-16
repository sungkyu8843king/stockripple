export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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
