-- 예정 catalyst 레지스트리 — 아직 뉴스로 안 터진 forward 이벤트를 담아 리포트가 미리 surface
-- (FDA 심사, 상장/ADR, 지수 편입, 실적 예정, 정책 시행 등). seed(수동) + AI 자동 추출 혼합.
CREATE TABLE IF NOT EXISTS catalysts (
  id BIGSERIAL PRIMARY KEY,
  market TEXT NOT NULL CHECK (market IN ('KR','US','GLOBAL')),
  ticker TEXT,
  company TEXT,
  title TEXT NOT NULL,
  category TEXT,                 -- FDA / IPO / 실적 / 편입 / 정책 / M&A / 기타
  event_date DATE,              -- 확정일이 있으면 (없으면 NULL, date_text 사용)
  date_text TEXT,               -- 퍼지 시점: "7월 중순~말", "2분기 잠정", "하반기(추진)"
  importance INT DEFAULT 2,     -- 1(보통) 2(중요) 3(marquee, 리드 후보)
  status TEXT DEFAULT 'upcoming' CHECK (status IN ('upcoming','passed','cancelled')),
  source TEXT,
  note TEXT,
  origin TEXT DEFAULT 'seed' CHECK (origin IN ('seed','ai')),
  dedupe_key TEXT UNIQUE,       -- AI upsert 중복 방지 키 (code에서 생성)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_catalysts_lookup ON catalysts(status, market, importance DESC, event_date);

ALTER TABLE catalysts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read catalysts" ON catalysts;
CREATE POLICY "Anyone can read catalysts" ON catalysts FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role can manage catalysts" ON catalysts;
CREATE POLICY "Service role can manage catalysts" ON catalysts FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- daily_reports 에 리포트별 '다가오는 핵심 catalyst' 섹션 컬럼 추가
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS catalysts JSONB;

-- ── 초기 seed (2026-07 기준, 사용자가 지목한 대형 catalyst) ──
-- 날짜가 확정 아닌 건 event_date NULL + date_text 퍼지 표기 (추측 날짜 창작 금지)
INSERT INTO catalysts (market, ticker, company, title, category, event_date, date_text, importance, source, note, origin, dedupe_key)
VALUES
  ('KR','028300.KQ','HLB','HLB 리보세라닙 간암 1차 치료제 FDA 재심사 결과','FDA', NULL, '7월 중순~말', 3,
   'seed', '리보세라닙+캄렐리주맙 병용요법, 앞선 CRL(보완요구) 이후 재심사 — K-bio 최대 이벤트', 'seed', 'seed:hlb-fda-2026q3'),
  ('KR','000660.KS','SK하이닉스','SK하이닉스 나스닥 ADR 상장 추진','IPO', NULL, '2026 하반기(추진)', 3,
   'seed', 'HBM/AI 메모리 수요 속 미국 상장 추진 — 국내 반도체 대장주 리레이팅 이슈', 'seed', 'seed:skhynix-nasdaq-2026'),
  ('KR','005930.KS','삼성전자','삼성전자 2분기 잠정실적 발표','실적', NULL, '7월 초 (잠정)', 3,
   'seed', 'HBM/파운드리 회복 여부·가이던스 주목 — 국장 최대 대장주', 'seed', 'seed:samsung-2q-prelim-2026')
ON CONFLICT (dedupe_key) DO NOTHING;
