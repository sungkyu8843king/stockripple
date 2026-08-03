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
  // 게스트 닉네임 — 예전엔 "게스트+키 뒷 4자리"(예: 게스트7ffn)라 무성의해 보인다는 피드백
  // (2026-08) — 회원 온보딩 때 쓰는 randomNickname()(site-header.js, 전역 함수라 여기서도
  // 바로 호출 가능)과 같은 형용사+명사+숫자 스타일("불꽃거북이5901")로 통일. guestKey처럼
  // localStorage에 한 번 저장해두고 계속 재사용(매번 랜덤이면 새로고침마다 딴 사람처럼 보임).
  let guestNickname = lsGet('sr_chat_gn', null);
  if (!guestNickname) { guestNickname = (typeof randomNickname === 'function') ? randomNickname() : ('게스트' + guestKey.slice(-4)); lsSet('sr_chat_gn', guestNickname); }
  const blocked = new Set(lsGet('sr_chat_blocked', []));
  const myReports = new Set(lsGet('sr_chat_reported', []));
  const myKey = () => (typeof currentUser !== 'undefined' && currentUser) ? 'u:' + currentUser.id : 'g:' + guestKey;

  // 2026-08: 이 패널은 이제 채팅 플래그와 무관하게 항상 뜬다(실시간 랭킹 탭은 항상 필요)
  // — site-header.js가 /api/feedback?action=chat-config 결과를 여기 담아둔다.
  const chatEnabled = window.__srChatEnabled === true;

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtTime = iso => { const d = new Date(iso); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  // ── 스타일 + 마크업 ────────────────────────────────────────
  // ⚠️ 전부 var(--...) 기반 — 하드코딩 hex를 쓰면 라이트/다크 토글 시 이 위젯만 안 바뀐다(2026-07-27 수정).
  const css = document.createElement('style');
  css.textContent = `
  #srChatBtn{position:fixed;right:18px;bottom:88px;z-index:8900;width:48px;height:48px;border-radius:50%;border:1px solid var(--border-strong);background:linear-gradient(135deg,var(--blue),var(--purple));color:#fff;font-size:21px;cursor:pointer;box-shadow:0 6px 20px rgba(36,87,230,.4);display:flex;align-items:center;justify-content:center}
  #srChatBtn .badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:999px;background:var(--red);color:#fff;font-size:13px;font-weight:700;display:none;align-items:center;justify-content:center;padding:0 5px;box-shadow:0 0 0 2px var(--bg)}
  #srChatPanel{position:fixed;top:0;right:0;bottom:0;width:340px;max-width:92vw;z-index:9000;background:var(--bg2);border-left:1px solid var(--border);display:flex;flex-direction:column;transform:translateX(105%);transition:transform .22s ease;box-shadow:-12px 0 40px rgba(0,0,0,.45);font-family:'Inter',sans-serif;color:var(--text)}
  #srChatPanel.open{transform:translateX(0)}
  .src-head{display:flex;align-items:center;gap:8px;padding:13px 16px;border-bottom:1px solid var(--border);flex-shrink:0}
  .src-head b{font-size:16.5px}
  .src-head .live{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);animation:srPulse 1.5s infinite}
  @keyframes srPulse{0%,100%{opacity:1}50%{opacity:.3}}
  .src-head .me{margin-left:auto;font-size:13.5px;color:var(--text3)}
  .src-close{background:none;border:none;color:var(--text3);font-size:20px;cursor:pointer;padding:2px 6px;line-height:1}
  .src-visitors{display:flex;gap:10px;padding:5px 16px;font-size:11.5px;color:var(--text3);border-bottom:1px solid var(--border);flex-shrink:0}
  .src-visitors b{color:var(--text2);font-weight:700}
  .src-close:hover{color:var(--text)}
  #srChatList{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:9px}
  .src-msg{max-width:100%}
  .src-meta{display:flex;align-items:center;gap:6px;font-size:13.5px;color:var(--text3);margin-bottom:2px}
  .src-nick{font-weight:700;color:var(--text2)}
  .src-nick.member{color:var(--blue)}
  .src-mb{font-size:12px;background:var(--blue-dim);color:var(--blue);padding:1px 5px;border-radius:4px;font-weight:700}
  .src-more{background:none;border:none;color:var(--text3);cursor:pointer;font-size:15.5px;padding:0 4px;opacity:0;transition:opacity .1s}
  .src-msg:hover .src-more{opacity:1}
  .src-body{font-size:11.5px;line-height:1.5;word-break:break-word;background:var(--bg3);border-radius:4px 12px 12px 12px;padding:7px 11px;display:inline-block}
  .src-msg.mine .src-body{background:var(--blue-dim)}
  .src-msg.ghost .src-body{color:var(--text3);font-style:italic;background:var(--bg3)}
  .src-menu{position:absolute;background:var(--bg3);border:1px solid var(--border-strong);border-radius:10px;overflow:hidden;z-index:9100;box-shadow:0 8px 24px rgba(0,0,0,.5)}
  .src-menu button{display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);font-size:15px;padding:9px 14px;cursor:pointer;white-space:nowrap}
  .src-menu button:hover{background:var(--bg4)}
  .src-menu button.danger{color:var(--red)}
  #srChatInput{position:relative;display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--border);flex-shrink:0}
  #srChatInput input{flex:1;min-width:0;background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:10px 12px;color:var(--text);font-size:11.5px;outline:none;font-family:inherit}
  #srChatInput input:focus{border-color:var(--blue)}
  #srChatInput button{background:var(--blue);border:none;color:#fff;font-weight:700;font-size:15.5px;border-radius:10px;padding:0 16px;cursor:pointer}
  #srChatInput button:disabled{opacity:.5;cursor:default}
  .src-note{font-size:10px;color:var(--text3);padding:0 16px 10px;flex-shrink:0}
  /* ── @멘션(종목/모의투자) 자동완성 (2026-08) — .hsug-item 등은 site-header.js가 이미
     전역 주입한 클래스를 그대로 재사용(검색 결과 행 스타일 중복 방지). .hsug 자체는
     아래로 펼쳐지는 포지션이라(top:100%) 입력창이 패널 맨 아래에 있는 이 위젯엔 안
     맞아서, 위로 펼쳐지는 별도 래퍼(.src-mention)만 새로 둔다. */
  .src-mention{position:absolute;left:14px;right:14px;bottom:calc(100% + 8px);background:var(--bg2);border:1px solid var(--border-strong);border-radius:14px;box-shadow:0 18px 44px rgba(0,0,0,.42);z-index:9200;max-height:260px;overflow-y:auto}
  /* 종목 카드 — 이름이 길면(예: "에스케이하이닉스(주)") 아이콘+이름+티커+가격을 한 줄에
     욱여넣다가 셋 다 제각각 줄바꿈되던 문제(2026-08 실측)를 고쳐, 처음부터 "왼쪽: 이름
     위·티커 아래" / "오른쪽: 가격 위·등락률 아래" 2단 레이아웃으로 고정한다. */
  /* 종목/모의투자 카드 공통 3분할 레이아웃(아이콘 | 이름-위·부가정보-아래 | 값-위·보조값-아래) —
     모의투자 카드도 처음엔 "📝 모의투자 총자산 ₩9,802,000 · -1.98% · 2종목"을 한 줄
     텍스트로 이어붙였다가, 부모(.src-body)의 word-break:break-word 때문에 "모의투\n자"
     처럼 단어 중간이 그대로 잘려나가는 문제가 있었다(2026-08 실측). 종목 카드와 완전히
     같은 구조를 재사용해 정리한다. */
  .src-mention-stock,.src-mention-port{display:flex;align-items:center;gap:8px;font-size:11.5px;text-decoration:none;color:var(--text);background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:7px 11px;margin-top:2px;max-width:100%}
  .src-mention-stock:hover,.src-mention-port:hover{border-color:var(--blue)}
  .src-mention-stock .mi-icon,.src-mention-port .mi-icon{flex-shrink:0}
  .src-mention-stock .mi-body,.src-mention-port .mi-body{display:flex;flex-direction:column;min-width:0;line-height:1.35}
  .src-mention-stock .mi-name,.src-mention-port .mi-name{font-size:12.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .src-mention-stock .tk,.src-mention-port .tk{font-family:var(--font-mono,'SF Mono',Menlo,monospace);font-size:10.5px;color:var(--text3);white-space:nowrap}
  .src-mention-stock .px,.src-mention-port .px{display:flex;flex-direction:column;align-items:flex-end;line-height:1.35;flex-shrink:0;margin-left:auto;font-family:var(--font-mono,'SF Mono',Menlo,monospace);font-weight:700;white-space:nowrap}
  .src-mention-stock .px .up,.src-mention-port .px .up{color:var(--red)}
  .src-mention-stock .px .dn,.src-mention-port .px .dn{color:var(--blue)}
  .src-mention-stock .px .chg,.src-mention-port .px .chg{font-size:10.5px;font-weight:700}
  @media (max-width:640px){ #srChatBtn{bottom:76px;right:12px} }
  @media (min-width:1200px){ #srChatBtn{display:none} } /* 데스크톱은 원형 버튼 대신 레일이 대신함 */
  /* PC 고정 패널(2026-07-28) — 넓은 화면은 기본으로 열어두고 본문이 패널을 피해 여백을
     둔다. html(documentElement)에 거는 이유 두 가지: (1) 이 스크립트가 모든 페이지에
     공통 로드되는데 페이지마다 본문 컨테이너 클래스명이 달라서(main-content/page-wrap
     등) 특정 클래스에 못 걸고, html은 어느 페이지에서나 동일하게 sticky 헤더까지 포함해
     전체가 같이 줄어든다. (2) body에 직접 걸면(margin-right든 padding-right든) 이
     프로젝트의 프리뷰 툴에서 우측 값만 실제로 반영이 안 되는 현상을 실측으로 확인했다
     (margin-left/padding-left/top/bottom은 정상, 오직 우측만 무시됨 — body 자체의
     특이 동작으로 추정) — html에 걸면 문제없이 반영된다. 데스크톱 전용(min-width:1200px)
     이라 CLAUDE.md가 경고하는 "overflow-x:hidden을 html에 걸면 iOS Safari에서 sticky가
     깨진다" 케이스와는 무관(overflow 속성이 아니라 padding일 뿐이고, 모바일엔 이 클래스
     자체가 안 붙는다). */
  /* transition:padding-right 없음 — 실측 결과 이 속성에 transition을 걸면(어느 값으로도)
     html 루트에서 padding-right 자체가 아예 반영되지 않는 현상이 재현됐다(프로덕션에서
     직접 확인 — transition 제거 시 즉시 정상화). 애니메이션은 포기하고 즉시 전환만. */
  /* ── 아이콘 레일(2026-08) — 데스크톱 전용. 패널을 64px만큼 오른쪽으로 밀어 레일 옆에 붙인다. ── */
  @media (min-width:1200px){
    #srChatPanel{ right:64px; }
    html.sr-chat-pinned-open{ padding-right:404px; } /* 340(패널) + 64(레일) */
  }
  #srRail{display:none;position:fixed;right:0;top:0;bottom:0;width:64px;z-index:9001;background:var(--bg2);border-left:1px solid var(--border);flex-direction:column;align-items:center;padding:14px 0;gap:4px}
  /* 레일이 뜨는 폭에서는 의견주기 아이콘이 레일 안(테마 아래)으로 옮겨가므로,
     페이지마다 따로 떠 있던 독립 .fb-fab(좌하단 보라색 원)은 숨겨 중복을 없앤다. */
  @media (min-width:1200px){ #srRail{display:flex} .fb-fab{display:none} }
  /* 접기/펼치기 — 탭 스타일(.srr-item)로 통일해서 아이콘+라벨("열기·닫기")을 항상 보여주고
     (2026-08), 거기에 더해 "\ 키로도 열고 닫을 수 있다"는 걸 알리는 말풍선을 왼쪽 바깥
     (빈 화면 쪽)에 띄운다. <button> 안에 절대위치 자식을 두면 WebKit 계열에서 버튼 자체
     경계로 잘려 안 보이는 현상이 있어서(2026-08 실측), 말풍선은 버튼의 형제로 빼고
     별도 래퍼(.srr-collapse-wrap)에 위치 기준(position:relative)을 둔다. */
  .srr-collapse-wrap{position:relative;margin-bottom:8px;flex-shrink:0}
  .srr-key-hint{position:absolute;top:50%;right:calc(100% + 12px);transform:translateY(-50%);display:flex;align-items:center;gap:7px;white-space:nowrap;font-size:12.5px;font-weight:700;color:#fff;background:var(--blue);padding:6px 13px 6px 7px;border-radius:10px;box-shadow:0 4px 14px rgba(36,87,230,.45);pointer-events:auto;animation:srrHintNudge 2.2s ease-in-out infinite}
  /* 마우스 올렸을 때만 ✕가 나타나 닫을 수 있게(2026-08 피드백) — 평소엔 안 보이다가
     hover 시에만 나타나므로 배지 자체 레이아웃(padding 등)에 영향 없음. */
  .srr-key-hint-close{display:none;align-items:center;justify-content:center;position:absolute;top:-6px;right:-6px;width:16px;height:16px;border-radius:50%;background:var(--bg);border:1px solid var(--border-strong);color:var(--text2);font-size:9px;line-height:1;cursor:pointer;padding:0}
  .srr-key-hint:hover .srr-key-hint-close{display:flex}
  .srr-key-hint-close:hover{background:var(--bg3);color:var(--text)}
  /* \ 글자를 파란 배경 위에 흰 굵은 글씨로만 두니 잘 안 읽힌다는 피드백(2026-08) —
     실제 키보드 키캡처럼 흰 배경 + 테두리 박스 안에 넣어서 "이게 누르는 키다"가
     한눈에 보이게 함. 폰트는 반드시 Consolas를 앞에 둔다 — 'SF Mono'/Menlo는 macOS
     전용이라 윈도우에서는 시스템 기본 monospace로 대체되는데, 일부 한글 윈도우 폰트가
     0x5C(백슬래시)를 레거시 EUC-KR 관례대로 원화기호(₩)로 그려버리는 문제가 실측됨.
     Consolas(윈도우 기본 코딩 폰트)는 이 문제가 없다. */
  .srr-key-hint kbd{font-family:Consolas,'SF Mono',Menlo,monospace;font-size:13px;font-weight:800;color:var(--blue);background:#fff;border-radius:5px;padding:2px 8px;line-height:1.4;box-shadow:0 1px 0 rgba(0,0,0,.2);font-style:normal}
  .srr-key-hint::after{content:'';position:absolute;top:50%;right:-5px;transform:translateY(-50%);width:0;height:0;border-style:solid;border-width:5px 0 5px 6px;border-color:transparent transparent transparent var(--blue)}
  @keyframes srrHintNudge{0%,15%,100%{transform:translateY(-50%) translateX(0)}7%{transform:translateY(-50%) translateX(-5px)}}
  @media (prefers-reduced-motion:reduce){ .srr-key-hint{animation:none} }
  .srr-item{position:relative;width:56px;padding:9px 0 7px;border:none;background:none;color:var(--text3);font-size:19px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:3px;border-radius:10px}
  .srr-item:hover{background:var(--bg3);color:var(--text2)}
  .srr-item.active{color:var(--blue);background:var(--blue-dim)}
  .srr-item .srr-label{font-size:11px;font-weight:700}
  .srr-item .badge{position:absolute;top:1px;right:6px;min-width:15px;height:15px;border-radius:999px;background:var(--red);color:#fff;font-size:10.5px;font-weight:700;display:none;align-items:center;justify-content:center;padding:0 4px}
  /* ── 탭(채팅/랭킹/관심/최근 본, 2026-08) ── 이 패널은 이제 항상 주입되고(채팅이 꺼져
     있어도), 그 안에서 채팅 탭만 admin 플래그로 노출 여부가 갈린다. ≥1200px에서는
     좌측 레일이 탭 전환을 대신하므로 패널 안 탭바는 숨긴다(중복 컨트롤 방지). */
  .src-tabs{display:flex;flex-shrink:0;border-bottom:1px solid var(--border)}
  @media (min-width:1200px){ .src-tabs{display:none !important} }
  .src-tab{flex:1;padding:10px 0;text-align:center;background:none;border:none;font-size:13.5px;font-weight:700;color:var(--text3);cursor:pointer;border-bottom:2px solid transparent}
  .src-tab.active{color:var(--blue);border-bottom-color:var(--blue)}
  #srChatTabBody{flex:1;min-height:0;display:flex;flex-direction:column}
  .srk-tab-body{flex:1;min-height:0;overflow-y:auto;padding:12px 14px 14px}
  .srk-search{position:relative;margin-bottom:10px}
  .srk-search input{width:100%;box-sizing:border-box;background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:9px 12px;color:var(--text);font-size:14.5px;outline:none;font-family:inherit}
  .srk-search input:focus{border-color:var(--blue)}
  .srk-search input::placeholder{color:var(--text3)}
  .srk-mkts{display:flex;gap:4px;background:var(--bg3);border-radius:10px;padding:3px;margin-bottom:8px}
  .srk-mkt{flex:1;border:none;background:transparent;color:var(--text2);font-size:13.5px;font-weight:700;padding:6px 0;border-radius:8px;cursor:pointer}
  .srk-mkt.active{background:var(--blue);color:#fff}
  .srk-cats{display:flex;gap:5px;overflow-x:auto;margin-bottom:10px;scrollbar-width:none;cursor:grab}
  .srk-cats::-webkit-scrollbar{display:none}
  .srk-cats.dragging{cursor:grabbing;user-select:none}
  .srk-cat{flex-shrink:0;border:1px solid var(--border);background:var(--bg2);color:var(--text2);font-size:13px;font-weight:600;padding:5px 10px;border-radius:999px;cursor:pointer;white-space:nowrap}
  .srk-cat.active{border-color:var(--blue);color:var(--blue);background:var(--blue-dim)}
  .srk-sub-head{font-size:12.5px;font-weight:700;color:var(--text3);margin:10px 0 6px;letter-spacing:.02em}
  .srk-sub-head:first-child{margin-top:0}
  .srk-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border-soft);cursor:pointer;text-decoration:none;color:var(--text)}
  .srk-row:hover{background:var(--bg3)}
  .srk-rank{width:16px;font-size:13px;font-weight:700;color:var(--text3);flex-shrink:0}
  .srk-mkt-badge{flex-shrink:0;font-size:10.5px;font-weight:700;padding:2px 6px;border-radius:5px;white-space:nowrap}
  .srk-mkt-badge.kr{background:var(--blue-dim);color:var(--blue)}
  .srk-mkt-badge.us{background:var(--purple-dim);color:var(--purple)}
  .srk-name{flex:1;min-width:0;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .srk-price{text-align:right;flex-shrink:0}
  .srk-price .v{font-size:13.5px;font-weight:700;font-family:'SF Mono',monospace}
  .srk-price .c{font-size:12px;font-weight:700}
  .srk-price .c.up{color:var(--red)}
  .srk-price .c.dn{color:var(--blue)}
  .srk-loading,.srk-empty{text-align:center;color:var(--text3);font-size:14px;padding:24px 10px}`;
  document.head.appendChild(css);

  const btn = document.createElement('button');
  btn.id = 'srChatBtn'; btn.title = chatEnabled ? '채팅 · 실시간 랭킹' : '실시간 랭킹';
  btn.innerHTML = '💬<span class="badge" id="srChatBadge"></span>';
  const panel = document.createElement('div');
  panel.id = 'srChatPanel';
  panel.innerHTML = `
    <div class="src-head"><span class="live" id="srHeadLive"></span><b id="srHeadTitle">실시간 채팅</b><span class="me" id="srChatMe"></span>
      <button class="src-close" id="srChatClose" title="숨기기">✕</button></div>
    <div class="src-visitors" id="srVisitorStats">
      <span>👥 현재 <b id="srVisitorLive">—</b></span><span>· 전체 <b id="srVisitorTotal">—</b></span>
    </div>
    <div class="src-tabs" id="srTabs">
      ${chatEnabled ? `<button class="src-tab" data-tab="chat">💬 채팅</button>` : ''}
      <button class="src-tab" data-tab="rank">📊 랭킹</button>
      <button class="src-tab" data-tab="wl">⭐ 관심</button>
      <button class="src-tab" data-tab="recent">🕐 최근 본</button>
    </div>
    <div id="srChatTabBody">
      <div id="srChatList"></div>
      <div id="srChatInput"><input id="srChatText" maxlength="300" placeholder="메시지 입력 (최대 300자, @로 종목·모의투자 첨부)" autocomplete="off"><div id="srMentionBox" class="src-mention" style="display:none"></div><button id="srChatSend">전송</button></div>
      <div class="src-note">신고 3회 누적 시 임시 숨김 · 매매 권유/비방은 제재될 수 있어요<br>💡 <b>@종목명</b>으로 종목을, <b>@모투</b>로 내 모의투자 현황을 채팅에 붙여넣을 수 있어요</div>
    </div>
    <div id="srRankTabBody" class="srk-tab-body" style="display:none">
      <div class="srk-search"><input id="srkSearchInput" placeholder="종목명, 티커 검색" autocomplete="off"><div id="srkSugBox"></div></div>
      <div class="srk-mkts" id="srkMkts">
        <button class="srk-mkt active" data-mkt="all">전체</button>
        <button class="srk-mkt" data-mkt="kr">국장</button>
        <button class="srk-mkt" data-mkt="us">해외</button>
      </div>
      <div class="srk-cats" id="srkCats">
        <button class="srk-cat active" data-cat="popular">🔥 인기</button>
        <button class="srk-cat" data-cat="amount">💰 거래대금</button>
        <button class="srk-cat" data-cat="volume">📊 거래량</button>
        <button class="srk-cat" data-cat="gainers">🚀 급상승</button>
        <button class="srk-cat" data-cat="losers">📉 급하락</button>
      </div>
      <div id="srkList"><div class="srk-loading">불러오는 중...</div></div>
    </div>
    <div id="srWlTabBody" class="srk-tab-body" style="display:none">
      <div id="srWlList"><div class="srk-loading">불러오는 중...</div></div>
    </div>
    <div id="srRecentTabBody" class="srk-tab-body" style="display:none">
      <div id="srRecentList"><div class="srk-empty">최근 본 종목이 없습니다</div></div>
    </div>`;
  document.body.appendChild(btn); document.body.appendChild(panel);

  // ── 아이콘 레일(≥1200px) ─────────────────────────────────────
  const rail = document.createElement('div');
  rail.id = 'srRail';
  rail.innerHTML = `
    <div class="srr-collapse-wrap">
      <button class="srr-item srr-collapse" id="srRailCollapse" title="접기/펼치기 (\\ 키, 닫기는 Esc)">
        <span id="srRailCollapseIcon">«</span><span class="srr-label">열기·닫기</span>
      </button>
      <span class="srr-key-hint" id="srKeyHint" style="${lsGet('sr_key_hint_dismissed', false) ? 'display:none' : ''}">
        <kbd>\\</kbd><span>단축키</span>
        <button type="button" class="srr-key-hint-close" id="srKeyHintClose" title="다시 안 보기" aria-label="닫기">✕</button>
      </span>
    </div>
    ${chatEnabled ? `<button class="srr-item" data-tab="chat"><span>💬</span><span class="srr-label">채팅</span><span class="badge" id="srRailChatBadge"></span></button>` : ''}
    <button class="srr-item" data-tab="rank"><span>📊</span><span class="srr-label">실시간</span></button>
    <button class="srr-item" data-tab="wl"><span>⭐</span><span class="srr-label">관심</span></button>
    <button class="srr-item" data-tab="recent"><span>🕐</span><span class="srr-label">최근 본</span></button>
    <button class="srr-item" id="srRailTheme" onclick="srToggleTheme()" title="다크/라이트 모드 전환" style="margin-top:auto">
      <span id="srRailThemeIcon">🌙</span><span class="srr-label">테마</span>
    </button>
    ${document.querySelector('.fb-fab') ? `<button class="srr-item" id="srRailFeedback" title="의견 보내기">
      <span>💬</span><span class="srr-label">의견</span>
    </button>` : ''}`;
  document.body.appendChild(rail);

  // 의견주기는 페이지마다 이미 있는 .fb-fab(app.js의 openFeedbackChat 연결)를 그대로
  // 재사용한다 — 로직을 여기로 옮기면 페이지마다 중복 구현해야 해서, 숨겨둔 원래
  // 버튼을 대신 클릭시키는 방식을 쓴다. .fb-fab가 없는 페이지(company.html 등)에서는
  // 위에서 이 버튼 자체를 안 만든다.
  const railFeedbackBtn = rail.querySelector('#srRailFeedback');
  if (railFeedbackBtn) railFeedbackBtn.addEventListener('click', () => document.querySelector('.fb-fab')?.click());

  // 다크/라이트 토글 — 헤더에 있던 걸 여기로 옮김(2026-08, ≥1200px에서 헤더 쪽은 CSS로
  // 숨김). srToggleTheme/srGetTheme는 site-header.js 전역 함수를 그대로 재사용.
  const railThemeIcon = rail.querySelector('#srRailThemeIcon');
  function _syncRailThemeIcon() {
    if (railThemeIcon && typeof srGetTheme === 'function') railThemeIcon.textContent = srGetTheme() === 'light' ? '☀️' : '🌙';
  }
  _syncRailThemeIcon();
  window.addEventListener('sr-theme-change', _syncRailThemeIcon);

  const list = panel.querySelector('#srChatList');
  const input = panel.querySelector('#srChatText');
  const sendBtn = panel.querySelector('#srChatSend');
  const badge = btn.querySelector('#srChatBadge');
  let unread = 0;

  function renderMe() {
    const el = panel.querySelector('#srChatMe');
    el.textContent = (typeof currentUser !== 'undefined' && currentUser)
      ? ((typeof currentNickname !== 'undefined' && currentNickname) || (currentUser.email || '').split('@')[0])
      : guestNickname;
  }
  window.addEventListener('sr-nickname-change', renderMe);

  // ── 메시지 렌더 ────────────────────────────────────────────
  const seen = new Set(); // 중복 방지(초기 로드 + realtime 겹침)

  // @멘션 마커를 카드로 치환한다. 마커는 자동완성으로만 삽입되므로(사용자가 직접 대괄호를
  // 타이핑해 넣는 경로가 없음) esc()로 먼저 이스케이프한 뒤 치환해도 안전하다.
  //  - [[stock:TICKER:이름]] → 종목 카드(가격은 렌더 직후 배치로 채움, 아래 _srPriceFillPending)
  //  - [[port:총자산:수익률%:종목수]] → 모의투자 스냅샷 카드(작성 시점 값 그대로, 실시간 아님)
  function renderChatBody(raw) {
    let html = esc(raw);
    html = html.replace(/\[\[stock:([A-Za-z0-9.]+):([^\]:]*)\]\]/g, (_, ticker, name) => {
      const label = name || ticker;
      const pxId = 'srmpx-' + Math.random().toString(36).slice(2, 9);
      return `<a class="src-mention-stock" href="/stock/${encodeURIComponent(ticker)}" target="_blank" rel="noopener"><span class="mi-icon">📈</span><span class="mi-body"><b class="mi-name">${label}</b><span class="tk">${esc(ticker.replace(/\.(KS|KQ)$/i, ''))}</span></span><span class="px" id="${pxId}" data-ticker="${esc(ticker)}">…</span></a>`;
    });
    html = html.replace(/\[\[port:(-?\d+):(-?\d+(?:\.\d+)?):(\d+)\]\]/g, (_, nav, pct, pos) => {
      const p = Number(pct);
      const cls = p > 0 ? 'up' : p < 0 ? 'dn' : '';
      const sign = p > 0 ? '+' : '';
      return `<a class="src-mention-port" href="/portfolio.html"><span class="mi-icon">📝</span><span class="mi-body"><b class="mi-name">모의투자</b><span class="tk">${esc(pos)}종목 보유</span></span><span class="px"><span class="${cls}">₩${Number(nav).toLocaleString('ko-KR')}</span><span class="chg ${cls}">${sign}${p.toFixed(2)}%</span></span></a>`;
    });
    return html;
  }

  // 종목 카드의 실시간가는 렌더 즉시(동기) 채우지 않고 배치로 모아 한 번에 조회한다 —
  // 초기 로드 50건이 전부 종목 멘션이면 50번 호출하는 걸 막기 위함(디바운스 200ms).
  let _pxFillTimer = null;
  function schedulePriceFill() {
    clearTimeout(_pxFillTimer);
    _pxFillTimer = setTimeout(async () => {
      const els = [...list.querySelectorAll('.src-mention-stock .px[data-ticker]:not([data-filled])')];
      if (!els.length) return;
      els.forEach(el => el.setAttribute('data-filled', '1')); // 중복 조회 방지(실패해도 재시도 안 함 — 다음 메시지 렌더 시 새 요소만 대상)
      const tickers = [...new Set(els.map(el => el.dataset.ticker))];
      try {
        const r = await fetch('/api/quotes?tickers=' + tickers.map(encodeURIComponent).join(','));
        const j = await r.json();
        const data = j?.data || {};
        for (const el of els) {
          const q = data[el.dataset.ticker];
          if (!q || q.price == null) { el.textContent = ''; continue; }
          const chg = q.changePercent;
          const cls = chg > 0 ? 'up' : chg < 0 ? 'dn' : '';
          const priceStr = q.currency === 'KRW' ? '₩' + Math.round(q.price).toLocaleString('ko-KR') : '$' + Number(q.price).toLocaleString('en-US', { maximumFractionDigits: 2 });
          const pctStr = chg != null ? `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%` : '';
          el.innerHTML = `<span class="${cls}">${esc(priceStr)}</span>${pctStr ? `<span class="chg ${cls}">${esc(pctStr)}</span>` : ''}`;
        }
      } catch { els.forEach(el => { el.textContent = ''; }); }
    }, 200);
  }

  function msgHtml(m) {
    if (m.hidden) return `<div class="src-msg ghost" data-id="${m.id}"><div class="src-body">🚫 신고 누적으로 숨김 처리된 메시지입니다</div></div>`;
    if (blocked.has(m.sender_key)) return `<div class="src-msg ghost" data-id="${m.id}" data-sender="${esc(m.sender_key)}"><div class="src-body">차단한 사용자의 메시지 <button class="src-more" style="opacity:1" onclick="srChatUnblock('${esc(m.sender_key)}')">차단해제</button></div></div>`;
    const mine = m.sender_key === myKey();
    return `<div class="src-msg${mine ? ' mine' : ''}" data-id="${m.id}" data-sender="${esc(m.sender_key)}">
      <div class="src-meta"><span class="src-nick${m.is_member ? ' member' : ''}">${esc(m.nickname)}</span>${m.is_member ? '<span class="src-mb">회원</span>' : ''}<span>${fmtTime(m.created_at)}</span>${mine ? '' : `<button class="src-more" onclick="srChatMenu(event,${m.id},'${esc(m.sender_key)}')">⋯</button>`}</div>
      <div class="src-body">${renderChatBody(m.message)}</div></div>`;
  }
  function appendMsg(m, scroll = true) {
    if (seen.has(m.id)) return; seen.add(m.id);
    list.insertAdjacentHTML('beforeend', msgHtml(m));
    if (scroll) list.scrollTop = list.scrollHeight;
    schedulePriceFill();
    if (!panel.classList.contains('open') && !m.hidden) {
      unread++;
      const txt = unread > 9 ? '9+' : unread;
      badge.style.display = 'flex'; badge.textContent = txt;
      const railBadge = rail.querySelector('#srRailChatBadge');
      if (railBadge) { railBadge.style.display = 'flex'; railBadge.textContent = txt; }
    }
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

  // ── @멘션(종목/모의투자) 자동완성 ────────────────────────────
  // "@종목명"은 hFindMatches(site-header.js 전역, 헤더검색·랭킹탭검색과 동일 로직)로 찾은
  // 종목을 [[stock:TICKER:이름]]으로, "@모투"는 지금 이 사용자의 모의투자 계좌를 그
  // 자리에서 스냅샷해 [[port:총자산:수익률:종목수]]로 메시지에 삽입한다. 다른 사용자는
  // paper_portfolios/paper_positions를 RLS로 못 읽으므로, 보내는 시점 숫자를 메시지
  // 자체에 찍어 넣는 방식만 가능하다(공유 이미지 카드와 같은 "지금 스냅샷" 원칙).
  const mentionBox = panel.querySelector('#srMentionBox');
  let _mentionStart = -1;
  let _mentionTimer = null;

  function sanitizeMentionPart(s) {
    // 마커 구분자(: [ ])가 이름에 섞이면 렌더 정규식이 깨지므로 제거 — 자동완성으로만
    // 채워지는 값이라 실제로 걸릴 일은 거의 없지만 방어적으로 처리.
    return String(s || '').replace(/[[\]:]/g, '').trim();
  }
  function closeMention() {
    mentionBox.style.display = 'none';
    mentionBox.innerHTML = '';
    _mentionStart = -1;
  }
  function insertMention(token) {
    if (_mentionStart < 0) return;
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, _mentionStart);
    const after = input.value.slice(caret);
    // DB CHECK(message 1~300자)와 input의 maxlength=300은 프로그램 방식 대입(.value=)엔
    // 적용 안 되므로 여기서 직접 자른다 — 드물게 마커가 잘려도 렌더 정규식이 그냥
    // 안 매칭될 뿐 깨지지 않는다(그레이스풀 디그레이드).
    input.value = (before + token + ' ' + after).slice(0, 300);
    const pos = Math.min((before + token + ' ').length, input.value.length);
    input.setSelectionRange(pos, pos);
    input.focus();
    closeMention();
  }
  async function selectMentionPortfolio() {
    if (typeof currentUser === 'undefined' || !currentUser) {
      if (typeof showToast === 'function') showToast('로그인 후 이용할 수 있어요', 'info');
      closeMention();
      return;
    }
    mentionBox.innerHTML = `<div class="hsug-loading">내 모의투자 불러오는 중…</div>`;
    try {
      const { data: pf } = await sb.from('paper_portfolios').select('id, cash_balance, initial_cash').eq('user_id', currentUser.id).maybeSingle();
      if (!pf) { mentionBox.innerHTML = `<div class="hsug-empty">아직 모의투자를 시작하지 않았어요</div>`; return; }
      const { data: positions } = await sb.from('paper_positions').select('ticker, market, quantity, entry_price, entry_fx_rate')
        .eq('portfolio_id', pf.id).eq('status', 'open');
      const lots = positions || [];
      let posVal = 0;
      if (lots.length) {
        const tickers = [...new Set(lots.map(l => l.ticker))];
        let quotes = {}, fxRate = null;
        try {
          const [qr, fr] = await Promise.all([
            fetch('/api/quotes?tickers=' + tickers.map(encodeURIComponent).join(',')).then(r => r.json()).catch(() => null),
            lots.some(l => l.market !== 'KR' && !l.entry_fx_rate) ? fetch('/api/toss?action=fx').then(r => r.json()).catch(() => null) : null,
          ]);
          quotes = qr?.data || {};
          fxRate = fr?.rate || null;
        } catch {}
        for (const l of lots) {
          const cur = quotes[l.ticker]?.price ?? Number(l.entry_price);
          const fx = l.market === 'KR' ? 1 : (Number(l.entry_fx_rate) || fxRate || 1);
          posVal += cur * fx * Number(l.quantity);
        }
      }
      const total = Number(pf.cash_balance) + posVal;
      const pnlPct = Number(pf.initial_cash) > 0 ? ((total - Number(pf.initial_cash)) / Number(pf.initial_cash)) * 100 : 0;
      insertMention(`[[port:${Math.round(total)}:${pnlPct.toFixed(2)}:${lots.length}]]`);
    } catch {
      mentionBox.innerHTML = `<div class="hsug-empty">불러오기 실패</div>`;
    }
  }
  // ⚠️ 첫 배포 직후 실측(2026-08): "@모투"를 치고 바로 Enter를 누르면 드롭다운에서
  // 아무것도 선택되지 않은 채 "@모투"라는 원문 텍스트 그대로 전송돼버렸다 — 클릭으로만
  // 항목을 선택할 수 있었고 Enter는 무조건 send()로 직행했기 때문. 다른 멘션 UI들처럼
  // 드롭다운이 떠 있을 때는 Enter가 "메시지 전송"이 아니라 "강조된 항목 선택"이 되도록
  // 고쳐야 한다 — 그래서 하이라이트 인덱스를 추적하고, 클릭/Enter가 같은 함수를 타게 한다.
  let _mentionHighlight = 0;
  function activateMentionItem(el) {
    if (!el) return;
    if (el.dataset.kind === 'port') selectMentionPortfolio();
    else if (el.dataset.kind === 'stock') insertMention(`[[stock:${el.dataset.ticker}:${sanitizeMentionPart(el.dataset.name)}]]`);
  }
  function paintMentionHighlight() {
    const items = [...mentionBox.querySelectorAll('.hsug-item')];
    if (!items.length) return;
    if (_mentionHighlight >= items.length) _mentionHighlight = items.length - 1;
    if (_mentionHighlight < 0) _mentionHighlight = 0;
    items.forEach((el, i) => el.classList.toggle('on', i === _mentionHighlight));
  }
  function wireMentionClicks() {
    mentionBox.querySelectorAll('.hsug-item').forEach((el, i) => {
      el.addEventListener('mouseenter', () => { _mentionHighlight = i; paintMentionHighlight(); });
      el.addEventListener('click', () => activateMentionItem(el));
    });
    _mentionHighlight = 0;
    paintMentionHighlight();
  }
  async function renderMentionBox(query) {
    if (_mentionStart < 0) return;
    const q = query.trim();
    const portRow = (!q || '모의투자'.startsWith(q) || '모투'.startsWith(q) || 'portfolio'.startsWith(q.toLowerCase()))
      ? `<div class="hsug-item" data-kind="port">📝 <span class="hsug-nm">모의투자</span><span class="hsug-mkt">내 계좌 스냅샷 첨부</span></div>` : '';
    if (!q) {
      mentionBox.innerHTML = portRow || `<div class="hsug-empty">종목명이나 "모투"를 입력해 보세요</div>`;
      mentionBox.style.display = 'block';
      wireMentionClicks();
      return;
    }
    mentionBox.innerHTML = portRow + `<div class="hsug-loading">검색 중…</div>`;
    mentionBox.style.display = 'block';
    if (typeof hFindMatches !== 'function') { mentionBox.innerHTML = portRow || `<div class="hsug-empty">검색 기능을 불러오지 못했어요</div>`; return; }
    const items = await hFindMatches(q);
    if (_mentionStart < 0 || input.value.slice(_mentionStart + 1, (input.selectionStart ?? input.value.length)).trim() !== q) return; // 그 사이 입력이 바뀌었으면 버림
    const stockRows = items.slice(0, 6).map(m => {
      const isKr = m.market === 'KR' || /\.K[SQ]$/i.test(m.ticker);
      const name = m.name_ko || m.name_en || m.ticker;
      return `<div class="hsug-item" data-kind="stock" data-ticker="${esc(m.ticker)}" data-name="${esc(name)}">
        <span class="hsug-tk ${isKr ? 'kr' : 'us'}">${esc(m.ticker.replace(/\.(KS|KQ)$/i, ''))}</span>
        <span class="hsug-nm">${esc(name)}</span><span class="hsug-mkt">${isKr ? '국내' : '미국'}</span></div>`;
    }).join('');
    mentionBox.innerHTML = portRow + (stockRows || (portRow ? '' : `<div class="hsug-empty">"${esc(q)}" 검색 결과가 없습니다</div>`));
    wireMentionClicks();
  }
  input.addEventListener('input', () => {
    const val = input.value;
    const caret = input.selectionStart ?? val.length;
    const before = val.slice(0, caret);
    const at = before.lastIndexOf('@');
    // '@' 바로 앞이 공백이거나 문장 시작일 때만 트리거(단어 중간 @는 무시).
    if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) { closeMention(); return; }
    const query = before.slice(at + 1);
    if (/\s/.test(query)) { closeMention(); return; }
    _mentionStart = at;
    clearTimeout(_mentionTimer);
    _mentionTimer = setTimeout(() => renderMentionBox(query), 200);
  });
  // ⚠️ 이 리스너가 아래 "Enter → send()" 리스너보다 먼저 등록돼(이 파일 아래쪽에서 추가)
  // keydown 처리 순서상 먼저 실행된다 — 드롭다운이 열려있을 때 Enter/화살표를 여기서
  // 가로채 stopImmediatePropagation()하면 뒤의 send() 리스너가 아예 안 불린다.
  input.addEventListener('keydown', e => {
    const openItems = mentionBox.style.display !== 'none' ? [...mentionBox.querySelectorAll('.hsug-item')] : [];
    if (e.key === 'Escape' && mentionBox.style.display !== 'none') { e.stopPropagation(); closeMention(); return; }
    if (!openItems.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); _mentionHighlight = (_mentionHighlight + 1) % openItems.length; paintMentionHighlight(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); _mentionHighlight = (_mentionHighlight - 1 + openItems.length) % openItems.length; paintMentionHighlight(); return; }
    if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); activateMentionItem(openItems[_mentionHighlight]); return; }
  });
  document.addEventListener('click', e => { if (!e.target.closest('#srChatInput')) closeMention(); });

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
        // guestNickname은 로그인 사용자에겐 서버가 무시함(회원은 user_profiles 닉네임 우선) —
        // 게스트일 때만 실제로 쓰인다.
        method: 'POST', headers, body: JSON.stringify({ message: text, guestKey, guestNickname }),
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

  // ── 📊 실시간 랭킹 탭 (2026-08: 메인 페이지 전용 위젯이던 걸 이 패널로 이동해
  // 전 페이지에서 접근 가능하게 함) — 데이터 소스는 메인 페이지가 쓰던 것과 동일한
  // 공개 API(/api/toss?action=rankings-all)를 그대로 재사용, fetch/재시도 패턴도 동일.
  let _srkMkt = 'all', _srkCat = 'popular', _srkLoaded = false, _srkTimer = null;
  const _srkCache = { kr: null, us: null };

  function _srkFmtPrice(v, cur) {
    if (v == null) return '—';
    return cur === 'KRW' ? '₩' + Math.round(v).toLocaleString('ko-KR') : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  async function _srkFetch(market) {
    const delays = [600, 1200, 2400];
    for (let i = 0; i <= delays.length; i++) {
      try {
        const r = await fetch(`/api/toss?action=rankings-all&market=${market}&count=10`);
        if (r.ok) { const j = await r.json(); if (j.ok) return j; }
      } catch {}
      if (i < delays.length) await new Promise(res => setTimeout(res, delays[i]));
    }
    return null;
  }
  async function _srkEnsure(force) {
    const need = _srkMkt === 'all' ? ['kr', 'us'] : [_srkMkt];
    for (const m of need) {
      if (!force && _srkCache[m]) continue;
      const d = await _srkFetch(m === 'kr' ? 'KR' : 'US');
      if (d) _srkCache[m] = d;
    }
  }
  function _srkListHtml(items) {
    if (!items || !items.length) return `<div class="srk-empty">데이터 없음</div>`;
    return items.slice(0, 10).map((it, i) => {
      const chg = it.changePercent;
      const cls = chg > 0 ? 'up' : chg < 0 ? 'dn' : '';
      const sign = chg > 0 ? '+' : '';
      return `<a class="srk-row" href="/company.html?ticker=${encodeURIComponent(it.linkTicker || it.symbol)}">
        <span class="srk-rank">${i + 1}</span>
        <span class="srk-name">${esc(it.name || it.symbol)}</span>
        <span class="srk-price"><div class="v">${_srkFmtPrice(it.price, it.currency)}</div>${chg != null ? `<div class="c ${cls}">${sign}${chg.toFixed(2)}%</div>` : ''}</span>
      </a>`;
    }).join('');
  }
  function _srkRender() {
    const el = panel.querySelector('#srkList');
    if (!el) return;
    const cat = d => (d?.categories?.[_srkCat]) || [];
    if (_srkMkt === 'all') {
      el.innerHTML = `
        <div class="srk-sub-head">🇰🇷 국장</div>
        ${_srkCache.kr ? _srkListHtml(cat(_srkCache.kr)) : `<div class="srk-loading">불러오는 중...</div>`}
        <div class="srk-sub-head">🇺🇸 해외</div>
        ${_srkCache.us ? _srkListHtml(cat(_srkCache.us)) : `<div class="srk-loading">불러오는 중...</div>`}`;
    } else {
      const d = _srkMkt === 'kr' ? _srkCache.kr : _srkCache.us;
      el.innerHTML = d ? _srkListHtml(cat(d)) : `<div class="srk-loading">불러오는 중...</div>`;
    }
  }
  async function initRankTab() {
    await _srkEnsure();
    _srkRender();
    // 콜드 스타트 시 첫 응답 일부가 빌 수 있어 3초 뒤 한 번 더 강제 갱신(메인 페이지 위젯과 동일 패턴).
    setTimeout(async () => { await _srkEnsure(true); _srkRender(); }, 3000);
    if (_srkTimer) clearInterval(_srkTimer);
    _srkTimer = setInterval(async () => { if (document.hidden || !panel.classList.contains('open') || _activeTab !== 'rank') return; await _srkEnsure(true); _srkRender(); }, 10000);
  }
  panel.querySelector('#srkMkts').addEventListener('click', e => {
    const b = e.target.closest('.srk-mkt'); if (!b) return;
    _srkMkt = b.dataset.mkt;
    panel.querySelectorAll('.srk-mkt').forEach(x => x.classList.toggle('active', x === b));
    _srkEnsure().then(_srkRender);
  });
  panel.querySelector('#srkCats').addEventListener('click', e => {
    const b = e.target.closest('.srk-cat'); if (!b) return;
    _srkCat = b.dataset.cat;
    panel.querySelectorAll('.srk-cat').forEach(x => x.classList.toggle('active', x === b));
    _srkRender();
  });

  // PC에서 숨겨둔 스크롤바(scrollbar-width:none) 때문에 이 줄을 스크롤할 방법이
  // 트랙패드 좌우 스와이프뿐이었다 — 마우스 클릭+드래그로도 스크롤되게 추가.
  (function setupDragScroll(el) {
    let down = false, startX = 0, startScroll = 0, moved = false;
    el.addEventListener('mousedown', e => {
      down = true; moved = false;
      startX = e.pageX; startScroll = el.scrollLeft;
      el.classList.add('dragging');
    });
    window.addEventListener('mousemove', e => {
      if (!down) return;
      const walk = e.pageX - startX;
      if (Math.abs(walk) > 4) moved = true;
      el.scrollLeft = startScroll - walk;
    });
    window.addEventListener('mouseup', () => { down = false; el.classList.remove('dragging'); });
    el.addEventListener('click', e => { if (moved) { e.stopPropagation(); e.preventDefault(); } }, true);
  })(panel.querySelector('#srkCats'));

  // 랭킹 탭 검색 — 새 매칭 로직을 만들지 않고 site-header.js의 hFindMatches를 재사용,
  // 결과 마크업도 전역 .hsug/.hsug-item 클래스(_siteChromeInjectStyle이 이미 주입)를 그대로 씀.
  let _srkSugTimer = null;
  const srkSearchInput = panel.querySelector('#srkSearchInput');
  const srkSugBox = panel.querySelector('#srkSugBox');
  srkSearchInput.addEventListener('input', () => {
    clearTimeout(_srkSugTimer);
    const q = srkSearchInput.value.trim();
    if (!q) { srkSugBox.innerHTML = ''; return; }
    _srkSugTimer = setTimeout(async () => {
      if (typeof hFindMatches !== 'function') return;
      srkSugBox.innerHTML = `<div class="hsug"><div class="hsug-loading">검색 중…</div></div>`;
      const items = await hFindMatches(q);
      if (srkSearchInput.value.trim() !== q) return;
      srkSugBox.innerHTML = items.length
        ? `<div class="hsug">${items.map(m => {
            const isKr = m.market === 'KR' || /\.K[SQ]$/i.test(m.ticker);
            return `<a class="hsug-item" href="/company.html?ticker=${encodeURIComponent(m.ticker)}">
              <span class="hsug-tk ${isKr ? 'kr' : 'us'}">${esc(m.ticker.replace(/\.(KS|KQ)$/i, ''))}</span>
              <span class="hsug-nm">${esc(m.name_ko || m.name_en || m.ticker)}</span>
              <span class="hsug-mkt">${isKr ? '국내' : '미국'}</span>
            </a>`;
          }).join('')}</div>`
        : `<div class="hsug"><div class="hsug-empty">"${esc(q)}" 검색 결과가 없습니다</div></div>`;
    }, 220);
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.srk-search')) srkSugBox.innerHTML = '';
  });

  // ── ⭐ 관심 탭 — renderWatchlistView()(app.js)와 동일한 쿼리를 재사용, 가격도
  // 같은 엔드포인트(/api/stock-price) 재사용. DOM id는 app.js의 wlp_*/wlc_*와
  // 겹치지 않게 srwl_ 접두어로 분리(같은 페이지에 두 워치리스트 뷰가 동시에 있을 수 있음).
  async function _srPriceFill(elId, ticker) {
    try {
      const res = await fetch(`/api/stock-price?ticker=${encodeURIComponent(ticker)}`);
      const data = await res.json();
      const el = document.getElementById(elId);
      if (!el || !data.price) return;
      const cur = data.currency || 'USD';
      const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: cur === 'KRW' ? 0 : 2 });
      const chg = data.changePercent;
      const cls = chg > 0 ? 'up' : chg < 0 ? 'dn' : '';
      const sign = chg > 0 ? '+' : '';
      el.innerHTML = `<div class="v">${fmt.format(data.price)}</div>${chg != null ? `<div class="c ${cls}">${sign}${chg.toFixed(2)}%</div>` : ''}`;
    } catch {}
  }
  // 관심/최근 본 탭은 랭킹 탭과 달리 국장·해외 종목이 한 목록에 섞여 있어(구간별로
  // 나뉘지 않음) 로고 없이도 구분되게 국장/미장 배지를 붙인다.
  function _srkMktBadge(market, ticker) {
    const isKr = market === 'KR' || /\.K[SQ]$/i.test(ticker || '');
    return `<span class="srk-mkt-badge ${isKr ? 'kr' : 'us'}">${isKr ? '국장' : '미장'}</span>`;
  }
  async function loadWlTab() {
    const el = panel.querySelector('#srWlList');
    if (!el) return;
    if (typeof currentUser === 'undefined' || !currentUser) {
      el.innerHTML = `<div class="srk-empty">로그인하면 관심종목을 볼 수 있어요<br><button class="src-more" style="opacity:1;color:var(--blue);font-weight:700;margin-top:6px" onclick="openAuthModal()">로그인</button></div>`;
      return;
    }
    el.innerHTML = `<div class="srk-loading">불러오는 중...</div>`;
    try {
      const { data } = await sb.from('user_watchlist').select('ticker,name,market').order('added_at', { ascending: false });
      if (!data || !data.length) { el.innerHTML = `<div class="srk-empty">관심종목이 없습니다<br>종목 카드의 ☆를 눌러 추가해보세요</div>`; return; }
      el.innerHTML = data.map(w => `
        <a class="srk-row" href="/company.html?ticker=${encodeURIComponent(w.ticker)}">
          ${_srkMktBadge(w.market, w.ticker)}
          <span class="srk-name">${esc(w.name || w.ticker)}</span>
          <span class="srk-price" id="srwl_${esc(w.ticker)}"><div class="v">—</div></span>
        </a>`).join('');
      data.forEach(w => _srPriceFill('srwl_' + w.ticker, w.ticker));
    } catch { el.innerHTML = `<div class="srk-empty">불러오기 실패</div>`; }
  }
  // 로그인/로그아웃 시 관심 탭 갱신 — 이 패널을 연 채로 로그인하면(관심 탭의 "로그인"
  // 버튼 등) 헤더는 바로 갱신되지만 이 탭은 lazy-load 캐시(_srWlLoaded)에 막혀 로그인
  // 전 "로그인하세요" 화면 그대로 남아있던 버그 수정. 캐시를 무효화하고, 지금 관심
  // 탭이 열려 있으면 바로 다시 불러온다.
  sb.auth.onAuthStateChange(() => {
    _srWlLoaded = false;
    if (_activeTab === 'wl') loadWlTab();
  });

  // ── 🕐 최근 본 탭 — 서버 테이블 없이 localStorage로 최근 조회 종목을 기록/표시.
  // 기록은 company.html의 init()에서 sr_recent_views 키에 직접 push(이 파일은 읽기만).
  function readRecentViews() {
    try { return JSON.parse(localStorage.getItem('sr_recent_views')) || []; } catch { return []; }
  }
  function loadRecentTab() {
    const el = panel.querySelector('#srRecentList');
    if (!el) return;
    const items = readRecentViews();
    if (!items.length) { el.innerHTML = `<div class="srk-empty">최근 본 종목이 없습니다<br>종목 페이지를 방문하면 여기 쌓여요</div>`; return; }
    el.innerHTML = items.map(it => `
      <a class="srk-row" href="/company.html?ticker=${encodeURIComponent(it.ticker)}">
        ${_srkMktBadge(it.market, it.ticker)}
        <span class="srk-name">${esc(it.name || it.ticker)}</span>
        <span class="srk-price" id="srrc_${esc(it.ticker)}"><div class="v">—</div></span>
      </a>`).join('');
    items.forEach(it => _srPriceFill('srrc_' + it.ticker, it.ticker));
  }

  // ── 탭 전환 ────────────────────────────────────────────────
  // 마지막으로 보던 탭을 기억 — 이 사이트는 페이지 이동마다 chat.js가 새로 로드되므로
  // (SPA 아님) 저장 안 하면 페이지를 옮길 때마다 항상 기본 탭(채팅)으로 되돌아간다.
  const LAST_TAB_KEY = 'sr_chat_last_tab';
  const VALID_TABS = ['chat', 'rank', 'wl', 'recent'];
  let _activeTab = lsGet(LAST_TAB_KEY, null);
  if (!VALID_TABS.includes(_activeTab) || (_activeTab === 'chat' && !chatEnabled)) {
    _activeTab = chatEnabled ? 'chat' : 'rank';
  }
  let _srWlLoaded = false, _srRecentLoaded = false;
  const tabBodies = {
    chat: panel.querySelector('#srChatTabBody'),
    rank: panel.querySelector('#srRankTabBody'),
    wl: panel.querySelector('#srWlTabBody'),
    recent: panel.querySelector('#srRecentTabBody'),
  };
  const TAB_TITLES = { chat: '실시간 채팅', rank: '실시간 랭킹', wl: '관심종목', recent: '최근 본 종목' };
  const headTitle = panel.querySelector('#srHeadTitle');
  const headLive = panel.querySelector('#srHeadLive');
  const chatMeEl = panel.querySelector('#srChatMe');
  function srSwitchTab(tab) {
    if (tab === 'chat' && !chatEnabled) tab = 'rank';
    if (!tabBodies[tab]) tab = 'rank';
    _activeTab = tab;
    lsSet(LAST_TAB_KEY, tab);
    panel.querySelectorAll('.src-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    rail.querySelectorAll('.srr-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    Object.entries(tabBodies).forEach(([k, el]) => { if (el) el.style.display = k === tab ? (k === 'chat' ? 'flex' : 'block') : 'none'; });
    headTitle.textContent = TAB_TITLES[tab] || '';
    headLive.style.display = tab === 'chat' ? '' : 'none';
    chatMeEl.style.display = tab === 'chat' ? '' : 'none';
    if (tab === 'chat') {
      renderMe();
      if (!seen.size) loadInitial();
      subscribe();
      list.scrollTop = list.scrollHeight;
    } else if (tab === 'rank' && !_srkLoaded) {
      _srkLoaded = true; initRankTab();
    } else if (tab === 'wl' && !_srWlLoaded) {
      _srWlLoaded = true; loadWlTab();
    } else if (tab === 'recent' && !_srRecentLoaded) {
      _srRecentLoaded = true; loadRecentTab();
    }
  }
  panel.querySelectorAll('.src-tab').forEach(b => b.addEventListener('click', () => srSwitchTab(b.dataset.tab)));

  // ── PC 고정 패널(2026-07-28, 2026-08 레일 대응 확장) ────────────
  // 넓은 화면(≥1200px)에서는 기본으로 열어두고, 본문이 패널에 가리지 않게 body에
  // 여백 클래스를 같이 토글한다. "숨기기"를 누르면 접히고, 그 선택은 localStorage에
  // 저장돼 다음 방문에도 유지된다(매번 다시 열리면 오히려 성가심) — 레일 아이콘/원형
  // FAB을 다시 누르면 언제든 재오픈 가능하고, 그러면 숨김 선택이 해제된다.
  const PIN_BREAKPOINT = 1200;
  const HIDDEN_KEY = 'sr_chat_pinned_hidden';
  const isDesktopWide = () => window.innerWidth >= PIN_BREAKPOINT;
  const railCollapseBtn = rail.querySelector('#srRailCollapse');

  function updateRailCollapseIcon() {
    // 탭 스타일로 바뀌면서 버튼 안에 라벨(<span class="srr-label">)이 같이 들어있어
    // textContent를 통째로 덮어쓰면 라벨까지 날아간다 — 아이콘 span만 갈아끼운다.
    const icon = railCollapseBtn?.querySelector('#srRailCollapseIcon');
    if (icon) icon.textContent = panel.classList.contains('open') ? '«' : '»';
  }

  function openPanel() {
    panel.classList.add('open');
    document.documentElement.classList.toggle('sr-chat-pinned-open', isDesktopWide());
    unread = 0; badge.style.display = 'none';
    const railBadge = rail.querySelector('#srRailChatBadge');
    if (railBadge) railBadge.style.display = 'none';
    srSwitchTab(_activeTab);
    updateRailCollapseIcon();
  }
  function closePanel() {
    panel.classList.remove('open');
    document.documentElement.classList.remove('sr-chat-pinned-open');
    if (isDesktopWide()) lsSet(HIDDEN_KEY, true);
    updateRailCollapseIcon();
  }

  btn.addEventListener('click', () => {
    if (panel.classList.contains('open')) {
      closePanel();
    } else {
      if (isDesktopWide()) lsSet(HIDDEN_KEY, false);
      openPanel();
      if (_activeTab === 'chat') setTimeout(() => input.focus(), 250);
    }
  });
  panel.querySelector('#srChatClose').addEventListener('click', closePanel);

  // 레일: 접기/펼치기 버튼은 패널 열림 상태만 토글. 아이콘 버튼은 그 탭으로 열거나,
  // 이미 그 탭이 열려 있으면 패널을 닫는다(같은 아이콘 재클릭 = 닫기).
  railCollapseBtn?.addEventListener('click', () => {
    if (panel.classList.contains('open')) { closePanel(); } else { openPanel(); }
  });
  // \ 키 말풍선 힌트 — 마우스 올렸을 때 나오는 ✕로 닫으면 다음 방문부터도 안 보이게
  // localStorage에 기억(2026-08 피드백). 버튼 클릭이 뒤의 접기/펼치기 버튼까지 겹쳐
  // 눌리지 않도록 stopPropagation.
  rail.querySelector('#srKeyHintClose')?.addEventListener('click', (e) => {
    e.stopPropagation();
    lsSet('sr_key_hint_dismissed', true);
    const hint = rail.querySelector('#srKeyHint');
    if (hint) hint.style.display = 'none';
  });
  rail.querySelectorAll('.srr-item[data-tab]').forEach(b => {
    b.addEventListener('click', () => {
      const tab = b.dataset.tab;
      if (panel.classList.contains('open') && _activeTab === tab) {
        closePanel();
        return;
      }
      if (isDesktopWide()) lsSet(HIDDEN_KEY, false);
      if (!panel.classList.contains('open')) openPanel();
      srSwitchTab(tab);
      if (tab === 'chat') setTimeout(() => input.focus(), 250);
    });
  });

  // ── 키보드 단축키 — 이 프로젝트에 딱히 정해진 관례가 없어서, VS Code/Notion류
  // 앱들이 사이드바 토글에 흔히 쓰는 백슬래시(\)를 열기/닫기 토글로, Esc를 닫기 전용으로
  // 뒀다(Esc는 이 사이트 다른 곳(검색 결과 모달 등)에서도 이미 "닫기"로 쓰이는 관례라
  // 통일). 입력창에 포커스가 있을 땐 \ 토글은 무시(타이핑 방해 방지) — Esc는 입력 중에도
  // "패널 닫기"로 동작하게 둔다(포커스만 blur하는 게 아니라).
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (panel.classList.contains('open')) closePanel();
      return;
    }
    if (e.key !== '\\' || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    e.preventDefault();
    if (panel.classList.contains('open')) {
      closePanel();
    } else {
      if (isDesktopWide()) lsSet(HIDDEN_KEY, false);
      openPanel();
    }
  });

  // 최초 진입 시 데스크톱 + 사용자가 이전에 명시적으로 숨긴 적 없으면 기본으로 열어둠.
  if (isDesktopWide() && !lsGet(HIDDEN_KEY, false)) openPanel();
  updateRailCollapseIcon();

  // ── 👥 현재/전체 접속자 (패널 상단, 2026-08) ──────────────────────────
  // 현재 접속자: 별도 채널을 또 구독하지 않고, site-header.js가 이미 track()까지 걸어둔
  // 'site-presence' 채널의 sync 결과를 window.__srLiveVisitors/'sr-live-visitors' 이벤트로
  // 받아 쓴다(채널을 하나 더 열면 sync 타이밍이 꼬여 값이 안 뜨는 문제가 있었음). 전체 접속자는
  // 공개 집계 엔드포인트에서 1회만 받아온다(실시간일 필요 없는 누적 숫자).
  (function initVisitorStats() {
    const liveEl = panel.querySelector('#srVisitorLive');
    const totalEl = panel.querySelector('#srVisitorTotal');
    if (!liveEl || !totalEl) return;
    const applyLive = n => { if (n != null) liveEl.textContent = n.toLocaleString('ko-KR'); };
    if (window.__srLiveVisitors != null) applyLive(window.__srLiveVisitors);
    window.addEventListener('sr-live-visitors', e => applyLive(e.detail));
    fetch('/api/admin?action=visitor-count').then(r => r.json()).then(j => {
      if (j.ok && j.total != null) totalEl.textContent = j.total.toLocaleString('ko-KR');
    }).catch(() => {});
  })();
})();
