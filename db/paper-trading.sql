-- ─────────────────────────────────────────────────────────────
-- 페이퍼 트레이딩 (가상 매매) 스키마
-- Supabase Dashboard → SQL Editor에서 한 번만 실행하세요
-- ─────────────────────────────────────────────────────────────

-- 가상 포트폴리오 (사용자 1인 1개)
CREATE TABLE IF NOT EXISTS paper_portfolios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  initial_cash  numeric NOT NULL DEFAULT 10000000,  -- 시작 자본 1000만원
  cash_balance  numeric NOT NULL DEFAULT 10000000,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  UNIQUE(user_id)
);

-- 가상 포지션 (각 매매 기록)
CREATE TABLE IF NOT EXISTS paper_positions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id  uuid REFERENCES paper_portfolios(id) ON DELETE CASCADE,
  ticker        text NOT NULL,
  name_ko       text,
  market        text,                  -- 'US' or 'KR'
  quantity      numeric NOT NULL,
  entry_price   numeric NOT NULL,
  entry_date    timestamptz NOT NULL DEFAULT now(),

  -- AI 추천 정보 스냅샷
  analysis_company_id uuid,             -- analysis_companies.id 참조 (FK 안 함, 삭제돼도 기록 유지)
  ai_target_pct numeric,                -- 목표 수익률 %
  ai_stop_pct   numeric,                -- 손절선 %
  ai_thesis     text,                   -- 매수 근거 (스냅샷)
  ai_time_frame text,                   -- '1w' / '1m' / '3m' / '6m'

  -- 종결 정보
  exit_price    numeric,
  exit_date     timestamptz,
  exit_reason   text,                   -- 'manual' / 'target_hit' / 'stop_hit'
  pnl_pct       numeric,
  pnl_amount    numeric,
  status        text DEFAULT 'open',    -- 'open' / 'closed'

  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_paper_positions_portfolio ON paper_positions(portfolio_id, status);
CREATE INDEX IF NOT EXISTS idx_paper_positions_ticker    ON paper_positions(ticker);

-- ─────────────────────────────────────────────────────────────
-- RLS: 사용자는 자기 포트폴리오/포지션만 접근
-- ─────────────────────────────────────────────────────────────
ALTER TABLE paper_portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_positions  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_own_portfolio" ON paper_portfolios;
CREATE POLICY "user_own_portfolio" ON paper_portfolios
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_own_positions" ON paper_positions;
CREATE POLICY "user_own_positions" ON paper_positions
  FOR ALL USING (
    portfolio_id IN (SELECT id FROM paper_portfolios WHERE user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────
-- 보조 view: 평가금액 + 총 손익 (보유 중인 포지션은 현재가 미반영,
--           프론트엔드에서 실시간 가격으로 계산)
-- ─────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS paper_portfolio_summary;
CREATE VIEW paper_portfolio_summary AS
SELECT
  p.id            AS portfolio_id,
  p.user_id,
  p.initial_cash,
  p.cash_balance,
  COUNT(pos.id) FILTER (WHERE pos.status = 'open')   AS open_positions,
  COUNT(pos.id) FILTER (WHERE pos.status = 'closed') AS closed_positions,
  COALESCE(SUM(pos.pnl_amount) FILTER (WHERE pos.status = 'closed'), 0) AS realized_pnl,
  COALESCE(SUM(pos.entry_price * pos.quantity) FILTER (WHERE pos.status = 'open'), 0) AS invested
FROM paper_portfolios p
LEFT JOIN paper_positions pos ON pos.portfolio_id = p.id
GROUP BY p.id;

GRANT SELECT ON paper_portfolio_summary TO authenticated;
