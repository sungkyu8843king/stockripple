-- analyze_batches를 Claude API 배치(anthropic) / Claude Code 에이전트(agent) 양쪽이 공유하도록 확장.
-- engine='agent'인 행은 Anthropic Message Batches API를 전혀 부르지 않고, 대신 프롬프트를
-- prompts 컬럼에 적재해두면 스케줄 Claude Code 에이전트가 읽어서 response 컬럼에 답을 써넣는다.
-- status/stage 상태머신과 finalizeDiscoverStage/finalizeDecideStage 로직은 기존과 100% 동일 —
-- processBatchRow만 engine으로 분기해서 "완료 여부"를 Anthropic API 조회 대신 response IS NOT NULL로 판단.
ALTER TABLE analyze_batches ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'anthropic' CHECK (engine IN ('anthropic', 'agent'));
ALTER TABLE analyze_batches ADD COLUMN IF NOT EXISTS prompts JSONB;   -- agent 전용: [{issueId, static, dynamic}] 형태로 렌더링된 프롬프트 전문
ALTER TABLE analyze_batches ADD COLUMN IF NOT EXISTS response JSONB;  -- agent 전용: { [issueId]: "<raw JSON 응답 텍스트>" } (파싱 전 원문 문자열)

-- anthropic_batch_id는 agent 엔진 행에서는 값이 없으므로 NOT NULL 제약이 있었다면 완화
DO $$
BEGIN
  BEGIN
    ALTER TABLE analyze_batches ALTER COLUMN anthropic_batch_id DROP NOT NULL;
  EXCEPTION WHEN undefined_column OR others THEN NULL;
  END;
END $$;

CREATE INDEX IF NOT EXISTS idx_analyze_batches_agent_pending
  ON analyze_batches (engine, status)
  WHERE engine = 'agent' AND status = 'submitted';
