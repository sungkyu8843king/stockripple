import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const results = { checked_7d: 0, checked_30d: 0, errors: [] };

  // 7일 체크: entry_date가 7일 이상 지났고 check_date_7d가 없는 것
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: due7d, error: e7 } = await supabase
    .from('analysis_companies')
    .select('id, company_id, entry_price, upside_pct, companies(ticker, currency)')
    .not('entry_price', 'is', null)
    .is('check_date_7d', null)
    .lte('entry_date', sevenDaysAgo)
    .limit(50);

  if (e7) return res.status(500).json({ error: e7.message });

  for (const row of due7d || []) {
    try {
      const price = await fetchPrice(row.companies?.ticker);
      if (!price) continue;

      const actualReturn = ((price - row.entry_price) / row.entry_price) * 100;
      const isAccurate = row.upside_pct > 0
        ? actualReturn > 0
        : actualReturn < 0;

      await supabase.from('analysis_companies').update({
        check_price_7d: price,
        check_date_7d: now.toISOString(),
        actual_return_7d: Math.round(actualReturn * 100) / 100,
        is_accurate_7d: isAccurate,
      }).eq('id', row.id);

      results.checked_7d++;
      await sleep(300);
    } catch (err) {
      results.errors.push(`7d ${row.companies?.ticker}: ${err.message}`);
    }
  }

  // 30일 체크
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: due30d, error: e30 } = await supabase
    .from('analysis_companies')
    .select('id, company_id, entry_price, upside_pct, companies(ticker, currency)')
    .not('entry_price', 'is', null)
    .is('check_date_30d', null)
    .lte('entry_date', thirtyDaysAgo)
    .limit(50);

  for (const row of due30d || []) {
    try {
      const price = await fetchPrice(row.companies?.ticker);
      if (!price) continue;

      const actualReturn = ((price - row.entry_price) / row.entry_price) * 100;
      const isAccurate = row.upside_pct > 0
        ? actualReturn > 0
        : actualReturn < 0;

      await supabase.from('analysis_companies').update({
        check_price_30d: price,
        check_date_30d: now.toISOString(),
        actual_return_30d: Math.round(actualReturn * 100) / 100,
        is_accurate_30d: isAccurate,
      }).eq('id', row.id);

      results.checked_30d++;
      await sleep(300);
    } catch (err) {
      results.errors.push(`30d ${row.companies?.ticker}: ${err.message}`);
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
