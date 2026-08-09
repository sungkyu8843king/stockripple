-- 아침 브리핑(텔레그램) 발송 기록 — 하루 한 번만 나가게 하는 멱등 가드용.
--
-- 왜 필요한가: 발송 트리거가 매시간 도는 GitHub Actions(analyze-backlog.yml)다.
-- "KST 08시대에만 보낸다"는 시간창만으로도 대개 하루 1회지만, GitHub 스케줄은 밀리거나
-- 중복 실행되는 일이 있어서(이 레포에서 실제로 겪음 — CLAUDE.md의 catch-up 패턴 항목)
-- 시간창만 믿으면 같은 날 두 번 보내는 사고가 난다. 구독자에게 중복 발송은 즉시 이탈 사유라
-- 서버 쪽에 마지막 발송 날짜를 남겨 확실히 막는다.
--
-- ⚠️ 이 마이그레이션을 실행하기 전에도 기능은 동작한다 — 핸들러가 테이블 없음을 감지하면
-- 시간창 가드만으로 fail-open 한다(이 레포의 다른 신선도 가드와 같은 원칙). 다만 그 상태에선
-- 중복 발송 위험이 남으므로 되도록 실행할 것.
CREATE TABLE IF NOT EXISTS morning_brief_state (
  id           SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- 단일 행만 허용
  last_sent_kst DATE,          -- 마지막으로 발송한 KST 날짜
  last_sent_at  TIMESTAMPTZ,
  recipients    INT,           -- 그때 보낸 대상 수(운영 확인용)
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO morning_brief_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 발송 이력은 운영 정보라 공개하지 않는다 — service_role(서버 API)만 접근.
-- (kis_token_cache와 같은 처리. 다른 캐시 테이블처럼 anon 읽기 정책을 두지 않는다.)
ALTER TABLE morning_brief_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role can manage morning_brief_state" ON morning_brief_state;
CREATE POLICY "Service role can manage morning_brief_state" ON morning_brief_state FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
