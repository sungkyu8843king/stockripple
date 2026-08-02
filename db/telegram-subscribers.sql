-- 2026-08-02 텔레그램 봇 공개 구독 — 사이트 회원가입 없이 봇에 /start만 보내면
-- 구독되는 불특정 다수용 테이블. 기존 user_settings.telegram_chat_id(로그인 계정에
-- 수동으로 Chat ID를 붙여넣는 방식, account.html)와는 별개 경로 — 둘 다 유지하고
-- 발송 시(api/admin.js notifyReportSubscribers) chat_id 기준으로 합쳐서 중복 제거한다.
CREATE TABLE IF NOT EXISTS telegram_subscribers (
  chat_id    BIGINT PRIMARY KEY,
  username   TEXT,                       -- 텔레그램 @username (없을 수 있음, 참고용)
  active     BOOLEAN NOT NULL DEFAULT true, -- /stop 보내면 false (행 삭제 대신 보존 — 재구독 이력 참고용)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE telegram_subscribers ENABLE ROW LEVEL SECURITY;
-- anon 정책 없음(webhook/발송 둘 다 서버의 service_role로만 접근) — 의도적으로 공개 정책 없음.
DROP POLICY IF EXISTS "Service role manages telegram_subscribers" ON telegram_subscribers;
CREATE POLICY "Service role manages telegram_subscribers" ON telegram_subscribers FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
