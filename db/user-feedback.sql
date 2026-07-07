-- 사용자 피드백 (랜딩 페이지 챗봇 위젯에서 수집, 어드민 패널에서 확인)
CREATE TABLE IF NOT EXISTS user_feedback (
  id BIGSERIAL PRIMARY KEY,
  category TEXT DEFAULT 'other',      -- bug | feature | design | other
  message TEXT NOT NULL,
  contact TEXT,                       -- 선택 입력한 이메일
  page TEXT,                          -- 제출 당시 경로 (location.pathname)
  status TEXT DEFAULT 'new',          -- new | reviewed | planned | done | rejected
  admin_note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON user_feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON user_feedback(status);

ALTER TABLE user_feedback ENABLE ROW LEVEL SECURITY;

-- 익명 제출은 허용하되 SELECT는 만들지 않는다 — anon key로 다른 사용자의 피드백을
-- 읽을 수 있으면 안 되므로 (조회는 서버가 SUPABASE_SERVICE_KEY로 어드민 패널에서만 수행,
-- RLS를 우회하는 service role 클라이언트라 이 정책과 무관하게 항상 조회 가능함).
CREATE POLICY "feedback_insert" ON user_feedback FOR INSERT TO anon, authenticated WITH CHECK (true);
