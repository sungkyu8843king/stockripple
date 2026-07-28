import { tossProxyConfigured, callTossProxy } from '../lib/toss-proxy.js';

// id → Yahoo 심볼 매핑 (핸들러 본문의 SYMBOLS와 동일한 값 — 차트 히스토리 브랜치가 별도로 참조)
const SYMBOL_MAP = {
  sp500: '^GSPC', nasdaq: '^IXIC', dow: '^DJI', kospi: '^KS11', kosdaq: '^KQ11',
  btc: 'BTC-USD', gold: 'GC=F', oil: 'CL=F', usdkrw: 'KRW=X', vix: '^VIX',
  us10y: '^TNX', dxy: 'DX-Y.NYB', eth: 'ETH-USD', nikkei: '^N225', hsi: '^HSI',
  sox: '^SOX', nq: 'NQ=F',
};

// 세션 앵커 차트(2026-07-28) — 홈 대시보드 차트가 "최근 24시간 창을 24포인트로 다운샘플해
// 폭 전체에 늘려 그리기" 방식이라, 장이 방금 열려 30분치 데이터뿐이어도 하루치가 다 지난
// 것처럼 선이 폭 전체를 채웠다(토스 앱 등 레퍼런스와 비교해 사용자가 지적). 이제 코스피/
// 코스닥/나스닥/다우/S&P500/VIX/SOX/나스닥100선물처럼 "하루 단위 정규 세션"이 뚜렷한
// 지표는 x축을 실제 [세션 시작, 세션 종료] 시각에 고정하고, 장중이면 지금까지 온 데이터만
// 그려서 나머지 폭은 비워둔다(클라이언트가 sessionStart/sessionEnd/sessionLive로 레이아웃).
// 나머지(BTC/금/유가/환율/니케이/항셍 등 24시간 가깝게 돌거나 별도 시간대인 지표)는 기존
// "최근 24시간 롤링 윈도우" 방식을 그대로 쓴다(세션 개념이 뚜렷하지 않거나 대시보드에
// 안 쓰여서 정밀한 세션 계산의 이득이 적음).
const SESSION_MARKET = {
  kospi: 'kr', kosdaq: 'kr',
  nasdaq: 'us', dow: 'us', sp500: 'us', vix: 'us', sox: 'us', nq: 'us',
};

// 휴일 캘린더까지는 안 보되(다른 곳의 mktIsOpen과 동일한 근사 수준), 주말은 최근 평일로
// 되감는다. 반환값은 전부 ms epoch. live=true면 지금이 세션 진행 중이란 뜻 — 클라이언트가
// "지금까지만 그리고 나머지는 비워두기"를 결정하는 데 쓴다.
function computeSessionWindow(mk) {
  const nowMs = Date.now();
  const kstNow = new Date(nowMs + 9 * 3600000);
  const y = kstNow.getUTCFullYear(), mo = kstNow.getUTCMonth(), d = kstNow.getUTCDate();
  const kstMidnightMs = Date.UTC(y, mo, d) - 9 * 3600000; // 오늘 00:00 KST → UTC ms
  const isWeekday = (dow) => dow >= 1 && dow <= 5;

  if (mk === 'kr') {
    const dow = kstNow.getUTCDay();
    const openMs = kstMidnightMs + 9 * 3600000;      // 09:00 KST
    const closeMs = kstMidnightMs + 15.5 * 3600000;  // 15:30 KST
    if (isWeekday(dow) && nowMs >= openMs && nowMs < closeMs) {
      return { start: openMs, end: closeMs, live: true };
    }
    // 세션 밖 — 가장 최근 평일 세션으로 되감기(오늘이 아직 개장 전이면 어제부터 검색)
    let cursorMidnight = nowMs < openMs ? kstMidnightMs - 86400000 : kstMidnightMs;
    let cursorDow = new Date(cursorMidnight + 9 * 3600000).getUTCDay();
    while (!isWeekday(cursorDow)) { cursorMidnight -= 86400000; cursorDow = (cursorDow + 6) % 7; }
    return { start: cursorMidnight + 9 * 3600000, end: cursorMidnight + 15.5 * 3600000, live: false };
  }

  if (mk === 'us') {
    // 미국 정규장 22:30(KST, 전날 저녁)~05:00(KST, 당일 새벽) — 자정을 넘겨 이어진다.
    const todayEveningStart = kstMidnightMs + 22.5 * 3600000; // 오늘 22:30 KST
    const todayMorningEnd = kstMidnightMs + 5 * 3600000;      // 오늘 05:00 KST(어제 저녁 시작분의 끝)
    const yestEveningStart = todayEveningStart - 86400000;
    const yestDow = new Date(yestEveningStart + 9 * 3600000).getUTCDay();
    if (nowMs >= yestEveningStart && nowMs < todayMorningEnd && isWeekday(yestDow)) {
      return { start: yestEveningStart, end: todayMorningEnd, live: nowMs < todayMorningEnd };
    }
    const todayDow = kstNow.getUTCDay();
    if (nowMs >= todayEveningStart && isWeekday(todayDow)) {
      return { start: todayEveningStart, end: todayEveningStart + 6.5 * 3600000, live: true };
    }
    // 세션 밖(낮 시간대) — 가장 최근에 끝난 세션으로 되감기(주말이면 금요일 저녁 세션까지)
    let cursorStart = yestEveningStart;
    let cursorDow = yestDow;
    while (!isWeekday(cursorDow)) { cursorStart -= 86400000; cursorDow = (cursorDow + 6) % 7; }
    return { start: cursorStart, end: cursorStart + 6.5 * 3600000, live: false };
  }
  return null;
}

