/**
 * feedback.js — 사용자 피드백 (랜딩 페이지 챗봇 위젯)
 * POST /api/feedback                    → 제출 (공개, 누구나)
 * GET  /api/feedback?action=list        → 목록 조회 (관리자 전용)
 * POST /api/feedback?action=update      → 상태/메모 갱신 (관리자 전용)
 */
import { createClient } from '@supabase/supabase-js';
import { verifyAdmin } from '../lib/auth.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CATEGORIES = new Set(['bug', 'feature', 'design', 'other']);
const STATUSES = new Set(['new', 'reviewed', 'planned', 'done', 'rejected']);

export default async function handler(req, res) {
  const action = (req.query?.action || '').toString();
  if (action === 'list')   return handleList(req, res);
  if (action === 'update') return handleUpdate(req, res);
  // ── 실시간 채팅 (db/chat.sql) — 쓰기 전부 여기(service_role) 경유, 브라우저 직접 INSERT 불가 ──
  if (action === 'chat-config')   return handleChatConfig(req, res);
  if (action === 'chat-messages') return handleChatMessages(req, res);
  if (action === 'chat-send')     return handleChatSend(req, res);
  if (action === 'chat-report')   return handleChatReport(req, res);
  return handleSubmit(req, res);
}

// ════════════════════════════════════════════════════════════
// 실시간 채팅
// ════════════════════════════════════════════════════════════

// 플래그 조회 — fail-closed(행 없음/에러 = OFF). 다른 AI 플래그들의 fail-open과 반대인 게 의도:
// "어드민이 켤 때만 위젯이 나온다"가 요구사항이라 불확실하면 안 보여주는 쪽이 맞다.
async function isChatEnabled() {
  try {
    const { data } = await supabase.from('feature_flags').select('enabled').eq('key', 'chat').maybeSingle();
    return data?.enabled === true;
  } catch { return false; }
}

async function handleChatConfig(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // 모든 페이지가 로드마다 호출 — 엣지캐시 필수(어드민 토글 반영은 최대 60초 지연 감수)
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  return res.status(200).json({ ok: true, enabled: await isChatEnabled() });
}

async function handleChatMessages(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // 초기 로드 1회용(이후엔 Realtime 구독이 이어받음) — 짧은 캐시로 동시 접속 몰림 흡수
  res.setHeader('Cache-Control', 'public, s-maxage=5, stale-while-revalidate=30');
  const { data, error } = await supabase
    .from('chat_messages')
    .select('id, sender_key, nickname, is_member, message, hidden, created_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(200).json({ ok: false, error: error.message, items: [] });
  // 숨김 메시지는 본문을 서버에서 비워서 내려보냄 — 클라이언트는 플레이스홀더만 표시
  const items = (data || []).reverse().map(m => m.hidden ? { ...m, message: '' } : m);
  return res.status(200).json({ ok: true, items });
}

// 인스턴스 내 레이트리밋(10초에 3건). 서버리스라 인스턴스마다 별도지만 스팸 1차 방어로 충분.
const _chatRate = new Map();
function chatRateLimited(key) {
  const now = Date.now();
  const arr = (_chatRate.get(key) || []).filter(t => now - t < 10000);
  if (arr.length >= 3) return true;
  arr.push(now); _chatRate.set(key, arr);
  if (_chatRate.size > 2000) _chatRate.clear(); // 메모리 상한
  return false;
}

async function handleChatSend(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await isChatEnabled())) return res.status(403).json({ ok: false, error: 'chat disabled' });

  const body = req.body || {};
  const message = String(body.message || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!message) return res.status(400).json({ ok: false, error: 'message required' });
  if (message.length > 300) return res.status(400).json({ ok: false, error: 'too long (max 300)' });

  // 회원이면 토큰 검증해서 신원 확정 — 닉네임은 user_profiles(계정 공통 닉네임, 2026-08
  // 도입)을 우선 쓰고, 아직 없으면(과거 계정 등) 이메일 앞부분으로 폴백. 아니면 게스트 키 사용.
  let senderKey = null, nickname = null, isMember = false;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const { data } = await supabase.auth.getUser(authHeader.slice(7).trim());
      if (data?.user) {
        senderKey = 'u:' + data.user.id;
        isMember = true;
        const { data: profile } = await supabase.from('user_profiles').select('nickname').eq('user_id', data.user.id).maybeSingle();
        nickname = (profile?.nickname || (data.user.email || '회원').split('@')[0]).slice(0, 20);
      }
    } catch {}
  }
  if (!senderKey) {
    const gk = String(body.guestKey || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    if (gk.length < 8) return res.status(400).json({ ok: false, error: 'guestKey required' });
    senderKey = 'g:' + gk;
    // 게스트 닉네임 — 클라이언트(chat.js)가 randomNickname()으로 만들어 localStorage에
    // 저장해둔 값을 그대로 보내온다("게스트7ffn" 대신 "불꽃거북이5901" 스타일, 2026-08).
    // 서버가 생성한 값이 아니라 사용자 입력이므로 message와 동일하게 제어문자만 제거하고
    // 길이 제한 — 비어있거나 이상하면 기존 방식으로 안전하게 폴백.
    const clientNick = String(body.guestNickname || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20);
    nickname = clientNick || ('게스트' + gk.slice(-4)).slice(0, 20);
  }

  const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || 'noip';
  if (chatRateLimited(ip) || chatRateLimited(senderKey)) {
    return res.status(429).json({ ok: false, error: '잠시 후 다시 보내주세요 (도배 방지)' });
  }

  const { data, error } = await supabase.from('chat_messages')
    .insert({ sender_key: senderKey, nickname, is_member: isMember, message })
    .select('id').maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.status(200).json({ ok: true, id: data?.id, senderKey });
}

