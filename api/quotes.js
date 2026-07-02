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
  const tickers = param.split(',').map(t => t.trim()).filter(Boolean).slice(0, 200);

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
        ...(series ? { series } : {}),
      }];
    } catch {
      return [ticker, null];
    }
  };

  const results = await Promise.all(tickers.map(fetchOne));
  const data = Object.fromEntries(results);

  return new Response(JSON.stringify({ ok: true, data, ts: Date.now() }), { headers: cors });
}
