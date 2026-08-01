-- etf_snapshot에 운용사(issuer_name) 컬럼 추가 — 네이버 etfAnalysis 응답의 issuerName
-- (예: "삼성자산운용(ETF)")을 crawl-etf-holdings가 어차피 이미 호출하는 김에 같이 저장.
-- ETF 목록 화면에 운용사 표시(2026-08-01, 피드백: "현재가·등락률·3개월 외에 운용사나
-- 다른것들 추가해줘") — 별도 API 호출 비용 없음.
ALTER TABLE etf_snapshot ADD COLUMN IF NOT EXISTS issuer_name TEXT;
