-- 뉴스 키포인트 + 섹터 방향성(톤) — article_digest 파이프라인이 요약과 함께 채운다.
-- ⚠️ 이 필드는 analyses/analysis_companies(유사투자자문 리스크로 노출 차단된 테이블)와
--    완전히 무관하다. 특정 종목의 매수/매도를 지정하지 않고, "이 뉴스가 어떤 산업 테마에
--    우호적/비우호적/중립인가"라는 편집성 뉴스 분류만 담는다(신문의 산업 코멘트 수준).
--    그래서 expose_ripple_effects 게이트 대상이 아니며 공개 응답에 담아도 된다.
-- shape: { "keypoints": ["핵심1","핵심2"], "sectors": [{"name":"반도체","tone":"pos|neg|neu"}] }
ALTER TABLE issues ADD COLUMN IF NOT EXISTS news_analysis JSONB;

-- backfill 재선정(news_analysis가 아직 없는 최신 이슈부터)용 인덱스
CREATE INDEX IF NOT EXISTS idx_issues_news_analysis_null
  ON issues (published_at DESC) WHERE news_analysis IS NULL;
