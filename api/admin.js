/**
 * admin.js — 4개 admin 도구 통합
 *  POST /api/admin?action=verify       → 인증 확인 (admin-verify)
 *  POST /api/admin?action=fix-names    → 회사명 일괄 보정 (fix-company-names)
 *  GET  /api/admin?action=stats        → 통계 + 백테스트
 *  GET  /api/admin?action=summary&ticker=X → 회사 AI 종합 분석 (인증 불필요)
 *  POST /api/admin?action=extract-investments → 최근 분석된 이슈에서 전략 투자 패턴 추출 (cron 또는 admin)
 *  GET  /api/admin?action=list-investments    → 전략투자 목록 조회 (필터/페이지)
 *  POST /api/admin?action=update-investment   → 항목 수정 (highlight/status)
 *  POST /api/admin?action=delete-investment   → 항목 삭제 (status=rejected 소프트 삭제)
 *  GET  /api/admin?action=investment-events   → 티커별 추출 이벤트 히스토리 (그래프용)
 *  POST /api/admin?action=dart-poll           → DART 5%+ 지분공시 폴링 (한국 OpenDart API)
 *  POST /api/admin?action=sec-13f-poll        → SEC EDGAR 13F 폴링 (미국 헤지펀드 보유)
 *  POST /api/admin?action=dart-sync-corp-codes → DART corpCode.xml.zip 다운로드 & companies 매핑 (느릴 수 있음)
 *  POST /api/admin?action=dart-upload-corp-codes → CSV 수동 업로드 (Vercel→한국 네트워크 느릴 때 fallback)
 *  POST /api/admin?action=verify-kr-names → DART corp_code 기반 KR 종목명 검증 + 자동 수정
 *  GET  /api/admin?action=dart-company-detail&ticker=005930.KS → DART 상세 (주주/임원/재무)
 */
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { verifyAdmin } from '../lib/auth.js';

