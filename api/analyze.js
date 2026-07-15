import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';
import { verifyAdmin } from '../lib/auth.js';
import { isFeatureEnabled } from '../lib/feature-flags.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── 속보 감지 → 긴급 안내 배너 자동 트리거 ──────────────────────────────
// 오탐(스팸성 배너)을 피하려고 일상적인 급등/급락이 아니라 드물고 확실히
// 시장 구조에 영향을 주는 이벤트만 좁게 매칭한다. 관리자가 수동으로 켠
// 배너(source='manual')는 절대 건드리지 않는다.
const BREAKING_KEYWORDS = [
  '사이드카', '서킷브레이커', '거래정지', '상장폐지',
  '디폴트', '파산신청', '파산보호',
];
function detectBreakingNews(title) {
  if (!title) return null;
  return BREAKING_KEYWORDS.find(k => title.includes(k)) || null;
}
// 자동 배너 노출 유지 시간 — 서킷브레이커·사이드카 등 이벤트 창을 덮되 하루종일
// 남지 않도록 2시간 뒤 자동 만료. 만료 처리는 handleGetAnnouncement가 조회 시점에
// lazily 수행한다(별도 cron 불필요 — 배너는 매 페이지 로드마다 폴링됨).
const AUTO_ANNOUNCE_TTL_MS = 2 * 3600 * 1000;

