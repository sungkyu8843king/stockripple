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
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=5d`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return { id, price: null, changePercent: null, change: null };
      const json = await r.json();
      const result = json.chart?.result?.[0];
      const meta = result?.meta;
      if (!meta) return { id, price: null, changePercent: null, change: null };

      // 일별 종가 시계열 (마지막 값은 장중이면 현재가)
      const closes = (result?.indicators?.quote?.[0]?.close || []).filter(v => v != null);

      const price = meta.regularMarketPrice ?? closes[closes.length - 1] ?? meta.previousClose ?? null;

      // 전일 종가: 시계열의 끝에서 두 번째 값이 정답.
      // KR 지수(^KS11 등)는 meta.previousClose가 null이고 chartPreviousClose는
      // range 시작 이전 종가(며칠 전)라 등락률이 크게 틀어짐 — meta 폴백은 최후에만.
      let prevClose = closes.length >= 2 ? closes[closes.length - 2] : (meta.previousClose ?? null);

      let changePercent = null;
      let change = null;
      if (price != null && prevClose) {
        change = price - prevClose;
        changePercent = (change / prevClose) * 100;
      } else {
        changePercent = meta.regularMarketChangePercent ?? null;
        change = meta.regularMarketChange ?? null;
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
