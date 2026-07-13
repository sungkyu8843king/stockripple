-- Claude 토큰을 소비하는 자동/상시 파이프라인을 개별 또는 일괄로 켜고 끄기 위한 플래그 테이블.
-- 크론(GH Actions/Vercel)은 flag와 무관하게 계속 돌지만, 각 핸들러가 실제 Claude 호출 직전에
-- 이 테이블을 확인해 꺼져 있으면 호출 없이 스킵한다 — 비용 급증 시 코드 배포 없이 즉시 차단 가능.
CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO feature_flags (key, enabled) VALUES
  ('analyze', true),
  ('ai_market_summary', true),
  ('catalysts', true),
  ('daily_report', true),
  ('extract_investments', true),
  ('weekly_schedule', true),
  ('company_summary', true)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
-- 정책 없음 = anon 접근 불가, service_role(어드민 API)만 조회·수정.