// 일부 액션(dart-sync, sec-13f, extract-investments)은 무거우므로 최대 60초 허용
export const config = { maxDuration: 60 };

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
  // investment-events 는 공개 조회 가능 (회사 페이지에서 사용)
  if (action === 'investment-events') return handleInvestmentEvents(req, res);
  // dart-company-detail 도 공개 (캐시된 데이터 조회)
  if (action === 'dart-company-detail') return handleDartCompanyDetail(req, res);

  // 나머지는 admin 인증 필요
  const _a = await verifyAdmin(req.headers.authorization);
  if (!_a.ok) return res.status(401).json({ error: _a.error });

  if (action === 'verify')              return res.status(200).json({ ok: true, mode: _a.mode, email: _a.email });
  if (action === 'fix-names')           return handleFixNames(req, res);
  if (action === 'stats')               return handleStats(req, res);
  if (action === 'extract-investments') return handleExtractInvestments(req, res);
  if (action === 'list-investments')    return handleListInvestments(req, res);
  if (action === 'update-investment')   return handleUpdateInvestment(req, res);
  if (action === 'delete-investment')   return handleDeleteInvestment(req, res);
  if (action === 'dart-poll')           return handleDartPoll(req, res);
  if (action === 'sec-13f-poll')        return handleSec13fPoll(req, res);
  if (action === 'dart-sync-corp-codes') return handleDartSyncCorpCodes(req, res);
  if (action === 'dart-upload-corp-codes') return handleDartUploadCorpCodes(req, res);
  if (action === 'verify-kr-names') return handleVerifyKrNames(req, res);

  return res.status(400).json({ error: 'Unknown action' });
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

    // 전략적 투자/지분 컨텍스트 주입 (하드코딩 큐레이션 + AI 자동누적 DB 병합)
    let strategicCtx = null;
    try {
      const mod = await import('../lib/strategic-investments.js');
      strategicCtx = await mod.formatMergedBetsForPrompt(supabase, ticker);
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
    // 복리 누적 수익률 (1+r1)(1+r2)...(1+rn) - 1
    // 단순 합산은 의미 없음 (46거래 × 22% = 1040% 같은 비현실적 수치)
    const compound = (rets) => {
      const v = rets.reduce((acc, r) => acc * (1 + (r || 0) / 100), 1) - 1;
      return Math.round(v * 10000) / 100;  // % 소수 둘째자리
    };
    const r2 = (x) => x == null ? null : Math.round(x * 100) / 100;

    const MIN_TRADES = 3;  // 표본 1-2개는 노이즈 → 제외
    const byTicker = Object.values(byTickerMap).map(t => ({
      ...t, n: t.returns.length,
      avg:        r2(avg(t.returns)),
      compounded: compound(t.returns),  // 복리 누적
    }));
    const significant = byTicker.filter(t => t.n >= MIN_TRADES);
    const topWinners = [...significant].sort((a, b) => b.compounded - a.compounded).slice(0, 10);
    const topLosers  = [...significant].sort((a, b) => a.compounded - b.compounded).slice(0, 10);

    const verified7dRets = verified7d.map(r => r.actual_return_7d).filter(v => v != null);
    const backtest = {
      totalTrades: verified7d.length,
      winRate:     verified7d.length ? Math.round(winners.length / verified7d.length * 100) : 0,
      avgReturn:   r2(avg(verified7dRets)),
      bestTrade:   verified7dRets.length ? r2(Math.max(...verified7dRets)) : 0,
      worstTrade:  verified7dRets.length ? r2(Math.min(...verified7dRets)) : 0,
      // 복리 누적: 모든 거래를 동일 비중으로 순차 보유했을 때 자본 변화율
      cumulativeReturn: compound(verified7dRets),
      minTradesFilter: MIN_TRADES,
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

// ════════════════════════════════════════════════════════════
// 5) 전략 투자 자동 추출 (cron이 매일 호출)
// ════════════════════════════════════════════════════════════
// 최근 24~48h 내 분석된 이슈에서 "X가 Y에 투자/인수/지분" 패턴을 Claude로 추출
// → strategic_investments 테이블에 upsert. 중복은 seen_count 증가 + last_seen 갱신.
async function handleExtractInvestments(req, res) {
  if (!anthropic) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });

  const sinceHours = parseInt(req.body?.since_hours || req.query?.since_hours || 48, 10);
  const maxIssues  = Math.min(parseInt(req.body?.max || req.query?.max || 30, 10), 60);

  // 최근 분석된 이슈 수집
  const sinceIso = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const { data: issues, error: issErr } = await supabase
    .from('issues')
    .select('id, title, summary, source_url')
    .eq('is_analyzed', true)
    .gte('published_at', sinceIso)
    .order('published_at', { ascending: false })
    .limit(maxIssues);
  if (issErr) return res.status(500).json({ error: issErr.message });
  if (!issues?.length) return res.status(200).json({ ok: true, scanned: 0, extracted: 0 });

  const results = { scanned: 0, extracted: 0, new: 0, updated: 0, skipped: 0, errors: [] };

  for (const issue of issues) {
    results.scanned++;
    try {
      const prompt = `당신은 금융 뉴스 분석가입니다. 아래 뉴스에서 "상장사가 다른 기업/프로젝트에 투자·인수·지분 확보" 사실이 명시적으로 언급되었는지만 추출하세요.

뉴스 제목: ${issue.title}
요약: ${issue.summary || '없음'}

엄격한 규칙:
1. 명시적 사실만 추출. "할 수도 있다", "검토 중" 등 추측·계획은 제외
2. 투자자는 반드시 상장사여야 함 (티커가 존재해야 함). 비상장 VC/펀드는 제외
3. 단순 협력·MOU·공급계약은 제외. 지분 인수/투자/합작법인(JV)만
4. 대상이 비상장이어도 OK (예: Anthropic, OpenAI, SpaceX, xAI)
5. 한국 상장사는 6자리.KS 형식, 미국은 NYSE/NASDAQ 티커
6. theme는 "AI", "AI 반도체", "로봇", "휴머노이드", "자율주행", "우주", "위성통신", "방산", "바이오", "GLP-1", "원자력", "SMR", "EV 배터리", "K-팝", "게임", "핀테크", "암호화폐", "K-뷰티", "클라우드", "메타버스" 중 적합한 것
7. 여러 건이면 배열로. 해당 사실 없으면 빈 배열

다음 JSON만 반환 (다른 텍스트 없이):
{
  "extractions": [
    {
      "investor_ticker": "017670.KS",
      "investor_name": "SK텔레콤",
      "target_name": "Anthropic",
      "theme": "AI",
      "detail": "추가 라운드 참여 — 한국 내 Claude 독점 파트너십",
      "stake_info": "$100M",
      "confidence": 85,
      "highlight": true
    }
  ]
}

confidence 가이드:
- 90+: 보도자료 수준 명시 사실
- 70-89: 본문에서 명확히 언급
- 50-69: 행간에 암시되나 확실
- 50 미만은 추출 금지

highlight=true 조건:
- 핵심 사업과의 강한 연결 (예: SKT-Anthropic, 현대차-Boston Dynamics)
- 단순 소수 지분은 false`;

      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = msg.content[0].text.trim();
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) { results.skipped++; continue; }
      const parsed = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
      const list = Array.isArray(parsed.extractions) ? parsed.extractions : [];
      if (!list.length) { results.skipped++; continue; }

      for (const ex of list) {
        if (!ex.investor_ticker || !ex.target_name || !ex.theme || !ex.detail) continue;
        if (typeof ex.confidence === 'number' && ex.confidence < 60) continue;

        results.extracted++;
        const ticker = ex.investor_ticker.toUpperCase().trim();
        const target = ex.target_name.trim();

        // 기존 항목 있는지 확인 (UNIQUE constraint 활용)
        const { data: existing } = await supabase
          .from('strategic_investments')
          .select('id, seen_count, confidence')
          .eq('investor_ticker', ticker)
          .eq('target_name', target)
          .maybeSingle();

        let investmentId = existing?.id;
        let eventType = null;

        if (existing) {
          // 재등장 → seen_count++ + last_seen + confidence 평균
          const newConf = Math.round(((existing.confidence || 70) + (ex.confidence || 70)) / 2);
          await supabase.from('strategic_investments')
            .update({
              seen_count:   (existing.seen_count || 1) + 1,
              last_seen_at: new Date().toISOString(),
              confidence:   newConf,
            })
            .eq('id', existing.id);
          results.updated++;
          eventType = 'reextracted';
        } else {
          // 신규 삽입
          const { data: inserted, error: insErr } = await supabase.from('strategic_investments').insert({
            investor_ticker: ticker,
            investor_name:   ex.investor_name || null,
            target_name:     target,
            theme:           ex.theme,
            detail:          ex.detail.slice(0, 500),
            stake_info:      ex.stake_info ? String(ex.stake_info).slice(0, 80) : null,
            highlight:       !!ex.highlight,
            confidence:      ex.confidence || 70,
            source_issue_id: issue.id,
            source_url:      issue.source_url || null,
            source_title:    issue.title?.slice(0, 300) || null,
          }).select('id').single();
          if (!insErr) {
            results.new++;
            investmentId = inserted?.id;
            eventType = 'extracted';
          }
        }

        // 이벤트 로그 (그래프용)
        if (investmentId && eventType) {
          await supabase.from('strategic_investment_events').insert({
            investment_id:   investmentId,
            investor_ticker: ticker,
            target_name:     target,
            event_type:      eventType,
            confidence:      ex.confidence || 70,
            source_issue_id: issue.id,
            source_url:      issue.source_url || null,
          });
        }
      }
    } catch (e) {
      results.errors.push({ issue_id: issue.id, error: e.message?.slice(0, 200) });
    }
  }

  return res.status(200).json({ ok: true, ...results, ts: new Date().toISOString() });
}

