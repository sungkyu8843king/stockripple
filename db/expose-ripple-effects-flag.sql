-- 2026-07-27: 'analyze'(파이프라인 실행 on/off, 비용관리용)와 공개 노출 여부를 분리.
-- analyze를 운영상 다시 켜도 이 플래그가 false(기본값)인 한 매수후보/신뢰도/파급효과
-- 데이터(analyses/analysis_companies 조인, 종목 랭킹/매수논리)는 공개 API 응답에 실리지 않는다.
-- fail-closed(행이 없거나 조회 실패 시 비활성화)로 lib/feature-flags.js의
-- isFeatureEnabledStrict()가 확인한다.
INSERT INTO feature_flags (key, enabled) VALUES ('expose_ripple_effects', false) ON CONFLICT (key) DO NOTHING;
