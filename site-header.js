// site-header.js — 사이트 전체 공통 헤더/푸터 + 로그인/회원가입 모달 + 상단 종목 검색 + 토스트.
// (2026-07-22) 이전엔 index/heatmap/kr-market/picks/sectors/news(app.js 경유)와
// company.html/analysis.html이 각각 따로 복사해 갖고 있던 걸 여기 하나로 합쳤다 —
// 앞으로 헤더 구조·로그인 규칙·검색 로직을 바꿀 땐 이 파일 하나만 고치면 전체 페이지에 반영된다.
//
// 사용법 — 페이지의 헤더가 있던 자리에 그대로:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
//   <script src="/site-header.js"></script>
//   <div id="site-header-mount"></div><script>renderSiteHeader('/etf.html')</script>
// 푸터가 있던 자리(또는 없었으면 본문 끝)에:
//   <div id="site-footer-mount"></div><script>renderSiteFooter()</script>
// 페이지 자체 스크립트 맨 끝에서 (기존과 동일하게) 반드시 한 번:
//   <script>initAuth();</script>
//
// ⚠️ 이 스크립트는 defer/async 없이 동기로 불러와야 한다 — 로드 즉시 헤더를 DOM에 주입하므로,
// mount용 <div>가 이미 파싱된 뒤(스크립트 태그 앞)에 위치해야 한다.
//
// ⚠️ 관심종목 캐시(watchlistCache 등)처럼 로그인 상태에 얹혀있는 페이지 전용 로직은 여기서
// 다루지 않는다 — app.js/analysis.html은 이 파일의 initAuth/renderUserMenu를 자신의 것으로
// "덮어써서"(함수 재선언은 에러 없이 마지막 정의가 이긴다) 관심종목 캐시까지 같이 처리한다.
// 그 페이지들의 initAuth/renderUserMenu는 절대 여기서 손대지 않는다.

const SUPABASE_URL = 'https://nmvfffzpkqyzztiobwtt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_22PPW0eCY3Tvy3vZVZYKFw_yCb8cI2f';

// 만료된 Supabase 세션이 페이지 쿼리를 멈추게 만드는 버그 방지
try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('sb-') || !key.endsWith('-auth-token')) continue;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const exp = parsed?.expires_at;
      if (typeof exp === 'number' && exp * 1000 < Date.now()) {
        localStorage.removeItem(key);
        console.info('[StockRipple] 만료된 세션 자동 제거:', key);
      }
    } catch { localStorage.removeItem(key); }
  }
} catch {}

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 실시간 접속자 표시용 (관리자 대시보드) — 페이지뷰 집계가 아니라 현재 열려있는 탭 수 근사치
(function trackPresence() {
  try {
    let sid = sessionStorage.getItem('sr_sid');
    if (!sid) { sid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; sessionStorage.setItem('sr_sid', sid); }
    const ch = sb.channel('site-presence', { config: { presence: { key: sid } } });
    ch.subscribe(status => { if (status === 'SUBSCRIBED') ch.track({ page: location.pathname }); });
  } catch {}
})();

function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// onClick을 넘기면 토스트가 클릭 가능해진다(예: "새 리포트 올라왔어요" → 누르면 그 리포트로
// 바로 이동, 2026-07-28 추가) — 예전엔 텍스트만 있고 눌러도 아무 반응이 없었다. 클릭하면
// 콜백 실행 후 토스트를 바로 닫는다(다시 눌리는 걸 방지).
function showToast(msg, type = 'info', onClick = null) {
  const t = document.getElementById('toast');
  if (!t) return;
  const icons = { success: '✓', error: '✗', info: 'ℹ' };
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icons[type] || ''}</span><span>${escHtml(msg)}</span>`;
  t.classList.add('show');
  t.style.cursor = onClick ? 'pointer' : '';
  t.onclick = onClick ? () => { t.classList.remove('show'); onClick(); } : null;
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(() => t.classList.remove('show'), onClick ? 6000 : 3000);
}
// 옛 페이지들이 쓰던 이름 — 그대로 동작하도록 별칭 유지
function showShareToast(msg) { showToast(msg, 'info'); }

/* ══════════════════ 헤더/푸터 ══════════════════ */

// "🎯 매수 후보"는 2026-07-22부로 뺐다 — analyze_batches/company_summary 파이프라인을
// 유사투자자문업 리스크로 완전히 껐고, picks.html이 계속 빈 화면이라 nav 진입점 자체를 없앤다
// (페이지는 남아있음, URL로는 접근 가능).
// "🧭 섹터 지도"(sectors.html)도 같은 날 뺐다 — 이 페이지의 핵심(파급 섹터맵·섹터별 종목
// 랭킹·매수논리)이 전부 꺼둔 analyze 파이프라인에 의존해서 sector-map API가 빈 맵만 반환한다
// (handleSectorMapGet의 analyze 플래그 가드). analyze 재활성화 전까지 살릴 수 없으므로 진입점 제거.
const SITE_NAV_ITEMS = [
  { href: '/news.html', label: '📰 뉴스', flag: 'nav-new' },
  { href: '/heatmap.html', label: '🔥 히트맵' },
  { href: '/kr-market.html', label: '📊 시장 현황' },
  { href: '/etf.html', label: '🧺 ETF', flag: 'nav-new' },
  { href: '/earnings.html', label: '📊 실적발표', flag: 'nav-new' },
  { href: '/talks.html', label: '💬 말말말', flag: 'nav-new' },
  { href: '/portfolio.html', label: '📝 모의투자' },
];

function _siteChromeInjectStyle() {
  if (document.getElementById('site-chrome-style')) return;
  const style = document.createElement('style');
  style.id = 'site-chrome-style';
  style.textContent = `
