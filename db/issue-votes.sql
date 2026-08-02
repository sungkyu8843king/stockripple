-- 뉴스 카드 "군중 vs AI" 투표 — "이 뉴스가 시장/산업에 실제 영향이 있을까"를 묻는 여론조사.
-- 종목 매수/매도 의견이 아니라 뉴스 자체의 영향력에 대한 투표라 유사투자자문업 리스크 밖.
-- voter_key는 sr-pulse.js가 이미 쓰는 localStorage sr_sid(기기당 1개, 로그인 불필요)를 재사용.
create table if not exists issue_votes (
  id bigint generated always as identity primary key,
  issue_id bigint not null references issues(id) on delete cascade,
  voter_key text not null,
  vote text not null check (vote in ('yes', 'no')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (issue_id, voter_key)
);
create index if not exists issue_votes_issue_idx on issue_votes(issue_id);

alter table issue_votes enable row level security;
-- 클라이언트가 anon 키로 직접 upsert(CLAUDE.md 표준 패턴) — 투표 자체가 저위험 기능이라
-- 채팅처럼 서버 경유로 감쌀 필요 없음. unique(issue_id, voter_key)가 중복 투표를 막는다.
create policy "aa_sel" on issue_votes for select to anon, authenticated using (true);
create policy "aa_ins" on issue_votes for insert to anon, authenticated with check (true);
create policy "aa_upd" on issue_votes for update to anon, authenticated using (true) with check (true);