// ════════════════════════════════════════════════════════════
// 6) 전략투자 목록 조회 (admin UI)
// ════════════════════════════════════════════════════════════
async function handleListInvestments(req, res) {
  const status   = (req.query?.status || 'active').toString();
  const ticker   = (req.query?.ticker || '').toString().toUpperCase().trim();
  const theme    = (req.query?.theme || '').toString().trim();
  const search   = (req.query?.q || '').toString().trim();
  const page     = Math.max(1, parseInt(req.query?.page || 1, 10));
  const pageSize = Math.min(100, parseInt(req.query?.page_size || 50, 10));

  let q = supabase.from('strategic_investments')
    .select('id, investor_ticker, investor_name, target_name, theme, detail, stake_info, highlight, confidence, seen_count, source_issue_id, source_url, source_title, status, extracted_at, last_seen_at', { count: 'exact' })
    .order('highlight', { ascending: false })
    .order('seen_count', { ascending: false })
    .order('extracted_at', { ascending: false });

  if (status !== 'all') q = q.eq('status', status);
  if (ticker)           q = q.eq('investor_ticker', ticker);
  if (theme)            q = q.ilike('theme', `%${theme}%`);
  if (search)           q = q.or(`investor_name.ilike.%${search}%,target_name.ilike.%${search}%,detail.ilike.%${search}%`);

  const { data, count, error } = await q.range((page - 1) * pageSize, page * pageSize - 1);
  if (error) return res.status(500).json({ error: error.message });

  // 티커별 그룹 카운트 (요약용)
  const { data: byTicker } = await supabase
    .from('strategic_investments')
    .select('investor_ticker, investor_name')
    .eq('status', 'active');
  const tickerCounts = {};
  for (const row of (byTicker || [])) {
    const k = row.investor_ticker;
    if (!tickerCounts[k]) tickerCounts[k] = { ticker: k, name: row.investor_name, count: 0 };
    tickerCounts[k].count++;
  }
  const topTickers = Object.values(tickerCounts).sort((a, b) => b.count - a.count).slice(0, 20);

  return res.status(200).json({ ok: true, items: data || [], total: count || 0, page, pageSize, topTickers });
}

// ════════════════════════════════════════════════════════════
// 7) 전략투자 수정 (highlight / status / detail)
// ════════════════════════════════════════════════════════════
async function handleUpdateInvestment(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = parseInt(req.body?.id, 10);
  if (!id) return res.status(400).json({ error: 'id required' });

  const update = {};
  if (typeof req.body?.highlight === 'boolean') update.highlight = req.body.highlight;
  if (typeof req.body?.status === 'string')     update.status = req.body.status;
  if (typeof req.body?.detail === 'string')     update.detail = req.body.detail.slice(0, 500);
  if (typeof req.body?.theme === 'string')      update.theme = req.body.theme.slice(0, 80);
  if (typeof req.body?.stake_info === 'string') update.stake_info = req.body.stake_info.slice(0, 80);
  if (typeof req.body?.confidence === 'number') update.confidence = Math.max(0, Math.min(100, req.body.confidence));
  if (!Object.keys(update).length) return res.status(400).json({ error: 'no fields to update' });

  const { data, error } = await supabase
    .from('strategic_investments')
    .update(update).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  let evType = null;
  if (update.status === 'rejected') evType = 'rejected';
  else if (update.status === 'active' && req.body?._from_pending) evType = 'approved';
  if (evType) {
    await supabase.from('strategic_investment_events').insert({
      investment_id: id, investor_ticker: data.investor_ticker,
      target_name: data.target_name, event_type: evType, confidence: data.confidence,
    });
  }
  return res.status(200).json({ ok: true, item: data });
}

