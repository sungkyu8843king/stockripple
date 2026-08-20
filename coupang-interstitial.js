// 쿠팡 파트너스 모바일 인터스티셜 배너 — 종목 상세(company.html)/뉴스 상세(analysis.html) 진입 시.
// 2026-08: 정적 이미지 대신 쿠팡 파트너스 공식 위젯(g.js, id 1005662)을 실은 iframe으로
// 교체 — g.js는 레거시 document.write() 방식이라 페이지에 직접 동적 주입하면 조용히
// 무시돼 광고가 안 뜬다(다른 쿠팡 광고 슬롯과 동일한 이유, coupang-ad-*.html 참고).
// 그래서 실제 정적 페이지(coupang-ad-interstitial-mobile.html)를 iframe src로 물린다.
(function () {
  var CONFIG = {
    adSrc: '/coupang-ad-interstitial-mobile.html',
    adWidth: 320,
    adHeight: 480,
    disclosure: '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.',
    cooldownHours: 1,
    mobileMaxWidth: 768,
  };
  var STORAGE_KEY = 'sr_coupang_interstitial_last_shown';

  function isMobile() {
    return window.innerWidth <= CONFIG.mobileMaxWidth;
  }
  function isDue() {
    try {
      var last = parseInt(localStorage.getItem(STORAGE_KEY), 10);
      if (!last) return true;
      return (Date.now() - last) >= CONFIG.cooldownHours * 3600 * 1000;
    } catch (e) { return true; }
  }
  function markShown() {
    try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch (e) {}
  }

  // 이미 떠 있는 인스턴스가 있으면 지운다 — show()가 두 번 불려도(아래 pageshow 가드 참고)
  // 검은 카드가 겹겹이 쌓이지 않게. querySelector로 찾는 이유: 이 IIFE의 클로저 변수가
  // 아니라 DOM 자체를 진실의 원천으로 삼아야 "스크립트가 다시 실행됐지만 이전 실행의
  // DOM은 그대로 남아있는" 경우(아래 참고)도 잡는다.
  function removeExisting() {
    var el = document.getElementById('coupangInterstitial');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function show() {
    removeExisting();
    markShown();
    var overlay = document.createElement('div');
    overlay.id = 'coupangInterstitial';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);padding:24px;box-sizing:border-box';

    var card = document.createElement('div');
    card.style.cssText = 'position:relative;max-width:360px;width:100%;background:#0d0f14;border-radius:16px;overflow:hidden;box-shadow:0 24px 60px -12px rgba(0,0,0,.7)';

    // 클릭/이동 처리는 iframe 안(coupang-ad-interstitial-mobile.html)의 쿠팡 공식 위젯이
    // 전담한다 — 정적 이미지 때와 달리 우리가 <a href>를 따로 씌우지 않는다(이중 이동 방지).
    // 그 파일 안에 window.open 새탭 우회 방지(iOS "다른 앱을 열려고 합니다" 확인창 방지)도
    // 이미 들어있음.
    var iframe = document.createElement('iframe');
    iframe.src = CONFIG.adSrc;
    iframe.title = '쿠팡 파트너스 광고';
    iframe.scrolling = 'no';
    iframe.style.cssText = 'display:block;width:100%;height:' + CONFIG.adHeight + 'px;max-width:' + CONFIG.adWidth + 'px;margin:0 auto;border:0';
    card.appendChild(iframe);

    var disclosure = document.createElement('div');
    disclosure.textContent = CONFIG.disclosure;
    disclosure.style.cssText = 'font-size:12px;color:rgba(255,255,255,.55);text-align:center;padding:8px 12px;line-height:1.5';
    card.appendChild(disclosure);

    // 의도적으로 작은 X — 배너 클릭을 유도하되, 실제로 눌리는 닫기 버튼(가짜 아님).
    var closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', '닫기');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'position:absolute;top:6px;right:6px;width:20px;height:20px;border-radius:50%;border:none;background:rgba(0,0,0,.55);color:#fff;font-size:11px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0';
    closeBtn.addEventListener('click', function (e) { e.stopPropagation(); close(); });
    card.appendChild(closeBtn);

    // ⚠️ 2026-08-20 실측 버그(1차): 앱을 백그라운드에 오래 뒀다가 돌아오면 iframe 광고가 안
    // 뜨고 카드가 검은 배경만 남은 채 화면에 박혀있는 게 보고됨. 광고가 일정 시간 안에 안
    // 뜨면 깨진 채 화면을 막고 있지 말고 그냥 조용히 닫는다 — 못 띄운 광고 하나보다 사용자가
    // 페이지를 못 쓰는 게 훨씬 나쁘다.
    //
    // ⚠️ 2026-08-20 실측 버그(2차): 위 1차 수정은 iframe의 'load' 이벤트로 이 안전장치를
    // 해제했는데, 'load'는 iframe 문서 자체(그리고 그 안의 <script src=g.js>)가 다 받아진
    // 시점에 뜰 뿐이다. g.js가 실행된 뒤 실제 광고 콘텐츠를 채워넣는 건 비동기(네트워크
    // 요청 등)라 'load' 이후에 일어나고, 그 요청이 광고 재고 없음 등으로 실패하면 body가
    // 영영 빈 채로 남는다 — 'load'가 이미 타이머를 꺼버렸으니 검은 카드만 화면에 그대로
    // 박힌다(사용자 실측: 광고 없이 안내문구만 뜬 채 안 닫힘). 그래서 이제 'load' 자체가
    // 아니라 "iframe body에 실제로 뭔가 채워졌는지"를 폴링해 확인한 뒤에만 타이머를 끈다 —
    // 끝까지 비어있으면 실패로 간주해 원래 타이머가 그대로 닫는다. 같은 출처(same-origin)
    // 정적 파일이라 contentDocument 접근이 막히지 않는다.
    var loadTimer = setTimeout(close, 5000);
    var contentPoll = setInterval(function () {
      try {
        var doc = iframe.contentDocument;
        if (doc && doc.body && doc.body.children.length > 0) {
          clearTimeout(loadTimer);
          clearInterval(contentPoll);
        }
      } catch (e) { clearInterval(contentPoll); }
    }, 300);
    iframe.addEventListener('load', function () {
      // 로드 직후엔 아직 광고 콘텐츠가 안 채워졌을 수 있으니 폴링에게 판단을 맡긴다(위 참고).
    }, { once: true });

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function close() {
      clearTimeout(loadTimer);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    // 배너 이미지를 눌러 쿠팡으로 넘어가는 경우 X를 안 눌러도 됨 — iframe 안(다른 문서)에서
    // 일어나는 클릭이라 여기서 직접 감지는 못 하지만, "페이지를 떠나는 순간"엔 항상 닫아두면
    // 된다. 이렇게 해야 브라우저 뒤로가기로 돌아왔을 때(bfcache 복원 — 페이지 스크립트가
    // 다시 실행되지 않고 떠날 때의 DOM이 그대로 되살아남) 배너가 그대로 남아있지 않는다.
    document.addEventListener('visibilitychange', function () { if (document.hidden) close(); });
    window.addEventListener('pagehide', close);
  }

  function init() {
    if (!isMobile() || !isDue()) return;
    show();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // ⚠️ 위 pagehide/visibilitychange 정리가 항상 실행된다는 보장이 없다 — iOS가 메모리
  // 압박으로 탭 프로세스를 강제 종료하면 정리 코드가 돌 기회 없이 그대로 죽는다. 그 상태로
  // 복원되면(bfcache) 페이지 스크립트는 다시 실행되지 않지만 DOM은 종료 직전 그대로
  // 되살아나므로, 닫히지 못한 검은 카드가 그대로 남아있게 된다(2026-08-20 실측 버그의
  // 유력한 원인). pageshow는 새로고침·bfcache 복원 둘 다에서 뜨므로, 복원된 경우
  // (event.persisted)엔 무조건 지운다 — 새로고침이면 애초에 이 시점엔 아직 없으므로 안전.
  window.addEventListener('pageshow', function (e) { if (e.persisted) removeExisting(); });
})();
