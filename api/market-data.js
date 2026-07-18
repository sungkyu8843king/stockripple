/**
 * market-data.js — 시세/기술지표/실적/경제캘린더/시간외 통합 (Vercel Hobby 플랜
 * 서버리스 함수 12개 제한 대응 — quotes/technicals/earnings/market-pulse/
 * kr-overtime 5개를 하나로 합쳐 함수 개수를 줄인다)
 *
 * GET /api/market-data?source=quotes&tickers=...        (구 /api/quotes)
 * GET /api/market-data?source=technicals&tickers=...     (구 /api/technicals)
 * GET /api/market-data?source=earnings[&type=analyst]    (구 /api/earnings)
 * GET /api/market-data?source=market-pulse[&type=trump]  (구 /api/market-pulse)
 * GET /api/market-data?source=kr-overtime&codes=...&session=pre|post (구 /api/kr-overtime)
 * GET /api/market-data?source=us-market&type=actives|gainers|losers  (미장현황 랭킹 — Yahoo 스크리너)
 *
 * 실제 공개 경로(/api/quotes 등)는 vercel.json rewrites로 여기로 연결되며,
 * 프론트엔드 fetch 호출은 전혀 바뀌지 않는다.
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  const source = (req.query.source || '').toString();
  switch (source) {
    case 'quotes':       return handleQuotes(req, res);
    case 'technicals':   return handleTechnicals(req, res);
    case 'earnings':     return (req.query.type === 'analyst') ? handleAnalyst(res) : handleEarnings(res);
    case 'market-pulse':  {
      const type = (req.query.type || 'economic').toString();
      if (type === 'trump') return handleTrump(res);
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 80);
      return handleEconomic(res, limit);
    }
    case 'kr-overtime':  return handleKrOvertime(req, res);
    case 'us-market':    return handleUsMarket(req, res);
    case 'toss': {
      const action = (req.query.action || '').toString();
      if (action === 'prices')          return handleTossPrices(req, res);
      if (action === 'rankings')        return handleTossRankings(req, res);
      if (action === 'rankings-all')    return handleTossRankingsAll(req, res);
      if (action === 'investor-trading') return handleTossInvestorTrading(req, res);
      if (action === 'fx')              return handleTossFx(req, res);
      if (action === 'quote')           return handleTossQuote(req, res);
      if (action === 'orderbook')       return handleTossOrderbook(req, res);
      if (action === 'meta')            return handleTossMeta(req, res);
      if (action === 'daily')           return handleTossDaily(req, res);
      if (action === 'candles')         return handleTossCandles(req, res);
      return handleToss(req, res);
    }
    default:
      return res.status(400).json({ ok: false, error: 'unknown source' });
  }
}

// ════════════════════════════════════════════════════════════════════════
// toss — GET ?source=toss
// 코스피/코스닥/국고채금리(2·3·5·10·20·30년)/원달러환율 — 토스증권 공식 REST API.
// 토스는 IP 화이트리스트를 요구해서 Vercel(고정 IP 없음)에서 직접 호출 불가 —
// 고정 IP를 가진 GCP e2-micro VM(허용목록 등록됨)에 프록시를 세워두고 그걸 경유한다.
// 프록시 URL/시크릿은 TOSS_PROXY_URL/TOSS_PROXY_SECRET 환경변수. 60초 캐시.
// ════════════════════════════════════════════════════════════════════════
// 프록시(GCP VM, 고정 IP) 경유 공통 호출자 — 모든 toss 핸들러가 공유.
function tossProxyConfigured() {
  return !!(process.env.TOSS_PROXY_URL && process.env.TOSS_PROXY_SECRET);
}
async function callTossProxy(path) {
  try {
    const r = await fetch(`${process.env.TOSS_PROXY_URL}${path}`, {
      headers: { 'x-proxy-secret': process.env.TOSS_PROXY_SECRET },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function handleToss(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=180');

  if (!tossProxyConfigured()) {
    return res.status(503).json({ ok: false, error: 'toss proxy not configured' });
  }
  const callProxy = callTossProxy;

  // 미국 정규장은 한국시간 기준 22:30(전날 밤)~05:00(당일 새벽)로 자정을 넘겨 이어진다.
  // Toss 캘린더는 세션을 그 세션이 "속한" 거래일(예: 금요일)에 키잉하므로, 오늘(KST) 날짜만
  // 조회하면 "오늘 새로 시작하는 세션 없음" = 휴장으로 오판한다(토요일 새벽엔 실제로 금요일
  // 세션이 아직 진행 중). 오늘 + 어제(KST) 캘린더를 모두 조회해서 현재 시각을 포함하거나
  // 가장 최근/다음에 해당하는 세션을 고른다.
  const kstNowMs = Date.now();
  const kstToday = new Date(kstNowMs + 9 * 3600000).toISOString().slice(0, 10);
  const kstYest = new Date(kstNowMs + 9 * 3600000 - 86400000).toISOString().slice(0, 10);

  const indicatorSymbols = 'KOSPI,KOSDAQ,KR_BOND_2Y,KR_BOND_3Y,KR_BOND_5Y,KR_BOND_10Y,KR_BOND_20Y,KR_BOND_30Y';
  const [pricesData, fxData, krCal, usCalToday, usCalYest] = await Promise.all([
    callProxy(`/market-indicators/prices?symbols=${indicatorSymbols}`),
    callProxy(`/exchange-rate?baseCurrency=USD&quoteCurrency=KRW`),
    callProxy(`/market-calendar/KR`),
    callProxy(`/market-calendar/US?date=${kstToday}`),
    callProxy(`/market-calendar/US?date=${kstYest}`),
  ]);

  if (!pricesData && !fxData) {
    return res.status(502).json({ ok: false, error: 'toss proxy unreachable' });
  }

  const byId = {};
  for (const item of pricesData?.result || []) {
    byId[item.symbol] = item.lastPrice != null ? Number(item.lastPrice) : null;
  }

  // 장 운영 캘린더 — 세션 객체를 그대로 넘기고(휴장이면 null), 실제 열려있는지 판단은
  // 프론트에서 now와 startTime/endTime을 비교(타임존 오프셋 포함된 ISO라 그대로 비교 가능).
  const kr = krCal?.result;
  const usToday = usCalToday?.result;
  const usYest = usCalYest?.result;
  const krMarket = kr ? {
    isHoliday: !kr.today?.integrated,
    today: kr.today?.date ?? null,
    regularMarket: kr.today?.integrated?.regularMarket ?? null,
    nextBusinessDay: kr.nextBusinessDay?.date ?? null,
  } : null;

  // 휴일(주말)에 date=오늘로 조회하면 Toss가 아예 에러를 내는 경우가 있어(callTossProxy가
  // null로 흡수) usToday가 통째로 비어있을 수 있다 — 그럴 땐 usYest로 완전히 폴백한다.
  const withinSess = sess => sess && kstNowMs >= new Date(sess.startTime).getTime() && kstNowMs < new Date(sess.endTime).getTime();
  const todaySess = usToday?.today?.regularMarket ?? null;
  const yestSess = usYest?.today?.regularMarket ?? null;
  // 어제 세션이 자정을 넘겨 아직 진행 중이면 그걸 쓰고, 아니면 오늘 세션(시작 전이어도) 사용
  const regularMarket = withinSess(yestSess) ? yestSess : (todaySess ?? yestSess ?? null);
  const usBase = usToday || usYest;
  const usMarket = usBase ? {
    isHoliday: !regularMarket,
    today: usToday?.today?.date ?? kstToday,
    regularMarket,
    nextBusinessDay: usToday?.nextBusinessDay?.date ?? usYest?.nextBusinessDay?.date ?? null,
  } : null;

  return res.status(200).json({
    ok: true,
    source: 'toss',
    kospi: byId.KOSPI ?? null,
    kosdaq: byId.KOSDAQ ?? null,
    bonds: {
      y2: byId.KR_BOND_2Y ?? null,
      y3: byId.KR_BOND_3Y ?? null,
      y5: byId.KR_BOND_5Y ?? null,
      y10: byId.KR_BOND_10Y ?? null,
      y20: byId.KR_BOND_20Y ?? null,
      y30: byId.KR_BOND_30Y ?? null,
    },
    usdkrw: fxData?.result?.rate != null ? Number(fxData.result.rate) : null,
    krMarket,
    usMarket,
    updatedAt: new Date().toISOString(),
  });
}

// GET ?source=toss&action=prices&symbols=005930,000660  — 개별 종목 실시간가(토스 공식).
// KR 티커는 .KS/.KQ 접미사를 떼고 6자리 코드로 넘겨야 함(사이트 내부 표기와의 변환은
// 여기서 처리). 짧은 캐시(10초)로 빠른 갱신 + 과호출 방지 둘 다 잡는다.
async function handleTossPrices(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
  if (!tossProxyConfigured()) return res.status(503).json({ ok: false, error: 'toss proxy not configured' });

  const raw = (req.query.symbols || '').toString();
  if (!raw) return res.status(400).json({ ok: false, error: 'symbols required' });
  const siteToToss = {};   // 'AAPL' or '005930.KS' -> 'AAPL' or '005930'
  const tossSymbols = raw.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const bare = s.replace(/\.(KS|KQ)$/i, '');
    siteToToss[s] = bare;
    return bare;
  });

  const data = await callTossProxy(`/prices?symbols=${encodeURIComponent(tossSymbols.join(','))}`);
  if (!data) return res.status(502).json({ ok: false, error: 'toss proxy unreachable' });

  const byBare = {};
  for (const item of data.result || []) {
    byBare[item.symbol] = { price: item.lastPrice != null ? Number(item.lastPrice) : null, timestamp: item.timestamp, currency: item.currency };
  }
  const out = {};
  for (const [site, bare] of Object.entries(siteToToss)) out[site] = byBare[bare] || null;

  return res.status(200).json({ ok: true, source: 'toss', data: out, updatedAt: new Date().toISOString() });
}

// GET ?source=toss&action=rankings&type=TOP_GAINERS&marketCountry=KR&duration=1d&count=20
async function handleTossRankings(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=90');
  if (!tossProxyConfigured()) return res.status(503).json({ ok: false, error: 'toss proxy not configured' });

  const { type = 'TOP_GAINERS', marketCountry = 'KR', duration = '1d', count = '20' } = req.query;
  const data = await callTossProxy(`/rankings?type=${encodeURIComponent(type)}&marketCountry=${encodeURIComponent(marketCountry)}&duration=${encodeURIComponent(duration)}&count=${encodeURIComponent(count)}`);
  if (!data) return res.status(502).json({ ok: false, error: 'toss proxy unreachable' });
  if (data.error) return res.status(400).json({ ok: false, error: data.error.message || 'toss error' });

  const rankings = (data.result?.rankings || []).map(r => ({
    rank: r.rank,
    symbol: r.symbol,
    currency: r.currency,
    price: r.price?.lastPrice != null ? Number(r.price.lastPrice) : null,
    changePercent: r.price?.changeRate != null ? Number(r.price.changeRate) * 100 : null,
    tradingVolume: r.tradingVolume != null ? Number(r.tradingVolume) : null,
    tradingAmount: r.tradingAmount != null ? Number(r.tradingAmount) : null,
  }));

  return res.status(200).json({ ok: true, source: 'toss', rankedAt: data.result?.rankedAt ?? null, rankings });
}

// GET ?source=toss&action=rankings-all&market=KR|US&count=12 — 메인 페이지 실시간 랭킹.
// 5개 카테고리(인기/거래대금/거래량/급상승/급하락)를 한 번에 + 종목명 배치 해석.
// 랭킹 아이템엔 name이 없어(코드만) /stocks로 이름·시장을 함께 조회해 병합한다.
// realtime/1d 전략: 인기·거래대금·거래량은 realtime(장 마감이어도 마지막 정규장 반환),
// 급상승·급하락은 realtime 미지원이라 1d(= 마지막 정규장 세션 기준).
async function handleTossRankingsAll(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // 모든 방문자가 동일 페이로드(시장별 고정 요청) → edge 캐시가 origin 호출을 흡수(레이트리밋 방어).
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=90');
  if (!tossProxyConfigured()) return res.status(503).json({ ok: false, error: 'toss proxy not configured' });

  const market = (req.query.market || 'KR').toString().toUpperCase();
  if (market !== 'KR' && market !== 'US') return res.status(400).json({ ok: false, error: 'market must be KR or US' });
  const count = Math.min(Math.max(parseInt(req.query.count) || 12, 1), 30);

  const CATS = [
    { key: 'popular', type: 'TOSS_SECURITIES_TRADING_AMOUNT', duration: 'realtime' },
    { key: 'amount',  type: 'MARKET_TRADING_AMOUNT',          duration: 'realtime' },
    { key: 'volume',  type: 'MARKET_TRADING_VOLUME',          duration: 'realtime' },
    { key: 'gainers', type: 'TOP_GAINERS',                    duration: '1d' },
    { key: 'losers',  type: 'TOP_LOSERS',                     duration: '1d' },
  ];

  const raw = await Promise.all(CATS.map(c =>
    callTossProxy(`/rankings?type=${c.type}&marketCountry=${market}&duration=${c.duration}&count=${count}`)
  ));
  if (raw.every(d => !d)) return res.status(502).json({ ok: false, error: 'toss proxy unreachable' });

  // 종목명·시장 배치 해석 (랭킹 아이템엔 이름이 없음)
  const symSet = new Set();
  raw.forEach(d => (d?.result?.rankings || []).forEach(r => { if (r.symbol) symSet.add(r.symbol); }));
  const nameMap = {};
  const symList = [...symSet];
  if (symList.length) {
    const stocks = await callTossProxy(`/stocks?symbols=${encodeURIComponent(symList.join(','))}`);
    for (const s of stocks?.result || []) nameMap[s.symbol] = { name: s.name || s.englishName || s.symbol, market: s.market || null };
  }

  const suffix = mk => mk === 'KOSDAQ' ? '.KQ' : '.KS';
  const categories = {};
  CATS.forEach((c, i) => {
    const rankings = raw[i]?.result?.rankings || [];
    categories[c.key] = rankings.map(r => {
      const meta = nameMap[r.symbol] || {};
      return {
        rank: r.rank,
        symbol: r.symbol,
        name: meta.name || r.symbol,
        linkTicker: market === 'KR' ? r.symbol + suffix(meta.market) : r.symbol,
        currency: r.currency,
        price: r.price?.lastPrice != null ? Number(r.price.lastPrice) : null,
        changePercent: r.price?.changeRate != null ? Number(r.price.changeRate) * 100 : null,
        tradingAmount: r.tradingAmount != null ? Number(r.tradingAmount) : null,
        tradingVolume: r.tradingVolume != null ? Number(r.tradingVolume) : null,
      };
    });
  });

  return res.status(200).json({ ok: true, market, categories, updatedAt: new Date().toISOString() });
}

// GET ?source=toss&action=investor-trading&symbol=KOSPI&count=10 — 투자자별 매매대금(공식).
async function handleTossInvestorTrading(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
  if (!tossProxyConfigured()) return res.status(503).json({ ok: false, error: 'toss proxy not configured' });

  const symbol = (req.query.symbol || 'KOSPI').toString().toUpperCase();
  if (symbol !== 'KOSPI' && symbol !== 'KOSDAQ') return res.status(400).json({ ok: false, error: 'symbol must be KOSPI or KOSDAQ' });
  const count = req.query.count || '20';

  const data = await callTossProxy(`/market-indicators/${symbol}/investor-trading?interval=1d&count=${encodeURIComponent(count)}`);
  if (!data) return res.status(502).json({ ok: false, error: 'toss proxy unreachable' });

  const net = amt => amt ? Number(amt.buyAmount) - Number(amt.sellAmount) : null;
  const records = (data.result?.records || []).map(r => ({
    date: r.date,
    individual: net(r.individual),
    foreigner: net(r.foreigner),
    institution: net(r.institution),
    otherCorporation: net(r.otherCorporation),
  }));

  return res.status(200).json({ ok: true, source: 'toss', symbol, records });
}

// GET ?source=toss&action=fx — USD/KRW 환율만 가볍게 (미장 종목 페이지 원화 병기용,
// handleToss 전체 번들을 부르는 것보다 훨씬 가벼움 + 자주 안 바뀌니 캐시도 더 길게).
async function handleTossFx(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
  if (!tossProxyConfigured()) return res.status(503).json({ ok: false, error: 'toss proxy not configured' });

  const data = await callTossProxy('/exchange-rate?baseCurrency=USD&quoteCurrency=KRW');
  if (!data) return res.status(502).json({ ok: false, error: 'toss proxy unreachable' });

  return res.status(200).json({ ok: true, rate: data.result?.rate != null ? Number(data.result.rate) : null });
}

// GET ?source=toss&action=quote&symbol=AAPL — 통합가(Toss lastPrice, 세션 구분 없이 하나) +
// 정규장/시간외 변동 분해(전부 Toss 공식 데이터로 서버에서 계산). Toss /prices는 marketState나
// pre/day/after 세션별 가격을 안 주므로(공식 스키마 확인됨), 일별 캔들의 종가를 "정규장 마감가"
// 기준점으로 삼아 직접 계산한다 — 캔들 종가는 정규장만 반영(확인됨: 시간외 체결이 있어도
// /prices의 lastPrice와 최근 완결 캔들 종가가 서로 다르게 나옴).
async function handleTossQuote(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=45');
  if (!tossProxyConfigured()) return res.status(503).json({ ok: false, error: 'toss proxy not configured' });

  const rawSymbol = (req.query.symbol || '').toString();
  if (!rawSymbol) return res.status(400).json({ ok: false, error: 'symbol required' });
  const isKr = /\.(KS|KQ)$/i.test(rawSymbol);
  const symbol = rawSymbol.replace(/\.(KS|KQ)$/i, '');

  // 세션 라벨 판정에 자정 넘김 대응 필요(홈 시장지표와 동일 이유) — 오늘+어제(KST) 둘 다 조회.
  const kstNowMs = Date.now();
  const kstToday = new Date(kstNowMs + 9 * 3600000).toISOString().slice(0, 10);
  const kstYest = new Date(kstNowMs + 9 * 3600000 - 86400000).toISOString().slice(0, 10);

  const calls = [
    callTossProxy(`/prices?symbols=${encodeURIComponent(symbol)}`),
    callTossProxy(`/candles?symbol=${encodeURIComponent(symbol)}&interval=1d&count=2`),
  ];
  if (!isKr) {
    calls.push(callTossProxy(`/market-calendar/US?date=${kstToday}`));
    calls.push(callTossProxy(`/market-calendar/US?date=${kstYest}`));
  }
  const [priceData, candleData, calToday, calYest] = await Promise.all(calls);

  const p = priceData?.result?.[0];
  if (!p) return res.status(502).json({ ok: false, error: 'toss proxy unreachable' });
  const lastPrice = p.lastPrice != null ? Number(p.lastPrice) : null;

  const candles = candleData?.result?.candles || [];
  const regularClose = candles[0]?.closePrice != null ? Number(candles[0].closePrice) : null;
  const prevClose = candles[1]?.closePrice != null ? Number(candles[1].closePrice) : null;

  // 세션 라벨 (미장만 — KR NXT는 세션 구분 데이터가 아예 없어 항상 CLOSED로 둠)
  let session = 'CLOSED';
  if (!isKr) {
    const within = s => s && kstNowMs >= new Date(s.startTime).getTime() && kstNowMs < new Date(s.endTime).getTime();
    for (const cal of [calYest?.result?.today, calToday?.result?.today]) {
      if (!cal) continue;
      if (within(cal.regularMarket)) { session = 'REGULAR'; break; }
      if (within(cal.preMarket))     { session = 'PRE'; break; }
      if (within(cal.afterMarket))   { session = 'POST'; break; }
    }
  }

  // 정규장 중엔 당일 캔들이 아직 완결되지 않았을 수 있으므로 lastPrice를 기준가로,
  // 그 외(프리/애프터/마감)엔 직전 완결 캔들 종가를 정규장 마감 기준가로 쓴다.
  const dayRefPrice = session === 'REGULAR' ? lastPrice : regularClose;
  let regularChange = null, regularChangePercent = null;
  if (dayRefPrice != null && prevClose) {
    regularChange = dayRefPrice - prevClose;
    regularChangePercent = (regularChange / prevClose) * 100;
  }
  // 시간외 변동(정규장 마감가 대비)은 프리/애프터일 때만 의미가 있음
  let exChange = null, exChangePercent = null;
  if ((session === 'PRE' || session === 'POST') && lastPrice != null && regularClose) {
    exChange = lastPrice - regularClose;
    exChangePercent = (exChange / regularClose) * 100;
  }

  return res.status(200).json({
    ok: true, symbol: rawSymbol, currency: p.currency, lastPrice, timestamp: p.timestamp,
    regularClose, prevClose, regularChange, regularChangePercent,
    exChange, exChangePercent, session,
  });
}

// GET ?source=toss&action=orderbook&symbol=005930[.KS] — 호가창(10단 매도/매수 + 잔량).
async function handleTossOrderbook(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=5, stale-while-revalidate=15');
  if (!tossProxyConfigured()) return res.status(503).json({ ok: false, error: 'toss proxy not configured' });
  const symbol = (req.query.symbol || '').toString().replace(/\.(KS|KQ)$/i, '');
  if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });

  const data = await callTossProxy(`/orderbook?symbol=${encodeURIComponent(symbol)}`);
  if (!data) return res.status(502).json({ ok: false, error: 'toss proxy unreachable' });
  const r = data.result || {};
  const num = v => v != null ? Number(v) : null;
  return res.status(200).json({
    ok: true, symbol, currency: r.currency, timestamp: r.timestamp,
    asks: (r.asks || []).map(a => ({ price: num(a.price), volume: num(a.volume) })),
    bids: (r.bids || []).map(b => ({ price: num(b.price), volume: num(b.volume) })),
  });
}

// GET ?source=toss&action=meta&symbol=005930[.KS] — 종목 마스터(정확한 상장주식수→시총) +
// 투자유의 경고 + 상/하한가(KR). 히어로 뱃지/시총용으로 한 번에 묶어 조회.
async function handleTossMeta(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  if (!tossProxyConfigured()) return res.status(503).json({ ok: false, error: 'toss proxy not configured' });
  const rawSymbol = (req.query.symbol || '').toString();
  const isKr = /\.(KS|KQ)$/i.test(rawSymbol);
  const symbol = rawSymbol.replace(/\.(KS|KQ)$/i, '');
  if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });

  const calls = [
    callTossProxy(`/stocks?symbols=${encodeURIComponent(symbol)}`),
    callTossProxy(`/stocks/${encodeURIComponent(symbol)}/warnings`),
  ];
  if (isKr) calls.push(callTossProxy(`/price-limits?symbol=${encodeURIComponent(symbol)}`));
  const [stockData, warnData, limitData] = await Promise.all(calls);

  const s = stockData?.result?.[0];
  if (!s) return res.status(502).json({ ok: false, error: 'toss proxy unreachable' });
  const km = s.koreanMarketDetail || null;
  const num = v => v != null ? Number(v) : null;

  return res.status(200).json({
    ok: true,
    symbol: rawSymbol,
    name: s.name ?? null,
    market: s.market ?? null,
    currency: s.currency ?? null,
    status: s.status ?? null,                       // ACTIVE / ...
    listDate: s.listDate ?? null,
    sharesOutstanding: num(s.sharesOutstanding),    // 정확한 시총 계산용
    // KR 전용 플래그
    liquidationTrading: km?.liquidationTrading ?? null,   // 정리매매
    nxtSupported: km?.nxtSupported ?? null,               // NXT 거래 지원
    krxTradingSuspended: km?.krxTradingSuspended ?? null, // 거래정지
    nxtTradingSuspended: km?.nxtTradingSuspended ?? null,
    warnings: warnData?.result || [],               // 투자유의 배열(빈 배열=정상)
    upperLimitPrice: limitData?.result?.upperLimitPrice != null ? Number(limitData.result.upperLimitPrice) : null,
    lowerLimitPrice: limitData?.result?.lowerLimitPrice != null ? Number(limitData.result.lowerLimitPrice) : null,
  });
}

// GET ?source=toss&action=daily&symbol=005930[.KS]&count=20 — 일별 시세 표(OHLCV + 전일대비).
async function handleTossDaily(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
  if (!tossProxyConfigured()) return res.status(503).json({ ok: false, error: 'toss proxy not configured' });
  const symbol = (req.query.symbol || '').toString().replace(/\.(KS|KQ)$/i, '');
  if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });
  const count = Math.min(Math.max(parseInt(req.query.count) || 20, 1), 60);

  // 전일대비 계산 위해 요청 개수 + 1개 더 받아 마지막 기준점 확보
  const data = await callTossProxy(`/candles?symbol=${encodeURIComponent(symbol)}&interval=1d&count=${count + 1}`);
  if (!data) return res.status(502).json({ ok: false, error: 'toss proxy unreachable' });
  const candles = data.result?.candles || [];   // 최신순(내림차순)
  const num = v => v != null ? Number(v) : null;
  const rows = [];
  for (let i = 0; i < candles.length && rows.length < count; i++) {
    const c = candles[i];
    const prev = candles[i + 1];   // 하루 이전
    const close = num(c.closePrice);
    const prevClose = prev ? num(prev.closePrice) : null;
    rows.push({
      date: c.timestamp ? c.timestamp.slice(0, 10) : null,
      close,
      open: num(c.openPrice), high: num(c.highPrice), low: num(c.lowPrice),
      volume: num(c.volume),
      change: prevClose != null ? close - prevClose : null,
      changePercent: prevClose ? ((close - prevClose) / prevClose) * 100 : null,
    });
  }
  return res.status(200).json({ ok: true, symbol, currency: candles[0]?.currency ?? null, rows });
}

// GET ?source=toss&action=candles&symbol=005930[.KS]&interval=1d|1w|1mo&count=120
// 고도화 캔들차트(lightweight-charts)용 OHLCV. 오름차순(옛→최신)으로 정렬해 반환.
async function handleTossCandles(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
  if (!tossProxyConfigured()) return res.status(503).json({ ok: false, error: 'toss proxy not configured' });
  const symbol = (req.query.symbol || '').toString().replace(/\.(KS|KQ)$/i, '');
  if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });
  // Toss /candles는 실측상 일봉(1d)만 안정 지원(주/월봉 interval은 에러) + 최대 200개.
  const interval = '1d';
  const count = Math.min(Math.max(parseInt(req.query.count) || 120, 5), 200);

  const data = await callTossProxy(`/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&count=${count}`);
  if (!data) return res.status(502).json({ ok: false, error: 'toss proxy unreachable' });
  const num = v => v != null ? Number(v) : null;
  // Toss는 최신순(내림차순) → 차트용으로 오름차순 뒤집기
  const candles = (data.result?.candles || []).slice().reverse().map(c => ({
    date: c.timestamp ? c.timestamp.slice(0, 10) : null,
    open: num(c.openPrice), high: num(c.highPrice), low: num(c.lowPrice), close: num(c.closePrice),
    volume: num(c.volume),
  })).filter(c => c.date && c.close != null);

  return res.status(200).json({ ok: true, symbol, interval, currency: data.result?.candles?.[0]?.currency ?? null, candles });
}

const SHARED_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, */*',
};