// GET /api/indices?chart=nasdaq&range=6mo — 단일 지표의 일봉 히스토리(시장지표 상세페이지 차트용).
// TradingView 무료 임베드가 IXIC/KOSPI/KOSDAQ/VIX/SOX/NQ 등 절반 가까이 심볼을 지원 안 해서
// (2026-07 실측 확인) 자체 차트로 대체 — 이미 신뢰하는 Yahoo 소스라 별도 검증 불필요.
async function handleChartHistory(id, range, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
  const symbol = SYMBOL_MAP[id];
  if (!symbol) return res.status(400).json({ ok: false, error: 'unknown symbol' });
  const safeRange = ['1mo', '3mo', '6mo', '1y'].includes(range) ? range : '6mo';
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${safeRange}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) throw new Error(`yahoo http ${r.status}`);
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    const ts = result?.timestamp || [];
    const q = result?.indicators?.quote?.[0] || {};
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i];
      if (c == null) continue;
      candles.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: c });
    }
    return res.status(200).json({ ok: true, id, symbol, candles });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.query.chart) return handleChartHistory(req.query.chart, req.query.range, res);

  // 홈 대시보드가 1초 간격으로 폴링하지만, 엣지 캐시가 접속자 수와 무관하게 오리진(야후) 호출을
  // 3초에 1회로 묶어준다 — 2026-07-15 팬아웃 사고(quotes 엔드포인트, s-maxage 너무 낮게 잡아
  // 트래픽 증가 시 초당 수십 회로 폭증)와 같은 실수를 반복하지 않도록 너무 낮추지 않을 것.
  res.setHeader('Cache-Control', 'public, s-maxage=3, stale-while-revalidate=10');

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

      // 스파크라인. sparkT(같은 인덱스의 실제 봉 시각, ms epoch)를 항상 같이 내려줘서
      // 클라이언트가 호버/드래그 시 "몇 시였는지" 보여줄 수 있게 한다.
      let spark = null, sparkT = null, sessionStart = null, sessionEnd = null, sessionLive = null;
      const intraResult = intra?.chart?.result?.[0];
      const intraTs = intraResult?.timestamp || [];
      const intraRaw = intraResult?.indicators?.quote?.[0]?.close || [];
      const pts = [];
      for (let i = 0; i < intraRaw.length; i++) {
        if (intraRaw[i] != null && intraTs[i] != null) pts.push({ t: intraTs[i], c: intraRaw[i] });
      }

      const sessionMk = SESSION_MARKET[id];
      if (sessionMk && pts.length) {
        // 세션 앵커 모드: [세션 시작, 세션 종료] 안에 든 봉만 — x축은 클라이언트가 이
        // 구간에 맞춰 그린다(장중이면 지금까지 온 데이터까지만 실제로 그리고 나머지는 공백).
        const win = computeSessionWindow(sessionMk);
        if (win) {
          const inSession = pts.filter(p => p.t * 1000 >= win.start && p.t * 1000 <= win.end);
          if (inSession.length >= 2) {
            spark = inSession.map(p => Number(Number(p.c).toPrecision(6)));
            sparkT = inSession.map(p => p.t * 1000);
            sessionStart = win.start;
            sessionEnd = win.end;
            sessionLive = win.live;
          }
        }
      }
      if (spark == null && pts.length >= 3) {
        // 폴백(세션 앵커 대상이 아니거나 그 구간에 데이터가 모자랄 때): 마지막 봉 기준
        // 최근 24시간 창을 최대 24포인트로 다운샘플해 폭 전체에 그리는 기존 방식.
        const lastT = pts[pts.length - 1].t;
        const windowed = pts.filter(p => p.t >= lastT - 24 * 3600);
        const src = windowed.length >= 3 ? windowed : pts;
        const step = Math.max(1, Math.ceil(src.length / 24));
        let sampled = src.filter((_, i) => i % step === 0);
        if (sampled[sampled.length - 1] !== src[src.length - 1]) {
          sampled.push(src[src.length - 1]);  // 마지막 값은 항상 포함
        }
        spark = sampled.map(p => Number(Number(p.c).toPrecision(6)));
        sparkT = sampled.map(p => p.t * 1000);
      }

      return {
        id, price, changePercent, change, prevClose, currency: meta.currency, spark, sparkT,
        sessionStart, sessionEnd, sessionLive,
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

  await patchKrIndicesFromToss(data);

  return res.status(200).json({ ok: true, data, ts: Date.now() });
}

