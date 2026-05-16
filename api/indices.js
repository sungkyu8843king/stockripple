export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');

  const SYMBOLS = [
    { id: 'sp500',  symbol: '^GSPC' },
    { id: 'nasdaq', symbol: '^IXIC' },
    { id: 'dow',    symbol: '^DJI'  },
    { id: 'kospi',  symbol: '^KS11' },
    { id: 'kosdaq', symbol: '^KQ11' },
    { id: 'btc',    symbol: 'BTC-USD' },
    { id: 'gold',   symbol: 'GC=F'   },
    { id: 'oil',    symbol: 'CL=F'   },
    { id: 'usdkrw', symbol: 'KRW=X'  },
    { id: 'vix',    symbol: '^VIX'   },
  ];

  try {
    const tickerStr = SYMBOLS.map(s => encodeURIComponent(s.symbol)).join('%2C');
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${tickerStr}&range=1d&interval=1d`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockRipple/1.0)' },
      signal: AbortSignal.timeout(8000),
    });

    if (!r.ok) throw new Error(`spark HTTP ${r.status}`);
    const spark = await r.json();

    // fallback: use quote API if spark fails
    const quoteUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickerStr}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketChange,previousClose`;
    const qr = await fetch(quoteUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockRipple/1.0)' },
      signal: AbortSignal.timeout(8000),
    });

    let quoteMap = {};
    if (qr.ok) {
      const qData = await qr.json();
      (qData.quoteResponse?.result || []).forEach(q => {
        quoteMap[q.symbol] = q;
      });
    }

    const result = {};
    for (const { id, symbol } of SYMBOLS) {
      const q = quoteMap[symbol];
      if (q) {
        result[id] = {
          price: q.regularMarketPrice,
          changePercent: q.regularMarketChangePercent ?? null,
          change: q.regularMarketChange ?? null,
          prevClose: q.regularMarketPreviousClose ?? q.previousClose ?? null,
        };
      } else {
        result[id] = { price: null, changePercent: null, change: null };
      }
    }

    return res.status(200).json({ ok: true, data: result, ts: Date.now() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
