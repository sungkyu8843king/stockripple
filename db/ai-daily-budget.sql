-- 하루 전체 Claude 호출 횟수 상한 (company-summary 캐시가 어떤 이유로든 안 먹어도
-- 비용이 무한정 늘어나지 않도록 하는 이중 안전장치). 공개 SELECT 불필요 — 서버만 사용.
CREATE TABLE IF NOT EXISTS ai_daily_budget (
  day DATE PRIMARY KEY,
  calls INT NOT NULL DEFAULT 0
);

ALTER TABLE ai_daily_budget ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role can manage ai_daily_budget" ON ai_daily_budget FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- 원자적 증가 + 증가 후 값 반환 (경합 상태에서도 정확한 카운트)
CREATE OR REPLACE FUNCTION increment_ai_budget(p_day DATE)
RETURNS INT AS $$
DECLARE new_count INT;
BEGIN
  INSERT INTO ai_daily_budget (day, calls) VALUES (p_day, 1)
  ON CONFLICT (day) DO UPDATE SET calls = ai_daily_budget.calls + 1
  RETURNING calls INTO new_count;
  RETURN new_count;
END;
$$ LANGUAGE plpgsql;
