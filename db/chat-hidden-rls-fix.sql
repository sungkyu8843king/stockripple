-- 보안 점검(2026-08-02)에서 발견: chat_messages의 "숨김(hidden)" 처리는 서버 API/클라이언트
-- 쪽에서만 본문을 가려서 보여줬을 뿐, RLS 정책 자체는 모든 행을 무조건 허용(USING (true))
-- 하고 있었다 — 즉:
--   1) 공개 anon key로 테이블을 직접 조회하면 신고 누적으로 숨김 처리된 메시지 원문이 그대로 보임.
--   2) 메시지가 숨김 처리되는 순간(hidden: false→true) Supabase Realtime UPDATE 이벤트가
--      anon 구독자 전원에게 "새 행 상태 전체"를 브로드캐스트하는데, 여기엔 원문 그대로
--      들어있다(브라우저 devtools 웹소켓 탭에서 그대로 보임) — chat.js의 replaceMsg()가
--      화면에 그릴 때만 지울 뿐, 이미 네트워크로는 나간 뒤다.
-- 숨긴 메시지는 정확히 hidden=false인 것만 anon에게 보이도록 정책을 좁힌다.
-- (부작용: 이미 화면에 떠 있던 메시지가 숨김 처리되는 순간, 그 갱신 이벤트 자체가 더 이상
--  전달되지 않아 이미 열려있던 탭에서는 새로고침 전까지 원문이 그대로 남아있을 수 있다 —
--  다만 원문이 네트워크로 새로 나가지 않는다는 게 핵심이고, 다음 로드 시 handleChatMessages가
--  정상적으로 가려서 내려준다.)
DROP POLICY IF EXISTS "Anyone can read chat_messages" ON chat_messages;
CREATE POLICY "Anyone can read chat_messages" ON chat_messages FOR SELECT USING (NOT hidden);
-- service_role은 이미 있는 "Service role manages chat_messages" 정책(FOR ALL)으로 RLS를
-- 우회하므로, 어드민 모더레이션 패널(handleChatAdmin)은 숨김 메시지도 계속 정상 조회된다.
