-- 사이트 전체 상단에 노출하는 긴급 안내 배너 — 싱글턴 행(id=1) 하나만 사용.
CREATE TABLE IF NOT EXISTS site_announcement (
  id INT PRIMARY KEY DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT false,
  message TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (id = 1)
);
INSERT INTO site_announcement (id, active, message)
VALUES (1, false, '')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE site_announcement ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read site_announcement" ON site_announcement FOR SELECT USING (true);
CREATE POLICY "Service role can manage site_announcement" ON site_announcement FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
