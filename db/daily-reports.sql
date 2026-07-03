-- 데일리 리포트 (국장/미장) — 장 마감 후 자동 생성, 과거 리포트 아카이브 조회 가능
CREATE TABLE IF NOT EXISTS daily_reports (
  id BIGSERIAL PRIMARY KEY,
  market TEXT NOT NULL CHECK (market IN ('KR','US')),
  report_date DATE NOT NULL,
  headline TEXT,
  mood TEXT,               -- 상승 / 하락 / 혼조
  indices JSONB,           -- 실제 지수 마감 데이터 [{name, price, changePercent}]
  recap JSONB,             -- 시장 흐름 요약 (문장 배열)
  top_events JSONB,        -- 주요 이벤트 (배열)
  sector_notes JSONB,      -- 섹터/종목 특징 (배열)
  tomorrow JSONB,          -- 다음 거래일 관전 포인트 (배열)
  based_on_issues INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(market, report_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_reports_date ON daily_reports(market, report_date DESC);

ALTER TABLE daily_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read daily_reports" ON daily_reports FOR SELECT USING (true);
CREATE POLICY "Service role can manage daily_reports" ON daily_reports FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