async function maybeAutoAnnounce(issue, matchedKeyword) {
  try {
    const { data: cur } = await supabase.from('site_announcement').select('active, source, source_issue_id, auto_expires_at').eq('id', 1).maybeSingle();
    if (cur?.source === 'manual') {
      if (cur.active) return; // 관리자가 켠 배너 보존
      // 관리자가 방금 끈 배너 — checkFuturesSidecar와 동일하게 auto_expires_at을 뮤트
      // 마감시각으로 존중한다(꺼도 바로 다시 켜지던 버그, 2026-07-15).
      if (cur.auto_expires_at && new Date(cur.auto_expires_at) > new Date()) return;
    }
    if (cur?.source === 'auto' && cur?.active && cur?.source_issue_id === issue.id) return; // 같은 이슈로 이미 노출 중

    // 다른 배너가 켜져 있었다면 그 이력 종료 처리 후 새 이력 시작
    await supabase.from('announcement_log').update({ ended_at: new Date().toISOString() }).is('ended_at', null);

    const now = new Date();
    const message = `🚨 [속보] ${issue.title}`.slice(0, 500);
    await supabase.from('site_announcement').upsert({
      id: 1, active: true, message, source: 'auto', source_issue_id: issue.id,
      auto_expires_at: new Date(now.getTime() + AUTO_ANNOUNCE_TTL_MS).toISOString(),
      updated_at: now.toISOString(),
    });
    await supabase.from('announcement_log').insert({
      source: 'auto', message, source_issue_id: issue.id, started_at: now.toISOString(),
    });
  } catch (e) {
    console.error('auto-announce failed:', e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await verifyAdmin(req.headers.authorization);
  if (!auth.ok) return res.status(401).json({ error: auth.error });

  // 배치 모드: analyze-backlog/cron-daily처럼 실시간 응답이 필요 없는 대량 처리 경로.
  // Anthropic Message Batches API로 넘겨 입력 토큰 50% 할인을 추가로 받는다.
  // (live-refresh의 장중 실시간 소량 새로고침은 지연을 감수할 수 없어 기존 동기 경로 그대로 유지)
  const mode = (req.query?.mode || req.body?.mode || '').toString();
  // batch-poll은 게이트와 무관하게 항상 진행 — 이미 제출(과금 완료)된 배치를 방치하면
  // orphan 상태로 영원히 안 끝나므로, 기능이 꺼져 있어도 진행 중인 배치는 끝까지 수거한다.
  if (mode === 'batch-poll') return handleBatchPoll(req, res);

  if (!(await isFeatureEnabled(supabase, 'analyze'))) {
    return res.status(200).json({ ok: true, analyzed: 0, submitted: 0, disabled: true, reason: 'analyze 기능이 꺼져 있습니다' });
  }

  if (mode === 'batch-submit') return handleBatchSubmit(req, res);
  // agent-submit: Anthropic Batches API를 전혀 부르지 않고(과금 없음), 렌더링된 프롬프트만
  // analyze_batches(engine='agent')에 적재. 스케줄 Claude Code 에이전트가 이 큐를 읽어
  // response 컬럼에 답을 써넣으면, 기존 batch-poll(mode=batch-poll)이 그대로 완료 처리한다.
  if (mode === 'agent-submit') return handleBatchSubmit(req, res, { engine: 'agent' });

  const rawBody = req.body || {};
  const issue_id = rawBody.issue_id;
  // Vercel 60초 타임아웃. 2-패스 분석(후보발굴 + 애널리스트 결정)으로 이슈당 ~18초 → 1회 최대 3건
  const HARD_CAP = 3;
  const limit = Math.min(rawBody.limit ?? 5, HARD_CAP);
  const force_recent = Math.min(rawBody.force_recent ?? 0, HARD_CAP);
  // 체이닝: 1회 호출은 5건이 한계지만, 처리 후 스스로를 재호출해 여러 배치를 이어서 처리
  // (각 호출은 새 60초 예산을 받음). 크론(일일 자동)은 기본 4회(20건/일)로 비용 제한.
  // 수동으로 max_chain을 올려서 한 번에 더 큰 배치를 처리할 수 있음 (절대 상한 60회 = 300건).
  const DEFAULT_MAX_CHAIN = 4;
  const ABSOLUTE_MAX_CHAIN = 60;
  const MAX_CHAIN = Math.min(Math.max(parseInt(rawBody.max_chain ?? DEFAULT_MAX_CHAIN, 10) || DEFAULT_MAX_CHAIN, 1), ABSOLUTE_MAX_CHAIN);
  const chainCount = Math.min(Math.max(parseInt(rawBody.chain_count ?? 0, 10) || 0, 0), MAX_CHAIN);

  // 48시간 지난 미분석 이슈는 스킵 처리 — 오래된 뉴스에 "현재가 진입" 분석은 무의미하고 백로그만 쌓임
  // (is_analyzed=true지만 analyses row가 없으므로 피드의 analyses!inner 조인에는 노출되지 않음)
  let staleSkipped = 0;
  {
    const staleCutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const { count } = await supabase
      .from('issues')
      .update({ is_analyzed: true }, { count: 'exact' })
      .eq('is_analyzed', false)
      .lt('published_at', staleCutoff);
    staleSkipped = count || 0;
  }

  // force_recent: 최근 N개 이슈를 무조건 재분석 (기존 분석 삭제 후 재생성)
  let reanalyzed = 0;
  if (force_recent > 0) {
    const { data: recentIssues } = await supabase
      .from('issues')
      .select('id, analyses(id)')
      .order('published_at', { ascending: false })
      .limit(force_recent);

    const analysisIds = (recentIssues || []).flatMap(i => (i.analyses || []).map(a => a.id));
    if (analysisIds.length) {
      // 자식 테이블 먼저 삭제
      await supabase.from('analysis_companies').delete().in('analysis_id', analysisIds);
      await supabase.from('analyses').delete().in('id', analysisIds);
    }
    const ids = (recentIssues || []).map(i => i.id);
    if (ids.length) {
      await supabase.from('issues').update({ is_analyzed: false }).in('id', ids);
      reanalyzed = ids.length;
    }
  }

  let query = supabase.from('issues').select('*').eq('is_analyzed', false);
  if (issue_id) query = supabase.from('issues').select('*').eq('id', issue_id);
  else query = query.order('published_at', { ascending: false }).limit(limit);

  const { data: issues, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  if (!issues?.length) return res.status(200).json({ message: 'No issues to analyze', count: 0, reanalyzed, staleSkipped });

  const results = { analyzed: 0, errors: [], corrections: [], excluded: [], processed: [] };

  // 시간 예산: Vercel maxDuration 60s. 2-패스 분석은 이슈당 ~20초라 한도 초과 시
  // FUNCTION_INVOCATION_TIMEOUT으로 죽으면서 체이닝까지 끊긴다 → 40초 넘으면
  // 남은 이슈를 시작하지 않고 정상 응답 후 체이닝으로 넘긴다.
  const t0 = Date.now();
  const TIME_BUDGET_MS = 40000;
  let timeBudgetHit = false;

  // 시장 레짐 (호출당 1회): 약세 국면이면 매수 게재 기준 상향 — buy-only 시스템 방어
  const regime = await fetchMarketRegime().catch(() => ({ us: 'neutral', kr: 'neutral', vix: null }));

  for (const issue of issues) {
    if (Date.now() - t0 > TIME_BUDGET_MS) {
      timeBudgetHit = true;
      results.errors.push(`시간 예산 초과 — 남은 ${issues.length - results.analyzed}건은 체이닝으로 이월`);
      break;
    }
    const issueStart = Date.now();
    try {
      const analysis = await analyzeIssue(issue);

      // 관련성 낮은 이슈 제거 (비상장 스타트업, 생활경제, 스포츠 등)
      if ((analysis.relevance_score ?? 100) < 40) {
        await supabase.from('issues').delete().eq('id', issue.id);
        results.errors.push(`Irrelevant (score ${analysis.relevance_score}), deleted: "${issue.title?.slice(0, 60)}"`);
        continue;
      }

      // 이전 실행이 타임아웃으로 죽었으면 is_analyzed=false인 채 analyses 행이 남아있을 수 있음
      // → 재분석 시 중복되지 않도록 기존 분석을 지우고 새로 삽입
      const { data: staleAnalyses } = await supabase
        .from('analyses').select('id').eq('issue_id', issue.id);
      if (staleAnalyses?.length) {
        const staleIds = staleAnalyses.map(a => a.id);
        await supabase.from('analysis_companies').delete().in('analysis_id', staleIds);
        await supabase.from('analyses').delete().in('id', staleIds);
      }

      const { data: savedAnalysis, error: analysisErr } = await supabase
        .from('analyses')
        .insert({
          issue_id: issue.id,
          direct_sectors: analysis.directSectors || [],
          ripple_effects: analysis.rippleEffects || [],
          ai_summary: analysis.summary,
          confidence_score: analysis.confidence_score || 50,
        })
        .select()
        .single();

      if (analysisErr) throw new Error(analysisErr.message);

      // ── 1단계: 후보 티커 검증/교정 + 시장 데이터 수집 (병렬) ──
      const { uniqCandidates, errors: cErrors, corrections: cCorrections } = await enrichCandidates(analysis);
      results.errors.push(...cErrors);
      results.corrections.push(...cCorrections);

      let pickedTickers = [];
      if (uniqCandidates.length) {
        const histMap = await fetchTickerAccuracyHistory(uniqCandidates.map(c => c.co.ticker));

        // ── 2단계: 애널리스트 패스 — 실제 시장 데이터를 보고 매수/제외 결정 ──
        const decisions = await decideTrades(issue, analysis, uniqCandidates, regime);
        const { pickedTickers: picked, excluded } = await finalizeIssueDecisions({
          analysisId: savedAnalysis.id, candidates: uniqCandidates, decisions, regime, histMap,
        });
        pickedTickers = picked;
        results.excluded.push(...excluded);
      }

      await finalizeIssueCompletion({ issue, analysis, pickedTickers, req });

      results.analyzed++;
      results.processed.push({
        title: issue.title?.slice(0, 80) || '(제목 없음)',
        companies: pickedTickers.slice(0, 8),
        duration_ms: Date.now() - issueStart,
        relevance: analysis.relevance_score,
      });

      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      results.errors.push(`Issue "${issue.title?.slice(0, 50)}": ${err.message}`);
    }
  }

  // 이번 배치가 꽉 찼거나(=limit만큼 처리) 시간 예산으로 중단했다면 백로그가 남아있을
  // 가능성이 높음 → 다음 배치를 이어서 트리거. waitUntil로 감싸서 res.json() 응답 이후에도
  // 이 요청이 실제로 전송될 때까지 함수 인스턴스가 살아있도록 보장
  if (!issue_id && (issues.length === limit || timeBudgetHit) && chainCount < MAX_CHAIN - 1) {
    waitUntil(triggerNextChain(req, limit, chainCount + 1, MAX_CHAIN));
  }

  return res.status(200).json({ ...results, reanalyzed, staleSkipped, timeBudgetHit, chainCount, maxChain: MAX_CHAIN });
}

// ── 1단계: 후보 티커 검증/교정 + 시장 데이터 수집 (병렬) ──────────────────
// 동기 경로(handler)와 배치 경로(finalizeDiscoverStage) 양쪽에서 공유.
async function enrichCandidates(analysis) {
  const errors = [];
  const corrections = [];
  const allCompanyTasks = [];
  for (const ripple of analysis.rippleEffects || []) {
    for (const co of ripple.companies || []) {
      allCompanyTasks.push({ ripple, co });
    }
  }
  const candidates = [];

  await Promise.all(allCompanyTasks.map(async ({ ripple, co }) => {
    let valid = await validateTicker(co.ticker);
    if (!valid) {
      errors.push(`Invalid ticker skipped: ${co.ticker} (${co.name_ko})`);
      return;
    }

    // 티커 실존 ≠ 회사 일치. AI가 "삼성전자" 의도로 000810.KS(삼성화재)를 주는 환각 차단
    if (!namesMatch(co, valid.longName)) {
      const resolved = await resolveTickerByName(co);
      if (!resolved) {
        errors.push(`Name mismatch skipped: ${co.ticker} "${co.name_en || co.name_ko}" ≠ Yahoo "${valid.longName || '?'}"`);
        return;
      }
      if (resolved !== co.ticker) {
        const revalid = await validateTicker(resolved);
        if (!revalid) {
          errors.push(`Name mismatch skipped: ${co.ticker} "${co.name_en || co.name_ko}" (교정 후보 ${resolved} 시세 조회 실패)`);
          return;
        }
        corrections.push(`${co.ticker} → ${resolved} ("${co.name_en || co.name_ko}", Yahoo: ${revalid.longName || '?'})`);
        co.ticker = resolved;
        valid = revalid;
      }
      // resolved === co.ticker 이면 검색 결과가 AI 티커를 확인해준 것 (음역 등으로 토큰 비교만 실패한 케이스)
    }

    const [stats, fund] = await Promise.all([
      fetchPriceStats(co.ticker),
      fetchFundamentals(co.ticker),
    ]);
    candidates.push({ ripple, co, valid, stats, fund, fundScore: scoreFundamentals(fund) });
  }));

  // 티커 교정으로 같은 종목이 중복될 수 있음 → 첫 후보만 유지
  const seenTickers = new Set();
  const uniqCandidates = candidates.filter(c => {
    const t = c.co.ticker.toUpperCase();
    if (seenTickers.has(t)) return false;
    seenTickers.add(t);
    return true;
  });
  return { uniqCandidates, errors, corrections };
}

// 자기 적중률 피드백: 이 티커들의 과거 7일 검증 이력 (시스템이 자기 실적에서 학습)
async function fetchTickerAccuracyHistory(tickers) {
  const histMap = {};
  if (!tickers.length) return histMap;
  try {
    const { data: hist } = await supabase
      .from('analysis_companies')
      .select('is_accurate_7d, companies!inner(ticker)')
      .in('companies.ticker', tickers)
      .not('is_accurate_7d', 'is', null)
      .limit(500);
    for (const h of hist || []) {
      const t = h.companies?.ticker;
      if (!t) continue;
      const m = (histMap[t] ||= { n: 0, hit: 0 });
      m.n++;
      if (h.is_accurate_7d) m.hit++;
    }
  } catch {}
  return histMap;
}

// ── 2단계 결과 반영: 게재 게이트 + 스코어링 + analysis_companies 저장 ──────
// 동기 경로와 배치 경로(finalizeDecideStage) 양쪽에서 공유.
async function finalizeIssueDecisions({ analysisId, candidates, decisions, regime, histMap }) {
  const pickedTickers = [];
  const excluded = [];

  for (const cand of candidates) {
    const t = cand.co.ticker.toUpperCase();
    const d = decisions[t];
    const s = cand.stats;

    if (!d || d.action !== 'buy') {
      excluded.push(`${cand.co.ticker}: ${d?.exclude_reason || '애널리스트 패스 제외'}`);
      continue;
    }
    // 하드 필터: 차트가 명백히 반대인 종목은 AI 판단과 무관하게 차단
    if (s && ((s.ret1m != null && s.ret1m < -10 && s.aboveSma50 === false) || s.signal === 'strong_bearish')) {
      excluded.push(`${cand.co.ticker}: 하락 추세 (1M ${s.ret1m}%, 시그널 ${s.signal})`);
      continue;
    }
    if (s?.rsi14 != null && s.rsi14 >= 80) {
      excluded.push(`${cand.co.ticker}: 과열 (RSI ${s.rsi14}) — 추격 매수 금지`);
      continue;
    }

    clampTrade(d, s);
    const momScore = scoreTechnicals(s);

    // 자기 적중률 피드백: 4회 이상 검증된 종목의 과거 성적을 점수에 반영
    let trackAdj = 0, trackNote = '';
    const h = histMap[cand.co.ticker];
    if (h && h.n >= 4) {
      const rate = h.hit / h.n;
      if (rate < 0.3) { trackAdj = -10; trackNote = `과거 적중 ${h.hit}/${h.n}`; }
      else if (rate >= 0.6) trackAdj = 5;
    }

    let composite = (d.confidence ?? 50) + (cand.fundScore ?? 0) + momScore + trackAdj;
    composite = Math.max(0, Math.min(100, Math.round(composite)));

    // 게재 게이트: 기본 60점, 해당 시장이 약세 레짐이면 70점으로 상향 (소수 정예)
    const mkt = (cand.co.market === 'KR' || /\.K[SQ]$/i.test(cand.co.ticker)) ? regime.kr : regime.us;
    const gateMin = mkt === 'bear' ? 70 : 60;
    if (composite < gateMin) {
      excluded.push(`${cand.co.ticker}: 종합점수 ${composite} < ${gateMin}${mkt === 'bear' ? ' (약세장 상향)' : ''} (AI ${d.confidence ?? 50}, 펀더 ${cand.fundScore ?? '-'}, 모멘텀 ${momScore}${trackNote ? ', ' + trackNote : ''})`);
      continue;
    }

    const companyId = await upsertCompany(cand.co, cand.valid);

    const tradeMeta = {
      elp: d.entry_low_pct, ehp: d.entry_high_pct,
      tp:  d.upside_pct,    sl:  d.stop_loss_pct,
      tf:  d.time_frame,    th:  d.key_thesis,    rk: d.key_risk,
    };
    const cleanMeta = Object.fromEntries(
      Object.entries(tradeMeta).filter(([_, v]) => v != null && v !== '')
    );
    const fund = cand.fund;
    const fundMeta = (fund || s) ? {
      ...(fund ? {
        pe: fund.pe, pb: fund.pb, roe: fund.roe,
        opm: fund.operatingMargin, de: fund.debtToEquity, cr: fund.currentRatio,
        rev_yoy: fund.revenueGrowthYoY, ni_yoy: fund.netIncomeGrowthYoY,
      } : {}),
      ...(s ? {
        mom1m: s.ret1m, mom3m: s.ret3m, atrm: s.atrMonthPct,
        ma50: s.aboveSma50 ? 1 : 0, ma200: s.aboveSma200 ? 1 : 0,
        rsi: s.rsi14, sig: s.signal, volr: s.volRatio,
        macd: s.macdHistPct != null ? (s.macdHistPct > 0 ? 1 : -1) : null,
        hi52: s.pctFrom52wHigh,
      } : {}),
      score: cand.fundScore, moms: momScore,
    } : null;

    let enrichedRationale = cand.co.rationale || d.key_thesis || '';
    if (Object.keys(cleanMeta).length) enrichedRationale += `\n\n[TRADE]${JSON.stringify(cleanMeta)}`;
    if (fundMeta) enrichedRationale += `\n\n[FUND]${JSON.stringify(fundMeta)}`;

    await supabase.from('analysis_companies').insert({
      analysis_id: analysisId,
      company_id: companyId,
      ripple_sector: cand.ripple.sector,
      rationale: enrichedRationale,
      upside_pct: d.upside_pct,
      confidence: composite,
      entry_price: cand.valid.price,
      entry_date: new Date().toISOString(),
    });
    pickedTickers.push(`${cand.co.ticker}(${composite}%)`);
  }

  return { pickedTickers, excluded };
}

// ── 이슈 완료 처리: 섹터 역태깅 + is_analyzed 마킹 + 속보 배너 + 텔레그램 알림 ──
// 동기 경로와 배치 경로(uniqCandidates 없는 경우 포함) 양쪽에서 공유.
async function finalizeIssueCompletion({ issue, analysis, pickedTickers, req }) {
  // AI가 판정한 섹터를 표준 태그로 변환해 이슈에 역태깅 — 피드 고정 태그('글로벌, 주식')만으로는
  // 프론트의 카테고리 탭/섹터 칩(sectors 배열 contains 검색)에 잡히지 않는 문제 해결
  const derivedTags = deriveSectorTags(issue, analysis);
  const mergedSectors = Array.from(new Set([...(issue.sectors || []), ...derivedTags]));
  await supabase.from('issues').update({ is_analyzed: true, sectors: mergedSectors }).eq('id', issue.id);

  const breakingKeyword = detectBreakingNews(issue.title);
  if (breakingKeyword) await maybeAutoAnnounce(issue, breakingKeyword);

  const tickers = pickedTickers.slice(0, 5).join(', ');
  await sendNotify(
    `📊 <b>StockRipple 새 분석</b>\n${issue.title}\n\n게재 종목: ${tickers || '— (전원 제외)'}\n신뢰도: ${analysis.confidence_score || 50}%`,
    req
  ).catch(() => {});
}

function triggerNextChain(req, limit, nextChainCount, maxChain) {
  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `https://${req.headers.host}`;
  // 다음 배치의 완료까지 기다리지 않음 — 요청이 실제로 전달되는 것만 확인하면 충분
  // (짧은 타임아웃으로 waitUntil이 붙잡고 있는 시간을 최소화)
  return fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.ADMIN_SECRET}`,
    },
    body: JSON.stringify({ limit, chain_count: nextChainCount, max_chain: maxChain }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

// ════════════════════════════════════════════════════════════
// 배치 모드 — Anthropic Message Batches API (입력 토큰 50% 추가 할인, 완료까지
// 공식적으로는 최대 24시간 소요될 수 있음). analyze-backlog/cron-daily처럼 응답을
// 실시간으로 기다릴 필요 없는 경로 전용. discover(후보발굴) → decide(애널리스트
// 결정) 2단계를 각각 별도 배치로 제출하고, 폴링으로 완료를 감지해 이어 붙인다.
// (live-refresh의 장중 실시간 소량 새로고침은 지연을 감수할 수 없어 기존 동기
// 경로 그대로 유지 — 이 배치 경로와 별개로 계속 동작)
// ════════════════════════════════════════════════════════════
const BATCH_SUBMIT_LIMIT = 30;
// 안전장치: 배치가 이 시간 안에 안 끝나면 취소하고 그냥 놓아준다 — 이슈는
// is_analyzed=false로 남아있으므로 다음 hourly 크론의 기존 동기 경로가 자연스럽게
// 다시 집어가 처리한다 (하루 종일 안 끝나는 걸 무한정 기다리지 않기 위한 상한).
const BATCH_STUCK_TIMEOUT_MS = 3 * 3600 * 1000;

async function handleBatchSubmit(req, res, opts = {}) {
  const engine = opts.engine === 'agent' ? 'agent' : 'anthropic';
  const limit = Math.min(parseInt(req.body?.limit, 10) || BATCH_SUBMIT_LIMIT, 100);

  // discover/decide 각각 동시에 하나만 진행 — 이전 배치가 안 끝났으면 새로 제출하지 않음.
  // 이 조회 자체가 실패하면(예: analyze_batches 테이블이 아직 마이그레이션 전) 아래에서
  // Anthropic 배치를 만들어놓고 추적 행 insert가 실패해 배치가 고아로 남는 사고를 막기 위해
  // 여기서 바로 에러 반환 — 실제 배치 생성(비용 발생) 이전에 걸러낸다.
  // anthropic/agent 엔진은 서로 다른 큐이므로 in-flight 체크도 엔진별로 분리한다.
  const { data: inflight, error: inflightErr } = await supabase
    .from('analyze_batches').select('id, stage').eq('engine', engine).in('status', ['submitted', 'processing']);
  if (inflightErr) return res.status(500).json({ error: 'analyze_batches table not ready: ' + inflightErr.message });
  if (inflight?.length) {
    return res.status(200).json({ ok: true, submitted: 0, reason: 'batch already in flight', inflight: inflight.map(r => r.stage) });
  }

  // 48시간 지난 미분석 이슈는 스킵 처리 (동기 경로와 동일한 정책)
  const staleCutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const { count: staleSkipped } = await supabase
    .from('issues')
    .update({ is_analyzed: true }, { count: 'exact' })
    .eq('is_analyzed', false)
    .lt('published_at', staleCutoff);

  const { data: issues, error } = await supabase
    .from('issues').select('*').eq('is_analyzed', false)
    .order('published_at', { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  if (!issues?.length) return res.status(200).json({ ok: true, submitted: 0, staleSkipped: staleSkipped || 0 });

  if (engine === 'agent') {
    // Anthropic을 전혀 호출하지 않음 — 렌더링된 프롬프트 전문만 큐에 적재하고 끝.
    // 실제 "추론"은 스케줄 Claude Code 에이전트가 이 행을 읽어 response에 답을 써넣는 방식으로 수행.
    const prompts = [];
    for (const issue of issues) {
      const strategicCtx = await buildStrategicCtx(issue);
      prompts.push({
        issueId: issue.id,
        static: ANALYZE_STATIC_PROMPT,
        dynamic: buildAnalyzeDynamicBlock(issue, strategicCtx),
      });
    }
    const { error: insertErr } = await supabase.from('analyze_batches').insert({
      engine: 'agent',
      stage: 'discover',
      status: 'submitted',
      payload: { issueIds: issues.map(i => i.id) },
      prompts,
    });
    if (insertErr) return res.status(500).json({ error: 'failed to save agent queue row: ' + insertErr.message });
    return res.status(200).json({ ok: true, submitted: issues.length, engine: 'agent', staleSkipped: staleSkipped || 0 });
  }

  const requests = [];
  for (const issue of issues) {
    const strategicCtx = await buildStrategicCtx(issue);
    requests.push({
      custom_id: issue.id,
      params: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: ANALYZE_STATIC_PROMPT, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: buildAnalyzeDynamicBlock(issue, strategicCtx) },
          ],
        }],
      },
    });
  }

  const batch = await anthropic.messages.batches.create({ requests });
  const { error: insertErr } = await supabase.from('analyze_batches').insert({
    anthropic_batch_id: batch.id,
    engine: 'anthropic',
    stage: 'discover',
    status: 'submitted',
    payload: { issueIds: issues.map(i => i.id) },
  });
  if (insertErr) {
    // 추적 행이 없으면 이 배치는 영원히 폴링되지 않아 비용만 나가고 버려짐 — 즉시 취소 시도
    try { await anthropic.messages.batches.cancel(batch.id); } catch {}
    return res.status(500).json({ error: 'failed to save batch tracking row, cancelled batch: ' + insertErr.message });
  }

  return res.status(200).json({ ok: true, submitted: issues.length, batchId: batch.id, staleSkipped: staleSkipped || 0 });
}

async function handleBatchPoll(req, res) {
  const { data: rows } = await supabase.from('analyze_batches').select('*').eq('status', 'submitted').order('created_at', { ascending: true });
  if (!rows?.length) return res.status(200).json({ ok: true, checked: 0 });

  const outcomes = [];
  for (const row of rows) {
    try {
      outcomes.push(await processBatchRow(row, req));
    } catch (e) {
      outcomes.push({ id: row.id, stage: row.stage, status: 'error', error: e.message });
    }
  }
  return res.status(200).json({ ok: true, checked: rows.length, outcomes });
}

async function processBatchRow(row, req) {
  const age = Date.now() - new Date(row.created_at).getTime();

  if (row.engine === 'agent') {
    // Anthropic 배치 상태 대신 에이전트가 response 컬럼을 채웠는지로 완료 여부를 판단.
    if (!row.response) {
      if (age > BATCH_STUCK_TIMEOUT_MS) {
        const { data: claimed } = await supabase.from('analyze_batches')
          .update({ status: 'timeout', completed_at: new Date().toISOString() })
          .eq('id', row.id).eq('status', 'submitted').select();
        if (!claimed?.length) return { id: row.id, stage: row.stage, status: 'already_claimed' };
        return { id: row.id, stage: row.stage, status: 'timeout' };
      }
      return { id: row.id, stage: row.stage, status: 'processing' };
    }

    const { data: claimed } = await supabase.from('analyze_batches')
      .update({ status: 'processing' }).eq('id', row.id).eq('status', 'submitted').select();
    if (!claimed?.length) return { id: row.id, stage: row.stage, status: 'already_claimed' };

    try {
      const byId = row.response; // { [issueId]: "<raw JSON text the agent wrote>" }
      if (row.stage === 'discover') {
        await finalizeDiscoverStage(row, byId, req);
      } else {
        await finalizeDecideStage(row, byId, req);
      }
      await supabase.from('analyze_batches').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', row.id);
      return { id: row.id, stage: row.stage, status: 'completed' };
    } catch (e) {
      await supabase.from('analyze_batches').update({ status: 'submitted' }).eq('id', row.id);
      throw e;
    }
  }

  const batch = await anthropic.messages.batches.retrieve(row.anthropic_batch_id);

  if (batch.processing_status !== 'ended') {
    if (age > BATCH_STUCK_TIMEOUT_MS) {
      const { data: claimed } = await supabase.from('analyze_batches')
        .update({ status: 'timeout', completed_at: new Date().toISOString() })
        .eq('id', row.id).eq('status', 'submitted').select();
      if (!claimed?.length) return { id: row.id, stage: row.stage, status: 'already_claimed' };
      try { await anthropic.messages.batches.cancel(row.anthropic_batch_id); } catch {}
      return { id: row.id, stage: row.stage, status: 'timeout_cancelled' };
    }
    return { id: row.id, stage: row.stage, status: 'processing' };
  }

  // 동시 실행(10분/1시간 폴링이 겹치는 등) 대비 — submitted 상태인 행만 원자적으로 선점해
  // 같은 배치를 두 번 완료 처리(중복 DB insert)하지 않도록 방어
  const { data: claimed } = await supabase.from('analyze_batches')
    .update({ status: 'processing' }).eq('id', row.id).eq('status', 'submitted').select();
  if (!claimed?.length) return { id: row.id, stage: row.stage, status: 'already_claimed' };

  try {
    const lines = await anthropic.messages.batches.results(row.anthropic_batch_id);
    const byId = {};
    for await (const line of lines) byId[line.custom_id] = line;

    if (row.stage === 'discover') {
      await finalizeDiscoverStage(row, byId, req);
    } else {
      await finalizeDecideStage(row, byId, req);
    }

    await supabase.from('analyze_batches').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', row.id);
    return { id: row.id, stage: row.stage, status: 'completed' };
  } catch (e) {
    // 실패 시 submitted로 되돌려 다음 폴링에서 재시도할 수 있게 함
    await supabase.from('analyze_batches').update({ status: 'submitted' }).eq('id', row.id);
    throw e;
  }
}

function extractBatchText(engine, line) {
  if (engine === 'agent') return typeof line === 'string' ? line.trim() : null;
  if (line?.result?.type !== 'succeeded') return null;
  return line.result.message?.content?.[0]?.text?.trim() || null;
}

function parseJsonBlock(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('JSON not found in batch response');
  return parseJsonSafe(m[0]);
}

// discover 배치 완료 처리 — 후보 티커 검증/시장데이터 수집(Claude 불필요, 동기 진행) 후
// 매수 후보가 있는 이슈들만 모아 decide 배치를 새로 제출한다.
async function finalizeDiscoverStage(row, byId, req) {
  const issueIds = row.payload?.issueIds || [];
  const decideItems = [];

  // 시장 레짐은 이 배치 전체에서 1회만 조회 (동기 경로와 동일하게 배치당 하나의 스냅샷 공유)
  const regime = await fetchMarketRegime().catch(() => ({ us: 'neutral', kr: 'neutral', vix: null }));

  for (const issueId of issueIds) {
    try {
      const { data: issue } = await supabase.from('issues').select('*').eq('id', issueId).maybeSingle();
      if (!issue || issue.is_analyzed) continue; // force_recent 등으로 이미 처리/삭제된 경우 스킵

      const text = extractBatchText(row.engine, byId[issueId]);
      if (!text) continue; // 개별 요청 실패 — is_analyzed=false로 남겨 다음 백로그가 재시도

      const analysis = parseJsonBlock(text);

      if ((analysis.relevance_score ?? 100) < 40) {
        await supabase.from('issues').delete().eq('id', issue.id);
        continue;
      }

      const { data: staleAnalyses } = await supabase.from('analyses').select('id').eq('issue_id', issue.id);
      if (staleAnalyses?.length) {
        const staleIds = staleAnalyses.map(a => a.id);
        await supabase.from('analysis_companies').delete().in('analysis_id', staleIds);
        await supabase.from('analyses').delete().in('id', staleIds);
      }

      const { data: savedAnalysis, error: analysisErr } = await supabase
        .from('analyses').insert({
          issue_id: issue.id,
          direct_sectors: analysis.directSectors || [],
          ripple_effects: analysis.rippleEffects || [],
          ai_summary: analysis.summary,
          confidence_score: analysis.confidence_score || 50,
        }).select().single();
      if (analysisErr) throw new Error(analysisErr.message);

      const { uniqCandidates } = await enrichCandidates(analysis);

      if (!uniqCandidates.length) {
        // 매수 후보가 없으면 애널리스트 패스(2단계) 없이 바로 완료 처리
        await finalizeIssueCompletion({ issue, analysis, pickedTickers: [], req });
        continue;
      }

      const histMap = await fetchTickerAccuracyHistory(uniqCandidates.map(c => c.co.ticker));

      decideItems.push({
        issueId: issue.id,
        issueTitle: issue.title,
        issueSummary: issue.summary,
        analysisId: savedAnalysis.id,
        analysis: {
          summary: analysis.summary, directSectors: analysis.directSectors,
          rippleEffects: analysis.rippleEffects, confidence_score: analysis.confidence_score,
        },
        candidates: uniqCandidates,
        histMap, regime,
      });
    } catch (e) {
      console.error(`discover finalize failed for issue ${issueId}:`, e.message);
    }
  }

  if (!decideItems.length) return;

  const decidePayload = {
    items: decideItems.map(item => ({
      issueId: item.issueId, analysisId: item.analysisId, analysis: item.analysis,
      candidates: item.candidates, histMap: item.histMap, regime: item.regime,
    })),
  };

  if (row.engine === 'agent') {
    const prompts = decideItems.map(item => ({
      issueId: item.issueId,
      static: DECIDE_TRADES_STATIC_PROMPT,
      dynamic: buildDecideDynamicBlock(
        { title: item.issueTitle, summary: item.issueSummary },
        item.analysis, item.candidates, item.regime,
      ),
    }));
    const { error: insertErr } = await supabase.from('analyze_batches').insert({
      engine: 'agent',
      stage: 'decide',
      status: 'submitted',
      payload: decidePayload,
      prompts,
    });
    if (insertErr) console.error('failed to save agent decide-stage queue row:', insertErr.message);
    return;
  }

  const requests = decideItems.map(item => ({
    custom_id: item.issueId,
    params: {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: DECIDE_TRADES_STATIC_PROMPT, cache_control: { type: 'ephemeral' } },
          {
            type: 'text',
            text: buildDecideDynamicBlock(
              { title: item.issueTitle, summary: item.issueSummary },
              item.analysis, item.candidates, item.regime,
            ),
          },
        ],
      }],
    },
  }));

  const batch = await anthropic.messages.batches.create({ requests });
  const { error: insertErr } = await supabase.from('analyze_batches').insert({
    anthropic_batch_id: batch.id,
    engine: 'anthropic',
    stage: 'decide',
    status: 'submitted',
    payload: decidePayload,
  });
  if (insertErr) {
    // 추적 행 저장 실패 — 배치를 취소하고, 해당 이슈들은 is_analyzed=false로 남겨두어
    // 다음 discover 사이클이 처음부터 다시 집어가도록 한다 (analyses는 그때 재삭제/재생성됨).
    try { await anthropic.messages.batches.cancel(batch.id); } catch {}
    console.error('failed to save decide-stage batch tracking row, cancelled batch:', insertErr.message);
  }
}

// decide 배치 완료 처리 — 게재 게이트/스코어링/저장까지 마무리
async function finalizeDecideStage(row, byId, req) {
  const items = row.payload?.items || [];
  for (const item of items) {
    try {
      const { data: issue } = await supabase.from('issues').select('*').eq('id', item.issueId).maybeSingle();
      if (!issue || issue.is_analyzed) continue;

      const text = extractBatchText(row.engine, byId[item.issueId]);
      let pickedTickers = [];
      if (text) {
        const parsed = parseJsonBlock(text);
        const decisions = {};
        for (const d of parsed.decisions || []) {
          if (d?.ticker) decisions[d.ticker.toUpperCase()] = d;
        }
        const { pickedTickers: picked } = await finalizeIssueDecisions({
          analysisId: item.analysisId, candidates: item.candidates, decisions,
          regime: item.regime, histMap: item.histMap,
        });
        pickedTickers = picked;
      }
      // text가 없으면(개별 요청 실패) 전원 제외로 완료 처리 — analyses row는 이미 discover
      // 단계에서 저장됐으니 is_analyzed만 마킹해 배치 재시도 루프에 갇히지 않게 한다.
      await finalizeIssueCompletion({ issue, analysis: item.analysis, pickedTickers, req });
    } catch (e) {
      console.error(`decide finalize failed for issue ${item.issueId}:`, e.message);
    }
  }
}

// ─── 표준 섹터 태깅 — 분석 결과(직접·파급 섹터 + 제목)에서 프론트 필터용 태그 추출 ───
// 프론트(index.html)의 카테고리 탭·섹터 칩과 짝을 이루는 태그 집합. 여기에 태그를 추가하면
// index.html의 catFilters / filter-chip도 함께 확인할 것.
const SECTOR_TAG_RULES = [
  ['AI',       /(?:^|[^a-z])ai(?:[^a-z]|$)|인공지능|생성형|llm|챗gpt|chatgpt|claude|copilot|에이전트/i],
  ['반도체',    /반도체|hbm|파운드리|메모리|d램|dram|낸드|nand|웨이퍼|semiconductor|엔비디아|nvidia|gpu|칩(?:[^a-힣]|$)|chip/i],
  ['전기차',    /전기차|테슬라|tesla|자율주행|(?:^|[^a-z])ev(?:[^a-z]|$)|모빌리티/i],
  ['배터리',    /배터리|이차전지|2차전지|양극재|음극재|전고체|리튬|battery/i],
  ['바이오',    /바이오|제약|신약|임상|fda|헬스케어|의료|glp-?1|비만치료|항암|biotech|pharma/i],
  ['에너지',    /에너지|원전|원자력|smr|태양광|풍력|수소|정유|유가|lng|전력|energy|solar|nuclear/i],
  ['핀테크',    /핀테크|결제|송금|fintech|payment/i],
  ['금융',     /금융|은행|보험|증권|금리|연준|fed(?:[^a-z]|$)|중앙은행|채권/i],
  ['크립토',    /암호화폐|비트코인|이더리움|스테이블코인|블록체인|crypto|bitcoin|stablecoin/i],
  ['클라우드',  /클라우드|데이터센터|cloud|aws|azure|saas/i],
  ['로봇',     /로봇|휴머노이드|robot/i],
  ['방산·우주', /방산|국방|미사일|무기|전투기|위성|우주|로켓|발사체|defense|missile|aerospace/i],
  ['게임',     /게임|엔씨소프트|크래프톤|넥슨|넷마블|gaming/i],
  ['엔터',     /엔터테인먼트|k-?팝|아이돌|하이브|콘텐츠|드라마|영화|ott|넷플릭스|스트리밍/i],
  ['소비재',    /소비재|유통|화장품|뷰티|식품|음료|리테일|패션|이커머스/i],
  ['자동차',    /자동차|현대차|기아|완성차|(?:^|[^a-z])oem(?:[^a-z]|$)/i],
  ['물류·운송', /물류|해운|운송|항공|운임|공급망|logistics|shipping/i],
];

function deriveSectorTags(issue, analysis) {
  const hay = [
    issue.title || '',
    ...(analysis.directSectors || []),
    ...((analysis.rippleEffects || []).map(r => r.sector || '')),
  ].join(' ');
  const tags = [];
  for (const [tag, re] of SECTOR_TAG_RULES) {
    if (re.test(hay)) tags.push(tag);
  }
  return tags;
}

// ─── 티커-회사명 일치 검증 (AI 환각 차단) ────────────────
const NAME_STOP_TOKENS = new Set([
  'inc', 'corp', 'corporation', 'co', 'ltd', 'limited', 'plc', 'ag', 'sa', 'nv',
  'holdings', 'holding', 'group', 'company', 'companies', 'class', 'the', 'and',
]);

function nameTokens(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !NAME_STOP_TOKENS.has(t));
}

function stripKoName(s) {
  return (s || '').replace(/\(주\)|주식회사|㈜/g, '').replace(/[^가-힣a-z0-9]/gi, '').toLowerCase();
}

/**
 * AI가 준 회사명(name_en/name_ko)과 Yahoo 공식명(longName)이 같은 회사인지 판정.
 * false여도 바로 버리지 않고 resolveTickerByName()으로 2차 확인 (음역 차이 등 보수적 처리).
 */
function namesMatch(co, officialName) {
  if (!officialName) return true; // 공식명 없으면 검증 불가 → 통과
  // 공식명이 한국어면 name_ko와 포함 관계 비교 (예: "에스케이하이닉스(주)" vs "SK하이닉스"는 실패 → 검색 폴백)
  if (/[가-힣]/.test(officialName)) {
    const off = stripKoName(officialName);
    const ko = stripKoName(co.name_ko);
    return !!(ko && off && (off.includes(ko) || ko.includes(off)));
  }
  const offT = nameTokens(officialName);
  const aiT = nameTokens(co.name_en);
  if (!offT.length || !aiT.length) return false;
  const offSet = new Set(offT);
  const overlap = aiT.filter(t => offSet.has(t)).length;
  // 짧은 쪽 기준 60% 이상 겹쳐야 동일 회사로 인정
  // "Samsung Electronics" vs "Samsung Fire & Marine Insurance" → 1/2 = 50% → 불일치
  return overlap / Math.min(aiT.length, offT.length) >= 0.6;
}

/**
 * Yahoo 검색으로 회사명 → 티커 역조회.
 * - AI 티커가 검색 결과에 있으면 그대로 반환 (이름 표기 차이였던 것)
 * - 없으면 같은 시장(KR/US)의 최상위 종목으로 교정 티커 반환
 * - 결과 없으면 null (해당 종목 스킵)
 */
async function resolveTickerByName(co) {
  for (const q of [co.name_en, co.name_ko]) {
    if (!q || q.length < 2) continue;
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=6&newsCount=0`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data = await res.json();
      const quotes = (data.quotes || []).filter(x => x.symbol && (!x.quoteType || x.quoteType === 'EQUITY'));
      if (!quotes.length) continue;
      if (quotes.some(x => x.symbol.toUpperCase() === co.ticker.toUpperCase())) return co.ticker;
      const wantKr = co.market === 'KR' || /\.K[SQ]$/i.test(co.ticker);
      // 교정 후보는 정규 시장만: KR은 KOSPI/KOSDAQ, US는 NYSE/NASDAQ 계열 (OTC·해외 2차상장 제외)
      const US_EXCHANGES = new Set(['NYQ', 'NMS', 'NGM', 'NCM', 'NYS', 'NAS', 'ASE', 'PCX', 'BTS']);
      const cand = quotes.find(x => wantKr
        ? /\.K[SQ]$/i.test(x.symbol)
        : US_EXCHANGES.has(x.exchange));
      if (cand) return cand.symbol;
    } catch {}
  }
  return null;
}

