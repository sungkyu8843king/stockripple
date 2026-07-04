-- 주간 일정 (토·일 cron이 다음 주차 경제지표/실적/연준 일정 생성, 사이트에 노출)
CREATE TABLE IF NOT EXISTS weekly_schedule (
  id BIGSERIAL PRIMARY KEY,
  week_start DATE NOT NULL,      -- 해당 주 월요일 (KST)
  week_label TEXT,               -- 예: "2026년 7월 2주 차"
  highlights JSONB,              -- 주요 이벤트 요약 (문자열 배열)
  days JSONB,                    -- [{date, weekday, items:[{time,type,title,stars}]}]
  based_on JSONB,                -- { econ: N, earnings: N }
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS weekly_schedule_week_uniq ON weekly_schedule(week_start);

ALTER TABLE weekly_schedule ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read weekly_schedule" ON weekly_schedule FOR SELECT USING (true);
CREATE POLICY "Service role can manage weekly_schedule" ON weekly_schedule FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