const CHAT_HIDE_THRESHOLD = 3; // 서로 다른 신고자 3명 → 임시 숨김(어드민 확인 대상)

async function handleChatReport(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body || {};
  const messageId = parseInt(body.messageId);
  const reporterKey = String(body.reporterKey || '').slice(0, 60);
  if (!messageId || reporterKey.length < 8) return res.status(400).json({ ok: false, error: 'bad request' });

  // upsert+ignoreDuplicates — 같은 사람이 같은 글을 여러 번 신고해도 1건으로만 집계
  const { error: insErr } = await supabase.from('chat_reports')
    .upsert({ message_id: messageId, reporter_key: reporterKey },
            { onConflict: 'message_id,reporter_key', ignoreDuplicates: true });
  if (insErr) return res.status(500).json({ ok: false, error: insErr.message });

  const { count } = await supabase.from('chat_reports')
    .select('*', { count: 'exact', head: true }).eq('message_id', messageId);
  const reports = count ?? 0;
  let hidden = false;
  if (reports >= CHAT_HIDE_THRESHOLD) {
    hidden = true;
    await supabase.from('chat_messages').update({ hidden: true, report_count: reports }).eq('id', messageId);
  } else {
    await supabase.from('chat_messages').update({ report_count: reports }).eq('id', messageId);
  }
  return res.status(200).json({ ok: true, reports, hidden });
}

async function handleSubmit(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const message = String(body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  if (message.length > 3000) return res.status(400).json({ error: 'message too long (max 3000)' });

  const category = CATEGORIES.has(body.category) ? body.category : 'other';
  const contact = body.contact ? String(body.contact).trim().slice(0, 200) : null;
  const page = body.page ? String(body.page).trim().slice(0, 200) : null;

  const { error } = await supabase.from('user_feedback').insert({
    category, message, contact, page,
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

async function handleList(req, res) {
  const auth = await verifyAdmin(req.headers.authorization);
  if (!auth.ok) return res.status(401).json({ error: auth.error });

  const status = (req.query?.status || 'all').toString();
  let q = supabase.from('user_feedback').select('*').order('created_at', { ascending: false }).limit(300);
  if (status !== 'all' && STATUSES.has(status)) q = q.eq('status', status);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, items: data || [] });
}

async function handleUpdate(req, res) {
  const auth = await verifyAdmin(req.headers.authorization);
  if (!auth.ok) return res.status(401).json({ error: auth.error });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { id, status, admin_note } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });

  const patch = {};
  if (status !== undefined) {
    if (!STATUSES.has(status)) return res.status(400).json({ error: 'invalid status' });
    patch.status = status;
  }
  if (admin_note !== undefined) patch.admin_note = String(admin_note).slice(0, 2000);
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' });

  const { error } = await supabase.from('user_feedback').update(patch).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}
