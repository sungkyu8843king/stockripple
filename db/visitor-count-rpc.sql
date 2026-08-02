-- 채팅 패널 상단 "전체 접속자" 표시용 — page_views 전체 기간 순 방문자 수(session_id distinct)를
-- Postgres에서 한 번에 집계. 앱에서 전체 행을 끌어와 dedup하면(handleAnalytics의 fetchPageViews
-- 패턴) 시간이 지날수록 느려지고 20000행 캡에도 걸리므로, DB 집계 함수로 처리한다.
create or replace function total_unique_visitors()
returns bigint
language sql
stable
as $$
  select count(distinct session_id) from page_views;
$$;

grant execute on function total_unique_visitors() to anon, authenticated;