// ════════════════════════════════════════════════════════════
// 8) 전략투자 삭제 (소프트=rejected / hard=DELETE)
// ════════════════════════════════════════════════════════════
async function handleDeleteInvestment(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = parseInt(req.body?.id, 10);
  const hard = !!req.body?.hard;
  if (!id) return res.status(400).json({ error: 'id required' });

  if (hard) {
    const { error } = await supabase.from('strategic_investments').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, deleted: 'hard' });
  }
  const { error } = await supabase.from('strategic_investments')
    .update({ status: 'rejected' }).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, deleted: 'soft' });
}

// ════════════════════════════════════════════════════════════
// 9) 전략투자 이벤트 히스토리 (그래프용 — 인증 불필요)
// ════════════════════════════════════════════════════════════
async function handleInvestmentEvents(req, res) {
  const ticker = (req.query?.ticker || '').toString().toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  const { data: events } = await supabase
    .from('strategic_investment_events')
    .select('target_name, event_type, confidence, occurred_at, source_url')
    .eq('investor_ticker', ticker)
    .order('occurred_at', { ascending: true })
    .limit(500);

  const byTarget = {};
  for (const e of (events || [])) {
    if (!byTarget[e.target_name]) byTarget[e.target_name] = [];
    byTarget[e.target_name].push(e);
  }
  const series = Object.entries(byTarget).map(([target, evts]) => ({
    target,
    points: evts.map((e, i) => ({ t: e.occurred_at, cumulative: i + 1, type: e.event_type, confidence: e.confidence })),
  }));

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
  return res.status(200).json({ ok: true, ticker, events: events || [], series });
}

// ════════════════════════════════════════════════════════════
// 10) DART 5%+ 지분공시 폴링 (한국 OpenDart)
// ════════════════════════════════════════════════════════════
async function handleDartPoll(req, res) {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'DART_API_KEY env not set. Get free key at opendart.fss.or.kr' });

  const days = Math.min(30, parseInt(req.body?.days || req.query?.days || 7, 10));
  const begin = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  const end   = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // pblntf_detail_ty=D003: 주식등의 대량보유상황보고서
  const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${apiKey}&bgn_de=${begin}&end_de=${end}&pblntf_detail_ty=D003&page_count=100`;
  let listJson;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    listJson = await r.json();
  } catch (e) {
    return res.status(500).json({ error: 'DART list fetch failed: ' + e.message });
  }
  if (listJson.status && listJson.status !== '000') {
    return res.status(500).json({ error: `DART API: ${listJson.message || listJson.status}` });
  }

  const items = listJson.list || [];
  const results = {
    scanned: items.length, new: 0, updated: 0,
    skippedSelf: 0,        // 자기지분 (보고자 == 대상)
    skippedIndividual: 0,  // 개인 (2-4자 한글이름)
    skippedUnmatched: 0,   // 법인이지만 companies 테이블에 없음
    skippedMissing: 0,
    samples: [], unmatchedReporters: [],
  };

  // 신고자명 정규화
  const normalize = (s) => (s || '')
    .replace(/\(주\)|㈜|주식회사/g, '')
    .replace(/\s+Co\.?,?\s*Ltd\.?$/i, '')
    .replace(/\s+Inc\.?$/i, '')
    .replace(/외\s*\d+\s*인/g, '')
    .replace(/['"\\%_]/g, '')
    .trim();

  // 개인 이름 추정: 한글 2-4자, 회사/리츠/스튜디오/홀딩스/그룹 등 키워드 없음
  const isIndividual = (s) => {
    const t = normalize(s);
    if (!/^[가-힣]{2,4}$/.test(t)) return false;
    // 한글 2-4자 + 단어가 일반적인 회사 키워드 안 포함 → 개인 추정
    if (/리츠|스튜디오|홀딩스|그룹|증권|투자|자산운용|에너지|건설|전자|화학|중공업|제약|바이오|반도체|모터스|텔레콤/.test(t)) return false;
    return true;
  };

  for (const it of items.slice(0, 50)) {
    const reporter = (it.flr_nm || '').trim();
    const target = (it.corp_name || '').trim();
    const targetTicker = (it.stock_code || '').trim();
    if (!reporter || !target || !targetTicker) { results.skippedMissing++; continue; }

    // 자기지분 신고 (보고자 == 대상) — 의미 없음
    const reporterClean = normalize(reporter);
    const targetClean = normalize(target);
    if (reporterClean && targetClean && (reporterClean === targetClean || reporterClean.includes(targetClean) || targetClean.includes(reporterClean))) {
      results.skippedSelf++; continue;
    }

    // 개인 주주 신고 — 우리 목적 (기업→기업)과 무관
    if (isIndividual(reporter)) { results.skippedIndividual++; continue; }

    const cleaned = reporterClean;
    if (!cleaned || cleaned.length < 2) { results.skippedUnmatched++; continue; }

    // 1차: 정규화된 이름으로 매칭 (KR 시장)
    let { data: investorCo } = await supabase
      .from('companies')
      .select('ticker, name_ko, name_en')
      .or(`name_ko.ilike.%${cleaned}%,name_en.ilike.%${cleaned}%`)
      .eq('market', 'KR').limit(1).maybeSingle();

    // 2차: 첫 단어로만 매칭 (예: "한화에어로스페이스 외 1인" → "한화에어로스페이스")
    if (!investorCo?.ticker) {
      const firstToken = cleaned.split(/\s/)[0];
      if (firstToken.length >= 2) {
        const r2 = await supabase
          .from('companies')
          .select('ticker, name_ko, name_en')
          .or(`name_ko.ilike.${firstToken}%,name_en.ilike.${firstToken}%`)
          .eq('market', 'KR').limit(1).maybeSingle();
        investorCo = r2.data;
      }
    }

    if (!investorCo?.ticker) {
      results.skippedUnmatched++;
      if (results.unmatchedReporters.length < 15) {
        results.unmatchedReporters.push(`${reporter} → ${target}(${targetTicker})`);
      }
      continue;
    }

    const detail = `DART 대량보유 신고 — ${reporter}가 ${target} 지분 5%+ 신고`;
    const sourceUrl = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${it.rcept_no}`;
    const { data: existing } = await supabase
      .from('strategic_investments')
      .select('id, seen_count, confidence')
      .eq('investor_ticker', investorCo.ticker)
      .eq('target_name', target).maybeSingle();

    let invId;
    if (existing) {
      await supabase.from('strategic_investments').update({
        seen_count: (existing.seen_count || 1) + 1,
        last_seen_at: new Date().toISOString(),
        confidence: Math.max(existing.confidence || 70, 92),
      }).eq('id', existing.id);
      invId = existing.id; results.updated++;
    } else {
      const { data: ins } = await supabase.from('strategic_investments').insert({
        investor_ticker: investorCo.ticker,
        investor_name: investorCo.name_ko || investorCo.name_en,
        target_name: target, theme: '지분투자 (DART)',
        detail, stake_info: '5%+', highlight: false, confidence: 92,
        source_url: sourceUrl, source_title: it.report_nm, status: 'active',
      }).select('id').single();
      invId = ins?.id; if (invId) results.new++;
    }
    if (invId) {
      await supabase.from('strategic_investment_events').insert({
        investment_id: invId, investor_ticker: investorCo.ticker,
        target_name: target, event_type: 'dart', confidence: 92, source_url: sourceUrl,
      });
    }
    if (results.samples.length < 5) results.samples.push({ reporter, target, targetTicker });
  }
  return res.status(200).json({ ok: true, ...results, period: `${begin} ~ ${end}` });
}

