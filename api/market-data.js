/**
 * market-data.js — 시세/기술지표/실적/경제캘린더/시간외 통합 (Vercel Hobby 플랜
 * 서버리스 함수 12개 제한 대응 — quotes/technicals/earnings/market-pulse/
 * kr-overtime 5개를 하나로 합쳐 함수 개수를 줄인다)
 *
 * GET /api/market-data?source=quotes&tickers=...        (구 /api/quotes)
 * GET /api/market-data?source=technicals&tickers=...     (구 /api/technicals)
 * GET /api/market-data?source=earnings[&type=analyst]    (구 /api/earnings)
 * GET /api/market-data?source=earnings-calendar          (구 /api/earnings-calendar) — 이번주·다음주 미국 대형주 실적 캘린더
 * GET /api/market-data?source=market-pulse[&type=trump]  (구 /api/market-pulse)
 * GET /api/market-data?source=kr-overtime&codes=...&session=pre|post (구 /api/kr-overtime)
 * GET /api/market-data?source=us-market&type=actives|gainers|losers  (미장현황 랭킹 — Yahoo 스크리너)
 *
 * 실제 공개 경로(/api/quotes 등)는 vercel.json rewrites로 여기로 연결되며,
 * 프론트엔드 fetch 호출은 전혀 바뀌지 않는다.
 */
import { createClient } from '@supabase/supabase-js';
import { verifyAdmin } from '../lib/auth.js';
import WebSocket from 'ws';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  const source = (req.query.source || '').toString();
  switch (source) {
    case 'quotes':       return handleQuotes(req, res);
    case 'kr-proxy':     return handleKrProxy(req, res);
    case 'kr-estimate':  return handleKrEstimate(req, res);
    case 'kis-test': {
      // 디버그 전용 — KIS 실전 API 원본 응답을 그대로 확인(필드명을 감으로 짜지 않기 위함).
      // 어드민 인증 필요(발급 제한 있는 실전 API라 공개하면 남용될 수 있음). 브라우저 주소창에
      // 바로 붙여넣어 테스트할 수 있게 헤더 대신 ?secret= 쿼리도 허용(임시 디버그 라우트라서
      // 로그/히스토리에 새는 것보다 당장 원인 파악이 급함 — 원인 찾으면 이 라우트 자체를 뗄 것).
      const authHeader = req.headers.authorization || (req.query.secret ? `Bearer ${req.query.secret}` : '');
      const _a = await verifyAdmin(authHeader);
      if (!_a.ok) return res.status(401).json({ error: _a.error });
      res.setHeader('Cache-Control', 'no-store');
      // 어디서 멈추는지 보려고 25초 하드 타임아웃을 건다 — 응답이 "영영 안 옴" 상태가 되면
      // 안에서 뭘 기다리는지 알 도리가 없으니, 반드시 뭐라도(에러든 결과든) 돌려주게 만든다.
      const _diag = {};
      const result = await Promise.race([
        fetchKisNightFuture(true, _diag),
        new Promise(resolve => setTimeout(() => resolve({ error: '25초 워치독 — 어딘가 응답 없이 멈춤', diag: _diag }), 25000)),
      ]);
      return res.status(200).json({ ok: true, result });
    }
    case 'kis-ws-test': {
      // 디버그 전용(TEMP) — H0MFASP0 WebSocket 실시간 체결가 원본을 확인. kis-test와
      // 동일하게 어드민 인증 필요(?secret= 쿼리도 허용, 임시 디버그라 편의 우선).
      const authHeader2 = req.headers.authorization || (req.query.secret ? `Bearer ${req.query.secret}` : '');
      const _a2 = await verifyAdmin(authHeader2);
      if (!_a2.ok) return res.status(401).json({ error: _a2.error });
      res.setHeader('Cache-Control', 'no-store');
      const _diag2 = {};
      const result2 = await Promise.race([
        debugKisWebSocket(_diag2),
        new Promise(resolve => setTimeout(() => resolve({ error: '25초 워치독 — 어딘가 응답 없이 멈춤', diag: _diag2 }), 25000)),
      ]);
      return res.status(200).json({ ok: true, result: result2 });
    }
    case 'technicals':   return handleTechnicals(req, res);
    case 'earnings':     return (req.query.type === 'analyst') ? handleAnalyst(res) : handleEarnings(res);
    case 'earnings-calendar': return handleEarningsCalendar(req, res);
    case 'earnings-detail':   return handleEarningsDetail(req, res);
    case 'market-pulse':  {
      const type = (req.query.type || 'economic').toString();
      if (type === 'trump') return handleTrump(res);
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 80);
      return handleEconomic(res, limit);
    }
    case 'kr-overtime':  return handleKrOvertime(req, res);
    case 'us-market':    return handleUsMarket(req, res);
    case 'etf': {
      const action = (req.query.action || 'list').toString();
      if (action === 'list')      return handleEtfList(req, res);
      if (action === 'detail')   return handleEtfDetail(req, res);
      if (action === 'holders')  return handleEtfHolders(req, res);
      if (action === 'rankings') return handleEtfRankings(req, res);
      return res.status(400).json({ ok: false, error: 'unknown etf action' });
    }
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
// retries=1(기본) → 최대 2회 시도. GCP e2-micro 프록시가 순간 과부하로 타임아웃/무응답일 때
// 첫 실패만으로 바로 포기하지 않고 400ms 뒤 한 번 더 찔러본다(실측: 몇 초 뒤 재시도하면 정상화).
async function callTossProxy(path, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(`${process.env.TOSS_PROXY_URL}${path}`, {
        headers: { 'x-proxy-secret': process.env.TOSS_PROXY_SECRET },
        signal: AbortSignal.timeout(6000),
      });
      if (r.ok) return await r.json();
    } catch { /* 다음 시도로 폴백 */ }
    if (attempt < retries) await new Promise(r => setTimeout(r, 400));
  }
  return null;
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
    res.setHeader('Cache-Control', 'no-store');
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
  if (!data) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ ok: false, error: 'toss proxy unreachable' }); }

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
  if (!data) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ ok: false, error: 'toss proxy unreachable' }); }
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

// toss_rankings_cache(db/toss-rankings-cache.sql)에서 마지막 성공 응답을 읽어 stale로 대체 —
// 프록시(GCP VM)가 완전히 죽었을 때 "데이터가 없어요" 대신 오래된 데이터라도 보여준다.
async function tossRankingsCacheFallback(res, market) {
  try {
    const { data: cached } = await supabase
      .from('toss_rankings_cache')
      .select('categories, updated_at')
      .eq('market', market)
      .maybeSingle();
    if (cached?.categories) {
      // 프록시가 오래 다운되면 이 폴백이 방문자 수만큼 반복 호출되므로 짧게라도 캐시(no-store였던 것 수정).
      res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=120');
      res.status(200).json({ ok: true, market, categories: cached.categories, updatedAt: cached.updated_at, stale: true });
      return true;
    }
  } catch { /* 테이블이 아직 없거나(마이그레이션 전) 조회 실패 — fail-open으로 502 폴백 */ }
  return false;
}

// GET ?source=toss&action=rankings-all&market=KR|US&count=12 — 메인 페이지 실시간 랭킹.
// 5개 카테고리(인기/거래대금/거래량/급상승/급하락)를 한 번에 + 종목명 배치 해석.
// 랭킹 아이템엔 name이 없어(코드만) /stocks로 이름·시장을 함께 조회해 병합한다.
// realtime/1d 전략: 인기·거래대금·거래량은 realtime(장 마감이어도 마지막 정규장 반환),
// 급상승·급하락은 realtime 미지원이라 1d(= 마지막 정규장 세션 기준).
async function handleTossRankingsAll(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // 모든 방문자가 동일 페이로드(시장별 고정 요청) → edge 캐시가 origin 호출을 흡수(레이트리밋 방어).
  // 10초로 단축(2026-07-21) — 종목 quote 엔드포인트가 이미 10초 주기로 안정 운영 중인 것과
  // 맞춤. 이보다 더 낮추면 카테고리 5개를 한 번에 부르는 이 호출 특성상 GCP e2-micro
  // 프록시 부담이 검증 안 된 영역이라 일단 여기서 지켜본다.
  res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
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
  if (raw.every(d => !d)) {
    if (await tossRankingsCacheFallback(res, market)) return;
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ ok: false, error: 'toss proxy unreachable' });
  }

  // realtime이 빈 배열을 주는 경우가 실측됨(장 마감 시간대의 US 마켓에서 특히 자주) — 주석의
  // "장 마감이어도 마지막 정규장 반환"이 실제론 시장/카테고리에 따라 보장되지 않으므로,
  // gainers/losers가 애초에 1d를 쓰는 것과 같은 이유로 1d 폴백을 추가한다.
  await Promise.all(CATS.map(async (c, i) => {
    if (c.duration === 'realtime' && !(raw[i]?.result?.rankings?.length)) {
      const fallback = await callTossProxy(`/rankings?type=${c.type}&marketCountry=${market}&duration=1d&count=${count}`);
      if (fallback?.result?.rankings?.length) raw[i] = fallback;
    }
  }));

  // 종목명·시장 배치 해석 (랭킹 아이템엔 이름이 없음)
  const symSet = new Set();
  raw.forEach(d => (d?.result?.rankings || []).forEach(r => { if (r.symbol) symSet.add(r.symbol); }));
  const nameMap = {};
  const symList = [...symSet];
  if (symList.length) {
    const stocks = await callTossProxy(`/stocks?symbols=${encodeURIComponent(symList.join(','))}`);
    for (const s of stocks?.result || []) nameMap[s.symbol] = { name: s.name || s.englishName || s.symbol, market: s.market || null };
  }
  // 미장 소형 레버리지/인버스 ETF 등은 Toss가 한글명이 없어 티커를 그대로 name으로 줌
  // (예: KOLD) — 이런 것만 골라 Yahoo shortName(정식 영문명)으로 보강. 완전 실패해도 티커 유지.
  if (market === 'US') {
    const needFallback = symList.filter(s => !nameMap[s]?.name || nameMap[s].name === s);
    if (needFallback.length) {
      await mapWithConcurrency(needFallback, 6, async (sym) => {
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
            { headers: SHARED_HEADERS, signal: AbortSignal.timeout(5000) });
          if (!r.ok) return;
          const j = await r.json();
          const short = j?.chart?.result?.[0]?.meta?.shortName;
          if (short) nameMap[sym] = { ...(nameMap[sym] || {}), name: short };
        } catch {}
      });
    }
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

  // 개별 프록시 호출은 일부 성공했지만(raw가 all-null은 아님) 최종 카테고리가 전부 빈 배열인
  // 경우(realtime 미지원 시장 + 1d 폴백까지 실패 등) — 이것도 사용자 입장에선 "빈 화면"이므로
  // 동일하게 stale 캐시로 대체 시도.
  const hasAny = Object.values(categories).some(arr => arr.length > 0);
  if (!hasAny) {
    if (await tossRankingsCacheFallback(res, market)) return;
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, market, categories, updatedAt: new Date().toISOString() });
  }

  // 성공 응답을 캐시에 적어두기(다음 실패 시 stale 폴백용). 실패해도 응답 자체는 막지 않는다.
  try {
    await supabase.from('toss_rankings_cache').upsert({ market, categories, updated_at: new Date().toISOString() });
  } catch { /* 테이블 미생성 등 — fail-open */ }

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
  if (!data) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ ok: false, error: 'toss proxy unreachable' }); }

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
  if (!data) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ ok: false, error: 'toss proxy unreachable' }); }

  return res.status(200).json({ ok: true, rate: data.result?.rate != null ? Number(data.result.rate) : null });
}

