-- 2026-08 계정 전체 공통 닉네임. 기존엔 채팅 메시지마다 서버가 이메일 앞부분을 닉네임으로
-- 임시로 붙였을 뿐 계정에 저장되진 않았다 — 이 테이블이 그 계정 단위 닉네임의 진짜 저장소다.
-- 값이 없는 계정(가입만 하고 아직 한 번도 로드 안 됨)은 site-header.js의 ensureNickname()이
-- 최초 로그인 세션에서 임의 닉네임을 자동 생성해 넣는다(신규/기존 계정 구분 없이 동일 경로).
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nickname   TEXT NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 20),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- 본인 행만 읽고/쓰고/고칠 수 있음. chat-send API(api/feedback.js)는 service_role로 조회하므로
-- 여기 정책과 무관하게(RLS 우회) 다른 회원의 닉네임도 조회 가능 — 그 외 클라이언트 경로는 없음.
DROP POLICY IF EXISTS "own profile select" ON user_profiles;
CREATE POLICY "own profile select" ON user_profiles FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "own profile insert" ON user_profiles;
CREATE POLICY "own profile insert" ON user_profiles FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "own profile update" ON user_profiles;
CREATE POLICY "own profile update" ON user_profiles FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