// ════════════════════════════════════════════════════════════
// 11) SEC EDGAR 13F 폴링 (미국 헤지펀드/기관 보유)
// ════════════════════════════════════════════════════════════
// env SEC_13F_FILERS: CIK 콤마 구분 (기본: BRK, BlackRock 등)
async function handleSec13fPoll(req, res) {
  const filersEnv = process.env.SEC_13F_FILERS || '0001067983,0001364742';
  const ciks = filersEnv.split(',').map(s => s.trim().padStart(10, '0')).filter(Boolean).slice(0, 10);
  const ua = `StockRipple/1.0 (${(process.env.ADMIN_EMAILS || 'noreply@example.com').split(',')[0]})`;
  const results = { fetched: 0, new: 0, updated: 0, errors: [] };

  for (const cik of ciks) {
    try {
      const subUrl = `https://data.sec.gov/submissions/CIK${cik}.json`;
      const sr = await fetch(subUrl, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(10000) });
      if (!sr.ok) { results.errors.push(`CIK ${cik}: HTTP ${sr.status}`); continue; }
      const subData = await sr.json();
      const recent = subData.filings?.recent;
      if (!recent) continue;

      let acc = null;
      const filerName = subData.name || `CIK ${cik}`;
      for (let i = 0; i < (recent.form || []).length; i++) {
        if (recent.form[i] === '13F-HR') { acc = recent.accessionNumber[i].replace(/-/g, ''); break; }
      }
      if (!acc) { results.errors.push(`${filerName}: no 13F-HR`); continue; }

      const filingsUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${acc}/`;
      const idx = await fetch(filingsUrl + 'index.json', { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(10000) });
      if (!idx.ok) continue;
      const idxJson = await idx.json();
      const xmlFile = (idxJson.directory?.item || []).find(f => f.name.endsWith('.xml') && f.name.toLowerCase().includes('infotable'));
      if (!xmlFile) { results.errors.push(`${filerName}: no infotable.xml`); continue; }

      const xmlRes = await fetch(filingsUrl + xmlFile.name, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(15000) });
      const xml = await xmlRes.text();
      results.fetched++;

      const blocks = xml.match(/<infoTable>[\s\S]*?<\/infoTable>/g) || [];
      const holdings = blocks.map(b => ({
        name:  (b.match(/<nameOfIssuer>([\s\S]*?)<\/nameOfIssuer>/)?.[1] || '').trim(),
        value: parseInt((b.match(/<value>([\s\S]*?)<\/value>/)?.[1] || '0').replace(/\D/g, ''), 10),
      })).filter(h => h.name && h.value).sort((a, b) => b.value - a.value).slice(0, 10);

      // 매니저(헤지펀드)가 상장사인지 매핑 (Berkshire 등)
      const firstWord = filerName.split(/[\s.,]/)[0].replace(/['"\\%_]/g, '');
      const { data: investorCo } = await supabase.from('companies')
        .select('ticker, name_ko, name_en')
        .or(`name_en.ilike.%${firstWord}%,name_ko.ilike.%${firstWord}%`)
        .limit(1).maybeSingle();
      if (!investorCo?.ticker) { results.errors.push(`${filerName}: not listed in companies`); continue; }

      for (const h of holdings) {
        const detail = `13F 분기공시 — ${filerName} 보유 ($${(h.value / 1000).toFixed(1)}M)`;
        const { data: existing } = await supabase.from('strategic_investments')
          .select('id, seen_count').eq('investor_ticker', investorCo.ticker)
          .eq('target_name', h.name).maybeSingle();
        let invId;
        if (existing) {
          await supabase.from('strategic_investments').update({
            seen_count: (existing.seen_count || 1) + 1,
            last_seen_at: new Date().toISOString(),
            stake_info: `$${(h.value / 1000).toFixed(1)}M`, confidence: 88,
          }).eq('id', existing.id);
          invId = existing.id; results.updated++;
        } else {
          const { data: ins } = await supabase.from('strategic_investments').insert({
            investor_ticker: investorCo.ticker, investor_name: investorCo.name_en || filerName,
            target_name: h.name, theme: '지분투자 (13F)', detail,
            stake_info: `$${(h.value / 1000).toFixed(1)}M`, confidence: 88,
            source_url: filingsUrl + xmlFile.name, source_title: `13F-HR ${filerName}`,
            status: 'active',
          }).select('id').single();
          invId = ins?.id; if (invId) results.new++;
        }
        if (invId) {
          await supabase.from('strategic_investment_events').insert({
            investment_id: invId, investor_ticker: investorCo.ticker,
            target_name: h.name, event_type: 'sec13f', confidence: 88,
            source_url: filingsUrl + xmlFile.name,
          });
        }
      }
    } catch (e) {
      results.errors.push(`CIK ${cik}: ${e.message?.slice(0, 150)}`);
    }
  }
  return res.status(200).json({ ok: true, ...results });
}

// ════════════════════════════════════════════════════════════
// 12) DART corp_code 동기화 (1회 실행 / 종종 갱신)
// ════════════════════════════════════════════════════════════
// DART OpenAPI의 corpCode.xml.zip 다운로드 → 6자리 stock_code → 8자리 corp_code 매핑
// companies 테이블의 KR 종목에 dart_corp_code 채워넣음
async function handleDartSyncCorpCodes(req, res) {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'DART_API_KEY env not set' });

  try {
    const t0 = Date.now();
    const AdmZip = (await import('adm-zip')).default;
    const r = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${apiKey}`, {
      signal: AbortSignal.timeout(40000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/zip, application/octet-stream, */*',
      },
    });
    if (!r.ok) return res.status(500).json({ error: `DART zip HTTP ${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());
    const tFetch = Date.now() - t0;
    const zip = new AdmZip(buf);
    const entry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.xml'));
    if (!entry) return res.status(500).json({ error: 'No XML in DART zip' });
    const xml = entry.getData().toString('utf8');
    const tUnzip = Date.now() - t0 - tFetch;

    // <list><corp_code>...</corp_code><corp_name>...</corp_name><stock_code>...</stock_code><modify_date>...</modify_date></list>
    const lists = xml.match(/<list>[\s\S]*?<\/list>/g) || [];
    const mapping = {};   // stock_code (6자리, .KS 제외) → corp_code (8자리)
    for (const block of lists) {
      const stockCode = (block.match(/<stock_code>([\s\S]*?)<\/stock_code>/)?.[1] || '').trim();
      const corpCode  = (block.match(/<corp_code>([\s\S]*?)<\/corp_code>/)?.[1] || '').trim();
      if (stockCode && /^\d{6}$/.test(stockCode) && corpCode) mapping[stockCode] = corpCode;
    }

    // KR 종목들의 dart_corp_code 업데이트
    const { data: krCompanies } = await supabase
      .from('companies')
      .select('id, ticker, dart_corp_code')
      .eq('market', 'KR');

    // 병렬 업데이트 (10개씩 chunked)
    let updated = 0, alreadySet = 0, notFound = 0;
    const todo = [];
    for (const c of (krCompanies || [])) {
      const stockCode = c.ticker?.replace(/\.(KS|KQ)$/i, '');
      const corpCode = mapping[stockCode];
      if (!corpCode) { notFound++; continue; }
      if (c.dart_corp_code === corpCode) { alreadySet++; continue; }
      todo.push({ id: c.id, corpCode });
    }
    // 10개씩 batched parallel update
    for (let i = 0; i < todo.length; i += 10) {
      const batch = todo.slice(i, i + 10);
      await Promise.all(batch.map(async t => {
        const { error } = await supabase.from('companies').update({ dart_corp_code: t.corpCode }).eq('id', t.id);
        if (!error) updated++;
      }));
    }
    const tTotal = Date.now() - t0;

    return res.status(200).json({
      ok: true,
      total_kr_companies: (krCompanies || []).length,
      mapping_size: Object.keys(mapping).length,
      updated, alreadySet, notFound,
      timing: { fetch_ms: tFetch, unzip_parse_ms: tUnzip, total_ms: tTotal },
    });
  } catch (e) {
    return res.status(500).json({ error: 'DART sync failed: ' + e.message });
  }
}

// ════════════════════════════════════════════════════════════
// 13) DART 회사 상세 (주주/임원/재무) — 24h 캐시
// ════════════════════════════════════════════════════════════
async function handleDartCompanyDetail(req, res) {
  const apiKey = process.env.DART_API_KEY;
  const ticker = (req.query?.ticker || '').toString().trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  if (!apiKey) return res.status(500).json({ error: 'DART_API_KEY env not set' });
  if (!/\.K[SQ]$/i.test(ticker)) return res.status(400).json({ error: 'KR ticker only (.KS/.KQ)' });

  // 1. companies에서 corp_code 조회
  const { data: company } = await supabase
    .from('companies').select('dart_corp_code, name_ko, ticker')
    .eq('ticker', ticker).maybeSingle();
  const corpCode = company?.dart_corp_code;
  if (!corpCode) {
    return res.status(404).json({ error: 'dart_corp_code not synced. Run ?action=dart-sync-corp-codes first.' });
  }

  // 2. 24h 캐시 확인
  const { data: cached } = await supabase
    .from('dart_company_cache').select('*').eq('corp_code', corpCode).maybeSingle();
  if (cached && (Date.now() - new Date(cached.updated_at).getTime()) < 86400 * 1000) {
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ ok: true, cached: true, ...cached });
  }

  // 3. 최근 사업보고서 연도 (작년 또는 재작년)
  const now = new Date();
  // 사업보고서는 보통 3월말~4월초 공시. 5월 이후라면 작년, 그 이전이면 재작년
  const bsnsYear = (now.getMonth() >= 4 ? now.getFullYear() - 1 : now.getFullYear() - 2).toString();
  const reprtCode = '11011'; // 사업보고서

  const dartFetch = async (endpoint, extra = {}) => {
    const params = new URLSearchParams({
      crtfc_key: apiKey, corp_code: corpCode, bsns_year: bsnsYear, reprt_code: reprtCode, ...extra,
    });
    try {
      const r = await fetch(`https://opendart.fss.or.kr/api/${endpoint}?${params.toString()}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return null;
      const j = await r.json();
      if (j.status !== '000' && j.status !== '013') return null;  // 013: 조회결과 없음
      return j.list || [];
    } catch { return null; }
  };

  // 4. 4개 엔드포인트 병렬 호출
  const [majorHolders, shareholders, officers, financials] = await Promise.all([
    dartFetch('hyslrSttus.json'),       // 임원·주요주주 소유주식 변동
    dartFetch('mrhlSttus.json'),        // 최대주주 현황
    dartFetch('exctvSttus.json'),       // 임원 현황
    dartFetch('fnlttSinglAcntAll.json', { fs_div: 'CFS' }), // 연결재무제표 전체
  ]);

  // 재무는 최근 3년 추이도 가져오자 (작년/재작년)
  const yearsBack = [];
  for (let i = 0; i < 3; i++) {
    const y = (parseInt(bsnsYear, 10) - i).toString();
    yearsBack.push(y);
  }
  const financialsByYear = {};
  await Promise.all(yearsBack.map(async (y) => {
    const params = new URLSearchParams({
      crtfc_key: apiKey, corp_code: corpCode, bsns_year: y, reprt_code: '11011', fs_div: 'CFS',
    });
    try {
      const r = await fetch(`https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?${params.toString()}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return;
      const j = await r.json();
      if (j.status === '000') financialsByYear[y] = j.list;
    } catch {}
  }));

  // 5. 핵심 재무지표만 추출 (매출액, 영업이익, 당기순이익, 자산총계, 부채총계)
  const extractMetrics = (rows) => {
    if (!Array.isArray(rows)) return null;
    const find = (keywords) => {
      for (const row of rows) {
        const name = (row.account_nm || '').replace(/\s/g, '');
        if (keywords.some(k => name.includes(k))) {
          const v = parseFloat((row.thstrm_amount || '0').replace(/,/g, ''));
          return isNaN(v) ? null : v;
        }
      }
      return null;
    };
    return {
      revenue:   find(['매출액', '수익(매출액)', '영업수익']),
      opIncome:  find(['영업이익', '영업손실']),
      netIncome: find(['당기순이익', '당기순손실']),
      assets:    find(['자산총계']),
      liabilities: find(['부채총계']),
      equity:    find(['자본총계']),
    };
  };
  const annualFinancials = Object.fromEntries(
    Object.entries(financialsByYear).map(([y, rows]) => [y, extractMetrics(rows)])
  );

  // 6. 캐시에 저장
  const cacheRow = {
    corp_code: corpCode, ticker,
    major_holders: majorHolders || [],
    shareholders: shareholders || [],
    officers: officers || [],
    financials: annualFinancials,
    treasury_stock: null,   // 추후 추가
    updated_at: new Date().toISOString(),
  };
  await supabase.from('dart_company_cache').upsert(cacheRow, { onConflict: 'corp_code' });

  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({ ok: true, cached: false, ...cacheRow });
}

// ════════════════════════════════════════════════════════════
// 14) DART corp_code 수동 업로드 (CSV 페이스트)
// ════════════════════════════════════════════════════════════
// Vercel ↔ 한국 네트워크가 느려 자동 다운로드 timeout 시 사용
// body: { csv: "005930,00126380\n000660,00164779\n..." } 또는 { mapping: { "005930": "00126380", ... } }
async function handleDartUploadCorpCodes(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let mapping = {};
  if (req.body?.mapping && typeof req.body.mapping === 'object') {
    mapping = req.body.mapping;
  } else if (typeof req.body?.csv === 'string') {
    for (const line of req.body.csv.split(/\r?\n/)) {
      const m = line.match(/(\d{6})\s*[,;\t|]\s*(\d{8})/);
      if (m) mapping[m[1]] = m[2];
    }
  } else {
    return res.status(400).json({ error: 'Provide body.csv (text) or body.mapping (object)' });
  }
  const mappingSize = Object.keys(mapping).length;
  if (!mappingSize) return res.status(400).json({ error: 'No valid stock_code,corp_code pairs found' });

  const { data: krCompanies } = await supabase
    .from('companies').select('id, ticker, dart_corp_code').eq('market', 'KR');

  let updated = 0, alreadySet = 0, notFound = 0;
  const todo = [];
  for (const c of (krCompanies || [])) {
    const stockCode = c.ticker?.replace(/\.(KS|KQ)$/i, '');
    const corpCode = mapping[stockCode];
    if (!corpCode) { notFound++; continue; }
    if (c.dart_corp_code === corpCode) { alreadySet++; continue; }
    todo.push({ id: c.id, corpCode });
  }
  for (let i = 0; i < todo.length; i += 20) {
    await Promise.all(todo.slice(i, i + 20).map(async t => {
      const { error } = await supabase.from('companies').update({ dart_corp_code: t.corpCode }).eq('id', t.id);
      if (!error) updated++;
    }));
  }

  return res.status(200).json({
    ok: true,
    total_kr_companies: (krCompanies || []).length,
    mapping_size: mappingSize,
    updated, alreadySet, notFound,
  });
}

// ════════════════════════════════════════════════════════════
// 15) KR 종목명 일괄 검증 (DART 공식 회사명 vs DB 이름 대조)
// ════════════════════════════════════════════════════════════
// 우리 companies 테이블의 KR 종목들에 대해, DART에 등록된 공식 corp_name을 가져와서
// name_ko와 다르면 자동 보정. 잘못된 ticker→name 매핑(예: 001200.KS=삼성전기 같은 오류) 해결.
async function handleVerifyKrNames(req, res) {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'DART_API_KEY env not set' });
  const dryRun = req.body?.dry_run === true;

  const { data: krCompanies, error: listErr } = await supabase
    .from('companies')
    .select('id, ticker, name_ko, name_en, dart_corp_code')
    .eq('market', 'KR')
    .not('dart_corp_code', 'is', null);
  if (listErr) return res.status(500).json({ error: listErr.message });

  const results = { scanned: 0, matches: 0, mismatches: 0, fixed: 0, errors: 0, samples: [] };

  // 동시성 8로 제한해서 DART에 너무 많이 안 두드리게
  const CONCURRENCY = 8;
  for (let i = 0; i < krCompanies.length; i += CONCURRENCY) {
    const batch = krCompanies.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (c) => {
      try {
        const url = `https://opendart.fss.or.kr/api/company.json?crtfc_key=${apiKey}&corp_code=${c.dart_corp_code}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) { results.errors++; return; }
        const j = await r.json();
        if (j.status !== '000') { results.errors++; return; }

        results.scanned++;
        const officialName = (j.corp_name || '').trim();
        const officialEn = (j.corp_name_eng || '').trim();
        if (!officialName) return;

        if (officialName === (c.name_ko || '').trim()) {
          results.matches++;
          return;
        }

        // 불일치 발견
        results.mismatches++;
        if (results.samples.length < 30) {
          results.samples.push({
            ticker: c.ticker,
            db_name_ko: c.name_ko,
            db_name_en: c.name_en,
            dart_name_ko: officialName,
            dart_name_en: officialEn,
          });
        }

        if (!dryRun) {
          const update = { name_ko: officialName };
          if (officialEn) update.name_en = officialEn;
          const { error: upErr } = await supabase.from('companies').update(update).eq('id', c.id);
          if (!upErr) results.fixed++;
        }
      } catch { results.errors++; }
    }));
  }

  return res.status(200).json({ ok: true, dry_run: dryRun, ...results });
}
