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

  function show() {
    markShown();
    var overlay = document.createElement('div');
    overlay.id = 'coupangInterstitial';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);padding:24px;box-sizing:border-box';

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

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
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
})();
