// chat.js — 실시간 채팅 위젯 (우측 슬라이드 패널). site-header.js가 chat-config 플래그 확인 후
// 동적으로 로드한다 — 이 파일이 실행된다 = 어드민이 채팅을 켠 상태.
//
// 구조:
//  - 읽기: 초기 50건은 /api/feedback?action=chat-messages(엣지캐시), 이후는 Supabase Realtime
//    구독(INSERT/UPDATE 푸시 — 폴링 없음, DB 부하 최소). site-header.js의 전역 sb 클라이언트 재사용.
//  - 쓰기: 전부 서버 API 경유(chat-send/chat-report) — anon 직접 INSERT는 RLS로 막혀 있음.
//  - 회원: currentUser(site-header.js 전역) 세션 토큰을 chat-send에 실어 보내면 서버가 검증.
//    게스트: localStorage 랜덤 키(sr_chat_gk)로 식별(닉네임 '게스트XXXX' 자동 부여).
//  - 차단: 로컬 mute(sr_chat_blocked) — 그 사용자의 메시지를 내 화면에서만 접어서 보여줌.
//  - 신고: 1인 1신고(서버 강제), 3명 누적 시 서버가 hidden=true → 전체 화면에서 플레이스홀더 처리.
(function () {
  'use strict';
  if (window.__srChatLoaded) return; window.__srChatLoaded = true;

  // ── 식별/로컬 상태 ─────────────────────────────────────────
  function lsGet(k, fb) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fb; } catch { return fb; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  let guestKey = lsGet('sr_chat_gk', null);
  if (!guestKey) { guestKey = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join(''); lsSet('sr_chat_gk', guestKey); }
  const blocked = new Set(lsGet('sr_chat_blocked', []));
  const myReports = new Set(lsGet('sr_chat_reported', []));
  const myKey = () => (typeof currentUser !== 'undefined' && currentUser) ? 'u:' + currentUser.id : 'g:' + guestKey;

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtTime = iso => { const d = new Date(iso); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  // ── 스타일 + 마크업 ────────────────────────────────────────
  const css = document.createElement('style');
  css.textContent = `
  #srChatBtn{position:fixed;right:18px;bottom:88px;z-index:8900;width:48px;height:48px;border-radius:50%;border:1px solid rgba(255,255,255,.12);background:linear-gradient(135deg,#4d8dff,#9d7bff);color:#fff;font-size:21px;cursor:pointer;box-shadow:0 6px 20px rgba(36,87,230,.4);display:flex;align-items:center;justify-content:center}
  #srChatBtn .badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:999px;background:#ff6b6b;color:#fff;font-size:10.5px;font-weight:700;display:none;align-items:center;justify-content:center;padding:0 5px;box-shadow:0 0 0 2px #15171e}
  #srChatPanel{position:fixed;top:0;right:0;bottom:0;width:340px;max-width:92vw;z-index:9000;background:#1a1d24;border-left:1px solid rgba(255,255,255,.1);display:flex;flex-direction:column;transform:translateX(105%);transition:transform .22s ease;box-shadow:-12px 0 40px rgba(0,0,0,.45);font-family:'Inter',sans-serif;color:#f2f4f8}
  #srChatPanel.open{transform:translateX(0)}
  .src-head{display:flex;align-items:center;gap:8px;padding:13px 16px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0}
  .src-head b{font-size:14.5px}
  .src-head .live{width:7px;height:7px;border-radius:50%;background:#3ddb7f;box-shadow:0 0 6px #3ddb7f;animation:srPulse 1.5s infinite}
  @keyframes srPulse{0%,100%{opacity:1}50%{opacity:.3}}
  .src-head .me{margin-left:auto;font-size:11px;color:#6c7385}
  .src-close{background:none;border:none;color:#6c7385;font-size:20px;cursor:pointer;padding:2px 6px;line-height:1}
  .src-close:hover{color:#f2f4f8}
  #srChatList{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:9px}
  .src-msg{max-width:100%}
  .src-meta{display:flex;align-items:center;gap:6px;font-size:11px;color:#6c7385;margin-bottom:2px}
  .src-nick{font-weight:700;color:#a6adbb}
  .src-nick.member{color:#4d8dff}
  .src-mb{font-size:9px;background:rgba(77,141,255,.15);color:#4d8dff;padding:1px 5px;border-radius:4px;font-weight:700}
  .src-more{background:none;border:none;color:#6c7385;cursor:pointer;font-size:13px;padding:0 4px;opacity:0;transition:opacity .1s}
  .src-msg:hover .src-more{opacity:1}
  .src-body{font-size:13px;line-height:1.5;word-break:break-word;background:#242833;border-radius:4px 12px 12px 12px;padding:7px 11px;display:inline-block}
  .src-msg.mine .src-body{background:rgba(77,141,255,.18)}
  .src-msg.ghost .src-body{color:#6c7385;font-style:italic;background:rgba(255,255,255,.04)}
  .src-menu{position:absolute;background:#262a34;border:1px solid rgba(255,255,255,.16);border-radius:10px;overflow:hidden;z-index:9100;box-shadow:0 8px 24px rgba(0,0,0,.5)}
  .src-menu button{display:block;width:100%;text-align:left;background:none;border:none;color:#f2f4f8;font-size:12.5px;padding:9px 14px;cursor:pointer;white-space:nowrap}
  .src-menu button:hover{background:#2f333f}
  .src-menu button.danger{color:#ff6b6b}
  #srChatInput{display:flex;gap:8px;padding:12px 14px;border-top:1px solid rgba(255,255,255,.08);flex-shrink:0}
  #srChatInput input{flex:1;min-width:0;background:#242833;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px 12px;color:#f2f4f8;font-size:13px;outline:none;font-family:inherit}
  #srChatInput input:focus{border-color:rgba(77,141,255,.5)}
  #srChatInput button{background:#4d8dff;border:none;color:#fff;font-weight:700;font-size:13px;border-radius:10px;padding:0 16px;cursor:pointer}
  #srChatInput button:disabled{opacity:.5;cursor:default}
  .src-note{font-size:10.5px;color:#6c7385;padding:0 16px 10px;flex-shrink:0}
  @media (max-width:640px){ #srChatBtn{bottom:76px;right:12px} }`;
  document.head.appendChild(css);

  const btn = document.createElement('button');
  btn.id = 'srChatBtn'; btn.title = '실시간 채팅';
  btn.innerHTML = '💬<span class="badge" id="srChatBadge"></span>';
  const panel = document.createElement('div');
  panel.id = 'srChatPanel';
  panel.innerHTML = `
    <div class="src-head"><span class="live"></span><b>실시간 채팅</b><span class="me" id="srChatMe"></span>
      <button class="src-close" onclick="document.getElementById('srChatPanel').classList.remove('open')">✕</button></div>
    <div id="srChatList"></div>
    <div id="srChatInput"><input id="srChatText" maxlength="300" placeholder="메시지 입력 (최대 300자)"><button id="srChatSend">전송</button></div>
    <div class="src-note">신고 3회 누적 시 임시 숨김 · 매매 권유/비방은 제재될 수 있어요</div>`;
  document.body.appendChild(btn); document.body.appendChild(panel);

  const list = panel.querySelector('#srChatList');
  const input = panel.querySelector('#srChatText');
  const sendBtn = panel.querySelector('#srChatSend');
  const badge = btn.querySelector('#srChatBadge');
  let unread = 0;

  function renderMe() {
    const el = panel.querySelector('#srChatMe');
    el.textContent = (typeof currentUser !== 'undefined' && currentUser)
      ? (currentUser.email || '').split('@')[0] : '게스트' + guestKey.slice(-4);
  }

  // ── 메시지 렌더 ────────────────────────────────────────────
  const seen = new Set(); // 중복 방지(초기 로드 + realtime 겹침)
  function msgHtml(m) {
    if (m.hidden) return `<div class="src-msg ghost" data-id="${m.id}"><div class="src-body">🚫 신고 누적으로 숨김 처리된 메시지입니다</div></div>`;
    if (blocked.has(m.sender_key)) return `<div class="src-msg ghost" data-id="${m.id}" data-sender="${esc(m.sender_key)}"><div class="src-body">차단한 사용자의 메시지 <button class="src-more" style="opacity:1" onclick="srChatUnblock('${esc(m.sender_key)}')">차단해제</button></div></div>`;
    const mine = m.sender_key === myKey();
    return `<div class="src-msg${mine ? ' mine' : ''}" data-id="${m.id}" data-sender="${esc(m.sender_key)}">
      <div class="src-meta"><span class="src-nick${m.is_member ? ' member' : ''}">${esc(m.nickname)}</span>${m.is_member ? '<span class="src-mb">회원</span>' : ''}<span>${fmtTime(m.created_at)}</span>${mine ? '' : `<button class="src-more" onclick="srChatMenu(event,${m.id},'${esc(m.sender_key)}')">⋯</button>`}</div>
      <div class="src-body">${esc(m.message)}</div></div>`;
  }
  function appendMsg(m, scroll = true) {
    if (seen.has(m.id)) return; seen.add(m.id);
    list.insertAdjacentHTML('beforeend', msgHtml(m));
    if (scroll) list.scrollTop = list.scrollHeight;
    if (!panel.classList.contains('open') && !m.hidden) { unread++; badge.style.display = 'flex'; badge.textContent = unread > 9 ? '9+' : unread; }
  }
  function replaceMsg(m) { // realtime UPDATE(숨김/해제)
    const el = list.querySelector(`[data-id="${m.id}"]`);
    if (!el) return;
    if (m.hidden) m = { ...m, message: '' };
    seen.delete(m.id); const tmp = document.createElement('div'); tmp.innerHTML = msgHtml(m); seen.add(m.id);
    el.replaceWith(tmp.firstElementChild);
  }

  // ── 신고/차단 메뉴 ─────────────────────────────────────────
  let menuEl = null;
  window.srChatMenu = function (ev, id, senderKey) {
    ev.stopPropagation();
    if (menuEl) menuEl.remove();
    menuEl = document.createElement('div');
    menuEl.className = 'src-menu';
    const reported = myReports.has(id);
    menuEl.innerHTML = `
      <button class="danger" ${reported ? 'disabled style="opacity:.5"' : ''} onclick="srChatReport(${id})">${reported ? '✓ 신고됨' : '🚨 이 메시지 신고'}</button>
      <button onclick="srChatBlock('${esc(senderKey)}')">🔇 이 사용자 차단</button>`;
    document.body.appendChild(menuEl);
    const r = ev.target.getBoundingClientRect();
    menuEl.style.top = Math.min(r.bottom + 4, innerHeight - 90) + 'px';
    menuEl.style.left = Math.max(10, r.left - 140) + 'px';
    setTimeout(() => document.addEventListener('click', () => { menuEl?.remove(); menuEl = null; }, { once: true }));
  };
  window.srChatReport = async function (id) {
    menuEl?.remove();
    try {
      const r = await fetch('/api/feedback?action=chat-report', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: id, reporterKey: myKey() }),
      });
      const j = await r.json();
      if (j.ok) {
        myReports.add(id); lsSet('sr_chat_reported', [...myReports]);
        if (typeof showToast === 'function') showToast(j.hidden ? '신고 누적으로 숨김 처리됐어요' : '신고가 접수됐어요', 'success');
      }
    } catch {}
  };
  window.srChatBlock = function (senderKey) {
    menuEl?.remove();
    blocked.add(senderKey); lsSet('sr_chat_blocked', [...blocked]);
    list.querySelectorAll(`[data-sender="${CSS.escape(senderKey)}"]`).forEach(el => {
      el.outerHTML = `<div class="src-msg ghost" data-id="${el.dataset.id}" data-sender="${esc(senderKey)}"><div class="src-body">차단한 사용자의 메시지 <button class="src-more" style="opacity:1" onclick="srChatUnblock('${esc(senderKey)}')">차단해제</button></div></div>`;
    });
    if (typeof showToast === 'function') showToast('차단했어요 — 내 화면에서만 숨겨져요', 'info');
  };
  window.srChatUnblock = function (senderKey) {
    blocked.delete(senderKey); lsSet('sr_chat_blocked', [...blocked]);
    seen.clear(); list.innerHTML = ''; loadInitial(); // 간단히 전체 리로드
  };

  // ── 전송 ───────────────────────────────────────────────────
  async function send() {
    const text = input.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    try {
      const headers = { 'Content-Type': 'application/json' };
      try {
        const { data } = await sb.auth.getSession();
        if (data?.session?.access_token) headers['Authorization'] = 'Bearer ' + data.session.access_token;
      } catch {}
      const r = await fetch('/api/feedback?action=chat-send', {
        method: 'POST', headers, body: JSON.stringify({ message: text, guestKey }),
      });
      const j = await r.json();
      if (j.ok) input.value = '';
      else if (typeof showToast === 'function') showToast(j.error || '전송 실패', 'error');
    } catch { if (typeof showToast === 'function') showToast('전송 실패 — 네트워크 확인', 'error'); }
    sendBtn.disabled = false; input.focus();
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) send(); });

  // ── 초기 로드 + Realtime 구독 ──────────────────────────────
  async function loadInitial() {
    try {
      const r = await fetch('/api/feedback?action=chat-messages');
      const j = await r.json();
      (j.items || []).forEach(m => appendMsg(m, false));
      list.scrollTop = list.scrollHeight;
    } catch {}
  }
  let subscribed = false;
  function subscribe() {
    if (subscribed || typeof sb === 'undefined') return; subscribed = true;
    sb.channel('sr-chat')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' },
        p => { const m = p.new; appendMsg(m.hidden ? { ...m, message: '' } : m); })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_messages' },
        p => replaceMsg(p.new))
      .subscribe();
  }

  btn.addEventListener('click', () => {
    const opening = !panel.classList.contains('open');
    panel.classList.toggle('open');
    if (opening) {
      unread = 0; badge.style.display = 'none';
      renderMe();
      if (!seen.size) loadInitial();
      subscribe();
      list.scrollTop = list.scrollHeight;
      setTimeout(() => input.focus(), 250);
    }
  });
})();
