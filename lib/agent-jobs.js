// analyze 외 6개 AI 파이프라인(extract_investments/ai_market_summary/weekly_schedule/
// catalysts/daily_report/company_summary) 공용 agent 큐 — Anthropic을 직접 부르지 않고
// 렌더링된 프롬프트만 agent_jobs에 적재, 스케줄 Claude Code 에이전트가 response를 채우면
// handleAgentPoll이 파이프라인별 finalize 함수로 완료 처리(DB 저장까지)를 이어받는다.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const JOB_STUCK_TIMEOUT_MS = 3 * 3600 * 1000;

// 같은 pipeline+stage에 이미 대기 중인 job이 있으면 중복 제출을 스킵한다 (analyze_batches의
// in-flight 체크와 동일한 목적 — 프롬프트 렌더링 자체는 비용이 없지만 중복 큐잉을 막아둔다).
//
// ⚠️ 이 락에 만료가 없으면 자기강화적 병목이 된다(2026-08-08 실측으로 발견) — 스케줄
// 에이전트가 2시간 주기로 도는데 한 배치 처리가 그 안에 안 끝나거나 중간에 몇 시간
// 안 돌면, 다음 주기도 "이미 떠 있음"이라 새 배치를 못 넣는다. 이게 반복되면 스케줄
// 자체는 정상이어도 실제 제출 횟수는 훨씬 적어지고, 그 격차가 그대로 쌓여 article_digest
// 백로그가 22,846건까지 불어난 사례를 실측 확인했다. 그래서 기존 in-flight 건이
// JOB_STUCK_TIMEOUT_MS(3시간)를 넘도록 response가 없으면 죽은 것으로 보고 timeout
// 처리한 뒤 새로 제출한다 — handleAgentPoll이 이미 하는 stuck 판정(같은 타임아웃 상수)과
// 기준을 맞췄다.
export async function submitAgentJob({ pipeline, stage = 'main', items, payload }) {
  const { data: inflight, error: inflightErr } = await supabase
    .from('agent_jobs').select('id, status, created_at, response').eq('pipeline', pipeline).eq('stage', stage)
    .in('status', ['submitted', 'processing']).order('created_at', { ascending: true }).limit(1);
  if (inflightErr) return { submitted: false, reason: 'agent_jobs table not ready: ' + inflightErr.message };
  if (inflight?.length) {
    const row = inflight[0];
    const age = Date.now() - new Date(row.created_at).getTime();
    if (row.response || age <= JOB_STUCK_TIMEOUT_MS) return { submitted: false, reason: 'already in flight' };
    // 낙관적 동시성 — 그 사이 다른 요청이 이미 처리했으면(status가 바뀌었으면) 이 update는
    // 조용히 0행에 적용되고, 아래 새 제출은 그대로 진행된다(handleAgentPoll과 동일 패턴).
    await supabase.from('agent_jobs').update({ status: 'timeout', completed_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', row.status);
  }
  if (!items?.length) return { submitted: false, reason: 'no items' };

  const { error } = await supabase.from('agent_jobs').insert({ pipeline, stage, items, payload: payload ?? null });
  if (error) return { submitted: false, reason: error.message };
  return { submitted: true, count: items.length };
}

export function extractJobText(row, itemId) {
  const v = row.response?.[itemId];
  return typeof v === 'string' ? v.trim() : null;
}

export function parseJobJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('JSON not found in agent response');
  return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
}
