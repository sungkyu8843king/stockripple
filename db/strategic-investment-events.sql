-- ═══════════════════════════════════════════════════════════════
-- 전략 투자 이벤트 로그
-- 매번 추출/재추출/승인/거부/공시 매칭 등이 일어날 때마다 한 줄 추가
-- → 시간 흐름에 따른 seen_count 추이 그래프용
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS strategic_investment_events (
  id              BIGSERIAL PRIMARY KEY,
  investment_id   BIGINT REFERENCES strategic_investments(id) ON DELETE CASCADE,
  investor_ticker TEXT NOT NULL,
  target_name     TEXT NOT NULL,
  event_type      TEXT NOT NULL,   -- extracted | reextracted | approved | rejected | dart | sec13f
  confidence      INT,
  source_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  source_url      TEXT,
  occurred_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sie_ticker_time
  ON strategic_investment_events(investor_ticker, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sie_investment
  ON strategic_investment_events(investment_id);

ALTER TABLE strategic_investment_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read strategic_investment_events"
  ON strategic_investment_events FOR SELECT USING (true);

CREATE POLICY "Service role can manage strategic_investment_events"
  ON strategic_investment_events FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
