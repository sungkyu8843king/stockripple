-- 2026-07 실시간 채팅 (우측 위젯). 회원+비회원 모두 참여.
-- 쓰기: 전부 서버 API(api/feedback.js ?action=chat-send, service_role) 경유 — anon INSERT 정책 없음
--       (레이트리밋/검열을 서버에서 강제하기 위해. 브라우저가 직접 INSERT 못 함).
-- 읽기: anon SELECT 허용 + Supabase Realtime 구독(폴링 아님 — DB 부하 최소).
--       hidden(신고 누적) 메시지도 행 자체는 구독되지만 서버 API가 목록 조회 시 본문을 비우고,
--       클라이언트는 "숨김 처리된 메시지" 플레이스홀더만 표시한다.
CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  sender_key TEXT NOT NULL,                 -- 회원 'u:<user_id>' / 게스트 'g:<로컬랜덤키>' — 신고·차단 식별용
  nickname   TEXT NOT NULL CHECK (char_length(nickname) <= 30),
  is_member  BOOLEAN NOT NULL DEFAULT false,
  message    TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 300),
  hidden     BOOLEAN NOT NULL DEFAULT false, -- 신고 3인 이상 → 임시 숨김(어드민이 해제/확정)
  report_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at DESC);

CREATE TABLE IF NOT EXISTS chat_reports (
  message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  reporter_key TEXT NOT NULL,               -- sender_key와 동일 형식 — 1인 1신고 강제
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, reporter_key)
);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
-- 2026-08-02 보안 점검: hidden=true(신고 누적으로 숨김) 행은 anon에게 아예 안 보이게
-- 좁혔다 — USING (true)였을 땐 원문이 REST 직접조회/Realtime 브로드캐스트로 그대로
-- 샜다(서버/클라이언트는 화면에 그릴 때만 가렸을 뿐, DB 정책 자체는 안 막고 있었음).
-- db/chat-hidden-rls-fix.sql 참고.
DROP POLICY IF EXISTS "Anyone can read chat_messages" ON chat_messages;
CREATE POLICY "Anyone can read chat_messages" ON chat_messages FOR SELECT USING (NOT hidden);
DROP POLICY IF EXISTS "Service role manages chat_messages" ON chat_messages;
CREATE POLICY "Service role manages chat_messages" ON chat_messages FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

ALTER TABLE chat_reports ENABLE ROW LEVEL SECURITY;  -- 정책 없음 = anon 접근 불가(서버 전용)
DROP POLICY IF EXISTS "Service role manages chat_reports" ON chat_reports;
CREATE POLICY "Service role manages chat_reports" ON chat_reports FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Realtime 구독 대상으로 등록 (이미 등록돼 있으면 에러 — 아래 DO 블록이 무시 처리)
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 채팅 on/off 플래그 — 기본 OFF (어드민이 켤 때만 위젯 노출). chat-config API는 행이 없으면
-- 꺼진 것으로 간주(fail-closed — 다른 AI 플래그들의 fail-open과 반대, 의도적).
INSERT INTO feature_flags (key, enabled) VALUES ('chat', false)
ON CONFLICT (key) DO NOTHING;
