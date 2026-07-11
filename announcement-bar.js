// 사이트 전체 페이지 상단 긴급 안내 배너 — 어드민에서 켜면 모든 페이지에 노출된다.
// 각 페이지 <head>에 <script src="/announcement-bar.js" defer></script> 한 줄만 추가하면 됨.
(function () {
  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function hashMsg(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }
  function render(d) {
    if (!d || !d.active || !d.message) return;
    var key = 'sr_ann_dismissed_' + hashMsg(d.message);
    try { if (sessionStorage.getItem(key)) return; } catch (e) {}

    var bar = document.createElement('div');
    bar.id = 'srAnnouncementBar';
    bar.style.cssText = 'position:sticky;top:0;left:0;right:0;z-index:99999;background:#fef3c7;color:#92400e;'
      + 'font-size:13px;font-weight:600;line-height:1.5;padding:10px 40px;text-align:center;'
      + 'border-bottom:1px solid #fbbf24;font-family:inherit';
    bar.innerHTML = '🚨 ' + escHtml(d.message)
      + '<button aria-label="닫기" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);'
      + 'background:none;border:none;font-size:15px;cursor:pointer;color:#92400e;padding:4px 8px;line-height:1">✕</button>';
    document.body.insertBefore(bar, document.body.firstChild);

    bar.querySelector('button').addEventListener('click', function () {
      bar.remove();
      try { sessionStorage.setItem(key, '1'); } catch (e) {}
    });
  }
  function init() {
    if (!document.body) return;
    fetch('/api/admin?action=announcement')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(render)
      .catch(function () {});
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
