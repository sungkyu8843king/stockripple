/**
 * admin.js — 4개 admin 도구 통합
 *  POST /api/admin?action=verify       → 인증 확인 (admin-verify)
 *  POST /api/admin?action=fix-names    → 회사명 일괄 보정 (fix-company-names)
 *  GET  /api/admin?action=stats        → 통계 + 백테스트
 *  GET  /api/admin?action=summary&ticker=X → 회사 AI 종합 분석 (인증 불필요)
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = (req.query?.action || '').toString();

  // summary 는 인증 불필요 (공개 정보)
  if (action === 'summary') {
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return handleSummary(req, res);
  }

  // 나머지는 admin 인증 필요
  const _a = await verifyAdmin(req.headers.authorization);
  if (!_a.ok) return res.status(401).json({ error: _a.error });

  if (action === 'verify')    return res.status(200).json({ ok: true, mode: _a.mode, email: _a.email });
  if (action === 'fix-names') return handleFixNames(req, res);
  if (action === 'stats')     return handleStats(req, res);

  return res.status(400).json({ error: 'Unknown action. Use ?action=verify|fix-names|stats|summary' });
}

// ════════════════════════════════════════════════════════════
// 1) 회사 AI 종합 분석 (공개)
// ════════════════════════════════════════════════════════════
async function handleSummary(req, res) {
  const ticker = (req.query?.ticker || '').toString().trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  if (!anthropic) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });

  try {
    const { data: company } = await supabase
      .from('companies')
      .select('id, ticker, name_ko, name_en, market, sector')
      .eq('ticker', ticker)
      .single();
    if (!company) return res.status(404).json({ error: 'company not found' });

    const { data: recent } = await supabase
      .from('analysis_companies')
      .select('upside_pct, confidence, rationale, entry_date, ripple_sector, analyses(ai_summary, issues(title, published_at))')
      .eq('company_id', company.id)
      .order('entry_date', { ascending: false })
      .limit(8);

    const analyses = (recent || []).map(r => ({
      sector: r.ripple_sector,
      upside: r.upside_pct,
      confidence: r.confidence,
      rationale: (r.rationale || '').split('[TRADE]')[0].trim(),
      issueTitle: r.analyses?.issues?.title || '',
      date: r.entry_date,
    }));

    // 전략적 투자/지분 컨텍스트 주입 (AI/우주/로봇 등 미래 테마 노출도 고려)
    let strategicCtx = null;
    try {
      const mod = await import('../lib/strategic-investments.js');
      strategicCtx = mod.formatBetsForPrompt(ticker);
    } catch {}

    const prompt = `당신은 주식 분석 전문가입니다. 아래 회사에 대해 한국 투자자를 위한 종합 분석 보고서를 작성하세요.

회사 정보:
- 티커: ${ticker}
- 한국명: ${company.name_ko || '없음'}
- 영문명: ${company.name_en || '없음'}
- 시장: ${company.market === 'KR' ? '한국' : '미국'}

${strategicCtx ? `🎯 전략적 투자/지분 (본업 외 미래 성장축 — 매우 중요):\n${strategicCtx}\n\n이 정보는 주가 선반영 논리의 핵심 단서입니다. 예: SK텔레콤이 Anthropic에 투자했다면 Claude(AI) 성공 → SKT 주가 선반영. 종합 근거(thesis)와 전략적 노출(strategic_exposure) 작성 시 반드시 반영.\n` : ''}
최근 AI 분석들 (${analyses.length}건):
${analyses.map((a, i) => `${i+1}. [${a.date?.slice(0,10)}] ${a.issueTitle}\n   - 섹터: ${a.sector||'미분류'}, 예상 상승: ${a.upside??'?'}%, 신뢰도: ${a.confidence??'?'}%\n   - 근거: ${a.rationale.slice(0, 200)}`).join('\n')}

다음 JSON만 반환하세요 (다른 텍스트 없이):
{
  "overview": "회사 개요 - 어떤 사업을 하는지, 주력 제품/서비스, 시장 점유율 (2-3문장, 150자 내외)",
  "thesis": "현재 매수 후보로 거론되는 종합 근거 (위 분석들 + 전략적 투자 통합) (2-3문장, 200자 내외)",
  "strategic_exposure": "본업 외 보유한 전략적 지분/투자로 인한 간접 노출 (예: 'Anthropic 지분 보유 → Claude AI 성공이 주가에 선반영 중'). 해당 없으면 빈 문자열. (1-3문장, 250자 내외)",
  "key_risks": ["주요 리스크 1", "주요 리스크 2"],
  "competitive_position": "시장 내 경쟁 우위 또는 약점 — 전략적 투자가 만든 차별화 포지션 포함 (1-2문장)",
  "watch_points": ["주시 포인트 1 — 전략적 지분 가치를 끌어올릴 만한 이벤트 1개 이상 포함", "주시 포인트 2"]
}

규칙:
- 사실 기반, 한국어, 객관적, 추측 금지
- 위에 제공된 "전략적 투자/지분" 정보가 있다면 thesis와 strategic_exposure에 반드시 활용 (특히 ⭐ 표시된 항목)
- 전략적 투자 정보가 없으면 strategic_exposure는 빈 문자열 ""로 반환`;

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content[0].text.trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON in AI response');
    const parsed = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));

    return res.status(200).json({
      ok: true,
      ticker,
      company: { name_ko: company.name_ko, name_en: company.name_en, market: company.market, sector: company.sector },
      ...parsed,
      analyses_count: analyses.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ════════════════════════════════════════════════════════════
// 2) 회사명 일괄 보정
// ════════════════════════════════════════════════════════════
async function handleFixNames(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const dryRun     = !!req.body?.dry_run;
  const aiVerify   = !!req.body?.ai_verify;
  const batchSize  = Math.min(parseInt(req.body?.batch_size || 12, 10), 20);
  const batchOff   = parseInt(req.body?.batch_offset || 0, 10);
  const startMs    = Date.now();

  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, ticker, name_ko, name_en')
    .order('ticker');
  if (error) return res.status(500).json({ error: error.message });

  const updates = [];
  const errors  = [];

  const targets = aiVerify ? (companies || []).slice(batchOff, batchOff + batchSize) : (companies || []);

  const yhResults = await Promise.all(
    targets.map(c => fetchYahooMeta(c.ticker)
      .then(m => ({ c, officialEn: m?.longName || m?.shortName || null }))
      .catch(e => { errors.push(`${c.ticker} fetch: ${e.message}`); return { c, officialEn: null }; })
    )
  );
  const enriched = yhResults;
  const yhMs = Date.now() - startMs;

  let aiCorrections = {};
  let aiMs = 0;
  if (aiVerify && anthropic) {
    const aiStart = Date.now();
    aiCorrections = await aiVerifyNames(enriched);
    aiMs = Date.now() - aiStart;
  }

  for (const { c, officialEn } of enriched) {
    const update = {};
    if (officialEn && (!c.name_en || c.name_en === c.ticker || c.name_en === c.name_ko)) {
      update.name_en = officialEn;
    }
    const aiCorr = aiCorrections[c.ticker];
    if (aiCorr && aiCorr.is_wrong && aiCorr.correct_name_ko) {
      update.name_ko = aiCorr.correct_name_ko;
    } else if (!c.name_ko || c.name_ko === c.ticker) {
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

  const totalMs = Date.now() - startMs;
  return res.status(200).json({
    ok: true, dryRun, aiVerify,
    total:   companies?.length || 0,
    scanned: targets.length,
    updated: updates.length,
    updates: updates.slice(0, 50),
    errors,
    timing:  { totalMs, yhMs, aiMs },
    offset:  batchOff,
    nextOffset: aiVerify ? (batchOff + batchSize < (companies?.length || 0) ? batchOff + batchSize : null) : null,
  });
}

async function aiVerifyNames(enriched) {
  const candidates = enriched.filter(e => e.c.name_ko && e.officialEn);
  if (!candidates.length) return {};
  const list = candidates.map(({ c, officialEn }) =>
    `- ${c.ticker}: 현재 한국어명="${c.name_ko}", 공식영문명="${officialEn}"`
  ).join('\n');
  const prompt = `다음 종목들의 한국어 이름이 정확한지 검증하세요.

${list}

각 종목 한국어 이름이 잘못됐는지 (다른 회사 이름, 제품명 오용 등) 판단하고, 잘못된 경우만 JSON 배열로 반환:

[{"ticker":"LRCX","is_wrong":true,"reason":"라이젠은 AMD CPU 제품명","correct_name_ko":"램 리서치"}]

올바른 이름이나 영문명 그대로 쓴 경우는 포함하지 마세요.`;
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
  } catch { return {}; }
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

// ════════════════════════════════════════════════════════════
// 3) 통계 + 백테스트
// ════════════════════════════════════════════════════════════
async function handleStats(req, res) {
  try {
    const { data, error } = await supabase
      .from('analysis_companies')
      .select(`
        upside_pct, confidence, ripple_sector, entry_date, entry_price,
        is_accurate_1d, actual_return_1d,
        is_accurate_7d, actual_return_7d,
        is_accurate_30d, actual_return_30d,
        companies(ticker, name_ko, market)
      `)
      .limit(5000);
    if (error) return res.status(500).json({ error: error.message });

    const rows = data || [];
    if (!rows.length) return res.status(200).json({ ok: true, empty: true });

    const overall = {
      total: rows.length,
      verified1d:  rows.filter(r => r.is_accurate_1d  != null).length,
      verified7d:  rows.filter(r => r.is_accurate_7d  != null).length,
      verified30d: rows.filter(r => r.is_accurate_30d != null).length,
    };
    overall.accuracy1d  = accuracyOf(rows, '1d',  0.3);
    overall.accuracy7d  = accuracyOf(rows, '7d',  1.5);
    overall.accuracy30d = accuracyOf(rows, '30d', 3.0);

    const buckets = [
      { label: '0-40',  min: 0,  max: 40 },
      { label: '40-60', min: 40, max: 60 },
      { label: '60-80', min: 60, max: 80 },
      { label: '80-100', min: 80, max: 101 },
    ];
    const byConfidence = buckets.map(b => {
      const bucket = rows.filter(r => (r.confidence || 0) >= b.min && (r.confidence || 0) < b.max);
      return {
        bucket: b.label, total: bucket.length,
        accuracy7d: accuracyOf(bucket, '7d', 1.5),
        avgActualReturn7d: avgReturn(bucket, '7d'),
        avgUpside: avg(bucket.map(r => r.upside_pct)),
      };
    });

    const sectorMap = {};
    for (const r of rows) {
      const s = r.ripple_sector || '미분류';
      (sectorMap[s] = sectorMap[s] || []).push(r);
    }
    const bySector = Object.entries(sectorMap)
      .filter(([, arr]) => arr.length >= 3)
      .map(([sector, arr]) => ({
        sector, total: arr.length,
        accuracy7d: accuracyOf(arr, '7d', 1.5),
        avgActualReturn7d: avgReturn(arr, '7d'),
        avgUpside: avg(arr.map(r => r.upside_pct)),
      }))
      .sort((a, b) => (b.accuracy7d || 0) - (a.accuracy7d || 0))
      .slice(0, 15);

    const verified7d = rows.filter(r => r.actual_return_7d != null && r.entry_price != null);
    const winners    = verified7d.filter(r => r.actual_return_7d > 0);

    const byTickerMap = {};
    for (const r of verified7d) {
      const t = r.companies?.ticker;
      if (!t) continue;
      if (!byTickerMap[t]) byTickerMap[t] = {
        ticker: t, name: r.companies?.name_ko || t,
        market: r.companies?.market || 'US', returns: [],
      };
      byTickerMap[t].returns.push(r.actual_return_7d);
    }
    const byTicker = Object.values(byTickerMap).map(t => ({
      ...t, n: t.returns.length,
      avg: avg(t.returns),
      total: t.returns.reduce((s, v) => s + v, 0),
    }));
    const topWinners = [...byTicker].sort((a, b) => b.total - a.total).slice(0, 10);
    const topLosers  = [...byTicker].sort((a, b) => a.total - b.total).slice(0, 10);

    const backtest = {
      totalTrades: verified7d.length,
      winRate:     verified7d.length ? Math.round(winners.length / verified7d.length * 100) : 0,
      avgReturn:   avg(verified7d.map(r => r.actual_return_7d)),
      bestTrade:   verified7d.length ? Math.max(...verified7d.map(r => r.actual_return_7d)) : 0,
      worstTrade:  verified7d.length ? Math.min(...verified7d.map(r => r.actual_return_7d)) : 0,
      cumulativeReturn: verified7d.reduce((s, r) => s + r.actual_return_7d, 0),
      byPeriod: {
        '1d':  periodStats(rows, '1d',  0.3),
        '7d':  periodStats(rows, '7d',  1.5),
        '30d': periodStats(rows, '30d', 3.0),
      },
      topWinners, topLosers,
    };

    const byDateMap = {};
    for (const r of verified7d) {
      const d = (r.entry_date || '').split('T')[0];
      if (!d) continue;
      (byDateMap[d] = byDateMap[d] || []).push(r.actual_return_7d);
    }
    const timeline = Object.entries(byDateMap)
      .map(([date, arr]) => ({ date, count: arr.length, avgReturn7d: avg(arr) }))
      .filter(d => d.count >= 2)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-60);

    return res.status(200).json({ ok: true, overall, byConfidence, bySector, backtest, timeline });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function accuracyOf(rows, period, minAbs) {
  const accKey = `is_accurate_${period}`;
  const retKey = `actual_return_${period}`;
  const verified = rows.filter(r => r[accKey] != null);
  if (!verified.length) return null;
  const hits = verified.filter(r => r[accKey] === true && Math.abs(r[retKey] || 0) >= minAbs);
  return Math.round(hits.length / verified.length * 100);
}
function avgReturn(rows, period) {
  const retKey = `actual_return_${period}`;
  const values = rows.map(r => r[retKey]).filter(v => v != null);
  if (!values.length) return null;
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length * 100) / 100;
}
function avg(arr) {
  const filtered = arr.filter(v => v != null);
  if (!filtered.length) return null;
  return Math.round(filtered.reduce((s, v) => s + v, 0) / filtered.length * 100) / 100;
}
function periodStats(rows, period, minAbs) {
  const accKey = `is_accurate_${period}`;
  const retKey = `actual_return_${period}`;
  const verified = rows.filter(r => r[accKey] != null);
  if (!verified.length) return { verified: 0, accuracy: null, avgReturn: null };
  const hits = verified.filter(r => r[accKey] === true && Math.abs(r[retKey] || 0) >= minAbs);
  return {
    verified: verified.length,
    accuracy: Math.round(hits.length / verified.length * 100),
    avgReturn: avg(verified.map(r => r[retKey])),
    winRate:   Math.round(verified.filter(r => r[retKey] > 0).length / verified.length * 100),
  };
}
