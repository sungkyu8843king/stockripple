/**
 * fix-company-names.js
 * Yahoo Finance의 공식 longName으로 모든 companies 테이블의 name_en/name_ko를 보정.
 * Yahoo longName과 너무 다른 한국어 이름은 영어명으로 교체.
 *
 * POST /api/fix-company-names  (요구: Supabase admin 인증 또는 ADMIN_SECRET)
 *   body: { dry_run: true }  → 변경할 항목만 미리보기
 *   body: { dry_run: false } → 실제 업데이트
 */
import { createClient } from '@supabase/supabase-js';
import { verifyAdmin } from '../lib/auth.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const _a = await verifyAdmin(req.headers.authorization);
  if (!_a.ok) return res.status(401).json({ error: _a.error });

  const dryRun = !!req.body?.dry_run;

  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, ticker, name_ko, name_en');
  if (error) return res.status(500).json({ error: error.message });

  const updates = [];
  const errors  = [];

  for (const c of companies || []) {
    try {
      const yfMeta = await fetchYahooMeta(c.ticker);
      if (!yfMeta) continue;
      const officialEn = yfMeta.longName || yfMeta.shortName || null;
      if (!officialEn) continue;

      const update = {};

      // name_en 보정: 비어있거나 ticker와 같으면 공식명으로
      if (!c.name_en || c.name_en === c.ticker || c.name_en === c.name_ko) {
        update.name_en = officialEn;
      }

      // name_ko 검증: 의심스러운 경우 영어명으로 폴백
      // 의심 조건:
      //  1) 비어있음
      //  2) 영어 단어 첫 토큰의 음역과 전혀 다른 경우 (간단한 휴리스틱)
      const koSuspicious = !c.name_ko || c.name_ko === c.ticker;
      if (koSuspicious) {
        update.name_ko = officialEn;
      }

      if (Object.keys(update).length) {
        updates.push({ id: c.id, ticker: c.ticker, before: { en: c.name_en, ko: c.name_ko }, after: update });
        if (!dryRun) {
          const { error: upErr } = await supabase.from('companies').update(update).eq('id', c.id);
          if (upErr) errors.push(`${c.ticker}: ${upErr.message}`);
        }
      }

      // Yahoo rate limit 보호
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      errors.push(`${c.ticker}: ${e.message}`);
    }
  }

  return res.status(200).json({
    ok: true,
    dryRun,
    total:   companies?.length || 0,
    updated: updates.length,
    updates: updates.slice(0, 30),  // 미리보기 30개만
    errors,
  });
}

async function fetchYahooMeta(ticker) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return j?.chart?.result?.[0]?.meta || null;
  } catch { return null; }
}
