-- 정확도 추적 컬럼 추가 (analysis_companies)
-- Supabase SQL Editor에서 실행

ALTER TABLE analysis_companies
  ADD COLUMN IF NOT EXISTS entry_price    DECIMAL(15,4),
  ADD COLUMN IF NOT EXISTS entry_date     TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS check_price_7d  DECIMAL(15,4),
  ADD COLUMN IF NOT EXISTS check_date_7d   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actual_return_7d DECIMAL(7,2),
  ADD COLUMN IF NOT EXISTS check_price_30d DECIMAL(15,4),
  ADD COLUMN IF NOT EXISTS check_date_30d  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actual_return_30d DECIMAL(7,2),
  ADD COLUMN IF NOT EXISTS is_accurate_7d  BOOLEAN,
  ADD COLUMN IF NOT EXISTS is_accurate_30d BOOLEAN;

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_ac_entry_date ON analysis_companies(entry_date);
CREATE INDEX IF NOT EXISTS idx_ac_check_7d   ON analysis_companies(check_date_7d) WHERE check_date_7d IS NULL;
CREATE INDEX IF NOT EXISTS idx_ac_check_30d  ON analysis_companies(check_date_30d) WHERE check_date_30d IS NULL;
