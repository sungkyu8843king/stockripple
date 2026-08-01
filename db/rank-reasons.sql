-- 홈 실시간 랭킹(인기/거래대금/거래량/급상승/급하락) 종목별 "왜 이 순위에 있는지" 짧은 사유.
-- 뉴스 제목 매칭(기존 ai_digest 폴백)은 무관한 종목에 엉뚱한 문구가 붙는 문제가 있어(2026-07-22),
-- 랭킹 지표(등락률/거래대금/거래량) 자체를 근거로 AI가 판단하는 전용 파이프라인으로 대체한다.
-- 투자판단 없는 순수 사실 서술만 담는다 — analysis_companies와 무관, 유사투자자문업 리스크 없음.
CREATE TABLE IF NOT EXISTS rank_reasons (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,          -- linkTicker 형식 그대로 (예: 005930.KS, AAPL)
  market TEXT NOT NULL CHECK (market IN ('KR','US')),
  category TEXT NOT NULL CHECK (category IN ('popular','amount','volume','gainers','losers')),
  reason TEXT NOT NULL,          -- 30자 이내 한국어 사유 (빈 문자열 = 근거 부족으로 판단 보류)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rank_reasons_key ON rank_reasons(ticker, market, category);

ALTER TABLE rank_reasons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read rank_reasons" ON rank_reasons;
CREATE POLICY "Anyone can read rank_reasons" ON rank_reasons FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role can manage rank_reasons" ON rank_reasons;
CREATE POLICY "Service role can manage rank_reasons" ON rank_reasons FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
