-- 경제지표 캘린더(ForexFactory+FMP) 응답 캐시 — 단일 행(id=1)만 사용.
-- FMP 무료 플랜 250콜/일 한도를 반복 호출(스케줄 에이전트 매일 1:15 등)이 순식간에
-- 태우는 걸 막기 위해, api/market-data.js의 handleEconomic이 이 테이블을 30분 캐시로 쓴다.
-- 소스가 완전히 죽었을 때도(2026-07-16 실측: FMP 한도초과) 오래된 캐시라도 돌려줘서
-- "지표 섹션이 아예 텅 빔"보다 낫게 만드는 용도도 겸함.
CREATE TABLE IF NOT EXISTS econ_calendar_cache (
  id INT PRIMARY KEY DEFAULT 1,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  source TEXT,
  fmp JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT econ_calendar_cache_single_row CHECK (id = 1)
);

ALTER TABLE econ_calendar_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "econ_calendar_cache_select_anon" ON econ_calendar_cache;
CREATE POLICY "econ_calendar_cache_select_anon" ON econ_calendar_cache
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "econ_calendar_cache_write_service" ON econ_calendar_cache;
CREATE POLICY "econ_calendar_cache_write_service" ON econ_calendar_cache
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
