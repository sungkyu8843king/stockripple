
const SUPABASE_URL = 'https://nmvfffzpkqyzztiobwtt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_22PPW0eCY3Tvy3vZVZYKFw_yCb8cI2f';

// 만료된 Supabase 세션이 페이지 쿼리를 멈추게 만드는 버그 방지
// (admin 페이지에서 로그인한 세션이 깨진 상태로 남아있을 때 발생)
try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('sb-') || !key.endsWith('-auth-token')) continue;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const exp = parsed?.expires_at;
      // expires_at은 Unix 초. 현재 시각보다 과거면 제거
      if (typeof exp === 'number' && exp * 1000 < Date.now()) {
        localStorage.removeItem(key);
        console.info('[StockRipple] 만료된 세션 자동 제거:', key);
      }
    } catch { localStorage.removeItem(key); }  // 파싱 실패한 토큰도 제거
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

const PAGE_SIZE = 8;   // 홈 미리보기 노출량 축소 (기존 20 → 8, 페이지네이션으로 더 보기)
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


async function loadIssues() {
  const container = document.getElementById('issuesContainer');
  if (!container) return;
  container.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>이슈 불러오는 중...</p></div>';

  let query = sb.from('issues')
    .select(`
      id, title, summary, source_name, published_at, sectors, is_analyzed,
      analyses!inner(id, confidence_score, ripple_effects, ai_summary,
        analysis_companies(upside_pct, ripple_sector, is_accurate_1d, actual_return_1d, is_accurate_7d, actual_return_7d,
          companies(ticker, name_ko, name_en, market)
        )
      )
    `)
    .eq('is_analyzed', true)
    .order('published_at', { ascending: false });

  if (currentSector !== 'all') query = query.contains('sectors', [currentSector]);
  if (searchQuery) query = query.ilike('title', `%${searchQuery}%`);

  // 카테고리 탭 필터
  const catFilters = {
    earnings: 'title.ilike.%실적%,title.ilike.%어닝%,title.ilike.%earnings%,title.ilike.%EPS%,title.ilike.%revenue%,sectors.cs.{실적발표}',
    politics: 'title.ilike.%관세%,title.ilike.%무역%,title.ilike.%외교%,title.ilike.%제재%,title.ilike.%tariff%,title.ilike.%trade%,title.ilike.%geopolit%,title.ilike.%정치%,sectors.cs.{정치},sectors.cs.{외교},sectors.cs.{정세}',
    economy:  'title.ilike.%금리%,title.ilike.%Fed%,title.ilike.%FOMC%,title.ilike.%물가%,title.ilike.%GDP%,title.ilike.%고용%,title.ilike.%인플레%,sectors.cs.{경제},sectors.cs.{금리},sectors.cs.{물가}',
    // sectors 태그(분석 시 역태깅됨) + 제목 검색 폴백(태깅 이전 과거 이슈 대응)
    tech:     'sectors.cs.{AI},sectors.cs.{반도체},sectors.cs.{클라우드},sectors.cs.{IT},sectors.cs.{로봇},title.ilike.%반도체%,title.ilike.%인공지능%,title.ilike.%semiconductor%,title.ilike.%엔비디아%,title.ilike.%nvidia%,title.ilike.%HBM%,title.ilike.%chip%',
    bio:      'sectors.cs.{바이오},sectors.cs.{제약},sectors.cs.{헬스케어},title.ilike.%바이오%,title.ilike.%제약%,title.ilike.%신약%,title.ilike.%임상%,title.ilike.%FDA%,title.ilike.%biotech%,title.ilike.%pharma%',
    ev:       'sectors.cs.{전기차},sectors.cs.{배터리},title.ilike.%전기차%,title.ilike.%배터리%,title.ilike.%테슬라%,title.ilike.%tesla%,title.ilike.%이차전지%,title.ilike.%2차전지%,title.ilike.%리튬%',
    energy:   'sectors.cs.{에너지},sectors.cs.{원전},title.ilike.%원전%,title.ilike.%원자력%,title.ilike.%에너지%,title.ilike.%유가%,title.ilike.%태양광%,title.ilike.%수소%,title.ilike.%전력%,title.ilike.%nuclear%,title.ilike.%oil%',
    defense:  'sectors.cs.{방산·우주},sectors.cs.{방산},sectors.cs.{우주},title.ilike.%방산%,title.ilike.%국방%,title.ilike.%미사일%,title.ilike.%위성%,title.ilike.%우주%,title.ilike.%로켓%,title.ilike.%defense%,title.ilike.%missile%',
    game:     'sectors.cs.{게임},sectors.cs.{엔터},title.ilike.%게임%,title.ilike.%K팝%,title.ilike.%k-팝%,title.ilike.%넷플릭스%,title.ilike.%하이브%,title.ilike.%엔터테인먼트%,title.ilike.%netflix%',
    crypto:   'sectors.cs.{크립토},sectors.cs.{암호화폐},title.ilike.%비트코인%,title.ilike.%암호화폐%,title.ilike.%이더리움%,title.ilike.%스테이블코인%,title.ilike.%bitcoin%,title.ilike.%crypto%,title.ilike.%stablecoin%',
  };
  if (currentCategory !== 'all' && catFilters[currentCategory]) {
    query = query.or(catFilters[currentCategory]);
  }

  // 전체 카운트를 위한 병렬 쿼리 (조인 없이 issues 테이블만, 동일 필터 적용)
  let countQuery = sb.from('issues')
    .select('id', { count: 'exact', head: true })
    .eq('is_analyzed', true);
  if (currentSector !== 'all') countQuery = countQuery.contains('sectors', [currentSector]);
  if (searchQuery) countQuery = countQuery.ilike('title', `%${searchQuery}%`);
  if (currentCategory !== 'all' && catFilters[currentCategory]) {
    countQuery = countQuery.or(catFilters[currentCategory]);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  let data, error;
  try {
    const [pageRes, countRes] = await Promise.all([
      query.abortSignal(ac.signal)
           .range((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE - 1),
      countQuery,
    ]);
    ({ data, error } = pageRes);
    if (typeof countRes?.count === 'number') totalCount = countRes.count;
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
async function pollNewIssues() {
  if (currentPage !== 1 || currentCategory !== 'all' || currentSector !== 'all' || searchQuery) return;
  if (!anyMarketOpenNow().any || !_feedTopTs) return;
  try {
    const { count } = await sb.from('issues').select('id', { count: 'exact', head: true })
      .eq('is_analyzed', true).gt('published_at', _feedTopTs);
    const banner = document.getElementById('newIssueBanner');
    const cnt = document.getElementById('newIssueCount');
    if (banner && cnt && count > 0) { cnt.textContent = count; banner.style.display = 'block'; }
  } catch {}
}

function showNewIssues() {
  currentPage = 1;
  loadIssues();
  const top = document.getElementById('issuesContainer');
  if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        ${analysis?.ai_summary ? `<div class="card-ai-summary">${escHtml(analysis.ai_summary)}</div>` : ''}
        ${sectors.length ? `<div class="card-flow-label">📡 파급 섹터</div><div class="card-sectors">${sectorTags}</div>` : ''}
      </div>
      ${companies.length ? `<div class="card-companies"><div class="card-flow-label">🎯 수혜 예상 종목</div>${companyRows}</div>` : ''}
      <div class="card-footer">
        <div class="footer-stat">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <span class="val blue">${companies.length}</span>개 기업
        </div>
        ${avgUpside != null ? `<div class="footer-stat"><span class="val green">+${avgUpside}%</span> 평균 예상</div>` : ''}
        ${accBadge}
        <div class="confidence-bar" title="분석 신뢰도 ${confidence}%">
          <div class="confidence-fill" style="width:${confidence}%"></div>
        </div>
        <span class="view-btn">분석 보기 →</span>
        <button class="share-btn" data-share-title="${escAttr(issue.title)}" data-share-url="${escAttr(`${location.origin}/analysis/${issue.id}`)}" onclick="shareContent(event, this)" title="공유하기">🔗</button>
      </div>
    </a>`;
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
  // 페이지 이동 시 이슈 섹션 상단으로 스크롤
  const issuesTop = document.getElementById('issuesContainer');
  if (issuesTop) issuesTop.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  const icons = { success: '✓', error: '✗', info: 'ℹ' };
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
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
let currentUser = null;
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
    container.innerHTML = `<div class="watchlist-empty"><div style="font-size:48px;margin-bottom:16px">🔐</div><p style="font-size:20px;font-weight:600;margin-bottom:8px">로그인이 필요합니다</p><p style="font-size:14px;color:var(--text2);margin-bottom:24px">관심종목을 저장하려면 로그인하세요.</p><button class="empty-btn" onclick="openAuthModal()">로그인 / 회원가입</button></div>`;
    return;
  }
  const { data: list } = await sb.from('user_watchlist').select('ticker,name,market').order('added_at', { ascending: false });
  if (!list?.length) {
    container.innerHTML = `<div class="watchlist-empty"><div style="font-size:48px;margin-bottom:16px">⭐</div><p style="font-size:20px;font-weight:600;margin-bottom:8px">관심종목이 없습니다</p><p style="font-size:14px;color:var(--text2)">피드에서 기업 옆의 ☆ 버튼을 눌러 추가하세요.</p></div>`;
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

/* ── Auth Modal ── */
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
  // 회원가입 모드에서만 개인정보 수집·이용 동의 체크박스 노출 (이메일/Google 둘 다 적용)
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
async function doSignOut() {
  await sb.auth.signOut();
  watchlistCache.clear();
  renderUserMenu(null);
  showToast('로그아웃 했습니다', 'info');
}
function toggleUserDropdown() {
  const dd = document.getElementById('userDropdown');
  dd.style.display = dd.style.display === 'none' ? '' : 'none';
}
document.addEventListener('click', e => {
  if (!e.target.closest('#userMenu')) {
    const dd = document.getElementById('userDropdown');
    if (dd) dd.style.display = 'none';
  }
});

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

// 채워진 영역(area) 스파크라인 SVG — 시장 지표 대시보드 전용(홈 히어로/카드)
function areaSparkSvg(points, w, h, color) {
  if (!Array.isArray(points) || points.length < 2) return '';
  const min = Math.min(...points), max = Math.max(...points);
  const span = (max - min) || 1;
  const step = w / (points.length - 1);
  const coords = points.map((p, i) => [i * step, (h - 1) - ((p - min) / span) * (h - 2)]);
  const linePath = coords.map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join('');
  const gid = 'msg' + Math.random().toString(36).slice(2, 9);
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.32"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${linePath} L${w},${h} L0,${h} Z" fill="url(#${gid})" stroke="none"/>
    <path d="${linePath}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

// 🎯 지금 매수 후보 위 "시장 지표" 대시보드 — 홈 전용(mktDashGrid 없는 페이지는 no-op)
const MKT_DASH_ITEMS = [
  { id: 'sp500',  name: 'S&P 500',        fmt: 'n', mk: 'us' },
  { id: 'dow',    name: '다우존스',         fmt: 'n', mk: 'us' },
  { id: 'kospi',  name: '코스피',           fmt: 'n', mk: 'kr' },
  { id: 'kosdaq', name: '코스닥',           fmt: 'n', mk: 'kr' },
  { id: 'vix',    name: 'VIX',             fmt: 'n', mk: 'us' },
  { id: 'usdkrw', name: '달러환율',         fmt: 'n', mk: 'fx' },
  { id: 'sox',    name: '필라델피아반도체',   fmt: 'n', mk: 'us' },
  { id: 'nq',     name: '나스닥100 선물',    fmt: 'n', mk: 'us' },
  { id: 'btc',    name: '비트코인',         fmt: '$', mk: 'crypto' },
  { id: 'gold',   name: '금',              fmt: '$', mk: 'commodity' },
  { id: 'oil',    name: 'WTI 원유',         fmt: '$', mk: 'commodity' },
];

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
  const heroDot = document.getElementById('mktDot-nasdaq');
  if (heroDot) heroDot.classList.toggle('on', mktIsOpen('us'));
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

  // 나스닥 히어로
  const nd = data.nasdaq;
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
      const color = nd.changePercent >= 0 ? '#3ddb7f' : '#ff6b6b';
      chartEl.innerHTML = areaSparkSvg(nd.spark, 300, 64, color);
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

  // 카드 DOM은 최초 1회만 생성, 이후엔 in-place 갱신
  if (!grid.dataset.cardsBuilt) {
    grid.dataset.cardsBuilt = '1';
    const cardsHtml = MKT_DASH_ITEMS.map(it => `
      <a class="mkt-card mkt-card-link" href="/market-detail.html?sym=${it.id}">
        <div class="mkt-card-main">
          <div class="mkt-card-name"><span class="mkt-live-dot" id="mktDot-${it.id}"></span>${it.name}</div>
          <div class="mkt-card-val" id="mktCardVal-${it.id}">—</div>
          <div class="mkt-card-chg" id="mktCardChg-${it.id}">—</div>
        </div>
        <div class="mkt-card-spark" id="mktCardSpark-${it.id}"></div>
      </a>`).join('') + `
      <a class="mkt-card mkt-link" href="https://finance.naver.com/sise/sise_index.naver?code=FUT" target="_blank" rel="noopener">
        <div class="mkt-card-main"><div class="mkt-card-name">코스피200 야간선물</div></div>
        <span class="mkt-link-cta">실시간 시세 보기 →</span>
      </a>`;
    grid.insertAdjacentHTML('beforeend', cardsHtml);
  }
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
      const color = d.changePercent >= 0 ? '#3ddb7f' : '#ff6b6b';
      sparkEl.innerHTML = areaSparkSvg(d.spark, 46, 28, color);
    }
  });
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
        const color = changePercent > 0 ? 'var(--green)' : changePercent < 0 ? 'var(--red)' : 'var(--text3)';
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
    const [{ data, error }, themeMap] = await Promise.all([
      sb.from('analysis_companies')
        .select(`
          upside_pct, confidence, rationale, entry_date,
          is_accurate_7d, actual_return_7d, is_accurate_1d, actual_return_1d,
          companies(ticker, name_ko, name_en, market),
          analyses!inner(issue_id, ai_summary,
            issues!inner(id, title, published_at)
          )
        `)
        .order('entry_date', { ascending: false })
        .limit(500),
      fetch('/api/admin?action=theme-map').then(r => r.ok ? r.json() : { map: {} }).then(j => j.map || {}).catch(() => ({})),
    ]);

    if (error || !data?.length) { sec.style.display = 'none'; return; }

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
      el.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text3);background:var(--bg2);border:1px dashed var(--border);border-radius:10px;font-size:13px">
        ${strictMode
          ? `🔒 AI 신뢰도 ≥80% 종목 없음 (전체 ${beforeStrict}개 중 0개 통과)<br><span style="font-size:11px">→ 더 많은 분석이 쌓이면 채워집니다</span>`
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

        const tradeBox = trade ? `
          <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;padding:10px;background:linear-gradient(135deg,rgba(63,185,80,.08),rgba(47,129,247,.08));border:1px solid rgba(63,185,80,.2);border-radius:8px">
            <div style="text-align:center;min-width:0">
              <div style="font-size:9px;color:var(--text3);margin-bottom:2px">매수가</div>
              <div style="font-size:11px;font-weight:700;color:var(--blue);font-family:'SF Mono',monospace;overflow-wrap:break-word">
                ${buyLow ? fmtP(buyLow) : (trade.elp != null ? fmtPct(trade.elp) : '—')}
                ${buyHigh ? `<br><span style="font-size:9px;color:var(--text3);font-weight:400">~ ${fmtP(buyHigh)}</span>` : ''}
              </div>
            </div>
            <div style="text-align:center;min-width:0;border-left:1px solid var(--border);border-right:1px solid var(--border)">
              <div style="font-size:9px;color:var(--text3);margin-bottom:2px">목표</div>
              <div style="font-size:11px;font-weight:700;color:var(--green);font-family:'SF Mono',monospace;overflow-wrap:break-word">
                ${target ? fmtP(target) : (trade.tp != null ? fmtPct(trade.tp) : '—')}
                ${target ? `<br><span style="font-size:9px;color:var(--text3);font-weight:400">+${trade.tp}%</span>` : ''}
              </div>
            </div>
            <div style="text-align:center;min-width:0">
              <div style="font-size:9px;color:var(--text3);margin-bottom:2px">손절</div>
              <div style="font-size:11px;font-weight:700;color:var(--red);font-family:'SF Mono',monospace;overflow-wrap:break-word">
                ${stop ? fmtP(stop) : (trade.sl != null ? fmtPct(trade.sl) : '—')}
                ${stop ? `<br><span style="font-size:9px;color:var(--text3);font-weight:400">${trade.sl}%</span>` : ''}
              </div>
            </div>
          </div>` : `
          <div style="padding:6px 10px;background:var(--bg3);border-radius:8px;font-size:10px;color:var(--text3);text-align:center">
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
                  <span style="font-family:var(--font-mono,'SF Mono',monospace);font-size:12px;font-weight:700;color:${isKr?'#4d8dff':'#9d7bff'};background:${isKr?'rgba(0,102,204,0.10)':'rgba(124,58,237,0.10)'};padding:2px 8px;border-radius:5px">${escHtml(s.ticker)}</span>
                  <span style="font-size:15px;font-weight:700">${escHtml(s.name)}</span>
                </div>
                <div style="display:flex;gap:8px;font-size:10px;align-items:center;flex-wrap:wrap">
                  <span style="color:${accColor};font-weight:600">${accLabel}</span>
                  <span style="color:var(--text3)">·</span>
                  <span style="color:var(--text3)">신뢰 ${s.avgConf}%</span>
                  ${trade?.tf ? `<span style="color:var(--text3)">·</span><span style="color:var(--blue);font-weight:600">${tfLabel[trade.tf] || trade.tf}</span>` : ''}
                  ${s.themeLabel ? `<span title="현재 시장 뉴스에서 자동 추출된 전략적 투자 노출 (+${s.themeScore}점)" style="padding:1px 7px;border-radius:999px;font-weight:700;background:linear-gradient(135deg,rgba(163,113,247,.18),rgba(47,129,247,.18));color:#a371f7">🚀 ${escHtml(s.themeLabel)}</span>` : ''}
                </div>
              </div>
              <span style="font-size:10px;font-weight:800;padding:5px 10px;border-radius:6px;color:${signal.color};background:${signal.bg};white-space:nowrap">${signal.label}</span>
            </div>

            <!-- 실시간 시세 -->
            <div class="ins-quote" data-quote-ticker="${escHtml(s.ticker)}" style="display:flex;flex-direction:column;gap:4px;padding:8px 12px;background:var(--bg3);border-radius:10px;font-family:var(--font-mono,'SF Mono',monospace)">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                <span style="font-size:10px;color:var(--text3);font-family:inherit;display:inline-flex;align-items:center;flex-shrink:0"><span class="live-pulse-dot"></span><span class="live-state-label">LIVE</span></span>
                <span class="ins-q-price" style="font-size:15px;font-weight:700;color:var(--text2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:right">—</span>
                <span class="ins-q-chg" style="font-size:13px;font-weight:700;color:var(--text3);min-width:64px;text-align:right;flex-shrink:0">—</span>
              </div>
              <div class="ins-q-ah" style="display:none;align-items:center;justify-content:space-between;gap:8px;padding-top:4px;border-top:1px dashed var(--border)">
                <span class="ins-q-ah-label" style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:var(--purple-dim);color:var(--purple);font-family:inherit"></span>
                <span class="ins-q-ah-price" style="font-size:13px;font-weight:600;color:var(--text2)"></span>
                <span class="ins-q-ah-chg" style="font-size:12px;font-weight:700;min-width:64px;text-align:right"></span>
              </div>
            </div>

            <!-- 기술 시그널 chips (technicals 로드되면 채워짐) -->
            <div class="ins-tech" data-tech-ticker="${escHtml(s.ticker)}" style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;min-height:20px;font-size:10px">
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
              const c = v => v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--text3)';
              const fchip = 'padding:2px 7px;border-radius:4px;font-weight:600;background:var(--bg3)';
              return `<div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;font-size:10px" title="최근 5거래일 누적 순매수 · 점수 반영 ${(s.flowAdj || 0) >= 0 ? '+' : ''}${s.flowAdj || 0}점">
                <span style="color:var(--text3);font-weight:700">수급</span>
                <span style="${fchip};color:${c(f.foreign5d)}">외인 ${fmtSh(f.foreign5d)}</span>
                <span style="${fchip};color:${c(f.inst5d)}">기관 ${fmtSh(f.inst5d)}</span>
                ${f.foreignStreak >= 3 ? `<span style="${fchip};color:var(--green)">🔥 외인 ${f.foreignStreak}일 연속 매수</span>`
                  : f.foreignStreak <= -3 ? `<span style="${fchip};color:var(--red)">⚠️ 외인 ${-f.foreignStreak}일 연속 매도</span>` : ''}
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
              if (fund.rev_yoy != null) chips.push(`<span style="${fchip};color:${fund.rev_yoy > 10 ? 'var(--green)' : fund.rev_yoy > 0 ? 'var(--text2)' : 'var(--red)'}">매출 YoY ${fund.rev_yoy > 0 ? '+' : ''}${fund.rev_yoy.toFixed(0)}%</span>`);
              return `<div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;font-size:10px">${chips.join('')}</div>`;
            })() : ''}

            <!-- 매매 가격대 (현재가 ± %) -->
            ${tradeBox}

            <!-- 핵심 thesis & risk -->
            ${trade?.th || trade?.rk ? `
              <div style="display:flex;flex-direction:column;gap:5px;font-size:11px;line-height:1.45">
                ${trade.th ? `<div><span style="color:var(--green);font-weight:700">💡</span> <span style="color:var(--text2)">${escHtml(trade.th)}</span></div>` : ''}
                ${trade.rk ? `<div><span style="color:var(--yellow);font-weight:700">⚠️</span> <span style="color:var(--text3)">${escHtml(trade.rk)}</span></div>` : ''}
              </div>
            ` : (parsed.reason ? `<div style="font-size:11px;color:var(--text2);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${escHtml(parsed.reason.slice(0, 140))}</div>` : '')}

            <!-- 하단: 분석 빈도 + 스코어 바 -->
            <div style="display:flex;align-items:center;gap:8px;margin-top:auto;font-size:10px;color:var(--text3)">
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
        ? `<div style="text-align:center;margin-top:14px"><a href="/picks.html" style="display:inline-block;padding:10px 20px;border-radius:10px;background:var(--bg2);border:1px solid var(--border);color:var(--blue);font-weight:700;font-size:13px;text-decoration:none">전체 매수 후보 ${filteredPool.length}개 보기 →</a></div>`
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
    strong_bullish: { label: '🟢 강세 추세',  color: 'var(--green)',  bg: 'rgba(63,185,80,.15)' },
    bullish:        { label: '🟢 상승',      color: 'var(--green)',  bg: 'rgba(63,185,80,.1)'  },
    oversold_bull:  { label: '🟢 과매도(매수기회)', color: '#56d364',  bg: 'rgba(63,185,80,.2)' },
    neutral:        { label: '⚪ 중립',      color: 'var(--text2)',  bg: 'var(--bg3)' },
    overbought:     { label: '🟡 과매수',    color: 'var(--yellow)', bg: 'rgba(210,153,34,.15)' },
    oversold:       { label: '🟠 과매도',    color: 'var(--yellow)', bg: 'rgba(210,153,34,.15)' },
    bearish:        { label: '🔴 하락',      color: 'var(--red)',    bg: 'rgba(248,81,73,.1)' },
    strong_bearish: { label: '🔴 약세 추세', color: 'var(--red)',    bg: 'rgba(248,81,73,.15)' },
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
      const c = info.vsSma200 > 0 ? 'var(--green)' : 'var(--red)';
      const sign = info.vsSma200 > 0 ? '+' : '';
      chips.push(`<span style="${chipStyle};background:var(--bg3);color:${c}">200일 ${sign}${info.vsSma200}%</span>`);
    } else if (info.vsSma50 != null) {
      const c = info.vsSma50 > 0 ? 'var(--green)' : 'var(--red)';
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
      const chgColor = cp == null ? 'var(--text3)' : cp > 0 ? 'var(--green)' : cp < 0 ? 'var(--red)' : 'var(--text2)';

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
            ahChgEl.style.color = ahPct > 0 ? 'var(--green)' : ahPct < 0 ? 'var(--red)' : 'var(--text2)';
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
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;text-align:center;padding:8px 0">데이터 없음</div>';
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
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;text-align:center;padding:8px 0">집계 데이터 부족</div>';
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
      <span style="font-size:11px;color:var(--text3);width:14px;text-align:right">${i+1}</span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:5px">
          <span style="font-family:'SF Mono',monospace;font-size:12px;font-weight:700;color:var(--text1)">${escHtml(s.ticker)}</span>
          <span style="font-size:10px">${mktFlag}</span>
        </div>
        <div style="font-size:10.5px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(s.name)}</div>
        <div style="display:flex;align-items:center;gap:5px;margin-top:3px">
          <div style="flex:1;max-width:80px;height:3px;background:var(--bg3);border-radius:2px;overflow:hidden">
            <div style="height:100%;width:${confPct}%;background:${rateColor};border-radius:2px"></div>
          </div>
          <span style="font-size:9.5px;color:var(--text3)">신뢰도</span>
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:13px;font-weight:700;color:${rateColor}">${s.rate}%</div>
        <div style="font-size:10px;color:var(--text3)">적중 ${s.hits}/${s.total}건</div>
        ${s.avgActual != null ? `<div style="font-size:10px;color:${s.avgActual >= 0 ? 'var(--green)' : 'var(--red)'}">${periodLabel} ${upSign}${s.avgActual}%</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

// 실적발표 캘린더 (강화: 위스퍼·IV·매출 포함)
async function loadEarningsCalendar() {
  const el = document.getElementById('earningsCalendar');
  if (!el) return;

  let apiItems = [];
  try {
    const r = await fetch('/api/earnings');
    if (r.ok) { const j = await r.json(); if (j.ok && j.items?.length) apiItems = j.items; }
  } catch {}

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

  if (!apiItems.length) {
    el.innerHTML = `<div style="color:var(--text3);font-size:12px;text-align:center;padding:16px 0">이번 주 실적발표 없음</div>`;
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

    const timingClass = item.callTime === 'BMO' ? 'bmo' : item.callTime === 'AMC' ? 'amc' : '';
    const timingLabel = item.callTime === 'BMO' ? '장전' : item.callTime === 'AMC' ? '장후' : '';

    // 날짜 (D-day 포함, Nasdaq 알고리즘 추정일이면 "예상" 표기)
    const dday = item.date ? Math.round((new Date(item.date) - new Date(today)) / 86400000) : null;
    const estTag = item.dateEstimated ? '<span style="color:var(--text3);font-size:10px"> · 예상일</span>' : '';
    const dateLabel = !item.date
      ? `<span style="color:var(--text3);font-size:11px">다음 분기 발표 예정</span>`
      : isToday
        ? `<span class="ei-today">🔴 오늘 실적발표</span>`
        : isFuture
          ? `<span style="color:var(--blue)">📅 ${item.date} <b>D-${dday}</b></span>${estTag}`
          : `<span style="color:var(--text2)">📊 ${item.date} 발표</span>`;

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
      ? `<div class="ei-growth" style="${item.epsGrowth >= 0 ? 'color:var(--green)' : 'color:var(--red)'};font-size:10px">`
        + `${item.epsGrowth >= 0 ? '▲' : '▼'} YoY ${Math.abs(item.epsGrowth * 100).toFixed(1)}%</div>`
      : '';

    // 현재가 + 변동률 (chartMeta가 응답에 포함되지 않으니 priceTarget 만 표시)
    const ptStr = item.priceTarget
      ? `<span style="font-size:11px;color:var(--text3)">목표 ${fmtNum(item.priceTarget)}</span>`
      : '';
    const recStr = item.recKey
      ? `<span style="font-size:11px;font-weight:700;${recColor(item.recKey)}">${recLabel(item.recKey)}</span>`
      : '';
    const cpStr = item.currentPrice
      ? `<span style="font-size:11px;color:var(--text2);font-family:'SF Mono',monospace">${fmtNum(item.currentPrice)}</span>`
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
    ? `<div onclick="openCalendarModal('earnings')" style="text-align:center;padding:8px 0 2px;font-size:11.5px;font-weight:700;color:var(--blue);cursor:pointer">+${hiddenCount}건 더 보기 → 캘린더 전체보기</div>`
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
    el.innerHTML = `<div style="color:var(--text3);font-size:12px;text-align:center;padding:16px 0">데이터 없음</div>`;
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
      <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:11px;margin-top:4px">
        ${item.valuation ? `<span style="color:${item.valuation==='Overvalued'?'var(--red)':item.valuation==='Undervalued'?'var(--green)':'var(--text2)'}">${item.valuation==='Overvalued'?'고평가':item.valuation==='Undervalued'?'저평가':item.valuation}</span>` : ''}
        ${item.techDir ? `<span style="color:${item.techDir==='Bullish'?'var(--green)':item.techDir==='Bearish'?'var(--red)':'var(--text2)'}">기술적 ${item.techDir==='Bullish'?'상승':item.techDir==='Bearish'?'하락':item.techDir}</span>` : ''}
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
      el.innerHTML = `<div style="color:var(--text3);font-size:12px;text-align:center;padding:16px 0">속보 없음</div>`;
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
    el.innerHTML = `<div style="color:var(--text3);font-size:12px">로드 실패</div>`;
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
      el.innerHTML = `<div style="color:var(--text3);font-size:12px;text-align:center;padding:16px 0">이번 주 발표 없음</div>`;
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
                ? `<a href="https://www.forexfactory.com/calendar" target="_blank" rel="noopener" style="color:var(--blue);font-size:11px;text-decoration:none">📊 발표됨 — 결과 확인 ↗</a>
                   ${item.forecast ? `<span class="eco-prev">예상 ${escHtml(item.forecast)}</span>` : ''}`
                : `${item.forecast ? `<span class="eco-actual pending">예상 ${escHtml(item.forecast)}</span>` : ''}
                   ${item.previous ? `<span class="eco-prev">이전 ${escHtml(item.previous)}</span>` : ''}`
            }
          </div>
        </div>`;
        total++;
      }
    }

    el.innerHTML = html || `<div style="color:var(--text3);font-size:12px;text-align:center;padding:16px 0">이번 주 발표 없음</div>`;
  } catch {
    el.innerHTML = `<div style="color:var(--text3);font-size:12px;text-align:center;padding:16px 0">데이터 없음</div>`;
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
  initAuth();
  loadStats();
  loadIssues();
  reloadInsightsForPage();
  loadIndices();
  loadBondStrip();
  loadEconomicCalendar();
  loadEarningsCalendar();
  loadAnalystRatings();
  // 1초 폴링이지만 /api/indices는 전 사용자 공통 고정 심볼셋(사용자별로 다른 티커를
  // 요청하는 /api/quotes와 달리)이라 엣지 캐시가 트래픽과 무관하게 오리진 호출을
  // s-maxage(3초)로 묶어준다 — 접속자가 늘어도 야후 호출 빈도는 그대로.
  setInterval(loadIndices, 1000);
  // 15초마다 시세 갱신 (마켓 상태는 카드에 표시) — 사용자마다 화면에 보이는 종목
  // 조합이 달라 edge cache 히트율이 낮음. 1초 간격은 실사용자 트래픽 증가 시
  // Yahoo Finance 레이트리밋을 유발한 원인 중 하나였음(히트맵 폴링과 동일 이슈).
  setInterval(refreshInsightQuotes, 15000);
  setInterval(loadEconomicCalendar, 30000);   // 30초마다 (발표 결과 빠른 반영)
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
        const r = await fetch('/api/earnings');
        const j = await r.json();
        _calCache.earnings = j.ok ? j.items : [];
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
          ? '<span style="color:var(--text3);font-size:11px">집계 대기</span>'
          : '<span class="cal-pend">예정</span>';
      const impHtml = item.impact === 'High'
        ? '<span class="cal-hi">●고</span>'
        : '<span class="cal-med">●중</span>';

      html += `<tr>
        <td style="font-family:'SF Mono',monospace;color:var(--text3)">${fmtTime(item.date)}</td>
        <td style="font-weight:600">${escHtml(item.titleKo || item.title)}</td>
        <td style="font-size:12px">${flag[item.country] || item.country}</td>
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
      <div style="font-weight:800;font-size:15px">${year}년 ${month + 1}월 <span style="font-size:11px;font-weight:600;color:var(--text3)">· 실적발표 ${monthTotal}건</span></div>
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
    ${tbd.length ? `<div style="margin-top:14px;font-size:11px;color:var(--text3)">📌 날짜 미확정 ${tbd.length}건: ${tbd.map(it => escHtml(it.ticker || '')).join(', ')}</div>` : ''}
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

  el.innerHTML = `<div style="font-weight:800;font-size:13px;margin-bottom:8px">${fmtDay(dateStr)} 실적발표 (${items.length}건)</div>
    <table class="cal-tbl">
      <thead><tr>
        <th style="width:65px">종목</th><th>기업명</th><th style="width:38px">발표</th>
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
        const timing = item.callTime === 'BMO' ? '<span style="color:#60a5fa;font-size:10px">장전</span>'
                     : item.callTime === 'AMC' ? '<span style="color:#a78bfa;font-size:10px">장후</span>'
                     : '<span style="color:var(--text3);font-size:10px">—</span>';
        return `<tr>
          <td style="font-weight:700;color:var(--yellow)">${escHtml(item.ticker || '')}</td>
          <td style="font-size:11px;color:var(--text2)">${escHtml(item.company || '')}</td>
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

function hmCellHtml(it) {
  const sign = it.pct >= 0 ? '+' : '';
  const priceLabel = it.price == null ? '' : (it.currency === 'KRW'
    ? '₩' + Math.round(it.price).toLocaleString('ko-KR')
    : '$' + Number(it.price).toFixed(2));
  const c = heatmapColorFor(it.pct);
  const badge = HM_SESSION_BADGE[it.session];
  const badgeHtml = badge
    ? `<div class="hm-session" style="font-size:9px;font-weight:800;opacity:.95;margin-top:1px;color:${badge.color}">${badge.label}</div>`
    : '';
  return `<a class="hm-cell" data-ticker="${escAttr(it.ticker)}" href="${hmCellHref(it.ticker)}" ${hmCellOnClick(it.ticker)} style="display:flex;flex-direction:column;justify-content:center;text-decoration:none;color:${c.fg};background:${c.bg};border-radius:12px;padding:10px 8px;text-align:center;transition:transform .12s var(--ease),background .3s,color .3s;min-height:74px;line-height:1.2;box-shadow:0 1px 2px rgba(0,0,0,0.05);cursor:pointer" onmouseover="this.style.transform='translateY(-2px) scale(1.03)'" onmouseout="this.style.transform='translateY(0) scale(1)'" title="${escAttr(it.name)}">
    <div style="font-size:11px;font-weight:700;letter-spacing:.2px;opacity:.95;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escAttr(it.name)}</div>
    <div class="hm-price t-num" style="font-size:10px;font-weight:500;opacity:.85;margin-top:1px">${priceLabel}</div>
    <div class="hm-pct t-num" style="font-size:13px;font-weight:800;margin-top:3px">${sign}${it.pct.toFixed(2)}%</div>
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
      ? `<button onclick="${opts.backAction}" style="grid-column:1/-1;padding:10px;margin-bottom:2px;border:1px solid var(--border);border-radius:10px;background:var(--bg2);color:var(--text2);font-size:13px;font-weight:700;cursor:pointer;text-align:left">← ${opts.backLabel}</button>`
      : '';
    const cellsHtml = displayItems.map(hmCellHtml).join('') || '<div style="grid-column:1/-1;text-align:center;color:var(--text3);font-size:12px;padding:20px">데이터 없음</div>';
    const moreBtn = (opts.mobileLimit && !showAll && items.length > HM_MOBILE_LIMIT)
      ? `<button onclick="expandHeatmapMobile()" style="grid-column:1/-1;padding:12px;margin-top:4px;border:1px dashed var(--border);border-radius:10px;background:var(--bg2);color:var(--blue);font-size:13px;font-weight:700;cursor:pointer">▾ ${items.length - HM_MOBILE_LIMIT}개 더보기 (전체 ${items.length}개)</button>`
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
          sessionEl.style.cssText = 'font-size:9px;font-weight:800;opacity:.95;margin-top:1px';
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
      <div style="font-size:13px;font-weight:800;letter-spacing:.2px">${SECTOR_META[s].label}</div>
      <div class="t-num" style="font-size:19px;font-weight:800;margin-top:6px">${sign}${avgPct.toFixed(2)}%</div>
      <div style="font-size:10px;opacity:.8;margin-top:4px">${arr.length}개 종목 · 상승 ${up}</div>
    </button>`;
  }).join('');
  grid.innerHTML = boxes || '<div style="grid-column:1/-1;text-align:center;color:var(--text3);font-size:12px;padding:20px">데이터 없음</div>';
  _hmStructureKey = structureKey;
}

// ─── 🇰🇷 국장 요약 (지수 카드 + 인기 검색 종목 + 투자자별 수급 차트) ──
// 수급 차트는 직접 계산하지 않고 네이버 증권이 서버에서 미리 렌더링해 제공하는
// PNG를 그대로 embed(핫링크)한다 — sid= 캐시버스터로 매 새로고침마다 최신 이미지를 받음.
// 해외지수는 국장현황이 아니라 미장현황 쪽에 배치(아래 US 섹션 참고).
const KR_INDEX_DEFS = [
  { t: '^KS11',  label: '코스피' },
  { t: '^KQ11',  label: '코스닥' },
  { t: '^KS200', label: '코스피200' },
];
const KR_FLOW_CHART_IMG = { KOSPI: 'siseMainKOSPI', KOSDAQ: 'siseMainKOSDAQ', KPI200: 'siseMainKPI200' };
let _krFlowMkt = 'KOSPI';

// 억원 단위 축약 포맷 (+/- 부호 포함)
function fmtEok(v) {
  if (v == null) return '—';
  const sign = v >= 0 ? '+' : '−';
  const eok = Math.abs(v) / 1e8;
  return `${sign}${eok >= 10000 ? (eok / 10000).toFixed(1) + '조' : Math.round(eok).toLocaleString() + '억'}`;
}

function switchKrFlowChart(mkt) {
  _krFlowMkt = mkt;
  document.querySelectorAll('.kf-tab').forEach(b => b.classList.toggle('active', b.dataset.kf === mkt));
  const img = document.getElementById('krFlowChartImg');
  const dataWrap = document.getElementById('krFlowDataWrap');
  const srcNote = document.getElementById('krFlowSrcNote');

  // 코스피200은 토스 투자자별 매매대금 API가 지원하지 않아(KOSPI/KOSDAQ만) 기존 네이버 이미지 유지
  if (mkt === 'KPI200') {
    if (img) { img.style.display = 'block'; img.src = `https://ssl.pstatic.net/imgfinance/chart/sise/${KR_FLOW_CHART_IMG[mkt]}.png?sid=${Date.now()}`; }
    if (dataWrap) dataWrap.style.display = 'none';
    if (srcNote) srcNote.textContent = '📡 데이터: 네이버 증권 · 개인·외국인·기관 누적 순매수 + 지수 추이(당일)';
    return;
  }

  if (img) img.style.display = 'none';
  if (dataWrap) {
    dataWrap.style.display = 'block';
    dataWrap.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;padding:16px">로딩 중...</div>';
  }
  if (srcNote) srcNote.textContent = '📡 데이터: 토스증권 공식 API · 개인·외국인·기관 일별 순매수 (매수대금 − 매도대금)';

  fetch(`/api/toss?action=investor-trading&symbol=${mkt}&count=6`)
    .then(r => r.json())
    .then(j => {
      if (_krFlowMkt !== mkt || !dataWrap) return; // 탭이 그 사이 바뀌었으면 버림
      if (!j.ok || !j.records?.length) { dataWrap.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;padding:16px">데이터 없음</div>'; return; }
      const rows = j.records.map(r => {
        const cell = (label, v) => `<div style="text-align:center"><div style="font-size:9.5px;color:var(--text3);margin-bottom:2px">${label}</div><div style="font-size:11.5px;font-weight:700;font-family:var(--font-mono);color:${v >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtEok(v)}</div></div>`;
        return `<div style="display:grid;grid-template-columns:52px repeat(3,1fr);gap:6px;align-items:center;padding:7px 4px;border-bottom:1px solid var(--border-soft)">
          <div style="font-size:10.5px;color:var(--text3)">${r.date.slice(5).replace('-', '/')}</div>
          ${cell('개인', r.individual)}${cell('외국인', r.foreigner)}${cell('기관', r.institution)}
        </div>`;
      }).join('');
      dataWrap.innerHTML = `<div style="display:grid;grid-template-columns:52px repeat(3,1fr);gap:6px;padding:0 4px 6px;font-size:9.5px;color:var(--text3);font-weight:700;text-transform:uppercase;border-bottom:1px solid var(--border)"><div></div><div style="text-align:center">개인</div><div style="text-align:center">외국인</div><div style="text-align:center">기관</div></div>${rows}`;
    })
    .catch(() => { if (dataWrap) dataWrap.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;padding:16px">로드 실패</div>'; });
}

async function loadKrSummary() {
  const cardsEl = document.getElementById('krIndexCards');
  if (!cardsEl) return;
  try {
    const tickers = KR_INDEX_DEFS.map(x => x.t);
    const [quoteRes, searchRes] = await Promise.all([
      fetch(`/api/quotes?tickers=${tickers.map(encodeURIComponent).join(',')}`).then(r => r.json()),
      fetch('/api/kr-market?type=popular-search').then(r => r.json()),
    ]);
    const q = quoteRes?.data || {};

    cardsEl.innerHTML = KR_INDEX_DEFS.map(def => {
      const d = q[def.t];
      return d ? krIndexCard(def.label, d) : '';
    }).join('');

    renderKrPopularSearch(searchRes?.items || []);
    switchKrFlowChart(_krFlowMkt);

    const upd = document.getElementById('krSummaryUpdatedAt');
    if (upd) upd.textContent = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) + ' 기준';
  } catch (e) {
    cardsEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--red);font-size:12px;padding:16px">불러오기 실패: ${escHtml(e.message)}</div>`;
  }
}

