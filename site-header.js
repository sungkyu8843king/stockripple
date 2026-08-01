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
  { href: '/earnings.html', label: '📢 실적발표', flag: 'nav-new' },
  { href: '/talks.html', label: '💬 말말말', flag: 'nav-new' },
  { href: '/portfolio.html', label: '📝 모의투자' },
];

function _siteChromeInjectStyle() {
  if (document.getElementById('site-chrome-style')) return;

  // 파비콘/앱 아이콘(2026-08) — 페이지마다 <head>에 따로 넣는 대신 헤더가 항상
  // 로드하는 이 함수에서 한 번에 주입한다. 로고의 물결(〜) 마크를 그대로 벡터화한 것.
  if (!document.querySelector('link[rel="icon"]')) {
    [
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' },
      { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16.png' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
    ].forEach(attrs => {
      const link = document.createElement('link');
      Object.entries(attrs).forEach(([k, v]) => link.setAttribute(k, v));
      document.head.appendChild(link);
    });
  }

  const style = document.createElement('style');
  style.id = 'site-chrome-style';
  style.textContent = `
.header{position:sticky;top:0;z-index:100;background:rgba(var(--bg-rgb),0.80);backdrop-filter:blur(14px) saturate(150%);border-bottom:1px solid var(--border);padding:0 24px}
.header-inner{max-width:1400px;margin:0 auto;display:flex;align-items:center;gap:16px;height:56px}
.logo{display:flex;align-items:center;gap:10px;text-decoration:none;flex-shrink:0}
.logo-icon{width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,var(--blue) 0%,var(--purple) 100%);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;box-shadow:0 3px 10px rgba(36,87,230,0.30)}
.logo-text{font-size:19px;font-weight:800;color:var(--text);letter-spacing:-0.02em}
.logo-sub{font-size:13px;color:var(--text3);font-weight:500;margin-top:1px;letter-spacing:0}
.header-search{display:flex;align-items:center;gap:6px;background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:7px 10px;flex:1 1 auto;max-width:420px;min-width:0;position:relative}
.header-search svg{color:var(--text3);flex-shrink:0}
.header-search input{flex:1;min-width:0;border:none;outline:none;background:none;font-size:15.5px;color:var(--text);font-family:inherit}
.header-search input::placeholder{color:var(--text3)}
/* 상단 검색 — 모의투자 주문창의 실시간 자동완성과 같은 방식으로 통일(2026-08-01) */
#hSugBox:empty{display:none}
.hsug{position:absolute;top:calc(100% + 6px);left:0;right:0;background:var(--bg2);border:1px solid var(--border-strong);border-radius:14px;box-shadow:0 18px 44px rgba(0,0,0,.42);z-index:300;max-height:340px;overflow-y:auto}
/* 모바일에서 검색창 자체가 로고 옆 남는 폭만큼만 좁게 잡혀서(≤760px는 폭 제한 없이
   flex:1이지만 실제로는 로고를 빼면 200px 안팎) 드롭다운도 그 폭을 그대로 물려받아
   종목명이 "삼성..."처럼 심하게 잘렸다 — 드롭다운은 입력창 폭에 안 맞추고 화면 우측에
   더 넓게 펼친다(오버레이라 입력창보다 넓어도 위에 뜰 뿐 레이아웃에 영향 없음). */
@media (max-width:760px){ .hsug{left:auto;right:0;width:min(94vw,420px)} }
.hsug-item{display:flex;align-items:center;gap:9px;padding:10px 13px;cursor:pointer;border-bottom:1px solid var(--border-soft);text-decoration:none;color:var(--text)}
.hsug-item:last-child{border-bottom:none}
.hsug-item:hover,.hsug-item.on{background:var(--bg3)}
.hsug-nm{display:block;flex:1;min-width:0;font-size:14.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hsug-mkt{font-size:12px;color:var(--text3);flex-shrink:0}
.hsug-empty,.hsug-loading{padding:14px;text-align:center;color:var(--text3);font-size:13.5px}
.hsug-tk{font-family:var(--font-mono,'SF Mono',Menlo,monospace);font-size:12.5px;font-weight:700;padding:2px 7px;border-radius:5px;flex-shrink:0}
.hsug-tk.kr{background:var(--blue-dim);color:var(--blue)}
.hsug-tk.us{background:var(--purple-dim);color:var(--purple)}
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
/* 2026-08: ≥1200px는 chat.js의 우측 아이콘 레일(#srRail) 하단에 테마 토글을 옮겼으므로
   헤더 쪽은 숨김 — <1200px(태블릿/모바일)는 레일이 없어 헤더에 그대로 유지 */
@media (min-width:1200px){ #headerNav #themeToggleBtn{display:none} }
.user-menu{position:relative;flex-shrink:0}
.user-avatar-btn{width:32px;height:32px;border-radius:50%;background:var(--blue-dim);color:var(--blue);border:1.5px solid var(--blue);font-size:15.5px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center}
.user-dropdown{position:absolute;top:calc(100% + 8px);right:0;background:var(--bg2);border:1px solid var(--border);border-radius:16px;min-width:150px;overflow:hidden;z-index:500;box-shadow:0 20px 50px rgba(0,0,0,.6)}
.dropdown-nick{padding:11px 14px 9px;font-size:14.5px;font-weight:700;color:var(--text);border-bottom:1px solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
/* 카카오 로그인 — 카카오 공식 브랜드 가이드 색상(#FEE500 배경, #191919 텍스트) */
.auth-btn-kakao{width:100%;padding:12px 16px;border-radius:16px;font-size:16px;font-weight:600;background:#FEE500;border:none;color:#191919;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;transition:all .12s;margin-bottom:20px}
.auth-btn-kakao:hover{filter:brightness(0.97)}
.auth-btn-kakao:active{filter:brightness(0.94)}
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
          <input type="text" id="searchInput" placeholder="기업명/키워드 또는 티커 (예: AAPL)" autocomplete="off"
                 oninput="onHeaderSearchInput(this.value)" onfocus="onHeaderSearchInput(this.value)"
                 onkeydown="if(event.key==='Enter') hSearchEnter(this.value); if(event.key==='Escape') this.blur()">
          <div id="hSugBox"></div>
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
              <div class="dropdown-nick" id="userDropdownNick"></div>
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
        <button class="auth-btn-kakao" onclick="signInWithKakao()">
          <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#191919" d="M12 3C6.48 3 2 6.58 2 11c0 2.85 1.87 5.36 4.69 6.78-.15.55-.98 3.55-.99 3.79 0 0-.02.16.09.22.11.06.24.01.24.01.32-.04 3.68-2.41 4.25-2.81.55.08 1.12.12 1.72.12 5.52 0 10-3.58 10-8 0-4.42-4.48-9-10-9z"/></svg>
          카카오로 계속하기
        </button>
        <div class="auth-consent" id="authConsentRow" style="display:none">
          <label class="auth-consent-label">
            <input type="checkbox" id="authConsent">
            <span>이메일 주소 수집·이용에 동의합니다. <button type="button" class="auth-link-inline" onclick="togglePrivacyText(event)">약관 보기</button></span>
          </label>
          <div id="authPrivacyText" class="auth-privacy-text" style="display:none">
            · 수집 항목: 이메일 주소 (카카오 로그인 시 카카오 계정의 이메일)<br>
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

    <!-- 첫 가입 온보딩(닉네임 설정 + 약관 동의) — 배경/ESC로 안 닫힘(필수 단계) -->
    <div id="onboardOverlay" class="auth-overlay" style="display:none">
      <div class="auth-modal">
        <div class="auth-logo">Stock<span>Ripple</span></div>
        <h2 class="auth-title">가입을 완료해주세요</h2>
        <div class="auth-field">
          <label for="onboardNickname">닉네임</label>
          <input type="text" id="onboardNickname" class="auth-input" maxlength="20" placeholder="닉네임" autocomplete="off">
        </div>
        <div class="auth-consent" style="margin-top:6px">
          <label class="auth-consent-label">
            <input type="checkbox" id="onboardConsent">
            <span><a href="/privacy.html" target="_blank" rel="noopener" class="auth-link-inline">개인정보처리방침</a> 및 <a href="/terms.html" target="_blank" rel="noopener" class="auth-link-inline">이용약관</a>에 동의합니다.</span>
          </label>
        </div>
        <div id="onboardError" class="auth-error"></div>
        <button type="button" id="onboardSubmitBtn" class="auth-submit-btn" onclick="submitOnboarding()" disabled>시작하기</button>
        <div class="auth-switch" style="margin-top:10px">
          <button onclick="cancelOnboarding()" class="auth-link">동의하지 않고 나가기</button>
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
        <span><a href="/privacy.html">개인정보처리방침</a> · <a href="/terms.html">이용약관</a> · <a href="mailto:stockrippleinfo@gmail.com">stockrippleinfo@gmail.com</a></span>
        <span>© ${new Date().getFullYear()} StockRipple</span>
      </div>
    </footer>
    <div class="toast" id="toast"></div>`;
}

/* ══════════════════ 인증 (기본/공용 버전) ══════════════════
   관심종목 캐시 등 페이지 전용 부가 로직이 필요한 곳(app.js, analysis.html)은
   initAuth/renderUserMenu를 자신의 버전으로 재정의해서 덮어쓴다 — 여기 손대지 말 것. */
let currentUser = null;

/* ── 계정 공통 닉네임(2026-08) ──────────────────────────────
   initAuth/renderUserMenu는 페이지마다 재정의되지만(위 주석), 이 블록은 그 오버라이드와
   무관하게 항상 한 번만 등록되는 별도의 onAuthStateChange 리스너다 — 어느 페이지에서
   로그인하든, 어떤 페이지의 커스텀 initAuth를 타든 닉네임 보장 로직이 빠지지 않는다.
   Supabase JS v2는 구독 시 현재 세션으로 'INITIAL_SESSION' 이벤트를 한 번 먼저 쏴주므로
   새로고침 시에도 currentNickname이 채워진다. */
let currentNickname = null;
function randomNickname() {
  const adjs = ['용감한', '냉철한', '불꽃', '조용한', '전설의', '프로', '초보', '행운의', '신중한', '과감한'];
  const nouns = ['개미', '황소', '부엉이', '매수왕', '존버러', '투자자', '불곰', '여우', '거북이', '토끼'];
  const a = adjs[Math.floor(Math.random() * adjs.length)];
  const n = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${a}${n}${num}`;
}
// 이 온보딩(닉네임 설정+약관 동의) 기능이 배포된 시점 이후 만들어진 계정만 온보딩
// 대상으로 본다 — 그 전부터 있던 기존 회원은 원래 요청대로 조용히 임의 닉네임만 받는다.
// last_sign_in_at 근접 여부 같은 "방금 로그인했는지"로 판단하면, 온보딩에서
// "동의하지 않고 나가기"를 누른 뒤 시간이 좀 지나 다시 로그인했을 때 "기존 회원"으로
// 오분류돼 동의 없이 조용히 통과해버리는 구멍이 생긴다 — created_at은 고정값이라 그 문제가 없다.
const NICKNAME_ONBOARDING_LAUNCH = new Date('2026-08-01T12:00:00Z');
function _needsOnboarding(user) {
  if (!user.created_at) return false;
  return new Date(user.created_at) >= NICKNAME_ONBOARDING_LAUNCH;
}
async function ensureNickname(user) {
  if (!user) { currentNickname = null; return; }
  try {
    const { data } = await sb.from('user_profiles').select('nickname').eq('user_id', user.id).maybeSingle();
    if (data?.nickname) {
      currentNickname = data.nickname;
      window.dispatchEvent(new CustomEvent('sr-nickname-change', { detail: { nickname: currentNickname } }));
      return;
    }
    // privacy.html/terms.html은 온보딩 모달 안에서 링크로 열어보는 대상이라 여기서까지
    // 막으면 정작 약관을 읽으러 갔을 때 그 페이지에서도 모달이 또 떠서 못 읽는
    // 모순이 생긴다(2026-08 실측) — 이 두 페이지에서는 모달을 띄우지 않는다.
    const onboardExempt = location.pathname === '/privacy.html' || location.pathname === '/terms.html';
    if (_needsOnboarding(user) && !onboardExempt) {
      // 방금 가입한 계정 — 닉네임을 조용히 자동 생성하지 않고, 직접 정하게 하면서
      // 약관 동의도 같이 받는다(구글/카카오는 시작하기 전 동의 화면이 따로 없어서).
      showOnboarding(user);
      return;
    }
    if (onboardExempt) return; // 아직 프로필이 없어도 이 두 페이지에선 조용히 넘어간다
    // 이 기능 도입 전부터 있던 기존 회원 — 원래 요청대로 조용히 임의 닉네임 생성.
    const nick = randomNickname();
    const { error } = await sb.from('user_profiles').insert({ user_id: user.id, nickname: nick });
    if (!error) {
      currentNickname = nick;
    } else {
      // 다른 탭/기기가 동시에 먼저 만들었을 수 있음(user_id가 PK라 INSERT 충돌) — 재조회.
      const { data: retry } = await sb.from('user_profiles').select('nickname').eq('user_id', user.id).maybeSingle();
      currentNickname = retry?.nickname || null;
    }
  } catch { currentNickname = null; }
  window.dispatchEvent(new CustomEvent('sr-nickname-change', { detail: { nickname: currentNickname } }));
}
sb.auth.onAuthStateChange((_event, session) => { ensureNickname(session?.user ?? null); });

function showOnboarding(user) {
  const overlay = document.getElementById('onboardOverlay');
  const nickInput = document.getElementById('onboardNickname');
  const consent = document.getElementById('onboardConsent');
  const btn = document.getElementById('onboardSubmitBtn');
  const errEl = document.getElementById('onboardError');
  if (!overlay || !nickInput) return;
  nickInput.value = randomNickname();
  consent.checked = false;
  errEl.textContent = '';
  btn.disabled = true;
  overlay.dataset.userId = user.id;
  const syncBtn = () => { btn.disabled = !consent.checked || !nickInput.value.trim(); };
  nickInput.oninput = syncBtn;
  consent.onchange = syncBtn;
  overlay.style.display = 'flex';
}
async function submitOnboarding() {
  const overlay = document.getElementById('onboardOverlay');
  const userId = overlay?.dataset.userId;
  const nick = document.getElementById('onboardNickname').value.trim();
  const errEl = document.getElementById('onboardError');
  const btn = document.getElementById('onboardSubmitBtn');
  if (!userId) return;
  if (!nick) { errEl.textContent = '닉네임을 입력해주세요.'; return; }
  if (nick.length > 20) { errEl.textContent = '닉네임은 20자 이하로 입력해주세요.'; return; }
  btn.disabled = true; btn.textContent = '처리 중...';
  const { error } = await sb.from('user_profiles').insert({
    user_id: userId, nickname: nick, terms_agreed_at: new Date().toISOString(),
  });
  btn.disabled = false; btn.textContent = '시작하기';
  if (error) { errEl.textContent = '저장 중 오류가 발생했습니다: ' + error.message; return; }
  currentNickname = nick;
  window.dispatchEvent(new CustomEvent('sr-nickname-change', { detail: { nickname: nick } }));
  overlay.style.display = 'none';
}
// 동의하지 않고 나가기 — 프로필(닉네임/약관동의) 행 없이는 우리 서비스 이용 자체가
// 안 되므로, 방금 만들어진 세션을 로그아웃시켜 로그인 전 상태로 되돌린다. 카카오/구글
// 쪽 연동 자체는 남아있어 다음에 다시 로그인하면 동일한 온보딩을 다시 거치게 된다.
async function cancelOnboarding() {
  const overlay = document.getElementById('onboardOverlay');
  if (overlay) overlay.style.display = 'none';
  await sb.auth.signOut();
  if (typeof showToast === 'function') showToast('동의하지 않아 가입을 취소했습니다.', 'info');
}
function _syncDropdownNick() {
  const el = document.getElementById('userDropdownNick');
  if (el) el.textContent = currentNickname || '닉네임 불러오는 중…';
}
window.addEventListener('sr-nickname-change', _syncDropdownNick);

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
  _syncDropdownNick();
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
function _checkAuthConsent() {
  const mode = document.getElementById('authForm').dataset.mode;
  if (mode === 'signup' && !document.getElementById('authConsent').checked) {
    const errEl = document.getElementById('authError');
    errEl.className = 'auth-error';
    errEl.textContent = '개인정보 수집·이용에 동의해주세요.';
    return false;
  }
  return true;
}
// redirectTo를 location.origin(항상 홈)이 아니라 location.href(현재 페이지)로 줘야
// OAuth 로그인 후 원래 보던 페이지로 돌아온다 — 이전엔 어디서 로그인해도 홈으로
// 튕겨 "리다이렉트가 이상하다"는 피드백을 받았다(2026-08).
//
// 구글 로그인은 2026-08에 넣었다가(Redirect URLs/Client ID/Secret 다 맞춰도 콘솔
// 설정이 계속 꼬이고 재현 안 되는 실패가 반복돼) 결국 빼기로 했다 — signInWithGoogle
// 함수 자체를 없앰. 카카오 로그인만 유지.
// 카카오 로그인 — Supabase 대시보드(Authentication → Providers → Kakao)에 카카오
// 디벨로퍼스에서 발급받은 REST API 키(Client ID)·Client Secret이 등록돼 있어야 동작한다.
// 등록 전엔 이 버튼을 눌러도 Supabase가 "Unsupported provider" 에러를 반환한다.
async function signInWithKakao() {
  if (!_checkAuthConsent()) return;
  await sb.auth.signInWithOAuth({ provider: 'kakao', options: { redirectTo: location.href } });
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

/* 2026-08-01 — 상단 검색을 모의투자 주문창처럼 "타이핑하는 대로 바로 아래 목록이
   뜨는" 방식으로 바꿨다(피드백: 예전엔 Enter를 눌러야만 검색됐다). tryDirectLookup은
   기존 Enter 단축 이동 로직을 그대로 두고, 아래 함수들이 실시간 드롭다운만 새로 맡는다
   — 매칭 알고리즘(정확일치→접두사→부분, KR 상장 우선)은 tryDirectLookup과 동일하게
   맞춰 검색 결과가 Enter로 바로 이동했을 때와 어긋나지 않게 한다. */
let _hSugTimer = null;
function onHeaderSearchInput(v) {
  clearTimeout(_hSugTimer);
  const q = (v || '').trim();
  const box = document.getElementById('hSugBox');
  if (!box) return;
  if (q.length < 1) { box.innerHTML = ''; return; }
  _hSugTimer = setTimeout(() => runHeaderSearch(q), 220);
}

async function hFindMatches(raw) {
  const upper = raw.toUpperCase();
  if (/^\d{6}\.K[SQ]$/i.test(upper)) return [{ ticker: upper, name_ko: raw, market: 'KR' }];
  if (/^\d{6}$/.test(upper)) return [{ ticker: upper + '.KS', name_ko: raw, market: 'KR' }];

  const safe = raw.replace(/[%_'"\\]/g, '');
  let items = [];
  try {
    const { data } = await sb.from('companies')
      .select('ticker, name_ko, name_en, market')
      .or(`name_ko.ilike.%${safe}%,name_en.ilike.%${safe}%,ticker.ilike.${upper}%`)
      .limit(20);
    items = data || [];
  } catch {}

  const rawLower = raw.toLowerCase(), safeLower = safe.toLowerCase();
  const rankOf = (m) => {
    const ko = (m.name_ko || '').toLowerCase(), en = (m.name_en || '').toLowerCase();
    if (ko === rawLower || en === rawLower) return 0;
    if (ko.startsWith(safeLower) || en.startsWith(safeLower)) return 1;
    return 2;
  };
  items.sort((a, b) => {
    const ra = rankOf(a), rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    const ka = /\.K[SQ]$/i.test(a.ticker || '') ? 0 : 1;
    const kb = /\.K[SQ]$/i.test(b.ticker || '') ? 0 : 1;
    if (ka !== kb) return ka - kb;
    return (a.name_ko || a.name_en || '').localeCompare(b.name_ko || b.name_en || '');
  });

  if (items.length < 8) {
    // companies는 방문/분석으로 자동 등록된 종목만 있는 부분집합이라, 아직 한 번도
    // 등록 안 된 한국 종목(예: SK네트웍스)은 네이버 자동완성으로 한 번 더 보완한다.
    try {
      const r = await fetch(`/api/stock?type=search-kr&q=${encodeURIComponent(raw)}`);
      const j = await r.json();
      for (const it of j.items || []) {
        if (items.some(m => m.ticker === it.ticker)) continue;
        items.push({ ticker: it.ticker, name_ko: it.name, market: 'KR' });
      }
    } catch {}
  }

  const isUsTickerPattern = /^[A-Z][A-Z0-9.\-]{0,9}$/.test(upper) && !/^\d/.test(upper);
  if (!items.length && isUsTickerPattern) items.push({ ticker: upper, name_ko: raw, market: 'US' });
  return items.slice(0, 12);
}

async function runHeaderSearch(q) {
  const box = document.getElementById('hSugBox');
  if (!box) return;
  box.innerHTML = `<div class="hsug"><div class="hsug-loading">검색 중…</div></div>`;
  const items = await hFindMatches(q);
  // 입력값이 그 사이 바뀌었으면(빠르게 이어 타이핑) 이 결과는 버린다
  const cur = (document.getElementById('searchInput')?.value || '').trim();
  if (cur !== q) return;
  box.innerHTML = items.length
    ? `<div class="hsug">${items.map(m => {
        const isKr = m.market === 'KR' || /\.K[SQ]$/i.test(m.ticker);
        return `<a class="hsug-item" href="/company.html?ticker=${encodeURIComponent(m.ticker)}">
          <span class="hsug-tk ${isKr ? 'kr' : 'us'}">${escHtml(m.ticker.replace(/\.(KS|KQ)$/i, ''))}</span>
          <span class="hsug-nm">${escHtml(m.name_ko || m.name_en || m.ticker)}</span>
          <span class="hsug-mkt">${isKr ? '국내' : '미국'}</span>
        </a>`;
      }).join('')}</div>`
    : `<div class="hsug"><div class="hsug-empty">"${escHtml(q)}" 검색 결과가 없습니다</div></div>`;
}

async function hSearchEnter(v) {
  const raw = (v || '').trim();
  if (!raw) return;
  const box = document.getElementById('hSugBox');
  const first = box?.querySelector('.hsug-item');
  if (first) { location.href = first.getAttribute('href'); return; }
  // 아직 드롭다운이 안 뜬 상태에서 바로 Enter를 친 경우(디바운스 대기 중 등) — 즉시 조회.
  const items = await hFindMatches(raw);
  if (items.length) { location.href = `/company.html?ticker=${encodeURIComponent(items[0].ticker)}`; return; }
  showToast(`"${raw}" 종목을 찾을 수 없습니다`);
}

document.addEventListener('click', e => {
  if (!e.target.closest('#headerSearch')) {
    const box = document.getElementById('hSugBox');
    if (box) box.innerHTML = '';
  }
});

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
    { el: document.querySelector('#srChatBtn'), label: window.__srChatEnabled ? '채팅·랭킹' : '실시간 랭킹' },
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

// ── 우측 슬라이드 패널 로더(채팅 + 실시간 랭킹, 2026-08) ── /chat.js는 항상 주입한다 —
// 실시간 랭킹 탭은 어드민 플래그와 무관하게 항상 접근 가능해야 하기 때문(플래그를 끄면
// 랭킹까지 같이 사라지는 게 부적절). 어드민 플래그(chat)는 이제 "패널을 띄울지"가 아니라
// "그 안의 채팅 탭을 보여줄지"만 결정한다 — window.__srChatEnabled에 담아 chat.js가 읽는다.
// consolidateMobileFabs는 이 체인의 모든 분기 끝에서 정확히 한 번씩 호출 — #srChatBtn이
// 생기는 시점(비동기)까지 기다렸다가 통합해야 하기 때문에 DOMContentLoaded 시점에 바로
// 부르면 버튼을 놓친다.
document.addEventListener('DOMContentLoaded', () => {
  if (location.pathname.startsWith('/admin')) return;
  fetch('/api/feedback?action=chat-config')
    .then(r => r.json())
    .then(j => { window.__srChatEnabled = !!j?.enabled; })
    .catch(() => { window.__srChatEnabled = false; })
    .finally(() => {
      const sc = document.createElement('script');
      sc.src = '/chat.js';
      sc.onload = () => consolidateMobileFabs();
      sc.onerror = () => consolidateMobileFabs();
      document.body.appendChild(sc);
    });
});
