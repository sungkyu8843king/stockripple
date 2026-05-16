-- StockRipple DB Schema
-- Supabase SQL Editor에서 실행

-- 이슈 (뉴스/이슈)
CREATE TABLE IF NOT EXISTS issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  summary TEXT,
  source_url TEXT,
  source_name TEXT,
  published_at TIMESTAMPTZ,
  sectors TEXT[] DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  is_analyzed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- AI 분석 결과
CREATE TABLE IF NOT EXISTS analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID REFERENCES issues(id) ON DELETE CASCADE,
  direct_sectors TEXT[] DEFAULT '{}',
  ripple_effects JSONB DEFAULT '[]',
  ai_summary TEXT,
  confidence_score INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 기업 정보
CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker TEXT NOT NULL UNIQUE,
  name_ko TEXT,
  name_en TEXT,
  market TEXT DEFAULT 'US',
  sector TEXT,
  market_cap BIGINT,
  current_price DECIMAL(15,2),
  currency TEXT DEFAULT 'USD',
  price_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 분석-기업 연결 (파급효과별 수혜 기업)
CREATE TABLE IF NOT EXISTS analysis_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id UUID REFERENCES analyses(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  ripple_sector TEXT,
  rationale TEXT,
  upside_pct DECIMAL(5,2),
  confidence INT DEFAULT 50,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_issues_published_at ON issues(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_is_analyzed ON issues(is_analyzed);
CREATE INDEX IF NOT EXISTS idx_analyses_issue_id ON analyses(issue_id);
CREATE INDEX IF NOT EXISTS idx_analysis_companies_analysis_id ON analysis_companies(analysis_id);

-- RLS 비활성화 (또는 allow_all 정책)
ALTER TABLE issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_companies ENABLE ROW LEVEL SECURITY;

CREATE POLICY allow_all_issues ON issues FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY allow_all_analyses ON analyses FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY allow_all_companies ON companies FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY allow_all_analysis_companies ON analysis_companies FOR ALL USING (true) WITH CHECK (true);