// ════════════════════════════════════════════════════════════════════════
// quotes — GET ?source=quotes&tickers=AAPL,MSFT,005930.KS[&range=1mo][&include=series]
// 여러 티커를 한 번에 병렬 조회. 60초 캐시 + stale-while-revalidate.
// ════════════════════════════════════════════════════════════════════════

// 고정 개수 워커가 공유 큐를 소비하는 동시성 제한 map. Promise.all(items.map(fn))과 결과
// 순서·형태는 동일하지만, 동시 in-flight 요청 수를 concurrency로 제한한다.
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function handleQuotes(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // s-maxage=3은 프론트가 1초마다 폴링하던 시절 기준이었음 — edge cache가 완벽히
  // 흡수하지 못하면 실사용자 트래픽 증가 시 origin→Yahoo Finance 팬아웃(요청당 최대
  // 600개 티커)이 초당 수십 회로 폭증해 레이트리밋+장애로 이어짐(2026-07-15 발생).
  // 클라이언트 폴링 주기를 15초로 늦춘 것과 별개로, 서버 쪽에서도 origin 호출 자체를
  // 못 박아두는 이중 방어선.
  res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');

  const param = (req.query.tickers || '').toString();
  const range = (req.query.range || '1d').toString();
  const interval = range === '1mo' ? '1d' : range === '5d' ? '1d' : '1d';
  const includeSeries = req.query.include === 'series';   // 상관관계 계산용 시계열 반환
  // 히트맵 US/KR 목록이 S&P500 전체(525)·코스피+코스닥 top100(236) 규모로 확장되어 상향
  // (기존 200 → 600). 아래 mapWithConcurrency로 동시 요청 수를 제한해 Yahoo 레이트리밋 방지.
  const tickers = param.split(',').map(t => t.trim()).filter(Boolean).slice(0, 600);

  if (!tickers.length) {
    return res.status(400).json({ ok: false, error: 'tickers required', data: {} });
  }

  const fetchOne = async (ticker) => {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`,
        { headers: SHARED_HEADERS, signal: AbortSignal.timeout(5000) }
      );
      if (!r.ok) return [ticker, null];
      const j = await r.json();
      const result = j.chart?.result?.[0];
      const meta = result?.meta;
      if (!meta) return [ticker, null];

      const price = meta.regularMarketPrice ?? meta.previousClose ?? null;
      const prev  = meta.chartPreviousClose ?? meta.previousClose ?? null;
      let changePercent = meta.regularMarketChangePercent;
      let change        = meta.regularMarketChange;
      if (changePercent == null && price != null && prev) {
        change = price - prev;
        changePercent = (change / prev) * 100;
      }

      // 프리/애프터 마켓
      const preMarketPrice  = meta.preMarketPrice ?? null;
      const preMarketChange = meta.preMarketChange ?? null;
      const preMarketChangePercent = meta.preMarketChangePercent ?? null;
      const postMarketPrice  = meta.postMarketPrice ?? null;
      const postMarketChange = meta.postMarketChange ?? null;
      const postMarketChangePercent = meta.postMarketChangePercent ?? null;

      // currentTradingPeriod로 마켓 상태 계산
      const nowSec = Math.floor(Date.now() / 1000);
      const ctp = meta.currentTradingPeriod || {};
      const inRange = (p) => p && typeof p.start === 'number' && typeof p.end === 'number'
        && nowSec >= p.start && nowSec < p.end;
      let marketState = meta.marketState || null;
      if (!marketState) {
        if (inRange(ctp.regular))      marketState = 'REGULAR';
        else if (inRange(ctp.pre))     marketState = 'PRE';
        else if (inRange(ctp.post))    marketState = 'POST';
        else                            marketState = 'CLOSED';
      }

      // 기간 수익률 (range=1mo면 한 달, 5d면 5일치)
      let periodChangePercent = null;
      const closes = result.indicators?.quote?.[0]?.close;
      if (Array.isArray(closes) && closes.length >= 2) {
        const first = closes.find(v => v != null);
        const last  = [...closes].reverse().find(v => v != null);
        if (first && last) periodChangePercent = ((last - first) / first) * 100;
      }
      const series = includeSeries && Array.isArray(closes) ? closes.filter(v => v != null) : undefined;

      return [ticker, {
        price,
        previousClose: prev,
        change:        change != null ? Math.round(change * 100) / 100 : null,
        changePercent: changePercent != null ? Math.round(changePercent * 100) / 100 : null,
        currency:      meta.currency || 'USD',
        marketState,
        preMarketPrice,
        preMarketChange:        preMarketChange != null ? Math.round(preMarketChange * 100) / 100 : null,
        preMarketChangePercent: preMarketChangePercent != null ? Math.round(preMarketChangePercent * 100) / 100 : null,
        postMarketPrice,
        postMarketChange:        postMarketChange != null ? Math.round(postMarketChange * 100) / 100 : null,
        postMarketChangePercent: postMarketChangePercent != null ? Math.round(postMarketChangePercent * 100) / 100 : null,
        periodChangePercent: periodChangePercent != null ? Math.round(periodChangePercent * 100) / 100 : null,
        exchangeName: meta.exchangeName || meta.fullExchangeName || null,
        shortName:    meta.shortName || meta.longName || null,
        // 종목 상세 페이지용 — 이미 받아온 meta에서 추가 파싱만 하는 것이라 별도 호출 비용 없음
        dayHigh:  meta.regularMarketDayHigh ?? null,
        dayLow:   meta.regularMarketDayLow ?? null,
        volume:   meta.regularMarketVolume ?? null,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
        fiftyTwoWeekLow:  meta.fiftyTwoWeekLow ?? null,
        firstTradeDate:   meta.firstTradeDate ? new Date(meta.firstTradeDate * 1000).toISOString().slice(0, 10) : null,
        ...(series ? { series } : {}),
      }];
    } catch {
      return [ticker, null];
    }
  };

  // 워커 풀 방식 동시성 제한 — 티커 수가 커져도(최대 600) 동시 아웃바운드 연결을
  // concurrency 개로 고정. 슬로우 티커 하나가 배치 전체를 묶어두지 않도록 청크 방식 대신
  // 공유 큐를 쓴다(먼저 끝난 워커가 바로 다음 티커를 가져감).
  const results = await mapWithConcurrency(tickers, 60, fetchOne);
  const data = Object.fromEntries(results);

  return res.status(200).json({ ok: true, data, ts: Date.now() });
}

// ════════════════════════════════════════════════════════════════════════
// technicals — GET ?source=technicals&tickers=AAPL,MSFT,005930.KS
// Yahoo Finance v8/chart 6개월 일봉으로 SMA + RSI 계산. 무료, 인증 불필요.
// ════════════════════════════════════════════════════════════════════════
const TECHNICALS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0',
  'Accept': 'application/json',
};

async function handleTechnicals(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');  // 5분 캐시

  const tickers = (req.query.tickers || '').toString()
    .split(',').map(t => t.trim()).filter(Boolean).slice(0, 15);

  if (!tickers.length) {
    return res.status(400).json({ ok: false, error: 'tickers required', data: {} });
  }

  const results = await Promise.all(tickers.map(fetchTechnicals));
  const data = Object.fromEntries(results.filter(Boolean));

  return res.status(200).json({ ok: true, data, ts: Date.now() });
}

async function fetchTechnicals(ticker) {
  try {
    // 1년 일봉 (RSI 14 + SMA 200 계산에 충분)
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1y`,
      { headers: TECHNICALS_HEADERS, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return [ticker, null];
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    if (!result) return [ticker, null];

    const closes = (result.indicators?.quote?.[0]?.close || []).filter(v => v != null);
    if (closes.length < 30) return [ticker, null];

    const price = closes[closes.length - 1];
    const sma20  = sma(closes, 20);
    const sma50  = sma(closes, 50);
    const sma200 = sma(closes, 200);
    const rsi14  = rsi(closes, 14);

    // 시그널 판정
    const signal = classifySignal({ price, sma20, sma50, sma200, rsi14 });

    return [ticker, {
      price:   round2(price),
      sma20:   sma20  != null ? round2(sma20)  : null,
      sma50:   sma50  != null ? round2(sma50)  : null,
      sma200:  sma200 != null ? round2(sma200) : null,
      rsi14:   rsi14  != null ? Math.round(rsi14) : null,
      vsSma20:  sma20  ? pct(price, sma20)  : null,
      vsSma50:  sma50  ? pct(price, sma50)  : null,
      vsSma200: sma200 ? pct(price, sma200) : null,
      signal,
    }];
  } catch {
    return [ticker, null];
  }
}

function sma(arr, n) {
  if (arr.length < n) return null;
  const slice = arr.slice(-n);
  return slice.reduce((s, v) => s + v, 0) / n;
}

// Wilder's RSI (period 14)
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  // 첫 평균
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  // 이후 Wilder smoothing
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function classifySignal({ price, sma20, sma50, sma200, rsi14 }) {
  // 골든크로스 (20 > 50 > 200) + 가격 > 모든 MA → 강세
  if (sma20 && sma50 && sma200 && price > sma20 && sma20 > sma50 && sma50 > sma200) {
    if (rsi14 >= 70) return 'overbought';       // 과매수
    if (rsi14 <= 30) return 'oversold_bull';    // 강세 추세 + 단기 과매도 (매수 기회)
    return 'strong_bullish';
  }
  // 데드크로스 (20 < 50 < 200) + 가격 < 모든 MA → 약세
  if (sma20 && sma50 && sma200 && price < sma20 && sma20 < sma50 && sma50 < sma200) {
    if (rsi14 <= 30) return 'oversold';
    return 'strong_bearish';
  }
  // 가격이 SMA50 위 + RSI 중립
  if (sma50 && price > sma50) {
    if (rsi14 >= 70) return 'overbought';
    if (rsi14 <= 30) return 'oversold_bull';
    return 'bullish';
  }
  // 가격이 SMA50 아래
  if (sma50 && price < sma50) {
    if (rsi14 <= 30) return 'oversold';
    return 'bearish';
  }
  if (rsi14 != null && rsi14 >= 70) return 'overbought';
  if (rsi14 != null && rsi14 <= 30) return 'oversold';
  return 'neutral';
}

function pct(a, b) {
  return Math.round((a - b) / b * 10000) / 100;
}
function round2(v) {
  return Math.round(v * 100) / 100;
}

// ════════════════════════════════════════════════════════════════════════
// kr-overtime — GET ?source=kr-overtime&codes=005930,000660&session=pre|post
// Yahoo Finance는 KRX(.KS/.KQ) 종목의 시간외 데이터를 제공하지 않아
// 네이버 금융의 비공식 실시간 시세 API(overMarketPriceInfo)를 사용한다.
// KRX 시간외 세션 자체가 08:30–09:00(전일 종가 고정) / 15:40–18:00(종가매매+단일가)로
// 정해져 있으므로, 네이버가 보내는 태그값에 의존하지 않고 KST 시각으로 직접 세션을 판별한다.
// ════════════════════════════════════════════════════════════════════════
function kstMinuteOfDay() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return kst.getUTCHours() * 60 + kst.getUTCMinutes();
}

