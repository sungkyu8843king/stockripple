-- ═══════════════════════════════════════════════════════════════════
-- est_accuracy — "해외 실시간 추정가" 모델의 실측 정확도 기록
--
-- 왜 필요한가: 해외 신호(EWY/ADR/SOX)로 국장 재개장가를 역산하는 모델은
-- 본질적으로 오차가 크다(2026-07-31 실측: 삼성전자 추정 +9.5% vs 실제 +21.7%).
-- 감으로 beta/가중치를 고치면 그날 하루에 과적합되므로, 매 개장일마다
-- "추정 → 실제" 쌍을 쌓아 누적 오차를 근거로 조정하려는 목적.
--
-- 흐름: 개장 전(KST 08시대) 스냅샷 기록 → 개장 후 실제 시가로 정산(settle).
--   GET /api/market-data?source=kr-estimate&action=record   (ADMIN/CRON 인증)
--   GET /api/market-data?source=kr-estimate&action=accuracy  (공개 조회)
-- ═══════════════════════════════════════════════════════════════════

create table if not exists est_accuracy (
  id                bigserial primary key,
  ticker            text        not null,           -- '005930.KS'
  session_date      date        not null,           -- 대상 개장일 (KST 기준)
  model_version     text,                           -- EST_MODEL.version — 어느 모델이 낸 값인지
  base_close        numeric,                        -- 추정 기준이 된 직전 종가
  est_change_pct    numeric,                        -- 추정 등락%
  est_price         numeric,                        -- 추정가
  sources           jsonb,                          -- [{id,label,w,beta,value,adj}] 기여 내역
  actual_open       numeric,                        -- 실제 시가 (정산 시 채움)
  actual_change_pct numeric,                        -- 실제 등락% (시가 기준)
  error_pct         numeric,                        -- actual_change_pct - est_change_pct (%p, 양수면 과소추정)
  recorded_at       timestamptz not null default now(),
  settled_at        timestamptz,
  unique (ticker, session_date)
);

create index if not exists est_accuracy_date_idx   on est_accuracy (session_date desc);
create index if not exists est_accuracy_ticker_idx on est_accuracy (ticker, session_date desc);
-- 정산 대기(=아직 실제 시가가 안 채워진) 행만 빠르게 찾기
create index if not exists est_accuracy_unsettled_idx on est_accuracy (session_date) where settled_at is null;

-- RLS: 이 레포 표준 패턴 — anon은 읽기만, 쓰기는 service_role(서버 API)만.
-- 추정 정확도는 투자판단 데이터가 아니라 모델 성능 지표라 expose_ripple_effects 게이트 대상이 아니다.
alter table est_accuracy enable row level security;

drop policy if exists "est_accuracy anon read" on est_accuracy;
create policy "est_accuracy anon read" on est_accuracy for select to anon using (true);
