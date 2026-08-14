-- company_ai_summary에 기술적 분석 서술(technical_read) 컬럼 추가.
-- RSI14/SMA20·50·200 실측값(lib/technicals.js, /api/technicals과 동일 계산)을 근거로
-- AI가 쓴 1~2문장 해설 — 매수/매도 권유·목표가 없이 지표 사실만 서술.
-- 실행 전엔 api/admin.js의 finalizeCompanySummary/handleSummary가 이 컬럼 없이도
-- fail-open으로 동작(다른 필드는 정상 저장/조회, technical_read만 빈 문자열).
ALTER TABLE company_ai_summary ADD COLUMN IF NOT EXISTS technical_read TEXT;
