export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');

  const SYMBOLS = [
    { id: 'sp500',  symbol: '^GSPC'  },
    { id: 'nasdaq', symbol: '^IXIC'  },
    { id: 'dow',    symbol: '^DJI'   },
    { id: 'kospi',  symbol: '^KS11'  },
    { id: 'kosdaq', symbol: '^KQ11'  },
    { id: 'btc',    symbol: 'BTC-USD'},
    { id: 'gold',   symbol: 'GC=F'   },
    { id: 'oil',    symbol: 'CL=F'   },
    { id: 'usdkrw', symbol: 'KRW=X'  },
    { id: 'vix',    symbol: '^VIX'   },
  ];

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  const fetchOne = async ({ id, symbol }) => {
    try {
      const encoded = encodeURIComponent(symbol);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=2d`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return { id, price: null, changePercent: null, change: null };
      const json = await r.json();
      const meta = json.chart?.result?.[0]?.meta;
      if (!meta) return { id, price: null, changePercent: null, change: null };

      const price = meta.regularMarketPrice ?? meta.previousClose ?? null;
      const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? null;
      let changePercent = meta.regularMarketChangePercent ?? null;
      let change = meta.regularMarketChange ?? null;

      // fallback: calculate from previous close if not provided
      if (changePercent == null && price != null && prevClose != null && prevClose !== 0) {
        change = price - prevClose;
        changePercent = (change / prevClose) * 100;
      }

      return { id, price, changePercent, change, prevClose, currency: meta.currency };
    } catch {
      return { id, price: null, changePercent: null, change: null };
    }
  };

  const results = await Promise.allSettled(SYMBOLS.map(fetchOne));
  const data = {};
  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value) {
      const { id, ...rest } = r.value;
      data[id] = rest;
    }
  });

  return res.status(200).json({ ok: true, data, ts: Date.now() });
}