.header{position:sticky;top:0;z-index:100;background:rgba(var(--bg-rgb),0.80);backdrop-filter:blur(14px) saturate(150%);border-bottom:1px solid var(--border);padding:0 24px}
.header-inner{max-width:1400px;margin:0 auto;display:flex;align-items:center;gap:16px;height:56px}
.logo{display:flex;align-items:center;gap:10px;text-decoration:none;flex-shrink:0}
.logo-icon{width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,var(--blue) 0%,var(--purple) 100%);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;box-shadow:0 3px 10px rgba(36,87,230,0.30)}
.logo-text{font-size:19px;font-weight:800;color:var(--text);letter-spacing:-0.02em}
.logo-sub{font-size:13px;color:var(--text3);font-weight:500;margin-top:1px;letter-spacing:0}
.header-search{display:flex;align-items:center;gap:6px;background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:7px 10px;flex:1 1 auto;max-width:260px;min-width:0}
.header-search svg{color:var(--text3);flex-shrink:0}
.header-search input{flex:1;min-width:0;border:none;outline:none;background:none;font-size:15.5px;color:var(--text);font-family:inherit}
.header-search input::placeholder{color:var(--text3)}
/* 태블릿(761~1300px)에서는 숨긴다 — nav-btn 7개 + 로그인 버튼이 이 폭에서 검색창까지
   넣으면 겹친다(실측: 762px 이하 헤더 안에 nav만으로도 850px+ 필요). 760px 이하(모바일,
   header-nav도 줄바꿈되는 지점)에서는 아래 미디어쿼리가 다시 보이게 하면서 로고 옆
   자체 줄로 재배치한다. */