// ─── 시장 레짐 판정 — 하락 국면에서는 매수 게재 기준 상향 (buy-only 시스템의 최대 리스크 방어) ───
async function fetchMarketRegime() {
  const get = async (sym) => {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=3mo`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return null;
      const j = await r.json();
      const closes = (j.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(v => v != null);
      if (closes.length < 50) return null;
      const last = closes[closes.length - 1];
      const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
      const ret5d = closes.length > 5 ? ((last - closes[closes.length - 6]) / closes[closes.length - 6]) * 100 : 0;
      return { last, aboveSma50: last > sma50, ret5d };
    } catch { return null; }
  };
  const [us, kr, vixData] = await Promise.all([get('^GSPC'), get('^KS11'), get('^VIX')]);
  const vix = vixData?.last ?? null;
  const regimeOf = (m) => {
    if (!m) return 'neutral';
    let score = 0;
    score += m.aboveSma50 ? 1 : -1;
    if (m.ret5d < -2) score -= 1; else if (m.ret5d > 0) score += 1;
    if (vix != null) { if (vix >= 25) score -= 2; else if (vix <= 15) score += 1; }
    return score >= 1 ? 'bull' : score <= -1 ? 'bear' : 'neutral';
  };
  return { us: regimeOf(us), kr: regimeOf(kr), vix, usRet5d: us?.ret5d, krRet5d: kr?.ret5d };
}

// ─── 차트 테크니컬 (추세·모멘텀·수급·변동성) — 애널리스트 패스의 입력 데이터 ────────
async function fetchPriceStats(ticker) {
  try {
    // 1년 일봉: SMA200 + RSI + 52주 고저 계산에 필요
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1y`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000) });
    if (!res.ok) return null;
    const data = await res.json();
    const q = data.chart?.result?.[0]?.indicators?.quote?.[0];
    if (!q?.close) return null;

    // null 봉 제거 (거래정지일 등)
    const bars = [];
    for (let i = 0; i < q.close.length; i++) {
      if (q.close[i] != null && q.high[i] != null && q.low[i] != null) {
        bars.push({ c: q.close[i], h: q.high[i], l: q.low[i], v: q.volume?.[i] ?? null });
      }
    }
    if (bars.length < 30) return null;

    const closes = bars.map(b => b.c);
    const last = closes[closes.length - 1];
    const r = (n) => bars.length > n ? Math.round(((last - closes[closes.length - 1 - n]) / closes[closes.length - 1 - n]) * 1000) / 10 : null;
    const sma = (n) => closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : null;

    // ATR(14)% — 월간 기대 변동폭 ≈ 일간 ATR% × √21
    let trSum = 0, trN = 0;
    for (let i = Math.max(1, bars.length - 14); i < bars.length; i++) {
      const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
      trSum += tr / bars[i].c; trN++;
    }
    const atrDayPct = trN ? (trSum / trN) * 100 : null;

    // RSI(14) — Wilder smoothing
    let rsi14 = null;
    if (closes.length >= 15) {
      let g = 0, l = 0;
      for (let i = 1; i <= 14; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
      let ag = g / 14, al = l / 14;
      for (let i = 15; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        ag = (ag * 13 + (d > 0 ? d : 0)) / 14;
        al = (al * 13 + (d < 0 ? -d : 0)) / 14;
      }
      rsi14 = al === 0 ? 100 : Math.round(100 - 100 / (1 + ag / al));
    }

    // MACD(12,26,9) 히스토그램 — 모멘텀의 방향과 가속/감속
    let macdHistPct = null, macdRising = null;
    if (closes.length >= 40) {
      const emaSeries = (n) => { const k = 2 / (n + 1); let e = closes[0]; const out = [e]; for (let i = 1; i < closes.length; i++) { e = closes[i] * k + e * (1 - k); out.push(e); } return out; };
      const e12 = emaSeries(12), e26 = emaSeries(26);
      const macd = closes.map((_, i) => e12[i] - e26[i]);
      const k9 = 2 / 10; let s9 = macd[0]; const sig = [s9];
      for (let i = 1; i < macd.length; i++) { s9 = macd[i] * k9 + s9 * (1 - k9); sig.push(s9); }
      const h  = macd[macd.length - 1] - sig[sig.length - 1];
      const hp = macd[macd.length - 2] - sig[sig.length - 2];
      macdHistPct = Math.round((h / last) * 1000) / 10;
      macdRising = h > hp;
    }

    // 거래량 비율: 최근 5일 평균 / 20일 평균 (>1.3 = 수급 유입 확증)
    let volRatio = null;
    const vols = bars.map(b => b.v).filter(v => v != null && v > 0);
    if (vols.length >= 20) {
      const a5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const a20 = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
      if (a20 > 0) volRatio = Math.round((a5 / a20) * 100) / 100;
    }

    // 볼린저밴드 %B (20, 2σ): 0=하단, 1=상단
    let bbPctB = null;
    if (closes.length >= 20) {
      const w = closes.slice(-20);
      const m = w.reduce((a, b) => a + b, 0) / 20;
      const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
      if (sd > 0) bbPctB = Math.round(((last - (m - 2 * sd)) / (4 * sd)) * 100) / 100;
    }

    const sma20v = sma(20), sma50v = sma(50), sma200v = sma(200);
    const hi52 = Math.max(...bars.map(b => b.h));
    const lo52 = Math.min(...bars.map(b => b.l));

    // 종합 시그널 (technicals.js와 동일 분류)
    let signal = 'neutral';
    if (sma20v && sma50v && sma200v && last > sma20v && sma20v > sma50v && sma50v > sma200v) {
      signal = rsi14 >= 70 ? 'overbought' : rsi14 <= 30 ? 'oversold_bull' : 'strong_bullish';
    } else if (sma20v && sma50v && sma200v && last < sma20v && sma20v < sma50v && sma50v < sma200v) {
      signal = rsi14 <= 30 ? 'oversold' : 'strong_bearish';
    } else if (sma50v && last > sma50v) {
      signal = rsi14 >= 70 ? 'overbought' : rsi14 <= 30 ? 'oversold_bull' : 'bullish';
    } else if (sma50v && last < sma50v) {
      signal = rsi14 <= 30 ? 'oversold' : 'bearish';
    } else if (rsi14 != null && rsi14 >= 70) signal = 'overbought';
    else if (rsi14 != null && rsi14 <= 30) signal = 'oversold';

    return {
      ret5d: r(5), ret1m: r(21), ret3m: r(63),
      aboveSma20: sma20v != null ? last > sma20v : null,
      aboveSma50: sma50v != null ? last > sma50v : null,
      aboveSma200: sma200v != null ? last > sma200v : null,
      pctFrom52wHigh: hi52 ? Math.round(((last - hi52) / hi52) * 1000) / 10 : null,
      pctFrom52wLow:  lo52 ? Math.round(((last - lo52) / lo52) * 1000) / 10 : null,
      atrMonthPct: atrDayPct != null ? Math.round(atrDayPct * Math.sqrt(21) * 10) / 10 : null,
      rsi14, macdHistPct, macdRising, volRatio, bbPctB, signal,
    };
  } catch { return null; }
}

