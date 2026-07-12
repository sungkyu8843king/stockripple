-- 뉴스 분석 파이프라인을 Anthropic Message Batches API로 돌릴 때의 진행 상태 추적.
-- discover(후보발굴)/decide(애널리스트 결정) 각 단계를 별도 배치로 제출하고,
-- 이 테이블로 batch_id → 완료 여부 → 다음 단계 진입에 필요한 컨텍스트를 이어 붙인다.
CREATE TABLE IF NOT EXISTS analyze_batches (
  id BIGSERIAL PRIMARY KEY,
  anthropic_batch_id TEXT NOT NULL UNIQUE,
  stage TEXT NOT NULL CHECK (stage IN ('discover', 'decide')),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'processing', 'completed', 'failed', 'timeout')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 단계별 이슈/후보 컨텍스트 (다음 단계 배치 제출 또는 최종 저장에 사용)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_analyze_batches_status ON analyze_batches(status) WHERE status = 'submitted';

ALTER TABLE analyze_batches ENABLE ROW LEVEL SECURITY;
-- 정책 없음 = anon 접근 불가, service_role(서버)만 읽고 씀 — 내부 파이프라인 상태라 공개 불필요.
