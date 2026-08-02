-- 🔮 파급 예측 게임 — "AI 분석 공개 전, 이 뉴스가 어디까지 퍼질지" 산업 태그로 먼저
-- 예측하게 한다(analysis.html). 종목 매수/매도 의견이 아니라 "산업 파급" 추측 게임이라
-- 유사투자자문업 리스크 밖. D+1 정산은 새 채점 로직 없이 check-accuracy가 이미 매일 채점해
-- 두는 analysis_companies.actual_return_1d를 클라이언트에서 그대로 읽어 계산한다.
-- predictor_key는 sr-pulse.js가 이미 쓰는 localStorage sr_sid(기기당 1개, 로그인 불필요) 재사용.
create table if not exists issue_predictions (
  id bigint generated always as identity primary key,
  issue_id uuid not null references issues(id) on delete cascade,
  predictor_key text not null,
  sectors text[] not null,
  ai_match_count int not null default 0,
  ai_total_tags int not null default 0,
  created_at timestamptz not null default now(),
  unique (issue_id, predictor_key)
);
create index if not exists issue_predictions_issue_idx on issue_predictions(issue_id);

alter table issue_predictions enable row level security;
create policy "aa_sel" on issue_predictions for select to anon, authenticated using (true);
create policy "aa_ins" on issue_predictions for insert to anon, authenticated with check (true);
create policy "aa_upd" on issue_predictions for update to anon, authenticated using (true) with check (true);