// 차트 테크니컬 점수 -25 ~ +25 (종합점수 보정용)
function scoreTechnicals(s) {
  if (!s) return 0;
  let sc = 0;
  // 추세 (수익률 + 이평선)
  if (s.ret1m != null) sc += s.ret1m > 5 ? 5 : s.ret1m > 0 ? 3 : s.ret1m < -10 ? -8 : -3;
  if (s.ret3m != null) sc += s.ret3m > 10 ? 4 : s.ret3m > 0 ? 2 : s.ret3m < -20 ? -5 : -2;
  if (s.aboveSma50 != null) sc += s.aboveSma50 ? 3 : -3;
  if (s.aboveSma200 != null) sc += s.aboveSma200 ? 3 : -3;
  // RSI: 45~65 건강한 상승, 과열은 감점, 장기추세 위의 과매도는 기회
  if (s.rsi14 != null) {
    if (s.rsi14 >= 75) sc -= 6;
    else if (s.rsi14 >= 65) sc -= 2;
    else if (s.rsi14 >= 45) sc += 4;
    else if (s.rsi14 >= 35) sc += 1;
    else sc += s.aboveSma200 ? 2 : -4;
  }
  // MACD: 히스토그램 부호 + 가속 방향
  if (s.macdHistPct != null) sc += (s.macdHistPct > 0 ? 2 : -2) + (s.macdRising ? 2 : -1);
  // 거래량 확증: 대량 거래 + 상승 = 수급 유입 / 대량 거래 + 하락 = 투매
  if (s.volRatio != null && s.ret5d != null) {
    if (s.volRatio >= 1.5) sc += s.ret5d > 0 ? 4 : -4;
  }
  return Math.max(-25, Math.min(25, sc));
}

