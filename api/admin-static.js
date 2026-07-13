/**
 * admin-static.js — 어드민 대시보드 마크업(shell) + 업무로직(logic) 통합 서빙 (인증 전용)
 * GET /api/admin-static?asset=shell → nav+panel HTML 마크업 (구 /api/admin-shell)
 * GET /api/admin-static?asset=logic → 대시보드 JS 업무 로직 (구 /api/admin-logic)
 *
 * 원래 2개 파일(admin-shell.js/admin-logic.js)이었으나 Vercel Hobby 플랜의
 * 서버리스 함수 12개 제한에 걸려 하나로 합침 — 프론트 fetch 경로는
 * vercel.json rewrites로 그대로 유지(/api/admin-shell, /api/admin-logic).
 *
 * admin/index.html은 정적 파일이라 로그인 여부와 무관하게 '보기 소스'로 전체
 * 메뉴/패널 구조가 그대로 노출되는 문제가 있었다. 이 마크업을 서버 함수 뒤로
 * 옮겨 유효한 관리자 토큰(Supabase 세션 또는 ADMIN_SECRET)이 있어야만
 * 내려주도록 한다 — 페이지 최초 응답에는 로그인 폼과 빈 컨테이너만 존재.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { verifyAdmin } from '../lib/auth.js';

const SHELL_HTML = `
<nav class="sidebar">
  <div class="sidebar-logo">
    <div class="site-name">StockRipple</div>
    <div class="site-sub">관리자 패널</div>
  </div>
  <div class="sidebar-nav">
    <div class="nav-section">대시보드</div>
    <button class="nav-item active" data-panel="dashboard">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
      대시보드
    </button>
    <div class="nav-section">데이터 관리</div>
    <button class="nav-item" data-panel="news">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.61"/></svg>
      수집 + 분석
    </button>
    <button class="nav-item" data-panel="issues">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      이슈 목록
    </button>
    <button class="nav-item" data-panel="companies">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
      기업 데이터
    </button>
    <button class="nav-item" data-panel="investments">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="12 2 15 8.5 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 9 8.5 12 2"/></svg>
      🌟 전략투자
    </button>
    <div class="nav-section">설정</div>
    <button class="nav-item" data-panel="accuracy">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      예측 정확도</button>
    <button class="nav-item" data-panel="backtest">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
      📈 통계 + 백테스트
    </button>
    <button class="nav-item" data-panel="views">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      👁 조회수 통계
    </button>
    <button class="nav-item" data-panel="analytics">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
      📊 방문자 분석
    </button>
    <button class="nav-item" data-panel="reanalyze">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
      재분석 (구→신 변환)
    </button>
    <button class="nav-item" data-panel="feedback">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
      💬 사용자 피드백 <span id="fbNavBadge" class="fb-nav-badge" style="display:none"></span>
    </button>
    <button class="nav-item" data-panel="users">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      👤 회원 관리
    </button>
    <button class="nav-item" data-panel="announcement">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      🚨 긴급 안내 <span id="annNavBadge" class="fb-nav-badge" style="display:none">ON</span>
    </button>
    <button class="nav-item" data-panel="settings">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
      API 키 설정
    </button>
  </div>
  <div class="sidebar-footer">
    <a href="/" class="back-link">
      <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
      사이트 홈으로
    </a>
  </div>
</nav>

<div class="main">
  <div class="topbar">
    <div>
      <div class="topbar-title" id="topbarTitle">대시보드</div>
      <div class="topbar-sub" id="topbarSub">StockRipple 관리자</div>
    </div>
    <div class="spacer"></div>
    <button class="btn btn-ghost" onclick="location.reload()">새로고침</button>
  </div>

  <div class="content">

    <!-- Dashboard -->
    <div class="panel-section active" id="panel-dashboard">
      <div class="stats-grid" id="dashStats">
        <div class="stat-card"><div class="stat-label">총 이슈</div><div class="stat-value blue" id="ds-issues">—</div></div>
        <div class="stat-card"><div class="stat-label">분석 완료</div><div class="stat-value green" id="ds-analyzed">—</div></div>
        <div class="stat-card"><div class="stat-label">미분석</div><div class="stat-value yellow" id="ds-pending">—</div></div>
        <div class="stat-card"><div class="stat-label">등록 기업</div><div class="stat-value blue" id="ds-companies">—</div></div>
        <div class="stat-card">
          <div class="stat-label">🟢 실시간 접속자</div>
          <div class="stat-value green" id="ds-live-visitors">—</div>
          <div id="ds-live-pages" style="font-size:11px;color:var(--text3);margin-top:6px;line-height:1.6"></div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">전체 파이프라인 실행</div>
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">수집(뉴스+RSS+이벤트) → AI 분석 → 정확도 체크까지 한 번에 자동 실행</p>
        <div class="action-row">
          <button class="btn btn-success" style="font-size:14px;padding:10px 24px" onclick="runPipeline()">
            ▶ 수집 + 분석 한번에 실행
          </button>
          <button class="btn btn-ghost" onclick="showPanel('issues')">이슈 목록 보기</button>
        </div>
        <div id="pipelineLog" class="log-box" style="display:none"></div>
      </div>
      <div class="card">
        <div class="card-title">개별 실행</div>
        <div class="action-row">
          <button class="btn btn-ghost" onclick="runFetchOnly()">뉴스만 수집</button>
          <button class="btn btn-ghost" onclick="runAnalyze(null, 5, 'quickLog')">분석만 실행 (최대 20건)</button>
          <button class="btn btn-primary" onclick="runAnalyze(null, 5, 'quickLog', 60)" title="미분석 백로그를 최대 300건까지 한 번에 처리 (체이닝, 약 40~50분 소요, 백그라운드에서 계속 진행)">🚀 지금 최대한 분석 (최대 300건)</button>
          <button class="btn btn-ghost" onclick="runAiMarketSummary()" title="메인 피드 상단 'AI 시장 종합' 카드 생성 (Haiku 1회 호출, ~$0.005)">📰 AI 시장 종합 생성</button>
        </div>
        <div id="quickLog" class="log-box" style="display:none"></div>
      </div>

      <div class="card">
        <div class="card-title">📰 데일리 리포트 소급 생성</div>
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">크레딧 소진 등으로 특정 거래일 리포트가 안 만들어졌을 때, 날짜를 지정해서 그날 뉴스만으로 다시 생성합니다. 지수 데이터는 실시간 조회라 며칠 지나도 그날 종가가 그대로 잡힙니다.</p>
        <div class="form-group" style="max-width:220px">
          <label class="form-label">대상 거래일</label>
          <input type="date" id="drBackfillDate" class="form-input">
        </div>
        <div class="action-row">
          <button class="btn btn-ghost" onclick="runDailyReportBackfill('KR')">🇰🇷 국장 리포트 생성</button>
          <button class="btn btn-ghost" onclick="runDailyReportBackfill('US')">🇺🇸 미장 리포트 생성</button>
        </div>
        <div id="drBackfillLog" class="log-box" style="display:none"></div>
      </div>

      <div class="card">
        <div class="card-title">🔌 AI 기능 on/off (토큰 사용 제어)</div>
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">Claude API를 호출하는 자동/상시 파이프라인을 개별로, 또는 한 번에 켜고 끌 수 있습니다. 꺼도 크론 스케줄 자체는 계속 돌지만 실제 Claude 호출은 스킵되어 비용이 발생하지 않습니다.</p>
        <div class="action-row" style="margin-bottom:12px">
          <button class="btn btn-ghost" style="border-color:#e31937;color:#e31937" onclick="bulkToggleFeatureFlags(false)">🔴 전체 OFF</button>
          <button class="btn btn-ghost" style="border-color:#00873a;color:#00873a" onclick="bulkToggleFeatureFlags(true)">🟢 전체 ON</button>
          <button class="btn btn-ghost" onclick="loadFeatureFlags()">🔄 새로고침</button>
        </div>
        <div id="featureFlagsList" style="display:flex;flex-direction:column;gap:8px;font-size:13px;color:var(--text3)">로딩 중...</div>
        <div id="featureFlagsLog" class="log-box" style="display:none;margin-top:12px"></div>
      </div>
    </div>

    <!-- News (수집 메뉴는 파이프라인으로 통합됨) -->
    <div class="panel-section" id="panel-news">
      <div class="section-header">
        <h2>수집 + AI 분석</h2>
        <p>뉴스/RSS/이벤트 수집 후 Claude AI 분석까지 한번에 실행합니다.</p>
      </div>
      <div class="card">
        <div class="card-title">전체 파이프라인</div>
        <div class="action-row">
          <button class="btn btn-success" onclick="runPipeline('newsLog')">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.61"/></svg>
            수집 + 분석 한번에 실행
          </button>
          <button class="btn btn-ghost" onclick="runFetchOnly('newsLog')">뉴스만 수집</button>
        </div>
        <div class="log-box" id="newsLog">대기 중...</div>
      </div>
      <div class="card">
        <div class="card-title">개별 이슈 분석</div>
        <div class="form-group">
          <label class="form-label">이슈 ID</label>
          <input type="text" id="singleIssueId" class="form-input" placeholder="이슈 UUID를 입력하세요">
        </div>
        <button class="btn btn-primary" onclick="runAnalyzeSingle()">이 이슈 분석</button>
        <div class="log-box" id="analyzeLog" style="margin-top:12px">대기 중...</div>
      </div>
    </div>

    <!-- Analyze 메뉴 제거 (news 패널에 통합) -->
    <div class="panel-section" id="panel-analyze" style="display:none"></div>

    <!-- Issues -->
    <div class="panel-section" id="panel-issues">
      <div class="section-header">
        <h2>이슈 목록</h2>
        <p>수집된 모든 뉴스 이슈를 관리합니다.</p>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th style="width:44%">제목</th>
                <th>출처</th>
                <th>섹터</th>
                <th>상태</th>
                <th>날짜</th>
                <th>작업</th>
              </tr>
            </thead>
            <tbody id="issuesTable"><tr><td colspan="6" class="loading-row">불러오는 중...</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Companies -->
    <div class="panel-section" id="panel-companies">
      <div class="section-header">
        <h2>기업 데이터</h2>
        <p>AI 분석으로 발굴된 기업 목록입니다.</p>
      </div>
      <div class="action-row">
        <button class="btn btn-ghost" onclick="refreshAllPrices()">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.61"/></svg>
          전체 주가 갱신
        </button>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>티커</th>
                <th>기업명</th>
                <th>시장</th>
                <th>현재가</th>
                <th>시총</th>
                <th>업데이트</th>
                <th>작업</th>
              </tr>
            </thead>
            <tbody id="companiesTable"><tr><td colspan="7" class="loading-row">불러오는 중...</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Strategic Investments -->
    <div class="panel-section" id="panel-investments">
      <div class="section-header">
        <h2>🌟 전략투자 관리</h2>
        <p>뉴스에서 자동 추출된 기업 간 전략적 지분/투자 사실 — 승인·거부·하이라이트 관리</p>
      </div>

      <!-- 액션 바 -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        <button class="btn btn-primary" onclick="invExtractNow()">🔄 즉시 추출 (지난 1주)</button>
        <button class="btn btn-ghost"   onclick="invDartPoll()">📊 DART 5%+ 폴링</button>
        <button class="btn btn-ghost"   onclick="invSec13fPoll()">🇺🇸 SEC 13F 폴링</button>
        <button class="btn btn-ghost"   onclick="invDartSyncCorpCodes()" title="DART corp_code 자동 동기화 (Vercel→한국 네트워크 느려서 timeout 가능)">🔗 DART 자동 동기화</button>
        <button class="btn btn-ghost"   onclick="invDartUploadCorpCodes()" title="자동 동기화 timeout 시 한국에서 직접 받은 CSV를 붙여넣기">📥 DART CSV 업로드</button>
        <button class="btn btn-ghost"   onclick="invVerifyKrNames()" title="DART 공식 회사명과 DB 이름 대조 → 자동 보정">🇰🇷 KR 종목명 검증·보정</button>
        <span style="flex:1"></span>
        <select id="invStatusFilter" onchange="invLoad()" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px">
          <option value="active">활성</option>
          <option value="rejected">거부됨</option>
          <option value="all">전체</option>
        </select>
        <input id="invSearch" placeholder="검색 (회사/대상/설명)" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px;width:200px"
               onkeydown="if(event.key==='Enter')invLoad()">
        <button class="btn btn-ghost" onclick="invLoad()">검색</button>
      </div>

      <div id="invStatusBox" style="font-size:12px;color:var(--text2);margin-bottom:12px"></div>

      <!-- 티커별 그래프 -->
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:18px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px">
          <div style="font-weight:700;font-size:14px">📈 티커별 누적 추출 추이</div>
          <select id="invChartTicker" onchange="invLoadChart()" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;min-width:200px">
            <option value="">티커 선택...</option>
          </select>
        </div>
        <div style="position:relative;height:240px"><canvas id="invChart"></canvas></div>
        <div id="invChartHint" style="font-size:11px;color:var(--text3);margin-top:8px">상단의 티커를 선택하면 추출 이벤트 누적 추이가 표시됩니다.</div>
      </div>

      <!-- 목록 -->
      <div id="invList" style="display:flex;flex-direction:column;gap:10px"></div>
      <div id="invPagination" style="display:flex;justify-content:center;gap:8px;margin-top:18px"></div>
    </div>

    <!-- Accuracy -->
    <div class="panel-section" id="panel-accuracy">
      <div class="section-header">
        <h2>예측 정확도</h2>
        <p>AI 예측 후 실제 주가 변동과 비교한 정확도입니다.</p>
      </div>
      <div class="action-row">
        <button class="btn btn-ghost" onclick="runAccuracyCheck()">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.61"/></svg>
          정확도 체크 실행
        </button>
      </div>
      <div class="stats-grid" id="accuracyStats">
        <div class="stat-card"><div class="stat-label">1일 체크 완료</div><div class="stat-value blue" id="acc-1d-total">—</div></div>
        <div class="stat-card"><div class="stat-label">1일 방향 정확도</div><div class="stat-value green" id="acc-1d-rate">—</div><div style="font-size:10.5px;color:var(--text-muted);margin-top:3px" id="acc-1d-split"></div></div>
        <div class="stat-card"><div class="stat-label">3일 체크 완료</div><div class="stat-value blue" id="acc-3d-total">—</div></div>
        <div class="stat-card"><div class="stat-label">3일 방향 정확도</div><div class="stat-value green" id="acc-3d-rate">—</div><div style="font-size:10.5px;color:var(--text-muted);margin-top:3px" id="acc-3d-split"></div></div>
        <div class="stat-card"><div class="stat-label">7일 체크 완료</div><div class="stat-value blue" id="acc-7d-total">—</div></div>
        <div class="stat-card"><div class="stat-label">7일 방향 정확도</div><div class="stat-value green" id="acc-7d-rate">—</div><div style="font-size:10.5px;color:var(--text-muted);margin-top:3px" id="acc-7d-split"></div></div>
        <div class="stat-card"><div class="stat-label">30일 체크 완료</div><div class="stat-value blue" id="acc-30d-total">—</div></div>
        <div class="stat-card"><div class="stat-label">30일 방향 정확도</div><div class="stat-value green" id="acc-30d-rate">—</div><div style="font-size:10.5px;color:var(--text-muted);margin-top:3px" id="acc-30d-split"></div></div>
      </div>
      <div class="card">
        <div class="card-title">1일 후 결과</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>티커</th><th>기업명</th><th>예측 상승률</th><th>진입가</th><th>1일 후 가격</th><th>실제 수익률</th><th>정확도</th></tr></thead>
            <tbody id="accuracy1dTable"><tr><td colspan="7" class="loading-row">불러오는 중...</td></tr></tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-title">3일 후 결과</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>티커</th><th>기업명</th><th>예측 상승률</th><th>진입가</th><th>3일 후 가격</th><th>실제 수익률</th><th>정확도</th></tr></thead>
            <tbody id="accuracy3dTable"><tr><td colspan="7" class="loading-row">불러오는 중...</td></tr></tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-title">7일 후 결과</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>티커</th><th>기업명</th><th>예측 상승률</th><th>진입가</th><th>7일 후 가격</th><th>실제 수익률</th><th>정확도</th></tr></thead>
            <tbody id="accuracy7dTable"><tr><td colspan="7" class="loading-row">불러오는 중...</td></tr></tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-title">30일 후 결과</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>티커</th><th>기업명</th><th>예측 상승률</th><th>진입가</th><th>30일 후 가격</th><th>실제 수익률</th><th>정확도</th></tr></thead>
            <tbody id="accuracy30dTable"><tr><td colspan="7" class="loading-row">불러오는 중...</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Backtest -->
    <div class="panel-section" id="panel-backtest">
      <div class="section-header">
        <h2>📈 통계 + 백테스트</h2>
        <p>누적된 AI 예측 데이터의 전체 정확도, 신뢰도/섹터별 분포, 가상 매수 시 누적 수익률</p>
      </div>

      <div class="action-row" style="margin-bottom:16px">
        <button class="btn btn-primary" onclick="loadBacktest()">📊 분석 실행 / 새로고침</button>
        <span id="btUpdated" style="font-size:12px;color:var(--text3);align-self:center"></span>
      </div>

      <!-- 전체 통계 -->
      <div class="card">
        <div class="card-title">전체 검증 결과</div>
        <div id="btOverall" class="stats-grid">
          <div class="stat-card"><div class="stat-label">총 예측</div><div class="stat-value blue" id="btTotal">—</div></div>
          <div class="stat-card"><div class="stat-label">7일 검증</div><div class="stat-value green" id="btV7d">—</div></div>
          <div class="stat-card"><div class="stat-label">7일 적중률</div><div class="stat-value yellow" id="btAcc7d">—</div></div>
          <div class="stat-card"><div class="stat-label">30일 적중률</div><div class="stat-value yellow" id="btAcc30d">—</div></div>
        </div>
      </div>

      <!-- 백테스트 결과 -->
      <div class="card">
        <div class="card-title">💼 백테스트 — AI 추천대로 동일 비중 매수 시 (7일 보유)</div>
        <div class="stats-grid">
          <div class="stat-card"><div class="stat-label">총 거래</div><div class="stat-value blue" id="btTrades">—</div></div>
          <div class="stat-card"><div class="stat-label">승률</div><div class="stat-value green" id="btWinRate">—</div></div>
          <div class="stat-card"><div class="stat-label">평균 수익률</div><div class="stat-value yellow" id="btAvgRet">—</div></div>
          <div class="stat-card"><div class="stat-label">주간 복리 수익률</div><div class="stat-value green" id="btCumRet">—</div><div class="stat-label" id="btCumWeeks" style="margin-top:2px"></div></div>
        </div>
        <p style="font-size:11px;color:var(--text3);margin-top:10px;line-height:1.55">
          📐 <b>주간 복리</b> = 같은 주에 진입한 추천을 동일 비중 바스켓(7일 보유)으로 묶고, 주별 평균 수익률을 시간순으로 복리한 시뮬레이션 <code style="background:var(--bg3);padding:1px 5px;border-radius:3px;font-size:10px">(1+w₁)(1+w₂)...(1+wₙ) - 1</code><br>
          ⚠️ 실제 투자에는 수수료/세금/슬리피지/동시보유 제약 등이 추가됨. 단순 백테스트 지표이며 실현 수익을 보장하지 않음.
        </p>
      </div>

      <!-- 신뢰도별 정확도 -->
      <div class="card">
        <div class="card-title">🎯 AI 신뢰도 버킷별 정확도</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>신뢰도 구간</th><th>건수</th><th>7일 적중률</th><th>평균 실제 수익률</th><th>평균 예상 상승률</th></tr></thead>
            <tbody id="btConfTable"><tr><td colspan="5" class="loading-row">아직 실행 안 됨</td></tr></tbody>
          </table>
        </div>
      </div>

      <!-- 섹터별 정확도 -->
      <div class="card">
        <div class="card-title">🏭 섹터별 정확도 (Top 15)</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>섹터</th><th>건수</th><th>7일 적중률</th><th>평균 실제 수익률</th><th>평균 예상</th></tr></thead>
            <tbody id="btSectorTable"><tr><td colspan="5" class="loading-row">아직 실행 안 됨</td></tr></tbody>
          </table>
        </div>
      </div>

      <!-- 종목별 Top -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div class="card">
          <div class="card-title">🏆 평균 수익 TOP 10 <span style="font-size:11px;color:var(--text3);font-weight:400">(거래 3회 이상)</span></div>
          <div style="font-size:11px;color:var(--text3);padding:6px 12px 8px;line-height:1.5">
            <b>거래수</b>: 동일 종목 추천 횟수 · <b>평균</b>: 7일 수익률 단순평균 ·
            <b>승률</b>: 7일 수익률이 플러스였던 비율
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>티커</th><th>이름</th><th>거래</th><th>평균 (1회)</th><th>승률</th></tr></thead>
              <tbody id="btWinnersTable"><tr><td colspan="5" class="loading-row">—</td></tr></tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-title">📉 평균 손실 BOTTOM 10 <span style="font-size:11px;color:var(--text3);font-weight:400">(거래 3회 이상)</span></div>
          <div style="font-size:11px;color:var(--text3);padding:6px 12px 8px;line-height:1.5">
            ※ 단일 거래(n=1)는 노이즈로 제외 — 통계적 의미가 있는 3회 이상만 표시
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>티커</th><th>이름</th><th>거래</th><th>평균 (1회)</th><th>승률</th></tr></thead>
              <tbody id="btLosersTable"><tr><td colspan="5" class="loading-row">—</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 기간별 비교 -->
      <div class="card">
        <div class="card-title">⏰ 기간별 성과 비교</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>기간</th><th>검증 건수</th><th>적중률 (방향+최소변동)</th><th>승률 (방향만)</th><th>평균 수익률</th></tr></thead>
            <tbody id="btPeriodTable"><tr><td colspan="5" class="loading-row">—</td></tr></tbody>
          </table>
        </div>
        <p style="font-size:11px;color:var(--text3);margin-top:10px">
          • <b>적중률</b>: 방향 일치 + 최소 변동 충족 (1d≥0.3%, 7d≥1.5%, 30d≥3.0%)<br>
          • <b>승률</b>: 방향만 일치 (수익 났는지 여부)
        </p>
      </div>
    </div>

    <!-- Reanalyze -->
    <div class="panel-section" id="panel-reanalyze">
      <div class="section-header">
        <h2>재분석 (구버전 → 신버전 변환)</h2>
        <p>기존 분석된 이슈를 새 형식(매수가/목표/손절/시간프레임/thesis/risk)으로 재분석합니다.</p>
      </div>

      <div class="card" style="background:linear-gradient(135deg,rgba(63,185,80,.08),rgba(47,129,247,.08));border-color:rgba(63,185,80,.3)">
        <div class="card-title">💡 사용 시기</div>
        <p style="font-size:13px;color:var(--text2);line-height:1.6">
          • AI 분석 프롬프트를 새 형식으로 업그레이드한 후, <b>기존 데이터를 일괄 변환</b>할 때<br>
          • 매일 자동 수집되는 신규 이슈는 이미 새 형식으로 분석되므로 재분석 불필요<br>
          • 비용: 이슈당 약 $0.003 (Claude Haiku 4.5)
        </p>
      </div>

      <div class="card">
        <div class="card-title">단일 배치 재분석</div>
        <div class="form-group">
          <label class="form-label">재분석할 최근 이슈 개수 (1회 최대 5 — 펀더멘털 fetch 포함)</label>
          <input type="number" id="reanCount" class="form-input" value="5" min="1" max="5">
        </div>
        <div class="action-row">
          <button class="btn btn-primary" id="reanRunBtn" onclick="reanRunSingle()">재분석 시작</button>
          <button class="btn btn-success" onclick="reanRunFresh()">신규 미분석만 분석</button>
        </div>
        <div class="log-box" id="reanLog" style="display:none;margin-top:12px"></div>
      </div>

      <div class="card">
        <div class="card-title">🔁 자동 반복 (전체 재분석) — 비활성화됨</div>
        <p style="font-size:13px;color:var(--text2);margin-bottom:10px">
          탭을 열어둔 채 방치하면 브라우저에서 무한정 계속 돌면서 Claude API 크레딧을 소모하는
          문제가 있어 기능을 비활성화했습니다. 필요하면 개발자에게 안전장치(총 상한 등)를 추가해 다시 요청하세요.
        </p>
        <div class="action-row">
          <button class="btn btn-warn" disabled title="비활성화됨">🔁 자동 반복 시작 (비활성화됨)</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">🏷️ 회사명 일괄 보정</div>
        <p style="font-size:13px;color:var(--text2);margin-bottom:10px">
          <b>기본 모드</b>: Yahoo Finance 공식명으로 빈 이름/티커명만 보정 (빠름, 무료)<br>
          <b>AI 검증 모드</b>: Claude AI가 한국어 이름 환각(예: LRCX="라이젠")을 감지하고 정확한 이름으로 교체
        </p>
        <div class="form-group" style="display:flex;gap:10px;align-items:center;margin-bottom:8px">
          <label style="font-size:12px;color:var(--text2);margin:0">배치 크기:</label>
          <input type="number" id="fnBatchSize" class="form-input" value="10" min="3" max="20" style="width:80px">
          <span style="font-size:11px;color:var(--text3)">3-20 권장 (작을수록 안정, 클수록 빠름)</span>
        </div>
        <div class="action-row" style="margin-bottom:8px">
          <button class="btn btn-ghost" onclick="fixNames(true)">기본 미리보기</button>
          <button class="btn btn-primary" onclick="fixNames(false)">기본 실행</button>
        </div>
        <div class="action-row">
          <button class="btn btn-warn" id="fnAiPreviewBtn" onclick="fixNamesAi(true)">🤖 AI 검증 미리보기 (1배치)</button>
          <button class="btn btn-warn" id="fnAiRunBtn" onclick="fixNamesAi(false)">🤖 AI 검증 자동 반복 (전체)</button>
        </div>
        <!-- 실시간 진행 상태 -->
        <div id="fnStatus" style="display:none;margin-top:12px;padding:10px 14px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;font-size:13px">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <div class="spinner-mini"></div>
            <span id="fnStatusText">대기 중...</span>
            <span style="margin-left:auto;color:var(--text3);font-family:monospace;font-size:12px">
              <span id="fnElapsed">0</span>초 · 배치 <span id="fnBatchN">0</span>/<span id="fnBatchT">?</span>
            </span>
          </div>
          <div style="margin-top:8px;height:4px;background:var(--bg);border-radius:2px;overflow:hidden">
            <div id="fnProgBar" style="height:100%;width:0;background:linear-gradient(90deg,var(--blue),var(--green));transition:width .5s"></div>
          </div>
        </div>
        <div class="log-box" id="fixNamesLog" style="display:none;margin-top:12px"></div>
      </div>
      <style>
        .spinner-mini { width:12px;height:12px;border:2px solid var(--border);border-top-color:var(--blue);border-radius:50%;animation:fnSpin 0.8s linear infinite }
        @keyframes fnSpin { to { transform:rotate(360deg) } }
      </style>
    </div>

    <!-- 종목 조회수 통계 -->
    <div class="panel-section" id="panel-views">
      <div class="section-header">
        <h2>👁 조회수 통계</h2>
        <p>기업 상세 페이지가 가장 많이 열린 종목 순위입니다 (/api/company-summary 호출 기준).</p>
      </div>
      <div class="action-row">
        <button class="btn btn-ghost" onclick="loadViewStats()">🔄 새로고침</button>
        <select id="viewsPeriod" onchange="loadViewStats()" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px">
          <option value="today">오늘</option>
          <option value="7d" selected>최근 7일</option>
          <option value="30d">최근 30일</option>
          <option value="all">전체</option>
        </select>
        <span id="viewsSummary" style="font-size:12px;color:var(--text3);align-self:center"></span>
      </div>
      <div class="card" style="margin-top:14px">
        <table>
          <thead><tr><th style="width:40px">#</th><th>티커</th><th>회사명</th><th>시장</th><th style="text-align:right">조회수</th></tr></thead>
          <tbody id="viewsTableBody"><tr><td colspan="5" style="text-align:center;color:var(--text3)">로딩 중...</td></tr></tbody>
        </table>
      </div>
    </div>

    <!-- 방문자 애널리틱스 -->
    <div class="panel-section" id="panel-analytics">
      <div class="section-header">
        <h2>📊 방문자 분석</h2>
        <p>일자별·시간대별 접속자, 유입경로, 페이지별 체류시간, 이동경로를 보여줍니다 (/sr-pulse.js 수집 기준).</p>
      </div>
      <div class="action-row">
        <button class="btn btn-ghost" onclick="loadAnalyticsAll()">🔄 새로고침</button>
        <select id="anaDays" onchange="loadAnalyticsAll()" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px">
          <option value="7">최근 7일</option>
          <option value="14" selected>최근 14일</option>
          <option value="30">최근 30일</option>
          <option value="90">최근 90일</option>
        </select>
        <span id="anaCappedNote" style="font-size:11px;color:var(--yellow)"></span>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-title">📅 일자별 접속자 (순 방문 세션 수)</div>
        <div id="anaDaily" style="margin-top:10px">로딩 중...</div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-title">🕐 시간대별 접속자 (KST, 선택 기간 통합)</div>
        <div id="anaHourly" style="margin-top:10px;display:flex;align-items:flex-end;gap:2px;height:120px">로딩 중...</div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px">
        <div class="card">
          <div class="card-title">🔗 유입경로 TOP 20</div>
          <table style="margin-top:8px">
            <thead><tr><th>경로</th><th style="text-align:right">방문자</th></tr></thead>
            <tbody id="anaReferrers"><tr><td colspan="2" style="text-align:center;color:var(--text3)">로딩 중...</td></tr></tbody>
          </table>
        </div>
        <div class="card">
          <div class="card-title">⏱ 페이지별 평균 체류시간 TOP 30</div>
          <table style="margin-top:8px">
            <thead><tr><th>페이지</th><th style="text-align:right">평균</th><th style="text-align:right">표본</th></tr></thead>
            <tbody id="anaDwell"><tr><td colspan="3" style="text-align:center;color:var(--text3)">로딩 중...</td></tr></tbody>
          </table>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-title">🧭 최근 이동경로 (세션 샘플 50개)</div>
        <div id="anaPaths" style="margin-top:10px;font-size:12px">로딩 중...</div>
      </div>
    </div>

    <!-- User Feedback -->
    <div class="panel-section" id="panel-feedback">
      <div class="section-header">
        <h2>💬 사용자 피드백</h2>
        <p>랜딩 페이지 챗봇 위젯으로 접수된 의견입니다. 상태를 바꿔가며 검토·반영 여부를 관리하세요.</p>
      </div>
      <div class="action-row">
        <button class="btn btn-ghost" onclick="loadFeedback()">🔄 새로고침</button>
        <select id="fbStatusFilter" onchange="loadFeedback()" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px">
          <option value="new">🆕 신규</option>
          <option value="reviewed">👀 검토됨</option>
          <option value="planned">📌 반영 예정</option>
          <option value="done">✅ 반영 완료</option>
          <option value="rejected">🗑️ 반려</option>
          <option value="all">전체</option>
        </select>
        <span id="fbCount" style="font-size:12px;color:var(--text3);align-self:center"></span>
      </div>
      <div id="fbList" style="display:flex;flex-direction:column;gap:10px;margin-top:14px"></div>
    </div>

    <!-- 회원 관리 -->
    <div class="panel-section" id="panel-users">
      <div class="section-header">
        <h2>👤 회원 관리</h2>
        <p>가입한 회원 목록입니다. 문제가 있는 계정은 차단(밴)해서 로그인을 막을 수 있습니다.</p>
      </div>
      <div class="action-row">
        <button class="btn btn-ghost" onclick="loadUsers()">🔄 새로고침</button>
        <input id="usersSearch" type="text" placeholder="이메일 검색" oninput="renderUsersFiltered()" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px;min-width:200px">
        <span id="usersSummary" style="font-size:12px;color:var(--text3);align-self:center"></span>
      </div>
      <div class="card" style="margin-top:14px">
        <table>
          <thead><tr><th>이메일</th><th>가입 방법</th><th>가입일</th><th>최근 로그인</th><th>상태</th><th style="text-align:right">관리</th></tr></thead>
          <tbody id="usersTableBody"><tr><td colspan="6" style="text-align:center;color:var(--text3)">로딩 중...</td></tr></tbody>
        </table>
      </div>
    </div>

    <!-- 긴급 안내 배너 -->
    <div class="panel-section" id="panel-announcement">
      <div class="section-header">
        <h2>🚨 긴급 안내</h2>
        <p>활성화하면 사이트 모든 페이지 상단에 배너로 노출됩니다 (사용자가 닫기 전까지 유지). 장애·점검 등 긴급 공지에 사용하세요. 사이드카·서킷브레이커·거래정지 등 속보성 이슈가 분석되면 자동으로도 켜집니다.</p>
      </div>
      <div class="card">
        <div id="annAutoNote" style="display:none;font-size:12px;color:var(--blue);background:var(--blue-dim,rgba(59,130,246,.08));padding:8px 12px;border-radius:8px;margin-bottom:12px">🤖 속보 감지로 자동 활성화된 배너입니다. 저장하면 수동 배너로 전환되어 이후 자동 갱신되지 않습니다.</div>
        <label style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:14px">
          <input type="checkbox" id="annActive" style="width:16px;height:16px;cursor:pointer">
          배너 활성화
        </label>
        <textarea id="annMessage" placeholder="예: 일부 종목 정보가 일시적으로 지연되고 있습니다. 확인 중입니다." rows="3"
          style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px;font-family:inherit;resize:vertical;box-sizing:border-box"></textarea>
        <div class="action-row" style="margin-top:12px">
          <button class="btn btn-primary" onclick="saveAnnouncement()">저장</button>
          <button class="btn btn-ghost" onclick="loadAnnouncement()">🔄 새로고침</button>
          <span id="annStatus" style="font-size:12px;color:var(--text3);align-self:center"></span>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-title">📜 발동 이력 <span class="meta" style="font-weight:400;color:var(--text3)">자동/수동 · 시작·종료 시각</span></div>
        <table style="margin-top:8px">
          <thead><tr><th style="width:70px">구분</th><th>문구</th><th style="width:150px">시작</th><th style="width:150px">종료</th><th style="width:70px;text-align:right">노출시간</th></tr></thead>
          <tbody id="annLogBody"><tr><td colspan="5" style="text-align:center;color:var(--text3)">로딩 중...</td></tr></tbody>
        </table>
      </div>
    </div>

    <!-- Settings -->
    <div class="panel-section" id="panel-settings">
      <div class="section-header">
        <h2>API 키 설정</h2>
        <p>Vercel 환경변수에 아래 키를 설정해야 서비스가 작동합니다.</p>
      </div>
      <div class="card">
        <div class="card-title">필수 환경변수</div>
        <table>
          <thead><tr><th>키 이름</th><th>설명</th><th>발급처</th><th>상태</th></tr></thead>
          <tbody>
            <tr><td><code style="color:var(--blue);font-size:12px">SUPABASE_URL</code></td><td>Supabase 프로젝트 URL</td><td>Supabase 대시보드</td><td><span class="badge badge-green">필수</span></td></tr>
            <tr><td><code style="color:var(--blue);font-size:12px">SUPABASE_SERVICE_KEY</code></td><td>Supabase Service Role Key</td><td>Supabase → Settings → API</td><td><span class="badge badge-green">필수</span></td></tr>
            <tr><td><code style="color:var(--blue);font-size:12px">ANTHROPIC_API_KEY</code></td><td>Claude AI API 키</td><td>console.anthropic.com</td><td><span class="badge badge-green">필수</span></td></tr>
            <tr><td><code style="color:var(--blue);font-size:12px">NEWS_API_KEY</code></td><td>NewsAPI.org API 키</td><td>newsapi.org</td><td><span class="badge badge-green">필수</span></td></tr>
            <tr><td><code style="color:var(--blue);font-size:12px">ADMIN_SECRET</code></td><td>관리자 인증 토큰</td><td>직접 생성 (무작위 문자열)</td><td><span class="badge badge-green">필수</span></td></tr>
            <tr><td><code style="color:var(--blue);font-size:12px">CRON_SECRET</code></td><td>Vercel 크론 인증 토큰</td><td>직접 생성</td><td><span class="badge badge-blue">크론 사용시</span></td></tr>
          </tbody>
        </table>
      </div>
    </div>

  </div>
</div>
`;

export default async function handler(req, res) {
  const auth = await verifyAdmin(req.headers.authorization);
  if (!auth.ok) return res.status(401).json({ error: auth.error });

  res.setHeader('Cache-Control', 'no-store');

  if (req.query.asset === 'logic') {
    const code = readFileSync(join(process.cwd(), 'lib', 'admin-dashboard-logic.txt'), 'utf8');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    return res.status(200).send(code);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(SHELL_HTML);
}