async function handleKrOvertime(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=5, stale-while-revalidate=15');

  const codes = (req.query.codes || '').toString().split(',').map(c => c.trim()).filter(Boolean).slice(0, 100);
  const session = (req.query.session || '').toString();

  if (!codes.length || (session !== 'pre' && session !== 'post')) {
    return res.status(400).json({ ok: false, error: 'codes and session=pre|post required', data: {} });
  }

  const minOfDay = kstMinuteOfDay();
  const inWindow = session === 'pre'
    ? (minOfDay >= 510 && minOfDay < 540)    // 08:30–09:00 시간외 종가매매 (전일 종가 고정)
    : (minOfDay >= 940 && minOfDay < 1080);  // 15:40–18:00 시간외 종가매매+단일가

  if (!inWindow) {
    return res.status(200).json({ ok: true, data: {}, ts: Date.now() });
  }

  try {
    const url = `https://polling.finance.naver.com/api/realtime/domestic/stock/${codes.join(',')}`;
    const r = await fetch(url, { headers: SHARED_HEADERS, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('naver fetch failed');
    const j = await r.json();
    const data = {};
    for (const item of (j.datas || [])) {
      const over = item.overMarketPriceInfo;
      const closePrice = parseFloat(item.closePriceRaw);
      if (!over || !closePrice) continue;
      const overPrice = parseFloat(String(over.overPrice || '').replace(/,/g, ''));
      if (!overPrice) continue;
      const pct2 = ((overPrice - closePrice) / closePrice) * 100;
      data[item.itemCode] = { pct: Math.round(pct2 * 100) / 100, price: overPrice };
    }
    return res.status(200).json({ ok: true, data, ts: Date.now() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e), data: {} });
  }
}

// ════════════════════════════════════════════════════════════════════════
// market-pulse — GET ?source=market-pulse[&type=trump|economic]
// Trump: Truth Social RSS 최신 글 / Economic: ForexFactory+FMP 이번주 캘린더
// ════════════════════════════════════════════════════════════════════════
async function handleTrump(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');

  try {
    const r = await fetch('https://truthsocial.com/@realDonaldTrump.rss', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      return res.status(200).json({ ok: false, error: `HTTP ${r.status}`, items: [] });
    }
    const xml   = await r.text();
    const items = parseRss(xml, 5);
    return res.status(200).json({ ok: true, items, ts: Date.now() });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message, items: [] });
  }
}