// 목표/손절을 실제 변동성 범위로 강제 (AI가 임의 숫자를 만들어도 여기서 교정)
const TF_FACTOR = { '1w': 0.5, '1m': 1, '3m': 1.7, '6m': 2.4 };
function clampTrade(d, stats) {
  if (!['1w', '1m', '3m', '6m'].includes(d.time_frame)) d.time_frame = '1m';
  const atrM = stats?.atrMonthPct;
  if (atrM && atrM > 0) {
    const base = atrM * (TF_FACTOR[d.time_frame] || 1);   // 해당 기간의 기대 변동폭
    const lo = Math.max(2, base * 0.4), hi = base * 1.6;
    let tp = d.upside_pct;
    if (tp == null || !(tp > 0)) tp = base;
    tp = Math.min(Math.max(tp, lo), hi);
    d.upside_pct = Math.round(tp * 10) / 10;
  } else {
    // 변동성 데이터 없으면 보수적 상한
    let tp = d.upside_pct;
    if (tp == null || !(tp > 0)) tp = 8;
    d.upside_pct = Math.min(tp, 20);
  }
  // 손절: 목표의 40~70% (손익비 1.4~2.5 보장)
  let sl = d.stop_loss_pct;
  if (sl == null || sl >= 0) sl = -(d.upside_pct * 0.5);
  sl = Math.min(Math.max(sl, -(d.upside_pct * 0.7)), -(d.upside_pct * 0.4));
  d.stop_loss_pct = Math.round(sl * 10) / 10;
  // 진입 밴드 기본값 — 차트 상태 반영: 과열이면 눌림목 대기, 아니면 현재가 부근
  if (d.entry_low_pct == null || d.entry_high_pct == null) {
    if (stats?.rsi14 != null && stats.rsi14 >= 68) { d.entry_low_pct = -5; d.entry_high_pct = -1; }
    else { d.entry_low_pct = -2; d.entry_high_pct = 1; }
  }
}

