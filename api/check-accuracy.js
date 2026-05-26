import { createClient } from '@supabase/supabase-js';
import { verifyAdmin } from '../lib/auth.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PERIODS = [
  { key: '1d',  days: 1,  minActual: 0.3  },  // 최소 0.3% 실제 변동 있어야 "적중"
  { key: '3d',  days: 3,  minActual: 0.5  },  // 최소 0.5%
  { key: '7d',  days: 7,  minActual: 1.5  },  // 최소 1.5%
  { key: '30d', days: 30, minActual: 3.0  },  // 최소 3.0%
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const _auth = await verifyAdmin(req.headers.authorization);
  if (!_auth.ok) return res.status(401).json({ error: _auth.error });

  const now = new Date();
  const results = { checked_1d: 0, checked_3d: 0, checked_7d: 0, checked_30d: 0, errors: [] };

  for (const { key, days, minActual } of PERIODS) {
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
        // 적중 기준: ① 방향 일치 + ② 최소 실제 수익률 달성 (노이즈 제거)
        // 예) 예측 +22%이면 방향(상승) + 실제 0.3%↑ 이상이어야 적중
        const directionOk = row.upside_pct > 0 ? actualReturn > 0 : actualReturn < 0;
        const magnitudeOk = Math.abs(actualReturn) >= minActual;
        const isAccurate = directionOk && magnitudeOk;

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
