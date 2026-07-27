-- 히트맵 트리맵 박스 크기(시가총액 = 실시간가 × 상장주식수) 계산용 상장주식수 캐시.
-- Yahoo v8 chart에는 시총도 주식수도 없고 Yahoo v7·FMP는 차단돼 있어, Toss meta가 주는
-- sharesOutstanding을 주기적으로 크롤해 저장한다. 주식수는 분기 단위로만 바뀌므로
-- 매일 긁을 필요가 없다 — cron이 7일 이상 오래된 경우에만 갱신한다.
CREATE TABLE IF NOT EXISTS shares_outstanding (
  ticker TEXT PRIMARY KEY,          -- 히트맵 티커 표기 그대로 (예: AAPL, 005930.KS, BRK-B)
  shares BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shares_outstanding_updated ON shares_outstanding(updated_at);

ALTER TABLE shares_outstanding ENABLE ROW LEVEL SECURITY;
-- 공개 정보(발행주식수)라 anon 읽기 허용 — 투자판단 데이터가 아니므로 노출 게이트 대상 아님.
DROP POLICY IF EXISTS "Anyone can read shares_outstanding" ON shares_outstanding;
CREATE POLICY "Anyone can read shares_outstanding" ON shares_outstanding FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role can manage shares_outstanding" ON shares_outstanding;
CREATE POLICY "Service role can manage shares_outstanding" ON shares_outstanding FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