// 프롬프트 캐싱용 고정 지침 블록 — 이슈/후보 데이터와 무관하게 매 호출 동일하므로
// cache_control로 분리해 반복 호출 시 입력 토큰 비용을 절감 (analyze-backlog 등
// 시간당 최대 수십 건씩 도는 파이프라인이라 누적 효과가 큼)
const DECIDE_TRADES_STATIC_PROMPT = `당신은 미국 기관투자자(헤지펀드)의 바이사이드 주식 애널리스트입니다. 아래 뉴스 이슈에 대해 리서치팀이 올린 수혜 후보들을 실제 시장 데이터로 검증하고, 매수 추천할 종목만 선별하세요.

애널리스트 원칙:
1. 데이터가 논리를 뒷받침하지 않으면 제외. "수혜 기대"만으로 하락 추세 종목을 사지 않는다.
2. catalyst(뉴스) → mechanism(매출/이익 경로) → timeframe이 명확하지 않으면 제외.
3. 목표수익률은 종목의 실제 변동성(atr_month_pct) 안에서. 한 달에 5%도 안 움직이는 종목에 +15% 목표는 무효.
4. 확신이 없으면 제외가 정답. 전원 제외도 훌륭한 결정이다. 게재 수보다 적중률이 평가 기준.

차트 판독 원칙 (price_data 해석):
- signal=strong_bearish (정배열 붕괴, 모든 이평선 아래) → 반드시 exclude
- rsi_14 ≥ 75 → 과열. 추격 매수 금지: exclude 하거나 entry를 눌림목(-5 ~ -2%)으로 설정
- rsi_14 ≤ 35 이면서 above_sma200=true → 장기 상승추세 속 조정 = 좋은 진입 기회 (가점)
- macd_hist_pct < 0 이고 macd_rising=false → 모멘텀 꺾이는 중. 뉴스 촉매가 압도적이지 않으면 exclude
- vol_ratio_5d_20d ≥ 1.5 + ret_5d > 0 → 뉴스에 수급이 실제 반응 중 (신뢰 가점)
- vol_ratio_5d_20d ≥ 1.5 + ret_5d < 0 → 투매 진행 중 (exclude 우선)
- bollinger_pct_b > 1.0 → 밴드 상단 돌파 상태. 단기 되돌림 위험, entry를 보수적으로
- pct_from_52w_high > -5 (신고가 부근) → 저항 없음, 추세 지속 유리. 단 rsi 과열 동반 시 눌림목 대기
- key_thesis에는 뉴스 촉매와 차트 근거를 함께 담을 것 (예: "RSI 52 건전 + 50일선 지지 + 관세 수혜")
- key_thesis/key_risk는 일반 투자자가 읽는 문장 — above_sma50, ret_3m 같은 데이터 필드명 그대로 쓰지 말고 "50일선 위 안착", "3개월 +15% 추세"처럼 풀어 쓸 것

JSON만 반환:
{"decisions":[{"ticker":"...","action":"buy 또는 exclude","exclude_reason":"제외 시 한 문장","confidence":70,"upside_pct":8,"entry_low_pct":-2,"entry_high_pct":1,"stop_loss_pct":-4,"time_frame":"1w|1m|3m|6m","key_thesis":"왜 지금 사는가 한 문장 (데이터 근거 포함)","key_risk":"핵심 리스크 한 문장"}]}

buy 규칙:
- upside_pct: atr_month_pct × 기간계수(1w=0.5, 1m=1, 3m=1.7, 6m=2.4)의 0.5~1.5배 범위 내 양수
- stop_loss_pct: 음수, 절댓값은 upside_pct의 40~70% (손익비 ≥ 1.4)
- confidence: 0-100. 뉴스 연결 강도 × 데이터 정합성. 관성적으로 70을 주지 말 것 — 근거가 평범하면 50대
- ret_1m < -10 이고 above_sma50=false인 종목은 반드시 exclude
- price_data가 null인 종목은 확신이 매우 높지 않으면 exclude
- 모든 후보에 대해 decisions에 하나씩 반드시 응답할 것`;

function buildCandidateRows(candidates) {
  return candidates.map(c => ({
    ticker: c.co.ticker,
    name: c.co.name_ko || c.co.name_en,
    sector: c.ripple.sector,
    why: (c.co.rationale || '').slice(0, 120),
    price_data: c.stats ? {
      ret_5d: c.stats.ret5d, ret_1m: c.stats.ret1m, ret_3m: c.stats.ret3m,
      above_sma20: c.stats.aboveSma20, above_sma50: c.stats.aboveSma50, above_sma200: c.stats.aboveSma200,
      pct_from_52w_high: c.stats.pctFrom52wHigh, pct_from_52w_low: c.stats.pctFrom52wLow,
      atr_month_pct: c.stats.atrMonthPct,
      rsi_14: c.stats.rsi14, macd_hist_pct: c.stats.macdHistPct, macd_rising: c.stats.macdRising,
      vol_ratio_5d_20d: c.stats.volRatio, bollinger_pct_b: c.stats.bbPctB,
      signal: c.stats.signal,
    } : null,
    fundamentals: c.fund ? {
      pe: c.fund.pe, roe: c.fund.roe, op_margin: c.fund.operatingMargin,
      debt_equity: c.fund.debtToEquity, rev_yoy: c.fund.revenueGrowthYoY,
      fund_score: c.fundScore,
    } : null,
  }));
}

