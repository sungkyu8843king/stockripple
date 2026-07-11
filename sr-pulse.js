// 방문자 애널리틱스 수집 (일자/시간별 접속자, 체류시간, 유입경로, 이동경로 — 어드민 전용 집계).
// 각 페이지 <head>에 <script src="/sr-pulse.js" defer></script> 한 줄만 추가하면 됨.
// 개인 식별 정보는 저장하지 않음 — 세션은 브라우저 탭 한정(sessionStorage), IP/쿠키 없음.
(function () {
  function uid() {
    try { return crypto.randomUUID(); } catch (e) {
      return Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }

  var SID_KEY = 'sr_sid';
  var sessionId;
  try {
    sessionId = sessionStorage.getItem(SID_KEY);
    if (!sessionId) { sessionId = uid(); sessionStorage.setItem(SID_KEY, sessionId); }
  } catch (e) { sessionId = uid(); }

  var viewId = uid();
  var loadedAt = Date.now();
  var leaveSent = false;
  var params = new URLSearchParams(location.search);

  function send(body) {
    try {
      fetch('/api/admin?action=track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(function () {});
    } catch (e) {}
  }

  send({
    event: 'enter',
    view_id: viewId,
    session_id: sessionId,
    path: location.pathname + location.search,
    referrer: document.referrer || null,
    utm_source: params.get('utm_source'),
    utm_medium: params.get('utm_medium'),
    utm_campaign: params.get('utm_campaign'),
  });

  function sendLeave() {
    if (leaveSent) return;
    leaveSent = true;
    send({ event: 'leave', view_id: viewId, dwell_ms: Date.now() - loadedAt });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') sendLeave();
  });
  window.addEventListener('pagehide', sendLeave);
})();