function parseRss(xml, max = 5) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null && items.length < max) {
    const block   = m[1];
    const desc    = getTag(block, 'description') || getTag(block, 'content:encoded');
    const link    = getTag(block, 'link') || getTag(block, 'guid');
    const pubDate = getTag(block, 'pubDate');
    const text = (desc || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (text.length > 5) {
      items.push({
        text,
        link: link || 'https://truthsocial.com/@realDonaldTrump',
        publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
      });
    }
  }
  return items;
}

function getTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, 'i');
  const m  = xml.match(re);
  return m ? (m[1] ?? m[2] ?? '').trim() : '';
}

// 이벤트명 정규화 (ForexFactory/FMP 명명 차이 흡수)
function normalizeTitle(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/\bm\/m\b/g, 'mom').replace(/\by\/y\b/g, 'yoy').replace(/\bq\/q\b/g, 'qoq')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// FMP 무료 플랜(250콜/일)을 스케줄 에이전트 매일 1:15 등 반복 호출이 순식간에 태워서
// "Invalid API KEY"(실은 한도초과)로 계속 막히는 사고가 있었다(2026-07-16 실측: 1,001/250).
// 30분 DB 캐시로 재호출을 줄인다 — 캐시가 신선하면 FMP/ForexFactory를 아예 안 부른다.
const ECON_CACHE_TTL_MS = 30 * 60 * 1000;

