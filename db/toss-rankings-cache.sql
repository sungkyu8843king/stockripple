-- 토스증권 공식 API "실시간 랭킹"(홈 화면 rankings-all) 마지막 성공 응답 캐시 — market당 1행.
-- 토스 API는 GCP e2-micro(1vCPU/1GB) 무료 VM을 고정 IP 프록시로 경유하는데, 이 VM이
-- 순간 과부하로 무응답(502 "toss proxy unreachable")이 되는 경우가 실측됨(2026-07-19).
-- 재시도(callTossProxy retries=1)로도 못 살리면 이 캐시의 마지막 성공 데이터를 stale로
-- 대신 보여줘서 "실시간 랭킹 — 데이터가 없어요"로 완전히 비는 것보다 낫게 만드는 용도.
CREATE TABLE IF NOT EXISTS toss_rankings_cache (
  market TEXT PRIMARY KEY CHECK (market IN ('KR', 'US')),
  categories JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE toss_rankings_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "toss_rankings_cache_select_anon" ON toss_rankings_cache;
CREATE POLICY "toss_rankings_cache_select_anon" ON toss_rankings_cache
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "toss_rankings_cache_write_service" ON toss_rankings_cache;
CREATE POLICY "toss_rankings_cache_write_service" ON toss_rankings_cache
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
