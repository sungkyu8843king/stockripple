ALTER TABLE analysis_companies
  ADD COLUMN IF NOT EXISTS check_price_1d   DECIMAL(15,4),
  ADD COLUMN IF NOT EXISTS check_date_1d    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actual_return_1d DECIMAL(7,2),
  ADD COLUMN IF NOT EXISTS is_accurate_1d   BOOLEAN,
  ADD COLUMN IF NOT EXISTS check_price_3d   DECIMAL(15,4),
  ADD COLUMN IF NOT EXISTS check_date_3d    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actual_return_3d DECIMAL(7,2),
  ADD COLUMN IF NOT EXISTS is_accurate_3d   BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_ac_check_1d ON analysis_companies(check_date_1d) WHERE check_date_1d IS NULL;
CREATE INDEX IF NOT EXISTS idx_ac_check_3d ON analysis_companies(check_date_3d) WHERE check_date_3d IS NULL;