// ─── 🇺🇸 미장 요약 (지수 카드 + 비美 해외지수) ──────────────────────────
const US_INDEX_DEFS = [
  { t: '^GSPC', label: 'S&P 500' },
  { t: '^IXIC', label: '나스닥' },
  { t: '^DJI',  label: '다우' },
];
const GLOBAL_INDEX_DEFS = [
  { t: '^KS11',     label: '코스피' },
  { t: '^KQ11',     label: '코스닥' },
  { t: '^N225',     label: '니케이225' },
  { t: '^HSI',      label: '홍콩 항셍' },
  { t: '000001.SS', label: '상해종합' },
];

async function loadUsSummary() {
  const cardsEl = document.getElementById('usIndexCards');
  if (!cardsEl) return;
  try {
    const tickers = [...US_INDEX_DEFS, ...GLOBAL_INDEX_DEFS].map(x => x.t);
    const r = await fetch(`/api/quotes?tickers=${tickers.map(encodeURIComponent).join(',')}`);
    const j = await r.json();
    const q = j?.data || {};

    cardsEl.innerHTML = US_INDEX_DEFS.map(def => {
      const d = q[def.t];
      return d ? krIndexCard(def.label, d) : '';
    }).join('');

    const glEl = document.getElementById('usGlobalIndices');
    if (glEl) {
      glEl.innerHTML = GLOBAL_INDEX_DEFS.map(def => {
        const d = q[def.t];
        if (!d) return '';
        return `<div style="display:flex;align-items:center;gap:10px;padding:7px 4px">
          <span style="flex:1;min-width:0;font-size:12.5px;font-weight:600">${def.label}</span>
          <span class="t-num" style="font-size:12px;font-weight:600;text-align:right;white-space:nowrap">${krFmtNum(d.price)}</span>
          ${krChgChip(d.changePercent)}
        </div>`;
      }).join('');
    }

    const upd = document.getElementById('usSummaryUpdatedAt');
    if (upd) upd.textContent = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) + ' 기준';
  } catch (e) {
    cardsEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--red);font-size:12px;padding:16px">불러오기 실패: ${escHtml(e.message)}</div>`;
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
    panel.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;padding:20px">로딩 중...</div>';
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
    panel.innerHTML = `<div style="text-align:center;color:var(--text3);font-size:12px;padding:20px">불러오기 실패: ${escHtml(e.message)}</div>`;
  }
}

