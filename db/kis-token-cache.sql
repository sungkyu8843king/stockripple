-- KIS(한국투자증권) OAuth access_token 캐시 — 발급이 하루 단위로 제한되는 API라
-- Vercel 서버리스(요청마다 프로세스가 새로 뜸)에서 매 요청 재발급하면 금방 막힌다.
-- 단일 행(id=1)만 쓰고, 만료 전까지 이 값을 재사용한다.
-- night_future_code/night_future_code_updated_at: 코스피200 야간선물 근월물 종목코드
-- 캐시(분기 만기 롤오버라 매번 마스터파일을 새로 받을 필요 없이 하루 단위로만 갱신).
CREATE TABLE IF NOT EXISTS kis_token_cache (
  id          int PRIMARY KEY DEFAULT 1,
  access_token text,
  expires_at   timestamptz,
  night_future_code text,
  night_future_code_updated_at timestamptz,
  updated_at   timestamptz DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);

ALTER TABLE kis_token_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only" ON kis_token_cache;
CREATE POLICY "Service role only" ON kis_token_cache FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
-- 토큰 자체는 민감정보라 anon 읽기도 막는다(다른 캐시 테이블들과 달리 공개 정책 없음).
