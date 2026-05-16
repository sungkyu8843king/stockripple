import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PERIODS = [
  { key: '1d',  days: 1  },
  { key: '3d',  days: 3  },
  { key: '7d',  days: 7  },
  { key: '30d', days: 30 },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.headers.authorization !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const results = { checked_1d: 0, checked_3d: 0, checked_7d: 0, checked_30d: 0, errors: [] };

  for (const { key, days } of PERIODS) {
    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
    const { data: due, error } = await supabase
      .from('analysis_companies')
      .select('id, entry_price, upside_pct, companies(ticker)')
      .not('entry_price', 'is', null)
      .is(`check_date_${key}`, null)
      .lte('entry_date', cutoff)
      .limit(50);

    if (error) { results.errors.push(`${key} query: ${error.message}`); continue; }

    for (const row of due || []) {
      try {
        const price = await fetchPrice(row.companies?.ticker);
        if (!price) continue;

        const actualReturn = Math.round(((price - row.entry_price) / row.entry_price) * 10000) / 100;
        const isAccurate = row.upside_pct > 0 ? actualReturn > 0 : actualReturn < 0;

        await supabase.from('analysis_companies').update({
          [`check_price_${key}`]:   price,
          [`check_date_${key}`]:    now.toISOString(),
          [`actual_return_${key}`]: actualReturn,
          [`is_accurate_${key}`]:   isAccurate,
        }).eq('id', row.id);

        results[`checked_${key}`]++;
        await sleep(300);
      } catch (err) {
        results.errors.push(`${key} ${row.companies?.ticker}: ${err.message}`);
      }
    }
  }

  return res.status(200).json(results);
}

async function fetchPrice(ticker) {
  if (!ticker) return null;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data.chart?.result?.[0]?.meta;
    return meta?.regularMarketPrice || meta?.previousClose || null;
  } catch {
    return null;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