function buildDecideDynamicBlock(issue, analysis, candidates, regime) {
  const rows = buildCandidateRows(candidates);
  return `현재 시장 레짐: 미국 ${regime?.us || '?'}, 한국 ${regime?.kr || '?'}${regime?.vix != null ? `, VIX ${Math.round(regime.vix)}` : ''}
→ bear 레짐 시장의 종목은 원칙 4를 훨씬 엄격히 적용 (지수가 꺾인 장에서 개별 매수는 예외적 확신이 있을 때만)

뉴스 이슈: ${issue.title}
이슈 요약: ${(analysis.summary || issue.summary || '').slice(0, 300)}

후보 종목 데이터 (price_data: %단위, above_*: 이평선 상회 여부, atr_month_pct: 월간 기대 변동폭%):
${JSON.stringify(rows)}

위 데이터에 대해 위 규칙에 따라 JSON으로만 응답하세요.`;
}

// ─── 2단계: 애널리스트 패스 — 실데이터를 보고 매수/제외 결정 ────────
async function decideTrades(issue, analysis, candidates, regime) {
  const dynamicBlock = buildDecideDynamicBlock(issue, analysis, candidates, regime);

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: DECIDE_TRADES_STATIC_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamicBlock },
      ],
    }],
  });

  const text = message.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('decideTrades: JSON not found');
  const parsed = parseJsonSafe(jsonMatch[0]);

  const map = {};
  for (const d of parsed.decisions || []) {
    if (d?.ticker) map[d.ticker.toUpperCase()] = d;
  }
  return map;
}

async function sendNotify(message, req) {
  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `https://${req.headers.host}`;
  await fetch(`${base}/api/notify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.ADMIN_SECRET}`,
    },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(10000),
  });
}

// 후보발굴 패스 고정 지침 — 이슈 내용과 무관, 캐싱 대상
const ANALYZE_STATIC_PROMPT = `당신은 글로벌 주식시장 리서치 애널리스트입니다. 다음 뉴스/이슈의 파급효과와 수혜 후보 기업을 찾아주세요.
(주의: 지금은 "후보 발굴" 단계입니다. 매매 수치(목표가·손절가)는 이후 실제 시장 데이터를 보고 별도 단계에서 결정하므로 여기서 만들지 마세요.)

다음 형식으로 JSON만 반환하세요 (다른 텍스트 없이):
{
  "relevance_score": 75,
  "summary": "이슈의 핵심 내용과 시장 영향 2-3문장",
  "directSectors": ["직접 영향받는 섹터1", "섹터2"],
  "rippleEffects": [
    {
      "sector": "파급 섹터명 (한국어)",
      "impact": "positive 또는 negative 또는 neutral",
      "reason": "왜 이 섹터에 파급효과가 생기는지 설명",
      "companies": [
        {
          "ticker": "AAPL 또는 005930.KS 형식",
          "name_ko": "기업명 한국어",
          "name_en": "Company Name English",
          "market": "US 또는 KR",
          "rationale": "이 기업이 수혜를 받는 구체적 이유 — catalyst(뉴스)가 이 기업의 매출/이익에 닿는 경로(mechanism)를 명시"
        }
      ]
    }
  ],
  "confidence_score": 75
}

규칙:
- relevance_score: 주식시장 투자 관련성 (0-100). 상장기업 실적/정책/금리/무역 등 투자에 직접 영향이면 70+, 간접적이면 40-70, 비상장 스타트업·생활경제·스포츠·연예 등 무관하면 40 미만
- relevance_score < 40이면 rippleEffects는 빈 배열로 반환
- rippleEffects는 2-4개, 각 섹터당 기업은 2-3개 (relevance_score >= 40인 경우만)
- 한국 기업(KR)과 미국 기업(US)을 균형있게 포함
- 하락이 예상되는 종목은 companies에 넣지 말 것 (impact:negative 섹터는 companies를 비워둘 것)
- rationale에 3차 이상 간접 연결(뉴스→A→B→이 기업)은 금지. 최대 2차 파급까지만.

티커 규칙:
- 반드시 Yahoo Finance에서 실제로 거래되는 종목만 사용
- 한국 주식 티커: 반드시 6자리 숫자.KS 형식 (예: 005930.KS=삼성전자, 000660.KS=SK하이닉스, 035420.KS=NAVER, 051910.KS=LG화학)
- 미국 주식: NYSE/NASDAQ 실제 상장 티커만 사용 (예: AAPL, MSFT, NVDA, TSLA)
- 확실하지 않은 티커는 절대 추측하지 말고 제외할 것

⭐ 펀더멘털 고려 (시스템이 자동 검증):
- 종목 선택 시 다음 조건을 우선 고려: 수익성(ROE/영업이익률) 양호, 부채비율 적정(<2), 매출 성장세
- 시스템이 자동으로 PE/PB/ROE/부채비율/유동비율/매출성장 데이터를 가져와 confidence를 조정합니다
- 적자 기업이나 부채비율 3+인 부실 기업은 가능한 한 회피 (테마주/모멘텀 이슈가 명확하지 않은 경우)
- 동일 섹터 내에서는 펀더멘털 우수 기업 우선 (단, 뉴스 임팩트가 압도적이면 예외 OK)

⭐ 전략적 투자/지분 기반 간접 수혜 (선반영 논리) — 반도체에만 국한되지 말 것:
- 본업이 다른 분야인데 해당 테마에 전략적 지분/사업을 보유한 경우 적극 발굴
  [AI]   SK텔레콤 → Anthropic 투자 → Claude 성공 시 선반영
         알파벳·아마존 → Anthropic 투자 → Claude 매출 직접 수혜
         마이크로소프트 → OpenAI → GPT/Sora 성장 시 수혜
         Salesforce → Agentforce (엔터프라이즈 AI 에이전트)
  [로봇] 현대차 → Boston Dynamics 80% → 휴머노이드 테마 수혜
         삼성전자 → Rainbow Robotics 15% → 산업/서비스 로봇
  [우주] 한화에어로스페이스 → 한화시스템 위성 → 저궤도 위성통신
         RKLB → Neutron 로켓 → SpaceX 대안
  [방산] 한화에어로/KAI/현대로템 → 폴란드·UAE 수주 → 지정학 리스크 시 선반영
  [원전] 두산에너빌리티 → NuScale SMR 주기기 → AI 데이터센터 전력 테마
         CEG·VST → MS·AWS 원전 PPA → AI 인프라 전력 공급
  [비만/GLP-1] LLY/NVO → 비만치료제 글로벌 시장 / 한미약품 → MSD GLP-1 라이선스
  [바이오] 셀트리온 → 미국 직판 / 알테오젠 → 키트루다 SC 변경 기술
  [K-팝/콘텐츠] 하이브·SM·JYP·YG → 글로벌 팬덤 + 북미 진출
  [핀테크] 코인베이스 → BTC ETF 커스터디 / MELI → 라틴 결제
  [K-뷰티] 아모레·한국콜마 → 미국 Amazon/Sephora 직판
  [게임] 엔씨 TL → 아마존 글로벌 퍼블리싱 / 크래프톤 인조이 → 생성형 AI 게임
- 이런 종목은 rationale에 "OO에 지분 보유 → 선반영" 논리를 한 줄로 명시
- 위 컨텍스트에 ⭐ 표시된 항목은 가장 강한 연결고리. 우선 검토

⭐ 회사명 정확성 (매우 중요 - 환각 금지):
- name_en은 회사의 정식 영문 법인명 (예: LRCX → "Lam Research", AVGO → "Broadcom")
- name_ko는 한국에서 통용되는 정식 한국어 회사명. 영문명의 음역이거나 한국에서 공식 사용하는 이름.
  · 예: Lam Research → "램 리서치", Broadcom → "브로드컴", Micron → "마이크론 테크놀로지"
  · 절대 다른 회사의 제품명/브랜드명 사용 금지 (예: LRCX를 "라이젠"이라고 하면 안 됨 — Ryzen은 AMD 제품)
- 티커와 회사명이 매칭되는지 확실하지 않으면 그 종목을 제외할 것`;

// 전략적 투자 노출 컨텍스트: 이슈의 섹터·제목·요약에서 키워드 뽑아 관련 상장사 후보 제시
// (동기 경로의 analyzeIssue와 배치 경로의 discover-stage 제출 양쪽에서 공유)
async function buildStrategicCtx(issue) {
  let strategicCtx = '';
  try {
    const mod = await import('../lib/strategic-investments.js');
    // 이슈에서 테마 키워드 후보 추출
    const haystack = `${issue.title || ''} ${issue.summary || ''} ${(issue.sectors || []).join(' ')}`.toLowerCase();
    const THEME_KEYWORDS = [
      // AI / LLM
      'ai', '인공지능', 'llm', 'gpt', 'claude', 'anthropic', 'openai', 'gemini', 'grok', 'mistral', 'cohere', 'agentforce', 'copilot',
      // 반도체
      '반도체', 'hbm', 'gpu', '메모리', '파운드리', 'asic', 'tpu',
      // 로봇 / 자율주행
      '로봇', '휴머노이드', 'boston dynamics', 'optimus', '자율주행', 'waymo', 'robotaxi', '로보택시', 'fsd',
      // 우주 / 위성 / UAM
      '우주', '위성', 'spacex', 'starlink', 'kuiper', '로켓', 'rocket lab', 'uam', 'evtol',
      // 방산
      '방산', '국방', '미사일', '전투기', '전차', 'k2 흑표', 'k9', 'f-35', 'patriot', 'thaad', '천궁',
      // 바이오 / 제약 / GLP-1
      '바이오', 'cdmo', '의약품', '제약', 'mrna', 'glp-1', 'glp1', '비만치료', 'wegovy', 'ozempic', 'mounjaro', '항암제', '알츠하이머', 'fda', '신약', '바이오시밀러',
      // EV / 배터리 / 에너지
      'ev', '전기차', '배터리', 'ess', '전고체', '리튬',
      // 원자력
      '원자력', 'smr', '데이터센터', '원전', '핵발전',
      // 재생에너지
      '재생에너지', '태양광', '풍력', '수소', '암모니아',
      // 클라우드 / SaaS / 데이터
      '클라우드', 'saas', 'aws', 'azure', 'oci', '데이터 플랫폼', 'snowflake', 'databricks',
      // XR / 메타버스
      'xr', 'vr', 'ar', '메타버스',
      // 핀테크 / 결제 / 암호화폐
      '핀테크', '결제', '암호화폐', '비트코인', 'btc', 'crypto', 'stablecoin', '스테이블코인', 'etf',
      // 게임
      '게임', 'mmorpg', 'pubg', '인조이', '나혼렙', '엔씨', '크래프톤', '넷마블',
      // 콘텐츠 / 엔터 / K-팝
      'k-팝', 'k팝', 'kpop', 'bts', 'blackpink', 'newjeans', '하이브', '스트리밍', 'netflix', 'disney',
      // 이커머스 / 플랫폼
      '이커머스', '쿠팡', 'coupang', 'shopify', 'amazon', '물류',
      // K-뷰티 / 소비재
      'k-뷰티', 'k뷰티', '화장품', '아모레', '코스맥스',
    ];
    const matched = THEME_KEYWORDS.filter(k => haystack.includes(k));
    if (matched.length) {
      // 하드코딩 + DB 자동누적 항목 병합
      const formatted = await mod.formatMergedThemeBetsForPrompt(supabase, matched, 16);
      if (formatted) strategicCtx = `\n\n🎯 ${formatted}\n주의: 위 상장사들 중 뉴스 테마와 정말 부합하는 곳은 적극 포함시키되, "지분 보유 → 선반영" 논리는 rationale에 명시할 것. [AI추출] 태그는 자동 누적된 것이라 더 보수적으로 검증. 단순 나열 금지.`;
    }
  } catch {}
  return strategicCtx;
}

