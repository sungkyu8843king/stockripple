-- analyze 외 6개 AI 파이프라인(extract_investments/ai_market_summary/weekly_schedule/
-- catalysts/daily_report/company_summary) 공용 agent 큐. analyze_batches와 별개 —
-- 이 6개는 처음부터 Anthropic 직접호출 없이 전부 agent(Claude Code) 전용이라
-- analyze_batches의 engine 이원화(anthropic/agent) 같은 복잡성이 필요 없다.
CREATE TABLE IF NOT EXISTS agent_jobs (
  id BIGSERIAL PRIMARY KEY,
  pipeline TEXT NOT NULL,          -- 'extract_investments' | 'ai_market_summary' | 'weekly_schedule' | 'catalysts' | 'daily_report' | 'company_summary'
  stage TEXT NOT NULL DEFAULT 'main', -- weekly_schedule만 'events' → 'highlights' 2단계, 나머지는 'main' 고정
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'processing', 'completed', 'timeout')),
  items JSONB NOT NULL,             -- [{itemId, static, dynamic}] — itemId는 이슈ID/티커/'main' 등
  payload JSONB,                    -- 완료 처리에 필요한 결정론적 컨텍스트(파이프라인마다 다름)
  response JSONB,                   -- { [itemId]: "<raw JSON 응답 텍스트>" } — 에이전트가 채워넣음
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_jobs_pending
  ON agent_jobs (pipeline, status)
  WHERE status = 'submitted';
