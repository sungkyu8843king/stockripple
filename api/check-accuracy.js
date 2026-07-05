import { createClient } from '@supabase/supabase-js';
import { verifyAdmin } from '../lib/auth.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PERIODS = [
  // grace: 채점 유효 기간. 예: 1일 정확도는 진입 후 1~4일 사이에만 채점
  // (그 이후에 현재가로 재면 '1일' 수익률이 아니라 엉뚱한 기간을 재는 것 → 통계 오염)
  { key: '1d',  days: 1,  minActual: 0.3, grace: 3  },
  { key: '3d',  days: 3,  minActual: 0.5, grace: 3  },
  { key: '7d',  days: 7,  minActual: 1.5, grace: 5  },
  { key: '30d', days: 30, minActual: 3.0, grace: 10 },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const _auth = await verifyAdmin(req.headers.authorization);
  if (!_auth.ok) return res.status(401).json({ error: _auth.error });

  const now = new Date();
  const results = { checked_1d: 0, checked_3d: 0, checked_7d: 0, checked_30d: 0, errors: [] };

  // 시간 예산: maxDuration 60s 내에서 안전하게 종료 (초과분은 다음 실행이 이어서 처리)
  const t0 = Date.now();
  const TIME_BUDGET_MS = 48000;

  for (const { key, days, minActual, grace } of PERIODS) {
    if (Date.now() - t0 > TIME_BUDGET_MS) { results.errors.push('시간 예산 초과 — 다음 실행에서 계속'); break; }
    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

    // 채점 시기를 놓친 행(진입 후 days+grace 초과)은 일괄 만료 처리 —
    // check_date만 찍고 is_accurate는 null 유지 → 큐에서 빠지되 통계에는 미포함
    const staleCutoff = new Date(now - (days + grace) * 24 * 60 * 60 * 1000).toISOString();
    try {
      const { count: expired } = await supabase
        .from('analysis_companies')
        .update({ [`check_date_${key}`]: now.toISOString() }, { count: 'exact' })
        .not('entry_price', 'is', null)
        .is(`check_date_${key}`, null)
        .lte('entry_date', staleCutoff);
      if (expired) results[`expired_${key}`] = expired;
    } catch {}

    const { data: due, error } = await supabase
      .from('analysis_companies')
      .select('id, entry_price, upside_pct, entry_date, companies(ticker)')
      .not('entry_price', 'is', null)
      .is(`check_date_${key}`, null)
      .lte('entry_date', cutoff)
      .order('entry_date', { ascending: false })   // 최신 우선 — 제때(유효 기간 내) 채점
      .limit(60);

    if (error) { results.errors.push(`${key} query: ${error.message}`); continue; }

    for (const row of due || []) {
      if (Date.now() - t0 > TIME_BUDGET_MS) break;
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
        await sleep(150);
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
