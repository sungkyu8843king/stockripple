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

-- ── 초기 seed (2026-07 기준, 웹 검증 후 입력) ──
-- 원칙: 공식/복수 언론으로 확인된 날짜만 event_date로 박고, 엇갈리거나 미확정이면
--       event_date NULL + date_text에 불확실성 명시 (추측 날짜 창작 금지).
INSERT INTO catalysts (market, ticker, company, title, category, event_date, date_text, importance, source, note, origin, dedupe_key)
VALUES
  -- ✅ 확정: FDA PDUFA 목표일 2026-07-23 (Elevar/HLB 재심사 수리, 종양학 매체 다수 보도)
  ('KR','028300.KQ','HLB','HLB 리보세라닙 간암 1차 치료제 FDA 심사 결과','FDA', '2026-07-23', '7월 23일 (FDA PDUFA)', 3,
   'FDA PDUFA 목표일 / Elevar Therapeutics(HLB 자회사)',
   '리보세라닙+캄렐리주맙 병용 1L HCC; PDUFA 2026-07-23. 앞서 CRL 2회(2024-05, 2025-03) 후 3번째 심사 — K-bio 최대 이벤트', 'seed', 'seed:hlb-fda-2026q3'),
  -- ✅ 확정(잠정): 7/10 상장 목표, 티커 SKHY (2026-06-24 이사회 결의, CNBC·KED Global). SEC 승인·시황 따라 변동 가능
  ('KR','000660.KS','SK하이닉스','SK하이닉스 나스닥 ADR 상장 (SKHY)','IPO', '2026-07-10', '7월 10일 (잠정)', 3,
   '2026-06-24 이사회 결의 / CNBC·KED Global 보도',
   '~$29B(45.5조원) 신주 ADR, 티커 SKHY. SEC 승인·시황 따라 일정 변동 가능', 'seed', 'seed:skhynix-nasdaq-2026'),
  -- ⚠️ 미확정: 잠정실적일 7/7설 다수 vs 7/24설 혼재 → 날짜 단정 안 함(event_date NULL). 정식 실적은 7/23
  ('KR','005930.KS','삼성전자','삼성전자 2분기 잠정실적 발표','실적', NULL, '7월 초 잠정 (7/7 유력·7/24설 혼재)', 3,
   '언론 보도 상충 — 공식 IR 확인 필요',
   '분기말 후 통상 영업일 5일 내 잠정 공시. 7/7설 다수·7/24설 일부. 정식 실적발표 7/23. HBM/파운드리 회복·가이던스 주목', 'seed', 'seed:samsung-2q-prelim-2026')
ON CONFLICT (dedupe_key) DO NOTHING;
