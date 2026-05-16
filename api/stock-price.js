import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

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

    await supabase.from('companies').update({
      current_price: price,
      market_cap: marketCap,
      currency,
      price_updated_at: new Date().toISOString(),
    }).eq('ticker', ticker);

    return res.status(200).json({ ticker, price, marketCap, currency, source: 'yahoo' });
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
