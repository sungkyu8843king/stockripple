-- 2026-08 OAuth 첫 가입 온보딩(닉네임 설정 + 약관 동의) 도입에 따른 추가 컬럼.
-- user_profiles.sql이 이미 배포된 뒤 추가된 마이그레이션이라 별도 파일로 분리.
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS terms_agreed_at TIMESTAMPTZ;
