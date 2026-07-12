-- catalysts AI 추출(handleCatalystsPost)의 "마지막으로 시도한 시각" 추적용 싱글턴 행.
-- 기존엔 신선도 가드가 전혀 없어서 매시간 크론(analyze-backlog.yml)이 호출될 때마다
-- 무조건 최근 14일 뉴스로 Claude를 호출했음(방문자/신규 기사 유무와 무관한 상시 비용).
-- catalysts 테이블 자체의 최신 row로는 판단 불가 — AI가 "새로 뽑을 게 없다"고 판단하면
-- 새 row가 안 생기므로 "언제 마지막으로 시도했는지"를 별도로 기록해야 함.
CREATE TABLE IF NOT EXISTS catalysts_extraction_state (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  last_extracted_at TIMESTAMPTZ,
  CONSTRAINT single_row CHECK (id = 1)
);
INSERT INTO catalysts_extraction_state (id, last_extracted_at) VALUES (1, NULL)
  ON CONFLICT (id) DO NOTHING;

ALTER TABLE catalysts_extraction_state ENABLE ROW LEVEL SECURITY;
-- 정책 없음 = anon 접근 불가, service_role(서버)만 읽고 씀.
