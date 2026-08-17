-- ─────────────────────────────────────────────────────────────
-- 내 자산 (실제 보유 종목 등록 + 수익률 추이) 스키마
-- Supabase Dashboard → SQL Editor에서 한 번만 실행하세요
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS my_holdings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker         text NOT NULL,
  name_ko        text,
  market         text,                  -- 'US' or 'KR'
  quantity       numeric NOT NULL,
  buy_price      numeric NOT NULL,      -- 종목 통화 기준(KR=원, US=달러)
  buy_date       date NOT NULL,
  entry_fx_rate  numeric,               -- US 종목: 매수 시점 USD/KRW 고정(환차 제외, 모의투자와 동일 원칙)
  created_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_my_holdings_user ON my_holdings(user_id);

ALTER TABLE my_holdings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_own_holdings" ON my_holdings;
CREATE POLICY "user_own_holdings" ON my_holdings
  FOR ALL USING (auth.uid() = user_id);
