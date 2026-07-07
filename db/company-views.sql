-- 종목 조회수 집계 (어드민 "조회수 통계" 패널용) — 티커 x 날짜별 카운트를
-- /api/company-summary 호출 시마다 원자적으로 증가시킨다 (캐시 히트/미스 무관, 순수 조회 트래픽).
CREATE TABLE IF NOT EXISTS company_views (
  ticker TEXT NOT NULL,
  view_date DATE NOT NULL DEFAULT CURRENT_DATE,
  views INT NOT NULL DEFAULT 0,
  PRIMARY KEY (ticker, view_date)
);
CREATE INDEX IF NOT EXISTS idx_company_views_date ON company_views(view_date DESC);

ALTER TABLE company_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read company_views" ON company_views FOR SELECT USING (true);
CREATE POLICY "Service role can manage company_views" ON company_views FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- 동시 요청 경합 없이 카운트 증가 (upsert 방식 select-then-write 대신 원자적 처리)
CREATE OR REPLACE FUNCTION increment_company_view(p_ticker TEXT)
RETURNS void AS $$
BEGIN
  INSERT INTO company_views (ticker, view_date, views)
  VALUES (p_ticker, CURRENT_DATE, 1)
  ON CONFLICT (ticker, view_date)
  DO UPDATE SET views = company_views.views + 1;
END;
$$ LANGUAGE plpgsql;
