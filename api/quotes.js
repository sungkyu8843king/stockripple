/**
 * quotes.js — Vercel Edge Function
 * GET /api/quotes?tickers=AAPL,MSFT,NVDA,005930.KS
 * → { ok: true, data: { AAPL: {price, changePercent, ...}, ... } }
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
    'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=180',
  };

  const { searchParams } = new URL(req.url);
  const param = searchParams.get('tickers') || '';
  const tickers = param.split(',').map(t => t.trim()).filter(Boolean).slice(0, 20);

  if (!tickers.length) {
    return new Response(JSON.stringify({ ok: false, error: 'tickers required', data: {} }), {
      status: 400, headers: cors,
    });
  }

  const fetchOne = async (ticker) => {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
        { headers: HEADERS, signal: AbortSignal.timeout(4500) }
      );
      if (!r.ok) return [ticker, null];
      const j = await r.json();
      const meta = j.chart?.result?.[0]?.meta;
      if (!meta) return [ticker, null];

      const price = meta.regularMarketPrice ?? meta.previousClose ?? null;
      const prev  = meta.chartPreviousClose ?? meta.previousClose ?? null;
      let changePercent = meta.regularMarketChangePercent;
      let change        = meta.regularMarketChange;
      if (changePercent == null && price != null && prev) {
        change = price - prev;
        changePercent = (change / prev) * 100;
      }

      return [ticker, {
        price,
        previousClose: prev,
        change:        change != null ? Math.round(change * 100) / 100 : null,
        changePercent: changePercent != null ? Math.round(changePercent * 100) / 100 : null,
        currency:      meta.currency || 'USD',
        marketState:   meta.marketState || null,
      }];
    } catch {
      return [ticker, null];
    }
  };

  const results = await Promise.all(tickers.map(fetchOne));
  const data = Object.fromEntries(results);

  return new Response(JSON.stringify({ ok: true, data, ts: Date.now() }), { headers: cors });
}
