// 방문자 애널리틱스 수집 (일자/시간별 접속자, 체류시간, 유입경로, 이동경로 — 어드민 전용 집계).
// 각 페이지 <head>에 <script src="/sr-pulse.js" defer></script> 한 줄만 추가하면 됨.
// 개인 식별 정보는 저장하지 않음 — 무작위 UUID 하나만 localStorage에 저장, IP/쿠키 없음.
//
// 2026-08: sessionStorage → localStorage로 변경. sessionStorage는 탭 하나에 한정돼(탭
// 닫으면 소멸, 새 탭/재방문마다 새 ID) 어드민의 "일자별 접속자"가 사실 "브라우저 탭 세션 수"였고,
// 같은 사람이 탭을 여러 개 열거나 하루에 여러 번 드나들면 그때마다 별도 방문자로 잡혀 실제
// 순 방문자보다 부풀려졌다("유니크 사용자 기준이 맞냐"는 피드백). localStorage는 같은
// 브라우저/기기에서 계속 유지되므로 구글 애널리틱스 등과 동일한 "기기 하나당 ID 하나" 방식이
// 되어 훨씬 정확한 순 방문자 근사치가 된다. (이 변경 시점 전후로 일자별 그래프에 불연속
// 구간이 생길 수 있음 — 집계 방식이 바뀐 것일 뿐 실제 트래픽 변화가 아님.)
(function () {
  function uid() {
    try { return crypto.randomUUID(); } catch (e) {
      return Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }

  var SID_KEY = 'sr_sid';
  var sessionId;
  try {
    sessionId = localStorage.getItem(SID_KEY);
    if (!sessionId) { sessionId = uid(); localStorage.setItem(SID_KEY, sessionId); }
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