// GET ?source=toss&action=quote&symbol=AAPL — 통합가(Toss lastPrice, 세션 구분 없이 하나) +
// 정규장/시간외 변동 분해(전부 Toss 공식 데이터로 서버에서 계산). Toss /prices는 marketState나
// pre/day/after 세션별 가격을 안 주므로(공식 스키마 확인됨), 일별 캔들의 종가를 "정규장 마감가"
// 기준점으로 삼아 직접 계산한다 — 캔들 종가는 정규장만 반영(확인됨: 시간외 체결이 있어도
// /prices의 lastPrice와 최근 완결 캔들 종가가 서로 다르게 나옴).
//
// ⚠️ KR "전일 종가" 함정(2026-07-21 실측, 000660): Toss 일별 캔들의 전일 종가(정규장 15:30
// 마감가, 예 1,841,000)를 그대로 prevClose로 쓰면 홈 실시간 랭킹(Toss 자체 changeRate 기반,
// 예 +2.66%)과 종목 상세 페이지("정규" 표기, 캔들 기준 계산 시 -1.63%)의 등락률이 크게
// 어긋난다 — 같은 순간, 같은 lastPrice인데도. 네이버 integration의 lastClosePrice(예
// 1,764,000)가 Toss changeRate의 역산값과 정확히 일치함을 확인함 — NXT 애프터마켓(~20:00)
// 거래가 있으면 "전일 종가"가 정규장 마감가가 아니라 NXT 마감 시점 가격이 되기 때문으로
// 보인다. 그래서 KR 종목은 네이버 lastClosePrice를 prevClose로 우선 사용하고(랭킹 위젯과
// 항상 일치), 실패하면만 캔들 기반 값으로 폴백한다. US는 NXT가 없어 기존 캔들 방식 유지.
async function fetchNaverLastClose(code) {
  try {
    const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/integration`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockRipple/1.0)' },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const raw = data?.totalInfos?.find(i => i.code === 'lastClosePrice')?.value;
    const n = raw != null ? Number(String(raw).replace(/,/g, '')) : null;
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

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
    isKr ? callTossProxy(`/market-calendar/KR`) : callTossProxy(`/market-calendar/US?date=${kstToday}`),
    isKr ? null : callTossProxy(`/market-calendar/US?date=${kstYest}`),
    isKr ? fetchNaverLastClose(symbol) : null,
  ];
  const [priceData, candleData, calA, calB, naverLastClose] = await Promise.all(calls);

  const p = priceData?.result?.[0];
  if (!p) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ ok: false, error: 'toss proxy unreachable' }); }
  const lastPrice = p.lastPrice != null ? Number(p.lastPrice) : null;

  const candles = candleData?.result?.candles || [];
  const regularClose = candles[0]?.closePrice != null ? Number(candles[0].closePrice) : null;
  // "전일 종가" 기준점 — KR은 네이버 lastClosePrice 우선(위 주석 참고), 실패하면 캔들 폴백.
  const prevClose = isKr
    ? (naverLastClose ?? (candles[1]?.closePrice != null ? Number(candles[1].closePrice) : null))
    : (candles[1]?.closePrice != null ? Number(candles[1].closePrice) : null);

  // 세션 라벨
  let session = 'CLOSED';
  if (!isKr) {
    // ⚠️ 토스 데이마켓(2026-07-21 사용자 지적): 토스는 미국주식을 한국시간 기준 거의 24시간
    // 가깝게 거래 지원한다(데이마켓 09~17시·프리마켓 17~22:30·정규장 22:30~익일06시·
    // 애프터마켓 06~09:50, 실측 09:50~10:00 약 10분만 진짜 휴장) — /market-calendar/US 응답에
    // 이미 dayMarket 필드로 그 구간이 내려오는데 여기서 안 읽고 있어서, 하루 대부분(정확히는
    // 데이마켓 시간대 8시간)을 실제로는 거래 중인데도 "⚪ 마감"으로 잘못 표시하고 있었다.
    const within = s => s && kstNowMs >= new Date(s.startTime).getTime() && kstNowMs < new Date(s.endTime).getTime();
    for (const cal of [calB?.result?.today, calA?.result?.today]) {
      if (!cal) continue;
      if (within(cal.regularMarket)) { session = 'REGULAR'; break; }
      if (within(cal.preMarket))     { session = 'PRE'; break; }
      if (within(cal.afterMarket))   { session = 'POST'; break; }
      if (within(cal.dayMarket))     { session = 'DAY'; break; }
    }
  } else {
    // 넥스트레이드(NXT) 고정 시간대(사용자 확인, 토스 앱 "국내주식 거래 시간 안내" 기준):
    // 프리마켓 08:00-08:50, 정규장(KRX 마감 15:30까지 포함) 09:00-15:30, 애프터마켓 15:30-20:00.
    // 미장과 달리 KRX/NXT는 서머타임이 없고 휴장일 캘린더만 필요해 시각 계산이 단순함.
    // 휴일(주말·공휴일) 여부만 /market-calendar/KR로 확인 — 프록시 실패 시 안전하게 휴장(CLOSED) 취급.
    const isHoliday = !calA?.result?.today?.integrated;
    if (!isHoliday) {
      const kstMinutes = (m => m.getUTCHours() * 60 + m.getUTCMinutes())(new Date(kstNowMs + 9 * 3600000));
      // NXT는 08:50-09:00·15:20-15:30에 실제 주문체결이 멈추지만(휴장), 사용자 입장에선 그
      // 짧은 공백까지 "마감"으로 보이면 혼란스러우므로(정규장 시작 10분 전을 마감이라 부를 수 없음)
      // 라벨은 그 공백을 각각 앞뒤 세션(프리장/정규장)에 붙여 09:00 개장 전엔 계속 프리장으로 둔다.
      if (kstMinutes >= 8 * 60 && kstMinutes < 9 * 60) session = 'PRE';
      else if (kstMinutes >= 9 * 60 && kstMinutes < 15 * 60 + 30) session = 'REGULAR';
      else if (kstMinutes >= 15 * 60 + 30 && kstMinutes < 20 * 60) session = 'POST';
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
  // 시간외 변동(정규장 마감가 대비)은 프리/애프터/데이마켓일 때만 의미가 있음
  let exChange = null, exChangePercent = null;
  if ((session === 'PRE' || session === 'POST' || session === 'DAY') && lastPrice != null && regularClose) {
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
  if (!data) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ ok: false, error: 'toss proxy unreachable' }); }
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
  if (!s) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ ok: false, error: 'toss proxy unreachable' }); }
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
  if (!data) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ ok: false, error: 'toss proxy unreachable' }); }
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
  if (!data) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ ok: false, error: 'toss proxy unreachable' }); }
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
// kr-proxy — GET ?source=kr-proxy
// 국장 마감 중에 "해외에서 거래되는 한국물"이 지금 어떻게 움직이는지 모아준다.
// 국장 재개장 시 예상 가격을 역산하기 위한 원재료(raw signal)만 제공하고,
// 가중치·베타 같은 모델 파라미터는 클라이언트(kr-market.html)가 갖는다 —
// 모델을 고도화할 때 서버 재배포 없이 프론트만 고치면 되게 하려는 의도.
//
// 각 소스는 실패해도 전체를 깨뜨리지 않고 available:false로만 표시된다.
// (특히 바이낸스는 지역/네트워크에 따라 아예 막히는 환경이 있어 필수 아님)
// ════════════════════════════════════════════════════════════════════════

// 해외 상장 한국물 — 국장 종목과 1:1로 대응되는 ADR/ETF
const KR_PROXY_SYMBOLS = {
  EWY: { kind: 'etf', label: 'MSCI 한국 ETF' },        // 한국 시장 전체
  '^SOX': { kind: 'index', label: '필라델피아 반도체' },  // 반도체 섹터
  'KRW=X': { kind: 'fx', label: '원/달러' },
  SKM: { kind: 'adr', label: 'SK텔레콤', kr: '017670.KS' },
  KB:  { kind: 'adr', label: 'KB금융',   kr: '105560.KS' },
  PKX: { kind: 'adr', label: '포스코홀딩스', kr: '005490.KS' },
  LPL: { kind: 'adr', label: 'LG디스플레이', kr: '034220.KS' },
  WF:  { kind: 'adr', label: '우리금융',  kr: '316140.KS' },
  SHG: { kind: 'adr', label: '신한지주',  kr: '055550.KS' },
  KEP: { kind: 'adr', label: '한국전력',  kr: '015760.KS' },
  // 2026-07-31 NASDAQ 상장(신규, 이전엔 미국 상장 자체가 없어서 리스트에 없었다) — 실측
  // 결과 하루 거래량 4천만~6천만주로 유동성도 충분해 다른 ADR과 동급으로 취급한다.
  SKHY: { kind: 'adr', label: 'SK하이닉스', kr: '000660.KS' },
};

// ════════════════════════════════════════════════════════════════════════
// 코스피200 야간선물(KIS Open API) — 2026-08-01 추가. 사용자가 직접 한국투자증권
// 계좌를 만들고 API키를 발급받아 Vercel 환경변수(KIS_APP_KEY/KIS_APP_SECRET)에
// 저장했다. 다른 소스(binance 등)와 동일하게 실패해도 전체를 깨뜨리지 않고
// fetchKisNightFuture()가 null을 반환하는 fail-open 패턴.
//
// ⚠️ access_token 발급은 KIS 쪽에서 하루 단위로 제한된다 — 요청마다 새 프로세스가
// 뜨는 서버리스 환경이라 인메모리로 캐싱할 수 없어 kis_token_cache 테이블(단일 행)에
// 저장하고 만료 전까지 재사용한다(db/kis-token-cache.sql). 절대 이 캐시를 건너뛰고
// 매 요청 재발급하는 코드로 바꾸지 말 것 — 발급 제한에 걸리면 하루 종일 이 소스가
// 죽는다.
//
// 종목코드(FID_INPUT_ISCD)도 분기 만기 롤오버가 있어 매번 새로 계산하지 않고
// 같은 테이블에 하루 단위로 캐싱한다 — KIS가 공개 배포하는 마스터파일
// (CME연계 야간선물 종목코드, 인증 불필요)에서 KOSPI200 근월물(가장 빠른 만기)을
// 골라낸다. 필드 레이아웃은 KIS 공식 예제(github.com/koreainvestment/open-trading-api
// stocks_info/domestic_cme_future_code.py)의 고정폭 슬라이스를 그대로 이식했다.
// ════════════════════════════════════════════════════════════════════════
function kisConfigured() {
  return !!(process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET);
}

async function getKisToken() {
  const { data: cached } = await supabase.from('kis_token_cache').select('access_token, expires_at').eq('id', 1).maybeSingle();
  if (cached?.access_token && cached.expires_at && new Date(cached.expires_at) > new Date()) {
    return cached.access_token;
  }
  const r = await fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET }),
    signal: AbortSignal.timeout(10000),
  });
  const bodyText = await r.text();
  if (!r.ok) throw new Error(`KIS token HTTP ${r.status}: ${bodyText.slice(0, 300)}`);
  let j; try { j = JSON.parse(bodyText); } catch { throw new Error('KIS token response not JSON: ' + bodyText.slice(0, 200)); }
  if (!j.access_token) throw new Error('KIS token response missing access_token: ' + bodyText.slice(0, 300));
  // expires_in(초, 보통 86400=24시간) 경계에서 만료된 토큰을 쓰는 사고를 막기 위해 1시간 여유.
  const expiresAt = new Date(Date.now() + (Number(j.expires_in || 86400) - 3600) * 1000);
  await supabase.from('kis_token_cache').upsert({
    id: 1, access_token: j.access_token, expires_at: expiresAt.toISOString(), updated_at: new Date().toISOString(),
  });
  return j.access_token;
}

async function getKisNightFutureCode() {
  const { data: cached } = await supabase.from('kis_token_cache')
    .select('night_future_code, night_future_code_updated_at').eq('id', 1).maybeSingle();
  if (cached?.night_future_code && cached.night_future_code_updated_at &&
      Date.now() - new Date(cached.night_future_code_updated_at).getTime() < 20 * 3600 * 1000) {
    return cached.night_future_code;
  }
  const AdmZip = (await import('adm-zip')).default;
  const r = await fetch('https://new.real.download.dws.co.kr/common/master/fo_cme_code.mst.zip', { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`KIS master file HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const zip = new AdmZip(buf);
  const entry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.mst'));
  if (!entry) throw new Error('No .mst in KIS master zip');
  const text = new TextDecoder('euc-kr').decode(entry.getData());

  let best = null; // { code, expiry(YYYYMM) }
  for (const row of text.split(/\r?\n/)) {
    if (row[0] !== '1') continue;                    // 1=선물(outright), 2=캘린더 스프레드 제외
    const code = row.slice(1, 10).trim();
    const dCol = row.slice(22, 63).trim();            // 예: "F 202609"
    const underlying = row.slice(81).trim();          // 예: "KOSPI200"
    if (underlying !== 'KOSPI200') continue;
    const m = dCol.match(/(\d{6})/);
    if (!code || !m) continue;
    const expiry = m[1];
    if (!best || expiry < best.expiry) best = { code, expiry };  // 가장 빠른 만기 = 근월물(거래 가장 활발)
  }
  if (!best) throw new Error('KOSPI200 야간선물 근월물 코드를 찾지 못함(마스터파일 형식이 바뀌었을 수 있음)');

  await supabase.from('kis_token_cache').upsert({
    id: 1, night_future_code: best.code, night_future_code_updated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  return best.code;
}

// ════════════════════════════════════════════════════════════════════════
// [TEMP DEBUG — 2026-08] REST 스냅샷(inquire-price)이 비현실적인 등락률(+18.79%,
// 몇 시간째 고정)을 주는 문제의 원인 파악용. WebSocket 실시간 체결가(H0MFASP0)로
// 받은 원본 메시지를 그대로 눈으로 확인하기 위함 — 정상으로 보이면 REST 대신
// 이 경로로 갈아탈지 판단하고, 확인 끝나면 이 블록 자체를 뗄 것(?source=kis-test와
// 동일한 임시 디버그 관례).
// approval_key는 REST 접근토큰(oauth2/tokenP)과 별개 자격증명(oauth2/Approval).
// ════════════════════════════════════════════════════════════════════════
async function getKisApprovalKey() {
  const r = await fetch('https://openapi.koreainvestment.com:9443/oauth2/Approval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: process.env.KIS_APP_KEY, secretkey: process.env.KIS_APP_SECRET }),
    signal: AbortSignal.timeout(10000),
  });
  const bodyText = await r.text();
  if (!r.ok) throw new Error(`KIS approval HTTP ${r.status}: ${bodyText.slice(0, 300)}`);
  let j; try { j = JSON.parse(bodyText); } catch { throw new Error('KIS approval response not JSON: ' + bodyText.slice(0, 200)); }
  if (!j.approval_key) throw new Error('KIS approval response missing approval_key: ' + bodyText.slice(0, 300));
  return j.approval_key;
}

async function debugKisWebSocket(diag = {}) {
  diag.stage = 'start';
  if (!kisConfigured()) { diag.stage = 'not_configured'; return { error: 'KIS_APP_KEY/KIS_APP_SECRET not set', diag }; }
  const messages = [];
  let ws;
  try {
    diag.stage = 'approval+code_fetch';
    const [approvalKey, code] = await Promise.all([
      getKisApprovalKey().then(k => { diag.approvalOk = true; return k; }),
      getKisNightFutureCode().then(c => { diag.codeOk = true; diag.code = c; return c; }),
    ]);

    diag.stage = 'ws_connect';
    await new Promise((resolve, reject) => {
      ws = new WebSocket('ws://ops.koreainvestment.com:21000');
      const connTimer = setTimeout(() => reject(new Error('WS connect timeout(10s)')), 10000);
      ws.once('open', () => { clearTimeout(connTimer); resolve(); });
      ws.once('error', (e) => { clearTimeout(connTimer); reject(e); });
    });
    diag.stage = 'ws_open';

    // CNT(체결=실제 거래가)와 ASP(호가=매수/매도 스프레드)는 서로 다른 피드다 — 처음엔
    // ASP0만 구독했었는데(호가), 우리가 실제로 원하는 "현재가"에 해당하는 건 체결가인
    // CNT0라 사용자 지적으로 같이 구독하도록 수정(2026-08).
    for (const trId of ['H0MFCNT0', 'H0MFASP0']) {
      ws.send(JSON.stringify({
        header: { approval_key: approvalKey, custtype: 'P', tr_type: '1', 'content-type': 'utf-8' },
        body: { input: { tr_id: trId, tr_key: code } },
      }));
    }
    diag.stage = 'subscribed';

    // 최대 12초 동안 오는 메시지를 전부 모은다 — ACK/PINGPONG만 오고 실제 체결이 없을 수도
    // 있으니(주말/휴장) "아무것도 안 옴"도 유효한 결과로 취급, 타임아웃이어도 에러 아님.
    await new Promise((resolve) => {
      const collectTimer = setTimeout(resolve, 12000);
      ws.on('message', (data) => {
        messages.push(data.toString().slice(0, 500));
        if (messages.length >= 20) { clearTimeout(collectTimer); resolve(); }
      });
      ws.on('close', () => { clearTimeout(collectTimer); resolve(); });
      ws.on('error', () => { clearTimeout(collectTimer); resolve(); });
    });
    diag.stage = 'done';
    return { code, messageCount: messages.length, messages, diag };
  } catch (e) {
    diag.stage = 'error:' + diag.stage;
    diag.errorMessage = e.message;
    return { error: e.message, diag };
  } finally {
    try { ws?.close(); } catch {}
  }
}

// 코스피200 야간선물 프리징 감지(2026-08 실측 사고 대응, db/kis-night-future-freeze.sql).
// 서버리스라 인메모리로 "직전 값"을 기억할 수 없으니 kis_token_cache 단일 행에
// "마지막으로 값이 바뀐 시점"을 적어두고, 그 시점과 지금의 차이로 정체 시간을 잰다.
// kr-market.html의 자동 새로고침 주기(3분, setInterval 180000ms)보다 넉넉히 잡아야
// 정상적인 새로고침 타이밍에 오탐이 안 나므로 임계값은 2배 이상인 7분으로 둔다.
const KIS_FREEZE_THRESHOLD_MS = 7 * 60 * 1000;
async function isKisNightFutureFrozen(price, chg) {
  try {
    const { data, error } = await supabase.from('kis_token_cache')
      .select('night_future_last_price, night_future_last_change, night_future_last_seen_at')
      .eq('id', 1).maybeSingle();
    // 마이그레이션 전(컬럼 없음) — 감지 기능만 건너뛴다, 시세 자체는 그대로 흘려보냄(fail-open).
    if (error && /night_future_last/.test(error.message || '')) return false;

    const now = Date.now();
    const samePrice = data?.night_future_last_price != null && Math.abs(Number(data.night_future_last_price) - price) < 1e-9;
    const sameChg = (chg == null && data?.night_future_last_change == null) ||
      (chg != null && data?.night_future_last_change != null && Math.abs(Number(data.night_future_last_change) - chg) < 1e-9);
    const unchanged = samePrice && sameChg;
    const seenAt = data?.night_future_last_seen_at ? new Date(data.night_future_last_seen_at).getTime() : null;
    const frozen = unchanged && seenAt != null && (now - seenAt) > KIS_FREEZE_THRESHOLD_MS;

    // 값이 바뀌었으면(또는 이번이 처음이면) "마지막으로 바뀐 시각"을 지금으로 갱신한다 —
    // 같은 값이 계속 오는 동안은 이 시각을 건드리지 않아야 정체 시간을 정확히 잴 수 있다.
    if (!unchanged) {
      await supabase.from('kis_token_cache').upsert({
        id: 1, night_future_last_price: price, night_future_last_change: chg,
        night_future_last_seen_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
      });
    }
    return frozen;
  } catch {
    return false; // 감지 로직 자체의 실패가 원본 시세 흐름을 막으면 안 된다(fail-open).
  }
}

// raw:true면 파싱 없이 KIS 원본 응답을 그대로 반환(?source=kis-test 디버그용) —
// 실전 거래 API라 필드명을 감으로 짜지 않고 실제 응답을 먼저 눈으로 확인하기 위함.
// diag: 어느 단계까지 갔는지 밖(워치독)에서도 볼 수 있게 공유 객체에 계속 적어둔다
// — 이 함수가 25초 안에 안 끝나서 워치독이 대신 응답할 때도 diag.stage로 어디서
// 멈췄는지 알 수 있다.
export async function fetchKisNightFuture(raw = false, diag = {}) {
  diag.stage = 'start';
  if (!kisConfigured()) { diag.stage = 'not_configured'; return raw ? { error: 'KIS_APP_KEY/KIS_APP_SECRET not set', diag } : null; }
  try {
    diag.stage = 'token+code_fetch';
    const [token, code] = await Promise.all([
      getKisToken().then(t => { diag.tokenOk = true; return t; }),
      getKisNightFutureCode().then(c => { diag.codeOk = true; diag.code = c; return c; }),
    ]);
    diag.stage = 'quote_fetch';
    const r = await fetch(
      `https://openapi.koreainvestment.com:9443/uapi/domestic-futureoption/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=F&FID_INPUT_ISCD=${encodeURIComponent(code)}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          appkey: process.env.KIS_APP_KEY,
          appsecret: process.env.KIS_APP_SECRET,
          tr_id: 'FHMIF10000000',
          custtype: 'P',
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    diag.stage = 'quote_response_received';
    const bodyText = await r.text();
    diag.stage = 'done';
    if (raw) {
      let parsed; try { parsed = JSON.parse(bodyText); } catch { parsed = null; }
      return { httpStatus: r.status, code, body: parsed || bodyText.slice(0, 1000), diag };
    }
    if (!r.ok) return null;
    const j = JSON.parse(bodyText);
    const o = j?.output1 || j?.output;
    if (!o) return null;
    const price = Number(o.futs_prpr);
    const chg = Number(o.futs_prdy_ctrt);
    if (!isFinite(price)) return null;
    // 실측(2026-08) 결과 이 값이 몇 시간째 그대로 고정돼 있으면서 실제 시세와 크게
    // 어긋나는 사례를 확인했다(우리 값 +18.79% vs 실제 네이버 증권 -4.78% — 사용자
    // 리포트로 발견). 지수선물 단일 세션 등락률로 ±10%p는 비현실적으로 큰 값이라, 원인은
    // 불명이지만(모의투자 키 오설정 등 KIS 계정 쪽 문제로 추정) 최소한 명백히 틀린 값이
    // 아래 소비처(kr-market.html 배너·추정모델 가중치, 홈 대시보드 카드)로 흘러가 실시간인
    // 것처럼 보이지 않도록 이 소스에서부터 무효 처리한다 — 둘 다 null을 "신호 없음"으로
    // fail-open 처리하고 있어 여기서 막으면 두 곳 다 자동으로 안전해진다.
    if (isFinite(chg) && Math.abs(chg) > 10) {
      console.error(`[kis] night future changePercent implausible (${chg}%) — treating as unavailable`);
      return null;
    }
    // 위 ±10%p 체크는 두 번째 실측 사고(2026-08, 등락률 -3.72%로 몇 분 넘게 고정되며
    // 실제로는 -5.4%대까지 하락 — 폭이 10%를 안 넘어 위 체크를 그냥 통과)를 못 잡는다.
    // 값 자체가 오래 안 바뀌면 피드가 멈춘 것으로 보고 별도로 무효 처리한다.
    if (await isKisNightFutureFrozen(price, isFinite(chg) ? chg : null)) {
      console.error(`[kis] night future quote frozen (price=${price}, chg=${chg}%) for too long — treating as unavailable`);
      return null;
    }
    return { code, price, changePercent: isFinite(chg) ? chg : null };
  } catch (e) {
    diag.stage = 'error:' + diag.stage;
    diag.errorMessage = e.message;
    diag.errorName = e.name;
    if (raw) return { error: e.message, errorName: e.name, diag };
    console.error('[kis] night future fetch failed:', e.message);
    return null;
  }
}

// 바이낸스에 상장된 주식 perp(토큰화 주식 선물). 심볼 표기는 거래소마다 다르고
// 상장/폐지가 잦아 후보를 여러 개 두고 먼저 잡히는 것을 쓴다.
const BINANCE_STOCK_PERPS = {
  '005930.KS': ['SAMSUNGUSDT', 'SAMSUNGELECUSDT'],
  '000660.KS': ['SKHYNIXUSDT', 'HYNIXUSDT'],
};

async function fetchYahooChange(ticker) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
      { headers: SHARED_HEADERS, signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return null;
    const meta = (await r.json())?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    // 정규장 종료 후에도 시간외가가 있으면 그쪽이 "지금 값"에 더 가깝다
    const prev = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const live = meta.postMarketPrice ?? meta.regularMarketPrice ?? meta.preMarketPrice ?? null;
    if (live == null || !prev) return null;
    return {
      price: live,
      prevClose: prev,
      changePercent: ((live - prev) / prev) * 100,
      marketState: meta.marketState ?? null,
      currency: meta.currency ?? null,
    };
  } catch { return null; }
}

// 바이낸스 주식 perp — 24시간 돌아서 국장·미장이 다 닫힌 시간에도 유일하게 살아있는 신호.
// 다만 지역 차단·심볼 폐지 가능성이 있어 3초 안에 안 오면 그냥 포기한다.
async function fetchBinancePerps() {
  const out = { available: false, reason: null, items: {} };
  try {
    const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', {
      headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(3500),
    });
    if (!r.ok) { out.reason = `HTTP ${r.status}`; return out; }
    const arr = await r.json();
    if (!Array.isArray(arr)) { out.reason = 'unexpected payload'; return out; }
    const bySym = new Map(arr.map(x => [x.symbol, x]));
    for (const [krTicker, cands] of Object.entries(BINANCE_STOCK_PERPS)) {
      const hit = cands.map(s => bySym.get(s)).find(Boolean);
      if (!hit) continue;
      const chg = Number(hit.priceChangePercent);
      if (!isFinite(chg)) continue;
      out.items[krTicker] = {
        symbol: hit.symbol, price: Number(hit.lastPrice) || null,
        changePercent: chg, quoteVolume: Number(hit.quoteVolume) || null,
      };
    }
    out.available = Object.keys(out.items).length > 0;
    if (!out.available) out.reason = 'no matching stock perp symbol';
    return out;
  } catch (e) {
    out.reason = e.name === 'TimeoutError' ? 'timeout (지역 차단 가능)' : (e.message || 'unreachable').slice(0, 80);
    return out;
  }
}

// ════════════════════════════════════════════════════════════════════════
// kr-estimate — 해외 신호로 국장 재개장가를 역산하는 모델 + 실측 정확도 기록
//
//   추정등락% = Σ(소스등락% × beta × w) / Σ(w)        ← 사용 가능한 소스만
//   추정가    = 직전 종가 × (1 + 추정등락%/100)
//
// ⚠️ 모델을 여기(서버)에 둔 이유: 개장 전 스냅샷을 크론이 기록해야 정확도를
// 누적 측정할 수 있는데, 클라이언트에만 있으면 서버가 같은 값을 재현할 수 없다.
// 튜닝은 아래 EST_MODEL 하나만 고치면 되고 클라이언트는 렌더링만 한다.
//
//   GET ?source=kr-estimate                  → 추정치(또는 장중이면 mode:'live')
//   GET ?source=kr-estimate&action=accuracy  → 누적 오차 통계 (공개)
//   GET ?source=kr-estimate&action=record    → 스냅샷+정산 (ADMIN/CRON 인증)
// ════════════════════════════════════════════════════════════════════════
// 2026-08-01: 전 종목에 kis_night_future(코스피200 야간선물, KIS) 추가 — 사용자 요청
// ("가장 많이 고려하는 게 코스피 야간선물일 것 같은데"). 개별 ADR과 달리 시장 전체
// 방향을 직접 반영하는 신호라 모든 종목에 공통으로 넣었다. 가중치는 "종목 고유 신호
// (ADR/binance) > 야간선물(시장 전체, 그래도 EWY보다 직접적) > EWY/SOX(간접 프록시)"
// 순서를 유지하도록 잡았다 — 오늘(2026-08-01) 붙인 첫날이라 감으로 정한 시작값이고,
// est_accuracy가 며칠 쌓이면 bias 보고 조정할 것(감으로 재조정 금지, CLAUDE.md 참고).
const EST_MODEL = {
  version: '2026-08-01.2',
  targets: [
    { t: '005930.KS', name: '삼성전자', c: '#1428A0', ini: '삼성',
      sources: [{ id: 'binance', w: 1.7 }, { id: 'kis_night_future', w: 1.3 }, { id: 'ewy', w: 1.0, beta: 1.0 }, { id: 'sox', w: 0.9, beta: 0.85 }] },
    // 2026-07-31 SK하이닉스 NASDAQ 직상장(SKHY, KR_PROXY_SYMBOLS 참고)으로 binance
    // perp/SOX 대신 실제 1:1 상장 종목을 쓸 수 있게 됐다 — 다른 6개 ADR 종목과
    // 동일 패턴(adr: w2.2 + ewy w0.5)으로 맞춘다. 삼성전자는 미국 상장이 없어 그대로 유지.
    { t: '000660.KS', name: 'SK하이닉스', c: '#E8380D', ini: 'SK',
      sources: [{ id: 'adr:SKHY', w: 2.2 }, { id: 'kis_night_future', w: 1.0 }, { id: 'ewy', w: 0.5 }] },
    { t: '005490.KS', name: '포스코홀딩스', c: '#00A0E9', ini: 'PO',
      sources: [{ id: 'adr:PKX', w: 2.2 }, { id: 'kis_night_future', w: 1.0 }, { id: 'ewy', w: 0.5 }] },
    { t: '055550.KS', name: '신한지주', c: '#0046FF', ini: '신한',
      sources: [{ id: 'adr:SHG', w: 2.2 }, { id: 'kis_night_future', w: 1.0 }, { id: 'ewy', w: 0.5 }] },
    { t: '105560.KS', name: 'KB금융', c: '#FFB700', ini: 'KB',
      sources: [{ id: 'adr:KB', w: 2.2 }, { id: 'kis_night_future', w: 1.0 }, { id: 'ewy', w: 0.5 }] },
    { t: '015760.KS', name: '한국전력', c: '#0B5EA8', ini: '한전',
      sources: [{ id: 'adr:KEP', w: 2.2 }, { id: 'kis_night_future', w: 1.0 }, { id: 'ewy', w: 0.5 }] },
    { t: '034220.KS', name: 'LG디스플레이', c: '#A50034', ini: 'LG',
      sources: [{ id: 'adr:LPL', w: 2.2 }, { id: 'kis_night_future', w: 1.0 }, { id: 'ewy', w: 0.5 }] },
    { t: '017670.KS', name: 'SK텔레콤', c: '#E8380D', ini: 'SKT',
      sources: [{ id: 'adr:SKM', w: 2.2 }, { id: 'kis_night_future', w: 1.0 }, { id: 'ewy', w: 0.5 }] },
  ],
};

function estResolveSignal(id, P, ticker) {
  const n = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  if (id.startsWith('adr:')) {
    const sym = id.slice(4), o = P.overseas?.[sym];
    return { v: n(o?.changePercent), label: sym, tip: (o?.label || sym) + ' ADR (1:1 대응)' };
  }
  if (id === 'ewy') return { v: n(P.overseas?.EWY?.changePercent), label: 'EWY', tip: 'MSCI 한국 ETF' };
  if (id === 'sox') return { v: n(P.overseas?.['^SOX']?.changePercent), label: 'SOX', tip: '필라델피아 반도체 지수' };
  if (id === 'binance') return { v: n(P.binance?.items?.[ticker]?.changePercent), label: '바이낸스', tip: '주식 perp (24시간)' };
  // 코스피200 야간선물(KIS) — 개별 종목 ADR과 달리 시장 전체 방향을 직접 반영하는 신호라
  // 모든 종목에 공통으로 쓰인다(2026-08-01 추가). EWY보다 더 직접적인 신호로 취급.
  if (id === 'kis_night_future') return { v: n(P.kisNightFuture?.changePercent), label: '코스피200 야간선물', tip: 'KIS 코스피200 야간선물(CME 연계) 근월물' };
  return { v: null, label: id, tip: id };
}

// P = kr-proxy 결과, Q = { '005930.KS': {price,...} }
function computeEstimates(P, Q) {
  return EST_MODEL.targets.map(tg => {
    const q = Q[tg.t] || {};
    const base = (typeof q.price === 'number' && isFinite(q.price)) ? q.price : null;
    const used = [], missing = [];
    for (const s of tg.sources) {
      const r = estResolveSignal(s.id, P, tg.t);
      if (r.v == null) { missing.push(r.label); continue; }
      used.push({ id: s.id, label: r.label, tip: r.tip, w: s.w, beta: s.beta ?? 1, value: r.v, adj: r.v * (s.beta ?? 1) });
    }
    const out = { ...tg, base, used, missing, estChangePct: null, estPrice: null, confidence: 0 };
    if (!used.length || base == null) return out;

    const tw = used.reduce((a, s) => a + s.w, 0);
    const est = used.reduce((a, s) => a + s.adj * s.w, 0) / tw;
    const mean = used.reduce((a, s) => a + s.adj, 0) / used.length;
    const sd = Math.sqrt(used.reduce((a, s) => a + (s.adj - mean) ** 2, 0) / used.length);
    let conf = 1;
    if (used.length >= 2) conf++;
    if (used.length >= 3) conf++;
    if (sd < 2.5) conf++;

    out.estChangePct = est;
    out.estPrice = base * (1 + est / 100);
    out.confidence = Math.max(1, Math.min(4, conf));
    out.dispersion = sd;
    return out;
  });
}

// KST 기준 날짜/시각
function kstParts(ms = Date.now()) {
  const k = new Date(ms + 9 * 3600000);
  return { date: k.toISOString().slice(0, 10), hour: k.getUTCHours(), min: k.getUTCMinutes(), dow: k.getUTCDay() };
}

async function estFetchQuotes(tickers) {
  const pairs = await mapWithConcurrency(tickers, 6, async (t) => {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=1d`,
        { headers: SHARED_HEADERS, signal: AbortSignal.timeout(5000) });
      if (!r.ok) return [t, null];
      const m = (await r.json())?.chart?.result?.[0]?.meta;
      if (!m) return [t, null];
      return [t, { price: m.regularMarketPrice ?? null, prevClose: m.chartPreviousClose ?? m.previousClose ?? null, marketState: m.marketState ?? null }];
    } catch { return [t, null]; }
  });
  return Object.fromEntries(pairs.filter(([, v]) => v));
}