@media (max-width:1300px){ .header-search{display:none} }
.login-icon{display:none}
.header-nav{display:flex;gap:2px;margin-left:auto;align-items:center}
.nav-btn{padding:7px 13px;border-radius:16px;font-size:15.5px;font-weight:500;background:none;border:none;color:var(--text2);cursor:pointer;text-decoration:none;display:flex;align-items:center;gap:6px;transition:all .12s;white-space:nowrap}
.nav-btn:hover{background:var(--bg3);color:var(--text)}
.nav-btn.active{background:var(--blue);color:#fff;font-weight:600}
.nav-new{position:relative}
.nav-new::after{content:"";position:absolute;top:2px;right:1px;width:7px;height:7px;border-radius:50%;background:var(--red);box-shadow:0 0 0 2px var(--bg),0 0 6px var(--red)}
.nav-btn-primary{background:var(--blue);color:#fff;padding:7px 16px;margin-left:6px;border-radius:16px;font-size:15.5px;font-weight:600;text-decoration:none;cursor:pointer;border:none;transition:all .12s;white-space:nowrap;flex-shrink:0}
.nav-btn-primary:hover{background:#1e4ccc}
.theme-toggle{width:30px;height:30px;flex-shrink:0;border-radius:50%;background:var(--bg3);border:1px solid var(--border);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;margin-left:6px;transition:all .12s}
.theme-toggle:hover{background:var(--bg4);color:var(--text);border-color:var(--border-strong)}
.user-menu{position:relative;flex-shrink:0}
.user-avatar-btn{width:32px;height:32px;border-radius:50%;background:var(--blue-dim);color:var(--blue);border:1.5px solid var(--blue);font-size:15.5px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center}
.user-dropdown{position:absolute;top:calc(100% + 8px);right:0;background:var(--bg2);border:1px solid var(--border);border-radius:16px;min-width:140px;overflow:hidden;z-index:500;box-shadow:0 20px 50px rgba(0,0,0,.6)}
.dropdown-item{display:block;width:100%;padding:10px 14px;font-size:15.5px;color:var(--text2);background:none;border:none;text-align:left;cursor:pointer;text-decoration:none;transition:all .12s}
.dropdown-item:hover{background:var(--bg3);color:var(--text)}
@media (max-width:760px){
  /* 로고 옆 검색창이 남는 폭을 전부 쓰게 하고(피드백: "검색창 영역 좀 늘려"),
     테마토글·로그인/계정은 헤더에서 빼 우측 하단 ⋯ 독으로 옮긴다(consolidateMobileFabs).
     .header-nav 하위로 스코프를 걸어 숨기므로, 독으로 reparent되는 순간 이 규칙이
     더 이상 안 걸려 자동으로 다시 보인다 — 페이지별 #loginBtn 규칙(8개 파일에 중복)
     보다 특이도가 높아 그쪽도 같이 이긴다. nav 링크 7개는 둘째 줄부터 자체 줄바꿈. */
  .header-inner{flex-wrap:wrap;height:auto;padding:8px 0;row-gap:6px;position:relative}
  .header-search{display:flex;max-width:none;flex:1 1 0;min-width:0;order:1}
  .logo{flex-shrink:0}
  .header-nav{flex-wrap:wrap;row-gap:4px;flex-basis:100%;order:2;margin-left:0;margin-top:2px}
  .header-nav #themeToggleBtn,.header-nav #loginBtn,.header-nav #userMenu{display:none}
}
/* ⋯ 독으로 옮겨온 로그인/계정 버튼 — 독의 다른 원형 버튼과 같은 모양으로 맞추고,
   계정 드롭다운은 화면 하단에 붙으므로 아래가 아니라 위로 펼친다. */
#srFabDock .nav-btn-primary{width:48px;height:48px;padding:0;margin:0;border-radius:50%;display:flex;align-items:center;justify-content:center}
#srFabDock .login-icon{display:block;width:20px;height:20px}
#srFabDock .login-text{display:none}
#srFabDock .theme-toggle{width:48px;height:48px;margin:0;font-size:19px}
#srFabDock .user-avatar-btn{width:48px;height:48px;font-size:18px}
#srFabDock .user-dropdown{top:auto;bottom:calc(100% + 8px)}
@media (max-width:600px){
  .logo-sub{display:none}
  .nav-btn{padding:6px 9px;font-size:14.5px}
  .header{padding:0 16px}
}
/* 761~1300px 구간은 검색창을 숨겨도 nav-btn 7개 + 로그인 버튼이 꽉 차서, 이 폭에서만
   패딩/폰트를 줄여 한 줄에 들어가게 한다(loginBtn이 white-space:normal이라 flex 압박을
   혼자 뒤집어쓰고 텍스트가 2줄로 줄바꿈되며 46x80px처럼 찌그러지던 버그의 근본 수정 —
   loginBtn 자체는 위 .nav-btn-primary에 추가한 white-space:nowrap+flex-shrink:0로 항상
   원래 크기를 유지하게 하고, 남는 공간은 nav-btn 쪽 패딩/폰트를 줄여서 만든다. 다른 헤더
   규칙보다 뒤에 둬서 동일 우선순위 캐스케이드에서 항상 이기고, min-width:761px로 범위를
   묶어서 위 ≤760px 모바일 레이아웃(로그인 버튼이 동그라미 아이콘이 되는 구간)과 겹치지
   않게 한다 — 안 그러면 이 블록의 padding이 그 동그라미 버튼의 padding:0을 덮어써버림). */
@media (max-width:1300px) and (min-width:761px){
  .header{padding:0 12px}
  .header-inner{gap:8px}
  .nav-btn{padding:7px 4px;font-size:11.5px;gap:2px}
  .nav-btn-primary{padding:7px 10px;margin-left:2px}
  .theme-toggle{margin-left:2px}
  .header-nav{gap:0px}
}
.site-footer{border-top:1px solid var(--border);background:var(--bg2);margin-top:8px}
.site-footer-inner{max-width:1400px;margin:0 auto;padding:20px 28px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:13.5px;color:var(--text3);line-height:1.6}
@media (max-width:600px){ .site-footer-inner{padding:20px 16px} }
.site-footer-inner b{color:var(--text2);font-weight:700}
.site-footer-legal{padding-top:0;border-top:1px solid var(--border);margin-top:0}
.site-footer-legal a{color:var(--text3);text-decoration:underline}
.site-footer-legal a:hover{color:var(--text2)}
.toast{position:fixed;bottom:24px;right:24px;z-index:9999;background:var(--bg4);color:var(--text);border:1px solid var(--border-strong);border-radius:16px;padding:12px 16px;font-size:15.5px;display:flex;align-items:center;gap:8px;box-shadow:0 20px 50px rgba(0,0,0,.6);transform:translateY(80px);opacity:0;transition:all .2s;pointer-events:none}
/* .show일 때 pointer-events를 auto로 되돌리지 않으면, 숨어있을 때 클릭을 막으려던
   기본값(pointer-events:none)이 완전히 보이는 동안에도 그대로 남아 checkNewReports의
   "눌러서 보기" 토스트를 눌러도 클릭이 뒤쪽 요소로 그냥 통과해버린다(피드백, 2026-07-29
   — elementFromPoint로 토스트 정중앙을 찍어도 토스트가 안 잡히는 것으로 재현 확인). */
.toast.show{transform:translateY(0);opacity:1;pointer-events:auto}
.toast.success{box-shadow:0 0 0 1.5px var(--green),0 20px 50px rgba(0,0,0,.6)}
.toast.error{box-shadow:0 0 0 1.5px var(--red),0 20px 50px rgba(0,0,0,.6)}
.auth-overlay{position:fixed;inset:0;background:rgba(19,23,34,0.45);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(6px);animation:siteChromeFadeIn .15s ease}
@keyframes siteChromeFadeIn{from{opacity:0}to{opacity:1}}
.auth-modal{background:var(--bg2);border:1px solid var(--border);border-radius:20px;width:100%;max-width:380px;padding:36px 32px 28px;position:relative;animation:siteChromeSlideUp .2s ease;box-shadow:0 20px 50px rgba(0,0,0,.6)}
@keyframes siteChromeSlideUp{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}
.auth-close{position:absolute;top:14px;right:14px;background:none;border:none;color:var(--text3);cursor:pointer;font-size:18px;width:28px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center;transition:all .12s}
.auth-close:hover{background:var(--bg3);color:var(--text)}
.auth-logo{font-size:17px;font-weight:800;color:var(--text3);margin-bottom:6px}
.auth-logo span{color:var(--blue)}
.auth-title{font-size:24px;font-weight:800;margin-bottom:24px;letter-spacing:-0.02em}
.auth-btn-google{width:100%;padding:12px 16px;border-radius:16px;font-size:16px;font-weight:500;background:#fff;border:1px solid #dadce0;color:#3c4043;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;transition:all .12s;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.auth-btn-google:hover{background:#f8f9fa;box-shadow:0 2px 6px rgba(0,0,0,0.12)}
.auth-btn-google:active{background:#f1f3f4}
.auth-divider{display:flex;align-items:center;gap:12px;margin-bottom:18px;color:var(--text3);font-size:14.5px}
.auth-divider::before,.auth-divider::after{content:'';flex:1;height:1px;background:var(--border)}
.auth-field{position:relative;margin-bottom:12px}
.auth-field label{display:block;font-size:14.5px;font-weight:600;color:var(--text3);margin-bottom:5px}
.auth-input{width:100%;padding:10px 12px;background:var(--bg3);border:1.5px solid var(--border);border-radius:12px;color:var(--text);font-size:16px;outline:none;transition:border-color .12s,box-shadow .12s;font-family:inherit;box-sizing:border-box}
.auth-input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(77,141,255,.22);background:var(--bg2)}
.auth-input::placeholder{color:var(--text3)}
.auth-error{font-size:14.5px;min-height:18px;margin:4px 0 8px;color:var(--red)}
.auth-error.success{color:var(--green)}
.auth-submit-btn{width:100%;padding:12px;border-radius:16px;font-size:16px;font-weight:700;background:var(--blue);border:none;color:#fff;cursor:pointer;transition:all .12s}
.auth-submit-btn:hover{background:#1e4ccc;transform:translateY(-1px);box-shadow:0 4px 12px rgba(36,87,230,0.35)}
.auth-submit-btn:active{transform:none;box-shadow:none}
.auth-submit-btn:disabled{opacity:0.5;cursor:not-allowed;transform:none;box-shadow:none}
.auth-switch{margin-top:18px;text-align:center;font-size:15.5px;color:var(--text3)}
.auth-link{background:none;border:none;color:var(--blue);cursor:pointer;font-size:15.5px;font-weight:600}
.auth-link:hover{text-decoration:underline}
.auth-consent{margin-bottom:14px}
.auth-consent-label{display:flex;align-items:flex-start;gap:8px;font-size:15px;color:var(--text2);cursor:pointer;line-height:1.5}
.auth-consent-label input[type="checkbox"]{margin-top:2px;width:15px;height:15px;flex-shrink:0;accent-color:var(--blue);cursor:pointer}
.auth-link-inline{background:none;border:none;color:var(--blue);cursor:pointer;font-size:15px;font-weight:600;padding:0;text-decoration:underline}
.auth-privacy-text{margin-top:8px;padding:10px 12px;background:var(--bg3);border-radius:12px;font-size:14px;color:var(--text3);line-height:1.7}
.sp-card{display:flex;flex-direction:column;gap:6px;padding:14px 16px;background:var(--bg2);border:1px solid var(--border);border-radius:14px;text-decoration:none;color:var(--text);transition:transform .12s,border-color .12s,box-shadow .12s}
.sp-card:hover{transform:translateY(-2px);border-color:var(--blue);box-shadow:0 8px 24px rgba(0,102,204,0.10)}
.sp-card-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.sp-ticker{font-family:var(--mono);font-size:14.5px;font-weight:700;padding:3px 9px;border-radius:6px;letter-spacing:.3px}
.sp-market{font-size:13.5px;color:var(--text3);font-weight:500}
.sp-name{font-size:17px;font-weight:700;color:var(--text);line-height:1.3}
.sp-name-sub{font-size:13.5px;color:var(--text3);font-weight:400}
.sp-arrow{font-size:13.5px;color:var(--blue);margin-top:4px;font-weight:500}
`;
  document.head.appendChild(style);
}

function _siteHeaderHtml(activePath) {
  const navHtml = SITE_NAV_ITEMS.map(it => {
    const cls = ['nav-btn', it.flag, it.href === activePath ? 'active' : ''].filter(Boolean).join(' ');
    return `<a href="${it.href}" class="${cls}">${it.label}</a>`;
  }).join('\n      ');
  return `
    <header class="header">
      <div class="header-inner">
        <a href="/" class="logo">
          <div class="logo-icon">〜</div>
          <div>
            <div class="logo-text">StockRipple</div>
            <div class="logo-sub">파급효과 주식 전망</div>
          </div>
        </a>
        <div class="header-search" id="headerSearch">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="text" id="searchInput" placeholder="기업명/키워드 또는 티커 (예: AAPL)"
                 onkeydown="if(event.key==='Enter') tryDirectLookup(this.value)">
        </div>
        <nav class="header-nav" id="headerNav">
          ${navHtml}
          <button class="theme-toggle" id="themeToggleBtn" onclick="srToggleTheme()" aria-label="다크/라이트 모드 전환" title="다크/라이트 모드 전환">🌙</button>
          <button class="nav-btn-primary" id="loginBtn" onclick="openAuthModal()" style="display:none">
            <svg class="login-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span class="login-text">로그인</span>
          </button>
          <div class="user-menu" id="userMenu" style="display:none">
            <button class="user-avatar-btn" id="userAvatar" onclick="toggleUserDropdown()"></button>
            <div class="user-dropdown" id="userDropdown" style="display:none">
              <a href="/account.html" class="dropdown-item">계정 설정</a>
              <button class="dropdown-item" onclick="doSignOut()">로그아웃</button>
            </div>
          </div>
        </nav>
      </div>
    </header>

    <!-- 로그인/회원가입 모달 -->
    <div id="authOverlay" class="auth-overlay" style="display:none" onclick="if(event.target===this)closeAuthModal()">
      <div class="auth-modal">
        <button class="auth-close" onclick="closeAuthModal()" aria-label="닫기">✕</button>
        <div class="auth-logo">Stock<span>Ripple</span></div>
        <h2 class="auth-title" id="authTitle">로그인</h2>
        <button class="auth-btn-google" onclick="signInWithGoogle()">
          <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
          Google로 계속하기
        </button>
        <div class="auth-consent" id="authConsentRow" style="display:none">
          <label class="auth-consent-label">
            <input type="checkbox" id="authConsent">
            <span>이메일 주소 수집·이용에 동의합니다. <button type="button" class="auth-link-inline" onclick="togglePrivacyText(event)">약관 보기</button></span>
          </label>
          <div id="authPrivacyText" class="auth-privacy-text" style="display:none">
            · 수집 항목: 이메일 주소 (Google 로그인 시 Google 계정의 이메일)<br>
            · 수집 목적: 회원 식별, 로그인, 관심종목·북마크 등 계정 기반 기능 제공<br>
            · 보유 기간: 회원 탈퇴 시까지 — 탈퇴 즉시 파기<br>
            · 제3자 제공: 없음<br>
            · 동의를 거부할 수 있으나, 거부 시 회원가입이 제한됩니다.
          </div>
        </div>
        <div class="auth-divider"><span>이메일로 계속하기</span></div>
        <form id="authForm" data-mode="signin" onsubmit="submitAuth(event)" autocomplete="on">
          <div class="auth-field">
            <label for="authEmail">이메일</label>
            <input type="email" id="authEmail" name="email" class="auth-input" placeholder="example@email.com" required autocomplete="email">
          </div>
          <div class="auth-field">
            <label for="authPass" id="authPassLabel">비밀번호</label>
            <input type="password" id="authPass" name="password" class="auth-input" placeholder="6자 이상" required minlength="6" autocomplete="current-password">
          </div>
          <div id="authError" class="auth-error"></div>
          <button type="submit" id="authSubmitBtn" class="auth-submit-btn">로그인</button>
        </form>
        <div class="auth-switch" id="authSwitchText">
          계정이 없나요? <button onclick="switchAuthMode('signup')" class="auth-link">회원가입</button>
        </div>
      </div>
    </div>

    <!-- 종목 검색 결과 카드 모달 -->
    <div id="searchPickerModal" style="display:none;position:fixed;inset:0;z-index:9100;background:rgba(0,0,0,.55);align-items:center;justify-content:center;padding:20px" onclick="closeSearchPicker(event)">
      <div style="background:var(--bg);border-radius:18px;max-width:720px;width:100%;max-height:80vh;overflow:hidden;display:flex;flex-direction:column">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-weight:700;font-size:19px">🔍 "<span id="searchPickerQuery"></span>" 검색 결과</span>
            <span id="searchPickerCount" style="font-size:14.5px;color:var(--text3)"></span>
          </div>
          <button onclick="closeSearchPicker()" style="background:var(--bg3);border:none;border-radius:8px;width:30px;height:30px;cursor:pointer;color:var(--text2);font-size:18px">✕</button>
        </div>
        <div id="searchPickerGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;padding:18px 22px;overflow-y:auto"></div>
      </div>
    </div>`;
}

function renderSiteHeader(activePath) {
  _siteChromeInjectStyle();
  const mount = document.getElementById('site-header-mount');
  if (!mount) return;
  mount.outerHTML = _siteHeaderHtml(activePath || location.pathname);
  _updateThemeToggleIcon();
}

/* ══════════════════ 다크/라이트 테마 토글 (2026-07-27) ══════════════════
   각 페이지 <head> 맨 앞의 인라인 스크립트가 localStorage(sr_theme)를 읽어 첫 페인트 전에
   <html data-theme="light">를 이미 세팅해둔다(깜빡임 방지) — 여기서는 토글 버튼과 전환 로직만
   담당. 차트가 있는 페이지(company/market-detail/analysis)는 'sr-theme-change' 커스텀 이벤트를
   구독해 자체적으로 재도색한다(CSS 변수만으론 JS로 그린 chart canvas에 닿지 않으므로). */
function srGetTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function _updateThemeToggleIcon() {
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.textContent = srGetTheme() === 'light' ? '☀️' : '🌙';
}
function srSetTheme(theme) {
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('sr_theme', theme); } catch {}
  _updateThemeToggleIcon();
  window.dispatchEvent(new CustomEvent('sr-theme-change', { detail: { theme } }));
}
function srToggleTheme() {
  srSetTheme(srGetTheme() === 'light' ? 'dark' : 'light');
}

function renderSiteFooter() {
  _siteChromeInjectStyle();
  const mount = document.getElementById('site-footer-mount');
  if (!mount) return;
  mount.outerHTML = `
    <footer class="site-footer">
      <div class="site-footer-inner">
        <span><b>StockRipple</b> · 뉴스 파급효과 기반 AI 종목 분석 — 본 서비스의 모든 분석·추천은 투자 참고용이며, 투자 판단과 책임은 이용자 본인에게 있습니다.</span>
        <span>데이터: Yahoo Finance · 네이버증권 · DART · NewsAPI · Claude AI</span>
      </div>
      <div class="site-footer-inner site-footer-legal">
        <span><a href="/privacy.html">개인정보처리방침</a> · <a href="/terms.html">이용약관</a></span>
        <span>© ${new Date().getFullYear()} StockRipple</span>
      </div>
    </footer>
    <div class="toast" id="toast"></div>`;
}

/* ══════════════════ 인증 (기본/공용 버전) ══════════════════
   관심종목 캐시 등 페이지 전용 부가 로직이 필요한 곳(app.js, analysis.html)은
   initAuth/renderUserMenu를 자신의 버전으로 재정의해서 덮어쓴다 — 여기 손대지 말 것. */
let currentUser = null;

async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  currentUser = session?.user ?? null;
  renderUserMenu(currentUser);
  sb.auth.onAuthStateChange((event, session) => {
    currentUser = session?.user ?? null;
    renderUserMenu(currentUser);
    if (event === 'SIGNED_IN') closeAuthModal();
  });
}

function renderUserMenu(user) {
  const loginBtn = document.getElementById('loginBtn');
  const userMenu = document.getElementById('userMenu');
  if (!loginBtn || !userMenu) return;
  if (!user) {
    loginBtn.style.display = '';
    userMenu.style.display = 'none';
  } else {
    loginBtn.style.display = 'none';
    userMenu.style.display = '';
    const av = document.getElementById('userAvatar');
    if (av) av.textContent = (user.email || '?')[0].toUpperCase();
  }
}

function toggleUserDropdown() {
  const dd = document.getElementById('userDropdown');
  if (dd) dd.style.display = dd.style.display === 'none' ? '' : 'none';
}
document.addEventListener('click', e => {
  if (!e.target.closest('#userMenu')) {
    const dd = document.getElementById('userDropdown');
    if (dd) dd.style.display = 'none';
  }
});

async function doSignOut() {
  await sb.auth.signOut();
  renderUserMenu(null);
  showToast('로그아웃 했습니다');
}

function openAuthModal(mode = 'signin') {
  document.getElementById('authOverlay').style.display = 'flex';
  switchAuthMode(mode);
}
function closeAuthModal() {
  document.getElementById('authOverlay').style.display = 'none';
}
function switchAuthMode(mode) {
  const isSignIn = mode === 'signin';
  document.getElementById('authTitle').textContent = isSignIn ? '로그인' : '회원가입';
  document.getElementById('authSubmitBtn').textContent = isSignIn ? '로그인' : '가입하기';
  document.getElementById('authPassLabel').textContent = isSignIn ? '비밀번호' : '비밀번호 (영문·숫자·특수문자 포함 8자 이상)';
  document.getElementById('authPass').autocomplete = isSignIn ? 'current-password' : 'new-password';
  document.getElementById('authSwitchText').innerHTML = isSignIn
    ? `계정이 없나요? <button onclick="switchAuthMode('signup')" class="auth-link">회원가입</button>`
    : `이미 계정이 있나요? <button onclick="switchAuthMode('signin')" class="auth-link">로그인</button>`;
  document.getElementById('authForm').dataset.mode = mode;
  document.getElementById('authConsentRow').style.display = isSignIn ? 'none' : 'block';
  document.getElementById('authConsent').checked = false;
  document.getElementById('authPrivacyText').style.display = 'none';
  const errEl = document.getElementById('authError');
  errEl.textContent = '';
  errEl.className = 'auth-error';
}
function togglePrivacyText(e) {
  e?.preventDefault();
  const el = document.getElementById('authPrivacyText');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}
// 회원가입 비밀번호 규칙 — 영문+숫자+특수문자 조합, 8자 이상. signin에는 적용 안 함(기존 계정 보호).
function validateSignupPassword(pw) {
  if (pw.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
  if (!/[a-zA-Z]/.test(pw)) return '비밀번호에 영문자를 포함해주세요.';
  if (!/[0-9]/.test(pw)) return '비밀번호에 숫자를 포함해주세요.';
  if (!/[^a-zA-Z0-9]/.test(pw)) return '비밀번호에 특수문자를 포함해주세요.';
  return null;
}
async function submitAuth(e) {
  e.preventDefault();
  const mode = document.getElementById('authForm').dataset.mode;
  const email = document.getElementById('authEmail').value.trim();
  const pass = document.getElementById('authPass').value;
  const errEl = document.getElementById('authError');
  const btn = document.getElementById('authSubmitBtn');

  if (mode === 'signup' && !document.getElementById('authConsent').checked) {
    errEl.className = 'auth-error';
    errEl.textContent = '개인정보 수집·이용에 동의해주세요.';
    return;
  }
  if (mode === 'signup') {
    const pwErr = validateSignupPassword(pass);
    if (pwErr) { errEl.className = 'auth-error'; errEl.textContent = pwErr; return; }
  }

  btn.disabled = true; btn.textContent = '처리 중...';
  errEl.textContent = '';
  try {
    let result;
    if (mode === 'signup') {
      result = await sb.auth.signUp({ email, password: pass });
      if (result.error) throw result.error;
      if (result.data?.user && !result.data.session) {
        errEl.className = 'auth-error success';
        errEl.textContent = '이메일을 확인해 인증 링크를 클릭하세요.';
        return;
      }
    } else {
      result = await sb.auth.signInWithPassword({ email, password: pass });
      if (result.error) throw result.error;
    }
  } catch (err) {
    errEl.className = 'auth-error';
    const msgs = {
      'Invalid login credentials': '이메일 또는 비밀번호가 올바르지 않습니다.',
      'User already registered': '이미 가입된 이메일입니다.',
    };
    errEl.textContent = msgs[err.message] || err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = document.getElementById('authForm').dataset.mode === 'signin' ? '로그인' : '가입하기';
  }
}
async function signInWithGoogle() {
  const mode = document.getElementById('authForm').dataset.mode;
  if (mode === 'signup' && !document.getElementById('authConsent').checked) {
    const errEl = document.getElementById('authError');
    errEl.className = 'auth-error';
    errEl.textContent = '개인정보 수집·이용에 동의해주세요.';
    return;
  }
  await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin } });
}

/* ══════════════════ 상단 종목 검색 ══════════════════ */
async function tryDirectLookup(input) {
  const raw = (input || '').trim();
  if (!raw) return;
  const upper = raw.toUpperCase();
  const isKrTicker = /^\d{6}\.K[SQ]$/i.test(upper);
  const isKrCode6  = /^\d{6}$/.test(upper);
  const isUsTickerPattern = /^[A-Z][A-Z0-9.\-]{0,9}$/.test(upper) && !/^\d/.test(upper);

  if (isKrTicker) { location.href = `/company.html?ticker=${encodeURIComponent(upper)}`; return; }
  if (isKrCode6)  { location.href = `/company.html?ticker=${encodeURIComponent(upper + '.KS')}`; return; }

  showToast(`"${raw}" 검색 중...`);
  try {
    const safe = raw.replace(/[%_'"\\]/g, '');
    const { data: rawMatches } = await sb
      .from('companies')
      .select('ticker, name_ko, name_en, market')
      .or(`name_ko.ilike.%${safe}%,name_en.ilike.%${safe}%,ticker.ilike.${upper}%`)
      .limit(30);

    const rawLower = raw.toLowerCase();
    const safeLower = safe.toLowerCase();
    const rankOf = (m) => {
      const ko = (m.name_ko || '').toLowerCase();
      const en = (m.name_en || '').toLowerCase();
      if (ko === rawLower || en === rawLower) return 0;
      if (ko.startsWith(safeLower) || en.startsWith(safeLower)) return 1;
      return 2;
    };
    const matches = (rawMatches || []).slice().sort((a, b) => {
      const ra = rankOf(a), rb = rankOf(b);
      if (ra !== rb) return ra - rb;
      const ka = /\.K[SQ]$/i.test(a.ticker || '') ? 0 : 1;
      const kb = /\.K[SQ]$/i.test(b.ticker || '') ? 0 : 1;
      if (ka !== kb) return ka - kb;
      return (a.name_ko || a.name_en || '').localeCompare(b.name_ko || b.name_en || '');
    });

    if (matches.length === 1) { location.href = `/company.html?ticker=${encodeURIComponent(matches[0].ticker)}`; return; }
    if (matches.length > 1) {
      const exacts = matches.filter(m => rankOf(m) === 0);
      if (exacts.length === 1) { location.href = `/company.html?ticker=${encodeURIComponent(exacts[0].ticker)}`; return; }
      openSearchPicker(raw, matches);
      return;
    }

    if (isUsTickerPattern) { location.href = `/company.html?ticker=${encodeURIComponent(upper)}`; return; }

    // companies 테이블에 아직 등록 안 된 한국 종목(예: SK네트웍스) — 네이버 자동완성으로 재시도
    try {
      const krRes = await fetch(`/api/stock?type=search-kr&q=${encodeURIComponent(raw)}`);
      const krData = await krRes.json();
      const krItems = krData.items || [];
      if (krItems.length === 1) { location.href = `/company.html?ticker=${encodeURIComponent(krItems[0].ticker)}`; return; }
      if (krItems.length > 1) {
        openSearchPicker(raw, krItems.map(it => ({ ticker: it.ticker, name_ko: it.name, market: 'KR' })));
        return;
      }
    } catch {}

    showToast(`"${raw}" 종목을 찾을 수 없습니다`);
  } catch (e) {
    showToast('검색 실패: ' + e.message);
  }
}

function openSearchPicker(query, matches) {
  const modal = document.getElementById('searchPickerModal');
  const grid  = document.getElementById('searchPickerGrid');
  document.getElementById('searchPickerQuery').textContent = query;
  document.getElementById('searchPickerCount').textContent = `${matches.length}건`;

  grid.innerHTML = matches.map(m => {
    const isKr = m.market === 'KR' || /\.K[SQ]$/i.test(m.ticker);
    const tickerStripped = m.ticker.replace(/\.(KS|KQ)$/i, '');
    const badgeColor = isKr ? 'var(--blue-dim)' : 'var(--purple-dim)';
    const badgeText  = isKr ? 'var(--blue)' : 'var(--purple)';
    return `<a href="/company.html?ticker=${encodeURIComponent(m.ticker)}" class="sp-card">
      <div class="sp-card-top">
        <span class="sp-ticker" style="background:${badgeColor};color:${badgeText}">${escHtml(tickerStripped)}</span>
        <span class="sp-market">${isKr ? '🇰🇷 KR' : '🇺🇸 US'}</span>
      </div>
      <div class="sp-name">${escHtml(m.name_ko || m.name_en || m.ticker)}</div>
      ${m.name_en && m.name_ko !== m.name_en ? `<div class="sp-name-sub">${escHtml(m.name_en)}</div>` : ''}
      <div class="sp-arrow">상세 페이지로 이동 →</div>
    </a>`;
  }).join('');
  modal.style.display = 'flex';
}
function closeSearchPicker(event) {
  if (event && event.target.id !== 'searchPickerModal') return;
  document.getElementById('searchPickerModal').style.display = 'none';
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSearchPicker({ target: { id: 'searchPickerModal' } });
});

// ── 모바일 하단 FAB 통합(2026-07-28) ──────────────────────────────
// 의견주기(.fb-fab)/데일리리포트(.dr-fab, index.html만)/실시간채팅(#srChatBtn, chat.js가
// 동적 주입) 각자 원이 좌우 하단에 따로 떠서, 채팅까지 켜지면 모바일 화면이 번잡했다.
// 존재하는 걸 모아(2개 이상일 때만) 우측 하단 원 하나로 묶고 눌러서 펼치게 한다 — 각
// 버튼은 원래 DOM 그대로 위치만 옮기므로(reparent) 기존 onclick/뱃지 로직은 안 건드린다.
// 데스크톱(폭>768)은 각자 원래 위치 그대로 둔다(공간 여유 있고, PC는 채팅을 사이드
// 고정 패널로 따로 노출하므로 srChatBtn 자체가 기본적으로 안 보임).
function consolidateMobileFabs() {
  if (window.innerWidth > 1100) return; // .dr-fab가 보이기 시작하는 기준(1100px)과 맞춤
  if (document.getElementById('srFabDock')) return; // 이미 통합됨(중복 실행 방지)

  const candidates = [
    { el: document.querySelector('.dr-fab'), label: '데일리 리포트' },
    { el: document.querySelector('#srChatBtn'), label: '실시간 채팅' },
    { el: document.querySelector('.fb-fab'), label: '의견 주기' },
  ].filter(c => c.el && getComputedStyle(c.el).display !== 'none');

  // 헤더의 테마 토글·로그인/계정도 ≤760px에서 이 독으로 옮긴다(2026-07-31, 피드백:
  // "검색창 영역 좀 늘려" + "로그인 버튼은 우측 하단 ...안으로") — 헤더 쪽 CSS
  // (.header-nav #themeToggleBtn 등)가 이 폭에서 이미 그 세 요소를 숨겨뒀으므로,
  // 위 3개 후보와 달리 "지금 보이는지"로 거르지 않는다(로그인 전엔 loginBtn이, 로그인
  // 후엔 userMenu가 display:none이라 그 필터를 쓰면 둘 다 걸러져 로그인 진입점이
  // 통째로 사라진다). 존재 여부만 확인하고 항상 넣는다 — 실제 표시는 옮겨진 뒤
  // #srFabDock 스코프 CSS와 두 요소 자체의 display 토글(initAuth)이 계속 처리한다.
  if (window.innerWidth <= 760) {
    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) candidates.push({ el: themeBtn, label: '테마', keepSize: true });
    // loginBtn/userMenu는 로그인 상태에 따라 정확히 하나만 보이도록 다른 코드가
    // 서로의 display를 토글한다(initAuth) — 각자 따로 한 줄씩 만들면, 안 보이는
    // 쪽의 라벨 칩만 버튼 없이 둥둥 떠 보인다. 하나의 래퍼에 같이 넣어 한 줄로
    // 묶으면 어느 쪽이 보이든 그 줄 안에서 자연히 처리된다.
    const loginBtn = document.getElementById('loginBtn');
    const userMenu = document.getElementById('userMenu');
    if (loginBtn || userMenu) {
      const acctWrap = document.createElement('div');
      acctWrap.style.cssText = 'display:flex;align-items:center';
      // 여러 페이지에 중복된 구버전 규칙(`#loginBtn, .user-menu { position:absolute;
      // top:8px; right:0 }`, id/class 셀렉터라 이 요소들을 독으로 옮긴 뒤에도 계속
      // 걸린다)을 인라인 스타일로 덮어써야 한다 — 래퍼(acctWrap)가 아니라 이 두 요소
      // 자신에게 직접 걸리는 규칙이라, 래퍼만 정리해선 안 지워진다.
      [loginBtn, userMenu].forEach(el => {
        if (!el) return;
        el.style.position = 'static'; el.style.top = ''; el.style.right = ''; el.style.marginLeft = '0';
      });
      if (loginBtn) acctWrap.appendChild(loginBtn);
      if (userMenu) acctWrap.appendChild(userMenu);
      candidates.push({ el: acctWrap, label: '계정', keepSize: true, isWrap: true });
    }
  }
  // 원래는 "1개뿐이면 묶을 이유 없음"이었으나, fb-fab가 없는 페이지(earnings.html 등)에서
  // 채팅 버튼 혼자 구버전 원형 스타일(💬, 위치도 다름)로 남아 있어 페이지마다 우측 하단
  // 아이콘이 서로 달라 보인다는 피드백(2026-07-28) — 1개여도 항상 동일한 "⋯" 독 스타일로
  // 통일한다.
  if (!candidates.length) return;

  const dock = document.createElement('div');
  dock.id = 'srFabDock';
  dock.style.cssText = 'position:fixed;right:16px;bottom:20px;z-index:9300;display:flex;flex-direction:column;align-items:flex-end;gap:10px';

  // transition 없음 — opacity/transform에 transition을 걸면(어느 값으로도) 이후 JS로
  // 바꾼 값이 computed style에 전혀 반영이 안 되는 현상을 실측으로 확인했다(펼쳐도 opacity:0
  // 그대로 남아 버튼이 눌리지도 보이지도 않는 상태가 됨 — chat.js의 padding-right
  // transition 버그와 동일 유형, 2026-07-28). 애니메이션은 포기하고 즉시 전환만.
  const stack = document.createElement('div');
  stack.id = 'srFabStack';
  stack.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:10px;opacity:0;pointer-events:none;transform:translateY(8px)';
  dock.appendChild(stack);

  // 아이콘만으로는 뭘 하는 버튼인지 구분이 안 됐다(실시간채팅/의견주기 둘 다 💬라 동일하게
  // 보임 — 스크린샷으로 확인, 2026-07-28) — 아이콘 왼쪽에 항상 보이는 텍스트 라벨 칩을
  // 붙인다. 크기도 버튼마다 제각각(54/56/48px)이라 스택이 삐뚤빼뚤해 보였던 것도 통일.
  candidates.forEach(({ el, label, keepSize }) => {
    el.style.position = 'static';
    el.style.bottom = ''; el.style.right = ''; el.style.left = ''; el.style.marginLeft = '0';
    // keepSize: 테마/로그인/계정은 #srFabDock 스코프 CSS(위 _siteChromeInjectStyle)가
    // 이미 알맞은 크기를 지정해뒀다 — 특히 .user-menu는 아바타+드롭다운을 감싸는
    // 래퍼라 여기서 48px로 강제하면 내용이 잘린다.
    if (!keepSize) { el.style.width = '48px'; el.style.height = '48px'; el.style.fontSize = '19px'; }
    el.title = label;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px';
    const chip = document.createElement('span');
    chip.textContent = label;
    chip.style.cssText = 'background:var(--bg4,#2f333f);color:var(--text,#f2f4f8);font-size:13px;font-weight:700;padding:6px 12px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.28);white-space:nowrap;border:1px solid var(--border-strong,rgba(255,255,255,.16))';
    row.appendChild(chip);
    row.appendChild(el);
    stack.appendChild(row);
  });

  const main = document.createElement('button');
  main.id = 'srFabMain';
  main.setAttribute('aria-label', '메뉴 열기');
  main.style.cssText = 'width:56px;height:56px;border-radius:50%;border:none;background:var(--blue);color:#fff;font-size:24px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;flex-shrink:0';
  main.textContent = '⋯';
  dock.appendChild(main);
  document.body.appendChild(dock);

  let open = false;
  const setOpen = (v) => {
    open = v;
    stack.style.opacity = open ? '1' : '0';
    stack.style.pointerEvents = open ? 'auto' : 'none';
    stack.style.transform = open ? 'translateY(0)' : 'translateY(8px)';
    // 회전만으로는(⋯ → 45도) "닫기"라는 게 잘 안 읽혀서 다른 닫기 버튼들과 같은 ✕로 교체.
    main.textContent = open ? '✕' : '⋯';
    main.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');
  };
  main.addEventListener('click', () => setOpen(!open));
  // 안에서 뭔가(채팅/리포트/의견주기) 열었으면 그 액션이 먼저 실행되게 살짝 지연 후 접어준다.
  stack.addEventListener('click', (e) => {
    if (open && e.target.closest('button, a')) setTimeout(() => setOpen(false), 150);
  });
}

// ── 실시간 채팅 위젯 로더 — 어드민 플래그(chat)가 켜져 있을 때만 /chat.js를 동적 주입.
// 꺼져 있으면 아무것도 안 만듦(요구사항: '사용할 때만 나오도록'). fail-closed.
// consolidateMobileFabs는 이 fetch 체인의 모든 분기(채팅 켜짐/꺼짐/로드실패) 끝에서
// 정확히 한 번씩 호출 — #srChatBtn이 생기는 시점(비동기)까지 기다렸다가 통합해야
// 하기 때문에 DOMContentLoaded 시점에 바로 부르면 채팅 버튼을 놓친다.
document.addEventListener('DOMContentLoaded', () => {
  if (location.pathname.startsWith('/admin')) return;
  fetch('/api/feedback?action=chat-config')
    .then(r => r.json())
    .then(j => {
      if (!j?.enabled) { consolidateMobileFabs(); return; }
      const sc = document.createElement('script');
      sc.src = '/chat.js';
      sc.onload = () => consolidateMobileFabs();
      sc.onerror = () => consolidateMobileFabs();
      document.body.appendChild(sc);
    })
    .catch(() => consolidateMobileFabs());
});
