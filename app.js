
// sb/escHtml/showToast/트래킹/만료세션정리는 이제 site-header.js가 공용으로 제공한다
// (2026-07-22 헤더/푸터/인증 통합) — 이 파일이 로드되기 전에 반드시 site-header.js가
// 동기로 먼저 로드돼 있어야 한다(각 페이지에서 <script src="/site-header.js"> 위치 확인).

// 쿠팡 파트너스 광고(iframe이 우리 도메인이라 same-origin이라 window.top 접근 가능)가
// 소재에 따라 window.open(새 탭)으로 이동을 시도하면 iOS Safari에서 "다른 앱을 열려고
// 합니다" 확인창이 뜬다. 같은 창에서 바로 이동하면 확인창 없이 넘어가므로, 쿠팡 링크에
// 한해 새 탭 시도를 가로채 현재 창 이동으로 강제 전환한다.
(function(){
  const _open = window.open;
  window.open = function(url, ...rest) {
    if (url && /coupang/i.test(url)) { location.href = url; return null; }
    return _open.call(window, url, ...rest);
  };
})();

// 2026-08-01: 9 → 8로 되돌림. 9였던 이유(3열 그리드 3x3 꽉 채우기)가 이후 레이아웃
// 개편으로 깨졌다 — news.html은 보통 2열이라 9는 마지막 줄에 카드 1개만 덩그러니
// 남았다("중간이 어설프게 잘려 보인다" 피드백). 8은 2열(4줄)·4열(2줄) 둘 다 나머지
// 없이 꽉 찬다. 단, index.html 미리보기는 1열(사이드바 옆 좁은 칼럼)이라 이 나머지
// 문제 자체가 없어서, "메인은 9개로" 요청(2026-08-01)에 맞춰 index.html만 9로 예외.
const PAGE_SIZE = document.getElementById('searchHeroSection') ? 9 : 8;
let currentPage = 1;
let currentSector = 'all';
let searchQuery = '';
let totalCount = 0;

const sectorColors = {
  '반도체': 'tag-semi', 'AI': 'tag-ai', '전기차': 'tag-ev', '배터리': 'tag-ev',
  '바이오': 'tag-bio', '제약': 'tag-bio', '핀테크': 'tag-fin', '금융': 'tag-fin',
  '클라우드': 'tag-cloud', 'IT': 'tag-cloud', '로봇': 'tag-robot', '자동화': 'tag-robot',
  '에너지': 'tag-energy', '친환경': 'tag-energy',
};

function getSectorClass(s) { return sectorColors[s] || 'tag-default'; }

function fmtTz(d, tz, showDate) {
  const opts = { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  if (showDate) { opts.month = '2-digit'; opts.day = '2-digit'; }
  return d.toLocaleString('ko-KR', opts).replace(/\. /g, '/').replace(/\.$/, '');
}

function timeAgoHtml(dateStr) {
  const d = new Date(dateStr);
  const diff = (Date.now() - d.getTime()) / 1000;
  let rel;
  if (diff < 60)             rel = '방금 전';
  else if (diff < 3600)      rel = `${Math.floor(diff / 60)}분 전`;
  else if (diff < 86400)     rel = `${Math.floor(diff / 3600)}시간 전`;
  else if (diff < 86400 * 7) rel = `${Math.floor(diff / 86400)}일 전`;
  else                       rel = fmtTz(d, 'Asia/Seoul', true).split(' ')[0]; // MM/DD만

  const kst = fmtTz(d, 'Asia/Seoul', true);
  return `<span class="rel">${rel}</span><span class="abs">${kst} KST</span>`;
}

function timeAgo(dateStr) {
  const d = new Date(dateStr);
  const diff = (Date.now() - d.getTime()) / 1000;
  const abs = fmtTz(d, 'Asia/Seoul', true);
  if (diff < 60) return `방금 전 · ${abs}`;
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전 · ${abs}`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전 · ${abs}`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전 · ${abs}`;
  return abs;
}

function formatNum(n) {
  if (!n) return '—';
  if (n >= 1e12) return (n / 1e12).toFixed(1) + 'T';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  return n.toFixed(0);
}

// 2-패스 애널리스트 파이프라인 배포 시각 — 정확도 통계의 구/신 구간 분리 기준
const PIPELINE_V2_AT = '2026-07-02T13:43';

async function loadStats() {
  if (!document.getElementById('statIssues')) return;
  const accCnt = (extra) => {
    let q = sb.from('analysis_companies').select('id', { count: 'exact', head: true }).not('is_accurate_1d', 'is', null);
    return extra(q);
  };
  const [issuesRes, companiesRes, upsideRes, accTotal, accHit, accNewTotal, accNewHit] = await Promise.all([
    sb.from('analyses').select('*', { count: 'exact', head: true }),
    sb.from('companies').select('*', { count: 'exact', head: true }),
    sb.from('analysis_companies').select('upside_pct'),
    accCnt(q => q),
    accCnt(q => q.eq('is_accurate_1d', true)),
    accCnt(q => q.gte('entry_date', PIPELINE_V2_AT)),
    accCnt(q => q.eq('is_accurate_1d', true).gte('entry_date', PIPELINE_V2_AT)),
  ]);

  document.getElementById('statIssues').textContent = issuesRes.count ?? 0;
  document.getElementById('statCompanies').textContent = companiesRes.count ?? 0;

  const ups = (upsideRes.data || []).map(r => r.upside_pct).filter(Boolean);
  if (ups.length) {
    const avg = ups.reduce((a, b) => a + b, 0) / ups.length;
    document.getElementById('statUpside').textContent = `+${avg.toFixed(1)}%`;
  }

  if (accTotal.count) {
    const rate = Math.round((accHit.count || 0) / accTotal.count * 100);
    let txt = `${rate}% (${accTotal.count.toLocaleString()}건)`;
    // 신규 파이프라인 검증분이 쌓이면 분리 표시 (개편 효과 추적)
    if ((accNewTotal.count || 0) >= 10) {
      const newRate = Math.round((accNewHit.count || 0) / accNewTotal.count * 100);
      txt = `${rate}% · 신규 ${newRate}% (${accNewTotal.count}건)`;
    }
    document.getElementById('statAccuracy').textContent = txt;
  }

  const { data: latest } = await sb.from('issues')
    .select('published_at').eq('is_analyzed', true)
    .order('published_at', { ascending: false }).limit(1);
  if (latest?.[0]) document.getElementById('statUpdated').textContent = timeAgo(latest[0].published_at);
}


// 이슈 피드 — Supabase를 방문자 브라우저에서 직접(anon key, 캐싱 없이) 호출하던 걸 서버
// 엔드포인트(api/admin.js action=issues-feed, 45초 엣지캐시)로 옮겼다. index/heatmap/
// kr-market/picks/sectors/news 6개 페이지가 전부 이 피드를 공유하는데, 기본 뷰(필터 없음)는
// 사실상 전체 방문자가 동일 쿼리를 때리는 셈이라 캐싱 없이는 트래픽이 몰릴 때(예: 커뮤니티
// 홍보 유입) Supabase 커넥션이 소진되거나 응답이 느려질 위험이 컸다 — 필터/검색 로직 자체는
// 서버가 그대로 재현하므로 동작은 동일.
async function loadIssues() {
  const container = document.getElementById('issuesContainer');
  if (!container) return;
  container.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>이슈 불러오는 중...</p></div>';

  const params = new URLSearchParams({
    page: currentPage, pageSize: PAGE_SIZE,
    sector: currentSector, category: currentCategory,
  });
  if (searchQuery) params.set('q', searchQuery);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  let data, error;
  try {
    const r = await fetch(`/api/admin?action=issues-feed&${params}`, { signal: ac.signal });
    const j = await r.json();
    data = j.data;
    error = j.ok ? null : { message: j.error || 'unknown error' };
    if (typeof j.totalCount === 'number') totalCount = j.totalCount;
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">💤</div><p class="empty-title">DB 응답 없음</p><p class="empty-sub">Supabase DB가 슬립 상태일 수 있습니다. 잠시 후 다시 시도해주세요.</p><button class="empty-btn" onclick="loadIssues()">다시 시도</button></div>`;
    return;
  } finally {
    clearTimeout(timer);
  }

  if (error) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p class="empty-title">오류 발생</p><p class="empty-sub">${error.message}</p><button class="empty-btn" onclick="loadIssues()">다시 시도</button></div>`;
    return;
  }

  if (!data?.length) {
    // 검색어가 티커 패턴이면 직접 조회 제안
    const sq = (searchQuery || '').toUpperCase().trim();
    const looksLikeTicker = /^[A-Z][A-Z0-9.\-]{0,9}$/.test(sq) || /^\d{6}\.K[SQ]$/i.test(sq);
    if (sq && looksLikeTicker) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          <p class="empty-title">"${escHtml(sq)}" 은 분석 이력이 없습니다</p>
          <p class="empty-sub">Yahoo Finance에서 가져와 종목 페이지로 이동할 수 있습니다.</p>
          <button class="empty-btn" onclick="location.href='/company.html?ticker=${encodeURIComponent(sq)}'">📊 ${escHtml(sq)} 조회하기</button>
        </div>`;
    } else if (sq) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          <p class="empty-title">"${escHtml(searchQuery)}" 검색 결과 없음</p>
          <p class="empty-sub">정확한 티커를 입력해 직접 조회할 수도 있습니다 (예: AAPL, 005930.KS)</p>
        </div>`;
    } else {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📡</div>
          <p class="empty-title">아직 분석된 이슈가 없습니다</p>
          <p class="empty-sub">관리자 패널에서 뉴스를 수집하고 AI 분석을 실행해주세요.</p>
          <a href="/admin/" class="empty-btn">관리자 패널로 이동</a>
        </div>`;
    }
    return;
  }

  container.innerHTML = `<div class="issues-grid">${data.map(renderIssueCard).join('')}</div>`;
  // 이슈 카운트 표시
  const cntEl = document.getElementById('issuesCount');
  if (cntEl) cntEl.textContent = `${(totalCount || data.length).toLocaleString()}건 · 페이지 ${currentPage}`;
  renderPagination();
  // 🌡️ 지금 산업 온도 보드(news.html 전용) — 최초 1회만 로드
  if (!_sectorTempLoaded && document.getElementById('sectorTempBoard')) { _sectorTempLoaded = true; loadSectorTemp(); }

  // 실시간 폴링 기준점 갱신 + "새 이슈" 배너 리셋 (방금 최신본을 받았으므로)
  _feedTopTs = data[0]?.published_at || _feedTopTs;
  const _b = document.getElementById('newIssueBanner');
  if (_b) _b.style.display = 'none';
}

// ─── 🟢 이슈 피드 실시간 갱신 (장중 폴링) ────────────────────
let _feedTopTs = null;

// KR(09:00–15:30 KST) 또는 US(09:30–16:00 ET) 정규장 여부
function anyMarketOpenNow() {
  const now = new Date();
  const parse = tz => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
    const g = t => p.find(x => x.type === t)?.value;
    return { wd: g('weekday'), min: (parseInt(g('hour')) % 24) * 60 + parseInt(g('minute')) };
  };
  const wk = w => w !== 'Sat' && w !== 'Sun';
  const kr = parse('Asia/Seoul'), us = parse('America/New_York');
  const krOpen = wk(kr.wd) && kr.min >= 540 && kr.min <= 930;   // 09:00–15:30
  const usOpen = wk(us.wd) && us.min >= 570 && us.min < 960;    // 09:30–16:00
  return { krOpen, usOpen, any: krOpen || usOpen };
}

function updateFeedLiveTag() {
  const el = document.getElementById('feedLiveTag');
  if (!el) return;
  const { krOpen, usOpen, any } = anyMarketOpenNow();
  if (any) {
    const who = krOpen && usOpen ? '국장·미장' : krOpen ? '국장' : '미장';
    el.style.display = 'inline-flex';
    el.style.background = 'var(--green-dim)'; el.style.color = 'var(--green)';
    el.innerHTML = `<span class="live-pulse-dot"></span>실시간 · ${who} 장중`;
  } else {
    el.style.display = 'none';
  }
}

// 기본 뷰(1페이지·전체·검색없음)에서만 장중에 새 이슈 개수를 폴링해 배너로 알림 (피드를 강제로 갈아엎지 않음)
//
// ⚠️ 2026-07-28 버그 수정: 여기서 is_analyzed=true로 세고 있었는데, 실제로 화면에 뜨는
// 피드(loadIssues → handleIssuesFeed)는 expose_ripple_effects 플래그가 꺼져 있는 한(현재
// 기본값, 유사투자자문업 대응으로 anon 노출 차단 — CLAUDE.md 참고) ai_digest != '' 기준으로
// 필터링한다. 두 기준이 가리키는 행 집합이 서로 달라서, "새 이슈 N건"이 뜨는데 탭해서
// 다시 불러와도(loadIssues) 그 N건이 애초에 실제 피드 기준으로는 안 보이는 행들이라 배너가
// 절대 안 없어지고 계속 다시 뜨는 버그가 있었다(실측: is_analyzed=true 11건 vs 실제 표시
// 기준 ai_digest!='' 59건 — 서로 다른 집합). 실제 피드와 동일한 기준으로 맞춤.
async function pollNewIssues() {
  if (currentPage !== 1 || currentCategory !== 'all' || currentSector !== 'all' || searchQuery) return;
  if (!anyMarketOpenNow().any || !_feedTopTs) return;
  try {
    const { count } = await sb.from('issues').select('id', { count: 'exact', head: true })
      .neq('ai_digest', '').gt('published_at', _feedTopTs);
    const banner = document.getElementById('newIssueBanner');
    const cnt = document.getElementById('newIssueCount');
    if (banner && cnt && count > 0) { cnt.textContent = count; banner.style.display = 'block'; }
  } catch {}
}

function showNewIssues() {
  currentPage = 1;
  loadIssues();
  const top = document.getElementById('issuesContainer');
  // behavior:'smooth'는 이 프로젝트 브라우저 환경에서 스크롤 자체가 아예 안 되는 버그를
  // 실측으로 확인(2026-07-28, changePage와 동일 원인) — instant로 통일.
  if (top) top.scrollIntoView({ behavior: 'instant', block: 'start' });
}

// 장중 브라우저 구동 수집 트리거 — 서버가 장중게이트·레이트리밋 처리(사이트 열려 있는 동안만 수집)
async function triggerLiveCollect() {
  if (!anyMarketOpenNow().any) return;
  try { await fetch('/api/admin?action=live-refresh', { method: 'POST' }); } catch {}
}

function renderIssueCard(issue) {
  const analysis = issue.analyses?.[0];
  const companies = analysis?.analysis_companies?.slice(0, 3) || [];
  const upside = companies.map(c => c.upside_pct).filter(Boolean);
  const avgUpside = upside.length ? (upside.reduce((a, b) => a + b, 0) / upside.length).toFixed(1) : null;
  const confidence = analysis?.confidence_score || 0;

  // 7일 데이터 우선, 없으면 1일 — 방향+최소수익률 모두 충족한 경우만 "적중"
  const has7d = companies.some(c => c.is_accurate_7d !== null && c.is_accurate_7d !== undefined);
  const accKey   = has7d ? '7d' : '1d';
  const accMinAbs = has7d ? 1.5 : 0.3;
  const verified = companies.filter(c => c[`is_accurate_${accKey}`] !== null && c[`is_accurate_${accKey}`] !== undefined);
  const accurate = verified.filter(c =>
    c[`is_accurate_${accKey}`] === true &&
    Math.abs(c[`actual_return_${accKey}`] ?? 0) >= accMinAbs
  );
  const accRate = verified.length > 0 ? Math.round(accurate.length / verified.length * 100) : null;
  // 평균 실제 수익률
  const actuals = verified.map(c => c[`actual_return_${accKey}`]).filter(v => v != null);
  const avgActual = actuals.length ? (actuals.reduce((a,b)=>a+b,0)/actuals.length).toFixed(1) : null;
  const accBadge = accRate !== null
    ? `<span class="accuracy-badge ${accRate < 50 ? 'low' : ''}" title="${accKey === '7d' ? '7일' : '1일'} 적중률 (방향+수익 기준)">🎯 ${accKey === '7d' ? '7일' : '1일'} ${accRate}%${avgActual != null ? ` · 실제 ${avgActual >= 0 ? '+' : ''}${avgActual}%` : ''}</span>`
    : '';

  const sectors = (issue.sectors || []).slice(0, 4);
  const sectorTags = sectors.map(s => `<span class="sector-tag ${getSectorClass(s)}">${s}</span>`).join('');

  // news_analysis(키포인트 + 섹터 방향성) — 종목 미지정 산업 테마 방향 태깅(2026-07-27).
  const na = issue.news_analysis || {};
  const keypoints = (Array.isArray(na.keypoints) ? na.keypoints : []).slice(0, 3);
  const toneSectors = (Array.isArray(na.sectors) ? na.sectors : []).slice(0, 3);
  const _toneMeta = {
    pos: { label: '우호적', c: '#ff6b6b', bg: 'rgba(255,107,107,.14)' },
    neg: { label: '비우호적', c: '#4d8dff', bg: 'rgba(77,141,255,.14)' },
    neu: { label: '중립', c: 'var(--text3)', bg: 'rgba(255,255,255,.06)' },
  };
  const keypointsHtml = keypoints.length ? `<ul style="margin:9px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px">${
    keypoints.map(k => `<li style="font-size:14.5px;color:var(--text2);line-height:1.5;position:relative;padding-left:13px"><span style="position:absolute;left:0;color:var(--blue);font-weight:700">·</span>${escHtml(k)}</li>`).join('')
  }</ul>` : '';
  const toneChips = toneSectors.map(s => {
    const m = _toneMeta[s.tone] || _toneMeta.neu;
    return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:14px;font-weight:600;padding:3px 10px;border-radius:999px;color:${m.c};background:${m.bg}">${escHtml(s.name)}<span style="font-size:13px;opacity:.8">${m.label}</span></span>`;
  }).join('');

  const companyRows = companies.map(c => {
    const co = c.companies;
    if (!co) return '';
    const upPct = c.upside_pct;
    const cls = upPct >= 0 ? 'up' : 'dn';
    const sign = upPct >= 0 ? '+' : '';
    const isWL = isWatched(co.ticker);
    return `<div class="mini-company">
      <span class="mini-ticker">${co.ticker}</span>
      <span class="mini-name">${escHtml(co.name_ko || co.name_en || '')}</span>
      <button class="star-btn${isWL ? ' active' : ''}" data-wl-ticker="${escHtml(co.ticker)}" data-wl-name="${escHtml(co.name_ko||co.name_en||co.ticker)}" data-wl-market="${co.market||'US'}" onclick="toggleWatch(event,this)" title="관심종목 ${isWL?'제거':'추가'}">${isWL ? '★' : '☆'}</button>
    </div>`;
  }).join('');

  return `
    <a href="/analysis.html?id=${issue.id}" class="issue-card">
      <div class="card-header">
        <span class="card-source">
          <span class="source-dot"></span>${escHtml(issue.source_name || '뉴스')}
        </span>
        <span class="card-date">${timeAgoHtml(issue.published_at)}</span>
      </div>
      <div class="card-body">
        <div class="card-title">${escHtml(issue.title)}</div>
        ${analysis?.ai_summary ? `<div class="card-ai-summary">${escHtml(analysis.ai_summary)}</div>` : (issue.ai_digest ? `<div class="card-ai-summary">📝 ${escHtml(issue.ai_digest)}</div>` : '')}
        ${keypointsHtml}
        ${toneSectors.length
          ? `<div class="card-flow-label">📡 관련 산업 영향</div><div class="card-sectors">${toneChips}</div>`
          : (sectors.length ? `<div class="card-flow-label">📡 파급 섹터</div><div class="card-sectors">${sectorTags}</div>` : '')}
      </div>
      ${companies.length ? `<div class="card-companies"><div class="card-flow-label">🎯 관련 기업</div>${companyRows}</div>` : ''}
      <div class="card-footer">
        ${avgUpside != null ? `<div class="footer-stat"><span class="val green">+${avgUpside}%</span> 평균 예상</div>` : ''}
        ${accBadge}
        ${analysis ? `<div class="confidence-bar" title="분석 신뢰도 ${confidence}%">
          <div class="confidence-fill" style="width:${confidence}%"></div>
        </div>` : ''}
        <span class="view-btn">분석 보기 →</span>
        <button class="share-btn" data-share-title="${escAttr(issue.title)}" data-share-url="${escAttr(`${location.origin}/analysis/${issue.id}`)}" onclick="shareContent(event, this)" title="공유하기">🔗</button>
      </div>
    </a>`;
}

// ── 🌡️ 지금 산업 온도 (StockRipple 시그니처) ─────────────────────
// 최근 뉴스의 news_analysis.sectors 톤(우호적/비우호적/중립)을 산업별로 집계해, 지금 뉴스
// 흐름이 어떤 산업에 우호적/비우호적인지 한눈에 보여준다. 종목을 지목하지 않는 산업 테마
// 심리 집계라 유사투자자문 리스크 없음(analyses/analysis_companies 미사용). 다른 사이트엔 없는 기능.
let _sectorTempLoaded = false;
async function loadSectorTemp() {
  const board = document.getElementById('sectorTempBoard');
  if (!board || typeof sb === 'undefined') return;
  let rows = [];
  try {
    const { data } = await sb.from('issues').select('news_analysis, published_at')
      .neq('ai_digest', '').order('published_at', { ascending: false }).limit(120);
    rows = data || [];
  } catch { return; }
  const agg = {}; let newsCount = 0;
  for (const r of rows) {
    const secs = r.news_analysis && r.news_analysis.sectors;
    if (!Array.isArray(secs) || !secs.length) continue;
    newsCount++;
    for (const s of secs) {
      if (!s || !s.name) continue;
      const a = (agg[s.name] ||= { pos: 0, neg: 0, neu: 0 });
      if (s.tone === 'pos') a.pos++; else if (s.tone === 'neg') a.neg++; else a.neu++;
    }
  }
  const list = Object.entries(agg)
    .map(([name, a]) => ({ name, ...a, total: a.pos + a.neg + a.neu, net: a.pos - a.neg }))
    .filter(x => x.total >= 1).sort((a, b) => b.total - a.total || Math.abs(b.net) - Math.abs(a.net)).slice(0, 8);
  if (!list.length) { board.innerHTML = ''; return; }
  const rowHtml = x => {
    const t = x.total || 1;
    const pw = (x.pos / t * 100), nw = (x.neu / t * 100), gw = (x.neg / t * 100);
    const netCol = x.net > 0 ? 'var(--red)' : x.net < 0 ? 'var(--blue)' : 'var(--text3)';
    const netLbl = x.net > 0 ? `우호적 +${x.net}` : x.net < 0 ? `비우호적 ${x.net}` : '중립';
    return `<div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid var(--border)">
      <div style="width:92px;font-size:15.5px;font-weight:600;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(x.name)}</div>
      <div style="flex:1;display:flex;height:15px;border-radius:5px;overflow:hidden;background:var(--bg3);min-width:0" title="우호적 ${x.pos} · 중립 ${x.neu} · 비우호적 ${x.neg}">
        <div style="width:${pw}%;background:var(--red)"></div><div style="width:${nw}%;background:var(--bg4)"></div><div style="width:${gw}%;background:var(--blue)"></div>
      </div>
      <div style="width:76px;text-align:right;font-size:14px;font-weight:700;flex-shrink:0;color:${netCol}">${netLbl}</div>
    </div>`;
  };
  board.innerHTML = `
    <div style="background:linear-gradient(180deg,var(--bg3,#262a34),var(--bg2,#1e2129));border:1px solid var(--border);border-radius:16px;padding:18px 20px;margin-bottom:22px;position:relative;overflow:hidden">
      <div style="display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:4px">
        <span style="font-size:18px;font-weight:800;letter-spacing:-.01em">🌡️ 지금 산업 온도</span>
        <span style="font-size:14px;color:var(--text3)">최근 뉴스 ${newsCount}건이 어떤 산업에 우호적/비우호적인지</span>
      </div>
      <div style="font-size:14px;color:var(--text3);margin-bottom:13px">
        <span style="color:var(--red);font-weight:700">■</span> 우호적 뉴스 &nbsp; <span style="color:var(--text3);font-weight:700">■</span> 중립 &nbsp; <span style="color:var(--blue);font-weight:700">■</span> 비우호적 뉴스
      </div>
      ${list.map(rowHtml).join('')}
      <div style="font-size:13px;color:var(--text3);margin-top:12px;line-height:1.5">뉴스의 산업 영향 방향을 집계한 것으로, 특정 종목의 매수·매도 의견이 아닙니다.</div>
    </div>`;
}

function renderPagination() {
  const pg = document.getElementById('pagination');
  if (totalCount <= PAGE_SIZE) { pg.innerHTML = ''; return; }
  const total = Math.ceil(totalCount / PAGE_SIZE);
  let html = '';
  html += `<button class="page-btn" onclick="changePage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>← 이전</button>`;
  for (let i = Math.max(1, currentPage - 2); i <= Math.min(total, currentPage + 2); i++) {
    html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="changePage(${i})">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="changePage(${currentPage + 1})" ${currentPage === total ? 'disabled' : ''}>다음 →</button>`;
  pg.innerHTML = html;
}

function changePage(p) {
  currentPage = p;
  loadIssues();
  // 이슈 섹션 상단으로만 스크롤 — 예전엔 이 바로 다음에 window.scrollTo({top:0})를
  // 또 불러서 페이지 최상단(히어로/시장지표 위)까지 튕겨버렸다(2026-07-28 피드백:
  // "다음 페이지로 가면 제일 상단으로 가버린다"). 이슈 섹션이 화면에 이미 보이는
  // 위치면 그마저도 건드리지 않는다(멀쩡히 보던 위치에서 안 움직이는 게 최선).
  const issuesTop = document.getElementById('issuesContainer');
  if (issuesTop) {
    const r = issuesTop.getBoundingClientRect();
    if (r.top < 0 || r.top > 200) issuesTop.scrollIntoView({ behavior: 'instant', block: 'start' });
  }
}


// 뉴스/종목 공유 — 모바일은 OS 공유 시트, 데스크톱은 클립보드 복사 폴백.
// 카드 전체가 <a>라 이벤트 버블링을 막아 링크 이동을 막는다.
async function shareContent(e, btn) {
  e.preventDefault(); e.stopPropagation();
  const title = btn.dataset.shareTitle || document.title;
  const url = btn.dataset.shareUrl || location.href;
  if (navigator.share) {
    try { await navigator.share({ title, url }); } catch (err) { /* 사용자 취소 등 — 무시 */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('🔗 링크가 복사되었습니다', 'success');
  } catch {
    showToast('공유하기를 지원하지 않는 브라우저입니다', 'error');
  }
}

/* ── Auth & Watchlist ── */
// currentUser는 site-header.js가 선언 — 여기선 재선언하지 않고 그대로 쓴다(재할당은 아래 initAuth에서).
let watchlistCache = new Set();

async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  currentUser = session?.user ?? null;
  if (currentUser) await loadWatchlistCache();
  renderUserMenu(currentUser);
  sb.auth.onAuthStateChange(async (event, session) => {
    currentUser = session?.user ?? null;
    if (currentUser) {
      await loadWatchlistCache();
    } else {
      watchlistCache.clear();
    }
    renderUserMenu(currentUser);
    if (event === 'SIGNED_IN') closeAuthModal();
  });
}

function renderUserMenu(user) {
  const loginBtn = document.getElementById('loginBtn');
  const userMenu = document.getElementById('userMenu');
  if (!user) {
    loginBtn.style.display = '';
    userMenu.style.display = 'none';
  } else {
    loginBtn.style.display = 'none';
    userMenu.style.display = '';
    document.getElementById('userAvatar').textContent = (user.email || '?')[0].toUpperCase();
  }
  updateWlCount();
}

async function loadWatchlistCache() {
  if (!currentUser) return;
  const { data } = await sb.from('user_watchlist').select('ticker');
  watchlistCache = new Set((data || []).map(r => r.ticker));
  updateWlCount();
}

function isWatched(ticker) { return watchlistCache.has(ticker); }

async function toggleWatch(e, btn) {
  e.preventDefault(); e.stopPropagation();
  if (!currentUser) { openAuthModal(); return; }
  const { wlTicker: ticker, wlName: name, wlMarket: market } = btn.dataset;
  if (watchlistCache.has(ticker)) {
    await sb.from('user_watchlist').delete().eq('ticker', ticker);
    watchlistCache.delete(ticker);
    showToast(`${name} 관심종목 제거`, 'info');
  } else {
    await sb.from('user_watchlist').insert({ user_id: currentUser.id, ticker, name, market });
    watchlistCache.add(ticker);
    showToast(`${name} ★ 관심종목 추가`, 'success');
  }
  updateWlCount();
  document.querySelectorAll(`[data-wl-ticker="${ticker}"]`).forEach(b => {
    const w = watchlistCache.has(ticker);
    b.classList.toggle('active', w);
    b.textContent = w ? '★' : '☆';
    b.title = w ? '관심종목 제거' : '관심종목 추가';
  });
}

function updateWlCount() {
  const el = document.getElementById('wlCount');
  if (el) el.textContent = watchlistCache.size > 0 ? ` (${watchlistCache.size})` : '';
}

async function renderWatchlistView() {
  const container = document.getElementById('watchlistView');
  if (!currentUser) {
    container.innerHTML = `<div class="watchlist-empty"><div style="font-size:48px;margin-bottom:16px">🔐</div><p style="font-size:20px;font-weight:600;margin-bottom:8px">로그인이 필요합니다</p><p style="font-size:16px;color:var(--text2);margin-bottom:24px">관심종목을 저장하려면 로그인하세요.</p><button class="empty-btn" onclick="openAuthModal()">로그인 / 회원가입</button></div>`;
    return;
  }
  const { data: list } = await sb.from('user_watchlist').select('ticker,name,market').order('added_at', { ascending: false });
  if (!list?.length) {
    container.innerHTML = `<div class="watchlist-empty"><div style="font-size:48px;margin-bottom:16px">⭐</div><p style="font-size:20px;font-weight:600;margin-bottom:8px">관심종목이 없습니다</p><p style="font-size:16px;color:var(--text2)">피드에서 기업 옆의 ☆ 버튼을 눌러 추가하세요.</p></div>`;
    return;
  }
  container.innerHTML = `<div class="watchlist-grid">${list.map(w => `
    <div class="watchlist-card">
      <div class="wl-top">
        <span class="wl-ticker ${w.market === 'KR' ? 'kr' : 'us'}">${escHtml(w.ticker)}</span>
        <span class="wl-name">${escHtml(w.name)}</span>
        <button class="wl-remove" onclick="removeWL('${escHtml(w.ticker)}')" title="제거">✕</button>
      </div>
      <div class="wl-price-row">
        <span class="wl-price" id="wlp_${w.ticker}">—</span>
        <span class="wl-chg" id="wlc_${w.ticker}"></span>
      </div>
      <a href="/company.html?ticker=${encodeURIComponent(w.ticker)}" class="wl-link">종목 상세 보기 →</a>
    </div>`).join('')}</div>`;
  list.forEach(w => loadWLPrice(w.ticker));
}

async function loadWLPrice(ticker) {
  try {
    const res = await fetch(`/api/stock-price?ticker=${encodeURIComponent(ticker)}`);
    const data = await res.json();
    if (!data.price) return;
    const cur = data.currency || 'USD';
    const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: cur === 'KRW' ? 0 : 2 });
    const priceEl = document.getElementById(`wlp_${ticker}`);
    if (priceEl) priceEl.textContent = fmt.format(data.price);
    if (data.changePercent != null) {
      const chgEl = document.getElementById(`wlc_${ticker}`);
      if (chgEl) {
        const up = data.changePercent >= 0;
        chgEl.textContent = `${up ? '+' : ''}${data.changePercent.toFixed(2)}%`;
        chgEl.className = 'wl-chg ' + (up ? 'up' : 'dn');
      }
    }
  } catch {}
}

async function removeWL(ticker) {
  await sb.from('user_watchlist').delete().eq('ticker', ticker);
  watchlistCache.delete(ticker);
  updateWlCount();
  renderWatchlistView();
}

function switchTab(tab) {
  const isFeed = tab === 'feed';
  const wlBtn = document.getElementById('tabWatchlist');
  wlBtn.classList.toggle('active', !isFeed);
  wlBtn.innerHTML = (isFeed ? '관심종목' : '← 피드로') + '<span id="wlCount"></span>';
  document.getElementById('issuesSection').style.display = isFeed ? '' : 'none';
  document.getElementById('sidebar').style.display = isFeed ? '' : 'none';
  const wv = document.getElementById('watchlistView');
  wv.style.display = isFeed ? 'none' : 'block';
  if (!isFeed) renderWatchlistView();
  updateWlCount();
}
function toggleWatchlistTab() {
  const isActive = document.getElementById('tabWatchlist').classList.contains('active');
  switchTab(isActive ? 'feed' : 'watchlist');
}

/* ── 피드백 챗봇 ── */
let _fbState = {};
function openFeedbackChat() {
  document.getElementById('fbOverlay').style.display = 'flex';
  document.getElementById('fbMessages').innerHTML = '';
  _fbState = {};
  fbBotSay('안녕하세요! StockRipple에 대한 의견을 들려주세요 😊\n어떤 종류의 의견인가요?');
  fbShowQuickReplies([
    { label: '🐛 버그 신고', value: 'bug' },
    { label: '💡 기능 제안', value: 'feature' },
    { label: '🎨 디자인/UX', value: 'design' },
    { label: '💬 기타', value: 'other' },
  ], (val, label) => {
    _fbState.category = val;
    fbUserSay(label);
    fbAskMessage();
  });
}
function closeFeedbackChat() {
  document.getElementById('fbOverlay').style.display = 'none';
}
function fbBotSay(text) {
  const el = document.getElementById('fbMessages');
  el.insertAdjacentHTML('beforeend', `<div class="fb-msg bot">${escHtml(text)}</div>`);
  el.scrollTop = el.scrollHeight;
}
function fbUserSay(text) {
  const el = document.getElementById('fbMessages');
  el.insertAdjacentHTML('beforeend', `<div class="fb-msg user">${escHtml(text)}</div>`);
  el.scrollTop = el.scrollHeight;
}
function fbShowQuickReplies(options, onPick) {
  const area = document.getElementById('fbInputArea');
  area.innerHTML = `<div class="fb-quick-replies">${options.map((o, i) => `<button class="fb-qr-btn" data-i="${i}">${escHtml(o.label)}</button>`).join('')}</div>`;
  area.querySelectorAll('.fb-qr-btn').forEach((btn, i) => {
    btn.onclick = () => {
      area.querySelectorAll('.fb-qr-btn').forEach(b => b.disabled = true);
      onPick(options[i].value, options[i].label);
    };
  });
}
function fbAskMessage() {
  fbBotSay('자세히 알려주시면 큰 도움이 됩니다 :)');
  const area = document.getElementById('fbInputArea');
  area.innerHTML = `
    <div class="fb-input-row">
      <textarea id="fbMsgInput" rows="2" placeholder="의견을 입력해주세요..." maxlength="3000"></textarea>
      <button class="fb-send-btn" id="fbMsgSend">전송</button>
    </div>`;
  const ta = document.getElementById('fbMsgInput');
  const send = () => {
    const val = ta.value.trim();
    if (!val) return;
    _fbState.message = val;
    fbUserSay(val);
    fbAskContact();
  };
  document.getElementById('fbMsgSend').onclick = send;
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  ta.focus();
}
function fbAskContact() {
  fbBotSay('혹시 답변 받으실 이메일을 남겨주시겠어요? (선택사항)');
  const area = document.getElementById('fbInputArea');
  area.innerHTML = `
    <div class="fb-input-row">
      <input type="email" id="fbContactInput" placeholder="example@email.com (선택)">
      <button class="fb-send-btn" id="fbContactSend">제출</button>
    </div>
    <button class="fb-skip-btn" id="fbContactSkip">건너뛰기</button>`;
  const input = document.getElementById('fbContactInput');
  const submit = (skip) => {
    const val = skip ? '' : input.value.trim();
    _fbState.contact = val || null;
    fbUserSay(val || '(건너뜀)');
    fbSubmitFeedback();
  };
  document.getElementById('fbContactSend').onclick = () => submit(false);
  document.getElementById('fbContactSkip').onclick = () => submit(true);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(false); });
  input.focus();
}
async function fbSubmitFeedback() {
  const area = document.getElementById('fbInputArea');
  area.innerHTML = '';
  fbBotSay('전송 중...');
  const msgs = document.getElementById('fbMessages');
  try {
    const r = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: _fbState.category,
        message: _fbState.message,
        contact: _fbState.contact,
        page: location.pathname,
      }),
    });
    const j = await r.json();
    msgs.lastElementChild?.remove();
    if (j.ok) {
      fbBotSay('소중한 의견 감사합니다! 더 나은 StockRipple을 만드는 데 반영하겠습니다 🙏');
      area.innerHTML = `<button class="fb-send-btn" style="width:100%" onclick="closeFeedbackChat()">닫기</button>`;
    } else {
      fbBotSay('전송에 실패했어요 :( 잠시 후 다시 시도해주세요.');
      area.innerHTML = `<button class="fb-send-btn" style="width:100%" onclick="fbSubmitFeedback()">다시 시도</button>`;
    }
  } catch (e) {
    msgs.lastElementChild?.remove();
    fbBotSay('전송에 실패했어요 :( 네트워크를 확인해주세요.');
    area.innerHTML = `<button class="fb-send-btn" style="width:100%" onclick="fbSubmitFeedback()">다시 시도</button>`;
  }
}

/* ── Auth Modal ──
   openAuthModal/closeAuthModal/switchAuthMode/togglePrivacyText/validateSignupPassword/
   submitAuth/signInWithGoogle/toggleUserDropdown은 site-header.js가 공용으로 제공(2026-07-22) —
   여기 재정의하지 않는다. doSignOut만 watchlistCache 정리가 필요해 그대로 유지(재정의로 덮어씀). */
async function doSignOut() {
  await sb.auth.signOut();
  watchlistCache.clear();
  renderUserMenu(null);
  showToast('로그아웃 했습니다', 'info');
}

document.querySelectorAll('[data-sector]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-sector]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSector = btn.dataset.sector;
    currentPage = 1;
    loadIssues();
  });
});

// 검색창에 입력 후 Enter → 직접 조회
// 1) 명확한 풀 티커는 바로 이동
// 2) 모든 입력 (영문/한글/약칭) → companies 테이블에서 ticker/name 매칭
// 3) DB에 없는 영문 패턴이면 US로 fallback
async function tryDirectLookup(input) {
  const raw = (input || '').trim();
  if (!raw) return;
  const upper = raw.toUpperCase();
  const isKrTicker = /^\d{6}\.K[SQ]$/i.test(upper);
  const isKrCode6  = /^\d{6}$/.test(upper);
  const isUsTickerPattern = /^[A-Z][A-Z0-9.\-]{0,9}$/.test(upper) && !/^\d/.test(upper);

  // 명확한 KR 풀 티커
  if (isKrTicker) {
    location.href = `/company.html?ticker=${encodeURIComponent(upper)}`;
    return;
  }
  if (isKrCode6) {
    location.href = `/company.html?ticker=${encodeURIComponent(upper + '.KS')}`;
    return;
  }

  // companies 테이블에서 ticker prefix / name 매칭 (영문/한글 모두)
  showToast(`"${raw}" 검색 중...`, 'info');
  try {
    const safe = raw.replace(/[%_'"\\]/g, '');
    // ticker도 함께 검색 (예: "HLB" → 028300.KQ가 ticker prefix로 매칭될 수도)
    // 더 정확히는: name_ko='HLB' 또는 name_en='HLB' 같은 약칭
    const { data: rawMatches } = await sb
      .from('companies')
      .select('ticker, name_ko, name_en, market')
      .or(`name_ko.ilike.%${safe}%,name_en.ilike.%${safe}%,ticker.ilike.${upper}%`)
      .limit(30);

    // 정확매칭 → 접두사 매칭 → 부분 매칭 순으로 정렬
    const rawLower = raw.toLowerCase();
    const safeLower = safe.toLowerCase();
    const rankOf = (m) => {
      const ko = (m.name_ko || '').toLowerCase();
      const en = (m.name_en || '').toLowerCase();
      if (ko === rawLower || en === rawLower) return 0;        // 정확 일치
      if (ko.startsWith(safeLower) || en.startsWith(safeLower)) return 1;  // 접두사
      return 2;                                                // 부분 매칭
    };
    const matches = (rawMatches || []).slice().sort((a, b) => {
      const ra = rankOf(a), rb = rankOf(b);
      if (ra !== rb) return ra - rb;
      // 동점이면 한국 정식 상장(.KS/.KQ) 우선 — 같은 회사의 미국 OTC(SSNLF류)로 빠지는 것 방지
      const ka = /\.K[SQ]$/i.test(a.ticker || '') ? 0 : 1;
      const kb = /\.K[SQ]$/i.test(b.ticker || '') ? 0 : 1;
      if (ka !== kb) return ka - kb;
      return (a.name_ko || a.name_en || '').localeCompare(b.name_ko || b.name_en || '');
    });

    if (matches.length === 1) {
      location.href = `/company.html?ticker=${encodeURIComponent(matches[0].ticker)}`;
      return;
    }
    if (matches.length > 1) {
      // 단일 정확 매칭이면 바로 이동
      const exacts = matches.filter(m => rankOf(m) === 0);
      if (exacts.length === 1) {
        location.href = `/company.html?ticker=${encodeURIComponent(exacts[0].ticker)}`;
        return;
      }
      // 여러 개면 카드 모달 (이미 정렬된 상태)
      openSearchPicker(raw, matches);
      return;
    }

    // 매칭 없음 — 영문 ticker 패턴이면 US로 직접 시도 (Yahoo auto-register)
    if (isUsTickerPattern) {
      location.href = `/company.html?ticker=${encodeURIComponent(upper)}`;
      return;
    }

    // companies 테이블은 방문/분석으로 자동등록된 종목만 있는 부분집합이라, 아직
    // 한 번도 등록 안 된 한국 종목(예: SK네트웍스)은 여기서 못 찾는다 — 네이버
    // 자동완성(한글 종목명 인덱싱 정확)으로 한 번 더 시도한 뒤에야 포기한다.
    try {
      const krRes = await fetch(`/api/stock?type=search-kr&q=${encodeURIComponent(raw)}`);
      const krData = await krRes.json();
      const krItems = krData.items || [];
      if (krItems.length === 1) {
        location.href = `/company.html?ticker=${encodeURIComponent(krItems[0].ticker)}`;
        return;
      }
      if (krItems.length > 1) {
        openSearchPicker(raw, krItems.map(it => ({ ticker: it.ticker, name_ko: it.name, market: 'KR' })));
        return;
      }
    } catch {}

    // 그 외 → 이슈 제목에서 검색
    showToast(`"${raw}" 종목 매칭 없음 — 이슈 제목에서 검색`, 'info');
    document.getElementById('searchInput').value = raw;
    searchQuery = raw;
    currentPage = 1;
    loadIssues();
  } catch (e) {
    showToast('검색 실패: ' + e.message, 'error');
  }
}

let searchTimeout;
document.getElementById('searchInput')?.addEventListener('input', e => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    searchQuery = e.target.value.trim();
    currentPage = 1;
    loadIssues();
  }, 400);
});

/* ── Category Tabs ── */
let currentCategory = 'all';

document.querySelectorAll('.cat-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cat-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentCategory = btn.dataset.cat;
    currentPage = 1;
    loadIssues();
  });
});

/* ── Indices ── */
const INDICES = [
  { id: 'sp500',  ticker: '%5EGSPC',  name: 'S&P 500',    fmt: 'n', tvSym: 'SPX' },
  { id: 'nasdaq', ticker: '%5EIXIC',  name: 'NASDAQ',     fmt: 'n', tvSym: 'NASDAQ:COMP' },
  { id: 'dow',    ticker: '%5EDJI',   name: 'DOW',        fmt: 'n', tvSym: 'DJI' },
  { id: 'kospi',  ticker: '%5EKS11',  name: 'KOSPI',      fmt: 'n', tvSym: 'KRX:KOSPI' },
  { id: 'kosdaq', ticker: '%5EKQ11',  name: 'KOSDAQ',     fmt: 'n', tvSym: 'KRX:KOSDAQ' },
  { id: 'btc',    ticker: 'BTC-USD',  name: '비트코인',    fmt: '$', tvSym: 'BITSTAMP:BTCUSD' },
  { id: 'gold',   ticker: 'GC%3DF',   name: '금 (GC)',    fmt: '$', tvSym: 'TVC:GOLD' },
  { id: 'oil',    ticker: 'CL%3DF',   name: 'WTI 원유',   fmt: '$', tvSym: 'TVC:USOIL' },
  { id: 'usdkrw', ticker: 'KRW%3DX',  name: 'USD/KRW',   fmt: 'n', tvSym: 'FX_IDC:USDKRW' },
  { id: 'vix',    ticker: '%5EVIX',   name: 'VIX',        fmt: 'n', tvSym: 'TVC:VIX' },
  { id: 'us10y',  ticker: '%5ETNX',   name: 'US 10Y',     fmt: 'n', tvSym: 'TVC:US10Y' },
  { id: 'dxy',    ticker: 'DX-Y.NYB', name: 'DXY',        fmt: 'n', tvSym: 'TVC:DXY' },
  { id: 'eth',    ticker: 'ETH-USD',  name: 'ETH',        fmt: '$', tvSym: 'BITSTAMP:ETHUSD' },
  { id: 'nikkei', ticker: '%5EN225',  name: 'NIKKEI',     fmt: 'n', tvSym: 'TVC:NI225' },
  { id: 'hsi',    ticker: '%5EHSI',   name: 'HSI',        fmt: 'n', tvSym: 'TVC:HSI' },
];
const _idxMap = Object.fromEntries(INDICES.map(i => [i.id, i]));

function fmtIdx(val, fmt) {
  if (!val) return '—';
  if (fmt === '$') return '$' + Number(val).toLocaleString('en-US', {maximumFractionDigits: 2});
  return Number(val).toLocaleString('ko-KR', {maximumFractionDigits: 2});
}

// ── 숫자 카운트업/다운 애니메이션 ──────────────────────────────
// 지표/시세를 폴링마다 textContent로 그냥 스냅 교체하면 "깜빡"이는 느낌만 준다.
// 이전 값 → 새 값을 부드럽게 보간(투표율 카운터 느낌)하고, 끝나는 시점에
// flashCls([상승클래스, 하락클래스])를 넘기면 해당 클래스를 재트리거해 마무리 효과를 준다.
function animateNumberText(el, toVal, formatFn, flashCls) {
  if (!el || toVal == null || !isFinite(toVal)) return;
  const fromVal = el.dataset.animVal != null ? parseFloat(el.dataset.animVal) : NaN;
  el.dataset.animVal = toVal;
  if (!isFinite(fromVal)) { el.textContent = formatFn(toVal); return; }
  if (fromVal === toVal) return; // 값 변화 없으면 재렌더 생략 — 매초 폴링에도 깜빡이지 않게

  if (el._animRAF) cancelAnimationFrame(el._animRAF);
  const startTs = performance.now();
  const duration = 500;
  const ease = t => 1 - Math.pow(1 - t, 3);
  const step = now => {
    const t = Math.min(1, (now - startTs) / duration);
    el.textContent = formatFn(fromVal + (toVal - fromVal) * ease(t));
    if (t < 1) { el._animRAF = requestAnimationFrame(step); return; }
    el._animRAF = null;
    if (flashCls) {
      const [upCls, dnCls] = flashCls;
      el.classList.remove(upCls, dnCls);
      void el.offsetWidth; // 리플로우 강제 — 애니메이션 재트리거
      el.classList.add(toVal > fromVal ? upCls : dnCls);
      setTimeout(() => el.classList.remove(upCls, dnCls), 900);
    }
  };
  el._animRAF = requestAnimationFrame(step);
}

// 최근 세션(24h) 미니 차트 — 44×14 SVG path 생성
function sparkPath(points) {
  if (!Array.isArray(points) || points.length < 2) return '';
  const w = 44, h = 14;
  const min = Math.min(...points), max = Math.max(...points);
  const span = (max - min) || 1;
  const step = w / (points.length - 1);
  return points.map((p, i) =>
    `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - 1.5 - ((p - min) / span) * (h - 3)).toFixed(1)}`
  ).join('');
}

// 채워진 영역(area) 스파크라인 SVG — 시장 지표 대시보드 전용(홈 히어로/카드).
// baseline(전일 종가 등 기준가)이 주어지면 그 위치에 옅은 점선을 그려 등락폭을 감으로 알 수 있게 한다.
// live=true면 마지막 지점에 레이더 핑(ping) 애니메이션을 붙여 "그 장이 지금 열려 있어
// 이 선이 계속 이어지는 중"이라는 걸 보여준다 — 장이 닫혀 있으면(오늘 종가까지 확정) 안 붙는다.
//
// session={start,end}(ms epoch)이 주어지면 "세션 앵커" 모드 — x축을 포인트 인덱스가 아니라
// 실제 [세션 시작, 세션 종료] 구간에서의 시각 비율로 배치한다(times 필요). 장이 방금 열려
// 데이터가 30분치뿐이면 선도 폭의 일부만 차지하고 나머지는 비워둔다 — 예전엔 있는 포인트를
// 무조건 폭 전체에 늘려 그려서, 장이 막 열렸을 뿐인데도 하루치가 다 지난 것처럼 보였다
// (2026-07-28, 레퍼런스 앱과 비교해 사용자가 지적). session이 없으면(세션 개념이 뚜렷하지
// 않은 지표 — 원자재/암호화폐/환율 등) 기존처럼 인덱스 균등분배로 폭 전체를 채운다.
function areaSparkSvg(points, w, h, color, baseline, live, times, session) {
  if (!Array.isArray(points) || points.length < 2) return '';
  const min = Math.min(...points), max = Math.max(...points);
  const span = (max - min) || 1;
  const yOf = p => (h - 1) - ((p - min) / span) * (h - 2);

  let coords;
  if (session && Array.isArray(times) && times.length === points.length) {
    const sessSpan = (session.end - session.start) || 1;
    coords = points.map((p, i) => [
      Math.min(w, Math.max(0, ((times[i] - session.start) / sessSpan) * w)),
      yOf(p),
    ]);
  } else {
    const step = w / (points.length - 1);
    coords = points.map((p, i) => [i * step, yOf(p)]);
  }
  const lastX = coords[coords.length - 1][0];
  const linePath = coords.map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join('');
  const gid = 'msg' + Math.random().toString(36).slice(2, 9);
  let baseLine = '';
  if (typeof baseline === 'number' && isFinite(baseline)) {
    const by = Math.min(h - 0.5, Math.max(0.5, yOf(baseline)));
    baseLine = `<line x1="0" y1="${by.toFixed(1)}" x2="${w}" y2="${by.toFixed(1)}" stroke-width="1" style="stroke:var(--text3);stroke-dasharray:3,3;opacity:.5"/>`;
  }
  let liveDot = '';
  if (live) {
    const [lx, ly] = coords[coords.length - 1];
    const r = Math.max(1.6, h * 0.045);
    liveDot = `
    <circle class="mkt-spark-ping" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}"/>
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="${(r * 0.6).toFixed(1)}" fill="${color}" stroke="var(--bg2)" stroke-width="${(r * 0.25).toFixed(2)}"/>`;
  }
  // 영역 채우기는 실제로 그려진 선(0~lastX)까지만 — 세션 앵커 모드에서 남은(미래) 구간은
  // 완전히 빈 채로 남겨 "아직 안 지난 시간"임을 보여준다.
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.32"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${linePath} L${lastX.toFixed(1)},${h} L0,${h} Z" fill="url(#${gid})" stroke="none"/>
    ${baseLine}
    <path d="${linePath}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
    ${liveDot}
  </svg>`;
}

// ─── 시장지표 차트 호버/드래그 툴팁 (2026-07-28) ───────────────────────
// areaSparkSvg가 만드는 차트는 값만 있고 시각 라벨이 없어 손으로 짚어봐도 "언제"인지
// 알 수 없었다 — /api/indices가 spark와 같은 인덱스의 sparkT(ms epoch)를 같이 내려주므로
// 그걸 이용해 포인터 위치에 가장 가까운 지점의 시각+값을 보여준다. 차트 컨테이너는 가격
// 폴링마다 재렌더되는데, 처음엔 컨테이너 자체(chartEl.innerHTML=svg)를 통째로 갈아끼웠더니
// 거기 붙여둔 가이드선/점/툴팁 오버레이 DOM이 두 번째 폴링에서 그대로 날아가는 버그가
// 있었다 — SVG는 전용 자식 슬롯(.mkt-spark-svg-slot)에만 넣고, 오버레이는 그 슬롯의
// 형제로 컨테이너에 최초 1회만 붙여 재렌더에서 살아남게 한다.
function renderMktSpark(containerEl, points, w, h, color, baseline, live, times, session) {
  if (!containerEl) return;
  let slot = containerEl.querySelector(':scope > .mkt-spark-svg-slot');
  if (!slot) {
    slot = document.createElement('span');
    slot.className = 'mkt-spark-svg-slot';
    containerEl.prepend(slot);
  }
  slot.innerHTML = areaSparkSvg(points, w, h, color, baseline, live, times, session);
  setMktChartData(containerEl, points, times, session);
}

function setMktChartData(containerEl, points, times, session) {
  if (!containerEl) return;
  containerEl._mktChart = { points, times, session };
  if (!containerEl.dataset.chartBound) {
    containerEl.dataset.chartBound = '1';
    bindMktChartHover(containerEl);
  }
}

function bindMktChartHover(containerEl) {
  containerEl.classList.add('mkt-chart-interactive');
  const tip = document.createElement('div');
  tip.className = 'mkt-chart-tip';
  const guide = document.createElement('div');
  guide.className = 'mkt-chart-guide';
  const dot = document.createElement('div');
  dot.className = 'mkt-chart-hover-dot';
  containerEl.append(guide, dot, tip);

  let dragging = false;

  const update = (clientX) => {
    const c = containerEl._mktChart;
    if (!c?.points || c.points.length < 2) return false;
    const rect = containerEl.getBoundingClientRect();
    if (!rect.width) return false;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));

    // 세션 앵커 모드는 포인트가 폭에 균등분배되지 않으므로(장중이면 초반 구간에만 몰려
    // 있음) 손가락 위치를 "그 위치가 해당하는 실제 시각"으로 변환한 뒤 가장 가까운
    // 포인트를 찾는다. 세션 정보가 없는 지표(원자재 등)는 기존처럼 인덱스 균등분배.
    let idx, xPct;
    if (c.session && c.times) {
      const targetT = c.session.start + frac * (c.session.end - c.session.start);
      idx = 0;
      let bestDiff = Infinity;
      for (let i = 0; i < c.times.length; i++) {
        const diff = Math.abs(c.times[i] - targetT);
        if (diff < bestDiff) { bestDiff = diff; idx = i; }
      }
      xPct = Math.min(100, Math.max(0, ((c.times[idx] - c.session.start) / (c.session.end - c.session.start)) * 100));
    } else {
      idx = Math.round(frac * (c.points.length - 1));
      xPct = (idx / (c.points.length - 1)) * 100;
    }

    const val = c.points[idx];
    const min = Math.min(...c.points), max = Math.max(...c.points);
    const span = (max - min) || 1;
    const yPct = (1 - (val - min) / span) * 100;

    guide.style.left = xPct + '%';
    dot.style.left = xPct + '%';
    dot.style.top = yPct + '%';

    const t = c.times?.[idx];
    const timeLabel = t ? new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    tip.innerHTML = `${timeLabel ? `<span class="mkt-chart-tip-time">${timeLabel}</span>` : ''}<span class="mkt-chart-tip-val">${fmtIdx(val, 'n')}</span>`;
    // 툴팁이 카드 좌우 밖으로 나가지 않게: 왼쪽 끝 근처면 왼쪽 정렬, 오른쪽 끝 근처면 오른쪽 정렬
    tip.style.left = xPct + '%';
    tip.classList.toggle('align-l', xPct < 15);
    tip.classList.toggle('align-r', xPct > 85);

    containerEl.classList.add('showing-tip');
    return true;
  };
  const hide = () => { containerEl.classList.remove('showing-tip'); dragging = false; };

  containerEl.addEventListener('mousemove', e => update(e.clientX));
  containerEl.addEventListener('mouseleave', hide);
  containerEl.addEventListener('touchstart', e => {
    if (update(e.touches[0].clientX)) dragging = true;
  }, { passive: true });
  containerEl.addEventListener('touchmove', e => {
    if (!dragging) return;
    containerEl.dataset.wasDragging = '1'; // 터치엔드에서 클릭(=페이지 이동)을 막기 위한 플래그
    update(e.touches[0].clientX);
    e.preventDefault(); // 드래그로 짚어보는 동안 페이지 스크롤 방지
  }, { passive: false });
  containerEl.addEventListener('touchend', hide);
  containerEl.addEventListener('touchcancel', hide);
  // 차트는 클릭 가능한 카드(<a>) 안에 있다 — 드래그해서 값을 짚어본 것뿐인데
  // 손을 떼며 상세페이지로 이동해버리지 않도록, 드래그 중이었으면 클릭을 죽인다.
  containerEl.addEventListener('click', e => {
    if (containerEl.dataset.wasDragging === '1') {
      containerEl.dataset.wasDragging = '';
      e.preventDefault();
      e.stopPropagation();
    }
  });
}

// 🎯 지금 매수 후보 위 "시장 지표" 대시보드 — 홈 전용(mktDashGrid 없는 페이지는 no-op)
// ⚠️ kospi/kosdaq/nasdaq/dow 4개는 히어로/서브 히어로 슬롯(heroMarketMeta/subMarketMeta)과
// 겹친다 — 예전엔 이 목록에 kosdaq/dow만 고정으로 박혀 있어서, 미국 장중(히어로=나스닥+다우)엔
// 다우가 히어로에도 작은 그리드에도 중복으로 뜨고 코스피는 아예 어디에도 안 나왔다(국내
// 장중엔 반대로 나스닥이 통째로 사라짐). 4개 다 목록엔 넣어두고 rotating:true로 표시,
// renderMarketDash가 매 렌더마다 현재 히어로/서브 히어로 키에 해당하는 카드만 숨겨서
// "항상 겹치는 2개는 히어로에만, 나머지 2개는 그리드에" 상태를 유지한다.
const MKT_DASH_ITEMS = [
  { id: 'sp500',  name: 'S&P 500',        fmt: 'n', mk: 'us' },
  { id: 'nasdaq', name: '나스닥',           fmt: 'n', mk: 'us', rotating: true },
  { id: 'dow',    name: '다우존스',         fmt: 'n', mk: 'us', rotating: true },
  { id: 'kospi',  name: '코스피',           fmt: 'n', mk: 'kr', rotating: true },
  { id: 'kosdaq', name: '코스닥',           fmt: 'n', mk: 'kr', rotating: true },
  { id: 'vix',    name: 'VIX',             fmt: 'n', mk: 'us' },
  { id: 'usdkrw', name: '달러환율',         fmt: 'n', mk: 'fx' },
  { id: 'sox',    name: '필라델피아반도체',   fmt: 'n', mk: 'us' },
  { id: 'nq',     name: '나스닥100 선물',    fmt: 'n', mk: 'us' },
  { id: 'btc',    name: '비트코인',         fmt: '$', mk: 'crypto' },
  { id: 'gold',   name: '금',              fmt: '$', mk: 'commodity' },
  { id: 'oil',    name: 'WTI 원유',         fmt: '$', mk: 'commodity' },
];

// /api/indices가 kr/us 지표엔 세션 앵커 정보(sessionStart/End/Live)를 내려준다 —
// areaSparkSvg/hover가 쓰는 {start,end} 형태로 뽑아준다. 세션 개념이 없는 지표(원자재 등)는
// null → areaSparkSvg가 자동으로 기존 인덱스 균등분배 방식으로 폴백한다.
function mktSessionOf(d) {
  return (d?.sessionStart != null && d?.sessionEnd != null) ? { start: d.sessionStart, end: d.sessionEnd } : null;
}

// 시장 개장 여부(KST 휴리스틱) — 시장지표 카드의 초록 동그라미 포인트용.
// KST = UTC+9. epoch에 9h 더한 뒤 getUTC*로 읽으면 브라우저 타임존과 무관하게 정확한 KST 벽시계.
function mktIsOpen(mk){
  const kst = new Date(Date.now() + 9*3600000);
  const day = kst.getUTCDay(), mins = kst.getUTCHours()*60 + kst.getUTCMinutes(), weekday = day>=1 && day<=5;
  if (mk === 'crypto') return true;
  if (mk === 'kr') return weekday && mins>=540 && mins<930;                       // 09:00~15:30
  if (mk === 'us') return (weekday && mins>=1350) || (mins<300 && day>=2 && day<=6); // 22:30~05:00 KST
  if (mk === 'fx' || mk === 'commodity') return weekday || (day===0 && mins>=360);  // 대략 월~금 + 일 저녁
  return false;
}
function updateMktDots(){
  MKT_DASH_ITEMS.forEach(it => {
    const dot = document.getElementById(`mktDot-${it.id}`);
    if (dot) dot.classList.toggle('on', mktIsOpen(it.mk));
  });
  const heroDot = document.getElementById('mktHeroDot');
  if (heroDot) heroDot.classList.toggle('on', mktIsOpen(heroMarketMeta().mk));
  const subDot = document.getElementById('mktHeroSubDot');
  if (subDot) subDot.classList.toggle('on', mktIsOpen(subMarketMeta().mk));
}

// 홈 "시장 지표" 히어로 카드 — 평일 08:50~18:00 KST는 국내 장(코스피/코스닥), 그 외
// (평일 저녁·밤·주말)는 미국 장(나스닥/다우)을 보여준다. 2026-07-28까지는 서브 히어로가
// "히어로의 반대 시장"(코스피↔나스닥)이었는데, 사용자 요청으로 "같은 장의 두 지수"로
// 바꿨다 — 국내 장중엔 코스피+코스닥, 미국 장중엔 나스닥+다우가 1·2번에 나란히 뜬다.
// 2026-08: 단, 토요일 10:00~월요일 08:00 KST(국내·미국 둘 다 완전히 쉬는 주말 구간)는
// 예외로 나스닥+코스피를 1·2번에 보여달라는 요청 — 위 두 함수 다 앞단에서 먼저 체크한다.
function _isWeekendCrossWindow(){
  const kst = new Date(Date.now() + 9*3600000);
  const day = kst.getUTCDay(), mins = kst.getUTCHours()*60 + kst.getUTCMinutes();
  if (day === 6 && mins >= 600) return true; // 토요일 10:00 이후
  if (day === 0) return true;                 // 일요일 종일
  if (day === 1 && mins < 480) return true;    // 월요일 08:00 이전
  return false;
}
function heroMarketMeta(){
  if (_isWeekendCrossWindow()) return { key: 'nasdaq', name: '나스닥', tag: 'NASDAQ Composite', mk: 'us', sym: 'nasdaq' };
  const kst = new Date(Date.now() + 9*3600000);
  const day = kst.getUTCDay(), mins = kst.getUTCHours()*60 + kst.getUTCMinutes();
  const isKrWindow = day>=1 && day<=5 && mins>=530 && mins<1080; // 08:50~18:00
  return isKrWindow
    ? { key: 'kospi',  name: '코스피',  tag: 'KOSPI Composite',  mk: 'kr', sym: 'kospi' }
    : { key: 'nasdaq', name: '나스닥',  tag: 'NASDAQ Composite', mk: 'us', sym: 'nasdaq' };
}
function subMarketMeta(){
  if (_isWeekendCrossWindow()) return { key: 'kospi', name: '코스피', tag: 'KOSPI Composite', mk: 'kr', sym: 'kospi' };
  return heroMarketMeta().key === 'kospi'
    ? { key: 'kosdaq', name: '코스닥',   tag: 'KOSDAQ Composite', mk: 'kr', sym: 'kosdaq' }
    : { key: 'dow',    name: '다우존스', tag: 'Dow Jones Industrial Average', mk: 'us', sym: 'dow' };
}


function renderMktStatus() {
  const el = document.getElementById('mktStatus');
  if (!el || el.dataset.rendered) return;
  el.dataset.rendered = '1';
  // 요일/시간 기반 1차 추정치 — 토스 장운영 캘린더(공휴일 포함 정확한 데이터)가 도착하면
  // renderMktStatusFromToss()가 이 자리를 실데이터로 덮어쓴다. 그 전까지 보여줄 빠른 추정.
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 - now.getTimezoneOffset()) * 60000);
  const day = kst.getDay();
  const mins = kst.getHours() * 60 + kst.getMinutes();
  const isWeekday = day >= 1 && day <= 5;
  const krOpen = isWeekday && mins >= 540 && mins < 930;       // 09:00–15:30
  // 해외(미국) 정규장은 22:30(전날 밤)~05:00(당일 새벽)로 자정을 넘겨 이어진다 —
  // 오늘 저녁에 새로 시작하거나(평일 저녁) 어제 밤 세션이 아직 진행 중인 경우(어제가 평일) 모두 포함.
  const usEveningOpen = isWeekday && mins >= 1350;             // 22:30~24:00
  const usMorningOpen = mins < 300 && day >= 2 && day <= 6;    // 00:00~05:00, 어제(day-1)가 평일
  const usOpen = usEveningOpen || usMorningOpen;
  el.innerHTML = `
    <div class="mkt-status-item"><span class="mkt-status-dot ${krOpen ? 'live' : 'closed'}"></span>${!isWeekday ? '국내 휴장일' : (krOpen ? '국내 정규장' : '국내 장마감')}</div>
    <div class="mkt-status-item"><span class="mkt-status-dot ${usOpen ? 'live' : 'closed'}"></span>해외 ${usOpen ? '정규장' : '장마감'} 22:30~05:00</div>
  `;
}

// 토스 장운영 캘린더(공휴일 포함 정확한 데이터)로 #mktStatus를 덮어쓴다.
function renderMktStatusFromToss(krMarket, usMarket) {
  const el = document.getElementById('mktStatus');
  if (!el) return;
  // 실데이터 우선권 표시 — loadIndices()가 나중에 끝나 renderMktStatus()(추정치)를 뒤늦게
  // 호출해도 이 값이 이미 서 있으면 덮어쓰지 못하게 막는다(레이스 컨디션 수정).
  el.dataset.rendered = 'toss';
  const now = new Date();
  const hhmm = iso => iso ? iso.slice(11, 16) : '';
  const within = sess => sess && now >= new Date(sess.startTime) && now < new Date(sess.endTime);

  let krHtml = '';
  if (krMarket) {
    if (krMarket.isHoliday) {
      krHtml = `<div class="mkt-status-item"><span class="mkt-status-dot closed"></span>국내 휴장일${krMarket.nextBusinessDay ? ` · 다음 개장 ${krMarket.nextBusinessDay.slice(5)}` : ''}</div>`;
    } else {
      const rm = krMarket.regularMarket;
      const open = within(rm);
      krHtml = `<div class="mkt-status-item"><span class="mkt-status-dot ${open ? 'live' : 'closed'}"></span>국내 ${open ? '정규장' : '장마감'}${rm ? ` ${hhmm(rm.startTime)}~${hhmm(rm.endTime)}` : ''}</div>`;
    }
  }

  let usHtml = '';
  if (usMarket) {
    if (usMarket.isHoliday) {
      usHtml = `<div class="mkt-status-item"><span class="mkt-status-dot closed"></span>해외 휴장일${usMarket.nextBusinessDay ? ` · 다음 개장 ${usMarket.nextBusinessDay.slice(5)}` : ''}</div>`;
    } else {
      const rm = usMarket.regularMarket;
      const open = within(rm);
      usHtml = `<div class="mkt-status-item"><span class="mkt-status-dot ${open ? 'live' : 'closed'}"></span>해외 ${open ? '정규장' : '장마감'}${rm ? ` ${hhmm(rm.startTime)}~${hhmm(rm.endTime)}` : ''}</div>`;
    }
  }

  if (krHtml || usHtml) el.innerHTML = krHtml + usHtml;
}

function renderMarketDash(data) {
  const grid = document.getElementById('mktDashGrid');
  if (!grid || !data) return;
  renderMktStatus();

  // 히어로 카드 — 시간대에 따라 코스피/나스닥 전환
  const heroMeta = heroMarketMeta();
  const heroA = document.getElementById('mktHero');
  if (heroA && heroA.dataset.heroKey !== heroMeta.key) {
    heroA.dataset.heroKey = heroMeta.key;
    heroA.href = `/market-detail.html?sym=${heroMeta.sym}`;
    const nameEl = document.getElementById('mktHeroName');
    const tagEl = document.getElementById('mktHeroTag');
    if (nameEl) nameEl.textContent = heroMeta.name;
    if (tagEl) tagEl.textContent = heroMeta.tag;
  }
  const nd = data[heroMeta.key];
  if (nd?.price != null) {
    const chgClass = nd.changePercent > 0 ? 'pos' : nd.changePercent < 0 ? 'neg' : '';
    const chgSign = nd.changePercent > 0 ? '+' : '';
    const valEl = document.getElementById('mktHeroVal');
    const chgEl = document.getElementById('mktHeroChg');
    if (valEl) animateNumberText(valEl, nd.price, v => fmtIdx(v, 'n'), ['flash-up', 'flash-down']);
    if (chgEl && nd.changePercent != null) {
      chgEl.innerHTML = `<span class="${chgClass}">${chgSign}${(nd.change ?? 0).toFixed(2)} (${chgSign}${nd.changePercent.toFixed(2)}%)</span>`;
    }
    const chartEl = document.getElementById('mktHeroChart');
    if (chartEl && Array.isArray(nd.spark) && nd.spark.length > 1) {
      // 국내 관례(상승 빨강/하락 파랑) — 예전엔 서구권 관례(초록/빨강)를 써서 등락 텍스트
      // (빨강/파랑)와 차트 색이 반대로 보였다(2026-07-28 스크린샷으로 확인). --red/--blue와
      // 동일한 hex(다크 테마 기준)로 맞춤.
      const color = nd.changePercent >= 0 ? '#ff6b6b' : '#4d8dff';
      renderMktSpark(chartEl, nd.spark, 300, 64, color, nd.prevClose, nd.sessionLive ?? mktIsOpen(heroMeta.mk), nd.sparkT, mktSessionOf(nd));
    }
    if (nd.fiftyTwoWeekLow != null && nd.fiftyTwoWeekHigh != null) {
      const wrap = document.getElementById('mktHero52w');
      if (wrap) {
        wrap.style.display = '';
        const range = nd.fiftyTwoWeekHigh - nd.fiftyTwoWeekLow || 1;
        const pos = Math.min(100, Math.max(0, ((nd.price - nd.fiftyTwoWeekLow) / range) * 100));
        const dot = document.getElementById('mktHero52wDot');
        if (dot) dot.style.left = pos + '%';
        const lo = document.getElementById('mktHero52wLo'), hi = document.getElementById('mktHero52wHi');
        if (lo) lo.textContent = fmtIdx(nd.fiftyTwoWeekLow, 'n');
        if (hi) hi.textContent = fmtIdx(nd.fiftyTwoWeekHigh, 'n');
      }
    }
  }

  // 서브 히어로 — 히어로와 같은 장의 다른 지수(subMarketMeta 참고), 히어로와 동일한 정보(차트+52주 범위)를 보여준다
  const subMeta = subMarketMeta();
  const subA = document.getElementById('mktHeroSub');
  if (subA && subA.dataset.subKey !== subMeta.key) {
    subA.dataset.subKey = subMeta.key;
    subA.href = `/market-detail.html?sym=${subMeta.sym}`;
    const subNameEl = document.getElementById('mktHeroSubName');
    const subTagEl = document.getElementById('mktHeroSubTag');
    if (subNameEl) subNameEl.textContent = subMeta.name;
    if (subTagEl) subTagEl.textContent = subMeta.tag;
  }
  const sd = data[subMeta.key];
  if (sd?.price != null) {
    const chgClass = sd.changePercent > 0 ? 'pos' : sd.changePercent < 0 ? 'neg' : '';
    const chgSign = sd.changePercent > 0 ? '+' : '';
    const subValEl = document.getElementById('mktHeroSubVal');
    const subChgEl = document.getElementById('mktHeroSubChg');
    if (subValEl) animateNumberText(subValEl, sd.price, v => fmtIdx(v, 'n'), ['flash-up', 'flash-down']);
    if (subChgEl && sd.changePercent != null) {
      subChgEl.innerHTML = `<span class="${chgClass}">${chgSign}${(sd.change ?? 0).toFixed(2)} (${chgSign}${sd.changePercent.toFixed(2)}%)</span>`;
    }
    const subChartEl = document.getElementById('mktHeroSubChart');
    if (subChartEl && Array.isArray(sd.spark) && sd.spark.length > 1) {
      const color = sd.changePercent >= 0 ? '#ff6b6b' : '#4d8dff';
      renderMktSpark(subChartEl, sd.spark, 300, 64, color, sd.prevClose, sd.sessionLive ?? mktIsOpen(subMeta.mk), sd.sparkT, mktSessionOf(sd));
    }
    if (sd.fiftyTwoWeekLow != null && sd.fiftyTwoWeekHigh != null) {
      const wrap = document.getElementById('mktHeroSub52w');
      if (wrap) {
        wrap.style.display = '';
        const range = sd.fiftyTwoWeekHigh - sd.fiftyTwoWeekLow || 1;
        const pos = Math.min(100, Math.max(0, ((sd.price - sd.fiftyTwoWeekLow) / range) * 100));
        const dot = document.getElementById('mktHeroSub52wDot');
        if (dot) dot.style.left = pos + '%';
        const lo = document.getElementById('mktHeroSub52wLo'), hi = document.getElementById('mktHeroSub52wHi');
        if (lo) lo.textContent = fmtIdx(sd.fiftyTwoWeekLow, 'n');
        if (hi) hi.textContent = fmtIdx(sd.fiftyTwoWeekHigh, 'n');
      }
    }
  }

  // 카드 DOM은 최초 1회만 생성, 이후엔 in-place 갱신
  if (!grid.dataset.cardsBuilt) {
    grid.dataset.cardsBuilt = '1';
    const cardsHtml = MKT_DASH_ITEMS.map(it => `
      <a class="mkt-card mkt-card-link" data-mkt-id="${it.id}" href="/market-detail.html?sym=${it.id}">
        <div class="mkt-card-main">
          <div class="mkt-card-name"><span class="mkt-live-dot" id="mktDot-${it.id}"></span>${it.name}</div>
          <div class="mkt-card-val" id="mktCardVal-${it.id}">—</div>
          <div class="mkt-card-chg" id="mktCardChg-${it.id}">—</div>
        </div>
        <div class="mkt-card-spark" id="mktCardSpark-${it.id}"></div>
      </a>`).join('') + `
      <a class="mkt-card mkt-link" data-mkt-id="kospiFut" href="https://finance.naver.com/sise/sise_index.naver?code=FUT" target="_blank" rel="noopener">
        <div class="mkt-card-main">
          <div class="mkt-card-name"><span class="mkt-live-dot" id="mktDot-kospiFut"></span>코스피200 야간선물</div>
          <div class="mkt-card-val" id="mktCardVal-kospiFut">—</div>
          <div class="mkt-card-chg" id="mktCardChg-kospiFut">—</div>
        </div>
        <span class="mkt-link-cta">실시간 시세<br>보기 →</span>
      </a>`;
    grid.insertAdjacentHTML('beforeend', cardsHtml);
  }
  // rotating 카드(kospi/kosdaq/nasdaq/dow) 중 지금 히어로/서브 히어로로 떠 있는 2개는
  // 작은 그리드에서 숨긴다 — cardsBuilt 캐시와 무관하게 히어로가 국내장↔미국장 경계를
  // 넘어갈 때마다(하루 두 번) 매 렌더 호출에서 다시 계산해야 한다.
  const activeRotatingIds = new Set([heroMeta.key, subMeta.key]);
  MKT_DASH_ITEMS.forEach(it => {
    if (!it.rotating) return;
    const card = grid.querySelector(`[data-mkt-id="${it.id}"]`);
    if (card) card.style.display = activeRotatingIds.has(it.id) ? 'none' : '';
  });
  updateMktDots();

  MKT_DASH_ITEMS.forEach(it => {
    const d = data[it.id];
    if (!d?.price) return;
    const chgClass = d.changePercent > 0 ? 'pos' : d.changePercent < 0 ? 'neg' : '';
    const chgSign = d.changePercent > 0 ? '+' : '';
    const valEl = document.getElementById(`mktCardVal-${it.id}`);
    const chgEl = document.getElementById(`mktCardChg-${it.id}`);
    if (valEl) animateNumberText(valEl, d.price, v => fmtIdx(v, it.fmt), ['flash-up', 'flash-down']);
    if (chgEl && d.changePercent != null) {
      chgEl.textContent = `${chgSign}${d.changePercent.toFixed(2)}%`;
      chgEl.className = `mkt-card-chg ${chgClass}`;
    }
    const sparkEl = document.getElementById(`mktCardSpark-${it.id}`);
    if (sparkEl && Array.isArray(d.spark) && d.spark.length > 1) {
      const color = d.changePercent >= 0 ? '#ff6b6b' : '#4d8dff';
      // 이 작은 카드(46×28)는 호버 툴팁을 붙이기엔 너무 좁아서 라이브 핑만 붙인다 —
      // 히어로 카드(위)만 손으로 짚어보는 인터랙션 대상. 세션 앵커(시작~장마감 축)는 붙인다.
      sparkEl.innerHTML = areaSparkSvg(d.spark, 46, 28, color, d.prevClose, d.sessionLive ?? mktIsOpen(it.mk), d.sparkT, mktSessionOf(d));
    }
  });

  // 코스피200 야간선물(KIS) — kr-market.html의 추정 배너와 같은 소스. 스냅샷(현재가·등락률)만
  // 있고 인트라데이 히스토리가 없어 스파크라인은 없음(다른 카드와 다른 점).
  // 2026-08 수정: "22:30~09:00 KST에만 표시" 시간 가드는 제거(실제 거래 가능 시간과
  // 무관한 잘못된 기준이었음 — 이전 커밋 참고).
  // ⚠️ 2026-08 추가: 실측 결과 이 값이 2시간 반 넘게 완전히 동일(1,030.65 / +18.79%)했고,
  // +18.79%는 지수 선물 단일 세션 등락률로는 비현실적으로 큰 값이라(사용자 지적: "장
  // 마지막 날 야간선물은 많이 떨어진 걸로 아는데") KIS API가 살아있는 실시간 값이 아니라
  // 고정/모의투자 데이터를 주고 있을 가능성이 있다 — 근본 원인(KIS_APP_KEY가 실전투자가
  // 아닌 모의투자 키인지 등)은 서버 쪽 확인이 필요해 여기서 못 고친다. 대신 등락률이
  // 비현실적으로 크면(±10%p 초과) 화면에 잘못된 실시간 인상을 주지 않도록 표시를 억제한다.
  const knf = data.kospiFut;
  const knfPlausible = knf?.price != null && Math.abs(knf.changePercent ?? 0) <= 10;
  const knfValEl = document.getElementById('mktCardVal-kospiFut');
  const knfChgEl = document.getElementById('mktCardChg-kospiFut');
  const knfDot = document.getElementById('mktDot-kospiFut');
  if (knfDot) knfDot.classList.toggle('on', knfPlausible);
  if (knfPlausible) {
    const chgClass = knf.changePercent > 0 ? 'pos' : knf.changePercent < 0 ? 'neg' : '';
    const chgSign = knf.changePercent > 0 ? '+' : '';
    if (knfValEl) animateNumberText(knfValEl, knf.price, v => fmtIdx(v, 'n'), ['flash-up', 'flash-down']);
    if (knfChgEl && knf.changePercent != null) {
      knfChgEl.textContent = `${chgSign}${knf.changePercent.toFixed(2)}%`;
      knfChgEl.className = `mkt-card-chg ${chgClass}`;
    }
  } else {
    if (knfValEl) knfValEl.textContent = '—';
    if (knfChgEl) { knfChgEl.textContent = ''; knfChgEl.className = 'mkt-card-chg'; }
  }
}

// 🇰🇷 국고채 금리 스트립 + 장운영 상태 — 홈 전용(관련 엘리먼트 없는 페이지는 no-op).
// 토스증권 공식 API 하나로 두 가지를 같이 갱신(불필요한 중복 호출 방지).
const BOND_TENORS = [
  { key: 'y2',  label: '2년' },
  { key: 'y3',  label: '3년' },
  { key: 'y5',  label: '5년' },
  { key: 'y10', label: '10년' },
  { key: 'y20', label: '20년' },
  { key: 'y30', label: '30년' },
];
async function loadBondStrip() {
  const wrap = document.getElementById('mktBondStrip');
  const hasStatus = !!document.getElementById('mktStatus');
  if (!wrap && !hasStatus) return;
  try {
    const bust = Math.floor(Date.now() / 60000);
    const r = await fetch(`/api/toss?_t=${bust}`);
    if (!r.ok) return;
    const j = await r.json();
    if (!j.ok) return;

    if (j.krMarket || j.usMarket) renderMktStatusFromToss(j.krMarket, j.usMarket);

    if (wrap && j.bonds) {
      const items = BOND_TENORS
        .filter(t => j.bonds[t.key] != null)
        .map(t => `<span class="mkt-bond-item"><small>${t.label}</small><b>${Number(j.bonds[t.key]).toFixed(2)}%</b></span>`)
        .join('');
      if (items) {
        wrap.insertAdjacentHTML('beforeend', items);
        wrap.style.display = '';
      }
    }
  } catch {}
}

async function loadIndices() {
  try {
    const r = await fetch('/api/indices');
    if (!r.ok) throw new Error('indices API failed');
    const { data } = await r.json();
    if (!data) return;

    renderMarketDash(data);

    INDICES.forEach(idx => {
      const d = data[idx.id];
      if (!d?.price) return;
      const { price, changePercent } = d;
      const chgClass = changePercent > 0 ? 'up' : changePercent < 0 ? 'dn' : 'flat';
      const chgSign = changePercent > 0 ? '+' : '';
      const chgStr = changePercent != null ? `${chgSign}${changePercent.toFixed(2)}%` : '—';
      const priceStr = fmtIdx(price, idx.fmt);

      // ticker bar — 마퀴 루프용 복제본(id 중복)까지 모두 갱신
      document.querySelectorAll(`[id="tk-${idx.id}"]`).forEach(el => { el.textContent = priceStr; });
      document.querySelectorAll(`[id="tk-${idx.id}-chg"]`).forEach(el => {
        el.textContent = chgStr; el.className = `ticker-chg ${chgClass}`;
      });
      // 24h 스파크라인
      if (Array.isArray(d.spark) && d.spark.length > 1) {
        const color = changePercent > 0 ? 'var(--red)' : changePercent < 0 ? 'var(--blue)' : 'var(--text3)';
        const path = `<path d="${sparkPath(d.spark)}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>`;
        document.querySelectorAll(`[data-spark="${idx.id}"]`).forEach(el => { el.innerHTML = path; });
      }

      // sidebar
      const siVal = document.getElementById(`si-${idx.id}`);
      const siChg = document.getElementById(`si-${idx.id}-chg`);
      if (siVal) { siVal.textContent = priceStr; siVal.className = `index-val ${chgClass}`; }
      if (siChg) { siChg.textContent = chgStr; siChg.className = `index-chg ${chgClass}`; }
    });
  } catch (e) {
    console.warn('loadIndices error:', e.message);
  }

  // ticker bar duplicate for seamless loop
  const track = document.getElementById('tickerTrack');
  if (track && !track.dataset.duped) {
    track.innerHTML += track.innerHTML;
    track.dataset.duped = '1';
  }

  const now = new Date().toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false});
  const el = document.getElementById('indicesUpdatedAt');
  if (el) el.textContent = now + ' 기준';
}

// ── 🎯 투자 인사이트: 누적 예측 데이터 기반 종목 추천 ──────────────
// 홈(index.html)은 #issuesContainer가 있는 페이지 — 미리보기 4개(2x2, 홀수면
// 그리드가 비어 보임) + "전체보기" 링크만 보여주고, 전용 페이지(/picks.html)는
// issuesContainer가 없으므로 더 많은 개수를 그대로 다 보여준다. 마크업 유무로
// 페이지를 구분해 별도 페이지 모드 플래그 없이 index.html/picks.html이 같은
// app.js를 공유한다.
function reloadInsightsForPage() {
  const isHome = !!document.getElementById('issuesContainer');
  loadInsights(isHome ? 4 : 30, isHome);
}

// maxCards: 카드 몇 개까지 보여줄지 (기본 12, 홈 미리보기는 4 + "전체보기" 링크).
// showMoreLink: true면 잘린 목록 아래 /picks.html "전체 매수 후보 보기" 링크를 붙인다.
async function loadInsights(maxCards = 12, showMoreLink = false) {
  const sec = document.getElementById('insightsSection');
  const el  = document.getElementById('insightsPanel');
  if (!sec || !el) return;

  try {
    const now = Date.now();
    const RECENT_DAYS = 14;
    const recentMs = RECENT_DAYS * 86400000;

    // 최근 500건의 예측 (이력 + 활성 모두) + 미래 먹거리 테마 맵 (큐레이션 + 일일 cron 자동추출 병합, /api/admin?action=theme-map)
    // analysis_companies 원본(500건)은 방문자 브라우저의 직접 Supabase 호출을 캐싱되는
    // 서버 엔드포인트(action=insights-raw, 60초 엣지캐시)로 옮긴 것 — 이하 티커별 집계·
    // 점수화 로직은 그대로 클라이언트에서 수행(응답 스키마 동일이라 안전).
    const [insightsRes, themeMap] = await Promise.all([
      fetch('/api/admin?action=insights-raw').then(r => r.json()).catch(() => ({ ok: false, data: [] })),
      fetch('/api/admin?action=theme-map').then(r => r.ok ? r.json() : { map: {} }).then(j => j.map || {}).catch(() => ({})),
    ]);
    const data = insightsRes?.data;
    const error = insightsRes?.ok ? null : (insightsRes?.error || 'unknown error');

    if (error) { sec.style.display = 'none'; return; }
    if (!data?.length) {
      // 매수 후보 데이터가 의도적으로 비어있는 경우(기능 일시 중단) — 그냥 숨기면
      // picks.html처럼 이 섹션이 페이지의 전부인 곳은 "제목만 있고 아무것도 없는"
      // 어색한 빈 화면이 된다. 조용히 사라지는 대신 이유를 짧게 안내한다.
      sec.style.display = '';
      el.innerHTML = `<div style="padding:32px 20px;text-align:center;color:var(--text3);font-size:15.5px;border:1px dashed var(--border);border-radius:12px">
        🛠️ 매수 후보 추천 기능은 현재 점검을 위해 잠시 중단되었습니다.
      </div>`;
      return;
    }

    // 티커별 집계
    const map = {};
    for (const row of data) {
      const t = row.companies?.ticker;
      if (!t) continue;
      if (!map[t]) map[t] = {
        ticker: t,
        name: row.companies.name_ko || row.companies.name_en || t,
        market: row.companies.market || 'US',
        histTotal: 0, histHits: 0,
        recent: [], recentUpsides: [], recentConfs: [],
        latestIssue: null, latestRationale: null,
      };
      const m = map[t];

      // 과거 적중 이력 (7일 검증 우선, 1일 폴백)
      if (row.is_accurate_7d !== null && row.is_accurate_7d !== undefined) {
        m.histTotal++;
        if (row.is_accurate_7d === true && Math.abs(row.actual_return_7d || 0) >= 1.5) m.histHits++;
      } else if (row.is_accurate_1d !== null && row.is_accurate_1d !== undefined) {
        m.histTotal++;
        if (row.is_accurate_1d === true && Math.abs(row.actual_return_1d || 0) >= 0.3) m.histHits++;
      }

      // 최근 14일 예측 (활성 신호)
      const entryMs = new Date(row.entry_date).getTime();
      if (now - entryMs <= recentMs) {
        m.recent.push(row);
        if (row.upside_pct != null) m.recentUpsides.push(row.upside_pct);
        if (row.confidence != null) m.recentConfs.push(row.confidence);
        if (!m.latestIssue && row.analyses?.issues) {
          m.latestIssue = row.analyses.issues;
          m.latestRationale = row.rationale;
        }
      }
    }

    // 점수 계산
    const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
    const scored = Object.values(map)
      .filter(s => s.recent.length >= 1)
      .map(s => {
        const accuracy = s.histTotal >= 2 ? (s.histHits / s.histTotal * 100) : null;
        const avgUpside = avg(s.recentUpsides);
        const avgConf   = avg(s.recentConfs) || 50;
        const predCount = s.recent.length;

        // 미래 먹거리 테마 점수 — 시장 전략적 투자/지분 노출 (큐레이션 + 최근 뉴스 자동추출, 최대 15점)
        // - 강조(⭐) 배팅이면 기본 15점, 일반 배팅이면 9점
        // - 큐레이션(source:'curated')은 감쇠 없음. AI 자동추출(source:'ai')은 최근 뉴스에 재등장했을수록 가중치 유지, 오래될수록 감쇠
        const bet = themeMap[s.ticker];
        let themeScore = 0, themeLabel = null;
        if (bet) {
          let recency = 1;
          if (bet.source === 'ai' && bet.last_seen_at) {
            const daysSinceSeen = (now - new Date(bet.last_seen_at).getTime()) / 86400000;
            recency = daysSinceSeen <= 7 ? 1 : daysSinceSeen <= 30 ? 0.6 : daysSinceSeen <= 90 ? 0.3 : 0.1;
          }
          themeScore = Math.round((bet.highlight ? 15 : 9) * recency);
          themeLabel = bet.theme;
        }

        // 종합 점수
        // - 적중률 가중치 50점 (이력 없으면 35점 기본)
        // - 평균 상승률 가중치 40점 (cap 30%)
        // - AI 신뢰도 가중치 25점
        // - 예측 빈도 가중치 20점 (최근 5건까지)
        // - 미래 먹거리 테마 가중치 15점 (전략적 투자 노출 + 최신성)
        // (이후 상위 후보군에 추가 보정: 기술 모멘텀 ±18, 수급 ±10, 펀더멘털 ±8 — 아래 참조)
        const accScore   = accuracy != null ? (accuracy / 100) * 50 : 35;
        const upScore    = Math.min(Math.max(avgUpside, 0), 30) / 30 * 40;
        const confScore  = (avgConf / 100) * 25;
        const countScore = Math.min(predCount, 5) / 5 * 20;
        const score = Math.round(accScore + upScore + confScore + countScore + themeScore);

        return {
          ...s,
          accuracy: accuracy != null ? Math.round(accuracy) : null,
          avgUpside: Math.round(avgUpside * 10) / 10,
          avgConf:   Math.round(avgConf),
          predCount, score, themeScore, themeLabel,
        };
      })
      .filter(s => s.avgUpside > 0) // 상승 예측만
      // 최근 [TRADE] 정보가 있고 목표가 음수면 매수 후보에서 제외 (AI 환각/모순 픽)
      // 인라인 파싱 (parseTradeMeta는 아래에 정의됨)
      .filter(s => {
        const r = s.latestRationale || '';
        const ti = r.indexOf('[TRADE]');
        if (ti < 0) return true;  // 트레이드 정보 없으면 통과
        const after = r.slice(ti + 7);
        const fi = after.indexOf('[FUND]');
        const json = fi >= 0 ? after.slice(0, fi).trim() : after.trim();
        let t = null;
        try { t = JSON.parse(json); } catch { return true; }
        if (!t) return true;
        if (t.tp != null && Number(t.tp) <= 0) return false;
        if (t.sl != null && Number(t.sl) >= 0) return false;
        return true;
      })
      .sort((a, b) => b.score - a.score);

    // 모멘텀 반영: 상위 후보군(기본 점수 상위 40개)에 기술적 시그널(RSI/추세)을 가져와 점수 보정.
    // "과거 분석 점수는 높은데 지금 급락 중"인 모순(예: 하락 추세인데 STRONG BUY)을 막기 위함.
    // 전체 종목에 다 걸면 느려지므로, 기본 점수로 이미 상위권인 후보군만 대상으로 함
    // (그 밖은 모멘텀 보너스를 받아도 top 12 진입이 사실상 불가능한 점수대).
    const MOMENTUM_ADJ = {
      strong_bullish: 8, bullish: 4, oversold_bull: 6, neutral: 0,
      overbought: -2, oversold: -4, bearish: -10, strong_bearish: -18,
    };
    const candidatePool = scored.slice(0, 40);
    const poolTickers = candidatePool.map(s => s.ticker);
    for (let i = 0; i < poolTickers.length; i += 15) {
      const batch = poolTickers.slice(i, i + 15);
      try {
        const r = await fetch(`/api/technicals?tickers=${batch.map(encodeURIComponent).join(',')}`);
        if (r.ok) {
          const j = await r.json();
          for (const [t, info] of Object.entries(j.data || {})) {
            if (info) _techCache[t] = { ...info, _ts: Date.now() };
          }
        }
      } catch {}
    }
    for (const s of candidatePool) {
      const tech = _techCache[s.ticker];
      s.momentumAdj = tech ? (MOMENTUM_ADJ[tech.signal] ?? 0) : 0;
      s.score = Math.round(s.score + s.momentumAdj);
    }
    candidatePool.sort((a, b) => b.score - a.score);

    // 수급 + 펀더멘털 팩터: 모멘텀 반영 후 상위 24개만 배치 조회 (서버 15분 CDN 캐시)
    // - 수급(KR만): 외인/기관 5일 누적 순매수·연속 매수일·거래량 대비 강도 → 최대 ±10점
    //   "AI 점수는 높은데 외인·기관이 던지는 중"인 종목의 순위를 낮추고, 쌍끌이 매수는 올린다
    // - 펀더멘털: 수익성(ROE·영업이익률)·성장(매출 YoY)·재무위험(부채) → 최대 ±8점
    //   KR은 네이버 분기 재무제표, US는 DB에 캐시된 FMP 데이터 (FMP 한도 소모 없음)
    const factorPool = candidatePool.slice(0, 24);
    try {
      const ft = factorPool.map(s => s.ticker).sort();  // 티커 정렬 → 동일 URL → CDN 캐시 히트
      const r = await fetch(`/api/stock?type=score-factors&tickers=${ft.map(encodeURIComponent).join(',')}`);
      if (r.ok) {
        const j = await r.json();
        for (const s of factorPool) {
          const d = j.data?.[s.ticker];
          if (!d) continue;
          let flowAdj = 0;
          if (d.flow) {
            const f = d.flow;
            const fPos = f.foreign5d > 0, iPos = f.inst5d > 0;
            if (fPos && iPos)      flowAdj += 6;   // 외인+기관 쌍끌이 매수
            else if (fPos)         flowAdj += 4;
            else if (iPos)         flowAdj += 2;
            if (f.foreign5d < 0 && f.inst5d < 0) flowAdj -= 6;   // 쌍매도
            if (f.foreignStreak >= 3)  flowAdj += 2;   // 외인 3일+ 연속 순매수
            if (f.foreignStreak <= -3) flowAdj -= 2;   // 외인 3일+ 연속 순매도
            if (f.smartRatio != null)  flowAdj += Math.max(-2, Math.min(2, Math.round(f.smartRatio / 5)));
            flowAdj = Math.max(-10, Math.min(10, flowAdj));
          }
          let fundAdj = 0;
          if (d.fund) {
            const g = d.fund;
            if (g.roe != null)      fundAdj += g.roe > 15 ? 3 : g.roe > 5 ? 1 : g.roe < 0 ? -3 : 0;
            if (g.opMargin != null) fundAdj += g.opMargin > 15 ? 2 : g.opMargin < 0 ? -3 : 0;
            if (g.revYoY != null)   fundAdj += g.revYoY > 20 ? 2 : g.revYoY > 5 ? 1 : g.revYoY < -10 ? -2 : 0;
            if (g.debtRatioPct != null && g.debtRatioPct > 400) fundAdj -= 3;  // KR: 부채비율 400%+
            if (g.debtToEquity != null && g.debtToEquity > 3)   fundAdj -= 3;  // US: D/E 3+
            fundAdj = Math.max(-8, Math.min(8, fundAdj));
          }
          s.flowAdj = flowAdj;
          s.fundAdj = fundAdj;
          s.factorFlow = d.flow || null;
          s.factorFund = d.fund || null;
          s.score = Math.round(s.score + flowAdj + fundAdj);
        }
      }
    } catch {}
    candidatePool.sort((a, b) => b.score - a.score);

    // 엄격 모드: AI 신뢰도 ≥80% 종목만 — 2026-07에 토글 UI를 없애고 항상 켬(사용자 요청)
    const strictMode = true;
    const beforeStrict = candidatePool.length;
    const filteredPool = strictMode ? candidatePool.filter(s => s.avgConf >= 80) : candidatePool;
    // 홈 미리보기(showMoreLink)는 히트맵/국장현황처럼 다음 줄이 살짝 보이다 페이드아웃
    // 되도록 카드를 2장 더 그려서 CSS로 자른다 (전체보기 유도 개수는 여전히 maxCards 기준).
    const finalScored = filteredPool.slice(0, maxCards + (showMoreLink ? 2 : 0));

    if (!finalScored.length) {
      sec.style.display = 'block';
      el.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text3);background:var(--bg2);border:1px dashed var(--border);border-radius:10px;font-size:15.5px">
        ${strictMode
          ? `🔒 AI 신뢰도 ≥80% 종목 없음 (전체 ${beforeStrict}개 중 0개 통과)<br><span style="font-size:13.5px">→ 더 많은 분석이 쌓이면 채워집니다</span>`
          : '데이터 부족'}
      </div>`;
      const upd = document.getElementById('insightsUpdated');
      if (upd) upd.textContent = new Date().toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit'}) + ' KST';
      return;
    }

    sec.style.display = 'block';
    const upd = document.getElementById('insightsUpdated');
    if (upd) upd.textContent = new Date().toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit'}) + ' KST · 최근 ' + RECENT_DAYS + '일' + (strictMode ? ` · 🔒 (${Math.min(finalScored.length, maxCards)}/${beforeStrict})` : '');

    const tickers = finalScored.map(s => s.ticker);

    // ── 매매 정보 + 펀더멘털 파싱 (rationale에 임베드된 [TRADE]/[FUND] 마커) ──
    const parseTradeMeta = (rationale) => {
      if (!rationale) return { reason: '', trade: null, fund: null };
      let reason = rationale, trade = null, fund = null;
      const fundIdx = rationale.indexOf('[FUND]');
      if (fundIdx >= 0) {
        try { fund = JSON.parse(rationale.slice(fundIdx + 6).split(/\[(TRADE|FUND)\]/)[0].trim()); } catch {}
      }
      const tradeIdx = rationale.indexOf('[TRADE]');
      if (tradeIdx >= 0) {
        const after = rationale.slice(tradeIdx + 7);
        const fundInAfter = after.indexOf('[FUND]');
        const tradeJson = fundInAfter >= 0 ? after.slice(0, fundInAfter).trim() : after.trim();
        try { trade = JSON.parse(tradeJson); } catch {}
      }
      const cutIdx = Math.min(
        tradeIdx >= 0 ? tradeIdx : Infinity,
        fundIdx  >= 0 ? fundIdx  : Infinity
      );
      if (cutIdx !== Infinity) reason = rationale.slice(0, cutIdx).trim();
      return { reason, trade, fund };
    };
    const tfLabel = { '1w':'단기 1주', '1m':'중기 1개월', '3m':'중장기 3개월', '6m':'장기 6개월' };

    el.innerHTML = (showMoreLink ? `<div id="insightsCropWrap">` : '') +
      `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:12px">` +
      finalScored.map((s, i) => {
        const isKr = s.market === 'KR';
        // 3=STRONG BUY, 2=BUY, 1=WATCH, 0=WEAK — 과거 누적 점수가 아무리 높아도
        // 지금 기술적으로 뚜렷한 하락 추세면 STRONG BUY/BUY로 표시하지 않도록 상한을 둠
        let tier = s.score >= 75 ? 3 : s.score >= 60 ? 2 : s.score >= 45 ? 1 : 0;
        const momentumSignal = _techCache[s.ticker]?.signal;
        if (momentumSignal === 'strong_bearish') tier = Math.min(tier, 1);
        else if (momentumSignal === 'bearish')   tier = Math.min(tier, 2);
        // 외인·기관 쌍매도 + 외인 3일 이상 연속 매도면 수급 붕괴 — STRONG BUY 억제
        if (s.factorFlow && s.factorFlow.foreign5d < 0 && s.factorFlow.inst5d < 0 && s.factorFlow.foreignStreak <= -3) tier = Math.min(tier, 2);
        const signal = tier === 3 ? { label: '🔥 STRONG BUY', color: '#fff', bg: 'linear-gradient(135deg,#ef4444,#dc2626)' }
                      : tier === 2 ? { label: '⭐ BUY',         color: '#fff', bg: 'linear-gradient(135deg,#3b82f6,#1d4ed8)' }
                      : tier === 1 ? { label: 'WATCH',          color: 'var(--text2)', bg: 'var(--bg3)' }
                      : { label: 'WEAK', color: 'var(--text3)', bg: 'var(--bg3)' };
        const accColor = s.accuracy == null ? 'var(--text3)'
                      : s.accuracy >= 70   ? 'var(--green)'
                      : s.accuracy >= 50   ? 'var(--yellow)' : 'var(--red)';
        const accLabel = s.accuracy != null ? `적중률 ${s.accuracy}% (${s.histTotal}건)` : `신규 분석`;
        const parsed = parseTradeMeta(s.latestRationale);
        const trade  = parsed.trade;
        const fund   = parsed.fund;
        // 카드 클릭 → 항상 company.html로 (기업 상세 + 차트 + AI 종합)
        const issueLink = `/company.html?ticker=${encodeURIComponent(s.ticker)}`;

        // 매매 정보 박스 (trade 있을 때만) — 현재가 기반 실제 가격 계산
        const fmtPct = v => (v > 0 ? '+' : '') + v + '%';
        // 실시간 시세 캐시 (refreshInsightQuotes에서 _lastQuoteCache 사용)
        const curPrice = _lastQuoteCache?.[s.ticker]?.price;
        const fmtP = v => v == null ? '—' : (isKr
          ? '₩' + Math.round(v).toLocaleString('ko-KR')
          : '$' + Number(v).toFixed(2));
        const buyLow  = curPrice && trade?.elp != null ? curPrice * (1 + trade.elp / 100) : null;
        const buyHigh = curPrice && trade?.ehp != null ? curPrice * (1 + trade.ehp / 100) : null;
        const target  = curPrice && trade?.tp  != null ? curPrice * (1 + trade.tp  / 100) : null;
        const stop    = curPrice && trade?.sl  != null ? curPrice * (1 + trade.sl  / 100) : null;

        // ⚠️ 규제(유사투자자문업)·과신 방어: 이 매수/목표/손절 수치는 "특정 종목 매매 권유"가
        // 아니라 AI가 만든 가설 시나리오임을 화면에서 분명히 한다(2026-07). 라벨을 "가설"로
        // 완화하고, 박스 상단에 매매 권유가 아니라는 캡션을 항상 붙인다. 수치 자체는 유지.
        const tradeBox = trade ? `
          <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;padding:10px;background:linear-gradient(135deg,rgba(63,185,80,.08),rgba(47,129,247,.08));border:1px solid rgba(63,185,80,.2);border-radius:8px">
            <div style="grid-column:1/-1;font-size:12px;color:var(--text3);text-align:center;line-height:1.3;margin-bottom:2px">🤖 AI 가설 시나리오 · 특정 종목 매매 권유가 아닙니다</div>
            <div style="text-align:center;min-width:0">
              <div style="font-size:12px;color:var(--text3);margin-bottom:2px">참고 매수대</div>
              <div style="font-size:13.5px;font-weight:700;color:var(--blue);font-family:'SF Mono',monospace;overflow-wrap:break-word">
                ${buyLow ? fmtP(buyLow) : (trade.elp != null ? fmtPct(trade.elp) : '—')}
                ${buyHigh ? `<br><span style="font-size:12px;color:var(--text3);font-weight:400">~ ${fmtP(buyHigh)}</span>` : ''}
              </div>
            </div>
            <div style="text-align:center;min-width:0;border-left:1px solid var(--border);border-right:1px solid var(--border)">
              <div style="font-size:12px;color:var(--text3);margin-bottom:2px">목표(가설)</div>
              <div style="font-size:13.5px;font-weight:700;color:var(--green);font-family:'SF Mono',monospace;overflow-wrap:break-word">
                ${target ? fmtP(target) : (trade.tp != null ? fmtPct(trade.tp) : '—')}
                ${target ? `<br><span style="font-size:12px;color:var(--text3);font-weight:400">+${trade.tp}%</span>` : ''}
              </div>
            </div>
            <div style="text-align:center;min-width:0">
              <div style="font-size:12px;color:var(--text3);margin-bottom:2px">손절(가설)</div>
              <div style="font-size:13.5px;font-weight:700;color:var(--red);font-family:'SF Mono',monospace;overflow-wrap:break-word">
                ${stop ? fmtP(stop) : (trade.sl != null ? fmtPct(trade.sl) : '—')}
                ${stop ? `<br><span style="font-size:12px;color:var(--text3);font-weight:400">${trade.sl}%</span>` : ''}
              </div>
            </div>
          </div>` : `
          <div style="padding:6px 10px;background:var(--bg3);border-radius:8px;font-size:13px;color:var(--text3);text-align:center">
            ⚠️ 구버전 분석 — 정밀 매매 정보 없음 (재분석 필요)
          </div>`;

        return `
        <a href="${issueLink}" style="text-decoration:none;color:inherit">
          <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:16px;transition:all .15s;height:100%;display:flex;flex-direction:column;gap:10px"
               onmouseover="this.style.borderColor='var(--blue)';this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 24px rgba(47,129,247,.15)'"
               onmouseout="this.style.borderColor='var(--border)';this.style.transform='none';this.style.boxShadow='none'">

            <!-- 헤더: 순위 + 티커 + 신호 -->
            <div style="display:flex;align-items:center;gap:10px">
              <span style="font-size:24px;font-weight:800;color:var(--text3);min-width:28px">${i+1}</span>
              <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;flex-wrap:wrap">
                  <span style="font-family:var(--font-mono,'SF Mono',monospace);font-size:14.5px;font-weight:700;color:${isKr?'#4d8dff':'#9d7bff'};background:${isKr?'rgba(0,102,204,0.10)':'rgba(124,58,237,0.10)'};padding:2px 8px;border-radius:5px">${escHtml(s.ticker)}</span>
                  <span style="font-size:17px;font-weight:700">${escHtml(s.name)}</span>
                </div>
                <div style="display:flex;gap:8px;font-size:13px;align-items:center;flex-wrap:wrap">
                  <span style="color:${accColor};font-weight:600">${accLabel}</span>
                  <span style="color:var(--text3)">·</span>
                  <span style="color:var(--text3)">신뢰 ${s.avgConf}%</span>
                  ${trade?.tf ? `<span style="color:var(--text3)">·</span><span style="color:var(--blue);font-weight:600">${tfLabel[trade.tf] || trade.tf}</span>` : ''}
                  ${s.themeLabel ? `<span title="현재 시장 뉴스에서 자동 추출된 전략적 투자 노출 (+${s.themeScore}점)" style="padding:1px 7px;border-radius:999px;font-weight:700;background:linear-gradient(135deg,rgba(163,113,247,.18),rgba(47,129,247,.18));color:#a371f7">🚀 ${escHtml(s.themeLabel)}</span>` : ''}
                </div>
              </div>
              <span style="font-size:13px;font-weight:800;padding:5px 10px;border-radius:6px;color:${signal.color};background:${signal.bg};white-space:nowrap">${signal.label}</span>
            </div>

            <!-- 실시간 시세 -->
            <div class="ins-quote" data-quote-ticker="${escHtml(s.ticker)}" style="display:flex;flex-direction:column;gap:4px;padding:8px 12px;background:var(--bg3);border-radius:10px;font-family:var(--font-mono,'SF Mono',monospace)">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                <span style="font-size:13px;color:var(--text3);font-family:inherit;display:inline-flex;align-items:center;flex-shrink:0"><span class="live-pulse-dot"></span><span class="live-state-label">LIVE</span></span>
                <span class="ins-q-price" style="font-size:17px;font-weight:700;color:var(--text2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:right">—</span>
                <span class="ins-q-chg" style="font-size:15.5px;font-weight:700;color:var(--text3);min-width:64px;text-align:right;flex-shrink:0">—</span>
              </div>
              <div class="ins-q-ah" style="display:none;align-items:center;justify-content:space-between;gap:8px;padding-top:4px;border-top:1px dashed var(--border)">
                <span class="ins-q-ah-label" style="font-size:12px;font-weight:700;padding:2px 6px;border-radius:4px;background:var(--purple-dim);color:var(--purple);font-family:inherit"></span>
                <span class="ins-q-ah-price" style="font-size:15.5px;font-weight:600;color:var(--text2)"></span>
                <span class="ins-q-ah-chg" style="font-size:14.5px;font-weight:700;min-width:64px;text-align:right"></span>
              </div>
            </div>

            <!-- 기술 시그널 chips (technicals 로드되면 채워짐) -->
            <div class="ins-tech" data-tech-ticker="${escHtml(s.ticker)}" style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;min-height:20px;font-size:13px">
              <span style="color:var(--text3)">기술 지표 로딩...</span>
            </div>

            <!-- 수급 chips (외인/기관 최근 5거래일 누적 순매수 — KR만) -->
            ${s.factorFlow ? (() => {
              const f = s.factorFlow;
              const fmtSh = v => {
                const a = Math.abs(v);
                const sign = v > 0 ? '+' : v < 0 ? '-' : '';
                return sign + (a >= 1e8 ? (a/1e8).toFixed(1) + '억' : a >= 1e4 ? Math.round(a/1e4).toLocaleString() + '만' : a.toLocaleString()) + '주';
              };
              const c = v => v > 0 ? 'var(--red)' : v < 0 ? 'var(--blue)' : 'var(--text3)';
              const fchip = 'padding:2px 7px;border-radius:4px;font-weight:600;background:var(--bg3)';
              return `<div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;font-size:13px" title="최근 5거래일 누적 순매수 · 점수 반영 ${(s.flowAdj || 0) >= 0 ? '+' : ''}${s.flowAdj || 0}점">
                <span style="color:var(--text3);font-weight:700">수급</span>
                <span style="${fchip};color:${c(f.foreign5d)}">외인 ${fmtSh(f.foreign5d)}</span>
                <span style="${fchip};color:${c(f.inst5d)}">기관 ${fmtSh(f.inst5d)}</span>
                ${f.foreignStreak >= 3 ? `<span style="${fchip};color:var(--red)">🔥 외인 ${f.foreignStreak}일 연속 매수</span>`
                  : f.foreignStreak <= -3 ? `<span style="${fchip};color:var(--blue)">⚠️ 외인 ${-f.foreignStreak}일 연속 매도</span>` : ''}
                ${f.smartRatio != null && Math.abs(f.smartRatio) >= 5 ? `<span style="${fchip};color:${c(f.smartRatio)}">강도 ${f.smartRatio > 0 ? '+' : ''}${f.smartRatio}%</span>` : ''}
              </div>`;
            })() : ''}

            <!-- 펀더멘털 chips (분석 시점 임베드된 데이터) -->
            ${fund ? (() => {
              const fchip = 'padding:2px 7px;border-radius:4px;font-weight:600;background:var(--bg3)';
              const chips = [];
              if (fund.pe  != null) chips.push(`<span style="${fchip};color:${fund.pe  < 20 ? 'var(--green)' : fund.pe  < 40 ? 'var(--text2)' : 'var(--yellow)'}">PER ${fund.pe.toFixed(1)}</span>`);
              if (fund.pb  != null) chips.push(`<span style="${fchip};color:${fund.pb  < 1.5 ? 'var(--green)' : fund.pb  < 4 ? 'var(--text2)' : 'var(--yellow)'}">PBR ${fund.pb.toFixed(1)}</span>`);
              if (fund.roe != null) chips.push(`<span style="${fchip};color:${fund.roe > 15 ? 'var(--green)' : fund.roe > 5 ? 'var(--text2)' : 'var(--red)'}">ROE ${fund.roe.toFixed(0)}%</span>`);
              if (fund.opm != null) chips.push(`<span style="${fchip};color:${fund.opm > 15 ? 'var(--green)' : fund.opm > 5 ? 'var(--text2)' : 'var(--red)'}">영업이익률 ${fund.opm.toFixed(0)}%</span>`);
              if (fund.de  != null) chips.push(`<span style="${fchip};color:${fund.de  < 1 ? 'var(--green)' : fund.de  < 2 ? 'var(--text2)' : 'var(--red)'}">D/E ${fund.de.toFixed(1)}</span>`);
              if (fund.rev_yoy != null) chips.push(`<span style="${fchip};color:${fund.rev_yoy > 10 ? 'var(--red)' : fund.rev_yoy > 0 ? 'var(--text2)' : 'var(--blue)'}">매출 YoY ${fund.rev_yoy > 0 ? '+' : ''}${fund.rev_yoy.toFixed(0)}%</span>`);
              return `<div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;font-size:13px">${chips.join('')}</div>`;
            })() : ''}

            <!-- 매매 가격대 (현재가 ± %) -->
            ${tradeBox}

            <!-- 핵심 thesis & risk -->
            ${trade?.th || trade?.rk ? `
              <div style="display:flex;flex-direction:column;gap:5px;font-size:13.5px;line-height:1.45">
                ${trade.th ? `<div><span style="color:var(--green);font-weight:700">💡</span> <span style="color:var(--text2)">${escHtml(trade.th)}</span></div>` : ''}
                ${trade.rk ? `<div><span style="color:var(--yellow);font-weight:700">⚠️</span> <span style="color:var(--text3)">${escHtml(trade.rk)}</span></div>` : ''}
              </div>
            ` : (parsed.reason ? `<div style="font-size:13.5px;color:var(--text2);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${escHtml(parsed.reason.slice(0, 140))}</div>` : '')}

            <!-- 하단: 분석 빈도 + 스코어 바 -->
            <div style="display:flex;align-items:center;gap:8px;margin-top:auto;font-size:13px;color:var(--text3)">
              <span>최근 ${s.predCount}건 분석</span>
              <span>·</span>
              <span title="보정 내역 — 모멘텀 ${(s.momentumAdj||0) >= 0 ? '+' : ''}${s.momentumAdj||0} · 수급 ${(s.flowAdj||0) >= 0 ? '+' : ''}${s.flowAdj||0} · 펀더멘털 ${(s.fundAdj||0) >= 0 ? '+' : ''}${s.fundAdj||0}">점수 ${s.score}</span>
              <div style="flex:1;height:3px;background:var(--bg3);border-radius:2px;overflow:hidden;margin-left:6px">
                <div style="height:100%;width:${Math.min(s.score,100)}%;background:linear-gradient(90deg,#2f81f7,#a371f7)"></div>
              </div>
            </div>
          </div>
        </a>`;
      }).join('') + `</div>` + (showMoreLink ? `</div>` : '') +
      (showMoreLink && filteredPool.length > maxCards
        ? `<div style="text-align:center;margin-top:14px"><a href="/picks.html" style="display:inline-block;padding:10px 20px;border-radius:10px;background:var(--bg2);border:1px solid var(--border);color:var(--blue);font-weight:700;font-size:15.5px;text-decoration:none">전체 매수 후보 ${filteredPool.length}개 보기 →</a></div>`
        : '');

    // 카드 높이는 사유/경고 문구 길이에 따라 들쭉날쭉하므로, 고정 px 크롭 대신
    // 실제 렌더된 마지막 "정식" 카드의 하단 위치를 측정해 딱 그 지점 + 고정
    // 피크(next row 살짝 보이는 정도)만큼만 잘라 히트맵과 동일한 미리보기 느낌을 낸다.
    if (showMoreLink) {
      const wrap = document.getElementById('insightsCropWrap');
      const grid = wrap?.firstElementChild;
      if (wrap && grid && grid.children.length > maxCards) {
        const wrapTop = wrap.getBoundingClientRect().top;
        const cutoff = grid.children[maxCards - 1].getBoundingClientRect().bottom - wrapTop + 72;
        wrap.style.maxHeight = cutoff + 'px';
      }
    }

    // 실시간 시세 즉시 로드 + 기술 지표 chip 채우기 (반드시 카드가 DOM에 렌더된 뒤에 호출 —
    // 미리 호출하면 _techCache가 이미 캐시돼 있을 때 동기적으로 끝나버려 새 카드가 생기기 전에
    // querySelectorAll이 아무것도 못 찾고 끝나는 경합 문제가 있었음)
    refreshInsightQuotes();
    fetchTechnicalsForCards(tickers);
  } catch(e) {
    console.warn('loadInsights error:', e.message);
    sec.style.display = 'none';
  }
}

// 인사이트 카드에 기술 지표 chip 채우기
const _techCache = {};
async function fetchTechnicalsForCards(tickers) {
  if (!tickers?.length) return;
  // 캐시 활용 — 5분 이내면 재요청 안 함
  const need = tickers.filter(t => !_techCache[t] || (Date.now() - _techCache[t]._ts > 300000));
  if (need.length) {
    try {
      const r = await fetch(`/api/technicals?tickers=${need.map(encodeURIComponent).join(',')}`);
      if (r.ok) {
        const j = await r.json();
        if (j?.data) {
          for (const [t, info] of Object.entries(j.data)) {
            if (info) _techCache[t] = { ...info, _ts: Date.now() };
          }
        }
      }
    } catch {}
  }

  // 시그널 라벨/색상 매핑
  const sigMap = {
    strong_bullish: { label: '🔴 강세 추세',  color: 'var(--red)',  bg: 'rgba(248,81,73,.15)' },
    bullish:        { label: '🔴 상승',      color: 'var(--red)',  bg: 'rgba(248,81,73,.1)'  },
    oversold_bull:  { label: '🔴 과매도(매수기회)', color: 'var(--red)',  bg: 'rgba(248,81,73,.2)' },
    neutral:        { label: '⚪ 중립',      color: 'var(--text2)',  bg: 'var(--bg3)' },
    overbought:     { label: '🟡 과매수',    color: 'var(--yellow)', bg: 'rgba(210,153,34,.15)' },
    oversold:       { label: '🟠 과매도',    color: 'var(--yellow)', bg: 'rgba(210,153,34,.15)' },
    bearish:        { label: '🔵 하락',      color: 'var(--blue)',    bg: 'rgba(77,141,255,.1)' },
    strong_bearish: { label: '🔵 약세 추세', color: 'var(--blue)',    bg: 'rgba(77,141,255,.15)' },
  };

  document.querySelectorAll('.ins-tech[data-tech-ticker]').forEach(node => {
    const t = node.dataset.techTicker;
    const info = _techCache[t];
    if (!info) {
      node.innerHTML = '<span style="color:var(--text3)">기술 지표 데이터 없음</span>';
      return;
    }
    const sig = sigMap[info.signal] || sigMap.neutral;
    const chipStyle = 'padding:2px 7px;border-radius:4px;font-weight:600;display:inline-flex;align-items:center;gap:3px';
    const chips = [];

    // 메인 시그널
    chips.push(`<span style="${chipStyle};background:${sig.bg};color:${sig.color}">${sig.label}</span>`);

    // RSI
    if (info.rsi14 != null) {
      const rsiColor = info.rsi14 >= 70 ? 'var(--yellow)' : info.rsi14 <= 30 ? 'var(--yellow)' : 'var(--text2)';
      chips.push(`<span style="${chipStyle};background:var(--bg3);color:${rsiColor}">RSI ${info.rsi14}</span>`);
    }

    // 주요 MA 대비 (200일 또는 50일)
    if (info.vsSma200 != null) {
      const c = info.vsSma200 > 0 ? 'var(--red)' : 'var(--blue)';
      const sign = info.vsSma200 > 0 ? '+' : '';
      chips.push(`<span style="${chipStyle};background:var(--bg3);color:${c}">200일 ${sign}${info.vsSma200}%</span>`);
    } else if (info.vsSma50 != null) {
      const c = info.vsSma50 > 0 ? 'var(--red)' : 'var(--blue)';
      const sign = info.vsSma50 > 0 ? '+' : '';
      chips.push(`<span style="${chipStyle};background:var(--bg3);color:${c}">50일 ${sign}${info.vsSma50}%</span>`);
    }

    node.innerHTML = chips.join('');
  });
}

// 직전 시세 캐시 (티커별)
const _lastQuoteCache = {};

// 인사이트 카드 실시간 시세 갱신 (1초마다)
let _refreshInFlight = false;
async function refreshInsightQuotes() {
  if (_refreshInFlight) return;        // 중복 호출 방지
  const nodes = document.querySelectorAll('.ins-quote[data-quote-ticker]');
  if (!nodes.length) return;
  const tickers = [...new Set([...nodes].map(n => n.dataset.quoteTicker))];
  if (!tickers.length) return;

  _refreshInFlight = true;
  try {
    const r = await fetch(`/api/quotes?tickers=${tickers.map(encodeURIComponent).join(',')}`);
    if (!r.ok) return;
    const j = await r.json();
    if (!j.ok || !j.data) return;

    // 마켓 상태별 라벨/색상
    const stateMap = {
      REGULAR:  { label: 'LIVE',   color: 'var(--green)',  pulse: true  },
      PRE:      { label: '장전',   color: 'var(--yellow)', pulse: false },
      PREPRE:   { label: '장전',   color: 'var(--yellow)', pulse: false },
      POST:     { label: '시간외', color: 'var(--yellow)', pulse: false },
      POSTPOST: { label: '시간외', color: 'var(--yellow)', pulse: false },
      CLOSED:   { label: '마감',   color: 'var(--text3)',  pulse: false },
    };

    nodes.forEach(node => {
      const t = node.dataset.quoteTicker;
      const q = j.data[t];
      const priceEl = node.querySelector('.ins-q-price');
      const chgEl   = node.querySelector('.ins-q-chg');
      const dotEl   = node.querySelector('.live-pulse-dot');
      const labelEl = node.querySelector('.live-state-label');

      // 마켓 상태 적용
      const state = stateMap[q?.marketState] || stateMap.CLOSED;
      if (dotEl)   { dotEl.style.background = state.color; dotEl.style.animation = state.pulse ? 'livePulse 1s infinite' : 'none'; }
      if (labelEl) { labelEl.textContent    = state.label; }

      if (!q || q.price == null) {
        if (priceEl) priceEl.textContent = '시세 없음';
        if (chgEl)   { chgEl.textContent = '—'; chgEl.style.color = 'var(--text3)'; }
        return;
      }

      // 이전 값과 비교 (장 마감 후엔 변동 없음 → flash 안 함)
      const prev = _lastQuoteCache[t];
      const direction = state.pulse && prev?.price != null && q.price !== prev.price
        ? (q.price > prev.price ? 'up' : 'down')
        : null;
      _lastQuoteCache[t] = { price: q.price, changePercent: q.changePercent };

      // 포맷
      const cur = q.currency === 'KRW' ? '₩' : '$';
      const priceFmt = v => cur + Number(v).toLocaleString(q.currency === 'KRW' ? 'ko-KR' : 'en-US',
        { maximumFractionDigits: q.currency === 'KRW' ? 0 : 2 });
      const cp = q.changePercent;
      const sign = cp != null && cp > 0 ? '+' : '';
      const chgStr = cp != null ? `${sign}${cp.toFixed(2)}%` : '—';
      const chgColor = cp == null ? 'var(--text3)' : cp > 0 ? 'var(--red)' : cp < 0 ? 'var(--blue)' : 'var(--text2)';

      if (priceEl) { priceEl.style.color = 'var(--text)'; animateNumberText(priceEl, q.price, priceFmt, ['flash-up', 'flash-down']); }
      if (chgEl)   { chgEl.textContent = chgStr; chgEl.style.color = chgColor; }

      // 시간외(프리/애프터) 호가 — 미장만 (Yahoo는 한국 NXT 미지원)
      const ahRow = node.querySelector('.ins-q-ah');
      if (ahRow) {
        let ahLabel = '', ahPrice = null, ahPct = null, ahCls = '';
        if (q.postMarketPrice != null && q.postMarketChangePercent != null) {
          ahLabel = '애프터'; ahPrice = q.postMarketPrice; ahPct = q.postMarketChangePercent; ahCls = 'ah-post';
        } else if (q.preMarketPrice != null && q.preMarketChangePercent != null) {
          ahLabel = '프리장'; ahPrice = q.preMarketPrice; ahPct = q.preMarketChangePercent; ahCls = 'ah-pre';
        }
        if (ahPrice != null) {
          ahRow.style.display = 'flex';
          const ahLabelEl = ahRow.querySelector('.ins-q-ah-label');
          const ahPriceEl = ahRow.querySelector('.ins-q-ah-price');
          const ahChgEl   = ahRow.querySelector('.ins-q-ah-chg');
          if (ahLabelEl) {
            ahLabelEl.textContent = ahLabel;
            // 프리/애프터 색상 구분
            if (ahCls === 'ah-pre') {
              ahLabelEl.style.background = 'var(--yellow-dim)';
              ahLabelEl.style.color = 'var(--yellow)';
            } else {
              ahLabelEl.style.background = 'var(--purple-dim)';
              ahLabelEl.style.color = 'var(--purple)';
            }
          }
          const ahCur = q.currency === 'KRW' ? '₩' : '$';
          const ahPriceStr = ahCur + Number(ahPrice).toLocaleString(q.currency === 'KRW' ? 'ko-KR' : 'en-US',
            { maximumFractionDigits: q.currency === 'KRW' ? 0 : 2 });
          const ahSign = ahPct > 0 ? '+' : '';
          if (ahPriceEl) ahPriceEl.textContent = ahPriceStr;
          if (ahChgEl) {
            ahChgEl.textContent = `${ahSign}${ahPct.toFixed(2)}%`;
            ahChgEl.style.color = ahPct > 0 ? 'var(--red)' : ahPct < 0 ? 'var(--blue)' : 'var(--text2)';
          }
        } else {
          ahRow.style.display = 'none';
        }
      }

      // 시세가 변동했을 때만 배경 pulse 효과 (가격 숫자 자체의 flash는 animateNumberText가
      // 카운트업/다운 애니메이션이 끝나는 시점에 맞춰 별도로 트리거함)
      if (direction) {
        const upCls = direction === 'up' ? 'tick-up' : 'tick-down';
        node.classList.remove('tick-up', 'tick-down');
        void node.offsetWidth;  // force reflow
        node.classList.add(upCls);
        setTimeout(() => node.classList.remove(upCls), 1000);
      }
    });
  } catch(e) {
    // 폴링 에러는 조용히 무시
  } finally {
    _refreshInFlight = false;
  }
}

// ── 예측 적중 상위 종목 ─────────────────────────────────────────────
let _topStocksData = null;   // { rows, period, minAbs }
let _topStocksMkt = 'ALL';

async function loadTopStocks() {
  const el = document.getElementById('topStocksPanel');
  if (!el) return;

  try {
    // 7일 체크된 예측 전체 조회 (방향+최소1.5% 기준)
    const { data, error } = await sb
      .from('analysis_companies')
      .select('upside_pct, is_accurate_7d, actual_return_7d, companies(ticker, name_ko, market)')
      .not('is_accurate_7d', 'is', null);

    if (error || !data?.length) {
      // 7d 없으면 1d로 폴백
      const { data: d1 } = await sb
        .from('analysis_companies')
        .select('upside_pct, is_accurate_1d, actual_return_1d, companies(ticker, name_ko, market)')
        .not('is_accurate_1d', 'is', null);
      _topStocksData = { rows: d1 || [], period: '1d', minAbs: 0.3 };
    } else {
      _topStocksData = { rows: data, period: '7d', minAbs: 1.5 };
    }
    const pl = document.getElementById('topStocksPeriod');
    if (pl) pl.textContent = _topStocksData.period === '7d' ? '7일 기준' : '1일 기준';
    renderTopStocks(el);
  } catch(e) {
    el.innerHTML = '<div style="color:var(--text3);font-size:14.5px;text-align:center;padding:8px 0">데이터 없음</div>';
  }
}

function switchTopStocksMkt(mkt) {
  _topStocksMkt = mkt;
  document.querySelectorAll('.acc-tab[data-mkt]').forEach(b => b.classList.toggle('active', b.dataset.mkt === mkt));
  const el = document.getElementById('topStocksPanel');
  if (el && _topStocksData) renderTopStocks(el);
}

// Wilson 신뢰하한 — 2/2=100%가 9/10=90%를 이기지 않도록 표본 수를 반영한 랭킹 점수
function wilsonLB(hits, total) {
  if (!total) return 0;
  const z = 1.96, p = hits / total;
  return (p + z*z/(2*total) - z * Math.sqrt((p*(1-p) + z*z/(4*total)) / total)) / (1 + z*z/total);
}

function renderTopStocks(el) {
  const { rows, period, minAbs } = _topStocksData;
  const map = {};
  for (const row of rows) {
    const t = row.companies?.ticker;
    if (!t) continue;
    if (_topStocksMkt !== 'ALL' && (row.companies.market || 'US') !== _topStocksMkt) continue;
    const accKey  = `is_accurate_${period}`;
    const retKey  = `actual_return_${period}`;
    if (!map[t]) map[t] = { ticker: t, name: row.companies.name_ko || t, market: row.companies.market || 'US', total: 0, hits: 0, upsides: [], actuals: [] };
    map[t].total++;
    const ret = row[retKey] ?? 0;
    const dirOk = row[accKey] === true;
    const magOk = Math.abs(ret) >= minAbs;
    if (dirOk && magOk) map[t].hits++;
    if (row.upside_pct != null) map[t].upsides.push(row.upside_pct);
    if (ret != null) map[t].actuals.push(ret);
  }

  const stocks = Object.values(map)
    .filter(s => s.total >= 2 && s.hits > 0)
    .map(s => ({
      ...s,
      rate:      Math.round(s.hits / s.total * 100),
      score:     wilsonLB(s.hits, s.total),
      avgUpside: s.upsides.length ? Math.round(s.upsides.reduce((a,b)=>a+b,0)/s.upsides.length) : 0,
      avgActual: s.actuals.length ? Math.round(s.actuals.reduce((a,b)=>a+b,0)/s.actuals.length * 10)/10 : null,
    }))
    .sort((a, b) => b.score - a.score || (b.avgActual ?? 0) - (a.avgActual ?? 0))
    .slice(0, 8);

  if (!stocks.length) {
    el.innerHTML = '<div style="color:var(--text3);font-size:14.5px;text-align:center;padding:8px 0">집계 데이터 부족</div>';
    return;
  }

  const periodLabel = period === '7d' ? '7일' : '1일';
  const maxScore = Math.max(...stocks.map(s => s.score), 0.01);
  el.innerHTML = stocks.map((s, i) => {
    const rateColor = s.rate >= 70 ? 'var(--green)' : s.rate >= 50 ? 'var(--yellow)' : 'var(--text3)';
    const mktFlag   = s.market === 'KR' ? '🇰🇷' : '🇺🇸';
    const upSign    = s.avgActual != null ? (s.avgActual >= 0 ? '+' : '') : '';
    const confPct   = Math.round(s.score / maxScore * 100);
    return `
    <div onclick="location.href='/company.html?ticker=${encodeURIComponent(s.ticker)}'" style="display:flex;align-items:center;gap:8px;padding:7px 0;cursor:pointer;${i < stocks.length-1 ? 'border-bottom:1px solid var(--border)' : ''}" title="클릭하면 종목 상세로 이동">
      <span style="font-size:13.5px;color:var(--text3);width:14px;text-align:right">${i+1}</span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:5px">
          <span style="font-family:'SF Mono',monospace;font-size:14.5px;font-weight:700;color:var(--text1)">${escHtml(s.ticker)}</span>
          <span style="font-size:13px">${mktFlag}</span>
        </div>
        <div style="font-size:13px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(s.name)}</div>
        <div style="display:flex;align-items:center;gap:5px;margin-top:3px">
          <div style="flex:1;max-width:80px;height:3px;background:var(--bg3);border-radius:2px;overflow:hidden">
            <div style="height:100%;width:${confPct}%;background:${rateColor};border-radius:2px"></div>
          </div>
          <span style="font-size:12.5px;color:var(--text3)">신뢰도</span>
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:15.5px;font-weight:700;color:${rateColor}">${s.rate}%</div>
        <div style="font-size:13px;color:var(--text3)">적중 ${s.hits}/${s.total}건</div>
        ${s.avgActual != null ? `<div style="font-size:13px;color:${s.avgActual >= 0 ? 'var(--red)' : 'var(--blue)'}">${periodLabel} ${upSign}${s.avgActual}%</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

// BMO/AMC(장전/장후)만 봐서는 한국시간으로 언제인지 감이 안 온다는 피드백(2026-07-28) —
// 개장 09:30 ET(BMO 기준) / 마감 16:00 ET(AMC 기준)를 그 미국 거래일의 실제 한국시간
// 일시로 환산해 같이 보여준다. DST로 ET-UTC 오프셋이 EDT(-4)/EST(-5)로 바뀌므로 매번
// 그 날짜 기준으로 판정 — 하드코딩 +13/+14시간을 쓰면 3~11월/11~3월 경계에서 1시간씩
// 어긋난다. AMC는 마감 후라 한국시간으로는 대부분 다음날 새벽으로 날짜가 넘어간다.
function _etOffsetHours(dateStr) {
  const probe = new Date(`${dateStr}T16:00:00Z`);
  const tz = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' })
    .formatToParts(probe).find(p => p.type === 'timeZoneName')?.value || '';
  return tz.includes('EDT') ? 4 : 5;
}
function earningsCallTimeToKst(dateStr, callTime) {
  if (!dateStr || !callTime) return null;
  const etHour = callTime === 'BMO' ? 9 : 16;
  const etMin  = callTime === 'BMO' ? 30 : 0;
  const offset = _etOffsetHours(dateStr);
  const utcMs = new Date(`${dateStr}T${String(etHour).padStart(2, '0')}:${String(etMin).padStart(2, '0')}:00Z`).getTime() + offset * 3600000;
  const kst = new Date(utcMs);
  const full = kst.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const hm = kst.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
  const kstDateStr = kst.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }); // YYYY-MM-DD, 날짜이월 판정용
  const rolledToNextDay = kstDateStr > dateStr;
  return {
    full,        // "7월 28일 화 05:00" — 전체 표기용
    hm,          // "05:00" — 좁은 칸용
    rolledToNextDay,
    whenLabel: callTime === 'BMO' ? '개장 전' : '마감 후',
  };
}

// 실적발표 캘린더 (강화: 위스퍼·IV·매출 포함)
// 20개 고정 워치리스트(FMP, /api/earnings)가 아니라 시총 $10B+ 미국 대형주 전체를
// 날짜별로 훑는 캘린더(/api/earnings-calendar, Nasdaq 공개 API) — 실적 시즌에 워치리스트
// 밖 대형주가 많아도 다 보이게 하려고 2026-07-27 교체. days[].items[]를 기존 렌더링
// 함수들이 기대하는 flat {ticker,company,date,callTime,...} 모양으로 펴서 반환한다.
let _earnCalFlatCache = null;
async function fetchEarningsCalendarFlat() {
  if (_earnCalFlatCache) return _earnCalFlatCache;
  try {
    const r = await fetch('/api/earnings-calendar');
    if (!r.ok) return (_earnCalFlatCache = []);
    const j = await r.json();
    if (!j.ok || !j.days?.length) return (_earnCalFlatCache = []);
    return (_earnCalFlatCache = j.days.flatMap(day => day.items.map(it => ({
      ticker: it.symbol, company: it.name, date: day.date,
      callTime: it.time, epsConsensus: it.epsForecast, marketCap: it.marketCap,
    }))));
  } catch { return (_earnCalFlatCache = []); }
}

async function loadEarningsCalendar() {
  const el = document.getElementById('earningsCalendar');
  if (!el) return;

  const apiItems = await fetchEarningsCalendarFlat();

  const today = new Date().toISOString().split('T')[0];

  const fmtNum = (v, digits = 2) => v != null ? `$${Number(v).toFixed(digits)}` : null;
  const fmtRev = (v) => {
    if (v == null) return null;
    if (v >= 1e12) return `$${(v/1e12).toFixed(2)}T`;
    if (v >= 1e9)  return `$${(v/1e9).toFixed(1)}B`;
    if (v >= 1e6)  return `$${(v/1e6).toFixed(0)}M`;
    return `$${Number(v).toFixed(0)}`;
  };
  const recLabel = (key) => {
    const m = { strong_buy:'강매수', buy:'매수', hold:'중립', sell:'매도', strong_sell:'강매도' };
    return m[key] || '';
  };
  const recColor = (key) => {
    if (!key) return '';
    if (key.includes('buy'))  return 'color:#4ade80';
    if (key === 'hold')       return 'color:#facc15';
    return 'color:#f87171';
  };

  // "실적" 서브탭이 사이드바 안에 숨어 있어 실적 시즌에도 존재를 못 알아채는 문제가
  // 있었다 — 탭에 건수 배지를 달아 클릭 전에도 물량이 보이게 한다.
  const pill = document.getElementById('earnCountPill');
  if (pill) {
    if (apiItems.length) { pill.textContent = apiItems.length; pill.style.display = 'inline-block'; }
    else pill.style.display = 'none';
  }

  if (!apiItems.length) {
    el.innerHTML = `<div style="color:var(--text3);font-size:14.5px;text-align:center;padding:16px 0">이번 주 실적발표 없음</div>`;
    return;
  }

  // 사이드바 미리보기는 최대 EARNINGS_SIDEBAR_LIMIT건만 — 전체는 "전체보기"(캘린더 모달)에서
  const EARNINGS_SIDEBAR_LIMIT = 5;
  const shownItems = apiItems.slice(0, EARNINGS_SIDEBAR_LIMIT);
  const hiddenCount = apiItems.length - shownItems.length;

  // 적응적 렌더링: 데이터 있는 필드만 표시
  const html = shownItems.map(item => {
    const isToday  = item.date === today;
    const isFuture = item.date && item.date > today;
    const isPast   = item.date && item.date < today;

    // BMO/AMC 문구만으로는 한국시간으로 언제인지 알기 어렵다는 피드백 — 뱃지엔 KST
    // 시각을, 날짜줄엔 "개장전/마감후 + 한국시간 전체 일시"를 같이 붙인다.
    const kstInfo = earningsCallTimeToKst(item.date, item.callTime);
    const timingClass = item.callTime === 'BMO' ? 'bmo' : item.callTime === 'AMC' ? 'amc' : '';
    const timingLabel = kstInfo ? `KST ${kstInfo.hm}${kstInfo.rolledToNextDay ? '(익일)' : ''}` : '';
    const kstLine = kstInfo
      ? `<span style="color:var(--text3);font-size:12.5px"> · ${kstInfo.whenLabel} 한국시간 ${kstInfo.full}</span>`
      : '';

    // 날짜 (D-day 포함, Nasdaq 알고리즘 추정일이면 "예상" 표기)
    const dday = item.date ? Math.round((new Date(item.date) - new Date(today)) / 86400000) : null;
    const estTag = item.dateEstimated ? '<span style="color:var(--text3);font-size:13px"> · 예상일</span>' : '';
    const dateLabel = !item.date
      ? `<span style="color:var(--text3);font-size:13.5px">다음 분기 발표 예정</span>`
      : isToday
        ? `<span class="ei-today">🔴 오늘 실적발표</span>${kstLine}`
        : isFuture
          ? `<span style="color:var(--blue)">📅 ${item.date} <b>D-${dday}</b></span>${estTag}${kstLine}`
          : `<span style="color:var(--text2)">📊 ${item.date} 발표</span>${kstLine}`;

    // EPS 메트릭 (있을 때만)
    const consensus = item.epsConsensus ?? item.epsEstimate ?? null;
    const metrics = [];

    // EPS 결과/컨센서스
    if (isPast && item.epsActual != null) {
      const ref = item.epsEstimate ?? item.epsConsensus;
      if (ref != null) {
        const beat = item.epsActual >= ref;
        metrics.push({
          label: beat ? 'EPS ▲ 서프라이즈' : 'EPS ▼ 쇼크',
          val:   `${fmtNum(item.epsActual)} (예상 ${fmtNum(ref)})`,
          cls:   beat ? 'beat' : 'miss',
        });
      } else {
        metrics.push({ label: '발표 EPS', val: fmtNum(item.epsActual) || '—' });
      }
    } else if (consensus != null) {
      metrics.push({ label: 'EPS 컨센서스', val: fmtNum(consensus) });
    }

    // 위스퍼 (값 있을 때만)
    if (item.whisper != null && item.whisper !== consensus) {
      metrics.push({ label: '위스퍼', val: fmtNum(item.whisper), cls: 'whisper' });
    }

    // IV
    if (item.iv != null) {
      metrics.push({ label: '내재변동성', val: `${item.iv.toFixed(1)}%`, cls: 'iv' });
    }

    // 매출 예상
    if (item.revEstimate != null) {
      metrics.push({ label: '매출 예상', val: fmtRev(item.revEstimate), cls: 'rev' });
    }

    // YoY 성장률
    const growthStr = item.epsGrowth != null
      ? `<div class="ei-growth" style="${item.epsGrowth >= 0 ? 'color:var(--red)' : 'color:var(--blue)'};font-size:13px">`
        + `${item.epsGrowth >= 0 ? '▲' : '▼'} YoY ${Math.abs(item.epsGrowth * 100).toFixed(1)}%</div>`
      : '';

    // 현재가 + 변동률 (chartMeta가 응답에 포함되지 않으니 priceTarget 만 표시)
    const ptStr = item.priceTarget
      ? `<span style="font-size:13.5px;color:var(--text3)">목표 ${fmtNum(item.priceTarget)}</span>`
      : '';
    const recStr = item.recKey
      ? `<span style="font-size:13.5px;font-weight:700;${recColor(item.recKey)}">${recLabel(item.recKey)}</span>`
      : '';
    const cpStr = item.currentPrice
      ? `<span style="font-size:13.5px;color:var(--text2);font-family:'SF Mono',monospace">${fmtNum(item.currentPrice)}</span>`
      : '';

    // 메트릭 그리드 (있을 때만)
    const metricsHtml = metrics.length
      ? `<div class="ei-metrics" style="grid-template-columns:repeat(${Math.min(metrics.length, 2)}, 1fr)">
          ${metrics.map(m => `
            <div class="ei-metric">
              <div class="ei-metric-label">${m.label}</div>
              <div class="ei-metric-val ${m.cls||''}">${m.val}</div>
              ${m === metrics[0] ? growthStr : ''}
            </div>`).join('')}
        </div>`
      : '';

    return `<div class="earnings-item">
      <div class="earnings-header">
        <span class="earnings-ticker">${escHtml(item.ticker||'')}</span>
        <span class="earnings-company">${escHtml(item.company||item.ticker||'')}</span>
        ${timingClass ? `<span class="ei-timing-${timingClass}">${timingLabel}</span>` : ''}
      </div>
      <div class="ei-date-row" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
        <span>${dateLabel}</span>
        <span style="display:flex;gap:8px;align-items:center">${cpStr}${recStr}${ptStr}</span>
      </div>
      ${metricsHtml}
    </div>`;
  }).join('');

  el.innerHTML = html + (hiddenCount > 0
    ? `<div onclick="openCalendarModal('earnings')" style="text-align:center;padding:8px 0 2px;font-size:14px;font-weight:700;color:var(--blue);cursor:pointer">+${hiddenCount}건 더 보기 → 캘린더 전체보기</div>`
    : '');
}

// 투자의견 (애널리스트 레이팅)
async function loadAnalystRatings() {
  const el = document.getElementById('analystRatings');
  if (!el) return;

  let items = [];
  try {
    const r = await fetch('/api/earnings?type=analyst');
    if (r.ok) { const j = await r.json(); if (j.ok && j.items?.length) items = j.items; }
  } catch {}

  if (!items.length) {
    el.innerHTML = `<div style="color:var(--text3);font-size:14.5px;text-align:center;padding:16px 0">데이터 없음</div>`;
    return;
  }

  const consensusClass = (key) => {
    const m = { strong_buy:'ac-strong-buy', buy:'ac-buy', hold:'ac-hold', sell:'ac-sell', strong_sell:'ac-strong-sell' };
    return m[key] || 'ac-hold';
  };
  const consensusLabel = (key) => {
    const m = { strong_buy:'강매수', buy:'매수', hold:'중립', sell:'매도', strong_sell:'강매도' };
    return m[key] || '—';
  };
  const actionIcon = (action) => {
    if (action === 'up' || action === 'upgrade') return `<span class="aa-icon-up">↑</span>`;
    if (action === 'down' || action === 'downgrade') return `<span class="aa-icon-down">↓</span>`;
    if (action === 'init') return `<span class="aa-icon-main">★</span>`;
    return `<span class="aa-icon-main">→</span>`;
  };
  const daysAgo = (dateStr) => {
    if (!dateStr) return '';
    const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
    return diff === 0 ? '오늘' : diff === 1 ? '어제' : `${diff}일 전`;
  };
  const fmtPrice = (p) => p != null ? `$${Number(p).toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:2})}` : '—';

  const html = items.map(item => {
    const dist = item.dist;
    const totalCount = dist ? (dist.strongBuy + dist.buy + dist.hold + dist.sell + dist.strongSell) : 0;
    const buyCount  = dist ? dist.strongBuy + dist.buy  : 0;
    const holdCount = dist ? dist.hold : 0;
    const sellCount = dist ? dist.sell + dist.strongSell : 0;

    const buyPct  = totalCount > 0 ? (buyCount  / totalCount * 100).toFixed(0) : 0;
    const holdPct = totalCount > 0 ? (holdCount / totalCount * 100).toFixed(0) : 0;
    const sellPct = totalCount > 0 ? (sellCount / totalCount * 100).toFixed(0) : 0;

    const barHtml = totalCount > 0 ? `
      <div class="analyst-bar">
        ${buyPct  > 0 ? `<div class="ab-buy"  style="width:${buyPct}%"></div>`  : ''}
        ${holdPct > 0 ? `<div class="ab-hold" style="width:${holdPct}%"></div>` : ''}
        ${sellPct > 0 ? `<div class="ab-sell" style="width:${sellPct}%"></div>` : ''}
      </div>
      <div class="analyst-bar-legend">
        ${buyCount  > 0 ? `<span class="abl-buy">매수 ${buyCount}</span>`   : ''}
        ${holdCount > 0 ? `<span class="abl-hold">중립 ${holdCount}</span>` : ''}
        ${sellCount > 0 ? `<span class="abl-sell">매도 ${sellCount}</span>` : ''}
      </div>` : '';

    const ptUpside = item.price && item.targetMean
      ? ((item.targetMean - item.price) / item.price * 100).toFixed(0)
      : null;
    const ptHtml = item.targetMean ? `
      <div class="analyst-pt">
        목표주가 ${fmtPrice(item.targetMean)}
        ${ptUpside != null ? `<span class="${ptUpside >= 0 ? 'earnings-beat' : 'earnings-miss'}">${ptUpside >= 0 ? '+' : ''}${ptUpside}%</span>` : ''}
        ${item.targetLow && item.targetHigh ? `<span class="analyst-pt-range">(${fmtPrice(item.targetLow)}~${fmtPrice(item.targetHigh)})</span>` : ''}
      </div>` : '';

    const recentHtml = item.recent?.length ? `
      <div class="analyst-recent">
        ${item.recent.slice(0, 2).map(r => `
          <div class="analyst-action">
            ${actionIcon(r.action)}
            <span class="aa-firm">${escHtml(r.firm || '')}</span>
            ${r.toGrade ? `→ <span class="aa-grade">${escHtml(r.toGrade)}</span>` : ''}
            <span style="margin-left:auto">${daysAgo(r.date)}</span>
          </div>`).join('')}
      </div>` : '';

    const insightHtml = (item.valuation || item.techDir || item.provider) ? `
      <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:13.5px;margin-top:4px">
        ${item.valuation ? `<span style="color:${item.valuation==='Overvalued'?'var(--red)':item.valuation==='Undervalued'?'var(--green)':'var(--text2)'}">${item.valuation==='Overvalued'?'고평가':item.valuation==='Undervalued'?'저평가':item.valuation}</span>` : ''}
        ${item.techDir ? `<span style="color:${item.techDir==='Bullish'?'var(--red)':item.techDir==='Bearish'?'var(--blue)':'var(--text2)'}">기술적 ${item.techDir==='Bullish'?'상승':item.techDir==='Bearish'?'하락':item.techDir}</span>` : ''}
        ${item.provider ? `<span style="color:var(--text3)">${escHtml(item.provider)}</span>` : ''}
      </div>` : '';

    return `<div class="analyst-item">
      <div class="analyst-header">
        <span class="analyst-ticker">${escHtml(item.ticker)}</span>
        <span class="analyst-name">${escHtml(item.shortName || item.ticker)}</span>
        ${item.recKey ? `<span class="analyst-consensus ${consensusClass(item.recKey)}">${consensusLabel(item.recKey)}</span>` : ''}
      </div>
      ${barHtml}
      ${ptHtml}
      ${insightHtml}
      ${recentHtml}
    </div>`;
  }).join('');

  el.innerHTML = html;
  const upd = document.getElementById('analystUpdatedAt');
  if (upd) upd.textContent = new Date().toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit'}) + ' KST';
}

// 속보 (최근 이슈)
async function loadBreakingNews() {
  const el = document.getElementById('breakingNews');
  if (!el) return;
  try {
    const { data } = await sb.from('issues')
      .select('id, title, published_at, sectors')
      .eq('is_analyzed', true)
      .order('published_at', { ascending: false })
      .limit(8);

    if (!data?.length) {
      el.innerHTML = `<div style="color:var(--text3);font-size:14.5px;text-align:center;padding:16px 0">속보 없음</div>`;
      return;
    }

    const categoryBadge = (sectors) => {
      if (!sectors) return '';
      const s = sectors.join(' ');
      if (s.includes('정치') || s.includes('외교') || s.includes('정세')) return `<span class="breaking-badge badge-politics">정세</span>`;
      if (s.includes('실적') || s.includes('어닝')) return `<span class="breaking-badge badge-earnings">실적</span>`;
      if (s.includes('경제') || s.includes('금리') || s.includes('물가')) return `<span class="breaking-badge badge-economy">경제</span>`;
      return `<span class="breaking-badge badge-breaking">속보</span>`;
    };

    el.innerHTML = data.map(issue => {
      const d = new Date(issue.published_at);
      const timeStr = d.toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false});
      const dateStr = d.toLocaleDateString('ko-KR', {timeZone:'Asia/Seoul', month:'2-digit', day:'2-digit'}).replace('. ', '/').replace('.', '');
      return `
        <div class="breaking-item">
          ${categoryBadge(issue.sectors)}
          <a href="/analysis.html?id=${issue.id}" style="text-decoration:none;color:inherit">
            <div class="breaking-title">${escHtml(issue.title.slice(0, 55))}${issue.title.length > 55 ? '…' : ''}</div>
          </a>
          <div class="breaking-time">${dateStr} ${timeStr}</div>
        </div>
      `;
    }).join('');
  } catch(e) {
    el.innerHTML = `<div style="color:var(--text3);font-size:14.5px">로드 실패</div>`;
  }
}

// 경제지표 일정 (ForexFactory)
async function loadEconomicCalendar() {
  const el = document.getElementById('economicCalendar');
  if (!el) return;

  try {
    const r = await fetch('/api/market-pulse?type=economic');
    if (!r.ok) throw new Error('API error');
    const j = await r.json();

    if (!j.ok || !j.items?.length) {
      console.warn('[EconomicCalendar] empty response:', j);
      el.innerHTML = `<div style="color:var(--text3);font-size:14.5px;text-align:center;padding:16px 0">이번 주 발표 없음</div>`;
      return;
    }
    console.info('[EconomicCalendar]', j.items.length, '개 이벤트 수신');

    const nowKST = new Date().toLocaleDateString('ko-KR', { timeZone:'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit' });
    const tomKST = new Date(Date.now()+86400000).toLocaleDateString('ko-KR', { timeZone:'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit' });

    const dayLabel = (isoStr) => {
      const d = new Date(isoStr);
      const ks = d.toLocaleDateString('ko-KR', { timeZone:'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit' });
      if (ks === nowKST) return '오늘';
      if (ks === tomKST) return '내일';
      return d.toLocaleDateString('ko-KR', { timeZone:'Asia/Seoul', month:'long', day:'numeric', weekday:'short' });
    };
    const fmtTime = (isoStr) =>
      new Date(isoStr).toLocaleTimeString('ko-KR', { timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit', hour12:false });

    const countryFlag = { USD:'🇺🇸', EUR:'🇪🇺', JPY:'🇯🇵', GBP:'🇬🇧', CNY:'🇨🇳' };

    const beatMiss = (item) => {
      if (!item.actual || !item.forecast) return 'pending';
      const a = parseFloat(item.actual.replace(/[^0-9.\-]/g, ''));
      const f = parseFloat(item.forecast.replace(/[^0-9.\-]/g, ''));
      if (isNaN(a) || isNaN(f)) return 'meet';
      const diff = a - f;
      if (Math.abs(diff) < 0.001) return 'meet';
      return (item.lowerIsBetter ? diff < 0 : diff > 0) ? 'beat' : 'miss';
    };

    // Group by date
    const groups = new Map();
    j.items.forEach(item => {
      const lbl = dayLabel(item.date);
      if (!groups.has(lbl)) groups.set(lbl, []);
      groups.get(lbl).push(item);
    });

    const nowMs = Date.now();

    let html = '';
    let total = 0;
    for (const [label, items] of groups) {
      if (total >= 15) break;
      // API가 반환한 항목은 이미 -7d ~ +14d 윈도우로 필터링됨
      const hasFuture = true;
      if (!hasFuture) continue;
      html += `<div class="eco-section-label">${label}</div>`;
      for (const item of items) {
        if (total >= 15) break;
        const result    = beatMiss(item);
        const flag      = countryFlag[item.country] || item.country;
        const hasActual = item.actual != null;
        const isPastTime = new Date(item.date).getTime() < nowMs;
        html += `<div class="eco-item${hasActual ? ' eco-item-done' : ''}">
          <div class="eco-header">
            <div class="eco-dot-${item.impact === 'High' ? 'high' : 'medium'}"></div>
            <span class="eco-title">${escHtml(item.titleKo || item.title)}</span>
            <span class="eco-flag">${flag}</span>
          </div>
          <div class="eco-time">${fmtTime(item.date)} KST</div>
          <div class="eco-values">
            ${hasActual
              ? `<span class="eco-actual ${result}">결과 ${escHtml(item.actual)}${result === 'beat' ? ' ▲' : result === 'miss' ? ' ▼' : ''}</span>
                 ${item.forecast ? `<span class="eco-prev">예상 ${escHtml(item.forecast)}</span>` : ''}`
              : isPastTime
                ? `<a href="https://www.forexfactory.com/calendar" target="_blank" rel="noopener" style="color:var(--blue);font-size:13.5px;text-decoration:none">📊 발표됨 — 결과 확인 ↗</a>
                   ${item.forecast ? `<span class="eco-prev">예상 ${escHtml(item.forecast)}</span>` : ''}`
                : `${item.forecast ? `<span class="eco-actual pending">예상 ${escHtml(item.forecast)}</span>` : ''}
                   ${item.previous ? `<span class="eco-prev">이전 ${escHtml(item.previous)}</span>` : ''}`
            }
          </div>
        </div>`;
        total++;
      }
    }

    el.innerHTML = html || `<div style="color:var(--text3);font-size:14.5px;text-align:center;padding:16px 0">이번 주 발표 없음</div>`;
  } catch {
    el.innerHTML = `<div style="color:var(--text3);font-size:14.5px;text-align:center;padding:16px 0">데이터 없음</div>`;
  }
}

// 트럼프 Truth Social 글
async function loadTrumpPosts() {
  const el = document.getElementById('trumpPosts');
  if (!el) return;

  try {
    const r = await fetch('/api/market-pulse?type=trump');
    if (!r.ok) throw new Error();
    const j = await r.json();

    if (!j.ok || !j.items?.length) { el.style.display = 'none'; return; }

    el.style.display = 'block';
    el.innerHTML = j.items.slice(0, 3).map(post => {
      const timeHtml = post.publishedAt ? timeAgoHtml(post.publishedAt) : '';
      return `<div class="trump-item">
        <div class="trump-badge">🇺🇸 Truth Social</div>
        <div class="trump-text">${escHtml(post.text.slice(0, 220))}${post.text.length > 220 ? '…' : ''}</div>
        <div class="trump-meta">${timeHtml}</div>
      </div>`;
    }).join('');

    // Add separator to breaking news below
    const bn = document.getElementById('breakingNews');
    if (bn) bn.style.borderTop = '1px solid var(--border)';
  } catch {
    if (el) el.style.display = 'none';
  }
}

if (SUPABASE_URL === 'YOUR_SUPABASE_URL') {
  document.getElementById('issuesContainer').innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">⚙️</div>
      <p class="empty-title">Supabase 설정 필요</p>
      <p class="empty-sub">index.html의 SUPABASE_URL과 SUPABASE_ANON_KEY를 설정해주세요.</p>
    </div>`;
} else {
  // 홈 검색 히어로의 예시 칩("AI"/"반도체" → ?sector=, 자유 검색 폴백 → ?q=)이 딥링크로
  // 넘어올 때 이슈 피드에 미리 적용 — #issuesContainer가 있는 페이지에서만 의미 있고,
  // 없으면(다른 페이지) 아래는 그냥 no-op.
  (function applyIssuesQueryParams() {
    if (!document.getElementById('issuesContainer')) return;
    const params = new URLSearchParams(location.search);
    const qpSector = params.get('sector');
    const qpQuery = params.get('q');
    if (qpSector) {
      currentSector = qpSector;
      document.querySelectorAll('[data-sector]').forEach(b => b.classList.toggle('active', b.dataset.sector === qpSector));
    }
    if (qpQuery) {
      searchQuery = qpQuery;
      const si = document.getElementById('searchInput');
      if (si) si.value = qpQuery;
    }
  })();
  initAuth();
  loadStats();
  loadIssues();
  reloadInsightsForPage();
  loadIndices();
  loadBondStrip();
  loadEconomicCalendar();
  loadEarningsCalendar();
  loadAnalystRatings();
  // 10초 폴링. /api/indices는 전 사용자 공통 고정 심볼셋(사용자별로 다른 티커를
  // 요청하는 /api/quotes와 달리)이라 엣지 캐시가 트래픽과 무관하게 오리진 호출을
  // s-maxage(3초)로 묶어준다 — 접속자가 늘어도 야후 호출 빈도는 그대로.
  // (과거 1초 간격이었으나 체감 차이 없이 Observability Events만 불렸던 것 확인, 2026-07 10초로 완화)
  setInterval(() => { if (!document.hidden) loadIndices(); }, 10000);
  // 15초마다 시세 갱신 (마켓 상태는 카드에 표시) — 사용자마다 화면에 보이는 종목
  // 조합이 달라 edge cache 히트율이 낮음. 1초 간격은 실사용자 트래픽 증가 시
  // Yahoo Finance 레이트리밋을 유발한 원인 중 하나였음(히트맵 폴링과 동일 이슈).
  setInterval(() => { if (!document.hidden) refreshInsightQuotes(); }, 15000);
  setInterval(() => { if (!document.hidden) loadEconomicCalendar(); }, 30000);   // 30초마다 (발표 결과 빠른 반영)
  // 백그라운드 탭에서 멈춘 폴링을 탭 복귀 시 즉시 한 번 따라잡기
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    try { loadIndices(); } catch {}
    try { refreshInsightQuotes(); } catch {}
  });
}

// ── Calendar Modal ────────────────────────────────────────────────────────
let _calCache = { eco: null, earnings: null };
let _curCalTab = 'eco';

async function openCalendarModal(tab = 'eco') {
  _curCalTab = tab;
  _calMonthOffset = 0;
  _calCache = { eco: null, earnings: null }; // 항상 최신 데이터 로드
  let el = document.getElementById('calendarModal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'calendarModal';
    el.className = 'cal-overlay';
    el.innerHTML = `
      <div class="cal-modal" onclick="event.stopPropagation()">
        <div class="cal-modal-head">
          <h2>📅 전체 캘린더</h2>
          <button class="cal-close-btn" onclick="closeCalendarModal()">✕</button>
        </div>
        <div class="cal-tabs">
          <div class="cal-tab" id="calTabEco"      onclick="switchCalTab('eco')">📈 경제지표</div>
          <div class="cal-tab" id="calTabEarnings" onclick="switchCalTab('earnings')">📊 실적발표</div>
        </div>
        <div class="cal-body" id="calBody">
          <div style="text-align:center;padding:40px;color:var(--text3)">로딩 중...</div>
        </div>
      </div>`;
    el.addEventListener('click', e => { if (e.target === el) closeCalendarModal(); });
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
  document.getElementById('calTabEco').classList.toggle('active', tab === 'eco');
  document.getElementById('calTabEarnings').classList.toggle('active', tab === 'earnings');
  await renderCalModal();
}

function closeCalendarModal() {
  const el = document.getElementById('calendarModal');
  if (el) el.style.display = 'none';
}

async function switchCalTab(tab) {
  _curCalTab = tab;
  document.getElementById('calTabEco').classList.toggle('active', tab === 'eco');
  document.getElementById('calTabEarnings').classList.toggle('active', tab === 'earnings');
  await renderCalModal();
}

async function renderCalModal() {
  const body = document.getElementById('calBody');
  if (!body) return;

  if (!_calCache[_curCalTab]) {
    body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">로딩 중...</div>';
    try {
      if (_curCalTab === 'eco') {
        const r = await fetch('/api/market-pulse?type=economic');
        const j = await r.json();
        _calCache.eco = j.ok ? j.items : [];
      } else {
        _calCache.earnings = await fetchEarningsCalendarFlat();
      }
    } catch { _calCache[_curCalTab] = []; }
  }

  if (_curCalTab === 'eco') renderEcoCalTable(_calCache.eco);
  else renderEarningsCalTable(_calCache.earnings);
}

function renderEcoCalTable(items) {
  const body = document.getElementById('calBody');
  if (!items?.length) {
    body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">데이터 없음</div>';
    return;
  }

  const fmtTime = iso => new Date(iso).toLocaleTimeString('ko-KR', { timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit', hour12:false });
  const fmtDay  = iso => new Date(iso).toLocaleDateString('ko-KR', { timeZone:'Asia/Seoul', month:'long', day:'numeric', weekday:'short' });
  const flag = { USD:'🇺🇸', EUR:'🇪🇺', JPY:'🇯🇵' };

  const getBeatMiss = (item) => {
    if (!item.actual) return 'pending';
    if (!item.forecast) return 'meet';
    const a = parseFloat(item.actual.replace(/[^0-9.\-]/g, ''));
    const f = parseFloat(item.forecast.replace(/[^0-9.\-]/g, ''));
    if (isNaN(a) || isNaN(f)) return 'meet';
    const diff = a - f;
    if (Math.abs(diff) < 0.001) return 'meet';
    return (item.lowerIsBetter ? diff < 0 : diff > 0) ? 'beat' : 'miss';
  };

  const groups = new Map();
  items.forEach(it => {
    const dayKey = new Date(it.date).toLocaleDateString('ko-KR', { timeZone:'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit' });
    if (!groups.has(dayKey)) groups.set(dayKey, { label: fmtDay(it.date), rows: [] });
    groups.get(dayKey).rows.push(it);
  });

  let html = `<table class="cal-tbl">
    <thead><tr>
      <th style="width:80px">시간 KST</th>
      <th>지표명</th>
      <th style="width:45px">국가</th>
      <th style="width:42px">중요도</th>
      <th style="width:90px">결과</th>
      <th style="width:70px">예상치</th>
      <th style="width:70px">이전값</th>
    </tr></thead><tbody>`;

  for (const [, { label, rows }] of groups) {
    html += `<tr class="cal-day-hd"><td colspan="7">${label}</td></tr>`;
    for (const item of rows) {
      const bm = getBeatMiss(item);
      const isPastEvent = item.date && new Date(item.date) < new Date();
      const actualHtml = item.actual
        ? `<span class="${bm === 'beat' ? 'cal-beat' : bm === 'miss' ? 'cal-miss' : 'cal-meet'}">${escHtml(item.actual)}</span>${bm === 'beat' ? ' ▲상회' : bm === 'miss' ? ' ▼하회' : ' =부합'}`
        : isPastEvent
          ? '<span style="color:var(--text3);font-size:13.5px">집계 대기</span>'
          : '<span class="cal-pend">예정</span>';
      const impHtml = item.impact === 'High'
        ? '<span class="cal-hi">●고</span>'
        : '<span class="cal-med">●중</span>';

      html += `<tr>
        <td style="font-family:'SF Mono',monospace;color:var(--text3)">${fmtTime(item.date)}</td>
        <td style="font-weight:600">${escHtml(item.titleKo || item.title)}</td>
        <td style="font-size:14.5px">${flag[item.country] || item.country}</td>
        <td>${impHtml}</td>
        <td>${actualHtml}</td>
        <td style="color:var(--text3)">${item.forecast ? escHtml(item.forecast) : '—'}</td>
        <td style="color:var(--text3)">${item.previous ? escHtml(item.previous) : '—'}</td>
      </tr>`;
    }
  }
  html += '</tbody></table>';
  body.innerHTML = html;
}

// 실적발표 캘린더 — "캘린더 형태"(월 그리드) 뷰. 날짜 미확정(TBD) 건은 그리드에
// 표시할 자리가 없으므로 그리드 아래 별도 목록으로 붙인다.
let _calMonthOffset = 0;   // 0=이번 달, ±N=이전/다음 달 (모달 열 때마다 리셋)
let _earningsCalItems = [];

function renderEarningsCalTable(items) {
  const body = document.getElementById('calBody');
  if (!items?.length) {
    body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">데이터 없음</div>';
    return;
  }
  _earningsCalItems = items;
  renderEarningsCalGrid();
}

function navEarningsCal(delta) {
  _calMonthOffset += delta;
  renderEarningsCalGrid();
}

function renderEarningsCalGrid() {
  const body = document.getElementById('calBody');
  const items = _earningsCalItems;
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth() + _calMonthOffset, 1);
  const year = base.getFullYear(), month = base.getMonth();

  const byDay = new Map();
  const tbd = [];
  for (const it of items) {
    if (!it.date) { tbd.push(it); continue; }
    const d = new Date(it.date + 'T12:00:00Z');
    if (d.getFullYear() === year && d.getMonth() === month) {
      if (!byDay.has(it.date)) byDay.set(it.date, []);
      byDay.get(it.date).push(it);
    }
  }

  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = new Date().toISOString().slice(0, 10);

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const dowLabels = ['일','월','화','수','목','금','토'];
  const monthTotal = [...byDay.values()].reduce((s, arr) => s + arr.length, 0);

  const html = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 4px 12px">
      <button class="cal-nav-btn" onclick="navEarningsCal(-1)">‹ 이전달</button>
      <div style="font-weight:800;font-size:17px">${year}년 ${month + 1}월 <span style="font-size:13.5px;font-weight:600;color:var(--text3)">· 실적발표 ${monthTotal}건</span></div>
      <button class="cal-nav-btn" onclick="navEarningsCal(1)">다음달 ›</button>
    </div>
    <div class="cal-grid">
      ${dowLabels.map(l => `<div class="cal-grid-dow">${l}</div>`).join('')}
      ${cells.map(d => {
        if (d == null) return '<div class="cal-grid-cell empty"></div>';
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dayItems = byDay.get(dateStr) || [];
        const isToday = dateStr === todayStr;
        return `<div class="cal-grid-cell${isToday ? ' today' : ''}${dayItems.length ? ' has-events' : ''}" ${dayItems.length ? `onclick="showEarningsDayDetail('${dateStr}')"` : ''}>
          <div class="cal-grid-daynum">${d}</div>
          ${dayItems.slice(0, 3).map(it => `<div class="cal-grid-badge">${escHtml(it.ticker || '')}</div>`).join('')}
          ${dayItems.length > 3 ? `<div class="cal-grid-more">+${dayItems.length - 3}개</div>` : ''}
        </div>`;
      }).join('')}
    </div>
    ${tbd.length ? `<div style="margin-top:14px;font-size:13.5px;color:var(--text3)">📌 날짜 미확정 ${tbd.length}건: ${tbd.map(it => escHtml(it.ticker || '')).join(', ')}</div>` : ''}
    <div id="earningsDayDetail"></div>
  `;
  body.innerHTML = html;
}

function showEarningsDayDetail(dateStr) {
  const el = document.getElementById('earningsDayDetail');
  if (!el) return;
  const items = _earningsCalItems.filter(it => it.date === dateStr);

  const fmtNum = v => v != null ? `$${Number(v).toFixed(2)}` : '—';
  const fmtRev = v => {
    if (v == null) return '—';
    if (v >= 1e12) return `$${(v/1e12).toFixed(2)}T`;
    if (v >= 1e9)  return `$${(v/1e9).toFixed(1)}B`;
    if (v >= 1e6)  return `$${(v/1e6).toFixed(0)}M`;
    return `$${Number(v).toFixed(0)}`;
  };
  const fmtDay = d => {
    try { return new Date(d + 'T12:00:00Z').toLocaleDateString('ko-KR', { month:'long', day:'numeric', weekday:'short' }); }
    catch { return d; }
  };

  el.innerHTML = `<div style="font-weight:800;font-size:15.5px;margin-bottom:8px">${fmtDay(dateStr)} 실적발표 (${items.length}건)</div>
    <table class="cal-tbl">
      <thead><tr>
        <th style="width:65px">종목</th><th>기업명</th><th style="width:64px">발표(KST)</th>
        <th style="width:80px">EPS 예상</th><th style="width:90px">EPS 실적</th>
        <th style="width:80px">매출 예상</th><th style="width:70px">목표주가</th>
      </tr></thead><tbody>
      ${items.map(item => {
        const consensus = item.epsConsensus ?? item.epsEstimate ?? null;
        let epsActualHtml = '<span style="color:var(--text3)">미발표</span>';
        if (item.epsActual != null) {
          const beat = consensus != null ? item.epsActual >= consensus : null;
          const cls = beat === true ? 'cal-beat' : beat === false ? 'cal-miss' : 'cal-meet';
          const icon = beat === true ? ' ▲' : beat === false ? ' ▼' : '';
          epsActualHtml = `<span class="${cls}">${fmtNum(item.epsActual)}${icon}</span>`;
        }
        const kstInfo = earningsCallTimeToKst(item.date, item.callTime);
        const timing = kstInfo
          ? `<span style="color:${item.callTime === 'BMO' ? '#60a5fa' : '#a78bfa'};font-size:13px" title="${escAttr(kstInfo.whenLabel + ' 한국시간 ' + kstInfo.full)}">${kstInfo.hm}${kstInfo.rolledToNextDay ? '<sup>+1</sup>' : ''}</span>`
          : '<span style="color:var(--text3);font-size:13px">—</span>';
        return `<tr>
          <td style="font-weight:700;color:var(--yellow)">${escHtml(item.ticker || '')}</td>
          <td style="font-size:13.5px;color:var(--text2)">${escHtml(item.company || '')}</td>
          <td>${timing}</td>
          <td style="color:var(--text3)">${fmtNum(consensus)}</td>
          <td>${epsActualHtml}</td>
          <td style="color:var(--text3)">${fmtRev(item.revEstimate)}</td>
          <td style="color:var(--text3)">${fmtNum(item.priceTarget)}</td>
        </tr>`;
      }).join('')}
    </tbody></table>`;
}

// ─── 🔥 히트맵 ─────────────────────────────────────────────
const HEATMAP_TICKERS = {
  // 📊 SPDR 섹터 ETF (S&P500 11개 섹터)
  sector: [
    { t:'XLK',  n:'기술' },          { t:'XLF',  n:'금융' },         { t:'XLV',  n:'헬스케어' },
    { t:'XLY',  n:'경기소비재' },     { t:'XLP',  n:'필수소비재' },    { t:'XLE',  n:'에너지' },
    { t:'XLI',  n:'산업재' },         { t:'XLB',  n:'소재' },         { t:'XLU',  n:'유틸리티' },
    { t:'XLRE', n:'리츠' },           { t:'XLC',  n:'통신서비스' },
    // 추가: 반도체·바이오 sub-sector ETFs
    { t:'SMH',  n:'반도체' },         { t:'SOXX', n:'반도체 (IShares)' },
    { t:'XBI',  n:'바이오 (생물)' },  { t:'IBB',  n:'바이오 (대형)' },
    { t:'KRE',  n:'지역은행' },       { t:'KBE',  n:'전체은행' },
    { t:'XHB',  n:'주택건설' },       { t:'XRT',  n:'리테일' },
    { t:'ITA',  n:'방산·항공' },      { t:'JETS', n:'항공' },
    { t:'IYT',  n:'운송' },           { t:'XME',  n:'채굴' },
    { t:'TAN',  n:'태양광' },         { t:'ICLN', n:'친환경에너지' },
  ],
  // ⚡ 인기 ETF (지수·테마·국가)
  etf: [
    // 메이저 지수
    { t:'SPY',  n:'S&P 500' },       { t:'QQQ',  n:'NASDAQ 100' },   { t:'DIA',  n:'다우' },
    { t:'IWM',  n:'러셀 2000' },     { t:'VTI',  n:'미국 전체' },     { t:'VOO',  n:'S&P 500 (Vanguard)' },
    // 글로벌
    { t:'EFA',  n:'선진국 (비미국)' },{ t:'EEM',  n:'신흥국' },        { t:'VWO',  n:'신흥국 (Vanguard)' },
    { t:'EWJ',  n:'일본' },          { t:'EWY',  n:'한국' },          { t:'MCHI', n:'중국' },
    { t:'INDA', n:'인도' },          { t:'EWT',  n:'대만' },          { t:'EWZ',  n:'브라질' },
    // 테마
    { t:'ARKK', n:'ARK 혁신' },      { t:'TQQQ', n:'NASDAQ 3X' },    { t:'SQQQ', n:'NASDAQ -3X' },
    { t:'SOXL', n:'반도체 3X' },     { t:'TLT',  n:'장기국채 20Y+' }, { t:'IEF',  n:'중기국채 7-10Y' },
    { t:'SHY',  n:'단기국채 1-3Y' }, { t:'HYG',  n:'하이일드 채권' },  { t:'LQD',  n:'IG 회사채' },
    // 원자재·금
    { t:'GLD',  n:'금' },            { t:'SLV',  n:'은' },           { t:'USO',  n:'WTI 원유' },
    { t:'UNG',  n:'천연가스' },      { t:'DBC',  n:'원자재 종합' },   { t:'URA',  n:'우라늄' },
    // 암호화폐
    { t:'IBIT', n:'BTC 현물 ETF (BlackRock)' }, { t:'FBTC', n:'BTC 현물 ETF (Fidelity)' },
  ],
  // 🌍 글로벌 자산 (지수 / 금리 / 원자재 / FX / 크립토)
  assets: [
    // 미국 주요 지수
    { t:'^GSPC', n:'S&P 500' },      { t:'^IXIC', n:'NASDAQ' },      { t:'^DJI',  n:'DOW' },
    { t:'^RUT',  n:'러셀 2000' },    { t:'^VIX',  n:'VIX 공포지수' },
    // 글로벌 지수
    { t:'^KS11', n:'KOSPI' },        { t:'^KQ11', n:'KOSDAQ' },      { t:'^N225', n:'NIKKEI' },
    { t:'^HSI',  n:'홍콩 항셍' },    { t:'000001.SS', n:'상하이종합' },{ t:'^FTSE', n:'영국 FTSE' },
    { t:'^GDAXI',n:'독일 DAX' },     { t:'^FCHI', n:'프랑스 CAC' },
    // 미국 금리 (트레저리 yields)
    { t:'^IRX',  n:'미 3개월 금리' },{ t:'^FVX',  n:'미 5년 금리' },  { t:'^TNX',  n:'미 10년 금리' },
    { t:'^TYX',  n:'미 30년 금리' },
    // 원자재 (선물)
    { t:'GC=F',  n:'금' },           { t:'SI=F',  n:'은' },          { t:'PL=F',  n:'백금' },
    { t:'CL=F',  n:'WTI 원유' },     { t:'BZ=F',  n:'브렌트유' },     { t:'NG=F',  n:'천연가스' },
    { t:'HG=F',  n:'구리' },         { t:'ZC=F',  n:'옥수수' },       { t:'ZW=F',  n:'밀' },
    // FX (USD 환율)
    { t:'DX-Y.NYB', n:'달러 지수 DXY' },
    { t:'KRW=X', n:'USD/KRW' },      { t:'JPY=X', n:'USD/JPY' },     { t:'EURUSD=X', n:'EUR/USD' },
    { t:'GBPUSD=X', n:'GBP/USD' },   { t:'AUDUSD=X', n:'AUD/USD' },  { t:'CNY=X', n:'USD/CNY' },
    // 암호화폐
    { t:'BTC-USD', n:'비트코인' },   { t:'ETH-USD', n:'이더리움' },   { t:'SOL-USD', n:'솔라나' },
    { t:'XRP-USD', n:'리플' },
  ],
  us: [
    // 🎯 사용자 보유 (Toss 증권 계좌)
    { t:'SNDK',  n:'SanDisk' },      { t:'NASA',  n:'NASA ETF' },    { t:'TSLL', n:'TSLA 2x롱' },
    { t:'NVDL',  n:'NVDA 2x롱' },    { t:'NOWL',  n:'NOW 2x롱' },    { t:'ARMG', n:'ARM 2x롱' },
    { t:'QUBT',  n:'퀀텀컴퓨팅' },   { t:'BATL',  n:'Battalion Oil' },{ t:'BTBT', n:'Bit Digital' },
    { t:'USBC',  n:'USBC' },        { t:'SKHY',  n:'SK하이닉스 ADR' },
    // Mega cap (시총 1조+ )
    { t:'AAPL',  n:'Apple' },        { t:'MSFT',  n:'Microsoft' },   { t:'NVDA', n:'NVIDIA' },
    { t:'GOOGL', n:'Alphabet' },     { t:'AMZN',  n:'Amazon' },      { t:'META', n:'Meta' },
    { t:'TSLA',  n:'Tesla' },        { t:'AVGO',  n:'Broadcom' },    { t:'BRK-B',n:'Berkshire' },
    { t:'LLY',   n:'Eli Lilly' },    { t:'JPM',   n:'JPMorgan' },    { t:'V',    n:'Visa' },
    { t:'UNH',   n:'UnitedHealth' }, { t:'XOM',   n:'ExxonMobil' },  { t:'MA',   n:'Mastercard' },
    { t:'WMT',   n:'Walmart' },      { t:'JNJ',   n:'Johnson&Johnson'},{t:'PG',   n:'P&G' },
    { t:'ORCL',  n:'Oracle' },       { t:'COST',  n:'Costco' },      { t:'HD',   n:'Home Depot' },
    // Tech & growth
    { t:'AMD',   n:'AMD' },          { t:'NFLX',  n:'Netflix' },     { t:'CRM',  n:'Salesforce' },
    { t:'ADBE',  n:'Adobe' },        { t:'CSCO',  n:'Cisco' },       { t:'INTC', n:'Intel' },
    { t:'QCOM',  n:'Qualcomm' },     { t:'TXN',   n:'Texas Instr' }, { t:'MU',   n:'Micron' },
    { t:'PLTR',  n:'Palantir' },     { t:'SNOW',  n:'Snowflake' },   { t:'NOW',  n:'ServiceNow' },
    // Finance
    { t:'BAC',   n:'BofA' },         { t:'WFC',   n:'Wells Fargo' }, { t:'GS',   n:'Goldman Sachs'},
    { t:'MS',    n:'Morgan Stanley'},{ t:'BLK',   n:'BlackRock' },   { t:'AXP',  n:'AmEx' },
    // Healthcare / Pharma
    { t:'ABBV',  n:'AbbVie' },       { t:'MRK',   n:'Merck' },       { t:'TMO',  n:'Thermo Fisher'},
    { t:'NVO',   n:'Novo Nordisk' }, { t:'PFE',   n:'Pfizer' },
    // Energy / industrial
    { t:'CVX',   n:'Chevron' },      { t:'BA',    n:'Boeing' },      { t:'CAT',  n:'Caterpillar' },
    { t:'GE',    n:'GE' },           { t:'LMT',   n:'Lockheed' },    { t:'CEG',  n:'Constellation' },
    // Consumer / media
    { t:'DIS',   n:'Disney' },       { t:'MCD',   n:'McDonald\'s' }, { t:'NKE',  n:'Nike' },
    { t:'PEP',   n:'PepsiCo' },      { t:'KO',    n:'Coca-Cola' },   { t:'SBUX', n:'Starbucks' },
    // Crypto / fintech
    { t:'COIN',  n:'Coinbase' },     { t:'XYZ',   n:'Block' },
    // Auto
    { t:'F',     n:'Ford' },         { t:'GM',    n:'General Motors'},{t:'RIVN',  n:'Rivian' },
    // Semiconductors (추가)
    { t:'LRCX',  n:'Lam Research' }, { t:'AMAT',  n:'Applied Materials'},{t:'KLAC', n:'KLA' },
    { t:'ASML',  n:'ASML' },         { t:'TSM',   n:'TSMC' },        { t:'ARM',  n:'Arm Holdings' },
    // Software / Cloud / Internet (추가)
    { t:'PYPL',  n:'PayPal' },       { t:'SHOP',  n:'Shopify' },     { t:'UBER', n:'Uber' },
    { t:'ABNB',  n:'Airbnb' },       { t:'PANW',  n:'Palo Alto' },   { t:'CRWD', n:'CrowdStrike' },
    { t:'NET',   n:'Cloudflare' },   { t:'IBM',   n:'IBM' },         { t:'ACN',  n:'Accenture' },
    { t:'SPGI',  n:'S&P Global' },
    // Healthcare (추가)
    { t:'ABT',   n:'Abbott' },       { t:'DHR',   n:'Danaher' },     { t:'ISRG', n:'Intuitive Surgical'},
    { t:'GILD',  n:'Gilead' },       { t:'VRTX',  n:'Vertex Pharma'},
    // Industrial (추가)
    { t:'RTX',   n:'RTX' },          { t:'HON',   n:'Honeywell' },   { t:'DE',   n:'Deere' },
    // Finance (추가)
    { t:'C',     n:'Citigroup' },    { t:'SCHW',  n:'Charles Schwab'},
    // 소비재·리테일 (추가2)
    { t:'TGT',   n:'Target' },       { t:'LOW',   n:'Lowe\'s' },      { t:'TJX',  n:'TJX' },
    { t:'CMG',   n:'Chipotle' },     { t:'YUM',   n:'Yum! Brands' },  { t:'MNST', n:'Monster Bev' },
    { t:'KHC',   n:'Kraft Heinz' },  { t:'MDLZ',  n:'Mondelez' },     { t:'CL',   n:'Colgate' },
    { t:'KMB',   n:'Kimberly-Clark'},{ t:'EL',    n:'Estee Lauder' }, { t:'DASH', n:'DoorDash' },
    { t:'ETSY',  n:'Etsy' },
    // 헬스케어 (추가2)
    { t:'CVS',   n:'CVS Health' },   { t:'CI',    n:'Cigna' },        { t:'ELV',  n:'Elevance' },
    { t:'BMY',   n:'Bristol-Myers'}, { t:'AMGN',  n:'Amgen' },        { t:'REGN', n:'Regeneron' },
    { t:'ZTS',   n:'Zoetis' },       { t:'BSX',   n:'Boston Sci' },   { t:'MDT',  n:'Medtronic' },
    { t:'SYK',   n:'Stryker' },
    // 금융 (추가2)
    { t:'BX',    n:'Blackstone' },   { t:'KKR',   n:'KKR' },          { t:'ICE',  n:'ICE' },
    { t:'CME',   n:'CME Group' },    { t:'SPG',   n:'Simon Property'},{ t:'PGR',  n:'Progressive' },
    { t:'TRV',   n:'Travelers' },    { t:'MET',   n:'MetLife' },      { t:'AIG',  n:'AIG' },
    { t:'COF',   n:'Capital One' },  { t:'USB',   n:'US Bancorp' },   { t:'PNC',  n:'PNC' },
    // 산업재·운송 (추가2)
    { t:'MMM',   n:'3M' },           { t:'UNP',   n:'Union Pacific'}, { t:'CSX',  n:'CSX' },
    { t:'DAL',   n:'Delta' },        { t:'UAL',   n:'United' },       { t:'LUV',  n:'Southwest' },
    { t:'EMR',   n:'Emerson' },      { t:'ETN',   n:'Eaton' },        { t:'ITW',  n:'Illinois Tool'},
    // 반도체·소프트웨어 (추가2)
    { t:'MRVL',  n:'Marvell' },      { t:'ON',    n:'ON Semi' },      { t:'MCHP', n:'Microchip' },
    { t:'ADI',   n:'Analog Devices'},{ t:'SWKS',  n:'Skyworks' },     { t:'NXPI', n:'NXP' },
    { t:'ANET',  n:'Arista' },       { t:'DDOG',  n:'Datadog' },      { t:'MDB',  n:'MongoDB' },
    { t:'TEAM',  n:'Atlassian' },    { t:'WDAY',  n:'Workday' },      { t:'OKTA', n:'Okta' },
    { t:'ZS',    n:'Zscaler' },
    // 에너지 (추가2)
    { t:'SLB',   n:'Schlumberger' }, { t:'COP',   n:'ConocoPhillips'},{ t:'EOG',  n:'EOG Resources'},
    { t:'VLO',   n:'Valero' },
    // 통신·부동산 (추가2)
    { t:'T',     n:'AT&T' },         { t:'VZ',    n:'Verizon' },      { t:'TMUS', n:'T-Mobile' },
    { t:'CMCSA', n:'Comcast' },      { t:'PLD',   n:'Prologis' },     { t:'AMT',  n:'American Tower'},
    { t:'EQIX',  n:'Equinix' },      { t:'DLR',   n:'Digital Realty'},{ t:'O',    n:'Realty Income'},
    // 여행·레저 (추가2)
    { t:'BKNG',  n:'Booking' },      { t:'MAR',   n:'Marriott' },     { t:'HLT',  n:'Hilton' },

    // ─── S&P500 전체 편입 (히트맵 확장, 2026-07 기준) ───
    { t:'AOS', n:'A. O. Smith' }, { t:'AES', n:'AES' }, { t:'AFL', n:'Aflac' },
    { t:'A', n:'Agilent Technologies' }, { t:'APD', n:'Air Products' }, { t:'AKAM', n:'Akamai Technologies' },
    { t:'ALB', n:'Albemarle' }, { t:'ARE', n:'Alexandria Real Estate Equities' }, { t:'ALGN', n:'Align Technology' },
    { t:'ALLE', n:'Allegion' }, { t:'LNT', n:'Alliant Energy' }, { t:'ALL', n:'Allstate' },
    { t:'GOOG', n:'Alphabet Inc. (Class C)' }, { t:'MO', n:'Altria' }, { t:'AMCR', n:'Amcor' },
    { t:'AEE', n:'Ameren' }, { t:'AEP', n:'American Electric Power' }, { t:'AWK', n:'American Water Works' },
    { t:'AMP', n:'Ameriprise Financial' }, { t:'AME', n:'Ametek' }, { t:'APH', n:'Amphenol' },
    { t:'AON', n:'Aon plc' }, { t:'APA', n:'APA' }, { t:'APO', n:'Apollo Global Management' },
    { t:'APP', n:'AppLovin' }, { t:'APTV', n:'Aptiv' }, { t:'ACGL', n:'Arch Capital Group' },
    { t:'ADM', n:'Archer Daniels Midland' }, { t:'ARES', n:'Ares Management' }, { t:'AJG', n:'Arthur J. Gallagher and Co.' },
    { t:'AIZ', n:'Assurant' }, { t:'ATO', n:'Atmos Energy' }, { t:'ADSK', n:'Autodesk' },
    { t:'ADP', n:'Automatic Data Processing' }, { t:'AZO', n:'AutoZone' }, { t:'AVB', n:'AvalonBay Communities' },
    { t:'AVY', n:'Avery Dennison' }, { t:'AXON', n:'Axon Enterprise' }, { t:'BKR', n:'Baker Hughes' },
    { t:'BALL', n:'Ball' }, { t:'BAX', n:'Baxter International' }, { t:'BDX', n:'Becton Dickinson' },
    { t:'BBY', n:'Best Buy' }, { t:'TECH', n:'Bio-Techne' }, { t:'BIIB', n:'Biogen' },
    { t:'BNY', n:'BNY Mellon' }, { t:'BR', n:'Broadridge Financial Solutions' }, { t:'BRO', n:'Brown and Brown' },
    { t:'BF-B', n:'Brown-Forman' }, { t:'BLDR', n:'Builders FirstSource' }, { t:'BG', n:'Bunge Global' },
    { t:'BXP', n:'BXP' }, { t:'CHRW', n:'C.H. Robinson' }, { t:'CDNS', n:'Cadence Design Systems' },
    { t:'CPT', n:'Camden Property Trust' }, { t:'CAH', n:'Cardinal Health' }, { t:'CCL', n:'Carnival' },
    { t:'CARR', n:'Carrier Global' }, { t:'CVNA', n:'Carvana' }, { t:'CASY', n:'Caseys' },
    { t:'CBOE', n:'Cboe Global Markets' }, { t:'CBRE', n:'CBRE Group' }, { t:'CDW', n:'CDW' },
    { t:'COR', n:'Cencora' }, { t:'CNC', n:'Centene' }, { t:'CNP', n:'CenterPoint Energy' },
    { t:'CF', n:'CF Industries' }, { t:'CRL', n:'Charles River Laboratories' }, { t:'CHTR', n:'Charter Communications' },
    { t:'CB', n:'Chubb Limited' }, { t:'CHD', n:'Church and Dwight' }, { t:'CIEN', n:'Ciena' },
    { t:'CINF', n:'Cincinnati Financial' }, { t:'CTAS', n:'Cintas' }, { t:'CFG', n:'Citizens Financial Group' },
    { t:'CLX', n:'Clorox' }, { t:'CMS', n:'CMS Energy' }, { t:'CTSH', n:'Cognizant' },
    { t:'COHR', n:'Coherent Corp.' }, { t:'FIX', n:'Comfort Systems USA' }, { t:'ED', n:'Consolidated Edison' },
    { t:'STZ', n:'Constellation Brands' }, { t:'COO', n:'Cooper Companies' }, { t:'CPRT', n:'Copart' },
    { t:'GLW', n:'Corning' }, { t:'CPAY', n:'Corpay' }, { t:'CTVA', n:'Corteva' },
    { t:'CSGP', n:'CoStar Group' }, { t:'CRH', n:'CRH plc' }, { t:'CCI', n:'Crown Castle' },
    { t:'CMI', n:'Cummins' }, { t:'DRI', n:'Darden Restaurants' }, { t:'DVA', n:'DaVita' },
    { t:'DECK', n:'Deckers Brands' }, { t:'DELL', n:'Dell Technologies' }, { t:'DVN', n:'Devon Energy' },
    { t:'DXCM', n:'Dexcom' }, { t:'FANG', n:'Diamondback Energy' }, { t:'DG', n:'Dollar General' },
    { t:'DLTR', n:'Dollar Tree' }, { t:'D', n:'Dominion Energy' }, { t:'DPZ', n:'Dominos' },
    { t:'DOV', n:'Dover' }, { t:'DOW', n:'Dow' }, { t:'DHI', n:'D. R. Horton' },
    { t:'DTE', n:'DTE Energy' }, { t:'DUK', n:'Duke Energy' }, { t:'DD', n:'DuPont' },
    { t:'EBAY', n:'eBay' }, { t:'ECHO', n:'EchoStar' }, { t:'ECL', n:'Ecolab' },
    { t:'EIX', n:'Edison International' }, { t:'EW', n:'Edwards Lifesciences' }, { t:'EA', n:'Electronic Arts' },
    { t:'EME', n:'Emcor' }, { t:'ETR', n:'Entergy' }, { t:'EQT', n:'EQT' },
    { t:'EFX', n:'Equifax' }, { t:'EQR', n:'Equity Residential' }, { t:'ERIE', n:'Erie Indemnity' },
    { t:'ESS', n:'Essex Property Trust' }, { t:'EG', n:'Everest Group' }, { t:'EVRG', n:'Evergy' },
    { t:'ES', n:'Eversource Energy' }, { t:'EXC', n:'Exelon' }, { t:'EXE', n:'Expand Energy' },
    { t:'EXPE', n:'Expedia Group' }, { t:'EXPD', n:'Expeditors International' }, { t:'EXR', n:'Extra Space Storage' },
    { t:'FFIV', n:'F5' }, { t:'FDS', n:'FactSet' }, { t:'FICO', n:'Fair Isaac' },
    { t:'FAST', n:'Fastenal' }, { t:'FRT', n:'Federal Realty Investment Trust' }, { t:'FDX', n:'FedEx' },
    { t:'FDXF', n:'FedEx Freight' }, { t:'FIS', n:'Fidelity National Information Services' }, { t:'FITB', n:'Fifth Third Bancorp' },
    { t:'FSLR', n:'First Solar' }, { t:'FE', n:'FirstEnergy' }, { t:'FISV', n:'Fiserv' },
    { t:'FLEX', n:'Flex Ltd.' }, { t:'FTNT', n:'Fortinet' }, { t:'FTV', n:'Fortive' },
    { t:'FOXA', n:'Fox Corporation A' }, { t:'FOX', n:'Fox Corporation B' }, { t:'BEN', n:'Franklin Resources' },
    { t:'FCX', n:'Freeport-McMoRan' }, { t:'GRMN', n:'Garmin' }, { t:'IT', n:'Gartner' },
    { t:'GEHC', n:'GE HealthCare' }, { t:'GEV', n:'GE Vernova' }, { t:'GEN', n:'Gen Digital' },
    { t:'GNRC', n:'Generac' }, { t:'GD', n:'General Dynamics' }, { t:'GIS', n:'General Mills' },
    { t:'GPC', n:'Genuine Parts' }, { t:'GPN', n:'Global Payments' }, { t:'GL', n:'Globe Life' },
    { t:'GDDY', n:'GoDaddy' }, { t:'HAL', n:'Halliburton' }, { t:'HIG', n:'Hartford' },
    { t:'HAS', n:'Hasbro' }, { t:'HCA', n:'HCA Healthcare' }, { t:'DOC', n:'Healthpeak Properties' },
    { t:'HSIC', n:'Henry Schein' }, { t:'HSY', n:'Hershey' }, { t:'HPE', n:'Hewlett Packard Enterprise' },
    { t:'HONA', n:'Honeywell Aerospace' }, { t:'HRL', n:'Hormel Foods' }, { t:'HST', n:'Host Hotels and Resorts' },
    { t:'HWM', n:'Howmet Aerospace' }, { t:'HPQ', n:'HP' }, { t:'HUBB', n:'Hubbell Incorporated' },
    { t:'HUM', n:'Humana' }, { t:'HBAN', n:'Huntington Bancshares' }, { t:'HII', n:'Huntington Ingalls Industries' },
    { t:'IEX', n:'IDEX' }, { t:'IDXX', n:'Idexx Laboratories' }, { t:'INCY', n:'Incyte' },
    { t:'IR', n:'Ingersoll Rand' }, { t:'PODD', n:'Insulet' }, { t:'IBKR', n:'Interactive Brokers' },
    { t:'IFF', n:'International Flavors and Fragrances' }, { t:'IP', n:'International Paper' }, { t:'INTU', n:'Intuit' },
    { t:'IVZ', n:'Invesco' }, { t:'INVH', n:'Invitation Homes' }, { t:'IQV', n:'IQVIA' },
    { t:'IRM', n:'Iron Mountain' }, { t:'JBHT', n:'J.B. Hunt' }, { t:'JBL', n:'Jabil' },
    { t:'JKHY', n:'Jack Henry and Associates' }, { t:'J', n:'Jacobs Solutions' }, { t:'JCI', n:'Johnson Controls' },
    { t:'KVUE', n:'Kenvue' }, { t:'KDP', n:'Keurig Dr Pepper' }, { t:'KEY', n:'KeyCorp' },
    { t:'KEYS', n:'Keysight Technologies' }, { t:'KIM', n:'Kimco Realty' }, { t:'KMI', n:'Kinder Morgan' },
    { t:'KR', n:'Kroger' }, { t:'LHX', n:'L3Harris' }, { t:'LH', n:'Labcorp' },
    { t:'LVS', n:'Las Vegas Sands' }, { t:'LDOS', n:'Leidos' }, { t:'LEN', n:'Lennar' },
    { t:'LII', n:'Lennox International' }, { t:'LIN', n:'Linde plc' }, { t:'LYV', n:'Live Nation Entertainment' },
    { t:'L', n:'Loews' }, { t:'LULU', n:'Lululemon Athletica' }, { t:'LITE', n:'Lumentum' },
    { t:'LYB', n:'LyondellBasell' }, { t:'MTB', n:'M&T Bank' }, { t:'MPC', n:'Marathon Petroleum' },
    { t:'MRSH', n:'Marsh McLennan' }, { t:'MLM', n:'Martin Marietta Materials' }, { t:'MAS', n:'Masco' },
    { t:'MKC', n:'McCormick & Co' }, { t:'MCK', n:'McKesson' }, { t:'MTD', n:'Mettler Toledo' },
    { t:'MGM', n:'MGM Resorts' }, { t:'MAA', n:'Mid-America Apartment Communities' }, { t:'MRNA', n:'Moderna' },
    { t:'TAP', n:'Molson Coors Beverage' }, { t:'MPWR', n:'Monolithic Power Systems' }, { t:'MCO', n:'Moodys' },
    { t:'MOS', n:'Mosaic' }, { t:'MSI', n:'Motorola Solutions' }, { t:'MSCI', n:'MSCI' },
    { t:'NDAQ', n:'Nasdaq' }, { t:'NTAP', n:'NetApp' }, { t:'NEM', n:'Newmont' },
    { t:'NWSA', n:'News Corp A' }, { t:'NWS', n:'News Corp B' }, { t:'NEE', n:'NextEra Energy' },
    { t:'NI', n:'NiSource' }, { t:'NDSN', n:'Nordson' }, { t:'NSC', n:'Norfolk Southern' },
    { t:'NTRS', n:'Northern Trust' }, { t:'NOC', n:'Northrop Grumman' }, { t:'NCLH', n:'Norwegian Cruise Line Holdings' },
    { t:'NRG', n:'NRG Energy' }, { t:'NUE', n:'Nucor' }, { t:'NVR', n:'NVR' },
    { t:'ORLY', n:'OReilly Automotive' }, { t:'OXY', n:'Occidental Petroleum' }, { t:'ODFL', n:'Old Dominion' },
    { t:'OMC', n:'Omnicom Group' }, { t:'OKE', n:'Oneok' }, { t:'OTIS', n:'Otis Worldwide' },
    { t:'PCAR', n:'Paccar' }, { t:'PKG', n:'Packaging Corporation of America' }, { t:'PSKY', n:'Paramount Skydance' },
    { t:'PH', n:'Parker Hannifin' }, { t:'PAYX', n:'Paychex' }, { t:'PNR', n:'Pentair' },
    { t:'PCG', n:'PG&E' }, { t:'PM', n:'Philip Morris International' }, { t:'PSX', n:'Phillips 66' },
    { t:'PNW', n:'Pinnacle West Capital' }, { t:'PPG', n:'PPG Industries' }, { t:'PPL', n:'PPL' },
    { t:'PFG', n:'Principal Financial Group' }, { t:'PRU', n:'Prudential Financial' }, { t:'PEG', n:'Public Service Enterprise Group' },
    { t:'PTC', n:'PTC' }, { t:'PSA', n:'Public Storage' }, { t:'PHM', n:'PulteGroup' },
    { t:'PWR', n:'Quanta Services' }, { t:'DGX', n:'Quest Diagnostics' }, { t:'Q', n:'Qnity Electronics' },
    { t:'RL', n:'Ralph Lauren' }, { t:'RJF', n:'Raymond James Financial' }, { t:'REG', n:'Regency Centers' },
    { t:'RF', n:'Regions Financial' }, { t:'RSG', n:'Republic Services' }, { t:'RMD', n:'ResMed' },
    { t:'RVTY', n:'Revvity' }, { t:'HOOD', n:'Robinhood Markets' }, { t:'ROK', n:'Rockwell Automation' },
    { t:'ROL', n:'Rollins' }, { t:'ROP', n:'Roper Technologies' }, { t:'ROST', n:'Ross Stores' },
    { t:'RCL', n:'Royal Caribbean Group' }, { t:'SBAC', n:'SBA Communications' }, { t:'STX', n:'Seagate Technology' },
    { t:'SRE', n:'Sempra' }, { t:'SHW', n:'Sherwin-Williams' }, { t:'SJM', n:'J.M. Smucker' },
    { t:'SW', n:'Smurfit Westrock' }, { t:'SNA', n:'Snap-on' }, { t:'SOLV', n:'Solventum' },
    { t:'SO', n:'Southern' }, { t:'SWK', n:'Stanley Black and Decker' }, { t:'STT', n:'State Street' },
    { t:'STLD', n:'Steel Dynamics' }, { t:'STE', n:'Steris' }, { t:'SMCI', n:'Supermicro' },
    { t:'SYF', n:'Synchrony Financial' }, { t:'SNPS', n:'Synopsys' }, { t:'SYY', n:'Sysco' },
    { t:'TROW', n:'T. Rowe Price' }, { t:'TTWO', n:'Take-Two Interactive' }, { t:'TPR', n:'Tapestry' },
    { t:'TRGP', n:'Targa Resources' }, { t:'TEL', n:'TE Connectivity' }, { t:'TDY', n:'Teledyne Technologies' },
    { t:'TER', n:'Teradyne' }, { t:'TPL', n:'Texas Pacific Land' }, { t:'TXT', n:'Textron' },
    { t:'TKO', n:'TKO Group Holdings' }, { t:'TTD', n:'Trade Desk' }, { t:'TSCO', n:'Tractor Supply' },
    { t:'TT', n:'Trane Technologies' }, { t:'TDG', n:'TransDigm Group' }, { t:'TRMB', n:'Trimble' },
    { t:'TFC', n:'Truist Financial' }, { t:'TYL', n:'Tyler Technologies' }, { t:'TSN', n:'Tyson Foods' },
    { t:'UDR', n:'UDR' }, { t:'ULTA', n:'Ulta Beauty' }, { t:'UPS', n:'United Parcel Service' },
    { t:'URI', n:'United Rentals' }, { t:'UHS', n:'Universal Health Services' }, { t:'VEEV', n:'Veeva Systems' },
    { t:'VTR', n:'Ventas' }, { t:'VLTO', n:'Veralto' }, { t:'VRSN', n:'Verisign' },
    { t:'VRSK', n:'Verisk Analytics' }, { t:'VRT', n:'Vertiv' }, { t:'VTRS', n:'Viatris' },
    { t:'VICI', n:'Vici Properties' }, { t:'VST', n:'Vistra Corp.' }, { t:'VMC', n:'Vulcan Materials' },
    { t:'WRB', n:'W. R. Berkley' }, { t:'GWW', n:'W. W. Grainger' }, { t:'WAB', n:'Wabtec' },
    { t:'WBD', n:'Warner Bros. Discovery' }, { t:'WM', n:'Waste Management' }, { t:'WAT', n:'Waters' },
    { t:'WEC', n:'WEC Energy Group' }, { t:'WELL', n:'Welltower' }, { t:'WST', n:'West Pharmaceutical Services' },
    { t:'WDC', n:'Western Digital' }, { t:'WY', n:'Weyerhaeuser' }, { t:'WSM', n:'Williams-Sonoma' },
    { t:'WMB', n:'Williams Companies' }, { t:'WTW', n:'Willis Towers Watson' }, { t:'WYNN', n:'Wynn Resorts' },
    { t:'XEL', n:'Xcel Energy' }, { t:'XYL', n:'Xylem' }, { t:'ZBRA', n:'Zebra Technologies' },
    { t:'ZBH', n:'Zimmer Biomet' },
  ],
  kr: [
    // 시총 Top 30
    { t:'005930.KS', n:'삼성전자' },     { t:'000660.KS', n:'SK하이닉스' },   { t:'373220.KS', n:'LG에너지솔루션' },
    { t:'207940.KS', n:'삼성바이오로직스' },{ t:'005380.KS', n:'현대차' },     { t:'035420.KS', n:'NAVER' },
    { t:'005935.KS', n:'삼성전자우' },    { t:'068270.KS', n:'셀트리온' },    { t:'105560.KS', n:'KB금융' },
    { t:'035720.KS', n:'카카오' },        { t:'055550.KS', n:'신한지주' },    { t:'012330.KS', n:'현대모비스' },
    { t:'028260.KS', n:'삼성물산' },      { t:'005490.KS', n:'POSCO홀딩스' }, { t:'329180.KS', n:'HD현대중공업' },
    { t:'066570.KS', n:'LG전자' },        { t:'003550.KS', n:'LG' },         { t:'015760.KS', n:'한국전력' },
    { t:'032830.KS', n:'삼성생명' },      { t:'017670.KS', n:'SK텔레콤' },    { t:'086790.KS', n:'하나금융지주' },
    { t:'138040.KS', n:'메리츠금융지주' },{ t:'009150.KS', n:'삼성전기' },    { t:'010130.KS', n:'고려아연' },
    { t:'006400.KS', n:'삼성SDI' },       { t:'051910.KS', n:'LG화학' },     { t:'096770.KS', n:'SK이노베이션' },
    { t:'000270.KS', n:'기아' },          { t:'003670.KS', n:'포스코퓨처엠' },{ t:'010140.KS', n:'삼성중공업' },
    // 방산·우주·조선
    { t:'012450.KS', n:'한화에어로스페이스' }, { t:'047810.KS', n:'KAI' },
    { t:'079550.KS', n:'LIG넥스원' },        { t:'064350.KS', n:'현대로템' },
    { t:'009540.KS', n:'HD한국조선해양' },    { t:'042660.KS', n:'한화오션' },
    // 바이오·제약
    { t:'326030.KS', n:'SK바이오팜' },   { t:'196170.KQ', n:'알테오젠' },    { t:'128940.KS', n:'한미약품' },
    // 게임·콘텐츠·엔터
    { t:'259960.KS', n:'크래프톤' },     { t:'036570.KS', n:'엔씨소프트' },   { t:'251270.KS', n:'넷마블' },
    { t:'352820.KS', n:'하이브' },       { t:'041510.KQ', n:'SM' },          { t:'122870.KQ', n:'YG' },
    // 핀테크·금융
    { t:'323410.KS', n:'카카오뱅크' },   { t:'316140.KS', n:'우리금융지주' }, { t:'024110.KS', n:'기업은행' },
    // 화학·정유·소재
    { t:'011170.KS', n:'롯데케미칼' },   { t:'247540.KQ', n:'에코프로비엠' }, { t:'086520.KQ', n:'에코프로' },
    // 통신·플랫폼
    { t:'030200.KS', n:'KT' },           { t:'032640.KS', n:'LG유플러스' },
    // K-뷰티·소비재
    { t:'090430.KS', n:'아모레퍼시픽' }, { t:'161890.KS', n:'한국콜마' },
    // 유통
    { t:'139480.KS', n:'이마트' },       { t:'023530.KS', n:'롯데쇼핑' },    { t:'097950.KS', n:'CJ제일제당' },
    // 기타 시총 상위
    { t:'011200.KS', n:'HMM' },          { t:'086280.KS', n:'현대글로비스' },
    { t:'042700.KS', n:'한미반도체' },   { t:'009830.KS', n:'한화솔루션' },
    // 금융·지주 (추가)
    { t:'000810.KS', n:'삼성화재' },     { t:'034730.KS', n:'SK' },          { t:'078930.KS', n:'GS' },
    { t:'004990.KS', n:'롯데지주' },     { t:'001040.KS', n:'CJ' },
    // 반도체·전자·IT서비스 (추가)
    { t:'018260.KS', n:'삼성에스디에스' },{ t:'011070.KS', n:'LG이노텍' },     { t:'034220.KS', n:'LG디스플레이' },
    { t:'402340.KS', n:'SK스퀘어' },
    // 정유·에너지·전력기기 (추가)
    { t:'010950.KS', n:'S-Oil' },        { t:'010120.KS', n:'LS ELECTRIC' },  { t:'267260.KS', n:'HD현대일렉트릭' },
    { t:'034020.KS', n:'두산에너빌리티' },{ t:'112610.KS', n:'씨에스윈드' },
    // 건설·조선·부품 (추가)
    { t:'000720.KS', n:'현대건설' },     { t:'011790.KS', n:'SKC' },          { t:'018880.KS', n:'한온시스템' },
    // 바이오·미용·게임 (추가)
    { t:'000100.KS', n:'유한양행' },     { t:'145020.KQ', n:'휴젤' },         { t:'214150.KQ', n:'클래시스' },
    { t:'293490.KQ', n:'카카오게임즈' },
    // 소비재 (추가)
    { t:'271560.KS', n:'오리온' },     { t:'003230.KS', n:'삼양식품' },     { t:'007310.KS', n:'오뚜기' },
    // 항공·운송·물류 (추가2)
    { t:'003490.KS', n:'대한항공' },     { t:'000120.KS', n:'CJ대한통운' },
    // 지주·종합상사 (추가2)
    { t:'000880.KS', n:'한화' },         { t:'006260.KS', n:'LS' },           { t:'267250.KS', n:'HD현대' },
    // 증권·보험·금융지주 (추가2)
    { t:'006800.KS', n:'미래에셋증권' },  { t:'016360.KS', n:'삼성증권' },      { t:'071050.KS', n:'한국금융지주' },
    { t:'138930.KS', n:'BNK금융지주' },  { t:'175330.KS', n:'JB금융지주' },    { t:'088350.KS', n:'한화생명' },
    { t:'001450.KS', n:'현대해상' },
    // 화학·소재·2차전지 (추가2)
    { t:'020150.KS', n:'롯데에너지머티리얼즈' }, { t:'010060.KS', n:'OCI홀딩스' }, { t:'011780.KS', n:'금호석유' },
    { t:'004000.KS', n:'롯데정밀화학' }, { t:'298040.KS', n:'효성첨단소재' },  { t:'005070.KS', n:'코스모신소재' },
    { t:'357780.KQ', n:'솔브레인' },
    // 반도체·부품·장비 (추가2)
    { t:'240810.KQ', n:'원익IPS' },      { t:'000990.KS', n:'DB하이텍' },      { t:'348210.KQ', n:'넥스틴' },
    // 자동차부품·조선·철강 (추가2)
    { t:'011210.KS', n:'현대위아' },      { t:'097230.KS', n:'HJ중공업' },      { t:'004020.KS', n:'현대제철' },
    // 유통 (추가2)
    { t:'004170.KS', n:'신세계' },       { t:'007070.KS', n:'GS리테일' },      { t:'069960.KS', n:'현대백화점' },
    { t:'282330.KQ', n:'BGF리테일' },
    // HLB 그룹 (추가2)
    { t:'028300.KQ', n:'HLB' },          { t:'047920.KQ', n:'HLB제약' },       { t:'067630.KQ', n:'HLB생명과학' },
    { t:'115450.KQ', n:'HLB테라퓨틱스' }, { t:'046210.KQ', n:'HLB파나진' },     { t:'003580.KS', n:'HLB글로벌' },
    { t:'024850.KQ', n:'HLB이노베이션' }, { t:'278650.KQ', n:'HLB바이오스텝' },

    // ─── 코스피·코스닥 시총 top100 나머지 (히트맵 확장, 2026-07 기준) ───
    { t:'000150.KS', n:'두산' }, { t:'033780.KS', n:'KT&G' }, { t:'278470.KS', n:'에이피알' },
    { t:'272210.KS', n:'한화시스템' }, { t:'307950.KS', n:'현대오토에버' }, { t:'005940.KS', n:'NH투자증권' },
    { t:'005830.KS', n:'DB손해보험' }, { t:'028050.KS', n:'삼성E&A' }, { t:'161390.KS', n:'한국타이어앤테크놀로지' },
    { t:'039490.KS', n:'키움증권' }, { t:'443060.KS', n:'HD현대마린솔루션' }, { t:'180640.KS', n:'한진칼' },
    { t:'047050.KS', n:'포스코인터내셔널' }, { t:'007660.KS', n:'이수페타시스' }, { t:'064400.KS', n:'LG씨엔에스' },
    { t:'047040.KS', n:'대우건설' }, { t:'021240.KS', n:'코웨이' }, { t:'241560.KS', n:'두산밥캣' },
    { t:'267270.KS', n:'HD건설기계' }, { t:'001440.KS', n:'대한전선' }, { t:'062040.KS', n:'산일전기' },
    { t:'029780.KS', n:'삼성카드' }, { t:'353200.KS', n:'대덕전자' }, { t:'377300.KS', n:'카카오페이' },
    { t:'277810.KQ', n:'레인보우로보틱스' }, { t:'036930.KQ', n:'주성엔지니어링' }, { t:'950160.KQ', n:'코오롱티슈진' },
    { t:'058470.KQ', n:'리노공업' }, { t:'298380.KQ', n:'에이비엘바이오' }, { t:'141080.KQ', n:'리가켐바이오' },
    { t:'000250.KQ', n:'삼천당제약' }, { t:'039030.KQ', n:'이오테크닉스' }, { t:'319660.KQ', n:'피에스케이' },
    { t:'087010.KQ', n:'펩트론' }, { t:'222800.KQ', n:'심텍' }, { t:'347850.KQ', n:'디앤디파마텍' },
    { t:'214450.KQ', n:'파마리서치' }, { t:'214370.KQ', n:'케어젠' }, { t:'440110.KQ', n:'파두' },
    { t:'403870.KQ', n:'HPSP' }, { t:'084370.KQ', n:'유진테크' }, { t:'310210.KQ', n:'보로노이' },
    { t:'095340.KQ', n:'ISC' }, { t:'108490.KQ', n:'로보티즈' }, { t:'178320.KQ', n:'서진시스템' },
    { t:'080220.KQ', n:'제주반도체' }, { t:'095610.KQ', n:'테스' }, { t:'031980.KQ', n:'피에스케이홀딩스' },
    { t:'237690.KQ', n:'에스티팜' }, { t:'226950.KQ', n:'올릭스' }, { t:'064760.KQ', n:'티씨케이' },
    { t:'131290.KQ', n:'티에스이' }, { t:'257720.KQ', n:'실리콘투' }, { t:'319400.KQ', n:'현대무벡스' },
    { t:'067310.KQ', n:'하나마이크론' }, { t:'005290.KQ', n:'동진쎄미켐' }, { t:'263750.KQ', n:'펄어비스' },
    { t:'089970.KQ', n:'브이엠' }, { t:'290650.KQ', n:'엘앤씨바이오' }, { t:'131970.KQ', n:'두산테스나' },
    { t:'035900.KQ', n:'JYP Ent.' }, { t:'032820.KQ', n:'우리기술' }, { t:'098460.KQ', n:'고영' },
    { t:'068760.KQ', n:'셀트리온제약' }, { t:'140860.KQ', n:'파크시스템스' }, { t:'420770.KQ', n:'기가비스' },
    { t:'140410.KQ', n:'메지온' }, { t:'010170.KQ', n:'대한광통신' }, { t:'058610.KQ', n:'에스피지' },
    { t:'082920.KQ', n:'비츠로셀' }, { t:'089030.KQ', n:'테크윙' }, { t:'096530.KQ', n:'씨젠' },
    { t:'083650.KQ', n:'비에이치아이' }, { t:'183300.KQ', n:'코미코' }, { t:'218410.KQ', n:'RFHIC' },
    { t:'007390.KQ', n:'네이처셀' }, { t:'043260.KQ', n:'성호전자' }, { t:'030530.KQ', n:'원익홀딩스' },
    { t:'060370.KQ', n:'LS마린솔루션' }, { t:'458870.KQ', n:'씨어스' }, { t:'127120.KQ', n:'제이에스링크' },
    { t:'078600.KQ', n:'대주전자재료' }, { t:'039200.KQ', n:'오스코텍' }, { t:'323280.KQ', n:'태성' },
    { t:'195940.KQ', n:'HK이노엔' }, { t:'003380.KQ', n:'하림지주' }, { t:'475830.KQ', n:'오름테라퓨틱' },
    { t:'347700.KQ', n:'스피어' }, { t:'031330.KQ', n:'에스에이엠티' }, { t:'437730.KQ', n:'삼현' },
    { t:'166090.KQ', n:'하나머티리얼즈' }, { t:'101490.KQ', n:'에스앤에스텍' }, { t:'085660.KQ', n:'차바이오텍' },
    { t:'491000.KQ', n:'리브스메드' }, { t:'232140.KQ', n:'와이씨' }, { t:'204270.KQ', n:'제이앤티씨' },
    { t:'241710.KQ', n:'코스메카코리아' }, { t:'038500.KQ', n:'삼표시멘트' }, { t:'100790.KQ', n:'미래에셋벤처투자' },
    { t:'417200.KQ', n:'LS머트리얼즈' }, { t:'086450.KQ', n:'동국제약' }, { t:'099320.KQ', n:'쎄트렉아이' },
    { t:'281740.KQ', n:'레이크머티리얼즈' }, { t:'090710.KQ', n:'휴림로봇' }, { t:'036540.KQ', n:'SFA반도체' },
    { t:'019210.KQ', n:'와이지-원' }, { t:'388720.KQ', n:'유일로보틱스' }, { t:'328130.KQ', n:'루닛' },
    { t:'083450.KQ', n:'GST' }, { t:'065350.KQ', n:'신성델타테크' }, { t:'074600.KQ', n:'원익QnC' },
    { t:'056190.KQ', n:'SFA' }, { t:'137400.KQ', n:'피엔티' },
  ],
};

// ─── 히트맵 섹터 뷰 (GICS 11개 섹터 + 기타) — HEATMAP_TICKERS.us/kr 전 종목을
// 섹터별로 분류. 1단계(섹터 박스) 클릭 시 2단계(해당 섹터 종목만 필터링)로 드릴다운.
// 완벽한 GICS 세부 분류가 아닌 최선근사치 — 크로스오버 케이스(예: PYPL 금융 vs 기술)는
// 통상적 분류 기준을 따름.
const SECTOR_META = {
  tech:          { label: '기술' },
  comm:          { label: '통신서비스' },
  discretionary: { label: '임의소비재' },
  staples:       { label: '필수소비재' },
  financial:     { label: '금융' },
  health:        { label: '헬스케어' },
  industrial:    { label: '산업재' },
  energy:        { label: '에너지' },
  materials:     { label: '소재' },
  utilities:     { label: '유틸리티' },
  realestate:    { label: '리츠' },
  other:         { label: '기타' },
};
const SECTOR_ORDER = ['tech','comm','discretionary','staples','financial','health','industrial','energy','materials','utilities','realestate','other'];
const SECTOR_GROUPS = {
  tech: [
    'AAPL','MSFT','NVDA','AVGO','ORCL','AMD','CSCO','INTC','QCOM','TXN','MU','PLTR','SNOW','NOW',
    'ASML','TSM','ARM','LRCX','AMAT','KLAC','SHOP','PANW','CRWD','NET','IBM','ACN','ADBE','CRM',
    'MRVL','ON','MCHP','ADI','SWKS','NXPI','ANET','DDOG','MDB','TEAM','WDAY','OKTA','ZS','FTNT',
    'CDNS','SNPS','INTU','ADSK','KEYS','TER','GEN','FICO','GDDY','AKAM','FFIV','JBL','FLEX','HPQ',
    'HPE','DELL','STX','WDC','SMCI','APH','GLW','TRMB','ZBRA','NTAP','CIEN','LITE','COHR','MPWR',
    'VRSN','CTSH','IT','MSI','CDW','TYL','PTC','FSLR','JKHY','VEEV','TEL','Q',
    'SNDK','NVDL','NOWL','ARMG','QUBT','BTBT','SKHY',
    '005930.KS','000660.KS','005935.KS','009150.KS','018260.KS','011070.KS','034220.KS','402340.KS',
    '042700.KS','240810.KQ','000990.KS','348210.KQ','007660.KS','064400.KS','353200.KS',
    '036930.KQ','058470.KQ','039030.KQ','319660.KQ','222800.KQ','440110.KQ','403870.KQ','084370.KQ',
    '095340.KQ','178320.KQ','080220.KQ','095610.KQ','031980.KQ','064760.KQ','131290.KQ','067310.KQ',
    '131970.KQ','098460.KQ','140860.KQ','420770.KQ','010170.KQ','089030.KQ','183300.KQ','218410.KQ',
    '043260.KQ','030530.KQ','232140.KQ','204270.KQ','036540.KQ','083450.KQ','074600.KQ',
    '347700.KQ','031330.KQ',
  ],
  comm: [
    'GOOG','GOOGL','META','NFLX','DIS','CMCSA','CHTR','T','VZ','TMUS','FOXA','FOX','NWSA','NWS',
    'LYV','TTWO','EA','OMC','TKO','ECHO','APP','TTD','PSKY','WBD',
    '035420.KS','035720.KS','017670.KS','259960.KS','036570.KS','251270.KS','352820.KS','041510.KQ',
    '122870.KQ','030200.KS','032640.KS','293490.KQ','263750.KQ','035900.KQ',
  ],
  discretionary: [
    'AMZN','TSLA','HD','MCD','NKE','SBUX','LOW','TJX','CMG','YUM','DASH','ETSY','BKNG','MAR','HLT',
    'RCL','CCL','NCLH','WYNN','MGM','LVS','ORLY','AZO','ROST','ULTA','LULU','DECK','RL','TPR','WSM',
    'DHI','LEN','NVR','GRMN','F','GM','RIVN','APTV','BBY','EBAY','EXPE','DPZ','TSCO','HAS','GPC',
    'ABNB','UBER','CVNA','TSLL','TGT','DRI','PHM',
    '005380.KS','012330.KS','066570.KS','000270.KS','023530.KS','018880.KS','011210.KS','004170.KS',
    '069960.KS','278470.KS','161390.KS','021240.KS',
  ],
  staples: [
    'WMT','PG','COST','KO','PEP','MDLZ','KHC','CL','KMB','EL','MNST','STZ','GIS','HSY','SYY','TSN',
    'TAP','ADM','HRL','CHD','CLX','KR','DG','DLTR','BG','CASY','KVUE','MKC','PM','MO','SJM','BF-B','KDP',
    '090430.KS','161890.KS','139480.KS','097950.KS','033780.KS','271560.KS','003230.KS','007310.KS',
    '007070.KS','282330.KQ','003380.KQ','257720.KQ','241710.KQ',
  ],
  financial: [
    'JPM','BAC','WFC','GS','MS','C','USB','PNC','TFC','KEY','FITB','HBAN','CFG','MTB','STT','BNY',
    'BLK','BX','KKR','APO','ARES','TROW','IVZ','BEN','RJF','SCHW','IBKR','HOOD','AON','MRSH','AJG',
    'PGR','TRV','MET','AIG','ALL','HIG','CINF','CB','ACGL','WRB','L','GL','ERIE','AIZ','EG','PFG',
    'PRU','COF','NTRS','SYF','AMP','V','MA','AXP','PYPL','GPN','FIS','FISV','MSCI','MCO','ICE',
    'CME','CBOE','NDAQ','SPGI','BR','BRO','CPAY','FDS','USBC',
    'BRK-B','AFL','COIN','XYZ','RF','WTW',
    '105560.KS','055550.KS','032830.KS','086790.KS','138040.KS','323410.KS','316140.KS','024110.KS',
    '000810.KS','006800.KS','016360.KS','071050.KS','138930.KS','175330.KS','088350.KS','001450.KS',
    '005940.KS','005830.KS','039490.KS','029780.KS','377300.KS','100790.KQ',
  ],
  health: [
    'UNH','LLY','ABBV','MRK','TMO','PFE','JNJ','ABT','DHR','ISRG','GILD','VRTX','CVS','CI','ELV',
    'BMY','AMGN','REGN','ZTS','BSX','MDT','SYK','HCA','DXCM','IDXX','IQV','MRNA','INCY','PODD','RMD',
    'DVA','RVTY','CRL','CAH','COR','MCK','HSIC','BAX','BDX','TECH','BIIB','ALGN','EW','GEHC',
    'LH','DGX','MTD','WAT','WST','STE','SOLV','HUM','CNC','UHS','VTRS','A','NVO','COO','ZBH',
    '207940.KS','068270.KS','326030.KS','196170.KQ','128940.KS','000100.KS','145020.KQ','214150.KQ',
    '028300.KQ','047920.KQ','067630.KQ','115450.KQ','046210.KQ','003580.KS','024850.KQ','278650.KQ',
    '950160.KQ','298380.KQ','141080.KQ','000250.KQ','087010.KQ','347850.KQ','214450.KQ','214370.KQ',
    '310210.KQ','096530.KQ','068760.KQ','458870.KQ','039200.KQ','195940.KQ','475830.KQ','085660.KQ',
    '491000.KQ','086450.KQ','328130.KQ','089970.KQ','290650.KQ','237690.KQ','226950.KQ',
    '140410.KQ','007390.KQ',
  ],
  industrial: [
    'BA','CAT','GE','LMT','MMM','UNP','CSX','NSC','DAL','UAL','LUV','EMR','ETN','ITW','RTX','HON',
    'DE','ADP','PAYX','UPS','FDX','WM','RSG','CTAS','ROL','CPRT','ODFL','JBHT','CHRW','EXPD','URI',
    'PWR','AME','DOV','XYL','IEX','ROK','PH','CMI','GD','NOC','LHX','HII','TDG','TXT','HWM','GEV',
    'CARR','JCI','OTIS','IR','GNRC','FTV','GWW','MAS','ALLE','AOS','BLDR','PNR','SNA','SWK','WAB',
    'AXON','VRSK','LDOS','J','NDSN','FIX','EME','HUBB','TT','EFX','FAST','FDXF',
    'HONA','LII','PCAR','ROP','TDY','VLTO','VRT',
    '373220.KS','329180.KS','003550.KS','028260.KS','010140.KS','012450.KS','047810.KS','079550.KS',
    '064350.KS','009540.KS','042660.KS','011200.KS','086280.KS','034730.KS','078930.KS','004990.KS',
    '001040.KS','010120.KS','267260.KS','034020.KS','112610.KS','000720.KS','003490.KS','000120.KS',
    '000880.KS','006260.KS','267250.KS','097230.KS','272210.KS','307950.KS','028050.KS','443060.KS',
    '180640.KS','047050.KS','047040.KS','241560.KS','267270.KS','001440.KS','062040.KS','277810.KQ',
    '000150.KS',
    '108490.KQ','319400.KQ','032820.KQ','058610.KQ','082920.KQ','083650.KQ','060370.KQ','127120.KQ',
    '323280.KQ','437730.KQ','099320.KQ','090710.KQ','019210.KQ','388720.KQ','065350.KQ','056190.KQ',
    '137400.KQ',
  ],
  energy: [
    'XOM','CVX','COP','SLB','EOG','VLO','HAL','OXY','PSX','MPC','KMI','WMB','OKE','TRGP','EQT','DVN',
    'FANG','EXE','APA','BKR','TPL','BATL',
    '096770.KS','010950.KS',
  ],
  materials: [
    'LIN','APD','ECL','SHW','FCX','NEM','NUE','STLD','DOW','DD','LYB','PPG','ALB','MLM','VMC','CF',
    'MOS','IFF','CTVA','BALL','AVY','PKG','IP','CRH','AMCR','SW',
    '005490.KS','010130.KS','006400.KS','051910.KS','003670.KS','011170.KS','247540.KQ','086520.KQ',
    '020150.KS','010060.KS','011780.KS','004000.KS','298040.KS','005070.KS','357780.KQ','011790.KS',
    '004020.KS','009830.KS','005290.KQ','166090.KQ','101490.KQ','417200.KQ','281740.KQ','038500.KQ',
    '078600.KQ',
  ],
  utilities: [
    'NEE','DUK','SO','D','AEP','EXC','XEL','SRE','ED','PEG','WEC','ES','DTE','PPL','FE','EIX','ETR',
    'CMS','CNP','AEE','EVRG','ATO','NI','PNW','PCG','NRG','VST','CEG','LNT','AWK','AES',
    '015760.KS',
  ],
  realestate: [
    'PLD','AMT','EQIX','DLR','O','SPG','PSA','WELL','VTR','ARE','AVB','EQR','ESS','MAA','CPT','UDR',
    'INVH','EXR','IRM','BXP','KIM','REG','FRT','HST','VICI','DOC','CBRE','CSGP','CCI','SBAC','WY',
  ],
  other: ['NASA'],
};
const TICKER_SECTOR = {};
for (const sec of SECTOR_ORDER) for (const t of (SECTOR_GROUPS[sec] || [])) TICKER_SECTOR[t] = sec;
const sectorOf = (t) => TICKER_SECTOR[t] || 'other';

let _hmMkt = 'us', _hmRange = '1d';
let _hmView = 'sector';   // 'sector'(1단계 섹터 박스) | 'all'(전체 플랫 리스트) — 히트맵 진입 시 기본은 섹터 뷰
let _hmSectorDrill = null; // 2단계 드릴다운 중인 섹터 키 (null이면 1단계)
let _hmMobileExpanded = false;   // 모바일에서 "더보기" 눌러 전체 표시했는지 (탭 전환 시 초기화)
const HM_MOBILE_LIMIT = 30;       // 모바일 초기 표시 개수 — us(525)/kr(236)를 그대로 세로 스크롤하면 끝이 없어 상단만 먼저 보여줌
const isNarrowViewport = () => window.matchMedia('(max-width: 700px)').matches;

function switchHeatmap(mkt, range) {
  if (mkt)   _hmMkt = mkt;
  if (range) _hmRange = range;
  _hmMobileExpanded = false;
  _hmSectorDrill = null;
  document.querySelectorAll('.hm-mkt').forEach(b => b.classList.toggle('active', b.dataset.mkt === _hmMkt));
  document.querySelectorAll('.hm-range').forEach(b => b.classList.toggle('active', b.dataset.range === _hmRange));
  updateHeatmapViewToggleUI();
  loadHeatmap();
}

// us/kr 탭에서만 섹터 드릴다운 뷰가 의미 있음 (sector=SPDR ETF, etf, assets 탭은 이미 단일 리스트)
const heatmapSectorApplicable = () => (_hmMkt === 'us' || _hmMkt === 'kr');

function switchHeatmapView(view) {
  _hmView = view;
  _hmSectorDrill = null;
  updateHeatmapViewToggleUI();
  loadHeatmap();
}

function heatmapDrillSector(sec) {
  _hmSectorDrill = sec;
  loadHeatmap();
}

function heatmapSectorBack() {
  _hmSectorDrill = null;
  loadHeatmap();
}

function updateHeatmapViewToggleUI() {
  const wrap = document.getElementById('heatmapViewToggle');
  if (!wrap) return;
  wrap.style.display = heatmapSectorApplicable() ? '' : 'none';
  wrap.querySelectorAll('.hm-view').forEach(b => b.classList.toggle('active', b.dataset.view === _hmView));
}

function expandHeatmapMobile() {
  _hmMobileExpanded = true;
  _hmStructureKey = '';   // 강제 리렌더 트리거
  loadHeatmap();
}

// 개별 종목 셀 클릭 동작 — 주식이면 company.html, 지수·자산·FX·크립토는 새창 TradingView
const hmCellHref = (t) => {
  if (/^\^/.test(t) || /=F$/.test(t) || /=X$/.test(t) || /-USD$/.test(t) || /^DX-Y/.test(t) || /\.SS$/.test(t)) {
    return '#';  // 자산은 별도 처리
  }
  return `/company.html?ticker=${encodeURIComponent(t)}`;
};
const hmCellOnClick = (t) => {
  if (hmCellHref(t) === '#') {
    return `onclick="event.preventDefault();openTickerInTradingView('${escAttr(t)}')"`;
  }
  return '';
};

const HM_SESSION_BADGE = {
  pre:  { label: '🟡 프리',   color: '#f0b45e' },
  post: { label: '🟣 애프터', color: '#9d7bff' },
};

// ─── Finviz 스타일 트리맵 (2026-07-27) ────────────────────────────────
// 섹터로 묶고, 박스 크기는 Finviz와 동일하게 **시가총액** 비례.
// 시총 = 실시간 가격 × 상장주식수. Yahoo v8 chart 응답엔 시총도 주식수도 없고 Yahoo v7·FMP는
// 막혀 있어서, Toss meta(action=meta)가 주는 sharesOutstanding을 쓴다. 원래는 전 종목 한 번
// 긁어 /data/shares-outstanding.json 정적 파일로만 커밋해뒀는데, 그러면 이후 신규 상장·
// 히트맵 종목 추가 시 수동으로 다시 긁어 재배포해야 했다 — 이제 `shares_outstanding` 테이블
// (db/shares-outstanding.sql)에 저장해두고 cron-daily가 주 1회(핸들러 자체 신선도가드) 자동
// 갱신한다(api/admin.js handleCrawlSharesOutstanding). 주식수는 분기 단위로만 바뀌므로
// 캐시로 충분하고, 가격은 실시간이라 시총도 실시간이다. 종목당 1콜(762콜)인 라이브 조회를
// 완전히 없애면서 정확한 시총 정렬을 얻는 방식. 주식수가 없는 종목은 거래대금으로 폴백
// (박스가 사라지지 않게). 정적 스냅샷을 baseline으로 깔고 DB 값으로 덮어쓰는 **병합** 방식 —
// (한쪽만 택하는 방식이면 DB 응답이 s-maxage=86400 CDN 캐시라 크롤 직후에도 최대 하루간
// 예전 스냅샷을 계속 돌려줄 수 있어, 그사이 신규 종목이 오히려 통째로 빠지는 역효과가 있었다)
// DB가 비어 있거나 실패해도 baseline은 항상 762개 그대로 남으므로 히트맵이 비는 일은 없고,
// DB가 일부만 갱신됐어도(크롤 진행 중 등) 그만큼만 정확도가 올라간다.
let _sharesOutstanding = null, _soPromise = null;
function loadSharesOutstanding() {
  if (_sharesOutstanding) return Promise.resolve(_sharesOutstanding);
  if (!_soPromise) {
    _soPromise = Promise.all([
      fetch('/data/shares-outstanding.json').then(r => r.ok ? r.json() : {}).catch(() => ({})),
      fetch('/api/admin?action=shares-outstanding').then(r => r.ok ? r.json() : { ok: false }).catch(() => ({ ok: false })),
    ]).then(([staticSnap, dbResp]) => (_sharesOutstanding = { ...staticSnap, ...(dbResp.ok ? dbResp.data : {}) }));
  }
  return _soPromise;
}
// 레이아웃은 이분할(binary split) 트리맵 — squarified만큼 정사각에 가깝진 않지만 코드가
// 훨씬 짧고 이 규모(섹터당 수십 개)에선 시각적 차이가 거의 없다.
function _tmLayout(list, x, y, w, h) {
  const out = [];
  const rec = (arr, x, y, w, h) => {
    if (!arr.length || w <= 0 || h <= 0) return;
    if (arr.length === 1) { out.push({ it: arr[0], x, y, w, h }); return; }
    const total = arr.reduce((s, d) => s + d._v, 0);
    if (total <= 0) return;
    let acc = 0, i = 0;
    for (; i < arr.length - 1; i++) {
      if (acc + arr[i]._v > total / 2) break;
      acc += arr[i]._v;
    }
    const a = arr.slice(0, i + 1), b = arr.slice(i + 1);
    const frac = a.reduce((s, d) => s + d._v, 0) / total;
    if (w >= h) { rec(a, x, y, w * frac, h); rec(b, x + w * frac, y, w * (1 - frac), h); }
    else { rec(a, x, y, w, h * frac); rec(b, x, y + h * frac, w, h * (1 - frac)); }
  };
  rec(list, x, y, w, h);
  return out;
}

// 박스 크기에 따라 표시 정보를 단계적으로 줄인다(작은 박스에 글자가 넘치지 않게).
function _tmTileHtml(node, isKr) {
  const { it, x, y, w, h } = node;
  const c = heatmapColorFor(it.pct);
  const sign = it.pct >= 0 ? '+' : '';
  const pctTxt = `${sign}${it.pct.toFixed(2)}%`;
  const showPct = w > 5.5 && h > 7;
  const showName = w > 7 && h > 11;
  // 본문 12px 미만 금지(접근성 기준) — 박스가 작아 다 안 들어가면 글자를 줄이는
  // 대신 말줄임표(ellipsis)로 잘라낸다(showName/showPct 자체가 아주 작은 박스는 숨김).
  const nameSize = w > 16 ? 15 : w > 11 ? 13 : 12;
  const pctSize = w > 16 ? 13 : w > 11 ? 12.5 : 12;
  const label = showName
    ? `<div style="font-weight:800;font-size:${nameSize}px;line-height:1.15;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escAttr(it.name)}</div>` : '';
  const pctHtml = showPct
    ? `<div class="t-num" style="font-weight:700;font-size:${pctSize}px;line-height:1.2;opacity:.95">${pctTxt}</div>` : '';
  return `<a class="tm-tile" href="${hmCellHref(it.ticker)}" ${hmCellOnClick(it.ticker)}
    title="${escAttr(it.name)} ${pctTxt}"
    style="position:absolute;left:${x}%;top:${y}%;width:${w}%;height:${h}%;background:${c.bg};color:${c.fg};
      display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;
      text-decoration:none;overflow:hidden;padding:2px;box-sizing:border-box;
      border:1px solid rgba(0,0,0,.35);transition:filter .12s"
    onmouseover="this.style.filter='brightness(1.25)'" onmouseout="this.style.filter=''">${label}${pctHtml}</a>`;
}

const TM_MAX_TILES = 120;   // 이보다 많으면 박스가 20px 미만으로 뭉개져 라벨이 아예 안 보인다
function renderHeatmapTreemap(grid, items) {
  if (!items.length) { grid.innerHTML = '<div style="color:var(--text3);padding:20px;text-align:center">데이터가 없어요.</div>'; return; }
  const isKr = _hmMkt === 'kr';
  const isNarrow = window.innerWidth <= 700;
  const limit = isNarrow ? 42 : TM_MAX_TILES;   // 모바일은 타일 수를 더 줄여 12px 폰트가 들어갈 여유를 준다
  const totalCount = items.length;
  // 시총 상위만 — 전 종목(500+)을 한 화면에 넣으면 타일이 6px까지 작아져 못 읽는다.
  const so = _sharesOutstanding || {};
  const withVal = items
    .map(it => {
      const shares = so[it.ticker];
      const mcap = (shares && it.price != null) ? shares * it.price : 0;
      return { ...it, _mcap: mcap, _v: Math.max(1, mcap || it.tradingValue || 0) };
    })
    .sort((a, b) => b._v - a._v)
    .slice(0, limit);
  // 섹터 그룹핑 → 섹터 총 거래대금 순
  const groups = {};
  for (const it of withVal) {
    const s = sectorOf(it.ticker) || 'other';
    (groups[s] ||= []).push(it);
  }
  const sectorList = Object.entries(groups).map(([key, arr]) => ({
    key, arr: arr.sort((a, b) => b._v - a._v), _v: arr.reduce((s, d) => s + d._v, 0),
  })).sort((a, b) => b._v - a._v);

  const secNodes = _tmLayout(sectorList, 0, 0, 100, 100);
  const HEAD = 18; // 섹터 라벨 띠 높이(px) — 12px 폰트가 들어갈 수 있게 15→18
  const html = secNodes.map(sn => {
    const g = sn.it;
    const label = SECTOR_META[g.key]?.label || g.key;
    const inner = _tmLayout(g.arr, 0, 0, 100, 100).map(n => _tmTileHtml(n, isKr)).join('');
    return `<div style="position:absolute;left:${sn.x}%;top:${sn.y}%;width:${sn.w}%;height:${sn.h}%;padding:1px;box-sizing:border-box">
      <div style="position:relative;width:100%;height:100%;border:1px solid rgba(255,255,255,.18);box-sizing:border-box;overflow:hidden">
        <div style="position:absolute;inset:0 0 auto 0;height:${HEAD}px;background:rgba(0,0,0,.55);color:#c9d1d9;font-size:12px;font-weight:800;letter-spacing:.02em;display:flex;align-items:center;justify-content:center;z-index:2;pointer-events:none;text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 3px;box-sizing:border-box">${escAttr(label)}</div>
        <div style="position:absolute;left:0;right:0;top:${HEAD}px;bottom:0">${inner}</div>
      </div>
    </div>`;
  }).join('');

  // 높이를 폭 비례(aspect-ratio)가 아니라 뷰포트 높이 기준으로 고정 — 페이지가 넓은
  // 모니터에서는 폭이 커질수록 aspect-ratio 방식은 높이도 같이 커져서(1600px 폭이면
  // 16:10에 1000px) 트리맵 하나가 화면 세로를 다 잡아먹었다. Finviz류 히트맵은 한눈에
  // 훑어보는 용도라 스크롤 없이 한 화면에 들어와야 의미가 있다.
  const tmHeight = isNarrow ? 'clamp(360px, 68vh, 560px)' : 'clamp(420px, 62vh, 620px)';
  grid.innerHTML = `<div class="tm-wrap" style="position:relative;width:100%;height:${tmHeight};background:#0d1117;border-radius:10px;overflow:hidden">${html}</div>
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:10px;font-size:12px;color:var(--text3);flex-wrap:wrap">
      <span>시가총액 상위 ${withVal.length}종목 / 전체 ${totalCount}</span><span style="opacity:.4">|</span>
      <span>박스 크기 = 시가총액</span><span style="opacity:.4">|</span>
      <span style="display:inline-flex;align-items:center;gap:5px">
        <i style="width:13px;height:13px;border-radius:3px;background:${heatmapColorFor(-5).bg};display:inline-block"></i>-5%
        <i style="width:13px;height:13px;border-radius:3px;background:${heatmapColorFor(0).bg};display:inline-block;margin-left:4px"></i>0%
        <i style="width:13px;height:13px;border-radius:3px;background:${heatmapColorFor(5).bg};display:inline-block;margin-left:4px"></i>+5%
      </span>
    </div>`;
}

function hmCellHtml(it) {
  const sign = it.pct >= 0 ? '+' : '';
  const priceLabel = it.price == null ? '' : (it.currency === 'KRW'
    ? '₩' + Math.round(it.price).toLocaleString('ko-KR')
    : '$' + Number(it.price).toFixed(2));
  const c = heatmapColorFor(it.pct);
  const badge = HM_SESSION_BADGE[it.session];
  const badgeHtml = badge
    ? `<div class="hm-session" style="font-size:12px;font-weight:800;opacity:.95;margin-top:1px;color:${badge.color}">${badge.label}</div>`
    : '';
  return `<a class="hm-cell" data-ticker="${escAttr(it.ticker)}" href="${hmCellHref(it.ticker)}" ${hmCellOnClick(it.ticker)} style="display:flex;flex-direction:column;justify-content:center;text-decoration:none;color:${c.fg};background:${c.bg};border-radius:12px;padding:10px 8px;text-align:center;transition:transform .12s var(--ease),background .3s,color .3s;min-height:74px;line-height:1.2;box-shadow:0 1px 2px rgba(0,0,0,0.05);cursor:pointer" onmouseover="this.style.transform='translateY(-2px) scale(1.03)'" onmouseout="this.style.transform='translateY(0) scale(1)'" title="${escAttr(it.name)}">
    <div style="font-size:13.5px;font-weight:700;letter-spacing:.2px;opacity:.95;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escAttr(it.name)}</div>
    <div class="hm-price t-num" style="font-size:13px;font-weight:500;opacity:.85;margin-top:1px">${priceLabel}</div>
    <div class="hm-pct t-num" style="font-size:15.5px;font-weight:800;margin-top:3px">${sign}${it.pct.toFixed(2)}%</div>
    ${badgeHtml}
  </a>`;
}

// 종목 타일 그리드 렌더 — "전체보기"(opts.mobileLimit)와 섹터 드릴다운 2단계(opts.backLabel) 둘 다 여기서 처리.
// needsRebuild가 false면 색/숫자만 갱신 + flash (실시간 폴링에서 깜빡임 없이 갱신하기 위함).
function renderTileGrid(grid, items, needsRebuild, structureKey, opts = {}) {
  grid.classList.add('hm-cropped');   // 종목 타일 나열 뷰(전체보기/드릴다운)는 홈 미리보기에서 크롭 대상
  if (needsRebuild) {
    const showAll = !opts.mobileLimit || !isNarrowViewport() || _hmMobileExpanded;
    const displayItems = showAll ? items : items.slice(0, HM_MOBILE_LIMIT);
    const backBtn = opts.backLabel
      ? `<button onclick="${opts.backAction}" style="grid-column:1/-1;padding:10px;margin-bottom:2px;border:1px solid var(--border);border-radius:10px;background:var(--bg2);color:var(--text2);font-size:15.5px;font-weight:700;cursor:pointer;text-align:left">← ${opts.backLabel}</button>`
      : '';
    const cellsHtml = displayItems.map(hmCellHtml).join('') || '<div style="grid-column:1/-1;text-align:center;color:var(--text3);font-size:14.5px;padding:20px">데이터 없음</div>';
    const moreBtn = (opts.mobileLimit && !showAll && items.length > HM_MOBILE_LIMIT)
      ? `<button onclick="expandHeatmapMobile()" style="grid-column:1/-1;padding:12px;margin-top:4px;border:1px dashed var(--border);border-radius:10px;background:var(--bg2);color:var(--blue);font-size:15.5px;font-weight:700;cursor:pointer">▾ ${items.length - HM_MOBILE_LIMIT}개 더보기 (전체 ${items.length}개)</button>`
      : '';
    grid.innerHTML = backBtn + cellsHtml + moreBtn;
    _hmStructureKey = structureKey;
    _hmCellState[structureKey] = {};
    items.forEach(it => { _hmCellState[structureKey][it.ticker] = it.pct; });
  } else {
    // 부분 업데이트 — 변동된 셀만 색/숫자 바꾸고 flash
    const prev = _hmCellState[structureKey] || {};
    items.forEach(it => {
      const oldPct = prev[it.ticker];
      if (oldPct === it.pct) return;  // 변화 없으면 skip
      const cell = grid.querySelector(`.hm-cell[data-ticker="${CSS.escape(it.ticker)}"]`);
      if (!cell) return;
      const sign = it.pct >= 0 ? '+' : '';
      const c = heatmapColorFor(it.pct);
      cell.style.background = c.bg;
      cell.style.color = c.fg;
      const pctEl = cell.querySelector('.hm-pct');
      if (pctEl) pctEl.textContent = `${sign}${it.pct.toFixed(2)}%`;
      const priceEl = cell.querySelector('.hm-price');
      if (priceEl && it.price != null) {
        priceEl.textContent = it.currency === 'KRW'
          ? '₩' + Math.round(it.price).toLocaleString('ko-KR')
          : '$' + Number(it.price).toFixed(2);
      }
      // 프리/애프터장 배지 동기화 — 세션이 바뀌면(장 시작 등) 배지도 새로 붙이거나 뗀다
      let sessionEl = cell.querySelector('.hm-session');
      const badge = HM_SESSION_BADGE[it.session];
      if (badge) {
        if (!sessionEl) {
          sessionEl = document.createElement('div');
          sessionEl.className = 'hm-session';
          sessionEl.style.cssText = 'font-size:12px;font-weight:800;opacity:.95;margin-top:1px';
          cell.appendChild(sessionEl);
        }
        sessionEl.style.color = badge.color;
        sessionEl.textContent = badge.label;
      } else if (sessionEl) {
        sessionEl.remove();
      }
      // flash 효과 — 상승/하락 방향에 따라
      if (oldPct != null && oldPct !== it.pct) {
        const direction = it.pct > oldPct ? 'up' : 'down';
        const flashColor = direction === 'up' ? 'rgba(255,255,0,0.4)' : 'rgba(255,255,255,0.4)';
        cell.style.boxShadow = `0 0 12px ${flashColor}, 0 1px 2px rgba(0,0,0,0.05)`;
        setTimeout(() => {
          if (cell) cell.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)';
        }, 800);
      }
      prev[it.ticker] = it.pct;
    });
    // 순위 변동도 반영 (DOM 재정렬)
    items.forEach(it => {
      const cell = grid.querySelector(`.hm-cell[data-ticker="${CSS.escape(it.ticker)}"]`);
      if (cell) grid.appendChild(cell);
    });
  }
}

// 섹터 1단계 박스 렌더 — 종목별 등락률을 GICS 섹터로 묶어 평균 등락률로 박스 하나씩 표시.
// 박스 클릭 시 heatmapDrillSector()로 2단계(해당 섹터 종목만)로 드릴다운.
function renderSectorBoxes(grid, items, structureKey) {
  grid.classList.remove('hm-cropped');   // 섹터 박스 11개는 작아서 홈 미리보기에서도 크롭 불필요
  const bySector = {};
  for (const it of items) {
    const s = sectorOf(it.ticker);
    if (!bySector[s]) bySector[s] = [];
    bySector[s].push(it);
  }
  const boxes = SECTOR_ORDER.filter(s => s !== 'other' && bySector[s]?.length).map(s => {
    const arr = bySector[s];
    const avgPct = arr.reduce((a, b) => a + b.pct, 0) / arr.length;
    const up = arr.filter(x => x.pct >= 0).length;
    const c = heatmapColorFor(avgPct);
    const sign = avgPct >= 0 ? '+' : '';
    return `<button type="button" class="hm-cell" onclick="heatmapDrillSector('${s}')" style="display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;border:none;font:inherit;cursor:pointer;color:${c.fg};background:${c.bg};border-radius:14px;padding:18px 10px;min-height:96px;transition:transform .12s var(--ease)" onmouseover="this.style.transform='translateY(-2px) scale(1.02)'" onmouseout="this.style.transform='translateY(0) scale(1)'">
      <div style="font-size:15.5px;font-weight:800;letter-spacing:.2px">${SECTOR_META[s].label}</div>
      <div class="t-num" style="font-size:21px;font-weight:800;margin-top:6px">${sign}${avgPct.toFixed(2)}%</div>
      <div style="font-size:13px;opacity:.8;margin-top:4px">${arr.length}개 종목 · 상승 ${up}</div>
    </button>`;
  }).join('');
  grid.innerHTML = boxes || '<div style="grid-column:1/-1;text-align:center;color:var(--text3);font-size:14.5px;padding:20px">데이터 없음</div>';
  _hmStructureKey = structureKey;
}

// ─── 🇰🇷 국장 요약 (지수 카드 + 인기 검색 종목 + 투자자별 수급 차트) ──
// 수급 차트는 직접 계산하지 않고 네이버 증권이 서버에서 미리 렌더링해 제공하는
// PNG를 그대로 embed(핫링크)한다 — sid= 캐시버스터로 매 새로고침마다 최신 이미지를 받음.
// 해외지수는 국장현황이 아니라 미장현황 쪽에 배치(아래 US 섹션 참고).
// 2026-07-31 재설계: /api/quotes(등락률만) → /api/indices(스파크라인 포함)로 전환하고
// 홈 대시보드의 .mkt-card 컴포넌트를 그대로 재사용한다(mktSummaryCard 참고) — 기존의
// 원형 화살표 배지 카드(krIndexCard)는 사용자 피드백으로 폐기.
const KR_INDEX_DEFS = [
  { id: 'kospi',    label: '코스피', mk: 'kr' },
  { id: 'kosdaq',   label: '코스닥', mk: 'kr' },
  { id: 'kospi200', label: '코스피200', mk: 'kr' },
];

// 억원 단위 축약 포맷 (+/- 부호 포함)
function fmtEok(v) {
  if (v == null) return '—';
  const sign = v >= 0 ? '+' : '−';
  const eok = Math.abs(v) / 1e8;
  return `${sign}${eok >= 10000 ? (eok / 10000).toFixed(1) + '조' : Math.round(eok).toLocaleString() + '억'}`;
}

// 투자자별 수급은 2026-07-31 시장현황 개편으로 kr-market.html 인라인 차트가 전담한다
// (네이버 캡처 이미지 → 토스 API 기반 자체 SVG 차트). 여기 있던 switchKrFlowChart는 제거됨.

async function loadKrSummary() {
  const cardsEl = document.getElementById('krIndexCards');
  if (!cardsEl) return;
  try {
    // /api/indices는 필터링 파라미터를 받지 않고 항상 전체 지표를 반환한다 —
    // 필요한 id만 골라 쓴다(홈 대시보드와 같은 엔드포인트를 공유해 엣지 캐시 히트율도 좋다).
    const [idxRes, searchRes] = await Promise.all([
      fetch('/api/indices').then(r => r.json()),
      fetch('/api/kr-market?type=popular-search').then(r => r.json()),
    ]);
    const q = idxRes?.data || {};

    cardsEl.innerHTML = KR_INDEX_DEFS.map(def => {
      const d = q[def.id];
      return d ? mktSummaryCard(def, d) : '';
    }).join('');

    renderKrPopularSearch(searchRes?.items || []);

    const upd = document.getElementById('krSummaryUpdatedAt');
    if (upd) upd.textContent = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) + ' 기준';
  } catch (e) {
    cardsEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--red);font-size:14.5px;padding:16px">불러오기 실패: ${escHtml(e.message)}</div>`;
  }
}

// ─── 🇺🇸 미장 요약 (지수 카드 + 비美 해외지수) ──────────────────────────
const US_INDEX_DEFS = [
  { id: 'sp500',  label: 'S&P 500', mk: 'us' },
  { id: 'nasdaq', label: '나스닥', mk: 'us' },
  { id: 'dow',    label: '다우', mk: 'us' },
];
const GLOBAL_INDEX_DEFS = [
  { id: 'kospi',  label: '코스피', mk: 'kr' },
  { id: 'kosdaq', label: '코스닥', mk: 'kr' },
  { id: 'nikkei', label: '니케이225', mk: 'us' },  // 국내 지정 카테고리 없음 — 장시간 유사한 'us' 휴리스틱으로 점만 표시
  { id: 'hsi',    label: '홍콩 항셍', mk: 'us' },
  { id: 'sse',    label: '상해종합', mk: 'us' },
];

async function loadUsSummary() {
  const cardsEl = document.getElementById('usIndexCards');
  if (!cardsEl) return;
  try {
    const r = await fetch('/api/indices');
    const j = await r.json();
    const q = j?.data || {};

    cardsEl.innerHTML = US_INDEX_DEFS.map(def => {
      const d = q[def.id];
      return d ? mktSummaryCard(def, d) : '';
    }).join('');

    const glEl = document.getElementById('usGlobalIndices');
    if (glEl) {
      glEl.innerHTML = GLOBAL_INDEX_DEFS.map(def => {
        const d = q[def.id];
        return d ? mktSummaryCard(def, d) : '';
      }).join('');
    }

    const upd = document.getElementById('usSummaryUpdatedAt');
    if (upd) upd.textContent = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) + ' 기준';
  } catch (e) {
    cardsEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--red);font-size:14.5px;padding:16px">불러오기 실패: ${escHtml(e.message)}</div>`;
  }
}

// ─── 🇺🇸 미장 현황 (거래량 TOP / 상승률 TOP / 하락률 TOP) ─────────────────
let _usmTab = 'actives';
const _usmCache = {};

function switchUsMarket(tab) {
  _usmTab = tab;
  document.querySelectorAll('.usm-tab').forEach(b => b.classList.toggle('active', b.dataset.usm === tab));
  loadUsMarket();
}

async function loadUsMarket() {
  const panel = document.getElementById('usMarketPanel');
  if (!panel) return;
  const tab = _usmTab;
  if (!_usmCache[tab]) {
    panel.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:14.5px;padding:20px">로딩 중...</div>';
  }
  try {
    if (!_usmCache[tab]) {
      const r = await fetch(`/api/us-market?type=${tab}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '로드 실패');
      _usmCache[tab] = j;
    }
    renderUsMarket(tab, _usmCache[tab]);
    const el = document.getElementById('usMarketUpdatedAt');
    if (el) el.textContent = new Date(_usmCache[tab].ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) + ' 기준';
  } catch (e) {
    panel.innerHTML = `<div style="text-align:center;color:var(--text3);font-size:14.5px;padding:20px">불러오기 실패: ${escHtml(e.message)}</div>`;
  }
}

function usNameCell(item) {
  const isWL = typeof isWatched === 'function' && isWatched(item.ticker);
  return `<a href="/company.html?ticker=${encodeURIComponent(item.ticker)}" style="color:var(--text);font-weight:600;text-decoration:none">${escHtml(item.name)}</a>
    <span style="color:var(--text3);font-size:13px;font-family:monospace;margin-left:4px">${escHtml(item.ticker)}</span>`;
}

function renderUsMarket(tab, d) {
  const panel = document.getElementById('usMarketPanel');
  panel.innerHTML = krRowsTable(d.items, [
    { label: '#', render: (_, i) => krRankCell(i) },
    { label: '종목', render: usNameCell },
    { label: '현재가', right: true, render: r => r.price != null ? `$${Number(r.price).toFixed(2)}` : '—' },
    { label: '등락률', right: true, render: r => krChgChip(r.changePercent) },
    { label: '거래량', right: true, render: r => krFmtNum(r.volume) },
  ]);
}

// ─── 국장현황 / 미장현황 상위 토글 ──────────────────────────────────────
let _marketSection = 'kr';

const MARKET_SECTION_META = {
  kr: {
    title: '국장 현황',
    sub: '밤사이 미국 흐름이 오늘 국장에 남긴 것 · 시장 온도계 · 투자자별 수급 · 뉴스 대비 주가',
  },
  us: {
    title: '미장 현황',
    sub: 'S&P 500·나스닥·다우 + 거래량 TOP · 상승률 TOP · 하락률 TOP 랭킹',
  },
};

function switchMarketSection(sec) {
  _marketSection = sec;
  document.querySelectorAll('.ms-tab').forEach(b => b.classList.toggle('active', b.dataset.ms === sec));
  const krWrap = document.getElementById('krMarketWrap');
  const usWrap = document.getElementById('usMarketWrap');
  if (krWrap) krWrap.style.display = sec === 'kr' ? 'flex' : 'none';
  if (usWrap) usWrap.style.display = sec === 'us' ? 'flex' : 'none';
  const meta = MARKET_SECTION_META[sec];
  if (meta) {
    const titleEl = document.getElementById('marketHeroTitle');
    const subEl = document.getElementById('marketHeroSub');
    if (titleEl) titleEl.innerHTML = '<span>' + meta.title + '</span>';
    if (subEl) subEl.textContent = meta.sub;
    document.title = `${meta.title} — StockRipple`;
  }
  if (sec === 'us' && !_usmCache[_usmTab]) { loadUsSummary(); loadUsMarket(); }
}

function renderKrPopularSearch(items) {
  const el = document.getElementById('krPopularSearch');
  if (!el) return;
  if (!items?.length) { el.innerHTML = '<div style="color:var(--text3);font-size:14.5px;text-align:center;padding:12px">데이터 없음</div>'; return; }
  el.innerHTML = `<div style="display:flex;flex-direction:column;gap:2px">` + items.map((it, i) => `
    <a href="/company.html?ticker=${encodeURIComponent(it.ticker)}" style="display:flex;align-items:center;gap:10px;padding:7px 4px;text-decoration:none;color:inherit;border-radius:6px" onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background=''">
      ${krRankCell(i)}
      <span style="flex:1;min-width:0;font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(it.name)}</span>
      <span class="t-num" style="font-size:14.5px;font-weight:600;text-align:right;white-space:nowrap">${krFmtNum(it.price)}</span>
      ${krChgChip(it.changePercent)}
    </a>`).join('') + `</div>`;
}

// ─── 🇰🇷 국장 현황 (거래량 TOP / 상한가 / 하한가 / 5일 수급 TOP) ──────────
let _kmTab = 'volume';
const _kmCache = {};

function switchKrMarket(tab) {
  _kmTab = tab;
  document.querySelectorAll('.km-tab').forEach(b => b.classList.toggle('active', b.dataset.km === tab));
  loadKrMarket();
}

async function loadKrMarket() {
  const panel = document.getElementById('krMarketPanel');
  if (!panel) return;
  const tab = _kmTab;
  if (!_kmCache[tab]) {
    panel.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:14.5px;padding:20px">로딩 중...</div>';
  }
  try {
    const typeMap = { volume: 'volume-top', up: 'limit-up', down: 'limit-down', flow: 'flow-top', surge: 'volume-surge' };
    const r = await fetch(`/api/kr-market?type=${typeMap[tab]}`);
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'load failed');
    _kmCache[tab] = d;
    if (_kmTab !== tab) return;  // 응답 오는 사이 탭이 바뀌었으면 무시
    renderKrMarket(tab, d);
    const el = document.getElementById('krMarketUpdatedAt');
    if (el) el.textContent = new Date(d.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) + ' 기준';
  } catch (e) {
    panel.innerHTML = `<div style="text-align:center;color:var(--text3);font-size:14.5px;padding:20px">불러오기 실패: ${escHtml(e.message)}</div>`;
  }
}

function krRowsTable(rows, cols) {
  if (!rows?.length) return '<div style="text-align:center;color:var(--text3);font-size:14.5px;padding:20px">데이터가 없습니다</div>';
  return `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:15px">
    <thead><tr style="border-bottom:2px solid var(--border)">${cols.map(c => `<th style="text-align:${c.right ? 'right' : 'left'};padding:8px;color:var(--text3);font-weight:700;font-size:13px;letter-spacing:.3px;white-space:nowrap;text-transform:uppercase">${c.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((row, i) => {
      const base = i % 2 ? 'var(--bg3)' : 'transparent';
      return `<tr style="border-bottom:1px solid var(--border-soft,var(--border));background:${base};transition:background .1s" onmouseover="this.style.background='var(--blue-dim)'" onmouseout="this.style.background='${base}'">${cols.map(c => `<td style="padding:8px;text-align:${c.right ? 'right' : 'left'};white-space:nowrap">${c.render(row, i)}</td>`).join('')}</tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function krRankCell(i) {
  return i < 3
    ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:var(--blue-dim);color:var(--blue);font-weight:800;font-size:13.5px">${i + 1}</span>`
    : `<span style="color:var(--text3);font-weight:600">${i + 1}</span>`;
}

function krNameCell(item) {
  const isWL = typeof isWatched === 'function' && isWatched(item.ticker);
  return `<a href="/company.html?ticker=${encodeURIComponent(item.ticker)}" style="color:var(--text);font-weight:700;text-decoration:none">${escHtml(item.name)}</a>
    <span style="color:var(--text3);font-size:13px;font-family:monospace;margin-left:4px">${escHtml(item.ticker)}</span>`;
}
const krChgColor = v => v > 0 ? 'var(--red)' : v < 0 ? 'var(--blue)' : 'var(--text2)';
const krFmtPct = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
const krFmtNum = v => v == null ? '—' : Math.round(v).toLocaleString('ko-KR');
const krFmtEok = v => v == null ? '—' : `${v >= 0 ? '+' : ''}${(v / 1e8).toFixed(1)}억`;
const krMktPill = label => `<span style="font-size:12.5px;font-weight:700;padding:2px 7px;border-radius:6px;background:var(--blue-dim);color:var(--blue);white-space:nowrap">${label}</span>`;
function krChgChip(pct) {
  if (pct == null) return '—';
  const bg = pct > 0 ? 'var(--red-dim)' : pct < 0 ? 'var(--blue-dim)' : 'var(--bg4)';
  const fg = pct > 0 ? 'var(--red)' : pct < 0 ? 'var(--blue)' : 'var(--text2)';
  return `<span style="display:inline-block;font-size:14px;font-weight:800;padding:3px 9px;border-radius:6px;background:${bg};color:${fg}">${krFmtPct(pct)}</span>`;
}

// 지수 카드(코스피/코스닥/코스피200, S&P500/나스닥/다우 공용) — dim 배경만으로는
// 카드 전체 면적에서 너무 흐릿해서(8% 알파) 경계가 안 보였음(직접 스크린샷으로 확인).
// 톤 배경 + 진한 색 좌측 보더 + 원형 화살표 배지로 카드 윤곽과 방향성을 동시에 확보.
// 홈 대시보드(.mkt-card, MKT_DASH_ITEMS)와 동일한 스파크라인 카드 컴포넌트를
// 국장/미장 요약에서도 재사용한다(2026-07-31, 기존 원형 화살표 배지 카드는 폐기 —
// 사용자 피드백: "안 이쁘다"). CSS는 kr-market.html에 .mkt-card 블록으로 복사해뒀다.
// def={id,label,mk}, d=/api/indices의 해당 id 응답(price,changePercent,spark,sparkT,
// prevClose,sessionStart,sessionEnd,sessionLive).
function mktSummaryCard(def, d) {
  if (!d || d.price == null) {
    return `<div class="mkt-card"><div class="mkt-card-main">
      <div class="mkt-card-name">${escHtml(def.label)}</div>
      <div class="mkt-card-val" style="color:var(--text3)">—</div>
    </div></div>`;
  }
  const cp = d.changePercent;
  const hasChg = cp != null && !Number.isNaN(cp);
  const up = hasChg && cp > 0, dn = hasChg && cp < 0;
  const color = up ? '#ff6b6b' : dn ? '#4d8dff' : '#9aa3b2';   // 상승=빨강/하락=파랑 (한국 관례)
  const chgCls = up ? 'pos' : dn ? 'neg' : '';
  const sign = hasChg && cp > 0 ? '+' : '';
  const session = mktSessionOf(d);
  const spark = Array.isArray(d.spark) && d.spark.length > 1
    ? areaSparkSvg(d.spark, 46, 28, color, d.prevClose, d.sessionLive ?? mktIsOpen(def.mk), d.sparkT, session)
    : '';
  return `<a class="mkt-card mkt-card-link" href="/market-detail.html?sym=${encodeURIComponent(def.id)}">
    <div class="mkt-card-main">
      <div class="mkt-card-name"><span class="mkt-live-dot${mktIsOpen(def.mk) ? ' on' : ''}"></span>${escHtml(def.label)}</div>
      <div class="mkt-card-val">${fmtIdx(d.price)}</div>
      <div class="mkt-card-chg ${chgCls}">${hasChg ? sign + cp.toFixed(2) + '%' : '—'}</div>
    </div>
    ${spark ? `<div class="mkt-card-spark">${spark}</div>` : ''}
  </a>`;
}

function renderKrMarket(tab, d) {
  const panel = document.getElementById('krMarketPanel');
  const mktPill = r => krMktPill(r.market === 'KOSPI' ? '코스피' : '코스닥');
  if (tab === 'volume') {
    panel.innerHTML = krRowsTable(d.items, [
      { label: '#', render: (_, i) => krRankCell(i) },
      { label: '종목', render: krNameCell },
      { label: '시장', render: mktPill },
      { label: '현재가', right: true, render: r => krFmtNum(r.price) },
      { label: '등락률', right: true, render: r => krChgChip(r.changePercent) },
      { label: '거래량', right: true, render: r => krFmtNum(r.volume) },
    ]);
  } else if (tab === 'up' || tab === 'down') {
    panel.innerHTML = krRowsTable(d.items, [
      { label: '#', render: (_, i) => krRankCell(i) },
      { label: '종목', render: krNameCell },
      { label: '시장', render: mktPill },
      { label: '현재가', right: true, render: r => krFmtNum(r.price) },
      { label: '등락률', right: true, render: r => krChgChip(r.changePercent) },
      { label: '거래량', right: true, render: r => krFmtNum(r.volume) },
      { label: '연속', right: true, render: r => r.streakDays ? `${r.streakDays}일째` : '—' },
    ]);
  } else if (tab === 'surge') {
    panel.innerHTML = krRowsTable(d.items, [
      { label: '#', render: (_, i) => krRankCell(i) },
      { label: '종목', render: krNameCell },
      { label: '시장', render: mktPill },
      { label: '현재가', right: true, render: r => krFmtNum(r.price) },
      { label: '등락률', right: true, render: r => krChgChip(r.changePercent) },
      { label: '거래량 급증률', right: true, render: r => `<span style="display:inline-block;font-size:14px;font-weight:800;padding:3px 9px;border-radius:6px;background:var(--yellow-dim);color:var(--yellow)">${r.surgeRatio != null ? r.surgeRatio.toLocaleString('ko-KR') + '%' : '—'}</span>` },
    ]);
  } else if (tab === 'flow') {
    const half = c => `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div><div style="font-size:14px;font-weight:700;color:var(--red);margin-bottom:4px">🔼 순매수 유입 TOP</div>${krRowsTable(d.inflow, c)}</div>
      <div><div style="font-size:14px;font-weight:700;color:var(--blue);margin-bottom:4px">🔽 순매도 유출 TOP</div>${krRowsTable(d.outflow, c)}</div>
    </div>`;
    panel.innerHTML = half([
      { label: '#', render: (_, i) => krRankCell(i) },
      { label: '종목', render: krNameCell },
      { label: '외국인', right: true, render: r => `<span style="color:${krChgColor(r.foreignVal5d)}">${krFmtEok(r.foreignVal5d)}</span>` },
      { label: '기관', right: true, render: r => `<span style="color:${krChgColor(r.instVal5d)}">${krFmtEok(r.instVal5d)}</span>` },
      { label: '합계', right: true, render: r => `<b style="color:${krChgColor(r.smartVal5d)}">${krFmtEok(r.smartVal5d)}</b>` },
    ]);
  }
}

// Heatmap 색상 계산 (재사용)
function heatmapColorFor(pct) {
  const v = Math.max(-5, Math.min(5, pct)) / 5;
  if (v >= 0) {
    const a = 0.18 + v * 0.78;
    return { bg: `rgba(229,72,77,${a.toFixed(2)})`, fg: v > 0.35 ? '#fff' : '#ffd4da' };
  } else {
    const a = 0.18 + (-v) * 0.78;
    return { bg: `rgba(77,141,255,${a.toFixed(2)})`, fg: -v > 0.35 ? '#fff' : '#cfe3ff' };
  }
}

// 마지막으로 그린 셀의 pct 캐시 (변동 비교용)
const _hmCellState = {};   // key: ticker → { pct, mkt, range }
let _hmInFlight = false;
let _hmStructureKey = '';  // 현재 그려진 grid 시그니처 (mkt+range+티커리스트)

// ─── 📊 리포트 공통 디자인 토큰 ────────────────────────────
// AI 시장 종합 / 데일리 미장 / 데일리 국장 세 리포트가 폰트·크기·배지를 동일하게
// 쓰도록 헬퍼로 통일. 시장 심리 배지는 영문(RISK-ON)과 국문(상승)이 섞여 있던 걸
// 하나의 배지 컴포넌트로 합쳐 라벨·색·아이콘을 일관되게 렌더한다.
const REPORT_LABEL = 'font-size:13.5px;font-weight:700;margin-bottom:4px';   // 섹션 소제목
const REPORT_HEADLINE = 'font-size:16px;font-weight:700;line-height:1.45;margin-bottom:10px';
const REPORT_LIST = 'margin:0;padding-left:16px;font-size:14.5px;color:var(--text2);line-height:1.6';
const REPORT_META = 'font-size:13.5px;color:var(--text3)';

const SENTIMENT_MAP = {
  'RISK-ON':  { dir: 'pos', label: '위험선호' },
  'RISK-OFF': { dir: 'neg', label: '위험회피' },
  'MIXED':    { dir: 'neu', label: '혼조' },
  '상승':     { dir: 'pos', label: '상승' },
  '하락':     { dir: 'neg', label: '하락' },
  '혼조':     { dir: 'neu', label: '혼조' },
};
function sentimentBadge(value) {
  const s = SENTIMENT_MAP[value] || { dir: 'neu', label: value || '혼조' };
  const color = s.dir === 'pos' ? 'var(--red)' : s.dir === 'neg' ? 'var(--blue)' : 'var(--yellow)';
  const icon  = s.dir === 'pos' ? '▲' : s.dir === 'neg' ? '▼' : '◆';
  return `<span style="display:inline-flex;align-items:center;gap:4px;background:${color};color:#fff;font-size:13.5px;font-weight:800;padding:4px 11px;border-radius:999px;white-space:nowrap">${icon} ${escHtml(s.label)}</span>`;
}
function reportList(items) {
  return Array.isArray(items) && items.length
    ? `<ul class="rp-list" style="${REPORT_LIST}">${items.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>`
    : '<div class="rp-meta" style="font-size:13.5px;color:var(--text3)">—</div>';
}

// ─── 🤖 AI 시장 종합 ─────────────────────────────────────
function aiSummaryHTML(d) {
  const when = d.created_at
    ? new Date(d.created_at).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';
  return `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
      ${sentimentBadge(d.regime)}
      <span class="rp-meta" style="${REPORT_META}">${when ? when + ' · ' : ''}${d.based_on_issues || 0}건 분석</span>
    </div>
    <div class="rp-headline" style="${REPORT_HEADLINE}">${escHtml(d.headline || '')}</div>
    <div class="rp-label" style="color:var(--red);${REPORT_LABEL}">▲ 강세 요인</div>
    ${reportList(d.bullish_drivers)}
    <div class="rp-label" style="color:var(--blue);${REPORT_LABEL};margin-top:8px">▼ 약세 요인</div>
    ${reportList(d.bearish_drivers)}
    <div class="rp-label" style="color:var(--blue);${REPORT_LABEL};margin-top:8px">🏆 수혜 섹터</div>
    <div style="display:flex;flex-wrap:wrap;gap:4px">${(d.sectors_winning||[]).map(s => `<span style="font-size:13.5px;padding:2px 8px;border-radius:999px;background:var(--red-dim);color:var(--red)">${escHtml(s)}</span>`).join('')}</div>
    <div class="rp-label" style="color:var(--text3);${REPORT_LABEL};margin-top:8px">📉 피해 섹터</div>
    <div style="display:flex;flex-wrap:wrap;gap:4px">${(d.sectors_losing||[]).map(s => `<span style="font-size:13.5px;padding:2px 8px;border-radius:999px;background:var(--blue-dim);color:var(--blue)">${escHtml(s)}</span>`).join('')}</div>
    <div class="rp-label" style="color:var(--blue);${REPORT_LABEL};margin-top:8px">👁 내일 주시</div>
    ${reportList(d.watch_tomorrow)}
  `;
}

// AI 시장 종합 데이터 캐시 + "새 업데이트" 알림 — 데일리 리포트(_drCache/_drSeenKey)와
// 동일한 패턴. created_at으로 새 버전 여부를 판별해 사이드바 점 · 모바일 FAB · 토스트로 알린다.
let _aiMsCache;   // undefined = 미조회, null = 조회했으나 없음
const _aiMsSeenKey = 'sr_seen_ai_ms';
async function getAiMsData() {
  if (_aiMsCache === undefined) {
    try {
      // 60초 버킷 캐시버스터 — getDrData와 동일한 이유. 이 엔드포인트가
      // Cache-Control: s-maxage=600이라 버스터 없이는 엣지가 최대 10분(스테일까지
      // 합치면 최대 70분) 묵은 응답을 그대로 돌려줘서, 일반 새로고침으로는 방금
      // 갱신된 AI 시장종합이 안 보이고 강제 새로고침(캐시 무시)에서만 보이는 문제가 있었다.
      const bust = Math.floor(Date.now() / 60000);
      const r = await fetch(`/api/admin?action=ai-market-summary&_t=${bust}`);
      _aiMsCache = r.ok ? await r.json() : null;
    } catch { _aiMsCache = null; }
  }
  return _aiMsCache;
}
function _aiMsIsUnseen() {
  const d = _aiMsCache;
  if (!d || !d.created_at) return false;
  const seen = localStorage.getItem(_aiMsSeenKey);
  return seen != null && d.created_at > seen;
}
function markAiMsSeen() {
  const d = _aiMsCache;
  if (d && d.created_at) localStorage.setItem(_aiMsSeenKey, d.created_at);
  refreshReportBadges();
}

async function loadAiMarketSummary() {
  const body = document.getElementById('aiMarketSummaryBody');
  if (!body) return;
  try {
    delete _aiMsCache;   // 사이드바는 항상 최신 조회 (탭 전환 없이 바로 보이는 화면이라 캐시 재사용 불필요)
    const d = await getAiMsData();
    if (!d) {
      body.innerHTML = `<div style="color:var(--text3);font-size:13.5px;text-align:center;padding:10px">아직 생성 전 — 다음 일일 cron 시 자동 생성됩니다</div>`;
      return;
    }
    // 생성시각은 aiSummaryHTML의 메타 줄에 이미 들어가므로 헤더에서는 뺐다(좁은
    // 사이드바에서 제목이 두 줄로 밀리는 원인). 다른 페이지가 아직 이 span을
    // 갖고 있을 수 있어 optional 처리.
    const created = document.getElementById('aiMSCreatedAt');
    if (created) {
      created.textContent = d.created_at
        ? new Date(d.created_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '';
    }
    body.innerHTML = aiSummaryHTML(d);
    // 데스크톱 사이드바에 실제로 렌더링돼 보이는 순간 "봤음" 처리 — 이게 없으면 모바일
    // 바텀시트(renderDrSheet)를 열 때만 markAiMsSeen이 호출돼서, 데스크톱에서는 계속
    // 보고 있어도 영원히 "안 읽음"으로 남아 새로고침/페이지 이동마다 토스트가 또 뜸.
    markAiMsSeen();
    refreshReportBadges();
  } catch { body.innerHTML = '<div style="color:var(--red);font-size:13.5px">로드 실패</div>'; }
}

// ─── 📌 주간 주요 일정 (토·일 cron 생성) ─────────────────────
const WS_TYPE_STYLE = {
  '지표':   ['var(--blue)',   'rgba(47,129,247,.12)'],
  '연준':   ['var(--yellow)', 'rgba(210,153,34,.12)'],
  '실적':   ['var(--green)',  'rgba(63,185,80,.12)'],
  '이벤트': ['var(--red)',    'rgba(248,81,73,.12)'],
};
async function loadWeeklySchedule() {
  const card = document.getElementById('weeklyScheduleCard');
  const body = document.getElementById('weeklyScheduleBody');
  if (!card || !body) return;
  try {
    // 60초 버킷 캐시버스터 — 이 엔드포인트가 s-maxage=1800(30분)이라 버스터 없이는
    // 방금 갱신된 주간일정이 최대 30분(스테일까지 합치면 2시간30분)까지 안 보일 수 있다.
    const bust = Math.floor(Date.now() / 60000);
    const r = await fetch(`/api/admin?action=weekly-schedule&_t=${bust}`);
    if (!r.ok) return;                       // 아직 생성 전이면 카드 숨김 유지
    const d = await r.json();
    if (!d.days?.length) return;
    // 지난 주 일정이면 표시 안 함 (주 시작 + 7일 경과)
    if (new Date(`${d.week_start}T00:00:00+09:00`).getTime() + 7 * 86400000 < Date.now()) return;

    document.getElementById('wsWeekLabel').textContent = d.week_label || '';
    const hl = (d.highlights || []).length ? `
      <div style="font-size:13px;color:var(--yellow);font-weight:700;margin-bottom:4px">⭐ 하이라이트</div>
      <ul style="margin:0 0 10px;padding-left:14px;font-size:14px;color:var(--text2);line-height:1.55">
        ${d.highlights.map(h => `<li>${escHtml(h)}</li>`).join('')}
      </ul>` : '';

    const dayHtml = d.days.map(day => {
      const items = (day.items || []).map(it => {
        const [color, bg] = WS_TYPE_STYLE[it.type] || ['var(--text3)', 'var(--bg3)'];
        const stars = it.stars ? '★'.repeat(it.stars) : '';
        return `<div style="display:flex;gap:6px;align-items:baseline;padding:2px 0;font-size:13.5px;line-height:1.45">
          <span style="color:var(--text3);font-family:monospace;flex-shrink:0;width:34px">${escHtml(it.time || '')}</span>
          <span style="flex-shrink:0;font-size:12px;font-weight:700;padding:1px 5px;border-radius:6px;color:${color};background:${bg}">${escHtml(it.type)}</span>
          <span style="color:var(--text2)">${escHtml(it.title)}${stars ? ` <span style="color:var(--yellow);font-size:12px">${stars}</span>` : ''}</span>
        </div>`;
      }).join('');
      return `<div style="margin-bottom:8px">
        <div style="font-size:13.5px;font-weight:700;color:var(--text);border-bottom:1px solid var(--border);padding-bottom:3px;margin-bottom:3px">${day.date.slice(5).replace('-', '/')} (${escHtml(day.weekday)})</div>
        ${items}
      </div>`;
    }).join('');

    body.innerHTML = hl + dayHtml + `<div style="font-size:12px;color:var(--text3);margin-top:6px">시간은 KST · 본 콘텐츠는 투자 권유가 아닌 정보 제공용입니다</div>`;
    card.style.display = '';
  } catch {}
}

// ─── 📰 데일리 리포트 (국장/미장) ─────────────────────────
let _drTab = 'US';
const _drCache = {};   // { US: data|null, KR: data|null }

function dailyReportHTML(d, compact) {
  const idxChips = Array.isArray(d.indices) && d.indices.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px">${d.indices.map(x => {
        const c = x.changePercent == null ? 'var(--text3)' : x.changePercent >= 0 ? 'var(--red)' : 'var(--blue)';
        const sign = x.changePercent != null && x.changePercent >= 0 ? '+' : '';
        return `<span style="font-size:13.5px;padding:3px 8px;border-radius:6px;background:var(--bg3);border:1px solid var(--border)">
          <b>${escHtml(x.name)}</b> <span style="font-family:'SF Mono',monospace">${Number(x.price).toLocaleString()}</span>
          ${x.changePercent != null ? `<span style="color:${c};font-weight:700"> ${sign}${x.changePercent}%</span>` : ''}
        </span>`;
      }).join('')}</div>`
    : '';

  // report_date(장 마감 거래일)와 created_at(실제 생성 시각)이 다른 날일 수 있다 — 미장은
  // 마감 다음날 새벽에 생성되는 게 정상이라, report_date의 날짜에 created_at의 시:분만
  // 이어붙이면 "7/15 07:32"처럼 실제로는 7/16 07:32에 만들어진 걸 7/15 07:32에 만든
  // 것처럼 보이게 된다(2026-07-16 실측 혼동 사례). 거래일과 생성 시각을 분리해서 표기.
  const genAt = d.created_at
    ? new Date(d.created_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';
  const drDateShort = d.report_date ? d.report_date.slice(5).replace('-', '/') : '';
  return `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
      ${sentimentBadge(d.mood)}
      <span class="rp-meta" style="${REPORT_META}">${drDateShort ? drDateShort + ' 장마감' : ''}${genAt ? ` · ${genAt} 생성` : ''} · ${d.based_on_issues || 0}건 분석</span>
    </div>
    <div class="rp-headline" style="${REPORT_HEADLINE}">${escHtml(d.headline || '')}</div>
    ${idxChips}
    ${Array.isArray(d.catalysts) && d.catalysts.length ? `
    <div class="rp-label" style="color:var(--purple);${REPORT_LABEL}">📌 다가오는 핵심 이벤트</div>
    <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:9px">${d.catalysts.map(c => `<div class="dr-cat">${escHtml(c)}</div>`).join('')}</div>` : ''}
    <div class="rp-label" style="color:var(--blue);${REPORT_LABEL}">📋 오늘 시장 흐름</div>
    ${reportList(d.recap)}
    <div class="rp-label" style="color:var(--yellow);${REPORT_LABEL};margin-top:8px">⚡ 주요 이벤트</div>
    ${reportList(d.top_events)}
    ${!compact ? `
    <div class="rp-label" style="color:var(--green);${REPORT_LABEL};margin-top:8px">🔍 섹터·종목 특징</div>
    ${reportList(d.sector_notes)}` : ''}
    <div class="rp-label" style="color:var(--blue);${REPORT_LABEL};margin-top:8px">👁 다음 거래일 관전 포인트</div>
    ${reportList(d.tomorrow)}
  `;
}

let _drSheetTab = 'US';
const _drToasted = new Set();   // 세션 내 중복 토스트 방지 (market+report_date)

// 최신 리포트 데이터 조회 (market별 캐시)
async function getDrData(mkt) {
  if (_drCache[mkt] === undefined) {
    try {
      // 60초 버킷 캐시버스터 — 재생성된 리포트가 엣지 stale 캐시에 막히지 않고 바로 반영되도록
      const bust = Math.floor(Date.now() / 60000);
      const r = await fetch(`/api/admin?action=daily-report&market=${mkt}&_t=${bust}`);
      _drCache[mkt] = r.ok ? await r.json() : null;
    } catch { _drCache[mkt] = null; }
  }
  return _drCache[mkt];
}

const _drSeenKey = mkt => 'sr_seen_dr_' + mkt;
function _drIsUnseen(mkt) {
  const d = _drCache[mkt];
  if (!d || !d.report_date) return false;
  const seen = localStorage.getItem(_drSeenKey(mkt));
  return seen != null && d.report_date > seen;   // seen이 null이면 최초 방문 → 기준선(아래 checkNewReports에서 설정)
}

// 이미 본 것으로 표시 (해당 시장의 뱃지/점 제거)
function markReportSeen(mkt) {
  const d = _drCache[mkt];
  if (d && d.report_date) localStorage.setItem(_drSeenKey(mkt), d.report_date);
  refreshReportBadges();
}

// 사이드바 탭 점 · NEW 필 · 모바일 FAB 점 갱신
function refreshReportBadges() {
  const unseenUS = _drIsUnseen('US'), unseenKR = _drIsUnseen('KR'), unseenAI = _aiMsIsUnseen();
  const set = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
  set('drDotUS', unseenUS);         set('drDotKR', unseenKR);
  set('drSheetDotUS', unseenUS);    set('drSheetDotKR', unseenKR);    set('drSheetDotAI', unseenAI);
  set('drNewPill', unseenUS || unseenKR || unseenAI);
  set('aiMSDot', unseenAI);
  document.getElementById('drFab')?.classList.toggle('has-new', unseenUS || unseenKR || unseenAI);
}

// 새 리포트/AI 종합 감지 → 뱃지 갱신 + 토스트 (최초 방문은 기준선만 설정, 알림 없음)
// 토스트를 눌렀을 때 실제로 그 리포트를 볼 수 있도록(2026-07-28, 예전엔 텍스트만 뜨고
// 눌러도 반응이 없었다) 리포트 종류별 openReportArchive 파라미터도 같이 모아둔다 —
// 여러 개가 동시에 올라왔으면 먼저 감지된 것(순서상 국장 > 미장 > AI 종합)을 연다.
async function checkNewReports() {
  await Promise.all([getDrData('US'), getDrData('KR'), getAiMsData()]);
  const toToast = [];
  const toToastParams = [];
  for (const mkt of ['KR', 'US']) {
    const d = _drCache[mkt];
    if (!d || !d.report_date) continue;
    if (localStorage.getItem(_drSeenKey(mkt)) == null) {
      // 최초 방문: 현재 최신본을 '이미 본 것'으로 기준선 설정 (첫 진입 스팸 방지)
      localStorage.setItem(_drSeenKey(mkt), d.report_date);
      continue;
    }
    if (_drIsUnseen(mkt) && !_drToasted.has(mkt + d.report_date)) {
      _drToasted.add(mkt + d.report_date);
      toToast.push(mkt === 'KR' ? '국장' : '미장');
      toToastParams.push(mkt === 'KR' ? 'dr-kr' : 'dr-us');
    }
  }
  const aiD = _aiMsCache;
  if (aiD && aiD.created_at) {
    if (localStorage.getItem(_aiMsSeenKey) == null) {
      localStorage.setItem(_aiMsSeenKey, aiD.created_at);
    } else if (_aiMsIsUnseen() && !_drToasted.has('AI' + aiD.created_at)) {
      _drToasted.add('AI' + aiD.created_at);
      toToast.push('AI 시장 종합');
      toToastParams.push('ai');
    }
  }
  refreshReportBadges();
  if (toToast.length) {
    // 토스트를 눌러 아카이브 모달로 본 것도 markReportSeen/markAiMsSeen을 안 태우면
    // localStorage seen값이 안 갱신돼서, 페이지를 새로고침/이동하면 _drToasted(메모리
    // 전용)만 리셋되고 seen값은 그대로라 같은 리포트가 또 "새 업데이트"로 뜬다(피드백,
    // 2026-07-29). 모달을 연 시점에 바로 읽음 처리.
    const openFirst = async () => {
      await openReportArchive(toToastParams[0]);
      renderArchDetail(0);
      const p = toToastParams[0];
      if (p === 'dr-kr') markReportSeen('KR');
      else if (p === 'dr-us') markReportSeen('US');
      else if (p === 'ai') markAiMsSeen();
    };
    try { showToast(`📰 새 ${toToast.join('·')} 업데이트가 올라왔어요 — 눌러서 보기`, 'info', openFirst); } catch {}
  }
}

async function loadDailyReport(market) {
  const body = document.getElementById('dailyReportBody');
  if (!body) return;
  const mkt = market || _drTab;
  try {
    const d = await getDrData(mkt);
    body.innerHTML = d
      ? dailyReportHTML(d, true)
      : `<div style="color:var(--text3);font-size:13.5px;text-align:center;padding:10px">아직 리포트 없음 — ${mkt === 'KR' ? '국장' : '미장'} 마감 후 자동 생성됩니다</div>`;
    refreshReportBadges();
  } catch { body.innerHTML = '<div style="color:var(--red);font-size:13.5px">로드 실패</div>'; }
}

function switchDrTab(mkt) {
  _drTab = mkt;
  document.getElementById('drTabUS').classList.toggle('active', mkt === 'US');
  document.getElementById('drTabKR').classList.toggle('active', mkt === 'KR');
  loadDailyReport(mkt).then(() => markReportSeen(mkt));   // 탭을 직접 보면 읽음 처리
}

// ─── 📱 모바일 데일리 리포트 바텀시트 (📰 미장/국장 + 🤖 AI 시장 종합) ──
async function renderDrSheet() {
  const body = document.getElementById('drSheetBody');
  if (!body) return;
  const mkt = _drSheetTab;
  document.getElementById('drSheetTabUS').classList.toggle('active', mkt === 'US');
  document.getElementById('drSheetTabKR').classList.toggle('active', mkt === 'KR');
  document.getElementById('drSheetTabAI').classList.toggle('active', mkt === 'AI');
  document.getElementById('drSheetTitle').textContent = mkt === 'AI' ? '🤖 AI 시장 종합' : '📰 데일리 리포트';
  body.innerHTML = '<div style="color:var(--text3);font-size:15.5px;text-align:center;padding:24px 0">로딩 중...</div>';

  if (mkt === 'AI') {
    const d = await getAiMsData();
    body.innerHTML = d
      ? aiSummaryHTML(d)
      : `<div style="color:var(--text3);font-size:15.5px;text-align:center;padding:24px 0">아직 생성 전 — 다음 일일 cron 시 자동 생성됩니다</div>`;
    markAiMsSeen();
    return;
  }

  const d = await getDrData(mkt);
  body.innerHTML = d
    ? dailyReportHTML(d, false)
    : `<div style="color:var(--text3);font-size:15.5px;text-align:center;padding:24px 0">아직 리포트 없음 — ${mkt === 'KR' ? '국장' : '미장'} 마감 후 자동 생성됩니다<br><span style="font-size:13.5px">국장은 평일 16:40, 미장은 익일 06:10경(KST) 올라옵니다</span></div>`;
  markReportSeen(mkt);
}
function openDrSheet() {
  _drSheetTab = _drTab || 'US';
  document.getElementById('drSheet').classList.add('show');
  document.body.style.overflow = 'hidden';
  renderDrSheet();
}
function closeDrSheet() {
  document.getElementById('drSheet').classList.remove('show');
  document.body.style.overflow = '';
}
function switchDrSheetTab(mkt) { _drSheetTab = mkt; renderDrSheet(); }

// 바텀시트 상단 그립(드래그 핸들) — 시각적으로만 있고 실제 드래그 동작이 없어서
// "작동 안 한다"는 혼동이 있었음. 헤더 영역을 아래로 끌면 닫히도록 구현
// (버튼/링크 위에서 시작한 터치는 원래 클릭 동작이 우선하도록 제외).
(function initDrSheetDrag() {
  const head = document.querySelector('.dr-sheet-head');
  const panel = document.querySelector('.dr-sheet-panel');
  if (!head || !panel) return;
  let startY = 0, dragging = false;

  head.addEventListener('touchstart', e => {
    if (e.target.closest('button, [onclick]')) return;
    dragging = true;
    startY = e.touches[0].clientY;
    panel.style.transition = 'none';
  }, { passive: true });

  head.addEventListener('touchmove', e => {
    if (!dragging) return;
    const delta = Math.max(0, e.touches[0].clientY - startY);
    panel.style.transform = `translateY(${delta}px)`;
  }, { passive: true });

  head.addEventListener('touchend', e => {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = '';
    panel.style.transform = '';
    const delta = e.changedTouches[0].clientY - startY;
    if (delta > 70) closeDrSheet();
  });
})();

// ─── 🤖 히어로 스트립 — 오늘의 AI 브리핑 롤링 (index/heatmap/kr-market/picks/sectors 공통) ───
// AI 시장종합은 하루 3번(1/9/17시 KST) 생성되는데 예전엔 최신 1건만 보여줬음 — 오늘 나온
// 것 전부를 몇 초 간격으로 롤링해서 보여주고, 클릭하면 그 회차의 전체 리포트(강세/약세
// 요인·수혜/피해 섹터·내일 주시)를 지난 리포트 모달로 바로 띄운다. #heroHeadline이 없는
// 페이지에서는 loadHeroHeadline이 조용히 no-op.
const HERO_ROTATE_MS = 7000;
let _heroBriefs = [];
let _heroIdx = 0;
let _heroRotateTimer = null;

function _kstDateStr(d) { return new Date(new Date(d).getTime() + 9 * 3600000).toISOString().slice(0, 10); }

function renderHeroBrief() {
  const el = document.getElementById('heroHeadline');
  if (!el || !_heroBriefs.length) return;
  el.style.opacity = '0';
  setTimeout(() => {
    el.textContent = _heroBriefs[_heroIdx]?.headline || '오늘의 이슈가 어떤 주식을 움직이나요?';
    el.style.opacity = '1';
  }, 250);
}

async function loadHeroHeadline() {
  const el = document.getElementById('heroHeadline');
  if (!el) return;
  try {
    const bust = Math.floor(Date.now() / 60000);
    const r = await fetch(`/api/admin?action=ai-market-summary&history=20&_t=${bust}`);
    if (!r.ok) throw new Error('no summary');
    const j = await r.json();
    const items = j?.items || [];
    const todayKst = _kstDateStr(Date.now());
    _heroBriefs = items.filter(d => d.created_at && _kstDateStr(d.created_at) === todayKst);
    if (!_heroBriefs.length && items.length) _heroBriefs = items.slice(0, 1); // 오늘자가 아직 없으면 최신 1건이라도
  } catch {
    _heroBriefs = [];
  }
  if (!_heroBriefs.length) { el.textContent = '오늘의 이슈가 어떤 주식을 움직이나요?'; return; }
  _heroIdx = 0;
  renderHeroBrief();
  if (_heroRotateTimer) clearInterval(_heroRotateTimer);
  if (_heroBriefs.length > 1) {
    _heroRotateTimer = setInterval(() => {
      _heroIdx = (_heroIdx + 1) % _heroBriefs.length;
      renderHeroBrief();
    }, HERO_ROTATE_MS);
  }
}
loadHeroHeadline();

// 헤드라인 클릭 → 그 회차의 전체 리포트를 "지난 리포트" 모달로 바로 표시(목록 경유 없이)
async function openHeroBriefDetail() {
  if (!_heroBriefs.length) { openReportArchive('ai'); return; }
  const current = _heroBriefs[_heroIdx];
  await openReportArchive('ai');
  const idx = (_archCache['ai'] || []).findIndex(d => d.created_at === current.created_at);
  renderArchDetail(idx >= 0 ? idx : 0);
}

// ─── 📚 지난 리포트 아카이브 모달 ─────────────────────────
let _archTab = 'ai';
const _archCache = {};   // { ai: [...], 'dr-us': [...], 'dr-kr': [...] }

// 모달 스타일은 5개 공유 페이지에 각각 복사돼 있던 걸 여기서 한 번만 주입한다 —
// 창 크기를 콘텐츠와 무관하게 고정(목록↔상세를 오가도 창이 안 튐)하는 게 핵심.
const ARCH_CSS = `
#reportArchiveModal .ra-modal { background:var(--bg2); border-radius:16px; border:1px solid var(--border); box-shadow:var(--shadow-pop);
  width:min(720px,94vw); height:min(720px,86vh); display:flex; flex-direction:column; overflow:hidden; }
#reportArchiveModal .ra-head { display:flex; align-items:center; gap:10px; padding:14px 16px; border-bottom:1px solid var(--border); flex-shrink:0; }
#reportArchiveModal .ra-title { font-size:19px; font-weight:800; margin:0; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#reportArchiveModal .ra-iconbtn { width:44px; height:44px; flex-shrink:0; display:flex; align-items:center; justify-content:center;
  background:var(--bg3); border:1px solid var(--border); border-radius:12px; color:var(--text1); font-size:20px; cursor:pointer; line-height:1; }
#reportArchiveModal .ra-iconbtn:hover { background:var(--bg4); }
#reportArchiveModal .ra-back { display:none; }
#reportArchiveModal.detail .ra-back { display:flex; }
#reportArchiveModal.detail .ra-tabs { display:none; }
#reportArchiveModal .ra-tabs { display:flex; gap:6px; padding:10px 16px; border-bottom:1px solid var(--border); flex-shrink:0; }
#reportArchiveModal .ra-tab { flex:1; min-width:0; padding:11px 6px; font-size:15px; font-weight:700; color:var(--text2);
  background:var(--bg3); border:1px solid var(--border); border-radius:10px; cursor:pointer; text-align:center;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#reportArchiveModal .ra-tab.active { color:#fff; background:var(--blue); border-color:var(--blue); }
#reportArchiveModal .ra-hint { font-size:14px; color:var(--text3); padding:12px 18px 4px; }
#reportArchiveModal .ra-body { flex:1; min-height:0; overflow-y:auto; -webkit-overflow-scrolling:touch; padding:6px 18px 24px; }
#reportArchiveModal .ra-empty { text-align:center; padding:56px 20px; color:var(--text3); font-size:16px; }
#reportArchiveModal .arch-item { display:block; width:100%; text-align:left; padding:14px; margin-bottom:8px; cursor:pointer;
  font:inherit; color:inherit; background:var(--bg3); border:1px solid var(--border); border-radius:12px; }
#reportArchiveModal .arch-item:hover { background:var(--bg4); border-color:var(--blue); }
#reportArchiveModal .arch-date { font-size:14px; color:var(--text3); }
#reportArchiveModal .arch-headline { font-size:16.5px; font-weight:700; line-height:1.5; color:var(--text1); }
/* 상세 본문 — 사이드바용 인라인 크기를 모달에서만 키운다 */
#reportArchiveModal .ra-report .rp-headline { font-size:21px !important; line-height:1.5 !important; margin-bottom:14px !important; }
#reportArchiveModal .ra-report .rp-label { font-size:16.5px !important; margin:18px 0 6px !important; }
#reportArchiveModal .ra-report .rp-list { font-size:17px !important; line-height:1.8 !important; padding-left:20px !important; }
#reportArchiveModal .ra-report .rp-list li { margin-bottom:6px; }
#reportArchiveModal .ra-report .rp-meta { font-size:14.5px !important; }
@media (max-width:480px) {
  #reportArchiveModal .ra-modal { width:100vw; height:100dvh; max-height:100dvh; border-radius:0; border:none; }
  #reportArchiveModal .ra-tab { font-size:13.5px; padding:11px 4px; }
}`;

async function openReportArchive(tab = 'ai') {
  _archTab = tab;
  let el = document.getElementById('reportArchiveModal');
  if (!el) {
    const st = document.createElement('style');
    st.textContent = ARCH_CSS;
    document.head.appendChild(st);

    el = document.createElement('div');
    el.id = 'reportArchiveModal';
    el.className = 'cal-overlay';
    el.innerHTML = `
      <div class="ra-modal" role="dialog" aria-modal="true" aria-label="지난 리포트" onclick="event.stopPropagation()">
        <div class="ra-head">
          <button class="ra-iconbtn ra-back" onclick="renderArchList()" aria-label="목록으로 돌아가기" title="목록으로">←</button>
          <h2 class="ra-title" id="archTitle">📚 지난 리포트</h2>
          <button class="ra-iconbtn" onclick="closeReportArchive()" aria-label="닫기" title="닫기">✕</button>
        </div>
        <div class="ra-tabs">
          <div class="ra-tab" id="archTabAi"   onclick="switchArchTab('ai')">🤖 시장 종합</div>
          <div class="ra-tab" id="archTabDrUs" onclick="switchArchTab('dr-us')">🇺🇸 미국 증시</div>
          <div class="ra-tab" id="archTabDrKr" onclick="switchArchTab('dr-kr')">🇰🇷 한국 증시</div>
        </div>
        <div class="ra-body" id="archBody">
          <div class="ra-empty">불러오는 중…</div>
        </div>
      </div>`;
    el.addEventListener('click', e => { if (e.target === el) closeReportArchive(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && el.style.display === 'flex') closeReportArchive();
    });
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  await renderArchList();
}

function closeReportArchive() {
  const el = document.getElementById('reportArchiveModal');
  if (el) el.style.display = 'none';
  document.body.style.overflow = '';
}

async function switchArchTab(tab) {
  _archTab = tab;
  await renderArchList();
}

function _archSyncTabs() {
  const m = { ai: 'archTabAi', 'dr-us': 'archTabDrUs', 'dr-kr': 'archTabDrKr' };
  Object.entries(m).forEach(([k, id]) => {
    const t = document.getElementById(id);
    if (t) { t.classList.toggle('active', k === _archTab); t.setAttribute('aria-selected', k === _archTab); }
  });
}

const ARCH_TAB_LABEL = { ai: '📚 지난 시장 종합', 'dr-us': '📚 지난 미국 증시 리포트', 'dr-kr': '📚 지난 한국 증시 리포트' };

async function renderArchList() {
  _archSyncTabs();
  const body = document.getElementById('archBody');
  if (!body) return;
  document.getElementById('reportArchiveModal')?.classList.remove('detail');
  const title = document.getElementById('archTitle');
  if (title) title.textContent = ARCH_TAB_LABEL[_archTab] || '📚 지난 리포트';
  body.scrollTop = 0;

  if (!_archCache[_archTab]) {
    body.innerHTML = '<div class="ra-empty">불러오는 중…</div>';
    try {
      const url = _archTab === 'ai'
        ? '/api/admin?action=ai-market-summary&history=60'
        : `/api/admin?action=daily-report&market=${_archTab === 'dr-kr' ? 'KR' : 'US'}&history=60`;
      const r = await fetch(url);
      const j = r.ok ? await r.json() : {};
      _archCache[_archTab] = j.items || [];
    } catch { _archCache[_archTab] = []; }
  }

  const items = _archCache[_archTab];
  if (!items.length) {
    body.innerHTML = '<div class="ra-empty">아직 저장된 리포트가 없어요</div>';
    return;
  }

  body.innerHTML = '<div class="ra-hint">날짜를 누르면 그날의 리포트 전체를 볼 수 있어요</div>' +
    items.map((d, i) => {
      const isAi = _archTab === 'ai';
      const dateStr = isAi
        ? new Date(d.created_at).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : (d.report_date || '') + (d.created_at ? ' ' + new Date(d.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '');
      const badge = sentimentBadge(isAi ? d.regime : d.mood);
      return `
      <button type="button" class="arch-item" onclick="renderArchDetail(${i})">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
          <span class="arch-date">${escHtml(dateStr || '')}</span>
          ${badge}
          <span class="arch-date">뉴스 ${d.based_on_issues || 0}건</span>
        </div>
        <div class="arch-headline">${escHtml(d.headline || '(제목 없음)')}</div>
      </button>`;
    }).join('');
}

function renderArchDetail(idx) {
  const body = document.getElementById('archBody');
  const d = _archCache[_archTab]?.[idx];
  if (!body || !d) return;
  document.getElementById('reportArchiveModal')?.classList.add('detail');
  const title = document.getElementById('archTitle');
  if (title) {
    title.textContent = _archTab === 'ai' ? '🤖 시장 종합' : _archTab === 'dr-kr' ? '🇰🇷 한국 증시 리포트' : '🇺🇸 미국 증시 리포트';
  }
  body.scrollTop = 0;
  body.innerHTML = `<div class="ra-report">${_archTab === 'ai' ? aiSummaryHTML(d) : dailyReportHTML(d, false)}</div>`;
}

// 텔레그램 알림의 "더 보러 가기" 링크(?report=ai|dr-kr|dr-us, api/admin.js
// notifyReportSubscribers가 생성)로 들어오면 목록 경유 없이 그 리포트 상세를 바로
// 열어준다 — 홈에 뚝 떨어뜨리면 알림 눌러 들어온 의미가 없어짐(2026-07-28). 이 트리거는
// 반드시 _archTab/_archCache(let/const) 선언과 openReportArchive/renderArchDetail
// 정의보다 뒤에 있어야 한다 — 앞에 두면 TDZ(ReferenceError: Cannot access '_archTab'
// before initialization)로 조용히 죽는다(실제로 겪은 버그, 로컬 테스트로 확인).
(async function _autoOpenReportFromQuery() {
  const tab = new URLSearchParams(location.search).get('report');
  if (!['ai', 'dr-kr', 'dr-us'].includes(tab)) return;
  await openReportArchive(tab);
  renderArchDetail(0); // 최신순 정렬이라 0번 = 알림이 온 바로 그 리포트
})();

// ─── 🔥 오늘의 트렌드(키워드/테마) — index.html #trendPanel에서만 동작 ─────────────
// 새 AI 호출/DB 컬럼 없이 최근 24h 이슈(issues.title/sectors)만 집계 — 체류시간
// 늘리는 용도의 "가벼운 발견" 위젯(2026-08 요청). 조사(은/는/이/가 등)가 안 떨어져
// 나가는 나이브 토큰화라 완벽한 키워드 추출은 아니지만, 같은 표현이 반복되는 제목이
// 많으면 자연스럽게 상위로 올라온다.
const TREND_STOPWORDS = new Set([
  '오늘','이번','대한','통해','위해','있다','한다','것으로','밝혔다','전했다','따르면','기자',
  '뉴스','종목','시장','업계','국내','발표','관련','최근','계획','예정','전망','상승','하락',
  '기업','산업','내년','올해','우리','기록','달성','진행','예상','때문','이후','현재','지난',
]);
function _stripKoreanParticle(t) {
  return t.replace(/(으로부터|에서의|이라는|이라고|에게서|이라면|이지만|하지만|까지도|으로써|에서는|에게는|에서도|와의|과의|이며|이고|이나|까지|부터|에게|에는|에도|와도|과도|이라|의|을|를|이|가|은|는|에|와|과|도|만|로|라)$/, '');
}
async function loadTrendPanel() {
  const panel = document.getElementById('trendPanel');
  if (!panel) return;
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data } = await sb.from('issues').select('title, sectors')
      .gte('published_at', since).order('published_at', { ascending: false }).limit(150);
    if (!data || !data.length) return;

    const sectorCount = {};
    data.forEach(i => (i.sectors || []).forEach(s => { if (s) sectorCount[s] = (sectorCount[s] || 0) + 1; }));
    const topSectors = Object.entries(sectorCount).sort((a, b) => b[1] - a[1]).slice(0, 6);

    const wordCount = {};
    data.forEach(i => {
      (i.title || '').replace(/[^가-힣a-zA-Z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).forEach(raw => {
        const t = _stripKoreanParticle(raw);
        if (t.length < 2 || TREND_STOPWORDS.has(t) || /^\d+$/.test(t)) return;
        wordCount[t] = (wordCount[t] || 0) + 1;
      });
    });
    const topWords = Object.entries(wordCount).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 10);

    if (!topSectors.length && !topWords.length) return;

    const kwEl = document.getElementById('trendKeywords');
    if (kwEl) {
      // w는 토큰화 정규식(가-힣/영문/숫자만 통과)이 이미 걸러서 따옴표·백슬래시가 절대
      // 나올 수 없으므로 onclick 안 작은따옴표 문자열로 바로 넣어도 안전하다.
      // heroChipClick이 아니라 heroSearchEnter를 쓴다 — 이 단어들은 큐레이션된 섹터
      // 키워드가 아니라 제목에서 뽑은 임의 단어라, 검색창에 쳐서 엔터 친 것과 같은
      // 처리(섹터 매치→종목 매치→뉴스 텍스트 검색 순 폴백)가 필요하다.
      kwEl.innerHTML = topWords.length
        ? topWords.map(([w]) => `<button type="button" class="trend-chip" onclick="heroSearchEnter('${w}')">${escHtml(w)}</button>`).join('')
        : `<div style="font-size:13.5px;color:var(--text3)">아직 데이터가 부족해요</div>`;
    }
    const thEl = document.getElementById('trendThemes');
    if (thEl) {
      thEl.innerHTML = topSectors.map(([s, c], i) => `
        <a class="trend-theme-row" href="/news.html?sector=${encodeURIComponent(s)}">
          <span class="trend-theme-rank">${i + 1}</span>
          <span class="trend-theme-name">${escHtml(s)}</span>
          <span class="trend-theme-count">${c}건</span>
        </a>`).join('');
    }
    panel.style.display = '';
  } catch (e) { console.error('loadTrendPanel', e); }
}

// ─── 📊 섹터 모멘텀 (1d) ─────────────────────────────────
const SECTOR_ETFS = [
  { t:'XLK', n:'기술' }, { t:'XLF', n:'금융' }, { t:'XLV', n:'헬스케어' },
  { t:'XLY', n:'경기소비재' }, { t:'XLP', n:'필수소비재' }, { t:'XLE', n:'에너지' },
  { t:'XLI', n:'산업재' }, { t:'XLB', n:'소재' }, { t:'XLU', n:'유틸리티' },
  { t:'XLRE',n:'리츠' }, { t:'XLC', n:'통신서비스' },
];
async function loadSectorMomentum() {
  const el = document.getElementById('sectorMomentum');
  if (!el) return;
  try {
    const r = await fetch(`/api/quotes?tickers=${SECTOR_ETFS.map(s => s.t).join(',')}`);
    const j = await r.json();
    if (!j.ok) throw new Error();
    const items = SECTOR_ETFS.map(s => ({
      ...s, pct: j.data?.[s.t]?.changePercent ?? null,
    })).filter(x => x.pct != null).sort((a, b) => b.pct - a.pct);
    if (!items.length) { el.innerHTML = '<div style="color:var(--text3);font-size:13.5px;text-align:center">데이터 없음 (시장 휴장)</div>'; return; }
    const maxAbs = Math.max(...items.map(it => Math.abs(it.pct)), 1);
    el.innerHTML = items.map(it => {
      const barPct = (Math.abs(it.pct) / maxAbs) * 100;
      const color = it.pct >= 0 ? 'var(--red)' : 'var(--blue)';
      const sign = it.pct >= 0 ? '+' : '';
      return `<div style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin-bottom:5px">
        <span style="width:74px;color:var(--text2);flex-shrink:0">${escHtml(it.n)}</span>
        <div style="flex:1;background:var(--bg3);border-radius:3px;height:6px;position:relative;overflow:hidden">
          <div style="position:absolute;${it.pct >= 0 ? 'left:50%' : `right:50%`};top:0;bottom:0;background:${color};width:${barPct/2}%;border-radius:2px"></div>
          <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--border)"></div>
        </div>
        <span style="color:${color};font-weight:700;font-family:var(--font-mono,monospace);width:56px;text-align:right">${sign}${it.pct.toFixed(2)}%</span>
      </div>`;
    }).join('');
  } catch { el.innerHTML = '<div style="color:var(--red);font-size:13.5px;text-align:center">로드 실패</div>'; }
}

// ─── 🔗 Cross-asset Correlation (30d) ───────────────────
const CORR_ASSETS = [
  { t:'SPY',     n:'주식' },
  { t:'TLT',     n:'채권' },
  { t:'GLD',     n:'금' },
  { t:'USO',     n:'유가' },
  { t:'DX-Y.NYB',n:'달러' },
  { t:'BTC-USD', n:'BTC' },
];
async function loadCorrelation() {
  const el = document.getElementById('corrMatrix');
  if (!el) return;
  try {
    const r = await fetch(`/api/quotes?tickers=${CORR_ASSETS.map(a => a.t).join(',')}&range=1mo&include=series`);
    const j = await r.json();
    if (!j.ok) throw new Error();
    // 일별 수익률 시계열 변환
    const returns = {};
    for (const a of CORR_ASSETS) {
      const s = j.data?.[a.t]?.series;
      if (!Array.isArray(s) || s.length < 5) continue;
      const ret = [];
      for (let i = 1; i < s.length; i++) {
        if (s[i] && s[i-1]) ret.push((s[i] - s[i-1]) / s[i-1]);
      }
      returns[a.t] = ret;
    }
    const valid = CORR_ASSETS.filter(a => returns[a.t]?.length >= 5);
    if (valid.length < 2) { el.innerHTML = '<div style="color:var(--text3);font-size:13.5px;text-align:center;padding:10px">데이터 부족</div>'; return; }

    // Pearson correlation
    const corr = (x, y) => {
      const n = Math.min(x.length, y.length);
      if (n < 3) return null;
      let sx=0, sy=0, sxy=0, sx2=0, sy2=0;
      for (let i = 0; i < n; i++) {
        const xi = x[x.length-n+i], yi = y[y.length-n+i];
        sx += xi; sy += yi; sxy += xi * yi; sx2 += xi * xi; sy2 += yi * yi;
      }
      const num = n * sxy - sx * sy;
      const den = Math.sqrt((n*sx2 - sx*sx) * (n*sy2 - sy*sy));
      return den ? num / den : null;
    };
    const cellColor = (c) => {
      if (c == null) return { bg: 'var(--bg3)', fg: 'var(--text3)' };
      const v = Math.max(-1, Math.min(1, c));
      if (v >= 0) {
        const a = 0.15 + v * 0.55;
        return { bg: `rgba(45,195,115,${a.toFixed(2)})`, fg: v > 0.4 ? '#fff' : '#c7ecd6' };
      }
      const a = 0.15 + (-v) * 0.55;
      return { bg: `rgba(240,85,105,${a.toFixed(2)})`, fg: -v > 0.4 ? '#fff' : '#ffd4da' };
    };
    let html = `<div style="overflow-x:auto"><table style="border-collapse:separate;border-spacing:2px;font-size:12.5px;margin:0 auto"><thead><tr><th style="width:36px"></th>${valid.map(a => `<th style="font-weight:600;color:var(--text2);padding:2px 1px;text-align:center;min-width:32px">${escHtml(a.n)}</th>`).join('')}</tr></thead><tbody>`;
    for (const a of valid) {
      html += `<tr><td style="font-weight:600;color:var(--text2);padding:3px 4px;white-space:nowrap;text-align:right">${escHtml(a.n)}</td>`;
      for (const b of valid) {
        const c = a.t === b.t ? 1 : corr(returns[a.t], returns[b.t]);
        const col = cellColor(c);
        html += `<td style="background:${col.bg};color:${col.fg};text-align:center;padding:3px 4px;border-radius:3px;font-weight:600;font-family:var(--font-mono,monospace);min-width:32px">${c != null ? c.toFixed(2) : '—'}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table></div><div style="font-size:12px;color:var(--text3);text-align:center;margin-top:6px">+1: 같이 움직임 / 0: 무상관 / −1: 반대로</div>';
    el.innerHTML = html;
  } catch { el.innerHTML = '<div style="color:var(--red);font-size:13.5px;text-align:center">로드 실패</div>'; }
}

async function loadHeatmap() {
  if (_hmInFlight) return;
  _hmInFlight = true;
  const grid = document.getElementById('heatmapGrid');
  if (!grid) { _hmInFlight = false; return; }
  updateHeatmapViewToggleUI();

  const list = HEATMAP_TICKERS[_hmMkt] || [];
  const tickers = list.map(x => x.t);
  const nameMap = Object.fromEntries(list.map(x => [x.t, x.n]));
  const effectiveView = heatmapSectorApplicable() ? _hmView : 'all';
  const drillSector = effectiveView === 'sector' ? _hmSectorDrill : null;
  const structureKey = `${_hmMkt}|${_hmRange}|${effectiveView}|${drillSector || ''}|${tickers.join(',')}`;
  const needsRebuild = structureKey !== _hmStructureKey;

  if (needsRebuild) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text3);font-size:14.5px;padding:20px">로딩 중...</div>';
  }

  try {
    let items;
    // 세션은 자동 감지: 야후 marketState(휴장일 반영) 기준으로 프리/애프터 시세를 자동 적용
    let liveSession = null;   // 'pre' | 'post' | 'kr-ot' | null(정규/마감)
    let domState = null;      // 다수결 marketState (상태 배지용)

    // 시총 정렬용 상장주식수는 최초 1회만 받아 캐시(정적 JSON, CDN 캐시됨)
    const [r] = await Promise.all([
      fetch(`/api/quotes?tickers=${tickers.join(',')}&range=${_hmRange}`),
      loadSharesOutstanding(),
    ]);
    const j = await r.json();
    if (!j.ok) throw new Error('fetch failed');
    const data = j.data || {};

    // marketState 다수결 (휴장·마감·프리장 판별 — 시계가 아니라 거래소 캘린더 기준)
    const stateCount = {};
    for (const d of Object.values(data)) {
      if (d?.marketState) stateCount[d.marketState] = (stateCount[d.marketState] || 0) + 1;
    }
    domState = Object.entries(stateCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    items = tickers.map(t => {
      const d = data[t];
      if (!d) return null;
      let pct, price = d.price, session = null;
      if (_hmRange === '1mo') pct = d.periodChangePercent;
      else if (d.marketState === 'PRE' && d.preMarketChangePercent != null) {
        pct = d.preMarketChangePercent; price = d.preMarketPrice ?? price; session = 'pre'; liveSession = 'pre';
      } else if (d.marketState === 'POST' && d.postMarketChangePercent != null) {
        pct = d.postMarketChangePercent; price = d.postMarketPrice ?? price; session = 'post'; liveSession = 'post';
      } else pct = d.changePercent;
      // 트리맵 박스 크기 기준(거래대금) — 통화가 섞이지 않게 시장별로 상대비교만 하면 되므로
      // 환산 없이 price×volume 원값을 쓴다(같은 시장 안에서만 비교됨).
      const tradingValue = (d.volume != null && price != null) ? d.volume * price : 0;
      return { ticker: t, pct, price, currency: d.currency, name: nameMap[t] || d.shortName || t, session, tradingValue };
    }).filter(x => x && x.pct != null);

    // 국장 시간외(15:40–18:00 KST) — Yahoo가 KRX 시간외를 제공하지 않아 네이버 시세를 덮어씀
    if (_hmMkt === 'kr' && _hmRange === '1d') {
      const kst = new Date(Date.now() + 9 * 3600 * 1000);
      const km = kst.getUTCHours() * 60 + kst.getUTCMinutes();
      const kd = kst.getUTCDay();
      if (kd >= 1 && kd <= 5 && km >= 940 && km < 1080) {
        try {
          const codes = tickers.map(t => t.replace(/\.(KS|KQ)$/, ''));
          const or = await fetch(`/api/kr-overtime?codes=${codes.join(',')}&session=post`);
          const oj = await or.json();
          const od = oj?.data || {};
          let applied = 0;
          for (const it of items) {
            const d = od[it.ticker.replace(/\.(KS|KQ)$/, '')];
            if (d && d.pct != null) { it.pct = d.pct; it.price = d.price; applied++; }
          }
          if (applied > 0) liveSession = 'kr-ot';
        } catch {}
      }
    }
    items.sort((a, b) => (b.pct || 0) - (a.pct || 0));

    // Finviz 스타일 트리맵 하나로 통일(2026-07-27) — 섹터/ETF/자산 탭, 일간·월간, 섹터별/
    // 개별종목 뷰 토글을 전부 없애고 미장·국장 두 개만 남겼다. 갱신 때마다 통째로 다시 그린다
    // (박스 위치·크기가 거래대금에 따라 매번 바뀌어서 부분 갱신이 의미 없음).
    renderHeatmapTreemap(grid, items);
    _hmStructureKey = structureKey;

    // 마지막 갱신 시각 + 마켓 상태 + 아이템 카운트
    const now = new Date();
    const upEl = document.getElementById('heatmapUpdatedAt');
    if (upEl) upEl.textContent = `${now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })} 기준`;
    const statusEl = document.getElementById('heatmapMarketStatus');
    if (statusEl) {
      const status = computeMarketStatusFromData(_hmMkt, domState, liveSession);
      statusEl.textContent = status.label;
      statusEl.style.background = status.bg;
      statusEl.style.color = status.fg;
    }
    const countEl = document.getElementById('heatmapItemCount');
    if (countEl) {
      // 표시 종목 수는 트리맵 하단 범례가 안내하므로 여기선 데이터 결손만 알린다.
      const missing = tickers.length - items.length;
      countEl.textContent = missing > 0 ? `${missing}개 종목 데이터 없음` : '';
    }
  } catch (e) {
    if (needsRebuild) grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--red);font-size:14.5px;padding:20px">로드 실패: ${e.message}</div>`;
  } finally {
    _hmInFlight = false;
  }
}

function escAttr(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// 거래소 캘린더 기반 마켓 상태 — 야후 marketState가 1차 소스, 시계 기반은 폴백.
// 공휴일에 시계만 보고 '프리장'으로 표시하던 문제 해결: 야후가 CLOSED면 시계가 뭐라든 휴장.
function computeMarketStatusFromData(market, domState, liveSession) {
  if (market === 'assets' || !domState) return computeMarketStatus(market);
  const isUs = market !== 'kr';
  if (liveSession === 'kr-ot') return { label: '🟠 국장 시간외 (15:40–18:00)', bg: 'rgba(255,165,0,0.15)', fg: '#e0902e' };
  switch (domState) {
    case 'REGULAR':
      return { label: isUs ? '🟢 미국 정규장' : '🟢 정규장 진행 중', bg: 'var(--green-dim)', fg: 'var(--green)' };
    case 'PRE':
      return liveSession === 'pre'
        ? { label: '🟡 미국 프리장 (시세 반영 중)', bg: 'var(--yellow-dim)', fg: 'var(--yellow)' }
        : { label: '🟡 개장 전', bg: 'var(--yellow-dim)', fg: 'var(--yellow)' };
    case 'PREPRE':
      return { label: '🟡 개장 전', bg: 'var(--yellow-dim)', fg: 'var(--yellow)' };
    case 'POST':
      return liveSession === 'post'
        ? { label: '🟠 미국 애프터마켓 (시세 반영 중)', bg: 'rgba(255,165,0,0.15)', fg: '#e0902e' }
        : { label: '🟠 미국 애프터마켓', bg: 'rgba(255,165,0,0.15)', fg: '#e0902e' };
    case 'POSTPOST':
      return { label: '⚪ 마감', bg: 'rgba(0,0,0,0.06)', fg: 'var(--text3)' };
    case 'CLOSED': {
      // 시계로는 장중·프리·애프터여야 하는데 거래소는 CLOSED → 공휴일
      const clock = computeMarketStatus(market);
      const shouldBeOpen = /정규장|프리장|애프터|시간외/.test(clock.label);
      if (shouldBeOpen) return { label: '🔴 휴장 (공휴일)', bg: 'var(--red-dim)', fg: 'var(--red)' };
      return clock;  // 주말·야간 → 기존 라벨 그대로
    }
    default:
      return computeMarketStatus(market);
  }
}

// ─── 📅 선물·옵션 만기일 ───────────────────────────────────
function nthWeekdayOfMonth(year, month, weekday, n) {
  // month: 0-11, weekday: 0(Sun)~6(Sat)
  const first = new Date(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + offset + (n - 1) * 7);
}
function loadExpiries() {
  const panel = document.getElementById('expiryPanel');
  if (!panel) return;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const items = [];

  // 미국 옵션: 매월 셋째 금요일
  for (let i = 0; i < 4; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const exp = nthWeekdayOfMonth(d.getFullYear(), d.getMonth(), 5, 3);
    if (exp >= today) {
      const isQuad = [2,5,8,11].includes(exp.getMonth()); // 3,6,9,12월
      items.push({
        d: exp,
        label: isQuad ? '🇺🇸 쿼드러플 위칭' : '🇺🇸 미국 옵션 만기',
        sub: isQuad ? '선물·옵션·지수 동시만기' : '월간 옵션',
      });
      if (items.filter(x => x.label.startsWith('🇺🇸')).length >= 2) break;
    }
  }

  // 한국 옵션: 매월 둘째 목요일
  for (let i = 0; i < 4; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const exp = nthWeekdayOfMonth(d.getFullYear(), d.getMonth(), 4, 2);
    if (exp >= today) {
      const isQuarter = [2,5,8,11].includes(exp.getMonth());
      items.push({
        d: exp,
        label: isQuarter ? '🇰🇷 KOSPI200 쿼드' : '🇰🇷 KOSPI200 옵션',
        sub: isQuarter ? '선물·옵션 동시만기' : '월간 옵션',
      });
      if (items.filter(x => x.label.startsWith('🇰🇷')).length >= 2) break;
    }
  }

  items.sort((a, b) => a.d - b.d);
  const fmtDate = (d) => `${d.getMonth()+1}/${d.getDate()} (${['일','월','화','수','목','금','토'][d.getDay()]})`;
  const daysLeft = (d) => Math.ceil((d - today) / 86400000);

  panel.innerHTML = items.slice(0, 5).map(it => {
    const dl = daysLeft(it.d);
    const urgent = dl <= 7;
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:14.5px">
      <div style="display:flex;flex-direction:column;gap:2px">
        <span style="font-weight:600;color:var(--text)">${it.label}</span>
        <span style="font-size:13px;color:var(--text3)">${it.sub} · ${fmtDate(it.d)}</span>
      </div>
      <span style="font-size:13.5px;font-weight:700;color:${urgent ? 'var(--red)' : 'var(--text2)'};white-space:nowrap">D-${dl}</span>
    </div>`;
  }).join('') || '<div style="color:var(--text3);font-size:13.5px;text-align:center;padding:8px 0">예정 없음</div>';
}

// 자산/지수/FX/원자재/크립토 → TradingView 새 창
function openTickerInTradingView(ticker) {
  // 매핑: Yahoo 심볼 → TradingView 심볼
  const map = {
    '^GSPC':'SPX', '^IXIC':'NASDAQ:IXIC', '^DJI':'DJI', '^RUT':'RUT', '^VIX':'TVC:VIX',
    '^KS11':'KRX:KOSPI', '^KQ11':'KRX:KOSDAQ', '^N225':'TVC:NI225', '^HSI':'TVC:HSI',
    '000001.SS':'SSE:000001', '^FTSE':'TVC:UKX', '^GDAXI':'TVC:DEU40', '^FCHI':'TVC:FRA40',
    '^IRX':'TVC:US03MY', '^FVX':'TVC:US05Y', '^TNX':'TVC:US10Y', '^TYX':'TVC:US30Y',
    'GC=F':'TVC:GOLD', 'SI=F':'TVC:SILVER', 'PL=F':'TVC:PLATINUM',
    'CL=F':'TVC:USOIL', 'BZ=F':'TVC:UKOIL', 'NG=F':'TVC:NATGAS', 'HG=F':'TVC:COPPER',
    'ZC=F':'TVC:CORN', 'ZW=F':'TVC:WHEAT',
    'DX-Y.NYB':'TVC:DXY', 'KRW=X':'FX_IDC:USDKRW', 'JPY=X':'FX_IDC:USDJPY',
    'EURUSD=X':'FX_IDC:EURUSD', 'GBPUSD=X':'FX_IDC:GBPUSD',
    'AUDUSD=X':'FX_IDC:AUDUSD', 'CNY=X':'FX_IDC:USDCNY',
    'BTC-USD':'BITSTAMP:BTCUSD', 'ETH-USD':'BITSTAMP:ETHUSD',
    'SOL-USD':'BINANCE:SOLUSD',  'XRP-USD':'BITSTAMP:XRPUSD',
  };
  const tvSym = map[ticker] || ticker;
  const url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSym)}`;
  window.open(url, '_blank', 'noopener');
}

// US 서머타임(EDT, UTC-4): 3월 둘째 일요일 ~ 11월 첫째 일요일. 그 외 EST(UTC-5)
function getEtOffsetHours() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const dstStart = new Date(Date.UTC(year, 2, 1));
  dstStart.setUTCDate(1 + ((7 - dstStart.getUTCDay()) % 7) + 7);  // 3월 둘째 일요일
  const dstEnd = new Date(Date.UTC(year, 10, 1));
  dstEnd.setUTCDate(1 + ((7 - dstEnd.getUTCDay()) % 7));            // 11월 첫째 일요일
  return (now >= dstStart && now < dstEnd) ? -4 : -5;
}

// 마켓 개장 상태 (시장별 현지 시간 기준)
function computeMarketStatus(market) {
  if (market === 'kr') {
    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const day = kst.getUTCDay();
    const minOfDay = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    if (day === 0 || day === 6) return { label: '🔴 휴장', bg: 'rgba(0,0,0,0.06)', fg: 'var(--text3)' };
    if (minOfDay < 510)  return { label: `🟡 개장 전 (9:00 시작, ${510 - minOfDay}분 후)`, bg: 'var(--yellow-dim)', fg: 'var(--yellow)' };
    if (minOfDay < 930)  return { label: '🟢 정규장 진행 중', bg: 'var(--green-dim)', fg: 'var(--green)' };
    if (minOfDay < 1080) return { label: '🟠 시간외', bg: 'rgba(255,165,0,0.15)', fg: '#e0902e' };
    return { label: '⚪ 마감', bg: 'rgba(0,0,0,0.06)', fg: 'var(--text3)' };
  }
  if (market === 'assets') {
    return { label: '🌍 멀티에셋 (크립토 24/7 · 기타 자산별)', bg: 'var(--blue-dim)', fg: 'var(--blue)' };
  }
  // us / sector / etf → ET 기준
  const etOffset = getEtOffsetHours();
  const et = new Date(Date.now() + etOffset * 3600 * 1000);
  const day = et.getUTCDay();
  const minOfDay = et.getUTCHours() * 60 + et.getUTCMinutes();
  if (day === 0 || day === 6) return { label: '🔴 휴장 (주말)', bg: 'rgba(0,0,0,0.06)', fg: 'var(--text3)' };
  if (minOfDay >= 570 && minOfDay < 960) return { label: '🟢 미국 정규장', bg: 'var(--green-dim)', fg: 'var(--green)' };           // 9:30-16:00
  if (minOfDay >= 240 && minOfDay < 570) return { label: '🟡 미국 프리장', bg: 'var(--yellow-dim)', fg: 'var(--yellow)' };          // 4:00-9:30
  if (minOfDay >= 960 && minOfDay < 1200) return { label: '🟠 미국 애프터', bg: 'rgba(255,165,0,0.15)', fg: '#e0902e' };           // 16:00-20:00
  return { label: '⚪ 마감', bg: 'rgba(0,0,0,0.06)', fg: 'var(--text3)' };
}

// 신규 위젯 초기화 — load 이벤트 의존하지 않고 즉시 실행 (DOM은 이미 파싱됨)
(function initNewWidgets() {
  const kick = async () => {
    try { loadHeatmap();          } catch (e) { console.error('heatmap', e); }
    try { loadExpiries();         } catch (e) { console.error('expiries', e); }
    // checkNewReports가 "안 읽음" 여부를 localStorage seen값과 비교해 토스트를 띄우는데,
    // loadAiMarketSummary/loadDailyReport는 렌더링과 동시에 markAiMsSeen/markReportSeen으로
    // seen값을 바로 덮어써버린다. 순서가 바뀌면(먼저 render) 토스트가 뜨기도 전에 이미
    // "읽음" 처리돼 영원히 안 뜨는 레이스가 생기므로, 반드시 먼저 await로 완료시킨다.
    try { await checkNewReports(); } catch (e) { console.error('checkNewReports', e); }
    try { loadAiMarketSummary();  } catch (e) { console.error('aims', e); }
    try { loadWeeklySchedule();   } catch (e) { console.error('wsched', e); }
    try { loadDailyReport();      } catch (e) { console.error('dailyReport', e); }
    try { updateFeedLiveTag();    } catch (e) { console.error('feedLiveTag', e); }
    try { loadSectorMomentum();   } catch (e) { console.error('sectorMo', e); }
    try { loadCorrelation();      } catch (e) { console.error('corr', e); }
    try { loadKrMarket();         } catch (e) { console.error('krMarket', e); }
    try { loadKrSummary();        } catch (e) { console.error('krSummary', e); }
    try { loadTrendPanel();       } catch (e) { console.error('trendPanel', e); }
    try { if (document.getElementById('marketSectionToggle')) switchMarketSection('kr'); } catch (e) { console.error('marketSection', e); }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', kick, { once: true });
  } else {
    kick();
  }
  // 15초마다 히트맵 갱신 — 과거엔 1초 간격이었는데, edge cache가 모든 사용자의
  // 쿼리스트링이 완전히 같을 때만 origin 호출을 흡수해줘서 실사용자 트래픽이 조금만
  // 몰려도 origin→Yahoo Finance 팬아웃(요청당 최대 600개 티커)이 초당 수십 회씩
  // 발생해 Yahoo 레이트리밋 + Supabase/게이트웨이 타임아웃까지 이어지는 장애가 있었음.
  setInterval(() => { if (document.hidden) return; try { loadHeatmap(); } catch {} }, 15000);
  // 60초 섹터 모멘텀
  setInterval(() => { if (document.hidden) return; try { loadSectorMomentum(); } catch {} }, 60000);
  // 30분 상관관계 (시계열이라 자주 갱신 불필요)
  setInterval(() => { try { loadCorrelation(); } catch {} }, 1800000);
  // 1시간마다 새 리포트/AI 종합 감지(토스트) → AI 시장 종합 + 데일리 리포트 새로고침.
  // kick()과 동일한 이유로 checkNewReports가 먼저 끝나야 render 쪽의 markSeen이 토스트를 가리지 않는다.
  setInterval(async () => {
    try { delete _drCache.US; delete _drCache.KR; await checkNewReports(); } catch (e) { console.error('checkNewReports', e); }
    try { loadAiMarketSummary(); } catch (e) { console.error('aims', e); }
    try { loadDailyReport();     } catch (e) { console.error('dailyReport', e); }
  }, 3600000);
  // 만기일은 자정 지나면 갱신
  setInterval(() => { try { loadExpiries(); } catch {} }, 3600000);
  // 이슈 피드 실시간: 장중 45초마다 새 이슈 감지(배너), 30초마다 LIVE 태그 갱신
  setInterval(() => { if (document.hidden) return; try { pollNewIssues(); } catch {} }, 45000);
  setInterval(() => { if (document.hidden) return; try { updateFeedLiveTag(); } catch {} }, 30000);
  // 장중 브라우저 구동 수집: 즉시 1회 + 5분마다 (서버가 게이트·레이트리밋 — 간격을 늘려
  // 동시접속자 많을 때 Claude 호출이 겹쳐 불어나는 걸 추가로 방지, 비용 급증 대응 2026-07)
  try { triggerLiveCollect(); } catch {}
  setInterval(() => { if (document.hidden) return; try { triggerLiveCollect(); } catch {} }, 300000);
  // 5분마다 국장 현황 새로고침
  setInterval(() => { if (document.hidden) return; try { delete _kmCache[_kmTab]; loadKrMarket(); } catch {} }, 300000);
  // 1분마다 국장 요약(지수 카드 + 인기검색 + 수급차트) 새로고침
  setInterval(() => { if (document.hidden) return; try { loadKrSummary(); } catch {} }, 60000);
  // 미장현황 탭이 보일 때만 새로고침 (숨겨져 있으면 불필요한 호출 방지)
  setInterval(() => { if (document.hidden) return; try { if (_marketSection === 'us') loadUsSummary(); } catch {} }, 60000);
  setInterval(() => { if (document.hidden) return; try { if (_marketSection === 'us') { delete _usmCache[_usmTab]; loadUsMarket(); } } catch {} }, 300000);
  // 백그라운드 탭에서 멈춘 폴링을 탭 복귀 시 즉시 한 번 따라잡기
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    try { loadHeatmap(); } catch {}
    try { loadSectorMomentum(); } catch {}
    try { pollNewIssues(); } catch {}
    try { updateFeedLiveTag(); } catch {}
    try { loadKrMarket(); } catch {}
    try { loadKrSummary(); } catch {}
    if (_marketSection === 'us') { try { loadUsSummary(); } catch {} try { loadUsMarket(); } catch {} }
  });
})();

// ─── 종목 검색 결과 카드 모달 ─────────────────────────────
function openSearchPicker(query, matches) {
  const modal = document.getElementById('searchPickerModal');
  const grid  = document.getElementById('searchPickerGrid');
  document.getElementById('searchPickerQuery').textContent = query;
  document.getElementById('searchPickerCount').textContent = `${matches.length}건`;

  grid.innerHTML = matches.map(m => {
    const isKr = m.market === 'KR' || /\.K[SQ]$/i.test(m.ticker);
    const tickerStripped = m.ticker.replace(/\.(KS|KQ)$/i, '');
    const badgeColor = isKr ? 'rgba(0,102,204,0.10)' : 'rgba(124,58,237,0.10)';
    const badgeText  = isKr ? '#4d8dff' : '#9d7bff';
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

// ── 🔍 홈 검색 히어로 (index.html 전용, 2026-08 개편) ──────────────────
// 자동완성 매칭 로직은 새로 안 짜고 site-header.js의 hFindMatches(엘리먼트 id에
// 의존하지 않는 순수 함수)를 그대로 재사용, 대상 DOM(#heroSearchInput/#heroSugBox)만 다르다.
// #heroSearchInput이 없는 페이지(홈 외 전부)에서는 아래 함수들이 전부 조용히 no-op.
let _heroSugTimer = null;
function onHeroSearchInput(v) {
  clearTimeout(_heroSugTimer);
  const q = (v || '').trim();
  const box = document.getElementById('heroSugBox');
  if (!box) return;
  if (q.length < 1) { box.innerHTML = ''; return; }
  _heroSugTimer = setTimeout(() => runHeroSearch(q), 220);
}

// 이슈 피드 섹터 필터 칩(index.html #categoryTabs 옆 .filters)과 동일한 실제 태그 값 —
// 사용자가 이 중 하나를 정확히 입력하면 회사명 부분일치 검색으로 넘기지 않는다.
// (실측 버그: "반도체" 입력 시 hFindMatches가 회사명에 "반도체"가 포함된 "제주반도체"를
// 찾아 그리로 보내버림 — 사용자는 반도체 "산업" 뉴스를 원했지 그 회사를 원한 게 아니었음.
// 이 목록에 정확히 일치하면 종목 검색 자체를 생략하고 뉴스 섹터 필터로 우선 보낸다.)
const SECTOR_KEYWORDS = ['AI', '반도체', '전기차', '배터리', '바이오', '에너지', '핀테크', '금융', '클라우드', '로봇', '방산·우주', '게임', '크립토', '자동차', '물류·운송'];
function matchSectorKeyword(raw) {
  const q = (raw || '').trim();
  return SECTOR_KEYWORDS.find(s => s.toLowerCase() === q.toLowerCase()) || null;
}

async function runHeroSearch(q) {
  const box = document.getElementById('heroSugBox');
  if (!box || typeof hFindMatches !== 'function') return;
  const sectorMatch = matchSectorKeyword(q);
  box.innerHTML = `<div class="hsug"><div class="hsug-loading">검색 중…</div></div>`;
  const items = sectorMatch ? [] : await hFindMatches(q);
  const cur = (document.getElementById('heroSearchInput')?.value || '').trim();
  if (cur !== q) return;
  const sectorHtml = sectorMatch
    ? `<a class="hsug-item" href="/news.html?sector=${encodeURIComponent(sectorMatch)}">
        <span class="hsug-nm">🔥 "${escHtml(sectorMatch)}" 관련 뉴스 전체 보기</span>
      </a>`
    : '';
  box.innerHTML = (sectorHtml || items.length)
    ? `<div class="hsug">${sectorHtml}${items.map(m => {
        const isKr = m.market === 'KR' || /\.K[SQ]$/i.test(m.ticker);
        return `<a class="hsug-item" href="/company.html?ticker=${encodeURIComponent(m.ticker)}">
          <span class="hsug-tk ${isKr ? 'kr' : 'us'}">${escHtml(m.ticker.replace(/\.(KS|KQ)$/i, ''))}</span>
          <span class="hsug-nm">${escHtml(m.name_ko || m.name_en || m.ticker)}</span>
          <span class="hsug-mkt">${isKr ? '국내' : '미국'}</span>
        </a>`;
      }).join('')}</div>`
    : `<div class="hsug"><div class="hsug-empty">"${escHtml(q)}" 종목을 찾지 못했습니다. Enter를 누르면 뉴스에서 검색합니다 →</div></div>`;
}

// 종목으로 못 찾으면 뉴스 검색으로 폴백 — 이 사이트의 핵심은 종목 추천이 아니라
// "뉴스가 어떤 산업·기업에 영향을 주는지" 탐색이라, 검색이 막다른 길이 되지 않게 한다.
async function heroSearchEnter(v) {
  const raw = (v || '').trim();
  if (!raw) return;
  const sectorMatch = matchSectorKeyword(raw);
  if (sectorMatch) { location.href = `/news.html?sector=${encodeURIComponent(sectorMatch)}`; return; }
  const box = document.getElementById('heroSugBox');
  const first = box?.querySelector('.hsug-item');
  if (first) { location.href = first.getAttribute('href'); return; }
  const items = await hFindMatches(raw);
  if (items.length) { location.href = `/company.html?ticker=${encodeURIComponent(items[0].ticker)}`; return; }
  location.href = `/news.html?q=${encodeURIComponent(raw)}`;
}

// 예시 칩 — 종목명 칩(삼성전자/테슬라)은 바로 종목 조회, 키워드 칩(AI/반도체)은
// 애초에 종목명이 아니므로 종목 검색을 시도하지 않고 뉴스의 섹터 필터로 보낸다
// (AI/반도체는 이슈 피드가 이미 쓰는 실제 sectors 태그 값이라 제목 텍스트 검색보다 정확).
function heroChipClick(type, text) {
  const input = document.getElementById('heroSearchInput');
  if (input) input.value = text;
  if (type === 'keyword') { location.href = `/news.html?sector=${encodeURIComponent(text)}`; return; }
  heroSearchEnter(text);
}

document.addEventListener('click', e => {
  if (!e.target.closest('#heroSearchBox')) {
    const box = document.getElementById('heroSugBox');
    if (box) box.innerHTML = '';
  }
});

// ── ⭐ 관심종목 뉴스 모아보기 (index.html 전용, 2026-08) ──────────────────
// analysis_companies를 직접 조회하지 않는다 — expose_ripple_effects 플래그가 꺼져
// 있으면(기본값, 유사투자자문업 대응) 그 조인 데이터는 공개 노출 금지 대상이라
// 클라이언트에서 직접 조회하면 서버(api/admin.js handleIssuesFeed)의 게이트를
// 우회하게 된다. 대신 워치리스트 티커의 회사명(공개 참고 데이터)만 조회해서,
// 기존 공개 검색 엔드포인트(q=회사명, title.ilike 매칭)를 그대로 재사용한다.
let _wlNewsActive = false;
async function toggleWatchlistNews() {
  const btn = document.getElementById('wlNewsToggle');
  if (!btn) return;
  if (!_wlNewsActive) {
    if (!currentUser) { openAuthModal(); return; }
    if (!watchlistCache.size) { showToast('관심종목이 없습니다. 종목 카드의 ☆를 눌러 추가해보세요'); return; }
    _wlNewsActive = true;
    btn.classList.add('active');
    btn.textContent = '← 전체 뉴스로';
    await loadWatchlistIssues();
  } else {
    _wlNewsActive = false;
    btn.classList.remove('active');
    btn.textContent = '⭐ 관심종목만';
    currentPage = 1;
    loadIssues();
  }
}

async function loadWatchlistIssues() {
  const container = document.getElementById('issuesContainer');
  if (!container) return;
  container.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>관심종목 뉴스 불러오는 중...</p></div>';
  const pg = document.getElementById('pagination');
  if (pg) pg.innerHTML = '';

  const tickers = [...watchlistCache];
  let names = [];
  try {
    const { data } = await sb.from('companies').select('name_ko, name_en').in('ticker', tickers);
    names = [...new Set((data || []).flatMap(c => [c.name_ko, c.name_en].filter(Boolean)))];
  } catch {}
  if (!names.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⭐</div><p class="empty-title">관심종목 정보를 찾을 수 없습니다</p></div>`;
    return;
  }

  try {
    const results = await Promise.all(names.slice(0, 10).map(name =>
      fetch(`/api/admin?action=issues-feed&page=1&pageSize=10&q=${encodeURIComponent(name)}`).then(r => r.json()).catch(() => null)
    ));
    const byId = new Map();
    for (const r of results) {
      if (!r?.ok) continue;
      for (const issue of (r.data || [])) byId.set(issue.id, issue);
    }
    const issues = [...byId.values()].sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
    if (!issues.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">⭐</div><p class="empty-title">관심종목 관련 뉴스가 아직 없습니다</p><p class="empty-sub">관심종목 이름이 제목에 포함된 새 이슈가 나오면 여기에 표시됩니다.</p></div>`;
      return;
    }
    container.innerHTML = `<div class="issues-grid">${issues.map(renderIssueCard).join('')}</div>`;
  } catch {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p class="empty-title">불러오기 실패</p><p class="empty-sub">잠시 후 다시 시도해주세요.</p></div>`;
  }
}
