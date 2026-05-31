-- DART corp_code 매핑 캐시
-- DART OpenAPI는 stock_code 대신 8자리 corp_code를 요구함
-- corpCode.xml.zip을 다운로드해서 한 번 동기화하면 그 이후엔 빠르게 조회 가능

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS dart_corp_code TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_dart_corp_code
  ON companies(dart_corp_code) WHERE dart_corp_code IS NOT NULL;

-- 상세 데이터 캐시 테이블 (DART API 호출 결과 24h 캐시)
CREATE TABLE IF NOT EXISTS dart_company_cache (
  corp_code        TEXT PRIMARY KEY,
  ticker           TEXT,
  major_holders    JSONB,    -- 최대주주 현황
  shareholders     JSONB,    -- 5%+ 주요주주
  officers         JSONB,    -- 임원 현황
  financials       JSONB,    -- 연간 재무제표 (최근 3년)
  treasury_stock   JSONB,    -- 자기주식
  updated_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dart_cache_ticker
  ON dart_company_cache(ticker);

ALTER TABLE dart_company_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read dart_company_cache"
  ON dart_company_cache FOR SELECT USING (true);

CREATE POLICY "Service role can manage dart_company_cache"
  ON dart_company_cache FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
