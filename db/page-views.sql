-- 방문자 애널리틱스 (일자별/시간별 접속자, 체류시간, 유입경로, 이동경로) — 어드민 전용
-- 클라이언트(anon)는 이 테이블을 절대 직접 건드리지 않는다 — 기록/조회 모두
-- /api/admin(action=track / action=analytics)을 거쳐 서버(service role)로만 처리한다.
CREATE TABLE IF NOT EXISTS page_views (
  id BIGSERIAL PRIMARY KEY,
  view_id TEXT NOT NULL UNIQUE,       -- 클라이언트 생성 UUID — 이탈 시 체류시간 매칭 키
  session_id TEXT NOT NULL,           -- 브라우저 탭 세션(sessionStorage) — 이동경로 재구성용
  path TEXT NOT NULL,
  referrer TEXT,
  referrer_host TEXT,                 -- 파싱된 호스트명 (직접 방문이면 NULL)
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  dwell_ms INT,                       -- 페이지 이탈 시 beacon으로 채워짐 (못 받으면 NULL로 남음)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_page_views_created ON page_views(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_views_session ON page_views(session_id, created_at);

ALTER TABLE page_views ENABLE ROW LEVEL SECURITY;
-- 정책을 하나도 만들지 않음 = anon/authenticated는 이 테이블에 전혀 접근 불가.
-- service_role은 RLS를 우회하므로 서버(백엔드)는 정상적으로 읽고 쓸 수 있다.
