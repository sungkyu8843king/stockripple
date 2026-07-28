-- 관리자가 직접 입력하는 실적 발표 실제 수치 — Nasdaq 캘린더 API가 방금 나온 실적의
-- 실제 EPS를 며칠씩 늦게 반영하는 경우가 있어(실측, 2026-07-29 — BA/KO/SPGI 등 장전 발표
-- 당일 오전에도 캘린더에 eps 필드가 비어 있었음), 그 사이 "발표 예정"에서는 빠지고
-- "발표 완료"에도 안 뜨는 사각지대가 생긴다. 관리자가 실제 발표 수치를 직접 넣으면
-- api/market-data.js handleEarningsCalendar가 Nasdaq 데이터와 병합(같은 symbol+날짜면
-- 관리자 입력이 우선)해서 즉시 "발표 완료"에 반영한다.
CREATE TABLE IF NOT EXISTS earnings_manual (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT,
  report_date DATE NOT NULL,
  time TEXT,                 -- 'BMO' | 'AMC' | NULL
  eps_actual NUMERIC,
  eps_estimate NUMERIC,
  surprise_pct NUMERIC,       -- NULL이면 eps_actual/eps_estimate로 서버가 자동 계산
  market_cap NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, report_date)
);
CREATE INDEX IF NOT EXISTS idx_earnings_manual_date ON earnings_manual(report_date);

ALTER TABLE earnings_manual ENABLE ROW LEVEL SECURITY;
-- 실적 수치 자체는 공개 정보라 anon 읽기 허용(투자판단 데이터가 아니므로 노출 게이트 대상 아님).
DROP POLICY IF EXISTS "Anyone can read earnings_manual" ON earnings_manual;
CREATE POLICY "Anyone can read earnings_manual" ON earnings_manual FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role can manage earnings_manual" ON earnings_manual;
CREATE POLICY "Service role can manage earnings_manual" ON earnings_manual FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