function buildAnalyzeDynamicBlock(issue, strategicCtx) {
  return `이슈 제목: ${issue.title}
요약: ${issue.summary || '없음'}
관련 섹터: ${issue.sectors?.join(', ') || '미분류'}${strategicCtx}

위 이슈에 대해 위 규칙에 따라 JSON으로만 응답하세요.`;
}

async function analyzeIssue(issue) {
  const strategicCtx = await buildStrategicCtx(issue);
  const dynamicBlock = buildAnalyzeDynamicBlock(issue, strategicCtx);

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: ANALYZE_STATIC_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamicBlock },
      ],
    }],
  });

  const text = message.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('JSON not found in response');

  return parseJsonSafe(jsonMatch[0]);
}

// ── 펀더멘털 fetch (FMP stable, 무료 엔드포인트만) ────────
async function fetchFundamentals(ticker) {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;
  if (/\.KS$|\.KQ$/i.test(ticker)) return null;  // 한국 주식은 FMP 무료에서 안 됨

  // DB 캐시 확인 (24h 이내면 FMP 호출 안 함)
  try {
    const { data } = await supabase
      .from('companies')
      .select('fundamentals, fundamentals_updated_at')
      .eq('ticker', ticker)
      .maybeSingle();
    if (data?.fundamentals && data?.fundamentals_updated_at) {
      const age = Date.now() - new Date(data.fundamentals_updated_at).getTime();
      if (age < 24 * 3600 * 1000) {
        const f = data.fundamentals;
        // 캐시된 데이터에서 필요한 필드만 추출 반환
        return {
          pe: f.pe, pb: f.pb,
          roe: f.roe, operatingMargin: f.operatingMargin,
          debtToEquity: f.debtToEquity, currentRatio: f.currentRatio,
          revenueGrowthYoY: f.revenueGrowthYoY,
          netIncomeGrowthYoY: f.netIncomeGrowthYoY,
        };
      }
    }
  } catch {}

  const fmp = (path) => fetch(`https://financialmodelingprep.com${path}${path.includes('?') ? '&' : '?'}apikey=${key}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) })
    .then(r => r.ok ? r.json() : null).catch(() => null);

  try {
    const [quote, incomeQ, balanceQ] = await Promise.all([
      fmp(`/stable/quote?symbol=${encodeURIComponent(ticker)}`),
      fmp(`/stable/income-statement?symbol=${encodeURIComponent(ticker)}&period=quarter&limit=5`),
      fmp(`/stable/balance-sheet-statement?symbol=${encodeURIComponent(ticker)}&period=quarter&limit=1`),
    ]);
    const qt  = Array.isArray(quote) ? quote[0] : quote;
    const inc      = Array.isArray(incomeQ)  ? incomeQ[0]  : null;
    const incYoY   = Array.isArray(incomeQ)  ? (incomeQ[3] || incomeQ[4] || null) : null;
    const bal      = Array.isArray(balanceQ) ? balanceQ[0] : null;
    if (!qt && !inc) return null;

    const n = v => (v == null || isNaN(Number(v))) ? null : Number(v);
    const div = (a, b) => (n(a) != null && n(b) != null && n(b) !== 0) ? (n(a) / n(b)) : null;
    const pct = (a, b) => (n(a) != null && n(b) != null && n(b) !== 0) ? ((n(a) - n(b)) / Math.abs(n(b)) * 100) : null;

    const revenue   = n(inc?.revenue);
    const opInc     = n(inc?.operatingIncome);
    const netInc    = n(inc?.netIncome);
    const equity    = n(bal?.totalStockholdersEquity);
    const debt      = n(bal?.totalDebt) || n(bal?.longTermDebt);
    const ca        = n(bal?.totalCurrentAssets);
    const cl        = n(bal?.totalCurrentLiabilities);

    return {
      pe:  n(qt?.pe),
      pb:  div(n(qt?.price), div(equity, n(qt?.sharesOutstanding))),
      roe: div(netInc, equity) != null ? div(netInc, equity) * 100 : null,
      operatingMargin: div(opInc, revenue) != null ? div(opInc, revenue) * 100 : null,
      debtToEquity:    div(debt, equity),
      currentRatio:    div(ca, cl),
      revenueGrowthYoY:   incYoY ? pct(revenue, incYoY.revenue) : null,
      netIncomeGrowthYoY: incYoY ? pct(netInc, incYoY.netIncome) : null,
    };
  } catch { return null; }
}

// 펀더멘털 점수 -30 ~ +30 (AI confidence 보정용)
function scoreFundamentals(f) {
  if (!f) return null;
  let score = 0;
  // ROE: 높을수록 좋음
  if (f.roe != null) {
    if (f.roe > 20) score += 8;
    else if (f.roe > 10) score += 4;
    else if (f.roe < 0) score -= 8;
  }
  // 영업이익률
  if (f.operatingMargin != null) {
    if (f.operatingMargin > 20) score += 6;
    else if (f.operatingMargin > 10) score += 3;
    else if (f.operatingMargin < 0) score -= 8;
  }
  // 매출 성장 (YoY)
  if (f.revenueGrowthYoY != null) {
    if (f.revenueGrowthYoY > 20) score += 6;
    else if (f.revenueGrowthYoY > 5) score += 3;
    else if (f.revenueGrowthYoY < -10) score -= 6;
  }
  // 부채비율
  if (f.debtToEquity != null) {
    if (f.debtToEquity < 0.5) score += 4;
    else if (f.debtToEquity > 3) score -= 6;
  }
  // 유동비율
  if (f.currentRatio != null) {
    if (f.currentRatio > 2) score += 3;
    else if (f.currentRatio < 1) score -= 5;
  }
  // PE: 너무 비싸면 감점
  if (f.pe != null) {
    if (f.pe > 50) score -= 4;
    else if (f.pe > 0 && f.pe < 20) score += 3;
  }
  return Math.max(-30, Math.min(30, score));
}

async function validateTicker(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice && !meta?.previousClose) return null;
    return {
      price: meta.regularMarketPrice || meta.previousClose,
      marketCap: meta.marketCap || null,
      currency: meta.currency || 'USD',
      longName: meta.longName || meta.shortName || null,
    };
  } catch {
    return null;
  }
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    // Fix trailing commas before } or ]
    let fixed = text
      .replace(/,\s*([}\]])/g, '$1')
      // Remove control characters in strings
      .replace(/[\x00-\x1F\x7F]/g, ' ');
    try {
      return JSON.parse(fixed);
    } catch (_) {
      // Try to close unclosed JSON by finding last complete array/object
      const lastBrace = fixed.lastIndexOf('}');
      if (lastBrace > 0) {
        fixed = fixed.slice(0, lastBrace + 1);
        fixed = fixed.replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(fixed);
      }
      throw new Error('Failed to parse AI response as JSON');
    }
  }
}

async function upsertCompany(co, priceData = null) {
  // Yahoo가 알려주는 공식 회사명을 신뢰의 원천으로 사용 (AI 환각 방지)
  const officialName = priceData?.longName || null;
  // AI가 준 name_ko가 의심스러우면 (영어 공식명에 포함된 토큰과 다른 회사명일 때) 영어명으로 대체
  // 예: LRCX의 longName이 "Lam Research Corporation"인데 AI가 "라이젠"이라고 했다면 → "Lam Research" 로 대체
  let nameKo = co.name_ko || '';
  if (officialName) {
    const officialLower = officialName.toLowerCase();
    const koLower       = nameKo.toLowerCase();
    // 한글 변형 확인: 영어 longName의 첫 단어가 한글 이름에 음역으로 포함되는지 대충 확인
    // 너무 엄격하면 정상 데이터도 거부하므로, 공식명을 fallback으로만 사용
    if (!nameKo || nameKo.length < 2) nameKo = officialName;
  }

  // .single()은 중복 행 존재 시 에러 → "없음"으로 오인해 회사가 또 생성됨 → limit(1) 사용
  const { data: existingRows } = await supabase
    .from('companies')
    .select('id, name_en, name_ko')
    .eq('ticker', co.ticker)
    .limit(1);
  const existing = existingRows?.[0];

  // 기존 row가 있어도 공식 영어명이 비어 있으면 업데이트
  if (existing) {
    if (officialName && (!existing.name_en || existing.name_en === existing.name_ko)) {
      await supabase.from('companies').update({ name_en: officialName }).eq('id', existing.id);
    }
    return existing.id;
  }

  const insertData = {
    ticker:  co.ticker,
    name_ko: nameKo,
    name_en: officialName || co.name_en || co.name_ko,
    market:  co.market,
  };
  if (priceData) {
    insertData.current_price = priceData.price;
    insertData.market_cap = priceData.marketCap;
    insertData.currency = priceData.currency;
    insertData.price_updated_at = new Date().toISOString();
  }

  const { data: newCo } = await supabase
    .from('companies')
    .insert(insertData)
    .select()
    .single();

  return newCo.id;
}