function usNameCell(item) {
  const isWL = typeof isWatched === 'function' && isWatched(item.ticker);
  return `<a href="/company.html?ticker=${encodeURIComponent(item.ticker)}" style="color:var(--text);font-weight:600;text-decoration:none">${escHtml(item.name)}</a>
    <span style="color:var(--text3);font-size:10.5px;font-family:monospace;margin-left:4px">${escHtml(item.ticker)}</span>`;
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
    sub: '코스피·코스닥 거래량 TOP · 상한가 · 하한가 · 수급 TOP · 거래량 급증 랭킹',
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
    if (titleEl) titleEl.textContent = meta.title;
    if (subEl) subEl.textContent = meta.sub;
    document.title = `${meta.title} — StockRipple`;
  }
  if (sec === 'us' && !_usmCache[_usmTab]) { loadUsSummary(); loadUsMarket(); }
}

function renderKrPopularSearch(items) {
  const el = document.getElementById('krPopularSearch');
  if (!el) return;
  if (!items?.length) { el.innerHTML = '<div style="color:var(--text3);font-size:12px;text-align:center;padding:12px">데이터 없음</div>'; return; }
  el.innerHTML = `<div style="display:flex;flex-direction:column;gap:2px">` + items.map((it, i) => `
    <a href="/company.html?ticker=${encodeURIComponent(it.ticker)}" style="display:flex;align-items:center;gap:10px;padding:7px 4px;text-decoration:none;color:inherit;border-radius:6px" onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background=''">
      ${krRankCell(i)}
      <span style="flex:1;min-width:0;font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(it.name)}</span>
      <span class="t-num" style="font-size:12px;font-weight:600;text-align:right;white-space:nowrap">${krFmtNum(it.price)}</span>
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
    panel.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;padding:20px">로딩 중...</div>';
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
    panel.innerHTML = `<div style="text-align:center;color:var(--text3);font-size:12px;padding:20px">불러오기 실패: ${escHtml(e.message)}</div>`;
  }
}

function krRowsTable(rows, cols) {
  if (!rows?.length) return '<div style="text-align:center;color:var(--text3);font-size:12px;padding:20px">데이터가 없습니다</div>';
  return `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
    <thead><tr style="border-bottom:2px solid var(--border)">${cols.map(c => `<th style="text-align:${c.right ? 'right' : 'left'};padding:8px;color:var(--text3);font-weight:700;font-size:10px;letter-spacing:.3px;white-space:nowrap;text-transform:uppercase">${c.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((row, i) => {
      const base = i % 2 ? 'var(--bg3)' : 'transparent';
      return `<tr style="border-bottom:1px solid var(--border-soft,var(--border));background:${base};transition:background .1s" onmouseover="this.style.background='var(--blue-dim)'" onmouseout="this.style.background='${base}'">${cols.map(c => `<td style="padding:8px;text-align:${c.right ? 'right' : 'left'};white-space:nowrap">${c.render(row, i)}</td>`).join('')}</tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function krRankCell(i) {
  return i < 3
    ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:var(--blue-dim);color:var(--blue);font-weight:800;font-size:11px">${i + 1}</span>`
    : `<span style="color:var(--text3);font-weight:600">${i + 1}</span>`;
}

function krNameCell(item) {
  const isWL = typeof isWatched === 'function' && isWatched(item.ticker);
  return `<a href="/company.html?ticker=${encodeURIComponent(item.ticker)}" style="color:var(--text);font-weight:700;text-decoration:none">${escHtml(item.name)}</a>
    <span style="color:var(--text3);font-size:10.5px;font-family:monospace;margin-left:4px">${escHtml(item.ticker)}</span>`;
}
const krChgColor = v => v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--text2)';
const krFmtPct = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
const krFmtNum = v => v == null ? '—' : Math.round(v).toLocaleString('ko-KR');
const krFmtEok = v => v == null ? '—' : `${v >= 0 ? '+' : ''}${(v / 1e8).toFixed(1)}억`;
const krMktPill = label => `<span style="font-size:9.5px;font-weight:700;padding:2px 7px;border-radius:6px;background:var(--blue-dim);color:var(--blue);white-space:nowrap">${label}</span>`;
function krChgChip(pct) {
  if (pct == null) return '—';
  const bg = pct > 0 ? 'var(--green-dim)' : pct < 0 ? 'var(--red-dim)' : 'var(--bg4)';
  const fg = pct > 0 ? 'var(--green)' : pct < 0 ? 'var(--red)' : 'var(--text2)';
  return `<span style="display:inline-block;font-size:11.5px;font-weight:800;padding:3px 9px;border-radius:6px;background:${bg};color:${fg}">${krFmtPct(pct)}</span>`;
}

// 지수 카드(코스피/코스닥/코스피200, S&P500/나스닥/다우 공용) — dim 배경만으로는
// 카드 전체 면적에서 너무 흐릿해서(8% 알파) 경계가 안 보였음(직접 스크린샷으로 확인).
// 톤 배경 + 진한 색 좌측 보더 + 원형 화살표 배지로 카드 윤곽과 방향성을 동시에 확보.
function krIndexCard(label, d) {
  const up = d.changePercent > 0, dn = d.changePercent < 0;
  const bg = up ? 'var(--green-dim)' : dn ? 'var(--red-dim)' : 'var(--bg3)';
  const fg = up ? 'var(--green)' : dn ? 'var(--red)' : 'var(--text2)';
  const arrow = up ? '▲' : dn ? '▼' : '·';
  const sign = d.change >= 0 ? '+' : '';
  return `<div style="background:${bg};border-left:4px solid ${fg};border-radius:10px;padding:16px 18px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <span style="font-size:12px;color:var(--text2);font-weight:700">${label}</span>
      <span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:${fg};color:#fff;font-size:11px">${arrow}</span>
    </div>
    <div class="t-num" style="font-size:24px;font-weight:800;color:var(--text)">${krFmtNum(d.price)}</div>
    <div class="t-num" style="font-size:12.5px;font-weight:800;color:${fg};margin-top:4px">${sign}${d.change.toFixed(2)} (${krFmtPct(d.changePercent)})</div>
  </div>`;
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
      { label: '거래량 급증률', right: true, render: r => `<span style="display:inline-block;font-size:11.5px;font-weight:800;padding:3px 9px;border-radius:6px;background:var(--yellow-dim);color:var(--yellow)">${r.surgeRatio != null ? r.surgeRatio.toLocaleString('ko-KR') + '%' : '—'}</span>` },
    ]);
  } else if (tab === 'flow') {
    const half = c => `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div><div style="font-size:11.5px;font-weight:700;color:var(--green);margin-bottom:4px">🔼 순매수 유입 TOP</div>${krRowsTable(d.inflow, c)}</div>
      <div><div style="font-size:11.5px;font-weight:700;color:var(--red);margin-bottom:4px">🔽 순매도 유출 TOP</div>${krRowsTable(d.outflow, c)}</div>
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
    return { bg: `rgba(45,195,115,${a.toFixed(2)})`, fg: v > 0.35 ? '#fff' : '#c7ecd6' };
  } else {
    const a = 0.18 + (-v) * 0.78;
    return { bg: `rgba(240,85,105,${a.toFixed(2)})`, fg: -v > 0.35 ? '#fff' : '#ffd4da' };
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
const REPORT_LABEL = 'font-size:11px;font-weight:700;margin-bottom:4px';   // 섹션 소제목
const REPORT_HEADLINE = 'font-size:14px;font-weight:700;line-height:1.45;margin-bottom:10px';
const REPORT_LIST = 'margin:0;padding-left:16px;font-size:12px;color:var(--text2);line-height:1.6';
const REPORT_META = 'font-size:11px;color:var(--text3)';

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
  const color = s.dir === 'pos' ? 'var(--green)' : s.dir === 'neg' ? 'var(--red)' : 'var(--yellow)';
  const icon  = s.dir === 'pos' ? '▲' : s.dir === 'neg' ? '▼' : '◆';
  return `<span style="display:inline-flex;align-items:center;gap:4px;background:${color};color:#fff;font-size:11px;font-weight:800;padding:4px 11px;border-radius:999px;white-space:nowrap">${icon} ${escHtml(s.label)}</span>`;
}
function reportList(items) {
  return Array.isArray(items) && items.length
    ? `<ul style="${REPORT_LIST}">${items.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>`
    : '<div style="font-size:11px;color:var(--text3)">—</div>';
}

// ─── 🤖 AI 시장 종합 ─────────────────────────────────────
function aiSummaryHTML(d) {
  const when = d.created_at
    ? new Date(d.created_at).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';
  return `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
      ${sentimentBadge(d.regime)}
      <span style="${REPORT_META}">${when ? when + ' · ' : ''}${d.based_on_issues || 0}건 분석</span>
    </div>
    <div style="${REPORT_HEADLINE}">${escHtml(d.headline || '')}</div>
    <div style="color:var(--green);${REPORT_LABEL}">▲ 강세 요인</div>
    ${reportList(d.bullish_drivers)}
    <div style="color:var(--red);${REPORT_LABEL};margin-top:8px">▼ 약세 요인</div>
    ${reportList(d.bearish_drivers)}
    <div style="color:var(--blue);${REPORT_LABEL};margin-top:8px">🏆 수혜 섹터</div>
    <div style="display:flex;flex-wrap:wrap;gap:4px">${(d.sectors_winning||[]).map(s => `<span style="font-size:11px;padding:2px 8px;border-radius:999px;background:var(--green-dim);color:var(--green)">${escHtml(s)}</span>`).join('')}</div>
    <div style="color:var(--text3);${REPORT_LABEL};margin-top:8px">📉 피해 섹터</div>
    <div style="display:flex;flex-wrap:wrap;gap:4px">${(d.sectors_losing||[]).map(s => `<span style="font-size:11px;padding:2px 8px;border-radius:999px;background:var(--red-dim);color:var(--red)">${escHtml(s)}</span>`).join('')}</div>
    <div style="color:var(--blue);${REPORT_LABEL};margin-top:8px">👁 내일 주시</div>
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
      body.innerHTML = `<div style="color:var(--text3);font-size:11px;text-align:center;padding:10px">아직 생성 전 — 다음 일일 cron 시 자동 생성됩니다</div>`;
      return;
    }
    const updatedAt = d.created_at ? new Date(d.created_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    document.getElementById('aiMSCreatedAt').textContent = updatedAt;
    body.innerHTML = aiSummaryHTML(d);
    // 데스크톱 사이드바에 실제로 렌더링돼 보이는 순간 "봤음" 처리 — 이게 없으면 모바일
    // 바텀시트(renderDrSheet)를 열 때만 markAiMsSeen이 호출돼서, 데스크톱에서는 계속
    // 보고 있어도 영원히 "안 읽음"으로 남아 새로고침/페이지 이동마다 토스트가 또 뜸.
    markAiMsSeen();
    refreshReportBadges();
  } catch { body.innerHTML = '<div style="color:var(--red);font-size:11px">로드 실패</div>'; }
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
      <div style="font-size:10px;color:var(--yellow);font-weight:700;margin-bottom:4px">⭐ 하이라이트</div>
      <ul style="margin:0 0 10px;padding-left:14px;font-size:11.5px;color:var(--text2);line-height:1.55">
        ${d.highlights.map(h => `<li>${escHtml(h)}</li>`).join('')}
      </ul>` : '';

    const dayHtml = d.days.map(day => {
      const items = (day.items || []).map(it => {
        const [color, bg] = WS_TYPE_STYLE[it.type] || ['var(--text3)', 'var(--bg3)'];
        const stars = it.stars ? '★'.repeat(it.stars) : '';
        return `<div style="display:flex;gap:6px;align-items:baseline;padding:2px 0;font-size:11px;line-height:1.45">
          <span style="color:var(--text3);font-family:monospace;flex-shrink:0;width:34px">${escHtml(it.time || '')}</span>
          <span style="flex-shrink:0;font-size:9px;font-weight:700;padding:1px 5px;border-radius:6px;color:${color};background:${bg}">${escHtml(it.type)}</span>
          <span style="color:var(--text2)">${escHtml(it.title)}${stars ? ` <span style="color:var(--yellow);font-size:9px">${stars}</span>` : ''}</span>
        </div>`;
      }).join('');
      return `<div style="margin-bottom:8px">
        <div style="font-size:11px;font-weight:700;color:var(--text);border-bottom:1px solid var(--border);padding-bottom:3px;margin-bottom:3px">${day.date.slice(5).replace('-', '/')} (${escHtml(day.weekday)})</div>
        ${items}
      </div>`;
    }).join('');

    body.innerHTML = hl + dayHtml + `<div style="font-size:9px;color:var(--text3);margin-top:6px">시간은 KST · 본 콘텐츠는 투자 권유가 아닌 정보 제공용입니다</div>`;
    card.style.display = '';
  } catch {}
}

// ─── 📰 데일리 리포트 (국장/미장) ─────────────────────────
let _drTab = 'US';
const _drCache = {};   // { US: data|null, KR: data|null }

function dailyReportHTML(d, compact) {
  const idxChips = Array.isArray(d.indices) && d.indices.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px">${d.indices.map(x => {
        const c = x.changePercent == null ? 'var(--text3)' : x.changePercent >= 0 ? 'var(--green)' : 'var(--red)';
        const sign = x.changePercent != null && x.changePercent >= 0 ? '+' : '';
        return `<span style="font-size:11px;padding:3px 8px;border-radius:6px;background:var(--bg3);border:1px solid var(--border)">
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
      <span style="${REPORT_META}">${drDateShort ? drDateShort + ' 장마감' : ''}${genAt ? ` · ${genAt} 생성` : ''} · ${d.based_on_issues || 0}건 분석</span>
    </div>
    <div style="${REPORT_HEADLINE}">${escHtml(d.headline || '')}</div>
    ${idxChips}
    ${Array.isArray(d.catalysts) && d.catalysts.length ? `
    <div style="color:var(--purple);${REPORT_LABEL}">📌 다가오는 핵심 이벤트</div>
    <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:9px">${d.catalysts.map(c => `<div class="dr-cat">${escHtml(c)}</div>`).join('')}</div>` : ''}
    <div style="color:var(--blue);${REPORT_LABEL}">📋 오늘 시장 흐름</div>
    ${reportList(d.recap)}
    <div style="color:var(--yellow);${REPORT_LABEL};margin-top:8px">⚡ 주요 이벤트</div>
    ${reportList(d.top_events)}
    ${!compact ? `
    <div style="color:var(--green);${REPORT_LABEL};margin-top:8px">🔍 섹터·종목 특징</div>
    ${reportList(d.sector_notes)}` : ''}
    <div style="color:var(--blue);${REPORT_LABEL};margin-top:8px">👁 다음 거래일 관전 포인트</div>
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
async function checkNewReports() {
  await Promise.all([getDrData('US'), getDrData('KR'), getAiMsData()]);
  const toToast = [];
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
    }
  }
  const aiD = _aiMsCache;
  if (aiD && aiD.created_at) {
    if (localStorage.getItem(_aiMsSeenKey) == null) {
      localStorage.setItem(_aiMsSeenKey, aiD.created_at);
    } else if (_aiMsIsUnseen() && !_drToasted.has('AI' + aiD.created_at)) {
      _drToasted.add('AI' + aiD.created_at);
      toToast.push('AI 시장 종합');
    }
  }
  refreshReportBadges();
  if (toToast.length) {
    try { showToast(`📰 새 ${toToast.join('·')} 업데이트가 올라왔어요`, 'info'); } catch {}
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
      : `<div style="color:var(--text3);font-size:11px;text-align:center;padding:10px">아직 리포트 없음 — ${mkt === 'KR' ? '국장' : '미장'} 마감 후 자동 생성됩니다</div>`;
    refreshReportBadges();
  } catch { body.innerHTML = '<div style="color:var(--red);font-size:11px">로드 실패</div>'; }
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
  body.innerHTML = '<div style="color:var(--text3);font-size:13px;text-align:center;padding:24px 0">로딩 중...</div>';

  if (mkt === 'AI') {
    const d = await getAiMsData();
    body.innerHTML = d
      ? aiSummaryHTML(d)
      : `<div style="color:var(--text3);font-size:13px;text-align:center;padding:24px 0">아직 생성 전 — 다음 일일 cron 시 자동 생성됩니다</div>`;
    markAiMsSeen();
    return;
  }

  const d = await getDrData(mkt);
  body.innerHTML = d
    ? dailyReportHTML(d, false)
    : `<div style="color:var(--text3);font-size:13px;text-align:center;padding:24px 0">아직 리포트 없음 — ${mkt === 'KR' ? '국장' : '미장'} 마감 후 자동 생성됩니다<br><span style="font-size:11px">국장은 평일 16:40, 미장은 익일 06:10경(KST) 올라옵니다</span></div>`;
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

async function openReportArchive(tab = 'ai') {
  _archTab = tab;
  let el = document.getElementById('reportArchiveModal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'reportArchiveModal';
    el.className = 'cal-overlay';
    el.innerHTML = `
      <div class="cal-modal" style="width:min(680px,96vw)" onclick="event.stopPropagation()">
        <div class="cal-modal-head">
          <h2>📚 지난 리포트</h2>
          <button class="cal-close-btn" onclick="closeReportArchive()">✕</button>
        </div>
        <div class="cal-tabs">
          <div class="cal-tab" id="archTabAi"   onclick="switchArchTab('ai')">🤖 AI 시장 종합</div>
          <div class="cal-tab" id="archTabDrUs" onclick="switchArchTab('dr-us')">🇺🇸 데일리 미장</div>
          <div class="cal-tab" id="archTabDrKr" onclick="switchArchTab('dr-kr')">🇰🇷 데일리 국장</div>
        </div>
        <div class="cal-body" id="archBody" style="padding:12px 20px 20px">
          <div style="text-align:center;padding:40px;color:var(--text3)">로딩 중...</div>
        </div>
      </div>`;
    el.addEventListener('click', e => { if (e.target === el) closeReportArchive(); });
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
  await renderArchList();
}

function closeReportArchive() {
  const el = document.getElementById('reportArchiveModal');
  if (el) el.style.display = 'none';
}

async function switchArchTab(tab) {
  _archTab = tab;
  await renderArchList();
}

function _archSyncTabs() {
  const m = { ai: 'archTabAi', 'dr-us': 'archTabDrUs', 'dr-kr': 'archTabDrKr' };
  Object.entries(m).forEach(([k, id]) => document.getElementById(id)?.classList.toggle('active', k === _archTab));
}

async function renderArchList() {
  _archSyncTabs();
  const body = document.getElementById('archBody');
  if (!body) return;

  if (!_archCache[_archTab]) {
    body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">로딩 중...</div>';
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
    body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">아직 저장된 리포트가 없습니다</div>';
    return;
  }

  body.innerHTML = items.map((d, i) => {
    const isAi = _archTab === 'ai';
    const dateStr = isAi
      ? new Date(d.created_at).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : (d.report_date || '') + (d.created_at ? ' ' + new Date(d.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '');
    const badge = sentimentBadge(isAi ? d.regime : d.mood);
    return `
    <div class="arch-item" onclick="renderArchDetail(${i})">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
        <span style="font-size:11px;color:var(--text3);font-family:'SF Mono',monospace">${escHtml(dateStr || '')}</span>
        ${badge}
        <span style="font-size:10px;color:var(--text3)">${d.based_on_issues || 0}건</span>
      </div>
      <div style="font-size:12.5px;font-weight:600;color:var(--text1)">${escHtml(d.headline || '(제목 없음)')}</div>
    </div>`;
  }).join('');
}

function renderArchDetail(idx) {
  const body = document.getElementById('archBody');
  const d = _archCache[_archTab]?.[idx];
  if (!body || !d) return;
  const detailHtml = _archTab === 'ai' ? aiSummaryHTML(d) : dailyReportHTML(d, false);
  body.innerHTML = `
    <span class="arch-back" onclick="renderArchList()">← 목록으로</span>
    <div style="max-width:560px">${detailHtml}</div>`;
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
    if (!items.length) { el.innerHTML = '<div style="color:var(--text3);font-size:11px;text-align:center">데이터 없음 (시장 휴장)</div>'; return; }
    const maxAbs = Math.max(...items.map(it => Math.abs(it.pct)), 1);
    el.innerHTML = items.map(it => {
      const barPct = (Math.abs(it.pct) / maxAbs) * 100;
      const color = it.pct >= 0 ? 'var(--green)' : 'var(--red)';
      const sign = it.pct >= 0 ? '+' : '';
      return `<div style="display:flex;align-items:center;gap:8px;font-size:11px;margin-bottom:5px">
        <span style="width:74px;color:var(--text2);flex-shrink:0">${escHtml(it.n)}</span>
        <div style="flex:1;background:var(--bg3);border-radius:3px;height:6px;position:relative;overflow:hidden">
          <div style="position:absolute;${it.pct >= 0 ? 'left:50%' : `right:50%`};top:0;bottom:0;background:${color};width:${barPct/2}%;border-radius:2px"></div>
          <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--border)"></div>
        </div>
        <span style="color:${color};font-weight:700;font-family:var(--font-mono,monospace);width:56px;text-align:right">${sign}${it.pct.toFixed(2)}%</span>
      </div>`;
    }).join('');
  } catch { el.innerHTML = '<div style="color:var(--red);font-size:11px;text-align:center">로드 실패</div>'; }
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
    if (valid.length < 2) { el.innerHTML = '<div style="color:var(--text3);font-size:11px;text-align:center;padding:10px">데이터 부족</div>'; return; }

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
    let html = `<div style="overflow-x:auto"><table style="border-collapse:separate;border-spacing:2px;font-size:9.5px;margin:0 auto"><thead><tr><th style="width:36px"></th>${valid.map(a => `<th style="font-weight:600;color:var(--text2);padding:2px 1px;text-align:center;min-width:32px">${escHtml(a.n)}</th>`).join('')}</tr></thead><tbody>`;
    for (const a of valid) {
      html += `<tr><td style="font-weight:600;color:var(--text2);padding:3px 4px;white-space:nowrap;text-align:right">${escHtml(a.n)}</td>`;
      for (const b of valid) {
        const c = a.t === b.t ? 1 : corr(returns[a.t], returns[b.t]);
        const col = cellColor(c);
        html += `<td style="background:${col.bg};color:${col.fg};text-align:center;padding:3px 4px;border-radius:3px;font-weight:600;font-family:var(--font-mono,monospace);min-width:32px">${c != null ? c.toFixed(2) : '—'}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table></div><div style="font-size:9px;color:var(--text3);text-align:center;margin-top:6px">+1: 같이 움직임 / 0: 무상관 / −1: 반대로</div>';
    el.innerHTML = html;
  } catch { el.innerHTML = '<div style="color:var(--red);font-size:11px;text-align:center">로드 실패</div>'; }
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
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text3);font-size:12px;padding:20px">로딩 중...</div>';
  }

  try {
    let items;
    // 세션은 자동 감지: 야후 marketState(휴장일 반영) 기준으로 프리/애프터 시세를 자동 적용
    let liveSession = null;   // 'pre' | 'post' | 'kr-ot' | null(정규/마감)
    let domState = null;      // 다수결 marketState (상태 배지용)

    const r = await fetch(`/api/quotes?tickers=${tickers.join(',')}&range=${_hmRange}`);
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
      return { ticker: t, pct, price, currency: d.currency, name: nameMap[t] || d.shortName || t, session };
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

    if (effectiveView === 'sector' && !drillSector) {
      // 1단계: 섹터 박스 (평균 등락률 기준, 항상 통째 리렌더 — 박스 11개라 비용 적음)
      if (needsRebuild) renderSectorBoxes(grid, items, structureKey);
    } else if (effectiveView === 'sector' && drillSector) {
      // 2단계: 드릴다운된 섹터 종목만 필터링해 기존 타일 그리드로 표시
      const filtered = items.filter(it => sectorOf(it.ticker) === drillSector);
      renderTileGrid(grid, filtered, needsRebuild, structureKey, {
        backLabel: `전체 섹터 (${SECTOR_META[drillSector]?.label || drillSector})`,
        backAction: 'heatmapSectorBack()',
      });
    } else {
      // 전체보기 — 기존 그대로 (모바일은 상위 N개 + 더보기)
      renderTileGrid(grid, items, needsRebuild, structureKey, { mobileLimit: true });
    }

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
      const missing = tickers.length - items.length;
      const shownCount = (!isNarrowViewport() || _hmMobileExpanded) ? items.length : Math.min(items.length, HM_MOBILE_LIMIT);
      countEl.textContent = `${shownCount}개 표시${shownCount < items.length ? ` (전체 ${items.length}개)` : ''}${missing > 0 ? ` · ${missing}개 데이터 없음` : ''} / ${tickers.length}개 요청`;
    }
  } catch (e) {
    if (needsRebuild) grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--red);font-size:12px;padding:20px">로드 실패: ${e.message}</div>`;
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
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">
      <div style="display:flex;flex-direction:column;gap:2px">
        <span style="font-weight:600;color:var(--text)">${it.label}</span>
        <span style="font-size:10px;color:var(--text3)">${it.sub} · ${fmtDate(it.d)}</span>
      </div>
      <span style="font-size:11px;font-weight:700;color:${urgent ? 'var(--red)' : 'var(--text2)'};white-space:nowrap">D-${dl}</span>
    </div>`;
  }).join('') || '<div style="color:var(--text3);font-size:11px;text-align:center;padding:8px 0">예정 없음</div>';
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
  setInterval(() => { try { loadHeatmap(); } catch {} }, 15000);
  // 60초 섹터 모멘텀
  setInterval(() => { try { loadSectorMomentum(); } catch {} }, 60000);
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
  setInterval(() => { try { pollNewIssues(); } catch {} }, 45000);
  setInterval(() => { try { updateFeedLiveTag(); } catch {} }, 30000);
  // 장중 브라우저 구동 수집: 즉시 1회 + 5분마다 (서버가 게이트·레이트리밋 — 간격을 늘려
  // 동시접속자 많을 때 Claude 호출이 겹쳐 불어나는 걸 추가로 방지, 비용 급증 대응 2026-07)
  try { triggerLiveCollect(); } catch {}
  setInterval(() => { try { triggerLiveCollect(); } catch {} }, 300000);
  // 5분마다 국장 현황 새로고침
  setInterval(() => { try { delete _kmCache[_kmTab]; loadKrMarket(); } catch {} }, 300000);
  // 1분마다 국장 요약(지수 카드 + 인기검색 + 수급차트) 새로고침
  setInterval(() => { try { loadKrSummary(); } catch {} }, 60000);
  // 미장현황 탭이 보일 때만 새로고침 (숨겨져 있으면 불필요한 호출 방지)
  setInterval(() => { try { if (_marketSection === 'us') loadUsSummary(); } catch {} }, 60000);
  setInterval(() => { try { if (_marketSection === 'us') { delete _usmCache[_usmTab]; loadUsMarket(); } } catch {} }, 300000);
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