// 특정 개장일의 실제 시가 — 정산용. Yahoo 일봉의 timestamp는 KRX 세션 시작(00:00 UTC)이라
// UTC 날짜 문자열이 그대로 KST 개장일과 일치한다.
async function estFetchOpen(ticker, sessionDate) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=10d`,
      { headers: SHARED_HEADERS, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json(), res = j?.chart?.result?.[0];
    const ts = res?.timestamp || [], op = res?.indicators?.quote?.[0]?.open || [];
    for (let i = 0; i < ts.length; i++) {
      if (new Date(ts[i] * 1000).toISOString().slice(0, 10) === sessionDate) {
        const v = op[i];
        return (typeof v === 'number' && isFinite(v)) ? v : null;
      }
    }
    return null;
  } catch { return null; }
}

// 스냅샷(개장 전) + 정산(개장 후). 크론이 매시간 불러도 안전하도록 전부 멱등.
async function estRecordAndSettle() {
  const { date, hour, dow } = kstParts();
  const log = { date, hour, snapshot: null, settled: 0, skipped: null };

  // ── 1) 스냅샷: 평일 07~08시대(개장 직전)에 오늘자 추정치를 남긴다
  if (dow >= 1 && dow <= 5 && hour >= 7 && hour < 9) {
    const { data: exist } = await supabase.from('est_accuracy')
      .select('id').eq('session_date', date).limit(1);
    if (exist?.length) log.snapshot = 'already recorded';
    else {
      const tickers = EST_MODEL.targets.map(t => t.t);
      const [P, Q] = await Promise.all([fetchKrProxyPayload(), estFetchQuotes(tickers)]);
      const rows = computeEstimates(P, Q)
        .filter(e => e.estChangePct != null)
        .map(e => ({
          ticker: e.t, session_date: date, model_version: EST_MODEL.version,
          base_close: e.base, est_change_pct: e.estChangePct, est_price: e.estPrice,
          sources: e.used.map(u => ({ id: u.id, label: u.label, w: u.w, beta: u.beta, value: u.value, adj: u.adj })),
        }));
      if (rows.length) {
        const { error } = await supabase.from('est_accuracy').upsert(rows, { onConflict: 'ticker,session_date' });
        log.snapshot = error ? `error: ${error.message}` : `recorded ${rows.length}`;
      } else log.snapshot = 'no estimate available';
    }
  } else log.skipped = 'not pre-open window (KST 평일 07~09시에만 스냅샷)';

  // ── 2) 정산: 아직 시가가 안 채워진 행을 실제 시가로 마감. 개장 후(09:10~)에만.
  const { data: pending } = await supabase.from('est_accuracy')
    .select('id, ticker, session_date, base_close, est_change_pct')
    .is('settled_at', null).lte('session_date', date)
    .order('session_date', { ascending: true }).limit(40);
  for (const row of (pending || [])) {
    // 오늘 것은 개장 직후엔 시가가 아직 안 잡힐 수 있으니 09:10 이후에만 시도
    if (row.session_date === date && (hour < 9 || (hour === 9 && kstParts().min < 10))) continue;
    const open = await estFetchOpen(row.ticker, row.session_date);
    if (open == null || !row.base_close) continue;
    const actualPct = ((open - row.base_close) / row.base_close) * 100;
    const { error } = await supabase.from('est_accuracy').update({
      actual_open: open, actual_change_pct: actualPct,
      error_pct: actualPct - (row.est_change_pct ?? 0), settled_at: new Date().toISOString(),
    }).eq('id', row.id);
    if (!error) log.settled++;
  }
  return log;
}

// handleKrProxy 본문을 재사용하기 위한 순수 함수 버전
async function fetchKrProxyPayload() {
  const syms = Object.keys(KR_PROXY_SYMBOLS);
  const [quoteList, binance, kisNightFuture] = await Promise.all([
    mapWithConcurrency(syms, 6, async (s) => [s, await fetchYahooChange(s)]),
    fetchBinancePerps(),
    fetchKisNightFuture(),   // 실패해도 null만 오고 나머지는 그대로 진행(fail-open)
  ]);
  const overseas = {};
  for (const [sym, q] of quoteList) if (q) overseas[sym] = { ...KR_PROXY_SYMBOLS[sym], ...q };
  return { overseas, binance, kisNightFuture };
}

async function handleKrEstimate(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const action = (req.query.action || '').toString();

  // ── 누적 정확도 (공개) ──
  if (action === 'accuracy') {
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
    const { data, error } = await supabase.from('est_accuracy')
      .select('ticker, session_date, est_change_pct, actual_change_pct, error_pct')
      .not('settled_at', 'is', null).order('session_date', { ascending: false }).limit(400);
    if (error) return res.status(200).json({ ok: true, available: false, reason: error.message, byTicker: {}, overall: null });
    const byTicker = {};
    for (const r of (data || [])) {
      const e = Math.abs(Number(r.error_pct));
      if (!isFinite(e)) continue;
      (byTicker[r.ticker] ||= { n: 0, sumAbs: 0, sumSigned: 0, last: null });
      const b = byTicker[r.ticker];
      b.n++; b.sumAbs += e; b.sumSigned += Number(r.error_pct);
      if (!b.last) b.last = { date: r.session_date, est: r.est_change_pct, actual: r.actual_change_pct, err: r.error_pct };
    }
    let n = 0, sumAbs = 0;
    for (const k of Object.keys(byTicker)) {
      const b = byTicker[k];
      b.mae = b.sumAbs / b.n; b.bias = b.sumSigned / b.n;
      n += b.n; sumAbs += b.sumAbs;
      delete b.sumAbs; delete b.sumSigned;
    }
    return res.status(200).json({ ok: true, available: n > 0, samples: n, overall: n ? { mae: sumAbs / n } : null, byTicker });
  }

  // ── 스냅샷/정산 (인증) ──
  if (action === 'record') {
    const a = await verifyAdmin(req.headers.authorization);
    if (!a.ok) return res.status(401).json({ ok: false, error: a.error || 'unauthorized' });
    res.setHeader('Cache-Control', 'no-store');
    try { return res.status(200).json({ ok: true, ...(await estRecordAndSettle()) }); }
    catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }

  // ── 기본: 지금 무엇을 보여줄지(국장 시세 vs 해외 추정) 결정 후 데이터 반환 ──
  //
  // ⚠️ 22:30(미국 개장) 전에는 EWY/ADR이 "전날 미국 세션" 값이라 17시간쯤 묵은 신호다.
  // 그걸로 추정하면 오히려 해로우므로, 국장 시세를 22:30까지 그대로 올려둔다.
  //   09:00~15:30  regular  정규장 실시간
  //   15:30~20:00  nxt      넥스트장(대체거래소) — 토스 통합가가 시간외를 반영
  //   20:00~22:30  closed   거래 없음, 마지막 시세 유지
  //   22:30~09:00  (추정)   미국장이 열려 해외 신호가 살아있는 구간
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=90');
  const kp = kstParts();
  const tmin = kp.hour * 60 + kp.min;
  const weekday = kp.dow >= 1 && kp.dow <= 5;
  const live = weekday && tmin >= 540 && tmin < 1350;      // 09:00~22:30
  const session = !live ? null : tmin < 930 ? 'regular' : tmin < 1200 ? 'nxt' : 'closed';
  const tickers = EST_MODEL.targets.map(t => t.t);

  if (live) {
    // 국장 시세: 토스 통합가(넥스트장 포함) 우선, 기준 종가는 야후에서.
    const codes = tickers.map(t => t.replace(/\.(KS|KQ)$/i, ''));
    const [toss, Q] = await Promise.all([
      tossProxyConfigured()
        ? callTossProxy(`/prices?symbols=${encodeURIComponent(codes.join(','))}`).catch(() => null)
        : Promise.resolve(null),
      estFetchQuotes(tickers),
    ]);
    const tossBy = {};
    for (const r of (toss?.result || [])) {
      if (r?.symbol != null && r.lastPrice != null) tossBy[String(r.symbol)] = Number(r.lastPrice);
    }
    const items = EST_MODEL.targets.map(tg => {
      const code = tg.t.replace(/\.(KS|KQ)$/i, '');
      const y = Q[tg.t] || {};
      const price = tossBy[code] ?? (typeof y.price === 'number' ? y.price : null);
      const prev = (typeof y.prevClose === 'number') ? y.prevClose : null;
      const chg = (price != null && prev) ? ((price - prev) / prev) * 100 : null;
      return { ...tg, price, prevClose: prev, changePct: chg, priceFrom: tossBy[code] != null ? 'toss' : 'yahoo' };
    });
    return res.status(200).json({ ok: true, ts: Date.now(), modelVersion: EST_MODEL.version, live: true, session, items });
  }

  const [P, Q] = await Promise.all([fetchKrProxyPayload(), estFetchQuotes(tickers)]);

  // 바이낸스는 Vercel에서 HTTP 451(지역 차단)이라 서버가 못 읽는다. 브라우저에서는
  // 되는 경우가 있어, 클라이언트가 읽은 값을 ?bn=티커:등락%,… 로 넘겨주면 모델에 합류시킨다.
  // (표시용 계산에만 쓰이고 DB에 남는 정확도 스냅샷은 서버 단독 계산이라 오염되지 않는다)
  const bnParam = (req.query.bn || '').toString().slice(0, 200);
  if (bnParam && !P.binance?.available) {
    const items = {};
    for (const pair of bnParam.split(',')) {
      const [tk, v] = pair.split(':');
      const n = Number(v);
      if (tk && isFinite(n) && Math.abs(n) < 100) items[tk.trim()] = { symbol: 'client', changePercent: n };
    }
    if (Object.keys(items).length) P.binance = { available: true, items, via: 'client' };
  }

  const items = computeEstimates(P, Q);
  return res.status(200).json({
    ok: true, ts: Date.now(), modelVersion: EST_MODEL.version, live: false, session: null,
    krwUsd: P.overseas?.['KRW=X']?.price ?? null,
    items, kisNightFuture: P.kisNightFuture, sources: { overseas: P.overseas, binance: P.binance },
  });
}

async function handleKrProxy(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // 해외 신호는 실시간성이 중요하지만 국장 재개장 전까지 쓰는 값이라 30초면 충분하다
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=90');

  const syms = Object.keys(KR_PROXY_SYMBOLS);
  const [quoteList, binance] = await Promise.all([
    mapWithConcurrency(syms, 6, async (s) => [s, await fetchYahooChange(s)]),
    fetchBinancePerps(),
  ]);

  const overseas = {};
  for (const [sym, q] of quoteList) {
    if (!q) continue;
    overseas[sym] = { ...KR_PROXY_SYMBOLS[sym], ...q };
  }

  return res.status(200).json({
    ok: true,
    ts: Date.now(),
    overseas,                                   // EWY/^SOX/환율/ADR 등 야후 기반 신호
    binance,                                    // { available, reason, items{krTicker:{...}} }
    coverage: {
      overseas: Object.keys(overseas).length,
      expected: syms.length,
      binance: binance.available ? Object.keys(binance.items).length : 0,
    },
  });
}

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
  // 응답 자체는 no-store였지만 내부적으로 30분짜리 DB 캐시(econ_calendar_cache)를 그대로
  // 읽어서 돌려주는 경우가 대부분 — 그런데도 매 요청마다 Supabase를 직접 때려서, 트래픽이
  // 몰리면(2026-07-19 커뮤니티 유입 때 실제로 이 테이블 포함 여러 곳이 함께 무너짐) 방문자
  // 수만큼 그대로 DB 부하가 됨. 짧게라도 엣지캐시 걸어서 흡수.
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');

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

// ─── 실적 캘린더 (2026-07) ──────────────────────────────────────────
// handleEarnings(위)는 20개 고정 티커만 FMP로 개별 조회 — 사이드바 "일정 → 실적" 탭
// (app.js loadEarningsCalendar)이 이걸 쓰고 있는데, 실적 시즌에 훨씬 많은 대형주가
// 발표해도 이 20개짜리 워치리스트 밖이면 전혀 안 보여서 "이렇게 많은데 사이트엔
// 하나도 안 보인다"는 피드백을 받았다(2026-07-27). Nasdaq의 공개 날짜별 캘린더
// API(무키, 인증 불필요 — fetchNasdaqEarningsDate와 같은 호스트)를 쓰면 "그날 발표하는
// 전체 종목"을 한 번에 받을 수 있고 marketCap 필드까지 같이 온다 — 대형주만 거르는 데
// 별도 조회가 필요 없다. loadEarningsCalendar/renderCalModal 둘 다 이 엔드포인트로 교체.
const EARNINGS_CAL_MIN_CAP = 10e9;   // $10B 이상만 "대형주"로 노출 (소형주 스팸 방지)
const EARNINGS_CAL_MAX_PER_DAY = 10;
const KR_DOW = ['일', '월', '화', '수', '목', '금', '토'];

function parseNasdaqMarketCap(s) {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/[$,]/g, ''));
  return isFinite(n) ? n : null;
}

// "$3.23" → 3.23, "($0.34)" → -0.34 (Nasdaq은 음수를 괄호로 표기)
function parseNasdaqEps(s) {
  if (!s || s === 'N/A') return null;
  const neg = /^\(.*\)$/.test(String(s).trim());
  const n = parseFloat(String(s).replace(/[()$,]/g, ''));
  return isFinite(n) ? (neg ? -n : n) : null;
}

async function fetchNasdaqCalendarForDate(dateStr) {
  try {
    const r = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${dateStr}`, {
      headers: EARNINGS_HEADERS, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return j?.data?.rows || [];
  } catch { return []; }
}

