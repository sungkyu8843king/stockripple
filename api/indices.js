export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');

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
    { id: 'us10y',  symbol: '^TNX'   },
    { id: 'dxy',    symbol: 'DX-Y.NYB' },
    { id: 'eth',    symbol: 'ETH-USD' },
    { id: 'nikkei', symbol: '^N225'  },
    { id: 'hsi',    symbol: '^HSI'   },
    { id: 'sox',    symbol: '^SOX'   },  // 필라델피아 반도체 지수
    { id: 'nq',     symbol: 'NQ=F'   },  // 나스닥100 선물
  ];

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  const fetchOne = async ({ id, symbol }) => {
    try {
      const encoded = encodeURIComponent(symbol);
      // 일봉(가격·전일종가)과 15분봉(최근 세션 스파크라인)을 병렬 수집
      const [dailyRes, intraRes] = await Promise.allSettled([
        fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=5d`,
          { headers, signal: AbortSignal.timeout(6000) }).then(r => r.ok ? r.json() : null),
        // range=2d: 주말·휴장 시 range=1d는 봉이 거의 없음(선물류) → 마지막 봉 기준 24h 창으로 절단
        fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=15m&range=2d`,
          { headers, signal: AbortSignal.timeout(6000) }).then(r => r.ok ? r.json() : null),
      ]);
      const daily = dailyRes.status === 'fulfilled' ? dailyRes.value : null;
      const intra = intraRes.status === 'fulfilled' ? intraRes.value : null;

      const result = daily?.chart?.result?.[0];
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

      // 스파크라인: 마지막 봉 기준 최근 24시간 창의 15분봉 종가, 최대 24포인트로 다운샘플
      let spark = null;
      const intraResult = intra?.chart?.result?.[0];
      const intraTs = intraResult?.timestamp || [];
      const intraRaw = intraResult?.indicators?.quote?.[0]?.close || [];
      const pts = [];
      for (let i = 0; i < intraRaw.length; i++) {
        if (intraRaw[i] != null && intraTs[i] != null) pts.push({ t: intraTs[i], c: intraRaw[i] });
      }
      if (pts.length >= 3) {
        const lastT = pts[pts.length - 1].t;
        const windowed = pts.filter(p => p.t >= lastT - 24 * 3600).map(p => p.c);
        const src = windowed.length >= 3 ? windowed : pts.map(p => p.c);
        const step = Math.max(1, Math.ceil(src.length / 24));
        spark = src.filter((_, i) => i % step === 0);
        if (spark[spark.length - 1] !== src[src.length - 1]) {
          spark.push(src[src.length - 1]);  // 마지막 값은 항상 포함
        }
        spark = spark.map(v => Number(Number(v).toPrecision(6)));
      }

      return {
        id, price, changePercent, change, prevClose, currency: meta.currency, spark,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
      };
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
