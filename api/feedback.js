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
  return handleSubmit(req, res);
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