// scope='upcoming'(기본, 오늘부터 앞으로) | 'reported'(어제부터 뒤로 — 실제 발표된 실적)
// 기본값은 기존 사이드바(app.js loadEarningsCalendar)가 파라미터 없이 부르므로 절대 바꾸지 말 것.
// reported 모드에선 Nasdaq 과거 캘린더가 eps(실제)·surprise(%)까지 같이 준다 — 발표 완료
// 목록을 별도 조회 없이 이 한 번으로 구성할 수 있다(실측 확인, 2026-07-28).
async function handleEarningsCalendar(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const scope = (req?.query?.scope || 'upcoming').toString();
  // gaps: 어드민 전용 — "실적 발표는 지났는데(Nasdaq eps 필드가 아직 비어있음) 관리자가
  // 아직 수동 입력도 안 한" 종목만 뽑아서 어드민 패널의 "실제 EPS만 입력" 목록에 쓴다.
  if (scope === 'gaps') return handleEarningsGaps(req, res);

  // 실적 일정은 하루 안에 잘 안 바뀌므로(간혹 당일 정정 있음) 넉넉히 캐시 — handleEarnings와 동일 정책.
  res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
  const reported = scope === 'reported';
  const wantDays = Math.min(Math.max(parseInt(req?.query?.days) || 10, 1), 15);

  // 평일만 수집 — 주말은 Nasdaq이 rows:null을 주므로 요청 자체를 건너뛴다.
  // ⚠️ reported 모드도 오늘(i=0)부터 포함해야 한다 — 원래 i=1(어제)부터였는데, 오늘 장전
  // (BMO) 발표는 대부분 사용자가 페이지를 보는 시점(오전~낮)엔 이미 다 끝나 있어서 "오늘
  // 장전 발표된 실적이 하나도 안 보인다"는 피드백(2026-07-28)을 받았다. 아직 발표 전인
  // 오늘 항목(예: 오늘 장마감후 예정)은 아래 epsActual != null 필터가 알아서 걸러내므로
  // 오늘을 포함해도 "아직 안 나온 실적"이 새는 일은 없다.
  const days = [];
  for (let i = 0; days.length < wantDays; i++) {
    const d = new Date(Date.now() + (reported ? -i : i) * 86400000);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    days.push(d.toISOString().slice(0, 10));
  }

  const results = await Promise.all(days.map(fetchNasdaqCalendarForDate));

  const out = days.map((date, idx) => {
    const items = (results[idx] || [])
      .map(r => {
        const epsActual = reported ? parseNasdaqEps(r.eps) : null;
        const epsForecast = parseNasdaqEps(r.epsForecast);
        const surprisePct = reported && r.surprise != null && r.surprise !== ''
          ? (isFinite(parseFloat(r.surprise)) ? parseFloat(r.surprise) : null) : null;
        return {
          symbol: r.symbol,
          name: (r.name || '').trim(),
          time: r.time === 'time-after-hours' ? 'AMC' : r.time === 'time-pre-market' ? 'BMO' : null,
          marketCap: parseNasdaqMarketCap(r.marketCap),
          epsForecast,
          ...(reported ? { epsActual, surprisePct } : {}),
        };
      })
      // reported 모드는 "실제로 실적이 나온 것"만 — 예정일만 잡혀 있고 아직 값이 없는 행은 뺀다.
      .filter(it => it.symbol && it.marketCap != null && it.marketCap >= EARNINGS_CAL_MIN_CAP
        && (!reported || it.epsActual != null))
      .sort((a, b) => b.marketCap - a.marketCap)
      .slice(0, EARNINGS_CAL_MAX_PER_DAY);
    return { date, weekday: KR_DOW[new Date(date + 'T12:00:00Z').getUTCDay()], items };
  }).filter(day => day.items.length > 0);

  // 관리자가 직접 입력한 실제 발표 수치(earnings_manual) 병합 — Nasdaq 캘린더가 방금 나온
  // 실적의 eps를 며칠씩 늦게 채워서(실측, 2026-07-29) 그 사이 "발표 예정"에서도 빠지고
  // "발표 완료"에도 안 뜨는 사각지대를 관리자가 직접 메울 수 있게 한다. 같은 symbol+날짜면
  // 관리자 입력이 Nasdaq 데이터를 덮어쓰고(우선순위), 원래 그 날짜 버킷이 없으면(예: 이미
  // wantDays 창을 벗어난 오래전 발표) 새로 만든다 — 시총/개수 제한 없이 관리자 판단 그대로 노출.
  if (reported) {
    try {
      const { data: manualRows } = await supabase.from('earnings_manual')
        .select('*').order('report_date', { ascending: false }).limit(100);
      if (manualRows?.length) {
        const byDate = new Map(out.map(d => [d.date, d]));
        for (const m of manualRows) {
          const date = (m.report_date || '').toString().slice(0, 10);
          if (!date) continue;
          let day = byDate.get(date);
          if (!day) {
            day = { date, weekday: KR_DOW[new Date(date + 'T12:00:00Z').getUTCDay()], items: [] };
            byDate.set(date, day);
            out.push(day);
          }
          const epsActual = m.eps_actual != null ? Number(m.eps_actual) : null;
          const epsForecast = m.eps_estimate != null ? Number(m.eps_estimate) : null;
          const surprisePct = m.surprise_pct != null ? Number(m.surprise_pct)
            : (epsActual != null && epsForecast) ? Math.round(((epsActual - epsForecast) / Math.abs(epsForecast)) * 1000) / 10 : null;
          const item = {
            symbol: (m.symbol || '').toUpperCase(),
            name: m.name || m.symbol,
            time: m.time || null,
            marketCap: m.market_cap != null ? Number(m.market_cap) : null,
            epsForecast, epsActual, surprisePct,
            manual: true,
          };
          const idx = day.items.findIndex(it => it.symbol === item.symbol);
          if (idx >= 0) day.items[idx] = item; else day.items.push(item);
        }
        out.sort((a, b) => b.date.localeCompare(a.date));
      }
    } catch {}
  }

  return res.status(200).json({ ok: true, scope, days: out, minCapUsd: EARNINGS_CAL_MIN_CAP, ts: Date.now() });
}

