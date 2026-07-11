-- 긴급 안내 배너 자동 트리거 지원 — 어떤 분석이 배너를 켰는지 구분해서
-- 자동으로 켠 배너만 자동으로 갱신/해제하고, 관리자가 수동으로 켠 배너는 절대
-- 덮어쓰지 않기 위한 컬럼 추가.
ALTER TABLE site_announcement ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE site_announcement ADD COLUMN IF NOT EXISTS source_issue_id UUID;
