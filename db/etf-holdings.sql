-- ETF 보유종목 역인덱스 — "이 종목을 담고 있는 ETF는 무엇인가?"(역조회)를 위한 저장 테이블.
-- 네이버 etfAnalysis의 상위10 구성종목(itemCode=국내 티커, etfWeight=비중)을 크롤해 적재한다.
-- ETF 상세/목록 자체는 네이버에서 실시간 조회(저장 불필요) — 이 테이블은 역조회 전용.
-- 상위10만 담기에 "주요 보유(major holding)" 신호에 해당 — 소수 비중까지는 담지 않음(네이버가
-- 전체 구성내역 공개 API를 안 줌, KRX PDF는 스크래핑 차단 — CLAUDE.md 참고).
CREATE TABLE IF NOT EXISTS etf_holdings (
  etf_code     TEXT NOT NULL,          -- ETF 종목코드 (예: 069500)
  etf_name     TEXT NOT NULL,          -- ETF 이름 (예: KODEX 200)
  etf_tab_code INT,                    -- 네이버 카테고리 코드 (1 국내지수 / 2 업종·테마 / 3 파생 / 4 해외 / 5 원자재 / 6 채권·금리 / 7 기타)
  stock_code   TEXT NOT NULL,          -- 보유 종목 티커 (6자리, 국내만)
  stock_name   TEXT NOT NULL,          -- 보유 종목명
  weight       NUMERIC,                -- ETF 내 비중(%)
  seq          INT,                    -- ETF 내 보유 순위(1=최대 비중)
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (etf_code, stock_code)
);

-- 역조회 핵심 인덱스: stock_code로 "이 종목을 담은 ETF 전부"를 빠르게 찾는다.
CREATE INDEX IF NOT EXISTS etf_holdings_stock_idx ON etf_holdings (stock_code);

ALTER TABLE etf_holdings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read etf_holdings" ON etf_holdings;
CREATE POLICY "Anyone can read etf_holdings" ON etf_holdings FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role can manage etf_holdings" ON etf_holdings;
CREATE POLICY "Service role can manage etf_holdings" ON etf_holdings FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
