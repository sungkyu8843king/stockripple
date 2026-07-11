// 공유 인증 헬퍼 — ADMIN_SECRET 또는 Supabase JWT(allowlist 이메일) 둘 다 허용
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// req.headers.authorization 검사 → { ok, mode, email?, error? }
export async function verifyAdmin(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return { ok: false, error: 'No auth header' };
  const token = authHeader.slice(7).trim();

  // 1) ADMIN_SECRET 일치
  if (token === process.env.ADMIN_SECRET) return { ok: true, mode: 'secret' };
  if (token === process.env.CRON_SECRET)  return { ok: true, mode: 'cron' };

  // 2) Supabase JWT — 사용자 검증
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user?.email) return { ok: false, error: 'Invalid token' };
    const email = data.user.email.toLowerCase();
    const adminEmails = (process.env.ADMIN_EMAILS || 'tjdrb8423@gmail.com')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!adminEmails.includes(email)) return { ok: false, error: `Email ${email} not in admin list` };
    return { ok: true, mode: 'supabase', email };
  } catch (e) {
    return { ok: false, error: `Auth check error: ${e.message}` };
  }
}

// 관리자 여부와 무관하게 "유효한 로그인 사용자"만 확인 — 회원탈퇴 등 본인 계정에
// 대해서만 수행하는 셀프서비스 액션에 사용. req.headers.authorization 검사 →
// { ok, user?, error? }
export async function verifyUser(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return { ok: false, error: 'No auth header' };
  const token = authHeader.slice(7).trim();
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return { ok: false, error: 'Invalid token' };
    return { ok: true, user: data.user };
  } catch (e) {
    return { ok: false, error: `Auth check error: ${e.message}` };
  }
}
