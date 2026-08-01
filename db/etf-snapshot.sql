-- ETF 스냅샷 — 네이버 ETF 목록 API(etfItemList)엔 없는 지표(총보수·추적오차·순자산·자금유입)를
-- 저장해두는 테이블. crawl-etf-holdings가 어차피 종목당 etfAnalysis를 이미 불러오므로
-- 그 응답에서 추가 필드만 더 뽑아 같이 upsert — 별도 API 호출 비용 없음.
-- 랭킹(신규 유입 상위/최저 보수/순자산 최대)에 사용. 실시간 등락률·3개월수익률·거래대금은
-- 목록 API에서 항상 라이브로 가져오므로 여기 저장하지 않는다(중복 방지, 최신성 보장).
CREATE TABLE IF NOT EXISTS etf_snapshot (
  code            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  tab_code        INT,
  total_fee       NUMERIC,      -- 총보수(%), 이미 % 단위
  tracking_error  NUMERIC,      -- 추적오차(%)
  deviation_rate  NUMERIC,      -- 괴리율(%)
  market_value_won NUMERIC,     -- 순자산총액(원) — "11조 5,043억" 파싱한 숫자
  net_inflow_1d_won NUMERIC,    -- 1일 누적 순유입(원)
  net_inflow_1w_won NUMERIC,    -- 1주 누적 순유입(원)
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE etf_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read etf_snapshot" ON etf_snapshot;
CREATE POLICY "Anyone can read etf_snapshot" ON etf_snapshot FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role can manage etf_snapshot" ON etf_snapshot;
CREATE POLICY "Service role can manage etf_snapshot" ON etf_snapshot FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
