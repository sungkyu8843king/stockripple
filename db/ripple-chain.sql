-- 2026-08 "AI 투자 시나리오" 기능. 기존 ripple_effects는 뉴스 → 섹터 2~4개(형제 관계,
-- 순서 없음)인 평평한 목록이라, "뉴스 → 우라늄 → 원전 EPC → 변압기 → ... → 관련 종목" 같은
-- 순차적 인과 사슬은 표현할 수 없었다. 이 컬럼은 그 순서 있는 체인을 저장한다.
-- 각 원소 형태: { step, reason, confidence: 'high'|'medium'|'low', companies: [...] }
-- (api/analyze.js의 rippleChain 프롬프트/파서 참고). 인과관계가 뚜렷하지 않으면 빈 배열([]).
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS ripple_chain JSONB NOT NULL DEFAULT '[]'::jsonb;