async function handleEconomic(res, limit = 30) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  let cachedRow = null;
  try {
    const { data } = await supabase.from('econ_calendar_cache').select('*').eq('id', 1).maybeSingle();
    cachedRow = data;
  } catch { /* 캐시 테이블이 아직 없어도(마이그레이션 전) fail-open — 그냥 매번 새로 가져온다 */ }
  const cacheAgeMs = cachedRow?.updated_at ? Date.now() - new Date(cachedRow.updated_at).getTime() : Infinity;

  if (cachedRow?.items?.length && cacheAgeMs < ECON_CACHE_TTL_MS) {
    return res.status(200).json({
      ok: true, items: cachedRow.items.slice(0, limit), ts: Date.now(),
      source: cachedRow.source, fmp: cachedRow.fmp, cached: true, cacheAgeMs,
    });
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
  };

  const NAME_KO = {
    'CPI m/m': '소비자물가 (MoM)', 'Core CPI m/m': '근원 CPI (MoM)',
    'CPI y/y': '소비자물가 (YoY)', 'Core CPI y/y': '근원 CPI (YoY)',
    'Non-Farm Employment Change': '비농업 신규고용 (NFP)', 'Unemployment Rate': '실업률',
    'GDP q/q': 'GDP (QoQ)', 'Prelim GDP q/q': 'GDP 예비치 (QoQ)',
    'Federal Funds Rate': 'FOMC 기준금리', 'FOMC Statement': 'FOMC 성명서',
    'FOMC Meeting Minutes': 'FOMC 의사록', 'FOMC Press Conference': 'FOMC 기자회견',
    'Retail Sales m/m': '소매판매 (MoM)', 'Core Retail Sales m/m': '근원 소매판매 (MoM)',
    'PPI m/m': '생산자물가 (MoM)', 'Core PPI m/m': '근원 PPI (MoM)',
    'PPI y/y': '생산자물가 (YoY)', 'Core PPI y/y': '근원 PPI (YoY)',
    'ISM Manufacturing PMI': 'ISM 제조업 PMI', 'ISM Services PMI': 'ISM 서비스업 PMI',
    'ISM Non-Manufacturing PMI': 'ISM 비제조업 PMI',
    'Flash Manufacturing PMI': '제조업 PMI (예비)', 'Flash Services PMI': '서비스업 PMI (예비)',
    'Trade Balance': '무역수지', 'Building Permits': '건축허가',
    'Housing Starts': '신규주택착공', 'Existing Home Sales': '기존주택판매',
    'New Home Sales': '신규주택판매', 'Pending Home Sales m/m': '주택판매계약 (MoM)',
    'Durable Goods Orders m/m': '내구재주문 (MoM)', 'Core Durable Goods Orders m/m': '근원 내구재주문 (MoM)',
    'Consumer Confidence': '소비자신뢰지수 (CB)', 'Michigan Consumer Sentiment': '미시간대 소비자심리',
    'Prelim UoM Consumer Sentiment': '미시간대 소비자심리 (예비)', 'UoM Consumer Sentiment': '미시간대 소비자심리',
    'Initial Jobless Claims': '신규실업급여 청구', 'Continuing Jobless Claims': '계속실업급여 청구',
    'ADP Non-Farm Employment Change': 'ADP 비농업 고용', 'JOLTS Job Openings': 'JOLTS 채용공고',
    'PCE Price Index m/m': 'PCE 물가 (MoM)', 'Core PCE Price Index m/m': '근원 PCE 물가 (MoM)',
    'PCE Price Index y/y': 'PCE 물가 (YoY)', 'Core PCE Price Index y/y': '근원 PCE 물가 (YoY)',
    'Fed Chair Powell Speaks': '파월 Fed 의장 발언', 'Fed Speaks': 'Fed 위원 발언',
    'Treasury Sec. Speaks': '재무장관 발언', 'Treasury Secretary Speaks': '재무장관 발언',
    'Empire State Manufacturing Index': '뉴욕 제조업 지수',
    'Philly Fed Manufacturing Index': '필라델피아 Fed 제조업',
    'Industrial Production m/m': '산업생산 (MoM)', 'Capacity Utilization Rate': '설비가동률',
    'Nonfarm Productivity q/q': '비농업 생산성 (QoQ)', 'Unit Labor Costs q/q': '단위노동비용 (QoQ)',
    'ECB Main Refinancing Rate': 'ECB 기준금리', 'ECB Press Conference': 'ECB 기자회견',
    'BOJ Policy Rate': '일본은행 기준금리', 'BOE Official Bank Rate': '영란은행 기준금리',
    'Employment Change': '고용변화', 'Employment Cost Index q/q': '고용비용지수 (QoQ)',
    'Chicago PMI': '시카고 PMI', 'Challenger Job Cuts y/y': '챌린저 감원 (YoY)',
  };

  const LOWER_IS_BETTER = new Set([
    'Unemployment Rate', 'Initial Jobless Claims', 'Continuing Jobless Claims',
    'Core CPI m/m', 'CPI m/m', 'CPI y/y', 'Core CPI y/y',
    'PPI m/m', 'Core PPI m/m', 'PPI y/y', 'Core PPI y/y',
    'PCE Price Index m/m', 'Core PCE Price Index m/m',
    'Unit Labor Costs q/q', 'Challenger Job Cuts y/y',
  ]);

  try {
    const fmpKey = process.env.FMP_API_KEY;
    const today  = new Date();
    const past   = new Date(today.getTime() - 7 * 86400000);
    const future = new Date(today.getTime() + 14 * 86400000);
    const fmpFrom = past.toISOString().split('T')[0];
    const fmpTo   = future.toISOString().split('T')[0];

    // FMP economic calendar 여러 엔드포인트 명 cascade 시도
    const fetchFMPEconomic = async () => {
      if (!fmpKey) return { data: [], status: 'no-key' };
      const urls = [
        `https://financialmodelingprep.com/stable/economic-calendar?from=${fmpFrom}&to=${fmpTo}&apikey=${fmpKey}`,
        `https://financialmodelingprep.com/stable/economics-calendar?from=${fmpFrom}&to=${fmpTo}&apikey=${fmpKey}`,
        `https://financialmodelingprep.com/api/v3/economic_calendar?from=${fmpFrom}&to=${fmpTo}&apikey=${fmpKey}`,
      ];
      const tried = [];
      for (const url of urls) {
        try {
          const r = await fetch(url, { headers, signal: AbortSignal.timeout(7000) });
          const path = url.split('?')[0].split('/').slice(-1)[0];
          if (r.ok) {
            const j = await r.json();
            if (Array.isArray(j) && j.length) return { data: j, status: `ok-${path}`, tried };
            tried.push(`${path}:empty`);
          } else {
            tried.push(`${path}:${r.status}`);
          }
        } catch (e) { tried.push(`err:${e.message}`); }
      }
      return { data: [], status: 'all-failed', tried };
    };

    const [tw, nw, lw, fmpResult] = await Promise.allSettled([
      fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers, signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : []),
      fetch('https://nfs.faireconomy.media/ff_calendar_nextweek.json', { headers, signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : []),
      fetch('https://nfs.faireconomy.media/ff_calendar_lastweek.json', { headers, signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : []),
      fetchFMPEconomic(),
    ]);

    const fmp = { status: 'fulfilled', value: fmpResult.status === 'fulfilled' ? fmpResult.value.data : [] };
    const fmpStatus = fmpResult.status === 'fulfilled' ? fmpResult.value.status : 'rejected';

    let raw = [
      ...(lw.status === 'fulfilled' && Array.isArray(lw.value) ? lw.value : []),
      ...(tw.status === 'fulfilled' && Array.isArray(tw.value) ? tw.value : []),
      ...(nw.status === 'fulfilled' && Array.isArray(nw.value) ? nw.value : []),
    ];

    // FMP economic calendar로 actual 값 보강 (ForexFactory JSON엔 actual 필드 없음)
    const fmpArr = fmp.status === 'fulfilled' && Array.isArray(fmp.value) ? fmp.value : [];
    // FMP country: 'US', 'EU', 'JP' → ForexFactory currency: 'USD', 'EUR', 'JPY'
    const COUNTRY_TO_CURRENCY = { US:'USD', EU:'EUR', JP:'JPY', GB:'GBP', CN:'CNY', DE:'EUR', FR:'EUR' };
    const fmpByKey = {};  // key: "currency|normalizedTitle" → FMP event
    for (const e of fmpArr) {
      const title = e?.event || e?.title;
      if (!title) continue;
      const curr  = (e.currency || COUNTRY_TO_CURRENCY[(e.country || '').toUpperCase()] || e.country || '').toUpperCase();
      const key   = `${curr}|${normalizeTitle(title)}`;
      // 시간 기반: 가장 가까운 이벤트 우선 매칭
      const existing = fmpByKey[key];
      if (!existing) { fmpByKey[key] = e; continue; }
      const eMs   = new Date(e.date).getTime();
      const exMs  = new Date(existing.date).getTime();
      // actual 있는 쪽 우선, 없으면 더 최근
      if (e.actual != null && existing.actual == null) fmpByKey[key] = e;
      else if (e.actual == null && existing.actual != null) {}
      else if (eMs > exMs) fmpByKey[key] = e;
    }

    // ForexFactory가 완전히 비면(IP 차단·nextweek.json 404 등) FMP 캘린더 단독으로 구성
    // FMP date는 UTC ("2026-07-06 12:30:00") — 'T'+'Z' 정규화로 런타임 로컬타임 오해 방지
    let usedFmpFallback = false;
    if (!raw.length && fmpArr.length) {
      usedFmpFallback = true;
      raw = fmpArr.map(e => ({
        title:    e.event || e.title || '',
        country:  (e.currency || COUNTRY_TO_CURRENCY[(e.country || '').toUpperCase()] || '').toUpperCase(),
        date:     typeof e.date === 'string' && !/[TZ+]/.test(e.date) ? e.date.replace(' ', 'T') + 'Z' : e.date,
        impact:   ['High', 'Medium', 'Low'].includes(e.impact) ? e.impact : 'Medium',
        forecast: e.estimate != null ? String(e.estimate) : '',
        previous: e.previous != null ? String(e.previous) : '',
        actual:   e.actual   != null ? String(e.actual)   : '',
      }));
    }

    if (!raw.length) {
      // 소스가 완전히 죽었을 때 — 캐시가 있으면(TTL 지난 것이라도) 완전 공백보다 낫다
      if (cachedRow?.items?.length) {
        return res.status(200).json({
          ok: true, items: cachedRow.items.slice(0, limit), ts: Date.now(),
          source: cachedRow.source, fmp: cachedRow.fmp, cached: true, stale: true, cacheAgeMs,
        });
      }
      return res.status(200).json({ ok: false, error: 'ForexFactory+FMP both empty', items: [], fmpCount: fmpArr.length });
    }

    raw = raw.filter(e =>
      (e.country === 'USD' || e.country === 'EUR' || e.country === 'JPY') &&
      (e.impact === 'High' || e.impact === 'Medium')
    );

    const now         = Date.now();
    const windowStart = now - 7  * 86400000;
    const windowEnd   = now + 14 * 86400000;

    const items = raw
      .map(e => {
        let dateIso = null;
        try { const d = new Date(e.date); if (!isNaN(d)) dateIso = d.toISOString(); } catch {}
        // FMP에서 actual 보강 (currency + 정규화된 이벤트명 매칭)
        const matchKey = `${(e.country || '').toUpperCase()}|${normalizeTitle(e.title)}`;
        const fmpMatch = fmpByKey[matchKey];
        const ffActual  = (e.actual != null && e.actual !== '') ? String(e.actual) : null;
        const fmpActual = fmpMatch && fmpMatch.actual != null && fmpMatch.actual !== '' ? String(fmpMatch.actual) : null;
        const fmpFcast  = fmpMatch && fmpMatch.estimate != null && fmpMatch.estimate !== '' ? String(fmpMatch.estimate) : null;
        const fmpPrev   = fmpMatch && fmpMatch.previous != null && fmpMatch.previous !== '' ? String(fmpMatch.previous) : null;
        return {
          title:        e.title || '',
          titleKo:      NAME_KO[e.title] || e.title || '',
          country:      e.country || 'USD',
          impact:       e.impact  || 'Medium',
          date:         dateIso,
          dateRaw:      e.date || '',
          forecast:     (e.forecast != null && e.forecast !== '') ? String(e.forecast) : fmpFcast,
          previous:     (e.previous != null && e.previous !== '') ? String(e.previous) : fmpPrev,
          actual:       ffActual || fmpActual,  // ForexFactory 우선, 없으면 FMP
          lowerIsBetter: LOWER_IS_BETTER.has(e.title),
        };
      })
      .filter(e => {
        if (!e.date) return false;
        const t = new Date(e.date).getTime();
        return t >= windowStart && t <= windowEnd;
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 80); // 캐시엔 넉넉히 저장(호출부 limit 상한과 동일) — 응답은 아래서 실제 limit만큼만

    const econSource = usedFmpFallback ? 'fmp-only' : 'forexfactory+fmp';
    const fmpMeta = { ok: !!fmpArr.length, count: fmpArr.length, withActual: fmpArr.filter(e => e?.actual != null).length, status: fmpStatus };

    try {
      await supabase.from('econ_calendar_cache').upsert({ id: 1, items, source: econSource, fmp: fmpMeta, updated_at: new Date().toISOString() });
    } catch { /* 캐시 쓰기 실패해도 응답 자체는 정상 반환 — 마이그레이션 전이면 그냥 매번 새로 가져오는 예전 동작으로 fail-open */ }

    return res.status(200).json({ ok: true, items: items.slice(0, limit), ts: Date.now(), source: econSource, fmp: fmpMeta });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, items: [] });
  }
}