// GET ?source=earnings-calendar&scope=gaps (어드민 전용) — 최근 wantDays 평일 중 Nasdaq
// 캘린더의 eps 필드가 아직 비어있고(=아직 실제 EPS 미반영) earnings_manual에도 없는(=관리자가
// 아직 안 채운) 대형주만 뽑는다. 어드민 패널이 이 목록을 보여주고 관리자는 "실제 EPS"
// 칸만 채우면 되도록(2026-07-29 피드백 — 티커/날짜/예상치를 매번 새로 타이핑할 필요 없게).
async function handleEarningsGaps(req, res) {
  const _a = await verifyAdmin(req.headers.authorization);
  if (!_a.ok) return res.status(401).json({ error: _a.error });
  res.setHeader('Cache-Control', 'no-store');

  const wantDays = Math.min(Math.max(parseInt(req?.query?.days) || 10, 1), 15);
  const days = [];
  for (let i = 0; days.length < wantDays; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    days.push(d.toISOString().slice(0, 10));
  }
  const results = await Promise.all(days.map(fetchNasdaqCalendarForDate));

  const { data: manualRows } = await supabase.from('earnings_manual').select('symbol, report_date');
  const manualSet = new Set((manualRows || []).map(m => `${(m.symbol || '').toUpperCase()}|${(m.report_date || '').toString().slice(0, 10)}`));

  const items = [];
  days.forEach((date, idx) => {
    (results[idx] || []).forEach(r => {
      if (!r.symbol) return;
      const marketCap = parseNasdaqMarketCap(r.marketCap);
      if (marketCap == null || marketCap < EARNINGS_CAL_MIN_CAP) return;
      if (parseNasdaqEps(r.eps) != null) return; // Nasdaq이 이미 채웠으면 gap 아님
      if (manualSet.has(`${r.symbol.toUpperCase()}|${date}`)) return; // 관리자가 이미 처리함
      items.push({
        symbol: r.symbol,
        name: (r.name || '').trim(),
        date,
        time: r.time === 'time-after-hours' ? 'AMC' : r.time === 'time-pre-market' ? 'BMO' : null,
        marketCap,
        epsForecast: parseNasdaqEps(r.epsForecast),
      });
    });
  });
  items.sort((a, b) => b.date.localeCompare(a.date) || b.marketCap - a.marketCap);

  return res.status(200).json({ ok: true, items, ts: Date.now() });
}

