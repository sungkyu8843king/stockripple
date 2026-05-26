/**
 * fix-company-names.js
 * Yahoo Finance의 공식 longName + Claude AI 검증으로 회사명 보정
 *
 * POST /api/fix-company-names
 *   body: {
 *     dry_run: true|false,
 *     ai_verify: true|false,     // Claude로 한국어 이름 환각 검증 (느림 + 비용)
 *     batch_size: 30,            // AI 검증 시 한 번에 처리할 개수 (기본 30)
 *     batch_offset: 0,           // AI 검증 시 시작 오프셋
 *   }
 */
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { verifyAdmin } from '../lib/auth.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const _a = await verifyAdmin(req.headers.authorization);
  if (!_a.ok) return res.status(401).json({ error: _a.error });

  const dryRun     = !!req.body?.dry_run;
  const aiVerify   = !!req.body?.ai_verify;
  const batchSize  = Math.min(parseInt(req.body?.batch_size || 30, 10), 50);
  const batchOff   = parseInt(req.body?.batch_offset || 0, 10);

  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, ticker, name_ko, name_en')
    .order('ticker');
  if (error) return res.status(500).json({ error: error.message });

  const updates = [];
  const errors  = [];

  // AI 검증 모드면 배치 슬라이스
  const targets = aiVerify
    ? (companies || []).slice(batchOff, batchOff + batchSize)
    : (companies || []);

  // 먼저 Yahoo로 영어 이름 + 기본 휴리스틱
  const enriched = [];
  for (const c of targets) {
    try {
      const yfMeta = await fetchYahooMeta(c.ticker);
      const officialEn = yfMeta?.longName || yfMeta?.shortName || null;
      enriched.push({ c, officialEn });
      await new Promise(r => setTimeout(r, 80));
    } catch (e) {
      errors.push(`${c.ticker} fetch: ${e.message}`);
      enriched.push({ c, officialEn: null });
    }
  }

  // AI 검증 (선택)
  let aiCorrections = {};
  if (aiVerify && anthropic) {
    aiCorrections = await aiVerifyNames(enriched);
  }

  // 업데이트 결정
  for (const { c, officialEn } of enriched) {
    const update = {};
    if (officialEn && (!c.name_en || c.name_en === c.ticker || c.name_en === c.name_ko)) {
      update.name_en = officialEn;
    }

    // AI 가 잘못됐다고 판단한 경우 무조건 교체
    const aiCorr = aiCorrections[c.ticker];
    if (aiCorr && aiCorr.is_wrong && aiCorr.correct_name_ko) {
      update.name_ko = aiCorr.correct_name_ko;
    } else if (!c.name_ko || c.name_ko === c.ticker) {
      // 빈 값이거나 ticker 자체인 경우만 영어명으로 폴백
      if (officialEn) update.name_ko = officialEn;
    }

    if (Object.keys(update).length) {
      updates.push({
        id: c.id, ticker: c.ticker,
        before: { en: c.name_en, ko: c.name_ko },
        after: update,
        reason: aiCorr?.is_wrong ? `AI: ${aiCorr.reason || '환각 감지'}` : '공식명 보정',
      });
      if (!dryRun) {
        const { error: upErr } = await supabase.from('companies').update(update).eq('id', c.id);
        if (upErr) errors.push(`${c.ticker}: ${upErr.message}`);
      }
    }
  }

  return res.status(200).json({
    ok: true,
    dryRun,
    aiVerify,
    total:   companies?.length || 0,
    scanned: targets.length,
    updated: updates.length,
    updates: updates.slice(0, 50),
    errors,
    nextOffset: aiVerify ? (batchOff + batchSize < (companies?.length || 0) ? batchOff + batchSize : null) : null,
  });
}

async function aiVerifyNames(enriched) {
  const candidates = enriched.filter(e => e.c.name_ko && e.officialEn);
  if (!candidates.length) return {};

  const list = candidates.map(({ c, officialEn }) =>
    `- ${c.ticker}: 현재 한국어명="${c.name_ko}", 공식영문명="${officialEn}"`
  ).join('\n');

  const prompt = `다음은 주식 종목들의 한국어 이름과 Yahoo Finance 공식 영문명입니다. 각 한국어 이름이 해당 회사를 정확히 가리키는지 검증하세요.

${list}

각 종목별로 한국어 이름이 잘못됐는지 (다른 회사 이름이거나, 제품명을 회사명으로 잘못 사용한 경우 등) 판단하세요.
잘못된 경우만 JSON 배열로 반환하세요. 다른 텍스트 없이:

[
  {
    "ticker": "LRCX",
    "is_wrong": true,
    "reason": "라이젠은 AMD의 CPU 제품명, Lam Research는 반도체 장비 회사",
    "correct_name_ko": "램 리서치"
  }
]

올바른 이름(예: "마이크론 테크놀로지" for Micron)은 결과에 포함하지 마세요. 영문명이 그냥 한국어로 쓰여 있는 경우(예: "Lam Research" 그대로)도 잘못된 것은 아니므로 포함하지 마세요.`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content[0].text.trim();
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return {};
    const arr = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
    const result = {};
    for (const item of arr) {
      if (item.ticker && item.is_wrong) result[item.ticker] = item;
    }
    return result;
  } catch (e) {
    return {};
  }
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
