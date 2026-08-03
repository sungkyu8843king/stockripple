-- 코스피200 야간선물(KIS inquire-price) 프리징 감지용 컬럼 추가.
--
-- 배경(2026-08 실측): 이 REST 스냅샷이 몇 시간째 완전히 똑같은 값을 반환하면서 실제
-- 시세와 크게 어긋난 사고가 두 번 있었다. 첫 번째(등락률 +18.79% vs 실제 -4.78%)는
-- api/market-data.js의 fetchKisNightFuture()에 "|등락률| > 10%면 무효 처리" 안전장치를
-- 추가해 막았지만, 두 번째(등락률 -3.72%로 고정, 실제는 -5.4%대까지 하락)는 폭이
-- 10%를 안 넘어서 그 안전장치를 그냥 통과했다 — 값 자체가 얼어붙었는지를 별도로
-- 감지해야 한다.
--
-- night_future_last_price/last_change: 마지막으로 "값이 바뀐 시점"의 price/changePercent.
-- night_future_last_seen_at: 그 값이 마지막으로 바뀐 시각(같은 값이 계속 오면 갱신 안 함) —
-- 이 시각과 지금의 차이로 "몇 분째 그대로인지"를 잰다. kr-market.html이 3분 간격으로
-- 자동 새로고침하므로(setInterval 180000ms) 임계값은 그보다 넉넉히(코드에서 7분) 잡는다.
ALTER TABLE kis_token_cache
  ADD COLUMN IF NOT EXISTS night_future_last_price numeric,
  ADD COLUMN IF NOT EXISTS night_future_last_change numeric,
  ADD COLUMN IF NOT EXISTS night_future_last_seen_at timestamptz;
