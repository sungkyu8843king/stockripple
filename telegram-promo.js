// telegram-promo.js — 홈 첫 진입 시 텔레그램 봇 홍보 팝업(다나와 스타일: 이미지 배너 +
// 하단 "오늘 그만보기"/"닫기"). 배너(이미지) 클릭 시 텔레그램으로 이동 — "닫기"는 이번
// 노출만 닫고(새로고침하면 다시 뜸), "오늘 그만보기"는 오늘(KST) 하루 다시 안 뜨게 한다.
(function () {
  var TELEGRAM_URL = 'https://t.me/stockripple_bot';
  var DISMISS_KEY = 'sr_telegram_promo_dismissed_date';

  function kstDateStr() {
    return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  }
  function isDismissedToday() {
    try { return localStorage.getItem(DISMISS_KEY) === kstDateStr(); } catch (e) { return false; }
  }
  function dismissToday() {
    try { localStorage.setItem(DISMISS_KEY, kstDateStr()); } catch (e) {}
  }

  function show() {
    var overlay = document.createElement('div');
    overlay.id = 'srTelegramPromo';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);padding:20px;box-sizing:border-box';

    var card = document.createElement('div');
    card.style.cssText = 'width:100%;max-width:460px;background:#0b0f19;border-radius:16px;overflow:hidden;box-shadow:0 24px 60px -12px rgba(0,0,0,.7)';

    // 배너 자체가 링크 — 새 탭으로 텔레그램을 열고, 클릭 즉시 팝업도 닫는다(오늘 그만보기 X,
    // 이번 노출만 종료 — 이미 관심 보인 사람에게 굳이 다시 안 띄울 이유는 없지만, 매번 다시
    // 뜨는 게 자연스러운 기본값이라 dismissToday는 호출하지 않는다).
    var link = document.createElement('a');
    link.href = TELEGRAM_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.cssText = 'display:block;line-height:0';
    link.addEventListener('click', function () { close(); });

    var img = document.createElement('img');
    img.src = '/telegram-svg.svg';
    img.alt = 'StockRipple 텔레그램 봇 — AI 시장 종합 분석 & 데일리 브리핑';
    img.style.cssText = 'display:block;width:100%;height:auto';
    link.appendChild(img);
    card.appendChild(link);

    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;border-top:1px solid rgba(0,0,0,.08)';

    var btnToday = document.createElement('button');
    btnToday.type = 'button';
    btnToday.textContent = '오늘 그만보기';
    btnToday.style.cssText = 'flex:1;padding:13px 0;background:#fff;color:#333;border:none;border-right:1px solid #e5e5e5;font-size:14px;font-weight:600;cursor:pointer';
    btnToday.addEventListener('click', function () { dismissToday(); close(); });

    var btnClose = document.createElement('button');
    btnClose.type = 'button';
    btnClose.textContent = '닫기';
    btnClose.style.cssText = 'flex:1;padding:13px 0;background:#fff;color:#333;border:none;font-size:14px;font-weight:600;cursor:pointer';
    btnClose.addEventListener('click', close);

    bar.appendChild(btnToday);
    bar.appendChild(btnClose);
    card.appendChild(bar);

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    // 배너 클릭으로 텔레그램에 갔다가 뒤로가기로 돌아왔을 때 팝업이 그대로 남아있지 않도록
    // (coupang-interstitial.js와 동일한 이유 — bfcache 복원 시 스크립트 재실행 없이 DOM만 되살아남).
    document.addEventListener('visibilitychange', function () { if (document.hidden) close(); });
    window.addEventListener('pagehide', close);
  }

  function init() {
    if (isDismissedToday()) return;
    show();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
