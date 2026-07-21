-- 2026-07-21: 순수 기사 요약 기능 (유사투자자문업 리스크와 무관 — 매수/매도·수혜기업·
-- 신뢰도 언급 없이 "이 기사가 무슨 내용인지"만 2~3문장 요약). analyses/analysis_companies와
-- 완전히 별개 — issues 테이블 자체 컬럼이라 RLS(공개 SELECT)도 오늘 건드린 적 없음.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS ai_digest TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS ai_digest_at TIMESTAMPTZ;

-- 이 파이프라인의 on/off 플래그 (feature_flags, lib/feature-flags.js FEATURE_FLAG_DEFS에 등록됨)
INSERT INTO feature_flags (key, enabled) VALUES ('article_digest', true)
ON CONFLICT (key) DO NOTHING;
