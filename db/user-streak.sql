-- 🔥 연속 참여 스트릭 — 로그인 사용자가 투표(issue_votes)/파급 예측(issue_predictions)에
-- 참여한 날짜가 이어지면 연속일수가 오른다. KST 기준 날짜로 비교(site-header.js bumpStreak).
alter table user_profiles add column if not exists streak_days int not null default 0;
alter table user_profiles add column if not exists longest_streak int not null default 0;
alter table user_profiles add column if not exists streak_last_date date;
