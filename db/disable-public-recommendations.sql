-- 2026-07-21: 유사투자자문업 리스크 대응 — "매수 후보/신뢰도%/파급효과 분석" 데이터에 대한
-- 공개(anon) 접근을 차단한다. supabase-schema.sql에서 만든 allow_all_* 정책(FOR ALL USING(true))이
-- analyses/analysis_companies를 사실상 누구나 읽을 수 있게 열어놨었음 — 프론트엔드(analysis.html,
-- app.js 등)가 브라우저에 박힌 공개 anon key로 이 테이블들을 직접 SELECT하므로, 코드/UI를 아무리
-- 고쳐도 이 정책이 살아있는 한 Supabase REST API를 직접 두드리면 동일 데이터를 그대로 받아갈 수 있다.
-- 이 SQL이 실제 "차단" 지점이다 — 반드시 Supabase SQL Editor에서 직접 실행할 것.
--
-- service_role(서버 API, api/analyze.js 등)은 RLS를 우회하므로 이 변경 후에도 서버 쪽 쓰기/읽기는
-- 정상 동작한다 — 영향받는 건 anon(공개 브라우저) 접근뿐이다.
--
-- 되돌리려면(신고 완료 등으로 재개 시): 아래 DROP된 정책을 supabase-schema.sql /
-- db/company-ai-summary.sql의 원본 CREATE POLICY 문으로 다시 생성하면 된다.

DROP POLICY IF EXISTS allow_all_analyses ON analyses;
DROP POLICY IF EXISTS allow_all_analysis_companies ON analysis_companies;
DROP POLICY IF EXISTS "Anyone can read company_ai_summary" ON company_ai_summary;

-- issues/companies 테이블(제목·시세·기업정보 등 순수 정보성 데이터)은 그대로 공개 유지 —
-- 위 3개 정책만 제거해 "종목별 매수 판단/신뢰도/목표가/파급효과 연결" 데이터만 선택적으로 막는다.
