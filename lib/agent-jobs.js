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
export async function submitAgentJob({ pipeline, stage = 'main', items, payload }) {
  const { data: inflight, error: inflightErr } = await supabase
    .from('agent_jobs').select('id').eq('pipeline', pipeline).eq('stage', stage)
    .in('status', ['submitted', 'processing']).limit(1);
  if (inflightErr) return { submitted: false, reason: 'agent_jobs table not ready: ' + inflightErr.message };
  if (inflight?.length) return { submitted: false, reason: 'already in flight' };
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
