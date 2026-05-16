-- user_watchlist: 사용자별 관심종목 (localStorage 대체)
CREATE TABLE IF NOT EXISTS user_watchlist (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker    TEXT NOT NULL,
  name      TEXT,
  market    TEXT DEFAULT 'US',
  added_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, ticker)
);

-- user_bookmarks: 분석 이슈 북마크
CREATE TABLE IF NOT EXISTS user_bookmarks (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  issue_id  UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  added_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, issue_id)
);

-- user_settings: 사용자 알림 설정
CREATE TABLE IF NOT EXISTS user_settings (
  user_id               UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  telegram_chat_id      TEXT,
  notify_new_analysis   BOOLEAN DEFAULT TRUE,
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- RLS 활성화
ALTER TABLE user_watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings  ENABLE ROW LEVEL SECURITY;

-- 각 테이블: 본인 데이터만 CRUD
CREATE POLICY "watchlist_own" ON user_watchlist FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "bookmarks_own" ON user_bookmarks FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "settings_own" ON user_settings FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
