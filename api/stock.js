/**
 * stock.js — stock-price + stock-chart 통합
 *  GET /api/stock?type=price&ticker=X       → 현재가, 시총 (캐시 1시간)
 *  GET /api/stock?type=chart&ticker=X&range=3mo → 차트 데이터 (raw points)
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const type = (req.query?.type || 'price').toString();
  if (type === 'chart') return handleChart(req, res);
  return handlePrice(req, res);
}

// ─── 현재가 + 시총 (DB 캐시 1시간) ────────────────────────
async function handlePrice(req, res) {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  const { data: cached } = await supabase
    .from('companies')
    .select('current_price, market_cap, price_updated_at, currency')
    .eq('ticker', ticker)
    .single();

  if (cached?.price_updated_at) {
    const age = Date.now() - new Date(cached.price_updated_at).getTime();
    if (age < 3600000) {
      return res.status(200).json({
        ticker,
        price: cached.current_price,
        marketCap: cached.market_cap,
        currency: cached.currency,
        source: 'cache',
      });
    }
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockRipple/1.0)' },
    });
    if (!response.ok) throw new Error(`Yahoo Finance HTTP ${response.status}`);
    const data = await response.json();
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta) throw new Error('No data from Yahoo Finance');

    const price = meta.regularMarketPrice || meta.previousClose;
    const marketCap = meta.marketCap || null;
    const currency = meta.currency || 'USD';
    const changePercent = meta.regularMarketChangePercent ?? null;
    const change = meta.regularMarketChange ?? null;

    await supabase.from('companies').update({
      current_price: price,
      market_cap: marketCap,
      currency,
      price_updated_at: new Date().toISOString(),
    }).eq('ticker', ticker);

    return res.status(200).json({ ticker, price, marketCap, currency, changePercent, change, source: 'yahoo' });
  } catch (err) {
    if (cached?.current_price) {
      return res.status(200).json({
        ticker,
        price: cached.current_price,
        marketCap: cached.market_cap,
        currency: cached.currency,
        source: 'cache_fallback',
      });
    }
    return res.status(500).json({ error: err.message });
  }
}

// ─── 차트 데이터 (일봉 N개월) ─────────────────────────────
async function handleChart(req, res) {
  const { ticker, range = '3mo' } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${range}`;
    const yf = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockRipple/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!yf.ok) throw new Error(`Yahoo Finance HTTP ${yf.status}`);
    const data = await yf.json();
    const result = data.chart?.result?.[0];
    if (!result) throw new Error('No data');

    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const meta = result.meta || {};

    const points = timestamps
      .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
      .filter(p => p.close != null);

    return res.status(200).json({
      ticker,
      currency: meta.currency || 'USD',
      currentPrice: meta.regularMarketPrice || meta.previousClose,
      longName: meta.longName || meta.shortName || ticker,
      points,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
