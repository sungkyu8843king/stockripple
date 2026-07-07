-- 회사 AI 종합분석 캐시 (공개 /api/company-summary) — 티커당 하루 1회만 Claude 재생성,
-- 이후 요청은 이 테이블에서 서빙. 방문자 트래픽에 비례해 Claude 비용이 늘어나는 걸 막기 위함.
CREATE TABLE IF NOT EXISTS company_ai_summary (
  ticker TEXT PRIMARY KEY,
  overview TEXT,
  thesis TEXT,
  strategic_exposure TEXT,
  key_risks JSONB,
  competitive_position TEXT,
  watch_points JSONB,
  analyses_count INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_company_ai_summary_created ON company_ai_summary(created_at DESC);

ALTER TABLE company_ai_summary ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read company_ai_summary" ON company_ai_summary FOR SELECT USING (true);
CREATE POLICY "Service role can manage company_ai_summary" ON company_ai_summary FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
