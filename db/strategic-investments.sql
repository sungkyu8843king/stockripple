-- ═══════════════════════════════════════════════════════════════
-- 전략적 투자/지분 자동 누적 테이블
-- - 일일 cron이 뉴스 분석 후 AI로 "X가 Y에 투자/인수" 패턴 추출 → 여기 저장
-- - lib/strategic-investments.js의 하드코딩 큐레이션과 합쳐서 사용
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS strategic_investments (
  id                BIGSERIAL PRIMARY KEY,
  investor_ticker   TEXT NOT NULL,                       -- 투자한 상장사 티커 (예: 017670.KS, GOOGL)
  investor_name     TEXT,                                -- 투자한 회사명 (예: SK텔레콤)
  target_name       TEXT NOT NULL,                       -- 투자 대상 (상장/비상장 무관, 예: Anthropic)
  theme             TEXT NOT NULL,                       -- 테마 (AI, 로봇, 우주, 바이오 등)
  detail            TEXT NOT NULL,                       -- 한 줄 설명
  stake_info        TEXT,                                -- 지분율/투자금 (예: $100M, 15%)
  highlight         BOOLEAN DEFAULT FALSE,               -- 핵심 연결 여부 (⭐)
  confidence        INT DEFAULT 70,                      -- AI 추출 신뢰도 0-100
  source_issue_id   UUID REFERENCES issues(id) ON DELETE SET NULL,
  source_url        TEXT,                                -- 원문 URL
  source_title      TEXT,                                -- 원문 제목
  extracted_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_seen_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),  -- 같은 사실이 다시 등장한 마지막 시점
  seen_count        INT DEFAULT 1,                       -- 추출 누적 횟수 (반복될수록 신뢰↑)
  status            TEXT DEFAULT 'active',               -- active / superseded / rejected
  -- 중복 방지 키
  CONSTRAINT uniq_investor_target UNIQUE(investor_ticker, target_name)
);

CREATE INDEX IF NOT EXISTS idx_strat_inv_ticker ON strategic_investments(investor_ticker);
CREATE INDEX IF NOT EXISTS idx_strat_inv_status ON strategic_investments(status);
CREATE INDEX IF NOT EXISTS idx_strat_inv_extracted ON strategic_investments(extracted_at DESC);

-- RLS
ALTER TABLE strategic_investments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read strategic_investments"
  ON strategic_investments FOR SELECT
  USING (status = 'active');

CREATE POLICY "Service role can manage strategic_investments"
  ON strategic_investments FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