// KOSPI/KOSDAQ 보정 — Yahoo(^KS11/^KQ11)는 이 환경에서 지수 일봉 히스토리에 이상치 봉이
// 섞여 있어(2026-07-15 종가 7284.41 vs 07-16 종가 6820.60처럼 실제로 있었던 급락 자체는
// 진짜지만) meta.regularMarketPrice가 그날 이후로 갱신되지 않은 채(=07-16 종가를 그대로
// "현재가"로 계속 반환) 다음 영업일 아침에도 이어지는 문제가 있다. 그 결과 "현재가(사실은
// 전전날 종가) vs 전전날의 전일종가"를 비교하게 되어 등락률이 실제(토스 앱 기준 -0.8%대)의
// 8배 가까이(-6.37%) 부풀려짐 — 실측 확인. 토스 공식 라이브가(market-indicators/prices)와
// 지수 일봉 히스토리(market-indicators/{symbol}/candles, 최신순)로 "오늘 이전 마지막 완결
// 거래일" 종가를 직접 골라 price/prevClose/change/changePercent만 덮어쓴다(spark·52주
// 범위는 기존 Yahoo 값 유지 — 이번에 확인된 문제 범위 밖).
const KR_INDEX_TOSS_SYMBOLS = { kospi: 'KOSPI', kosdaq: 'KOSDAQ' };
async function patchKrIndicesFromToss(data) {
  if (!tossProxyConfigured()) return;
  const kstToday = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

  await Promise.all(Object.entries(KR_INDEX_TOSS_SYMBOLS).map(async ([id, symbol]) => {
    try {
      const [pricesData, candlesData] = await Promise.all([
        callTossProxy(`/market-indicators/prices?symbols=${symbol}`),
        callTossProxy(`/market-indicators/${symbol}/candles?interval=1d&count=5`),
      ]);
      const liveItem = (pricesData?.result || []).find(it => it.symbol === symbol);
      const price = liveItem?.lastPrice != null ? Number(liveItem.lastPrice) : (data[id]?.price ?? null);

      // 최신순 캔들 중 "오늘(KST)" 이전 날짜의 첫 캔들 = 마지막으로 완결된 거래일 종가
      const candles = candlesData?.result?.candles || [];
      const prevCandle = candles.find(c => c.timestamp && c.timestamp.slice(0, 10) < kstToday);
      const prevClose = prevCandle?.closePrice != null ? Number(prevCandle.closePrice) : null;

      if (price != null && prevClose) {
        const change = price - prevClose;
        const changePercent = (change / prevClose) * 100;
        data[id] = { ...data[id], price, prevClose, change, changePercent };
      }
    } catch { /* Toss 실패 시 기존 Yahoo 기반 값 그대로 둠(fail-open) */ }
  }));
}