// ════════════════════════════════════════════════════════════════════════
// earnings — GET ?source=earnings[&type=analyst]
// ════════════════════════════════════════════════════════════════════════
// 메가캡 + 어닝시즌 조기 발표조(은행·항공·소비재) — 주간 일정에서 다음 주 실적 커버용
const EARNINGS_TICKERS = ['AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','INTC','QCOM','NFLX','ORCL',
                 'JPM','GS','BAC','WFC','DAL','PEP','UNH','JNJ'];

const EARNINGS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

// ─── Yahoo v8/chart: 현재가, 회사명 ─────────────────────────────────
async function fetchChart(ticker) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
      { headers: EARNINGS_HEADERS, signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return j?.chart?.result?.[0]?.meta || null;
  } catch { return null; }
}

// ─── Nasdaq: 다음 실적발표 예정일 + 컨센서스 EPS ──────────────────
// FMP 무료 티어가 실적 캘린더를 막아둔(402) 경우의 예정일 소스.
// Zacks 알고리즘 추정일이므로 dateEstimated=true 로 표시.
const MONTHS = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06', Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' };
async function fetchNasdaqEarningsDate(ticker) {
  try {
    const r = await fetch(
      `https://api.nasdaq.com/api/analyst/${encodeURIComponent(ticker)}/earnings-date`,
      { headers: EARNINGS_HEADERS, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const d = j?.data;
    if (!d) return null;

    let date = null;
    // "Earnings announcement* for NVDA: Aug 26, 2026"
    const am = (d.announcement || '').match(/:\s*([A-Z][a-z]{2})\w*\s+(\d{1,2}),\s*(\d{4})/);
    if (am && MONTHS[am[1]]) date = `${am[3]}-${MONTHS[am[1]]}-${String(am[2]).padStart(2, '0')}`;
    // "estimated to report earnings on  07/30/2026"
    if (!date) {
      const rm = (d.reportText || '').match(/report earnings on\s+(\d{2})\/(\d{2})\/(\d{4})/);
      if (rm) date = `${rm[3]}-${rm[1]}-${rm[2]}`;
    }
    // "consensus EPS forecast for the quarter is $1.88"
    const em = (d.reportText || '').match(/consensus EPS forecast for the quarter is \$(-?[\d.]+)/);
    const epsForecast = em ? parseFloat(em[1]) : null;

    if (!date && epsForecast == null) return null;
    return { date, epsForecast };
  } catch { return null; }
}

// ─── Yahoo insights: 목표가, 투자의견 ─────────────────────────────
async function fetchInsights(ticker) {
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/ws/insights/v2/finance/insights?symbol=${encodeURIComponent(ticker)}`,
      { headers: EARNINGS_HEADERS, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return j?.finance?.result || null;
  } catch { return null; }
}

// ─── FMP Stable API (2025년 9월 이후 신규) ────────────────────────
// 무료 티어 호환 엔드포인트만 사용
async function fetchFMPForTicker(sym, key) {
  const tryEndpoint = async (path, parser) => {
    try {
      const url = `https://financialmodelingprep.com${path}${path.includes('?') ? '&' : '?'}apikey=${key}`;
      const r = await fetch(url, { headers: EARNINGS_HEADERS, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return { ok: false, status: r.status };
      const data = await r.json();
      const result = parser(data);
      return { ok: !!result, data: result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // 1) /stable/earnings — 통합 실적 (유료 402)
  const earnings = await tryEndpoint(
    `/stable/earnings?symbol=${encodeURIComponent(sym)}&limit=8`,
    (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null;
      const todayMs = Date.now();
      const sorted = arr.slice().sort((a,b) => new Date(a.date) - new Date(b.date));
      const future = sorted.find(e => new Date(e.date).getTime() >= todayMs);
      const past   = sorted.filter(e => new Date(e.date).getTime() < todayMs).pop();
      // 실적 발표 당일이 지나면 곧바로 다음 분기 예정일로 넘어가 방금 나온 결과를
      // 확인할 새도 없이 사라지던 문제 — 지난 1주일 이내 발표(결과 반영됨)는
      // 다음 예정일보다 우선 노출해 최소 일주일간 결과를 볼 수 있게 한다.
      const SEVEN_DAYS_MS = 7 * 86400000;
      const pastIsRecent = past && (todayMs - new Date(past.date).getTime()) <= SEVEN_DAYS_MS;
      const e = pastIsRecent ? past : (future || past);
      if (!e) return null;
      return {
        symbol: sym, date: e.date,
        eps: e.epsActual ?? e.eps ?? null,
        epsEstimated: e.epsEstimated ?? e.epsEstimate ?? null,
        revenue: e.revenueActual ?? e.revenue ?? null,
        revenueEstimated: e.revenueEstimated ?? e.revenueEstimate ?? null,
        time: null, source: 'stable-earnings',
      };
    }
  );
  if (earnings.ok) return { ok: true, data: earnings.data, source: 'stable-earnings' };

  // 2) /stable/income-statement — 분기 손익계산서 (과거 EPS + 매출)
  const income = await tryEndpoint(
    `/stable/income-statement?symbol=${encodeURIComponent(sym)}&period=quarter&limit=1`,
    (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null;
      const i = arr[0];
      return {
        symbol: sym,
        date: i.date || i.fillingDate || null,
        eps: i.eps ?? i.epsDiluted ?? i.epsdiluted ?? null,
        epsEstimated: null,
        revenue: i.revenue ?? null,
        revenueEstimated: null,
        time: null, source: 'income-statement',
      };
    }
  );
  if (income.ok) return { ok: true, data: income.data, source: 'income-statement' };

  // 3) /stable/key-metrics — TTM 메트릭
  const km = await tryEndpoint(
    `/stable/key-metrics?symbol=${encodeURIComponent(sym)}&period=quarter&limit=1`,
    (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null;
      const k = arr[0];
      return {
        symbol: sym,
        date: k.date || null,
        eps: k.netIncomePerShare ?? k.eps ?? null,
        epsEstimated: null,
        revenue: k.revenuePerShare ? null : (k.revenue ?? null),
        revenueEstimated: null,
        time: null, source: 'key-metrics',
      };
    }
  );
  if (km.ok) return { ok: true, data: km.data, source: 'key-metrics' };

  return {
    ok: false,
    earningsStatus: earnings.status,
    incomeStatus:   income.status,
    kmStatus:       km.status,
  };
}

async function fetchFMP(tickers) {
  const key = process.env.FMP_API_KEY;
  if (!key) return { data: null, error: 'no-key' };

  const results = await Promise.all(tickers.map(t => fetchFMPForTicker(t, key)));
  const bySym = {};
  let count = 0;
  results.forEach((r, i) => {
    if (r.ok && r.data) { bySym[tickers[i]] = r.data; count++; }
  });
  return { data: bySym, error: count ? null : 'all-failed', count };
}

// ─── Earnings handler ─────────────────────────────────────────────
async function handleEarnings(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');

  const fmpRes = await fetchFMP(EARNINGS_TICKERS);
  const fmpBySym = fmpRes.data || {};

  const todayStr = new Date().toISOString().slice(0, 10);

  const enrich = async (ticker) => {
    const fmp = fmpBySym[ticker] || null;
    const [meta, ins, nasdaq] = await Promise.all([
      fetchChart(ticker),
      fetchInsights(ticker),
      fetchNasdaqEarningsDate(ticker),
    ]);

    const company      = meta?.shortName || meta?.longName || ticker;
    const currentPrice = meta?.regularMarketPrice ?? null;

    let priceTarget = null, recKey = null;
    if (ins?.recommendation) {
      priceTarget = ins.recommendation.targetPrice ?? null;
      const rStr  = (ins.recommendation.rating || '').toLowerCase();
      recKey = rStr === 'buy' ? 'buy' : rStr === 'sell' ? 'sell' : rStr === 'hold' ? 'hold' : null;
    }

    // 날짜: FMP 미래일 > FMP 최근(1주 이내) 과거 발표일 > Nasdaq 추정 예정일 > 그 외 FMP 과거 발표일
    // 최근 발표일은 결과를 확인할 시간을 주기 위해 Nasdaq의 다음 분기 예상일보다 우선한다.
    let date = fmp?.date || null;
    let dateEstimated = false;
    const isRecentPast = date && date < todayStr &&
      (Date.now() - new Date(date).getTime()) <= 7 * 86400000;
    if (!isRecentPast && (!date || date < todayStr) && nasdaq?.date && nasdaq.date >= todayStr) {
      date = nasdaq.date;
      dateEstimated = true;
    }

    return {
      ticker,
      company,
      date,
      dateEstimated,
      epsActual:    fmp?.eps ?? null,
      epsConsensus: fmp?.epsEstimated ?? nasdaq?.epsForecast ?? null,
      revActual:    fmp?.revenue ?? null,
      revEstimate:  fmp?.revenueEstimated ?? null,
      callTime:     fmp?.time === 'bmo' ? 'BMO' : fmp?.time === 'amc' ? 'AMC' : null,
      priceTarget,
      recKey,
      currentPrice,
    };
  };

  const settled = await Promise.allSettled(EARNINGS_TICKERS.map(enrich));
  const items = settled
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)
    .sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(a.date) - new Date(b.date);
    });

  return res.status(200).json({
    ok: true,
    items,
    fmp: { ok: !!fmpRes.data, count: fmpRes.count || 0 },
    ts: Date.now(),
  });
}

// ─── Analyst handler ──────────────────────────────────────────────
async function handleAnalyst(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');

  const ANALYST_TICKERS = ['AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','QCOM','NFLX'];

  const fetchOne = async (ticker) => {
    const meta = await fetchChart(ticker);
    const ins  = await fetchInsights(ticker);

    const shortName = meta?.shortName || meta?.longName || ticker;
    const price     = meta?.regularMarketPrice ?? null;

    let targetMean = null, recKey = null, provider = null, valuation = null, techDir = null;
    if (ins?.recommendation) {
      targetMean = ins.recommendation.targetPrice ?? null;
      provider   = ins.recommendation.provider   ?? null;
      const rStr = (ins.recommendation.rating || '').toLowerCase();
      recKey = rStr === 'buy' ? 'buy' : rStr === 'sell' ? 'sell' : rStr === 'hold' ? 'hold' : null;
    }
    if (ins?.instrumentInfo) {
      valuation = ins.instrumentInfo.valuation?.description ?? null;
      const iDir = ins.instrumentInfo.technicalEvents?.intermediateTermOutlook?.direction;
      const sDir = ins.instrumentInfo.technicalEvents?.shortTermOutlook?.direction;
      techDir = iDir || sDir || null;
    }

    if (!price && !targetMean) return null;

    return {
      ticker, shortName, price, targetMean,
      targetHigh: null, targetLow: null,
      recKey, analystCount: null,
      provider, valuation, techDir,
      dist: null, recent: [],
    };
  };

  const settled = await Promise.allSettled(ANALYST_TICKERS.map(fetchOne));
  const items = settled.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);

  return res.status(200).json({ ok: true, items, ts: Date.now() });
}

// ════════════════════════════════════════════════════════════════════════
// us-market — 미장현황(거래량 TOP/상승률 TOP/하락률 TOP) — Yahoo Finance의
// predefined screener(most_actives/day_gainers/day_losers)를 그대로 사용.
// 한국 상/하한가 같은 가격 제한폭 개념이 미국엔 없어 국장현황과 카테고리를
// 그대로 대응시키지 않고 미국 시장에 자연스러운 3개 랭킹으로 구성.
// GET ?source=us-market&type=actives|gainers|losers
async function handleUsMarket(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');

  const type = (req.query.type || 'actives').toString();
  const scrId = type === 'gainers' ? 'day_gainers' : type === 'losers' ? 'day_losers' : 'most_actives';

  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=${scrId}&count=30`,
      { headers: SHARED_HEADERS, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const quotes = j?.finance?.result?.[0]?.quotes || [];
    const items = quotes.map(q => ({
      ticker: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice ?? null,
      changePercent: q.regularMarketChangePercent ?? null,
      volume: q.regularMarketVolume ?? null,
      marketCap: q.marketCap ?? null,
    })).filter(it => it.ticker);

    return res.status(200).json({ ok: true, items, ts: Date.now() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