// ─── 실적 상세 (2026-07-28) — earnings.html 종목 클릭 시 ────────────────
// Nasdaq earnings-surprise: 최근 4개 분기의 실제 EPS·컨센서스·서프라이즈% 이력.
// + Yahoo 일봉 3개월: 발표 전후 주가 흐름을 같이 보여주기 위함(발표일 마커는 클라이언트가 찍음).
async function handleEarningsDetail(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=21600');
  const symbol = (req?.query?.symbol || '').toString().trim().toUpperCase();
  if (!symbol || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) {
    return res.status(400).json({ ok: false, error: 'valid symbol required' });
  }

  const [surpriseRes, chartRes] = await Promise.allSettled([
    fetch(`https://api.nasdaq.com/api/company/${encodeURIComponent(symbol)}/earnings-surprise`,
      { headers: EARNINGS_HEADERS, signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : null),
    fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`,
      { headers: EARNINGS_HEADERS, signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : null),
  ]);

  // 분기 이력 — Nasdaq은 최신순으로 준다. dateReported는 "4/30/2026" 형식이라 ISO로 정규화.
  let quarters = [];
  const rows = surpriseRes.status === 'fulfilled'
    ? (surpriseRes.value?.data?.earningsSurpriseTable?.rows || []) : [];
  quarters = rows.map(r => {
    const m = String(r.dateReported || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const iso = m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
    const eps = r.eps != null && r.eps !== '' ? Number(r.eps) : null;
    const est = r.consensusForecast != null && r.consensusForecast !== '' ? Number(r.consensusForecast) : null;
    const sp = r.percentageSurprise != null && r.percentageSurprise !== '' ? Number(r.percentageSurprise) : null;
    return {
      fiscalQuarter: r.fiscalQtrEnd || null,
      reportedDate: iso,
      epsActual: isFinite(eps) ? eps : null,
      epsEstimate: isFinite(est) ? est : null,
      surprisePct: isFinite(sp) ? sp : null,
    };
  }).filter(q => q.epsActual != null || q.epsEstimate != null);

  // 주가 3개월 일봉
  let points = [], currency = 'USD', name = symbol, currentPrice = null;
  const cr = chartRes.status === 'fulfilled' ? chartRes.value?.chart?.result?.[0] : null;
  if (cr) {
    const ts = cr.timestamp || [];
    const closes = cr.indicators?.quote?.[0]?.close || [];
    points = ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
      .filter(p => p.close != null);
    currency = cr.meta?.currency || 'USD';
    name = cr.meta?.longName || cr.meta?.shortName || symbol;
    currentPrice = cr.meta?.regularMarketPrice ?? cr.meta?.previousClose ?? null;
  }

  return res.status(200).json({ ok: true, symbol, name, currency, currentPrice, quarters, points, ts: Date.now() });
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

// ════════════════════════════════════════════════════════════════════════
// etf — GET ?source=etf&action=list|detail|holders  (전부 네이버, 키 불필요)
//  list    : 전체 ETF 목록(카테고리·등락률·수익률·거래대금) — etf.html 목록
//  detail  : 개별 ETF 상세(보수·추적오차·기간수익률·자산/국가/섹터 배분·상위10 구성종목·순유입) — etf.html 상세
//  holders : 특정 종목을 담은 ETF 역조회 — company.html "이 종목이 포함된 ETF"(저장된 etf_holdings 인덱스)
// ════════════════════════════════════════════════════════════════════════
export const ETF_CATEGORIES = {
  1: '국내 시장지수', 2: '국내 업종·테마', 3: '국내 파생',
  4: '해외 주식', 5: '원자재', 6: '채권·금리', 7: '기타',
};
const ETF_LABELS = {
  // 자산배분 detailTypeCode
  EQUITY: '주식', STOCK: '주식', BOND: '채권', CASH: '현금성', COMMODITY: '원자재',
  REIT: '리츠', ETF: 'ETF', FUND: '펀드', DERIVATIVE: '파생', ETC: '기타', OTHER: '기타',
  // 국가 detailTypeCode(ISO2)
  US: '미국', KR: '한국', CN: '중국', JP: '일본', HK: '홍콩', TW: '대만', IN: '인도',
  DE: '독일', GB: '영국', FR: '프랑스', VN: '베트남', EU: '유럽',
  // 섹터 detailTypeCode
  IT: 'IT', FINANCE: '금융', HEALTHCARE: '헬스케어', HEALTH_CARE: '헬스케어',
  ENERGY: '에너지', MATERIALS: '소재', MATERIAL: '소재', INDUSTRIALS: '산업재', INDUSTRIAL: '산업재',
  CONSUMER: '소비재', CONSUMER_STAPLES: '필수소비재', CONSUMER_DISCRETIONARY: '경기소비재',
  COMMUNICATION: '커뮤니케이션', UTILITIES: '유틸리티', UTILITY: '유틸리티', REAL_ESTATE: '부동산',
};
const etfLabel = code => ETF_LABELS[code] || ETF_LABELS[String(code || '').toUpperCase()] || code || '기타';

const NAVER_ETF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  'Referer': 'https://m.stock.naver.com/',
  'Accept': 'application/json, */*',
};

// 네이버 ETF 전체 목록 — 응답이 EUC-KR 인코딩이라 arrayBuffer로 받아 직접 디코드한다
// (UTF-8로 그냥 읽으면 종목명이 깨짐 — 실측 확인됨).
async function fetchNaverEtfList() {
  const r = await fetch('https://finance.naver.com/api/sise/etfItemList.nhn', {
    headers: NAVER_ETF_HEADERS, signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`naver etf list HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  let text;
  try { text = new TextDecoder('euc-kr').decode(buf); }
  catch { text = new TextDecoder('utf-8').decode(buf); }
  const j = JSON.parse(text);
  return j?.result?.etfItemList || [];
}

async function handleEtfList(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
  try {
    const list = await fetchNaverEtfList();
    // 운용사(issuer_name)·순자산총액(market_value_won)은 목록 API엔 없다 — crawl-etf-holdings가
    // 종목별 etfAnalysis 호출 김에 이미 채워둔 etf_snapshot에서 가져와 합친다(추가 호출 없음).
    // 아직 마이그레이션 전(db/etf-snapshot-issuer.sql 미실행)이면 issuer_name 컬럼이 없어
    // select 자체가 에러 나므로, 그 경우 그 컬럼만 빼고 재시도(이 레포의 표준 폴백 패턴).
    let snapMap = {};
    try {
      let { data, error } = await supabase.from('etf_snapshot').select('code, issuer_name, market_value_won');
      if (error && /issuer_name/i.test(error.message || '')) {
        ({ data } = await supabase.from('etf_snapshot').select('code, market_value_won'));
      }
      for (const s of data || []) snapMap[s.code] = s;
    } catch { /* 스냅샷 없어도 목록 자체는 항상 뜨게 */ }

    const items = list.map(e => {
      const snap = snapMap[e.itemcode];
      return {
        code: e.itemcode,
        name: e.itemname,
        tabCode: e.etfTabCode,
        category: ETF_CATEGORIES[e.etfTabCode] || '기타',
        price: e.nowVal ?? null,
        changeRate: e.changeRate ?? null,
        nav: e.nav ?? null,
        ret3m: e.threeMonthEarnRate ?? null,   // 최근 3개월 수익률(%)
        volume: e.quant ?? null,               // 거래량(주)
        amount: e.amonut != null ? e.amonut * 1e6 : null,  // 거래대금(원) — 원본은 백만원 단위(실측)
        issuer: snap?.issuer_name || null,          // 운용사, 예: "삼성자산운용(ETF)"
        aum: snap?.market_value_won ?? null,        // 순자산총액(원)
      };
    });
    return res.status(200).json({ ok: true, count: items.length, items, ts: Date.now() });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
}

async function handleEtfDetail(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
  const code = (req.query.code || '').toString().replace(/[^0-9A-Za-z]/g, '');
  if (!code) return res.status(400).json({ ok: false, error: 'code required' });
  try {
    const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/etfAnalysis`, {
      headers: NAVER_ETF_HEADERS, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.status(502).json({ ok: false, error: `naver HTTP ${r.status}` });
    const j = await r.json();
    if (!j || !j.itemCode) return res.status(404).json({ ok: false, error: 'not an ETF or no data' });

    const num = v => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : null; };
    const mapReturns = arr => (arr || []).map(x => ({ period: x.periodTypeCode, value: x.value }));
    const mapBreakdown = arr => (arr || []).map(x => ({ code: x.detailTypeCode, label: etfLabel(x.detailTypeCode), weight: x.weight }));

    return res.status(200).json({
      ok: true,
      code: j.itemCode,
      name: j.itemName,
      summary: j.etfSummary || null,
      issuer: j.issuerName || null,
      baseIndex: j.etfBaseIndex || null,
      listedDate: j.listedDate || null,
      totalFee: num(j.totalFee),               // 총보수(%) — 이미 % 단위 숫자(예: 0.15 = 0.15%)
      trackingError: num(j.chaseErrorRate),    // 추적오차(%)
      deviationRate: num(j.deviationRate),     // 괴리율(%)
      marketValue: j.marketValue || null,      // 순자산총액 — 네이버가 "11조 5,043억"처럼 이미 포맷된 문자열로 줌
      nav: num(j.nav),
      totalNav: j.totalNav || null,            // 순자산총액(총) — 역시 포맷 문자열
      taxationType: j.taxationTypeCode || null,
      dividend: j.dividend || null,
      returns: mapReturns(j.returnPerformanceList),        // 시장가 기간수익률
      navReturns: mapReturns(j.navPerformanceList),        // NAV 기간수익률
      assetBreakdown: mapBreakdown(j.assetPortfolioList),
      countryBreakdown: mapBreakdown(j.countryPortfolioList),
      sectorBreakdown: mapBreakdown(j.sectorPortfolioList),
      // cumulativeNetInflowList는 배열이 아니라 기간별 문자열 객체("136억" 등, 이미 포맷됨)
      netInflows: (() => {
        const o = j.cumulativeNetInflowList;
        if (!o || typeof o !== 'object') return null;
        const pick = [['1d','1일'],['1w','1주'],['1m','1개월'],['3m','3개월'],['6m','6개월'],['Ytd','연초이후'],['1y','1년']];
        const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
        return { referenceDate: o.referenceDate || null, items: pick
          .map(([k, label]) => ({ label, value: o['cumulativeNetInflow' + cap(k)] ?? null }))
          .filter(x => x.value != null) };
      })(),
      holdings: (j.etfTop10MajorConstituentAssets || []).map(h => ({
        seq: h.seq,
        code: h.itemCode || null,
        name: h.itemName,
        shares: h.stockCount || null,
        weight: num(h.etfWeight),
      })),
      ts: Date.now(),
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
}

// 역조회: 특정 종목을 상위10 구성으로 담은 ETF 목록(저장된 인덱스에서 조회).
async function handleEtfHolders(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800');
  const rawTicker = (req.query.ticker || '').toString().trim().toUpperCase();
  const rawQ = (req.query.q || '').toString().trim();
  const raw = rawTicker || rawQ.toUpperCase();
  const m = raw.match(/(\d{6})/);   // 005930.KS / 005930.KQ / 005930 모두 허용 — 6자리 코드만 추출

  // 6자리 티커가 없고 q(자유텍스트, 종목명)만 있으면 → 후보 종목 제안(자동완성)
  if (!m && rawQ) {
    try {
      const { data, error } = await supabase
        .from('etf_holdings')
        .select('stock_code, stock_name')
        .ilike('stock_name', `%${rawQ}%`)
        .limit(200);
      if (error) return res.status(200).json({ ok: true, mode: 'suggest', matches: [], note: error.message });
      const seen = new Map();
      for (const r of data || []) if (!seen.has(r.stock_code)) seen.set(r.stock_code, r.stock_name);
      const matches = [...seen.entries()].map(([code, name]) => ({ code, name })).slice(0, 12);
      return res.status(200).json({ ok: true, mode: 'suggest', matches });
    } catch (err) {
      return res.status(200).json({ ok: true, mode: 'suggest', matches: [], note: err.message });
    }
  }
  if (!m) return res.status(200).json({ ok: true, mode: 'holders', ticker: raw, etfs: [] });
  const stockCode = m[1];

  try {
    const { data, error } = await supabase
      .from('etf_holdings')
      .select('etf_code, etf_name, etf_tab_code, stock_name, weight, seq, updated_at')
      .eq('stock_code', stockCode)
      // nullsFirst:false 필수 — Postgres DESC 정렬 기본값이 NULL을 맨 앞에 두므로, 지정 안 하면
      // 비중 미표기(네이버가 "-"로 준) ETF가 KODEX 200(32.73%) 같은 실제 고비중 ETF보다 앞에 나옴(실측 확인된 버그).
      .order('weight', { ascending: false, nullsFirst: false })
      .limit(40);
    if (error) return res.status(200).json({ ok: true, mode: 'holders', ticker: stockCode, etfs: [], note: error.message });

    // 편입비중만으로는 부족 — 각 ETF의 실시간 등락률·3개월수익률·거래대금을 붙여 "정리된" 결과로.
    let liveByCode = {};
    try { (await fetchNaverEtfList()).forEach(e => { liveByCode[e.itemcode] = e; }); } catch {}

    const etfs = (data || []).map(r => {
      const live = liveByCode[r.etf_code];
      return {
        code: r.etf_code, name: r.etf_name,
        category: ETF_CATEGORIES[r.etf_tab_code] || '기타',
        weight: r.weight, seq: r.seq,
        price: live?.nowVal ?? null,
        changeRate: live?.changeRate ?? null,
        ret3m: live?.threeMonthEarnRate ?? null,
        amount: live?.amonut != null ? live.amonut * 1e6 : null,
      };
    });
    const updatedAt = data?.[0]?.updated_at || null;
    const stockName = data?.[0]?.stock_name || null;
    return res.status(200).json({ ok: true, mode: 'holders', ticker: stockCode, stockName, count: etfs.length, etfs, updatedAt });
  } catch (err) {
    return res.status(200).json({ ok: true, mode: 'holders', ticker: stockCode, etfs: [], note: err.message });
  }
}

// 자금유입 상위 / 최저보수 / 순자산 최대 랭킹 — etf_snapshot(크롤 적재분)에서 조회.
// 목록 API엔 없는 필드라(총보수·순자산·자금유입) 저장된 스냅샷을 쓴다.
async function handleEtfRankings(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=7200');
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 5, 1), 20);
  try {
    const [inflow1d, lowFee, bigAum] = await Promise.all([
      supabase.from('etf_snapshot').select('code,name,tab_code,net_inflow_1d_won').not('net_inflow_1d_won', 'is', null).order('net_inflow_1d_won', { ascending: false }).limit(limit),
      supabase.from('etf_snapshot').select('code,name,tab_code,total_fee').not('total_fee', 'is', null).gt('total_fee', 0).order('total_fee', { ascending: true }).limit(limit),
      supabase.from('etf_snapshot').select('code,name,tab_code,market_value_won').not('market_value_won', 'is', null).order('market_value_won', { ascending: false }).limit(limit),
    ]);
    const shape = (r, field) => (r.data || []).map(x => ({ code: x.code, name: x.name, category: ETF_CATEGORIES[x.tab_code] || '기타', value: x[field] }));
    return res.status(200).json({
      ok: true,
      netInflow1d: shape(inflow1d, 'net_inflow_1d_won'),
      lowestFee: shape(lowFee, 'total_fee'),
      largestAum: shape(bigAum, 'market_value_won'),
    });
  } catch (err) {
    return res.status(200).json({ ok: true, netInflow1d: [], lowestFee: [], largestAum: [], note: err.message });
  }
}
