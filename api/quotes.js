/**
 * quotes.js — Vercel Edge Function
 * GET /api/quotes?tickers=AAPL,MSFT,NVDA,005930.KS
 *   → { ok: true, data: { AAPL: {price, changePercent, preMarketPrice, postMarketPrice, ...}, ... } }
 * GET /api/quotes?tickers=...&range=1mo  → 월간 변화율 (히트맵용)
 *
 * 여러 티커를 한 번에 병렬 조회. 60초 캐시 + stale-while-revalidate.
 */
export const config = { runtime: 'edge' };

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, */*',
};

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

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, s-maxage=3, stale-while-revalidate=10',
  };

  const { searchParams } = new URL(req.url);
  const param = searchParams.get('tickers') || '';
  const range = (searchParams.get('range') || '1d').toString();
  const interval = range === '1mo' ? '1d' : range === '5d' ? '1d' : '1d';
  const includeSeries = searchParams.get('include') === 'series';   // 상관관계 계산용 시계열 반환
  // 히트맵 US/KR 목록이 S&P500 전체(525)·코스피+코스닥 top100(236) 규모로 확장되어 상향
  // (기존 200 → 600). 아래 mapWithConcurrency로 동시 요청 수를 제한해 Yahoo 레이트리밋 방지.
  const tickers = param.split(',').map(t => t.trim()).filter(Boolean).slice(0, 600);

  if (!tickers.length) {
    return new Response(JSON.stringify({ ok: false, error: 'tickers required', data: {} }), {
      status: 400, headers: cors,
    });
  }

  const fetchOne = async (ticker) => {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`,
        { headers: HEADERS, signal: AbortSignal.timeout(5000) }
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

  return new Response(JSON.stringify({ ok: true, data, ts: Date.now() }), { headers: cors });
}
