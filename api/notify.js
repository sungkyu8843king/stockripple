// POST /api/notify                     → 어드민 단일 채팅방 알림 (기존 기능, 변경 없음)
//   Authorization: Bearer ADMIN_SECRET
//   Body: { message: string }
// POST /api/notify?action=webhook       → 텔레그램 봇 웹훅 (2026-08-02 신규, /api/telegram-webhook로 리라이트됨)
//   Header: X-Telegram-Bot-Api-Secret-Token: TELEGRAM_WEBHOOK_SECRET
//   불특정 다수가 봇에 /start 보내면 telegram_subscribers에 등록 → 이후 리포트 발송 대상에 포함됨
//   (api/admin.js의 notifyReportSubscribers 참고). /stop 보내면 재발송 대상에서 제외.
// 환경변수: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID(어드민 알림용), TELEGRAM_WEBHOOK_SECRET(웹훅 검증용)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  const action = (req.query?.action || '').toString();
  if (action === 'webhook') return handleWebhook(req, res);
  return handleAdminNotify(req, res);
}

async function handleAdminNotify(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.headers.authorization !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return res.status(200).json({ skipped: true, reason: 'Telegram not configured' });
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.description || 'Telegram error');
    return res.status(200).json({ sent: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// 텔레그램 서버가 매 업데이트마다 이 엔드포인트를 호출한다. 무슨 일이 있어도 최대한 빨리
// 200을 돌려줘야 함(아니면 텔레그램이 재시도를 반복) — 실패해도 절대 5xx로 죽지 않도록
// 모든 처리를 try/catch로 감싼다.
async function handleWebhook(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expected && req.headers['x-telegram-bot-api-secret-token'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    const text = (msg?.text || '').trim();
    if (chatId == null || !text) return res.status(200).json({ ok: true });

    if (text === '/start') {
      const { error } = await supabase.from('telegram_subscribers').upsert({
        chat_id: chatId,
        username: msg.from?.username || null,
        active: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'chat_id' });
      if (error) {
        console.error('telegram_subscribers upsert failed:', error.message);
        await sendText(chatId, '⚠️ 구독 처리 중 오류가 발생했습니다. 잠시 후 /start 를 다시 보내주세요.');
      } else {
        await sendText(chatId,
          '✅ 구독이 시작됐습니다!\n\nAI 시장 종합, 국장·미장 데일리 리포트가 나올 때마다 여기로 알려드릴게요.\n중지하려면 언제든 /stop 을 보내주세요.');
      }
    } else if (text === '/stop') {
      const { error } = await supabase.from('telegram_subscribers')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('chat_id', chatId);
      if (error) {
        console.error('telegram_subscribers unsubscribe failed:', error.message);
      }
      await sendText(chatId, '🔕 구독이 해제됐습니다. 다시 받고 싶으시면 /start 를 보내주세요.');
    } else {
      await sendText(chatId, '이 봇은 StockRipple 리포트 알림 전용입니다.\n구독: /start · 해제: /stop');
    }
  } catch (e) {
    console.error('telegram webhook failed:', e.message);
  }
  return res.status(200).json({ ok: true });
}

async function sendText(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {}
}
