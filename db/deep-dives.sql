-- 심층분석(Deep Dive) — 여러 뉴스 기사를 종합한 장문 게시물 (2026-08-19)
--
-- 배경: 홈이 개별 기사 요약(article_digest) 카드 나열이라 네이버/토스와 구분이 안 되고
-- 방문자에게 수십 건을 각각 읽으라고 요구하는 구조였다. 이 테이블은 "여러 기사를 하나의
-- 테마로 묶어 해설한 글"을 담아 홈의 주인공 자리를 대체한다.
--
-- ⚠️ 유사투자자문업 리스크 — 이 테이블에 들어가는 재료는 issues의 공개 필드뿐이다.
--    analyses / analysis_companies / company_ai_summary(매수후보·신뢰도·상승여력)는
--    db/disable-public-recommendations.sql로 anon 차단된 데이터라 절대 섞지 않는다.
--    본문에 목표가·손절가·상승여력%·신뢰도%·"수혜주" 같은 투자판단 표현도 금지이며,
--    서버(finalizeDeepDiveWrite)가 저장 시점에 한 번 더 거른다.
CREATE TABLE IF NOT EXISTS deep_dives (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,        -- /deep/:slug 딥링크 키 (예: 'ai-datacenter-power-20260819')
  theme TEXT NOT NULL,              -- 테마명 (예: 'AI 데이터센터 전력난')
  title TEXT NOT NULL,              -- 게시물 제목
  deck TEXT,                        -- 부제 1문장 (목록 카드/OG description에 사용)
  sections JSONB,                   -- 본문 [{heading, paragraphs:[...]}]
  ripple_chain JSONB,               -- [{step, reason, confidence}] — 파급 체인 SVG 다이어그램 재료
  sectors JSONB,                    -- [{name, tone:'pos'|'neg'|'neu'}] 관련 테마 섹터
  tickers JSONB,                    -- ['005930.KS', 'NVDA'] 시세 카드용 (추천 아님, 객관적 시세만)
  charts JSONB,                     -- 서버가 실데이터로 채운 차트 스펙 (AI가 숫자를 만들지 않는다)
  source_issue_ids JSONB,           -- 참고문헌 — 근거가 된 issues.id 배열
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deep_dives_published ON deep_dives (published_at DESC);

-- RLS: 이 레포 표준 패턴 — anon은 SELECT만, 쓰기는 service_role(서버 API)만.
ALTER TABLE deep_dives ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read deep_dives" ON deep_dives;
CREATE POLICY "Anyone can read deep_dives" ON deep_dives FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role can manage deep_dives" ON deep_dives;
CREATE POLICY "Service role can manage deep_dives" ON deep_dives FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- 파이프라인 on/off 플래그 (lib/feature-flags.js FEATURE_FLAG_DEFS에도 등록할 것)
INSERT INTO feature_flags (key, enabled) VALUES ('deep_dive', true)
ON CONFLICT (key) DO NOTHING;
