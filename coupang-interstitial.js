// 쿠팡 파트너스 모바일 인터스티셜 배너 — 종목 상세(company.html)/뉴스 상세(analysis.html) 진입 시.
// 배너 이미지·링크·문구는 주기적으로 바뀔 수 있어 아래 CONFIG 하나만 고치면 된다.
(function () {
  var CONFIG = {
    // 배너 이미지 경로 — /ads/ 폴더에 새 이미지로 교체 후 이 파일명만 바꾸면 됨.
    imageSrc: '/ads/coupang-interstitial.png',
    link: 'https://link.coupang.com/a/fJcShK3GW4',
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

    var link = document.createElement('a');
    link.href = CONFIG.link;
    link.target = '_blank';
    link.rel = 'noopener noreferrer sponsored';
    link.style.cssText = 'display:block;cursor:pointer';
    link.addEventListener('click', close);

    var img = document.createElement('img');
    img.src = CONFIG.imageSrc;
    img.alt = '쿠팡 파트너스 광고';
    img.style.cssText = 'display:block;width:100%;height:auto';
    link.appendChild(img);
    card.appendChild(link);

    var disclosure = document.createElement('div');
    disclosure.textContent = CONFIG.disclosure;
    disclosure.style.cssText = 'font-size:10.5px;color:rgba(255,255,255,.55);text-align:center;padding:8px 12px;line-height:1.5';
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
