-- 🎯 "AI 이겨보기" — 개장 전 코스피 방향 맞히기 게임 (2026-08-09)
--
-- 왜 개별 종목이 아니라 지수인가:
--   1) 유사투자자문업 리스크. 특정 종목의 등락을 놓고 게임을 만들면 그 종목에 대한
--      의견 제시로 읽힐 소지가 있다. 지수 방향은 시장 전체에 대한 것이라 훨씬 안전하다.
--   2) 모두가 같은 문제를 풀어야 리더보드가 의미를 갖는다.
--
-- 하루 한 번, 사용자당 한 행. 제출 시점의 AI 추정 방향을 함께 박아둔다(ai_pick/ai_est_pct)
-- — 나중에 모델이 갱신돼도 "그때 AI는 이렇게 봤다"가 바뀌면 대결이 성립하지 않기 때문.
-- (분석 공유 이미지 카드·채팅 모투 첨부와 같은 '스냅샷' 원칙.)
CREATE TABLE IF NOT EXISTS predictions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_date  DATE NOT NULL,                                  -- 대상 거래일(KST)
  pick          TEXT NOT NULL CHECK (pick IN ('up', 'down')),   -- 사용자의 예측
  ai_pick       TEXT CHECK (ai_pick IN ('up', 'down')),         -- 제출 시점 AI 추정 방향(스냅샷)
  ai_est_pct    NUMERIC,                                        -- 제출 시점 AI 추정 등락률
  actual_pct    NUMERIC,                                        -- 채점 후 실제 코스피 등락률
  correct       BOOLEAN,                                        -- 채점 후
  ai_correct    BOOLEAN,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  scored_at     TIMESTAMPTZ,
  UNIQUE (user_id, session_date)                                -- 하루 한 번, 재제출 불가
);

CREATE INDEX IF NOT EXISTS idx_predictions_session ON predictions(session_date DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_user    ON predictions(user_id, session_date DESC);

-- RLS: 남의 예측은 못 본다. 리더보드는 서버(service_role)가 집계해서 순위·닉네임만 내려준다
-- — 이렇게 해야 "누가 뭘 찍었는지"가 장중에 새어나가지 않는다(그게 새면 게임이 깨진다).
ALTER TABLE predictions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own predictions" ON predictions;
CREATE POLICY "Users read own predictions" ON predictions FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users insert own predictions" ON predictions;
CREATE POLICY "Users insert own predictions" ON predictions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 수정/삭제 정책은 일부러 만들지 않는다 — 한 번 찍으면 못 바꾸는 게 이 게임의 규칙이고,
-- 정책이 없으면 anon/authenticated는 UPDATE/DELETE가 전부 막힌다. 채점은 service_role이 한다.
DROP POLICY IF EXISTS "Service role can manage predictions" ON predictions;
CREATE POLICY "Service role can manage predictions" ON predictions FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
