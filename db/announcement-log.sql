-- 긴급 안내 배너 발동 이력 (자동/수동, 시작·종료 시각) — 어드민 조회용.
-- 배너가 켜질 때마다 새 행을 만들고(ended_at=NULL), 꺼질 때 그 행의 ended_at을 채운다.
CREATE TABLE IF NOT EXISTS announcement_log (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,               -- 'manual' | 'auto'
  message TEXT,
  source_issue_id UUID,               -- auto인 경우 어떤 이슈가 트리거했는지
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ                -- NULL이면 현재 노출 중
);
CREATE INDEX IF NOT EXISTS idx_announcement_log_started ON announcement_log(started_at DESC);

ALTER TABLE announcement_log ENABLE ROW LEVEL SECURITY;
-- 정책 없음 = anon 접근 불가, service_role(서버)만 읽고 씀.

-- 자동 배너 만료 시각 — 서킷브레이커/사이드카 등은 짧게 끝나므로 자동으로 켠
-- 배너는 이 시각이 지나면 스스로 사라진다 (아래 auto_expires_at). 수동 배너는 NULL로 두어
-- 관리자가 직접 끌 때까지 유지.
ALTER TABLE site_announcement ADD COLUMN IF NOT EXISTS auto_expires_at TIMESTAMPTZ;
