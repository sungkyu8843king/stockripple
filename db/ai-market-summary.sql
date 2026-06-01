-- AI 시장 종합 보고서 (매일 cron이 생성, 사이트에 노출)
CREATE TABLE IF NOT EXISTS ai_market_summary (
  id BIGSERIAL PRIMARY KEY,
  headline TEXT,
  regime TEXT,           -- RISK-ON / RISK-OFF / MIXED
  bullish_drivers JSONB,
  bearish_drivers JSONB,
  sectors_winning JSONB,
  sectors_losing JSONB,
  key_events_today JSONB,
  watch_tomorrow JSONB,
  based_on_issues INT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_market_created ON ai_market_summary(created_at DESC);

ALTER TABLE ai_market_summary ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read ai_market_summary" ON ai_market_summary FOR SELECT USING (true);
CREATE POLICY "Service role can manage ai_market_summary" ON ai_market_summary FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
