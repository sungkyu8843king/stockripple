/**
 * admin.js — 4개 admin 도구 통합
 *  POST /api/admin?action=verify       → 인증 확인 (admin-verify)
 *  POST /api/admin?action=fix-names    → 회사명 일괄 보정 (fix-company-names)
 *  GET  /api/admin?action=stats        → 통계 + 백테스트
 *  GET  /api/admin?action=summary&ticker=X → 회사 AI 종합 분석 (인증 불필요)
 *  POST /api/admin?action=extract-investments → 최근 분석된 이슈에서 전략 투자 패턴 추출 (cron 또는 admin)
 *  GET  /api/admin?action=list-investments    → 전략투자 목록 조회 (필터/페이지)
 *  POST /api/admin?action=update-investment   → 항목 수정 (highlight/status)
 *  POST /api/admin?action=delete-investment   → 항목 삭제 (status=rejected 소프트 삭제)
 *  GET  /api/admin?action=investment-events   → 티커별 추출 이벤트 히스토리 (그래프용)
 *  GET  /api/admin?action=theme-map           → 티커별 미래 먹거리 테마 맵 (메인 피드 배점용, 인증 불필요)
 *  POST /api/admin?action=dart-poll           → DART 5%+ 지분공시 폴링 (한국 OpenDart API)
 *  POST /api/admin?action=sec-13f-poll        → SEC EDGAR 13F 폴링 (미국 헤지펀드 보유)
 *  POST /api/admin?action=dart-sync-corp-codes → DART corpCode.xml.zip 다운로드 & companies 매핑 (느릴 수 있음)
 *  POST /api/admin?action=dart-upload-corp-codes → CSV 수동 업로드 (Vercel→한국 네트워크 느릴 때 fallback)
 *  POST /api/admin?action=verify-kr-names → DART corp_code 기반 KR 종목명 검증 + 자동 수정
 *  GET  /api/admin?action=dart-company-detail&ticker=005930.KS → DART 상세 (주주/임원/재무)
 *  GET  /api/admin?action=ai-market-summary[&history=N] → AI 시장 종합 최신/과거 목록 (공개)
 *  GET  /api/admin?action=daily-report&market=KR|US[&date=|&history=N] → 데일리 리포트 조회 (공개)
 *  POST /api/admin?action=daily-report {market} → 데일리 리포트 생성 (장 마감 후 cron)
 *  POST /api/admin?action=track {event:'enter'|'leave', ...} → 방문자 애널리틱스 수집 (공개)
 *  GET  /api/admin?action=analytics&type=daily|hourly|referrers|paths|dwell|live[&days=N] → 방문자 통계 조회
 *  GET  /api/admin?action=feature-flags       → Claude 토큰 사용 기능 on/off 상태 조회
 *  POST /api/admin?action=feature-flags {key?, keys?, enabled} → 개별/일괄 on/off (key·keys 생략 시 전체)
 */
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { verifyAdmin, verifyUser } from '../lib/auth.js';
import { FEATURE_FLAG_DEFS, isFeatureEnabled } from '../lib/feature-flags.js';
import { submitAgentJob, extractJobText, parseJobJson, JOB_STUCK_TIMEOUT_MS } from '../lib/agent-jobs.js';

// 일부 액션(dart-sync, sec-13f, extract-investments)은 무거우므로 최대 60초 허용
export const config = { maxDuration: 60 };

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = (req.query?.action || '').toString();

  // summary 는 인증 불필요 (공개 정보)
  if (action === 'summary') {
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return handleSummary(req, res);
  }
  // investment-events 는 공개 조회 가능 (회사 페이지에서 사용)
  if (action === 'investment-events') return handleInvestmentEvents(req, res);
  // dart-company-detail 도 공개 (캐시된 데이터 조회)
  if (action === 'dart-company-detail') return handleDartCompanyDetail(req, res);
  // theme-map 도 공개 (메인 피드 "지금 매수 후보" 미래 먹거리 배점용)
  if (action === 'theme-map') return handleThemeMap(req, res);
  // options-chain / sec-filings 도 공개 (회사 페이지에서 인증 헤더 없이 호출)
  if (action === 'options-chain') return handleOptionsChain(req, res);
  if (action === 'sec-filings')   return handleSecFilings(req, res);
  // ai-market-summary는 GET(조회)은 공개, POST(생성/갱신)만 admin 인증 필요
  if (action === 'ai-market-summary' && req.method === 'GET') return handleAiMarketSummaryGet(req, res);
  // daily-report도 GET(조회)은 공개, POST(생성)만 admin 인증 필요
  if (action === 'daily-report' && req.method === 'GET') return handleDailyReportGet(req, res);
  // weekly-schedule도 GET(조회)은 공개, POST(생성)만 admin 인증 필요
  if (action === 'weekly-schedule' && req.method === 'GET') return handleWeeklyScheduleGet(req, res);
  // sector-map: 섹터 파급 지도 (공개, 계산 결과 CDN 캐시)
  if (action === 'sector-map' && req.method === 'GET') return handleSectorMapGet(req, res);
  // catalysts: 예정 catalyst 레지스트리 GET(조회)은 공개, POST(생성/추출)만 admin
  if (action === 'catalysts' && req.method === 'GET') return handleCatalystsGet(req, res);
  // live-refresh: 장중 브라우저 구동 수집 트리거 (공개·장중게이트·레이트리밋, 내부는 ADMIN_SECRET로 수집 호출)
  if (action === 'live-refresh') return handleLiveRefresh(req, res);
  // delete-own-account: 관리자 권한이 아니라 "본인 로그인 여부"만 확인하는 셀프서비스 액션
  if (action === 'delete-own-account') return handleDeleteOwnAccount(req, res);
  // announcement 조회는 공개 (사이트 전체 상단 배너가 매 페이지에서 호출)
  if (action === 'announcement' && req.method === 'GET') return handleGetAnnouncement(req, res);
  // track: 방문자 애널리틱스 수집 — 모든 방문자가 매 페이지에서 호출하므로 공개.
  // 실패해도 방문 경험에 영향 없도록 내부에서 항상 200을 반환한다.
  if (action === 'track') return handleTrack(req, res);

  // 나머지는 admin 인증 필요
  const _a = await verifyAdmin(req.headers.authorization);
  if (!_a.ok) return res.status(401).json({ error: _a.error });

  if (action === 'verify')              return res.status(200).json({ ok: true, mode: _a.mode, email: _a.email });
  if (action === 'fix-names')           return handleFixNames(req, res);
  if (action === 'stats')               return handleStats(req, res);
  if (action === 'extract-investments') return handleExtractInvestments(req, res);
  if (action === 'company-summary-backfill') return handleCompanySummaryBackfill(req, res);
  if (action === 'list-investments')    return handleListInvestments(req, res);
  if (action === 'update-investment')   return handleUpdateInvestment(req, res);
  if (action === 'delete-investment')   return handleDeleteInvestment(req, res);
  if (action === 'dart-poll')           return handleDartPoll(req, res);
  if (action === 'sec-13f-poll')        return handleSec13fPoll(req, res);
  if (action === 'dart-sync-corp-codes') return handleDartSyncCorpCodes(req, res);
  if (action === 'dart-upload-corp-codes') return handleDartUploadCorpCodes(req, res);
  if (action === 'verify-kr-names') return handleVerifyKrNames(req, res);
  if (action === 'fix-kr-broken-names') return handleFixKrBrokenNames(req, res);
  if (action === 'ai-market-summary') return handleAiMarketSummaryPost(req, res);
  if (action === 'daily-report') return handleDailyReportPost(req, res);
  if (action === 'weekly-schedule') return handleWeeklySchedulePost(req, res);
  if (action === 'catalysts') return handleCatalystsPost(req, res);
  if (action === 'check-accuracy') return handleCheckAccuracy(req, res);
  if (action === 'view-stats') return handleViewStats(req, res);
  if (action === 'analytics') return handleAnalytics(req, res);
  if (action === 'set-announcement') return handleSetAnnouncement(req, res);
  if (action === 'announcement-log') return handleAnnouncementLog(req, res);
  if (action === 'list-users') return handleListUsers(req, res);
  if (action === 'ban-user') return handleBanUser(req, res);
  if (action === 'feature-flags') {
    return req.method === 'GET' ? handleFeatureFlagsGet(req, res) : handleFeatureFlagsPost(req, res);
  }
  if (action === 'agent-poll') return handleAgentPoll(req, res);

  return res.status(400).json({ error: 'Unknown action' });
}

// ════════════════════════════════════════════════════════════
// 예측 적중률 채점 (구 api/check-accuracy.js — 함수 개수 12개 제한으로 통합)
// ════════════════════════════════════════════════════════════
const ACCURACY_PERIODS = [
  // grace: 채점 유효 기간. 예: 1일 정확도는 진입 후 1~4일 사이에만 채점
  // (그 이후에 현재가로 재면 '1일' 수익률이 아니라 엉뚱한 기간을 재는 것 → 통계 오염)
  { key: '1d',  days: 1,  minActual: 0.3, grace: 3  },
  { key: '3d',  days: 3,  minActual: 0.5, grace: 3  },
  { key: '7d',  days: 7,  minActual: 1.5, grace: 5  },
  { key: '30d', days: 30, minActual: 3.0, grace: 10 },
];

async function handleCheckAccuracy(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const now = new Date();
  const results = { checked_1d: 0, checked_3d: 0, checked_7d: 0, checked_30d: 0, errors: [] };

  // 시간 예산: maxDuration 60s 내에서 안전하게 종료 (초과분은 다음 실행이 이어서 처리)
  const t0 = Date.now();
  const TIME_BUDGET_MS = 48000;

  for (const { key, days, minActual, grace } of ACCURACY_PERIODS) {
    if (Date.now() - t0 > TIME_BUDGET_MS) { results.errors.push('시간 예산 초과 — 다음 실행에서 계속'); break; }
    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

    // 채점 시기를 놓친 행(진입 후 days+grace 초과)은 일괄 만료 처리 —
    // check_date만 찍고 is_accurate는 null 유지 → 큐에서 빠지되 통계에는 미포함
    const staleCutoff = new Date(now - (days + grace) * 24 * 60 * 60 * 1000).toISOString();
    try {
      const { count: expired } = await supabase
        .from('analysis_companies')
        .update({ [`check_date_${key}`]: now.toISOString() }, { count: 'exact' })
        .not('entry_price', 'is', null)
        .is(`check_date_${key}`, null)
        .lte('entry_date', staleCutoff);
      if (expired) results[`expired_${key}`] = expired;
    } catch {}

    const { data: due, error } = await supabase
      .from('analysis_companies')
      .select('id, entry_price, upside_pct, entry_date, companies(ticker)')
      .not('entry_price', 'is', null)
      .is(`check_date_${key}`, null)
      .lte('entry_date', cutoff)
      .order('entry_date', { ascending: false })   // 최신 우선 — 제때(유효 기간 내) 채점
      .limit(60);

    if (error) { results.errors.push(`${key} query: ${error.message}`); continue; }

    for (const row of due || []) {
      if (Date.now() - t0 > TIME_BUDGET_MS) break;
      try {
        const price = await fetchAccuracyCheckPrice(row.companies?.ticker);
        if (!price) continue;

        const actualReturn = Math.round(((price - row.entry_price) / row.entry_price) * 10000) / 100;
        // 변동 0% = 그 사이 거래일이 없었을 가능성 (주말/휴장) → 채점 보류하고 다음 실행에서 재시도
        // (진짜 보합 마감도 드물게 있지만, 거래 없는 기간을 '빗나감'으로 채점하는 왜곡이 훨씬 큼)
        if (actualReturn === 0) continue;
        // 적중 기준: ① 방향 일치 + ② 최소 실제 수익률 달성 (노이즈 제거)
        // 예) 예측 +22%이면 방향(상승) + 실제 0.3%↑ 이상이어야 적중
        const directionOk = row.upside_pct > 0 ? actualReturn > 0 : actualReturn < 0;
        const magnitudeOk = Math.abs(actualReturn) >= minActual;
        const isAccurate = directionOk && magnitudeOk;

        await supabase.from('analysis_companies').update({
          [`check_price_${key}`]:   price,
          [`check_date_${key}`]:    now.toISOString(),
          [`actual_return_${key}`]: actualReturn,
          [`is_accurate_${key}`]:   isAccurate,
        }).eq('id', row.id);

        results[`checked_${key}`]++;
        await accuracySleep(150);
      } catch (err) {
        results.errors.push(`${key} ${row.companies?.ticker}: ${err.message}`);
      }
    }
  }

  return res.status(200).json(results);
}

async function fetchAccuracyCheckPrice(ticker) {
  if (!ticker) return null;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const data = await r.json();
    const meta = data.chart?.result?.[0]?.meta;
    return meta?.regularMarketPrice || meta?.previousClose || null;
  } catch {
    return null;
  }
}

const accuracySleep = ms => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════
// 방문자 애널리틱스 — 수집(track) + 조회(analytics)
// 클라이언트는 page_views 테이블에 절대 직접 접근하지 않고 이 두 액션만 거친다.
// ════════════════════════════════════════════════════════════
async function handleTrack(req, res) {
  // 실패해도 방문 경험엔 영향 없도록 파싱 오류까지 전부 200으로 삼킨다.
  try {
    if (req.method !== 'POST') return res.status(200).json({ ok: false });
    const body = req.body || {};
    const { event, view_id, session_id, path, referrer, utm_source, utm_medium, utm_campaign, dwell_ms } = body;

    if (event === 'enter') {
      if (!view_id || !session_id || !path) return res.status(200).json({ ok: false });
      let referrer_host = null;
      if (referrer) {
        try { referrer_host = new URL(referrer).hostname.replace(/^www\./, '').slice(0, 100); } catch {}
      }
      await supabase.from('page_views').insert({
        view_id: String(view_id).slice(0, 100),
        session_id: String(session_id).slice(0, 100),
        path: String(path).slice(0, 300),
        referrer: referrer ? String(referrer).slice(0, 500) : null,
        referrer_host,
        utm_source: utm_source ? String(utm_source).slice(0, 100) : null,
        utm_medium: utm_medium ? String(utm_medium).slice(0, 100) : null,
        utm_campaign: utm_campaign ? String(utm_campaign).slice(0, 100) : null,
      });
    } else if (event === 'leave') {
      if (!view_id || dwell_ms == null) return res.status(200).json({ ok: false });
      const clamped = Math.max(0, Math.min(Number(dwell_ms) || 0, 3 * 3600 * 1000)); // 최대 3시간으로 클램프(비정상값 방지)
      await supabase.from('page_views').update({ dwell_ms: clamped }).eq('view_id', String(view_id).slice(0, 100));
    }
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(200).json({ ok: false });
  }
}

async function handleAnalytics(req, res) {
  const type = (req.query.type || 'daily').toString();
  const days = Math.min(Math.max(parseInt(req.query.days) || 14, 1), 90);
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
  const ROW_CAP = 20000; // 개인/소규모 트래픽 기준 — 그 이상이면 DB 집계 함수로 전환 필요

  try {
    if (type === 'live') {
      // 최근 5분 내 활동한 세션 = 실시간 접속자, 페이지별로도 묶어서 보여줌
      const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
      const { data, error } = await supabase.from('page_views').select('session_id, path').gte('created_at', fiveMinAgo);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      const sessions = new Set();
      const byPage = {};
      for (const row of data || []) {
        sessions.add(row.session_id);
        byPage[row.path] = (byPage[row.path] || 0) + 1;
      }
      const pages = Object.entries(byPage).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([path, count]) => ({ path, count }));
      return res.status(200).json({ ok: true, visitors: sessions.size, pages });
    }

    if (type === 'daily') {
      const { data, error } = await supabase.from('page_views').select('created_at, session_id')
        .gte('created_at', sinceIso).limit(ROW_CAP);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      const byDay = {};
      for (const row of data || []) {
        // created_at은 UTC로 저장됨 — 그냥 slice(0,10)하면 UTC 캘린더 날짜라 KST 00~09시
        // 트래픽이 전날로 잘못 잡힌다(아래 hourly와 동일하게 +9h 보정 후 날짜를 뽑아야 함).
        const kst = new Date(new Date(row.created_at).getTime() + 9 * 3600000);
        const day = kst.toISOString().slice(0, 10);
        (byDay[day] ??= new Set()).add(row.session_id);
      }
      const items = Object.entries(byDay)
        .map(([day, set]) => ({ day, visitors: set.size }))
        .sort((a, b) => a.day.localeCompare(b.day));
      return res.status(200).json({ ok: true, items, capped: (data || []).length >= ROW_CAP });
    }

    if (type === 'hourly') {
      // 최근 N일 통합 — 몇 시대에 방문이 몰리는지 (KST 기준)
      const { data, error } = await supabase.from('page_views').select('created_at, session_id')
        .gte('created_at', sinceIso).limit(ROW_CAP);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      const byHour = {};
      for (const row of data || []) {
        const kst = new Date(new Date(row.created_at).getTime() + 9 * 3600000);
        const h = kst.getUTCHours();
        (byHour[h] ??= new Set()).add(row.session_id);
      }
      const items = Array.from({ length: 24 }, (_, h) => ({ hour: h, visitors: byHour[h]?.size || 0 }));
      return res.status(200).json({ ok: true, items, capped: (data || []).length >= ROW_CAP });
    }

    if (type === 'referrers') {
      const { data, error } = await supabase.from('page_views').select('referrer_host, utm_source, session_id')
        .gte('created_at', sinceIso).limit(ROW_CAP);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      const groups = {};
      for (const row of data || []) {
        const key = row.utm_source ? `📣 ${row.utm_source}` : (row.referrer_host || '직접 방문/북마크');
        (groups[key] ??= new Set()).add(row.session_id);
      }
      const items = Object.entries(groups)
        .map(([source, set]) => ({ source, visitors: set.size }))
        .sort((a, b) => b.visitors - a.visitors)
        .slice(0, 20);
      return res.status(200).json({ ok: true, items, capped: (data || []).length >= ROW_CAP });
    }

    if (type === 'dwell') {
      const { data, error } = await supabase.from('page_views').select('path, dwell_ms')
        .gte('created_at', sinceIso).not('dwell_ms', 'is', null).limit(ROW_CAP);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      const byPath = {};
      for (const row of data || []) {
        (byPath[row.path] ??= []).push(row.dwell_ms);
      }
      const items = Object.entries(byPath)
        .map(([path, arr]) => ({
          path, samples: arr.length,
          avgMs: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
        }))
        .sort((a, b) => b.samples - a.samples)
        .slice(0, 30);
      return res.status(200).json({ ok: true, items });
    }

    if (type === 'paths') {
      // 최근 세션들의 페이지 이동 순서 (샘플 — 세션당 최대 20페이지)
      const { data, error } = await supabase.from('page_views').select('session_id, path, created_at')
        .gte('created_at', sinceIso).order('created_at', { ascending: true }).limit(ROW_CAP);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      const bySession = {};
      for (const row of data || []) {
        (bySession[row.session_id] ??= []).push({ path: row.path, at: row.created_at });
      }
      const items = Object.entries(bySession)
        .map(([session_id, seq]) => ({
          session_id,
          start: seq[0]?.at,
          steps: seq.slice(0, 20).map(s => s.path),
        }))
        .sort((a, b) => new Date(b.start) - new Date(a.start))
        .slice(0, 50);
      return res.status(200).json({ ok: true, items });
    }

    return res.status(400).json({ ok: false, error: 'unknown type' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ════════════════════════════════════════════════════════════
// 종목 조회수 통계 (어드민 대시보드 — 어떤 종목이 많이 보이는지)
// ════════════════════════════════════════════════════════════
async function handleViewStats(req, res) {
  const period = (req.query.period || '7d').toString();
  const today = new Date();
  let sinceDate = null;
  if (period === 'today')     sinceDate = today.toISOString().slice(0, 10);
  else if (period === '7d')   sinceDate = new Date(today - 7  * 86400000).toISOString().slice(0, 10);
  else if (period === '30d')  sinceDate = new Date(today - 30 * 86400000).toISOString().slice(0, 10);
  // period === 'all' → 필터 없음

  let q = supabase.from('company_views').select('ticker, views');
  if (sinceDate) q = q.gte('view_date', sinceDate);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const totals = {};
  for (const row of data || []) totals[row.ticker] = (totals[row.ticker] || 0) + row.views;

  const tickers = Object.keys(totals);
  const { data: companies } = tickers.length
    ? await supabase.from('companies').select('ticker, name_ko, name_en, market').in('ticker', tickers)
    : { data: [] };
  const nameMap = Object.fromEntries((companies || []).map(c => [c.ticker, c]));

  const items = tickers
    .map(t => ({
      ticker: t,
      views: totals[t],
      name_ko: nameMap[t]?.name_ko || null,
      name_en: nameMap[t]?.name_en || null,
      market: nameMap[t]?.market || null,
    }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 50);

  return res.status(200).json({
    ok: true,
    period,
    items,
    total_views: Object.values(totals).reduce((s, v) => s + v, 0),
    total_tickers: tickers.length,
  });
}

// ════════════════════════════════════════════════════════════
// 회원 관리 — 목록 조회 / 차단(밴) / 본인 탈퇴
// ════════════════════════════════════════════════════════════

// 본인 계정 탈퇴 — admin 권한이 아니라 "유효한 로그인" 여부만 확인.
// user_watchlist/user_bookmarks/user_settings/paper_portfolios 등은 전부
// auth.users(id)에 ON DELETE CASCADE로 걸려있어 별도 정리 없이 자동 삭제된다.
async function handleDeleteOwnAccount(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await verifyUser(req.headers.authorization);
  if (!auth.ok) return res.status(401).json({ error: auth.error });

  const { error } = await supabase.auth.admin.deleteUser(auth.user.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

// 회원 목록 (최근 가입순) — Supabase Auth 사용자를 페이지 단위로 모아 최대 1000명까지 반환
async function handleListUsers(req, res) {
  const users = [];
  let page = 1;
  const perPage = 200;
  while (users.length < 1000) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) return res.status(500).json({ error: error.message });
    users.push(...(data?.users || []));
    if (!data?.users?.length || data.users.length < perPage) break;
    page++;
  }

  const items = users
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(u => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      provider: u.app_metadata?.provider || 'email',
      banned: !!u.banned_until && new Date(u.banned_until) > new Date(),
    }));

  return res.status(200).json({ ok: true, items, total: items.length });
}

// 회원 차단/해제 — Supabase Auth 내장 ban_duration으로 로그인 자체를 막는다
// (별도 블랙리스트 테이블 없이 Auth 레벨에서 강제).
async function handleBanUser(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const userId = (req.body?.user_id || '').toString();
  const ban = !!req.body?.ban;
  if (!userId) return res.status(400).json({ error: 'user_id required' });

  const { error } = await supabase.auth.admin.updateUserById(userId, {
    ban_duration: ban ? '87600h' : 'none',
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, user_id: userId, banned: ban });
}

// ════════════════════════════════════════════════════════════
// 긴급 안내 배너 — 사이트 전체 페이지 상단에 노출 (관리자 on/off + 문구 편집)
// ════════════════════════════════════════════════════════════
async function handleGetAnnouncement(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // 긴급 안내라는 목적상 즉시 반영돼야 함 — 캐시 없음 (조회 1건짜리 가벼운 쿼리라 비용 부담 없음)
  res.setHeader('Cache-Control', 'no-store');
  const { data, error } = await supabase
    .from('site_announcement')
    .select('active, message, updated_at, source, auto_expires_at')
    .eq('id', 1)
    .maybeSingle();
  if (error || !data) return res.status(200).json({ active: false, message: '' });

  // 자동 배너 lazy 만료 — 매 페이지 로드가 이 조회를 하므로 별도 cron 없이 self-heal.
  // 서킷/사이드카가 끝나면(=TTL 경과) 자동으로 배너가 꺼지고 이력에 종료 시각이 기록된다.
  if (data.active && data.source === 'auto' && data.auto_expires_at && new Date(data.auto_expires_at) < new Date()) {
    const now = new Date().toISOString();
    await supabase.from('site_announcement').update({ active: false, updated_at: now }).eq('id', 1);
    await supabase.from('announcement_log').update({ ended_at: now }).is('ended_at', null);
    return res.status(200).json({ active: false, message: '', source: 'auto' });
  }
  // 수동으로 끈 직후라 auto_expires_at이 "뮤트 마감시각"으로 쓰이는 중이면 관리자 화면에 노출
  const muteUntil = (!data.active && data.source === 'manual' && data.auto_expires_at && new Date(data.auto_expires_at) > new Date())
    ? data.auto_expires_at : null;
  return res.status(200).json({ active: !!data.active, message: data.message || '', updated_at: data.updated_at, source: data.source || 'manual', mute_until: muteUntil });
}

async function handleSetAnnouncement(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const active = !!req.body?.active;
  const message = (req.body?.message || '').toString().slice(0, 500);
  const now = new Date().toISOString();

  const { data: prev } = await supabase.from('site_announcement').select('active').eq('id', 1).maybeSingle();
  const wasActive = !!prev?.active;

  // 관리자가 대시보드에서 직접 저장하면 항상 'manual'로 표시 — 이후 자동 트리거
  // 로직(analyze.js/checkFuturesSidecar)이 이 배너를 절대 덮어쓰지 않도록 하는 표식.
  // active:false로 끄는 경우도 마찬가지다 — 예전엔 이 케이스를 안 지켜줘서, 관리자가 끄자마자
  // 다음 라이브 리프레시(최소 90초 간격)에서 사이드카 조건이 여전히 참이면 바로 다시 켜지는
  // 버그가 있었다(2026-07-15 실측). active:false일 땐 auto_expires_at을 "이 시각까지는 자동이
  // 재점화하지 않는다"는 뮤트 마감시각으로 재사용한다(2시간 — 위 auto 배너 TTL과 동일 길이).
  const muteUntil = active ? null : new Date(Date.now() + 2 * 3600000).toISOString();
  const { error } = await supabase.from('site_announcement').upsert({
    id: 1, active, message, source: 'manual', source_issue_id: null, auto_expires_at: muteUntil, updated_at: now,
  });
  if (error) return res.status(500).json({ error: error.message });

  // 이력 기록: 새로 켜지면 새 이력 시작, 꺼지면 열려있던 이력 종료
  if (active && !wasActive) {
    await supabase.from('announcement_log').update({ ended_at: now }).is('ended_at', null);
    await supabase.from('announcement_log').insert({ source: 'manual', message, started_at: now });
  } else if (!active && wasActive) {
    await supabase.from('announcement_log').update({ ended_at: now }).is('ended_at', null);
  }

  return res.status(200).json({ ok: true, active, message });
}

async function handleAnnouncementLog(req, res) {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const { data, error } = await supabase
    .from('announcement_log')
    .select('source, message, started_at, ended_at')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, items: data || [] });
}

// ════════════════════════════════════════════════════════════
// 1) 회사 AI 종합 분석 (공개)
// ════════════════════════════════════════════════════════════
// 실시간 시세 스냅샷 — AI가 학습시점 기억(분사/재상장/인수 이전 상태)으로
// 상장 여부를 잘못 서술하는 것을 막는 사실 근거 (예: SNDK 2025-02 WDC에서 분사 재상장)
async function fetchLiveSnapshot(ticker) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1y`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const result = (await r.json())?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta?.regularMarketPrice) return null;
    const closes = (result?.indicators?.quote?.[0]?.close || []).filter(v => v != null);
    const price = meta.regularMarketPrice;
    const prev  = closes.length >= 2 ? closes[closes.length - 2] : null;
    const first = closes.length ? closes[0] : null;
    return {
      name: meta.longName || meta.shortName || null,
      exchange: meta.fullExchangeName || meta.exchangeName || null,
      price,
      currency: meta.currency || 'USD',
      dayChangePct: prev ? Math.round((price - prev) / prev * 10000) / 100 : null,
      w52Low: meta.fiftyTwoWeekLow ?? null,
      w52High: meta.fiftyTwoWeekHigh ?? null,
      perf1yPct: first ? Math.round((price - first) / first * 1000) / 10 : null,
      firstTradeDate: meta.firstTradeDate ? new Date(meta.firstTradeDate * 1000).toISOString().slice(0, 10) : null,
      asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10) : null,
    };
  } catch { return null; }
}

async function handleSummary(req, res) {
  const ticker = (req.query?.ticker || '').toString().trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  // 조회수 집계 (어드민 통계용) — 캐시 히트/미스와 무관하게 순수 방문 트래픽을 센다.
  // 실패해도 본 응답에 영향 없도록 fire-and-forget.
  supabase.rpc('increment_company_view', { p_ticker: ticker }).then(() => {}, () => {});

  // catch 블록에서도 참조해야 해서(토큰 소진 등으로 Claude 호출이 실패해도 DB
  // 캐시로 폴백하기 위함) try 블록 바깥에 선언 — const로 try 안에서만 선언하면
  // catch에서 접근할 수 없다.
  let company, live, cached;

  try {
    ({ data: company } = await supabase
      .from('companies')
      .select('id, ticker, name_ko, name_en, market, sector')
      .eq('ticker', ticker)
      .single());
    if (!company) return res.status(404).json({ error: 'company not found' });

    live = await fetchLiveSnapshot(ticker);

    // 티커당 3일에 1회만 Claude 재생성 — 그 안에는 DB 캐시로 서빙 (방문자 트래픽에
    // 비례해 API 비용이 느는 걸 방지). live(실시간 시세)는 캐시와 무관하게 항상 새로 받는다.
    // .single() 대신 배열+최신순 정렬 후 첫 건 사용 — 간헐적으로 .single()이 정상
    // 상황에서도 coerce 에러를 내는 걸 우회 (PostgREST/supabase-js 쪽 이슈로 추정).
    const { data: cachedRows } = await supabase
      .from('company_ai_summary')
      .select('*')
      .eq('ticker', ticker)
      .order('created_at', { ascending: false })
      .limit(1);
    cached = cachedRows?.[0] || null;
    const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
    if (cached && Date.now() - new Date(cached.created_at).getTime() < CACHE_TTL_MS) {
      return res.status(200).json({
        ok: true,
        ticker,
        company: { name_ko: company.name_ko, name_en: company.name_en, market: company.market, sector: company.sector },
        live,
        overview: cached.overview,
        thesis: cached.thesis,
        strategic_exposure: cached.strategic_exposure,
        key_risks: cached.key_risks,
        competitive_position: cached.competitive_position,
        watch_points: cached.watch_points,
        analyses_count: cached.analyses_count,
        cached: true,
        generated_at: cached.created_at,
      });
    }

    // 기능 자체가 꺼져 있으면(어드민 일괄 on/off) budget 체크와 동일하게 취급 —
    // 새로 생성하지 않고 캐시가 있으면 stale로 그거라도 보여준다.
    const featureOff = !(await isFeatureEnabled(supabase, 'company_summary'));

    // 하루 전체 Claude 호출 상한 — 캐시가 어떤 이유로든 안 먹어도 비용이 무한정
    // 늘어나지 않도록 하는 이중 안전장치. RPC 실패(마이그레이션 전 등)는 안전하게
    // 통과시킨다 — 이 안전장치가 아직 없다고 기능 자체를 막지는 않음.
    const DAILY_CLAUDE_CALL_LIMIT = 150;
    try {
      const budgetExceeded = !featureOff && await (async () => {
        const { data: budgetCount } = await supabase.rpc('increment_ai_budget', {
          p_day: new Date().toISOString().slice(0, 10),
        });
        return (budgetCount ?? 0) > DAILY_CLAUDE_CALL_LIMIT;
      })();
      if (featureOff || budgetExceeded) {
        // 새로 생성은 못 하지만, DB에 예전 분석이 남아있으면 그거라도 보여준다
        // (완전히 안 나오는 것보다 낫다) — stale로 표시해 하단에 마지막 업데이트 시각 노출.
        if (cached) {
          return res.status(200).json({
            ok: true,
            ticker,
            company: { name_ko: company.name_ko, name_en: company.name_en, market: company.market, sector: company.sector },
            live,
            overview: cached.overview,
            thesis: cached.thesis,
            strategic_exposure: cached.strategic_exposure,
            key_risks: cached.key_risks,
            competitive_position: cached.competitive_position,
            watch_points: cached.watch_points,
            analyses_count: cached.analyses_count,
            cached: true,
            stale: true,
            generated_at: cached.created_at,
          });
        }
        return res.status(200).json({
          ok: false,
          ticker,
          company: { name_ko: company.name_ko, name_en: company.name_en, market: company.market, sector: company.sector },
          live,
          error: featureOff
            ? 'AI 분석 기능이 일시 중지되었습니다.'
            : '오늘 AI 분석 요청량이 많아 잠시 제한 중입니다. 내일 다시 시도해주세요.',
          feature_disabled: featureOff,
          budget_exceeded: budgetExceeded,
        });
      }
    } catch {}

    const { data: recent } = await supabase
      .from('analysis_companies')
      .select('upside_pct, confidence, rationale, entry_date, ripple_sector, analyses(ai_summary, issues(title, published_at))')
      .eq('company_id', company.id)
      .order('entry_date', { ascending: false })
      .limit(8);

    const analyses = (recent || []).map(r => ({
      sector: r.ripple_sector,
      upside: r.upside_pct,
      confidence: r.confidence,
      rationale: (r.rationale || '').split('[TRADE]')[0].trim(),
      issueTitle: r.analyses?.issues?.title || '',
      date: r.entry_date,
    }));

    // 전략적 투자/지분 컨텍스트 주입 (하드코딩 큐레이션 + AI 자동누적 DB 병합)
    let strategicCtx = null;
    try {
      const mod = await import('../lib/strategic-investments.js');
      strategicCtx = await mod.formatMergedBetsForPrompt(supabase, ticker);
    } catch {}

    // 방문 시점에 즉답할 수 없으므로(에이전트가 나중에 처리) 큐에 적재만 하고, 지금은
    // 있는 캐시(stale이라도)나 "아직 없음" 상태를 바로 내려준다. 다음 방문(3일 캐시 TTL
    // 지난 뒤) 즈음엔 스케줄 에이전트가 채워둔 새 캐시가 서빙된다.
    await submitCompanySummaryJob({ ticker, company, live, analyses, strategicCtx });

    if (cached) {
      return res.status(200).json({
        ok: true,
        ticker,
        company: { name_ko: company.name_ko, name_en: company.name_en, market: company.market, sector: company.sector },
        live,
        overview: cached.overview,
        thesis: cached.thesis,
        strategic_exposure: cached.strategic_exposure,
        key_risks: cached.key_risks,
        competitive_position: cached.competitive_position,
        watch_points: cached.watch_points,
        analyses_count: cached.analyses_count,
        cached: true,
        stale: true,
        generated_at: cached.created_at,
      });
    }
    return res.status(200).json({
      ok: false,
      ticker,
      company: { name_ko: company.name_ko, name_en: company.name_en, market: company.market, sector: company.sector },
      live,
      error: '분석 준비 중입니다. 잠시 후 다시 확인해주세요.',
      pending: true,
    });
  } catch (e) {
    // DB 조회 등 그 외 실패 시 완전히 빈 화면 대신 마지막 분석을 그대로 보여준다.
    if (cached) {
      return res.status(200).json({
        ok: true,
        ticker,
        company: company ? { name_ko: company.name_ko, name_en: company.name_en, market: company.market, sector: company.sector } : null,
        live: live ?? null,
        overview: cached.overview,
        thesis: cached.thesis,
        strategic_exposure: cached.strategic_exposure,
        key_risks: cached.key_risks,
        competitive_position: cached.competitive_position,
        watch_points: cached.watch_points,
        analyses_count: cached.analyses_count,
        cached: true,
        stale: true,
        generated_at: cached.created_at,
      });
    }
    return res.status(500).json({ error: e.message });
  }
}

// handleSummary(방문 시)와 handleCompanySummaryBackfill(주기적 사전 생성) 공용 —
// 프롬프트 조립 + agent_jobs 제출까지. 호출부는 company/live/analyses/strategicCtx를
// 미리 구해서 넘긴다(백필은 fetchLiveSnapshot 등을 여러 티커에 걸쳐 반복 호출해야 하므로
// 여기서 다시 fetch하지 않고 얇게 유지).
async function submitCompanySummaryJob({ ticker, company, live, analyses, strategicCtx }) {
  const liveCtx = live ? `📡 실시간 시장 데이터 (Yahoo Finance, ${live.asOf || '오늘'} 기준 — 사실 판단의 최우선 근거):
- 종목명: ${live.name || ticker} — ${live.exchange || '?'} 에서 현재 정상 거래 중인 상장 종목
- 현재가: ${live.price} ${live.currency}${live.dayChangePct != null ? ` (전일 대비 ${live.dayChangePct >= 0 ? '+' : ''}${live.dayChangePct}%)` : ''}
- 52주 범위: ${live.w52Low ?? '?'} ~ ${live.w52High ?? '?'}
- 최근 1년 수익률: ${live.perf1yPct != null ? `${live.perf1yPct >= 0 ? '+' : ''}${live.perf1yPct}%` : '?'}
- 최초 거래일: ${live.firstTradeDate || '?'}${live.firstTradeDate && live.firstTradeDate > '2020-01-01' ? ' ← 최근 신규상장/분사 재상장/재편 가능성. 당신의 학습 지식이 이 티커를 과거 폐지·인수된 종목으로 기억하더라도 현재는 별개의 정상 거래 종목임' : ''}
` : `📡 실시간 시장 데이터: 조회 실패 — 상장/거래 상태를 단정하지 말 것.
`;

  const prompt = `당신은 주식 분석 전문가입니다. 아래 회사에 대해 한국 투자자를 위한 종합 분석 보고서를 작성하세요.

회사 정보:
- 티커: ${ticker}
- 한국명: ${company.name_ko || '없음'}
- 영문명: ${company.name_en || '없음'}
- 시장: ${company.market === 'KR' ? '한국' : '미국'}

${liveCtx}
${strategicCtx ? `🎯 전략적 투자/지분 (본업 외 미래 성장축 — 매우 중요):\n${strategicCtx}\n\n이 정보는 주가 선반영 논리의 핵심 단서입니다. 예: SK텔레콤이 Anthropic에 투자했다면 Claude(AI) 성공 → SKT 주가 선반영. 종합 근거(thesis)와 전략적 노출(strategic_exposure) 작성 시 반드시 반영.\n` : ''}
최근 AI 분석들 (${analyses.length}건):
${analyses.map((a, i) => `${i+1}. [${a.date?.slice(0,10)}] ${a.issueTitle}\n   - 섹터: ${a.sector||'미분류'}, 예상 상승: ${a.upside??'?'}%, 신뢰도: ${a.confidence??'?'}%\n   - 근거: ${a.rationale.slice(0, 200)}`).join('\n')}

다음 JSON만 반환하세요 (다른 텍스트 없이):
{
  "overview": "회사 개요 - 어떤 사업을 하는지, 주력 제품/서비스, 시장 점유율 (2-3문장, 150자 내외)",
  "thesis": "현재 매수 후보로 거론되는 종합 근거 (위 분석들 + 전략적 투자 통합) (2-3문장, 200자 내외)",
  "strategic_exposure": "본업 외 보유한 전략적 지분/투자로 인한 간접 노출 (예: 'Anthropic 지분 보유 → Claude AI 성공이 주가에 선반영 중'). 해당 없으면 빈 문자열. (1-3문장, 250자 내외)",
  "key_risks": ["주요 리스크 1", "주요 리스크 2"],
  "competitive_position": "시장 내 경쟁 우위 또는 약점 — 전략적 투자가 만든 차별화 포지션 포함 (1-2문장)",
  "watch_points": ["주시 포인트 1 — 전략적 지분 가치를 끌어올릴 만한 이벤트 1개 이상 포함", "주시 포인트 2"]
}

규칙:
- 사실 기반, 한국어, 객관적, 추측 금지
- ⚠️ 실시간 시장 데이터가 당신의 학습 지식과 충돌하면 반드시 실시간 데이터가 우선. 지식 컷오프 이후 분사·재상장·합병·구조 변화가 있었을 수 있음
- 실시간 데이터가 존재하는 종목에 '상장폐지', '거래 불가', '인수되어 비활성' 등의 서술 절대 금지
- 확실하지 않은 과거 기업 이력(인수/합병/모회사 관계)은 단정하지 말 것
- 위에 제공된 "전략적 투자/지분" 정보가 있다면 thesis와 strategic_exposure에 반드시 활용 (특히 ⭐ 표시된 항목)
- 전략적 투자 정보가 없으면 strategic_exposure는 빈 문자열 ""로 반환`;

  return submitAgentJob({
    pipeline: 'company_summary',
    stage: ticker,      // 티커별로 in-flight를 분리해 여러 종목이 서로 막지 않게 함
    items: [{ itemId: ticker, static: '', dynamic: prompt }],
    payload: { ticker, analyses_count: analyses.length },
  });
}

// ────────────────────────────────────────────────────────────
// AI 종합분석 사전 백필 — 방문자가 우연히 눌러야만 생성되던 걸, 캐시 없는(또는 3일
// TTL 지난) 종목을 주기적으로 미리 몇 건씩 큐에 채워둔다. 첫 방문자가 빈 화면을
//보는 경우를 줄이는 목적. 스케줄 에이전트가 큐를 드레인하는 것과 별개로, 이 액션
// 자체는 "무엇을 채울지 고르고 프롬프트를 큐에 넣는" 제출 역할만 한다(analyze의
// agent-submit과 동일한 성격).
async function handleCompanySummaryBackfill(req, res) {
  if (!(await isFeatureEnabled(supabase, 'company_summary'))) {
    return res.status(200).json({ ok: true, submitted: 0, disabled: true });
  }
  const limit = Math.min(parseInt(req.body?.limit || req.query?.limit, 10) || 15, 30);

  // 최근 30일 조회수가 있는(방문 트래픽이 있는) 종목 위주로 우선순위를 둔다 —
  // company_views는 티커별·일자별 카운터라 여기서 합산한다 (view-stats 액션과 동일 패턴).
  // 아무도 안 보는 종목까지 무제한으로 채우면 큐만 늘어나고 실효는 낮다.
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const { data: viewRows, error: viewErr } = await supabase
    .from('company_views').select('ticker, views').gte('view_date', since30);
  if (viewErr) return res.status(500).json({ error: viewErr.message });
  const viewTotals = {};
  for (const row of viewRows || []) viewTotals[row.ticker] = (viewTotals[row.ticker] || 0) + row.views;
  const rankedTickers = Object.keys(viewTotals).sort((a, b) => viewTotals[b] - viewTotals[a]).slice(0, 200);
  if (!rankedTickers.length) return res.status(200).json({ ok: true, submitted: 0, reason: 'no recent view traffic' });

  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, ticker, name_ko, name_en, market, sector')
    .in('ticker', rankedTickers);
  if (error) return res.status(500).json({ error: error.message });
  if (!companies?.length) return res.status(200).json({ ok: true, submitted: 0 });
  companies.sort((a, b) => (viewTotals[b.ticker] || 0) - (viewTotals[a.ticker] || 0));

  const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
  const { data: freshSummaries } = await supabase
    .from('company_ai_summary')
    .select('ticker, created_at')
    .gte('created_at', new Date(Date.now() - CACHE_TTL_MS).toISOString());
  const freshSet = new Set((freshSummaries || []).map(s => s.ticker));

  // 이미 대기/처리 중인 company_summary job도 제외(중복 제출 방지) — stage에 티커가 들어있다.
  const { data: pendingJobs } = await supabase
    .from('agent_jobs')
    .select('stage')
    .eq('pipeline', 'company_summary')
    .in('status', ['submitted', 'processing']);
  const pendingSet = new Set((pendingJobs || []).map(j => j.stage));

  const targets = companies
    .filter(c => c.ticker && !freshSet.has(c.ticker) && !pendingSet.has(c.ticker))
    .slice(0, limit);
  if (!targets.length) return res.status(200).json({ ok: true, submitted: 0, reason: 'no stale/missing targets' });

  let submitted = 0;
  const errors = [];
  for (const company of targets) {
    try {
      const [live, { data: recent }] = await Promise.all([
        fetchLiveSnapshot(company.ticker),
        supabase.from('analysis_companies')
          .select('upside_pct, confidence, rationale, entry_date, ripple_sector, analyses(ai_summary, issues(title, published_at))')
          .eq('company_id', company.id)
          .order('entry_date', { ascending: false })
          .limit(8),
      ]);
      const analyses = (recent || []).map(r => ({
        sector: r.ripple_sector,
        upside: r.upside_pct,
        confidence: r.confidence,
        rationale: (r.rationale || '').split('[TRADE]')[0].trim(),
        issueTitle: r.analyses?.issues?.title || '',
        date: r.entry_date,
      }));
      let strategicCtx = null;
      try {
        const mod = await import('../lib/strategic-investments.js');
        strategicCtx = await mod.formatMergedBetsForPrompt(supabase, company.ticker);
      } catch {}

      const result = await submitCompanySummaryJob({ ticker: company.ticker, company, live, analyses, strategicCtx });
      if (result.submitted) submitted++;
    } catch (e) {
      errors.push({ ticker: company.ticker, error: e.message?.slice(0, 200) });
    }
  }

  return res.status(200).json({ ok: true, submitted, scanned: targets.length, errors });
}

async function finalizeCompanySummary(row) {
  const ticker = row.payload?.ticker;
  const text = extractJobText(row, ticker);
  if (!text) throw new Error('No agent response for company_summary/' + ticker);
  const parsed = parseJobJson(text);
  const dbRow = {
    ticker,
    overview: parsed.overview,
    thesis: parsed.thesis,
    strategic_exposure: parsed.strategic_exposure,
    key_risks: parsed.key_risks,
    competitive_position: parsed.competitive_position,
    watch_points: parsed.watch_points,
    analyses_count: row.payload?.analyses_count || 0,
    created_at: new Date().toISOString(),
  };
  await supabase.from('company_ai_summary').upsert(dbRow, { onConflict: 'ticker' });
  return dbRow;
}

// ════════════════════════════════════════════════════════════
// 2) 회사명 일괄 보정
// ════════════════════════════════════════════════════════════
async function handleFixNames(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const dryRun     = !!req.body?.dry_run;
  const aiVerify   = !!req.body?.ai_verify;
  const batchSize  = Math.min(parseInt(req.body?.batch_size || 12, 10), 20);
  const batchOff   = parseInt(req.body?.batch_offset || 0, 10);
  const startMs    = Date.now();

  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, ticker, name_ko, name_en')
    .order('ticker');
  if (error) return res.status(500).json({ error: error.message });

  const updates = [];
  const errors  = [];

  const targets = aiVerify ? (companies || []).slice(batchOff, batchOff + batchSize) : (companies || []);

  const yhResults = await Promise.all(
    targets.map(c => fetchYahooMeta(c.ticker)
      .then(m => ({ c, officialEn: m?.longName || m?.shortName || null }))
      .catch(e => { errors.push(`${c.ticker} fetch: ${e.message}`); return { c, officialEn: null }; })
    )
  );
  const enriched = yhResults;
  const yhMs = Date.now() - startMs;

  let aiCorrections = {};
  let aiMs = 0;
  if (aiVerify && anthropic) {
    const aiStart = Date.now();
    aiCorrections = await aiVerifyNames(enriched);
    aiMs = Date.now() - aiStart;
  }

  for (const { c, officialEn } of enriched) {
    const update = {};
    if (officialEn && (!c.name_en || c.name_en === c.ticker || c.name_en === c.name_ko)) {
      update.name_en = officialEn;
    }
    const aiCorr = aiCorrections[c.ticker];
    if (aiCorr && aiCorr.is_wrong && aiCorr.correct_name_ko) {
      update.name_ko = aiCorr.correct_name_ko;
    } else if (!c.name_ko || c.name_ko === c.ticker) {
      if (officialEn) update.name_ko = officialEn;
    }
    if (Object.keys(update).length) {
      updates.push({
        id: c.id, ticker: c.ticker,
        before: { en: c.name_en, ko: c.name_ko },
        after: update,
        reason: aiCorr?.is_wrong ? `AI: ${aiCorr.reason || '환각 감지'}` : '공식명 보정',
      });
      if (!dryRun) {
        const { error: upErr } = await supabase.from('companies').update(update).eq('id', c.id);
        if (upErr) errors.push(`${c.ticker}: ${upErr.message}`);
      }
    }
  }

  const totalMs = Date.now() - startMs;
  return res.status(200).json({
    ok: true, dryRun, aiVerify,
    total:   companies?.length || 0,
    scanned: targets.length,
    updated: updates.length,
    updates: updates.slice(0, 50),
    errors,
    timing:  { totalMs, yhMs, aiMs },
    offset:  batchOff,
    nextOffset: aiVerify ? (batchOff + batchSize < (companies?.length || 0) ? batchOff + batchSize : null) : null,
  });
}

async function aiVerifyNames(enriched) {
  const candidates = enriched.filter(e => e.c.name_ko && e.officialEn);
  if (!candidates.length) return {};
  const list = candidates.map(({ c, officialEn }) =>
    `- ${c.ticker}: 현재 한국어명="${c.name_ko}", 공식영문명="${officialEn}"`
  ).join('\n');
  const prompt = `다음 종목들의 한국어 이름이 정확한지 검증하세요.

${list}

각 종목 한국어 이름이 잘못됐는지 (다른 회사 이름, 제품명 오용 등) 판단하고, 잘못된 경우만 JSON 배열로 반환:

[{"ticker":"LRCX","is_wrong":true,"reason":"라이젠은 AMD CPU 제품명","correct_name_ko":"램 리서치"}]

올바른 이름이나 영문명 그대로 쓴 경우는 포함하지 마세요.`;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content[0].text.trim();
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return {};
    const arr = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
    const result = {};
    for (const item of arr) {
      if (item.ticker && item.is_wrong) result[item.ticker] = item;
    }
    return result;
  } catch { return {}; }
}

async function fetchYahooMeta(ticker) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return j?.chart?.result?.[0]?.meta || null;
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════
// 3) 통계 + 백테스트
// ════════════════════════════════════════════════════════════
async function handleStats(req, res) {
  try {
    // PostgREST는 limit을 크게 줘도 1000행에서 자름 → range 페이지네이션으로 전체 로드
    const rows = [];
    for (let page = 0; page < 20; page++) {
      const { data, error } = await supabase
        .from('analysis_companies')
        .select(`
          upside_pct, confidence, ripple_sector, entry_date, entry_price,
          is_accurate_1d, actual_return_1d,
          is_accurate_7d, actual_return_7d,
          is_accurate_30d, actual_return_30d,
          companies(ticker, name_ko, market)
        `)
        .order('created_at', { ascending: false })
        .range(page * 1000, page * 1000 + 999);
      if (error) return res.status(500).json({ error: error.message });
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    if (!rows.length) return res.status(200).json({ ok: true, empty: true });

    const overall = {
      total: rows.length,
      verified1d:  rows.filter(r => r.is_accurate_1d  != null).length,
      verified7d:  rows.filter(r => r.is_accurate_7d  != null).length,
      verified30d: rows.filter(r => r.is_accurate_30d != null).length,
    };
    overall.accuracy1d  = accuracyOf(rows, '1d',  0.3);
    overall.accuracy7d  = accuracyOf(rows, '7d',  1.5);
    overall.accuracy30d = accuracyOf(rows, '30d', 3.0);

    const buckets = [
      { label: '0-40',  min: 0,  max: 40 },
      { label: '40-60', min: 40, max: 60 },
      { label: '60-80', min: 60, max: 80 },
      { label: '80-100', min: 80, max: 101 },
    ];
    const byConfidence = buckets.map(b => {
      const bucket = rows.filter(r => (r.confidence || 0) >= b.min && (r.confidence || 0) < b.max);
      return {
        bucket: b.label, total: bucket.length,
        accuracy7d: accuracyOf(bucket, '7d', 1.5),
        avgActualReturn7d: avgReturn(bucket, '7d'),
        avgUpside: avg(bucket.map(r => r.upside_pct)),
      };
    });

    const sectorMap = {};
    for (const r of rows) {
      const s = r.ripple_sector || '미분류';
      (sectorMap[s] = sectorMap[s] || []).push(r);
    }
    const bySector = Object.entries(sectorMap)
      .filter(([, arr]) => arr.length >= 3)
      .map(([sector, arr]) => ({
        sector, total: arr.length,
        accuracy7d: accuracyOf(arr, '7d', 1.5),
        avgActualReturn7d: avgReturn(arr, '7d'),
        avgUpside: avg(arr.map(r => r.upside_pct)),
      }))
      .sort((a, b) => (b.accuracy7d || 0) - (a.accuracy7d || 0))
      .slice(0, 15);

    const verified7d = rows.filter(r => r.actual_return_7d != null && r.entry_price != null);
    const winners    = verified7d.filter(r => r.actual_return_7d > 0);

    const byTickerMap = {};
    for (const r of verified7d) {
      const t = r.companies?.ticker;
      if (!t) continue;
      if (!byTickerMap[t]) byTickerMap[t] = {
        ticker: t, name: r.companies?.name_ko || t,
        market: r.companies?.market || 'US', returns: [],
      };
      byTickerMap[t].returns.push(r.actual_return_7d);
    }
    // 복리 누적 수익률 (1+r1)(1+r2)...(1+rn) - 1
    // 단순 합산은 의미 없음 (46거래 × 22% = 1040% 같은 비현실적 수치)
    const compound = (rets) => {
      const v = rets.reduce((acc, r) => acc * (1 + (r || 0) / 100), 1) - 1;
      return Math.round(v * 10000) / 100;  // % 소수 둘째자리
    };
    const r2 = (x) => x == null ? null : Math.round(x * 100) / 100;

    const MIN_TRADES = 3;  // 표본 1-2개는 노이즈 → 제외
    // 종목별 순차 복리는 거래 수가 많으면 천문학적 수치로 폭주(74건 × +25% → +15억%)
    // → 평균 수익률 기준 정렬 + 승률 표시로 교체
    const byTicker = Object.values(byTickerMap).map(t => ({
      ...t, n: t.returns.length,
      avg:     r2(avg(t.returns)),
      winRate: Math.round(t.returns.filter(v => v > 0).length / t.returns.length * 100),
    }));
    const significant = byTicker.filter(t => t.n >= MIN_TRADES);
    const topWinners = [...significant].sort((a, b) => b.avg - a.avg).slice(0, 10);
    const topLosers  = [...significant].sort((a, b) => a.avg - b.avg).slice(0, 10);

    const verified7dRets = verified7d.map(r => r.actual_return_7d).filter(v => v != null);

    // 주간 리밸런싱 시뮬레이션: 같은 주(월요일 시작) 진입 추천을 동일 비중 바스켓으로
    // 묶어 주별 평균 수익률을 시간순 복리. 거래별 순차 전액 재투자 가정은
    // (1.046)^827 같은 천문학적 수치가 나와 지표로 무의미함.
    const weekKey = (d) => {
      const dt = new Date(d);
      if (isNaN(dt)) return null;
      dt.setUTCDate(dt.getUTCDate() - (dt.getUTCDay() + 6) % 7);
      return dt.toISOString().slice(0, 10);
    };
    const byWeek = {};
    for (const r of verified7d) {
      const k = r.entry_date ? weekKey(r.entry_date) : null;
      if (!k) continue;
      (byWeek[k] = byWeek[k] || []).push(r.actual_return_7d);
    }
    const weeklyAvgs = Object.entries(byWeek)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, arr]) => avg(arr));

    const backtest = {
      totalTrades: verified7d.length,
      winRate:     verified7d.length ? Math.round(winners.length / verified7d.length * 100) : 0,
      avgReturn:   r2(avg(verified7dRets)),
      bestTrade:   verified7dRets.length ? r2(Math.max(...verified7dRets)) : 0,
      worstTrade:  verified7dRets.length ? r2(Math.min(...verified7dRets)) : 0,
      // 주간 복리: 주별 평균 수익률의 시간순 복리 (주 단위 리밸런싱 가정)
      cumulativeReturn: compound(weeklyAvgs),
      weeks: weeklyAvgs.length,
      minTradesFilter: MIN_TRADES,
      byPeriod: {
        '1d':  periodStats(rows, '1d',  0.3),
        '7d':  periodStats(rows, '7d',  1.5),
        '30d': periodStats(rows, '30d', 3.0),
      },
      topWinners, topLosers,
    };

    const byDateMap = {};
    for (const r of verified7d) {
      const d = (r.entry_date || '').split('T')[0];
      if (!d) continue;
      (byDateMap[d] = byDateMap[d] || []).push(r.actual_return_7d);
    }
    const timeline = Object.entries(byDateMap)
      .map(([date, arr]) => ({ date, count: arr.length, avgReturn7d: avg(arr) }))
      .filter(d => d.count >= 2)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-60);

    return res.status(200).json({ ok: true, overall, byConfidence, bySector, backtest, timeline });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function accuracyOf(rows, period, minAbs) {
  const accKey = `is_accurate_${period}`;
  const retKey = `actual_return_${period}`;
  const verified = rows.filter(r => r[accKey] != null);
  if (!verified.length) return null;
  const hits = verified.filter(r => r[accKey] === true && Math.abs(r[retKey] || 0) >= minAbs);
  return Math.round(hits.length / verified.length * 100);
}
function avgReturn(rows, period) {
  const retKey = `actual_return_${period}`;
  const values = rows.map(r => r[retKey]).filter(v => v != null);
  if (!values.length) return null;
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length * 100) / 100;
}
function avg(arr) {
  const filtered = arr.filter(v => v != null);
  if (!filtered.length) return null;
  return Math.round(filtered.reduce((s, v) => s + v, 0) / filtered.length * 100) / 100;
}
function periodStats(rows, period, minAbs) {
  const accKey = `is_accurate_${period}`;
  const retKey = `actual_return_${period}`;
  const verified = rows.filter(r => r[accKey] != null);
  if (!verified.length) return { verified: 0, accuracy: null, avgReturn: null };
  const hits = verified.filter(r => r[accKey] === true && Math.abs(r[retKey] || 0) >= minAbs);
  return {
    verified: verified.length,
    accuracy: Math.round(hits.length / verified.length * 100),
    avgReturn: avg(verified.map(r => r[retKey])),
    winRate:   Math.round(verified.filter(r => r[retKey] > 0).length / verified.length * 100),
  };
}

// ════════════════════════════════════════════════════════════
// 5) 전략 투자 자동 추출 (cron이 매일 호출)
// ════════════════════════════════════════════════════════════
// 최근 24~48h 내 분석된 이슈에서 "X가 Y에 투자/인수/지분" 패턴을 Claude로 추출
// → strategic_investments 테이블에 upsert. 중복은 seen_count 증가 + last_seen 갱신.
const EXTRACT_INVESTMENTS_STATIC_PROMPT = `당신은 금융 뉴스 분석가입니다. 아래 뉴스에서 "상장사가 다른 기업/프로젝트에 투자·인수·지분 확보" 사실이 명시적으로 언급되었는지만 추출하세요.

엄격한 규칙:
1. 명시적 사실만 추출. "할 수도 있다", "검토 중" 등 추측·계획은 제외
2. 투자자는 반드시 상장사여야 함 (티커가 존재해야 함). 비상장 VC/펀드는 제외
3. 단순 협력·MOU·공급계약은 제외. 지분 인수/투자/합작법인(JV)만
4. 대상이 비상장이어도 OK (예: Anthropic, OpenAI, SpaceX, xAI)
5. 한국 상장사는 6자리.KS 형식, 미국은 NYSE/NASDAQ 티커
6. theme는 "AI", "AI 반도체", "로봇", "휴머노이드", "자율주행", "우주", "위성통신", "방산", "바이오", "GLP-1", "원자력", "SMR", "EV 배터리", "K-팝", "게임", "핀테크", "암호화폐", "K-뷰티", "클라우드", "메타버스" 중 적합한 것
7. 여러 건이면 배열로. 해당 사실 없으면 빈 배열

다음 JSON만 반환 (다른 텍스트 없이):
{
  "extractions": [
    {
      "investor_ticker": "017670.KS",
      "investor_name": "SK텔레콤",
      "target_name": "Anthropic",
      "theme": "AI",
      "detail": "추가 라운드 참여 — 한국 내 Claude 독점 파트너십",
      "stake_info": "$100M",
      "confidence": 85,
      "highlight": true
    }
  ]
}

confidence 가이드:
- 90+: 보도자료 수준 명시 사실
- 70-89: 본문에서 명확히 언급
- 50-69: 행간에 암시되나 확실
- 50 미만은 추출 금지

highlight=true 조건:
- 핵심 사업과의 강한 연결 (예: SKT-Anthropic, 현대차-Boston Dynamics)
- 단순 소수 지분은 false`;

function buildExtractInvestmentsDynamicBlock(issue) {
  return `뉴스 제목: ${issue.title}\n요약: ${issue.summary || '없음'}\n\n위 뉴스에 대해 위 규칙에 따라 JSON으로만 응답하세요.`;
}

async function handleExtractInvestments(req, res) {
  if (!(await isFeatureEnabled(supabase, 'extract_investments'))) {
    return res.status(200).json({ ok: true, scanned: 0, extracted: 0, disabled: true });
  }

  const sinceHours = parseInt(req.body?.since_hours || req.query?.since_hours || 48, 10);
  const maxIssues  = Math.min(parseInt(req.body?.max || req.query?.max || 30, 10), 60);

  // 최근 분석된 이슈 수집
  const sinceIso = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const { data: issues, error: issErr } = await supabase
    .from('issues')
    .select('id, title, summary, source_url')
    .eq('is_analyzed', true)
    .gte('published_at', sinceIso)
    .order('published_at', { ascending: false })
    .limit(maxIssues);
  if (issErr) return res.status(500).json({ error: issErr.message });
  if (!issues?.length) return res.status(200).json({ ok: true, scanned: 0, extracted: 0 });

  const items = issues.map(issue => ({
    itemId: issue.id,
    static: EXTRACT_INVESTMENTS_STATIC_PROMPT,
    dynamic: buildExtractInvestmentsDynamicBlock(issue),
  }));
  const result = await submitAgentJob({
    pipeline: 'extract_investments',
    items,
    payload: { issues: issues.map(i => ({ id: i.id, title: i.title, source_url: i.source_url })) },
  });
  return res.status(200).json({ ok: true, scanned: issues.length, ...result });
}

// agent-poll에서 호출 — row.response[issue.id]를 읽어 기존과 동일한 파싱/upsert 로직 수행
async function finalizeExtractInvestments(row) {
  const issues = row.payload?.issues || [];
  const results = { extracted: 0, new: 0, updated: 0, skipped: 0, errors: [] };

  for (const issue of issues) {
    try {
      const text = extractJobText(row, issue.id);
      if (!text) { results.skipped++; continue; }
      const parsed = parseJobJson(text);
      const list = Array.isArray(parsed.extractions) ? parsed.extractions : [];
      if (!list.length) { results.skipped++; continue; }

      for (const ex of list) {
        if (!ex.investor_ticker || !ex.target_name || !ex.theme || !ex.detail) continue;
        if (typeof ex.confidence === 'number' && ex.confidence < 60) continue;

        results.extracted++;
        const ticker = ex.investor_ticker.toUpperCase().trim();
        const target = ex.target_name.trim();

        const { data: existing } = await supabase
          .from('strategic_investments')
          .select('id, seen_count, confidence')
          .eq('investor_ticker', ticker)
          .eq('target_name', target)
          .maybeSingle();

        let investmentId = existing?.id;
        let eventType = null;

        if (existing) {
          const newConf = Math.round(((existing.confidence || 70) + (ex.confidence || 70)) / 2);
          await supabase.from('strategic_investments')
            .update({
              seen_count:   (existing.seen_count || 1) + 1,
              last_seen_at: new Date().toISOString(),
              confidence:   newConf,
            })
            .eq('id', existing.id);
          results.updated++;
          eventType = 'reextracted';
        } else {
          const { data: inserted, error: insErr } = await supabase.from('strategic_investments').insert({
            investor_ticker: ticker,
            investor_name:   ex.investor_name || null,
            target_name:     target,
            theme:           ex.theme,
            detail:          ex.detail.slice(0, 500),
            stake_info:      ex.stake_info ? String(ex.stake_info).slice(0, 80) : null,
            highlight:       !!ex.highlight,
            confidence:      ex.confidence || 70,
            source_issue_id: issue.id,
            source_url:      issue.source_url || null,
            source_title:    issue.title?.slice(0, 300) || null,
          }).select('id').single();
          if (!insErr) {
            results.new++;
            investmentId = inserted?.id;
            eventType = 'extracted';
          }
        }

        if (investmentId && eventType) {
          await supabase.from('strategic_investment_events').insert({
            investment_id:   investmentId,
            investor_ticker: ticker,
            target_name:     target,
            event_type:      eventType,
            confidence:      ex.confidence || 70,
            source_issue_id: issue.id,
            source_url:      issue.source_url || null,
          });
        }
      }
    } catch (e) {
      results.errors.push({ issue_id: issue.id, error: e.message?.slice(0, 200) });
    }
  }

  return results;
}

// ════════════════════════════════════════════════════════════
// 6) 전략투자 목록 조회 (admin UI)
// ════════════════════════════════════════════════════════════
async function handleListInvestments(req, res) {
  const status   = (req.query?.status || 'active').toString();
  const ticker   = (req.query?.ticker || '').toString().toUpperCase().trim();
  const theme    = (req.query?.theme || '').toString().trim();
  const search   = (req.query?.q || '').toString().trim();
  const page     = Math.max(1, parseInt(req.query?.page || 1, 10));
  const pageSize = Math.min(100, parseInt(req.query?.page_size || 50, 10));

  let q = supabase.from('strategic_investments')
    .select('id, investor_ticker, investor_name, target_name, theme, detail, stake_info, highlight, confidence, seen_count, source_issue_id, source_url, source_title, status, extracted_at, last_seen_at', { count: 'exact' })
    .order('highlight', { ascending: false })
    .order('seen_count', { ascending: false })
    .order('extracted_at', { ascending: false });

  if (status !== 'all') q = q.eq('status', status);
  if (ticker)           q = q.eq('investor_ticker', ticker);
  if (theme)            q = q.ilike('theme', `%${theme}%`);
  if (search)           q = q.or(`investor_name.ilike.%${search}%,target_name.ilike.%${search}%,detail.ilike.%${search}%`);

  const { data, count, error } = await q.range((page - 1) * pageSize, page * pageSize - 1);
  if (error) return res.status(500).json({ error: error.message });

  // 티커별 그룹 카운트 (요약용)
  const { data: byTicker } = await supabase
    .from('strategic_investments')
    .select('investor_ticker, investor_name')
    .eq('status', 'active');
  const tickerCounts = {};
  for (const row of (byTicker || [])) {
    const k = row.investor_ticker;
    if (!tickerCounts[k]) tickerCounts[k] = { ticker: k, name: row.investor_name, count: 0 };
    tickerCounts[k].count++;
  }
  const topTickers = Object.values(tickerCounts).sort((a, b) => b.count - a.count).slice(0, 20);

  return res.status(200).json({ ok: true, items: data || [], total: count || 0, page, pageSize, topTickers });
}

// ════════════════════════════════════════════════════════════
// 7) 전략투자 수정 (highlight / status / detail)
// ════════════════════════════════════════════════════════════
async function handleUpdateInvestment(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = parseInt(req.body?.id, 10);
  if (!id) return res.status(400).json({ error: 'id required' });

  const update = {};
  if (typeof req.body?.highlight === 'boolean') update.highlight = req.body.highlight;
  if (typeof req.body?.status === 'string')     update.status = req.body.status;
  if (typeof req.body?.detail === 'string')     update.detail = req.body.detail.slice(0, 500);
  if (typeof req.body?.theme === 'string')      update.theme = req.body.theme.slice(0, 80);
  if (typeof req.body?.stake_info === 'string') update.stake_info = req.body.stake_info.slice(0, 80);
  if (typeof req.body?.confidence === 'number') update.confidence = Math.max(0, Math.min(100, req.body.confidence));
  if (!Object.keys(update).length) return res.status(400).json({ error: 'no fields to update' });

  const { data, error } = await supabase
    .from('strategic_investments')
    .update(update).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  let evType = null;
  if (update.status === 'rejected') evType = 'rejected';
  else if (update.status === 'active' && req.body?._from_pending) evType = 'approved';
  if (evType) {
    await supabase.from('strategic_investment_events').insert({
      investment_id: id, investor_ticker: data.investor_ticker,
      target_name: data.target_name, event_type: evType, confidence: data.confidence,
    });
  }
  return res.status(200).json({ ok: true, item: data });
}

// ════════════════════════════════════════════════════════════
// 8) 전략투자 삭제 (소프트=rejected / hard=DELETE)
// ════════════════════════════════════════════════════════════
async function handleDeleteInvestment(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = parseInt(req.body?.id, 10);
  const hard = !!req.body?.hard;
  if (!id) return res.status(400).json({ error: 'id required' });

  if (hard) {
    const { error } = await supabase.from('strategic_investments').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, deleted: 'hard' });
  }
  const { error } = await supabase.from('strategic_investments')
    .update({ status: 'rejected' }).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, deleted: 'soft' });
}

// ════════════════════════════════════════════════════════════
// 9) 전략투자 이벤트 히스토리 (그래프용 — 인증 불필요)
// ════════════════════════════════════════════════════════════
async function handleInvestmentEvents(req, res) {
  const ticker = (req.query?.ticker || '').toString().toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  const { data: events } = await supabase
    .from('strategic_investment_events')
    .select('target_name, event_type, confidence, occurred_at, source_url')
    .eq('investor_ticker', ticker)
    .order('occurred_at', { ascending: true })
    .limit(500);

  const byTarget = {};
  for (const e of (events || [])) {
    if (!byTarget[e.target_name]) byTarget[e.target_name] = [];
    byTarget[e.target_name].push(e);
  }
  const series = Object.entries(byTarget).map(([target, evts]) => ({
    target,
    points: evts.map((e, i) => ({ t: e.occurred_at, cumulative: i + 1, type: e.event_type, confidence: e.confidence })),
  }));

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
  return res.status(200).json({ ok: true, ticker, events: events || [], series });
}

// ════════════════════════════════════════════════════════════
// 9-1) 티커별 "미래 먹거리" 테마 맵 (메인 피드 지금 매수 후보 배점용 — 인증 불필요)
//  - 큐레이션(lib/strategic-investments.js 하드코딩) + DB 자동 추출(strategic_investments) 병합
//  - 큐레이션이 있으면 우선 사용(감쇠 없음), 없으면 DB 최신 추출 항목 사용(프론트에서 최신성 감쇠)
// ════════════════════════════════════════════════════════════
async function handleThemeMap(req, res) {
  try {
    const mod = await import('../lib/strategic-investments.js');
    const map = {};

    for (const [ticker, info] of Object.entries(mod.STRATEGIC_INVESTMENTS)) {
      const best = [...info.bets].sort((a, b) => (b.highlight ? 1 : 0) - (a.highlight ? 1 : 0))[0];
      if (best) map[ticker] = { theme: best.theme, highlight: !!best.highlight, source: 'curated' };
    }

    const { data } = await supabase
      .from('strategic_investments')
      .select('investor_ticker, theme, highlight, seen_count, last_seen_at')
      .eq('status', 'active');
    const byTicker = {};
    for (const row of (data || [])) {
      if (!row.investor_ticker) continue;
      (byTicker[row.investor_ticker] ||= []).push(row);
    }
    for (const [ticker, rows] of Object.entries(byTicker)) {
      if (map[ticker]) continue;  // 큐레이션이 이미 있으면 유지
      const best = [...rows].sort((a, b) => (b.highlight - a.highlight) || (b.seen_count || 0) - (a.seen_count || 0))[0];
      map[ticker] = { theme: best.theme, highlight: !!best.highlight, source: 'ai', last_seen_at: best.last_seen_at };
    }

    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json({ ok: true, map });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, map: {} });
  }
}

// ════════════════════════════════════════════════════════════
// 10) DART 5%+ 지분공시 폴링 (한국 OpenDart)
// ════════════════════════════════════════════════════════════
async function handleDartPoll(req, res) {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'DART_API_KEY env not set. Get free key at opendart.fss.or.kr' });

  const days = Math.min(30, parseInt(req.body?.days || req.query?.days || 7, 10));
  const begin = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  const end   = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // pblntf_detail_ty=D003: 주식등의 대량보유상황보고서
  const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${apiKey}&bgn_de=${begin}&end_de=${end}&pblntf_detail_ty=D003&page_count=100`;
  let listJson;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    listJson = await r.json();
  } catch (e) {
    return res.status(500).json({ error: 'DART list fetch failed: ' + e.message });
  }
  if (listJson.status && listJson.status !== '000') {
    return res.status(500).json({ error: `DART API: ${listJson.message || listJson.status}` });
  }

  const items = listJson.list || [];
  const results = {
    scanned: items.length, new: 0, updated: 0,
    skippedSelf: 0,        // 자기지분 (보고자 == 대상)
    skippedIndividual: 0,  // 개인 (2-4자 한글이름)
    skippedUnmatched: 0,   // 법인이지만 companies 테이블에 없음
    skippedMissing: 0,
    samples: [], unmatchedReporters: [],
  };

  // 신고자명 정규화
  const normalize = (s) => (s || '')
    .replace(/\(주\)|㈜|주식회사/g, '')
    .replace(/\s+Co\.?,?\s*Ltd\.?$/i, '')
    .replace(/\s+Inc\.?$/i, '')
    .replace(/외\s*\d+\s*인/g, '')
    .replace(/['"\\%_]/g, '')
    .trim();

  // 개인 이름 추정: 한글 2-4자, 회사/리츠/스튜디오/홀딩스/그룹 등 키워드 없음
  const isIndividual = (s) => {
    const t = normalize(s);
    if (!/^[가-힣]{2,4}$/.test(t)) return false;
    // 한글 2-4자 + 단어가 일반적인 회사 키워드 안 포함 → 개인 추정
    if (/리츠|스튜디오|홀딩스|그룹|증권|투자|자산운용|에너지|건설|전자|화학|중공업|제약|바이오|반도체|모터스|텔레콤/.test(t)) return false;
    return true;
  };

  for (const it of items.slice(0, 50)) {
    const reporter = (it.flr_nm || '').trim();
    const target = (it.corp_name || '').trim();
    const targetTicker = (it.stock_code || '').trim();
    if (!reporter || !target || !targetTicker) { results.skippedMissing++; continue; }

    // 자기지분 신고 (보고자 == 대상) — 의미 없음
    const reporterClean = normalize(reporter);
    const targetClean = normalize(target);
    if (reporterClean && targetClean && (reporterClean === targetClean || reporterClean.includes(targetClean) || targetClean.includes(reporterClean))) {
      results.skippedSelf++; continue;
    }

    // 개인 주주 신고 — 우리 목적 (기업→기업)과 무관
    if (isIndividual(reporter)) { results.skippedIndividual++; continue; }

    const cleaned = reporterClean;
    if (!cleaned || cleaned.length < 2) { results.skippedUnmatched++; continue; }

    // 1차: 정규화된 이름으로 매칭 (KR 시장)
    let { data: investorCo } = await supabase
      .from('companies')
      .select('ticker, name_ko, name_en')
      .or(`name_ko.ilike.%${cleaned}%,name_en.ilike.%${cleaned}%`)
      .eq('market', 'KR').limit(1).maybeSingle();

    // 2차: 첫 단어로만 매칭 (예: "한화에어로스페이스 외 1인" → "한화에어로스페이스")
    if (!investorCo?.ticker) {
      const firstToken = cleaned.split(/\s/)[0];
      if (firstToken.length >= 2) {
        const r2 = await supabase
          .from('companies')
          .select('ticker, name_ko, name_en')
          .or(`name_ko.ilike.${firstToken}%,name_en.ilike.${firstToken}%`)
          .eq('market', 'KR').limit(1).maybeSingle();
        investorCo = r2.data;
      }
    }

    if (!investorCo?.ticker) {
      results.skippedUnmatched++;
      if (results.unmatchedReporters.length < 15) {
        results.unmatchedReporters.push(`${reporter} → ${target}(${targetTicker})`);
      }
      continue;
    }

    const detail = `DART 대량보유 신고 — ${reporter}가 ${target} 지분 5%+ 신고`;
    const sourceUrl = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${it.rcept_no}`;
    const { data: existing } = await supabase
      .from('strategic_investments')
      .select('id, seen_count, confidence')
      .eq('investor_ticker', investorCo.ticker)
      .eq('target_name', target).maybeSingle();

    let invId;
    if (existing) {
      await supabase.from('strategic_investments').update({
        seen_count: (existing.seen_count || 1) + 1,
        last_seen_at: new Date().toISOString(),
        confidence: Math.max(existing.confidence || 70, 92),
      }).eq('id', existing.id);
      invId = existing.id; results.updated++;
    } else {
      const { data: ins } = await supabase.from('strategic_investments').insert({
        investor_ticker: investorCo.ticker,
        investor_name: investorCo.name_ko || investorCo.name_en,
        target_name: target, theme: '지분투자 (DART)',
        detail, stake_info: '5%+', highlight: false, confidence: 92,
        source_url: sourceUrl, source_title: it.report_nm, status: 'active',
      }).select('id').single();
      invId = ins?.id; if (invId) results.new++;
    }
    if (invId) {
      await supabase.from('strategic_investment_events').insert({
        investment_id: invId, investor_ticker: investorCo.ticker,
        target_name: target, event_type: 'dart', confidence: 92, source_url: sourceUrl,
      });
    }
    if (results.samples.length < 5) results.samples.push({ reporter, target, targetTicker });
  }
  return res.status(200).json({ ok: true, ...results, period: `${begin} ~ ${end}` });
}

// ════════════════════════════════════════════════════════════
// 11) SEC EDGAR 13F 폴링 (미국 헤지펀드/기관 보유)
// ════════════════════════════════════════════════════════════
// env SEC_13F_FILERS: CIK 콤마 구분 (기본: BRK, BlackRock 등)
async function handleSec13fPoll(req, res) {
  const filersEnv = process.env.SEC_13F_FILERS || '0001067983,0001364742';
  const ciks = filersEnv.split(',').map(s => s.trim().padStart(10, '0')).filter(Boolean).slice(0, 10);
  const ua = `StockRipple/1.0 (${(process.env.ADMIN_EMAILS || 'noreply@example.com').split(',')[0]})`;
  const results = { fetched: 0, new: 0, updated: 0, errors: [] };

  for (const cik of ciks) {
    try {
      const subUrl = `https://data.sec.gov/submissions/CIK${cik}.json`;
      const sr = await fetch(subUrl, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(10000) });
      if (!sr.ok) { results.errors.push(`CIK ${cik}: HTTP ${sr.status}`); continue; }
      const subData = await sr.json();
      const recent = subData.filings?.recent;
      if (!recent) continue;

      let acc = null;
      const filerName = subData.name || `CIK ${cik}`;
      for (let i = 0; i < (recent.form || []).length; i++) {
        if (recent.form[i] === '13F-HR') { acc = recent.accessionNumber[i].replace(/-/g, ''); break; }
      }
      if (!acc) { results.errors.push(`${filerName}: no 13F-HR`); continue; }

      const filingsUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${acc}/`;
      const idx = await fetch(filingsUrl + 'index.json', { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(10000) });
      if (!idx.ok) continue;
      const idxJson = await idx.json();
      const xmlFile = (idxJson.directory?.item || []).find(f => f.name.endsWith('.xml') && f.name.toLowerCase().includes('infotable'));
      if (!xmlFile) { results.errors.push(`${filerName}: no infotable.xml`); continue; }

      const xmlRes = await fetch(filingsUrl + xmlFile.name, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(15000) });
      const xml = await xmlRes.text();
      results.fetched++;

      const blocks = xml.match(/<infoTable>[\s\S]*?<\/infoTable>/g) || [];
      const holdings = blocks.map(b => ({
        name:  (b.match(/<nameOfIssuer>([\s\S]*?)<\/nameOfIssuer>/)?.[1] || '').trim(),
        value: parseInt((b.match(/<value>([\s\S]*?)<\/value>/)?.[1] || '0').replace(/\D/g, ''), 10),
      })).filter(h => h.name && h.value).sort((a, b) => b.value - a.value).slice(0, 10);

      // 매니저(헤지펀드)가 상장사인지 매핑 (Berkshire 등)
      const firstWord = filerName.split(/[\s.,]/)[0].replace(/['"\\%_]/g, '');
      const { data: investorCo } = await supabase.from('companies')
        .select('ticker, name_ko, name_en')
        .or(`name_en.ilike.%${firstWord}%,name_ko.ilike.%${firstWord}%`)
        .limit(1).maybeSingle();
      if (!investorCo?.ticker) { results.errors.push(`${filerName}: not listed in companies`); continue; }

      for (const h of holdings) {
        const detail = `13F 분기공시 — ${filerName} 보유 ($${(h.value / 1000).toFixed(1)}M)`;
        const { data: existing } = await supabase.from('strategic_investments')
          .select('id, seen_count').eq('investor_ticker', investorCo.ticker)
          .eq('target_name', h.name).maybeSingle();
        let invId;
        if (existing) {
          await supabase.from('strategic_investments').update({
            seen_count: (existing.seen_count || 1) + 1,
            last_seen_at: new Date().toISOString(),
            stake_info: `$${(h.value / 1000).toFixed(1)}M`, confidence: 88,
          }).eq('id', existing.id);
          invId = existing.id; results.updated++;
        } else {
          const { data: ins } = await supabase.from('strategic_investments').insert({
            investor_ticker: investorCo.ticker, investor_name: investorCo.name_en || filerName,
            target_name: h.name, theme: '지분투자 (13F)', detail,
            stake_info: `$${(h.value / 1000).toFixed(1)}M`, confidence: 88,
            source_url: filingsUrl + xmlFile.name, source_title: `13F-HR ${filerName}`,
            status: 'active',
          }).select('id').single();
          invId = ins?.id; if (invId) results.new++;
        }
        if (invId) {
          await supabase.from('strategic_investment_events').insert({
            investment_id: invId, investor_ticker: investorCo.ticker,
            target_name: h.name, event_type: 'sec13f', confidence: 88,
            source_url: filingsUrl + xmlFile.name,
          });
        }
      }
    } catch (e) {
      results.errors.push(`CIK ${cik}: ${e.message?.slice(0, 150)}`);
    }
  }
  return res.status(200).json({ ok: true, ...results });
}

// ════════════════════════════════════════════════════════════
// 12) DART corp_code 동기화 (1회 실행 / 종종 갱신)
// ════════════════════════════════════════════════════════════
// DART OpenAPI의 corpCode.xml.zip 다운로드 → 6자리 stock_code → 8자리 corp_code 매핑
// companies 테이블의 KR 종목에 dart_corp_code 채워넣음
async function handleDartSyncCorpCodes(req, res) {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'DART_API_KEY env not set' });

  try {
    const t0 = Date.now();
    const AdmZip = (await import('adm-zip')).default;
    const r = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${apiKey}`, {
      signal: AbortSignal.timeout(40000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/zip, application/octet-stream, */*',
      },
    });
    if (!r.ok) return res.status(500).json({ error: `DART zip HTTP ${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());
    const tFetch = Date.now() - t0;
    const zip = new AdmZip(buf);
    const entry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.xml'));
    if (!entry) return res.status(500).json({ error: 'No XML in DART zip' });
    const xml = entry.getData().toString('utf8');
    const tUnzip = Date.now() - t0 - tFetch;

    // <list><corp_code>...</corp_code><corp_name>...</corp_name><stock_code>...</stock_code><modify_date>...</modify_date></list>
    const lists = xml.match(/<list>[\s\S]*?<\/list>/g) || [];
    const mapping = {};   // stock_code (6자리, .KS 제외) → corp_code (8자리)
    for (const block of lists) {
      const stockCode = (block.match(/<stock_code>([\s\S]*?)<\/stock_code>/)?.[1] || '').trim();
      const corpCode  = (block.match(/<corp_code>([\s\S]*?)<\/corp_code>/)?.[1] || '').trim();
      if (stockCode && /^\d{6}$/.test(stockCode) && corpCode) mapping[stockCode] = corpCode;
    }

    // KR 종목들의 dart_corp_code 업데이트
    const { data: krCompanies } = await supabase
      .from('companies')
      .select('id, ticker, dart_corp_code')
      .eq('market', 'KR');

    // 병렬 업데이트 (10개씩 chunked)
    let updated = 0, alreadySet = 0, notFound = 0;
    const todo = [];
    for (const c of (krCompanies || [])) {
      const stockCode = c.ticker?.replace(/\.(KS|KQ)$/i, '');
      const corpCode = mapping[stockCode];
      if (!corpCode) { notFound++; continue; }
      if (c.dart_corp_code === corpCode) { alreadySet++; continue; }
      todo.push({ id: c.id, corpCode });
    }
    // 10개씩 batched parallel update
    for (let i = 0; i < todo.length; i += 10) {
      const batch = todo.slice(i, i + 10);
      await Promise.all(batch.map(async t => {
        const { error } = await supabase.from('companies').update({ dart_corp_code: t.corpCode }).eq('id', t.id);
        if (!error) updated++;
      }));
    }
    const tTotal = Date.now() - t0;

    return res.status(200).json({
      ok: true,
      total_kr_companies: (krCompanies || []).length,
      mapping_size: Object.keys(mapping).length,
      updated, alreadySet, notFound,
      timing: { fetch_ms: tFetch, unzip_parse_ms: tUnzip, total_ms: tTotal },
    });
  } catch (e) {
    return res.status(500).json({ error: 'DART sync failed: ' + e.message });
  }
}

// ════════════════════════════════════════════════════════════
// 13) DART 회사 상세 (주주/임원/재무) — 24h 캐시
// ════════════════════════════════════════════════════════════
async function handleDartCompanyDetail(req, res) {
  const apiKey = process.env.DART_API_KEY;
  const ticker = (req.query?.ticker || '').toString().trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  if (!apiKey) return res.status(500).json({ error: 'DART_API_KEY env not set' });
  if (!/\.K[SQ]$/i.test(ticker)) return res.status(400).json({ error: 'KR ticker only (.KS/.KQ)' });

  // 1. companies에서 corp_code 조회
  const { data: company } = await supabase
    .from('companies').select('dart_corp_code, name_ko, ticker')
    .eq('ticker', ticker).maybeSingle();
  const corpCode = company?.dart_corp_code;
  if (!corpCode) {
    return res.status(404).json({ error: 'dart_corp_code not synced. Run ?action=dart-sync-corp-codes first.' });
  }

  // 2. 24h 캐시 확인
  const { data: cached } = await supabase
    .from('dart_company_cache').select('*').eq('corp_code', corpCode).maybeSingle();
  if (cached && (Date.now() - new Date(cached.updated_at).getTime()) < 86400 * 1000) {
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ ok: true, cached: true, ...cached });
  }

  // 3. 최근 사업보고서 연도 (작년 또는 재작년)
  const now = new Date();
  // 사업보고서는 보통 3월말~4월초 공시. 5월 이후라면 작년, 그 이전이면 재작년
  const bsnsYear = (now.getMonth() >= 4 ? now.getFullYear() - 1 : now.getFullYear() - 2).toString();
  const reprtCode = '11011'; // 사업보고서

  const dartFetch = async (endpoint, extra = {}) => {
    const params = new URLSearchParams({
      crtfc_key: apiKey, corp_code: corpCode, bsns_year: bsnsYear, reprt_code: reprtCode, ...extra,
    });
    try {
      const r = await fetch(`https://opendart.fss.or.kr/api/${endpoint}?${params.toString()}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return null;
      const j = await r.json();
      if (j.status !== '000' && j.status !== '013') return null;  // 013: 조회결과 없음
      return j.list || [];
    } catch { return null; }
  };

  // 4. 4개 엔드포인트 병렬 호출
  const [majorHolders, shareholders, officers, financials] = await Promise.all([
    dartFetch('hyslrSttus.json'),       // 임원·주요주주 소유주식 변동
    dartFetch('mrhlSttus.json'),        // 최대주주 현황
    dartFetch('exctvSttus.json'),       // 임원 현황
    dartFetch('fnlttSinglAcntAll.json', { fs_div: 'CFS' }), // 연결재무제표 전체
  ]);

  // 재무는 최근 3년 추이도 가져오자 (작년/재작년)
  const yearsBack = [];
  for (let i = 0; i < 3; i++) {
    const y = (parseInt(bsnsYear, 10) - i).toString();
    yearsBack.push(y);
  }
  const financialsByYear = {};
  await Promise.all(yearsBack.map(async (y) => {
    const params = new URLSearchParams({
      crtfc_key: apiKey, corp_code: corpCode, bsns_year: y, reprt_code: '11011', fs_div: 'CFS',
    });
    try {
      const r = await fetch(`https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?${params.toString()}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return;
      const j = await r.json();
      if (j.status === '000') financialsByYear[y] = j.list;
    } catch {}
  }));

  // 5. 핵심 재무지표만 추출 (매출액, 영업이익, 당기순이익, 자산총계, 부채총계)
  const extractMetrics = (rows) => {
    if (!Array.isArray(rows)) return null;
    const find = (keywords) => {
      for (const row of rows) {
        const name = (row.account_nm || '').replace(/\s/g, '');
        if (keywords.some(k => name.includes(k))) {
          const v = parseFloat((row.thstrm_amount || '0').replace(/,/g, ''));
          return isNaN(v) ? null : v;
        }
      }
      return null;
    };
    return {
      revenue:   find(['매출액', '수익(매출액)', '영업수익']),
      opIncome:  find(['영업이익', '영업손실']),
      netIncome: find(['당기순이익', '당기순손실']),
      assets:    find(['자산총계']),
      liabilities: find(['부채총계']),
      equity:    find(['자본총계']),
    };
  };
  const annualFinancials = Object.fromEntries(
    Object.entries(financialsByYear).map(([y, rows]) => [y, extractMetrics(rows)])
  );

  // 6. 캐시에 저장
  const cacheRow = {
    corp_code: corpCode, ticker,
    major_holders: majorHolders || [],
    shareholders: shareholders || [],
    officers: officers || [],
    financials: annualFinancials,
    treasury_stock: null,   // 추후 추가
    updated_at: new Date().toISOString(),
  };
  await supabase.from('dart_company_cache').upsert(cacheRow, { onConflict: 'corp_code' });

  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({ ok: true, cached: false, ...cacheRow });
}

// ════════════════════════════════════════════════════════════
// 14) DART corp_code 수동 업로드 (CSV 페이스트)
// ════════════════════════════════════════════════════════════
// Vercel ↔ 한국 네트워크가 느려 자동 다운로드 timeout 시 사용
// body: { csv: "005930,00126380\n000660,00164779\n..." } 또는 { mapping: { "005930": "00126380", ... } }
async function handleDartUploadCorpCodes(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let mapping = {};
  if (req.body?.mapping && typeof req.body.mapping === 'object') {
    mapping = req.body.mapping;
  } else if (typeof req.body?.csv === 'string') {
    for (const line of req.body.csv.split(/\r?\n/)) {
      const m = line.match(/(\d{6})\s*[,;\t|]\s*(\d{8})/);
      if (m) mapping[m[1]] = m[2];
    }
  } else {
    return res.status(400).json({ error: 'Provide body.csv (text) or body.mapping (object)' });
  }
  const mappingSize = Object.keys(mapping).length;
  if (!mappingSize) return res.status(400).json({ error: 'No valid stock_code,corp_code pairs found' });

  const { data: krCompanies } = await supabase
    .from('companies').select('id, ticker, dart_corp_code').eq('market', 'KR');

  let updated = 0, alreadySet = 0, notFound = 0;
  const todo = [];
  for (const c of (krCompanies || [])) {
    const stockCode = c.ticker?.replace(/\.(KS|KQ)$/i, '');
    const corpCode = mapping[stockCode];
    if (!corpCode) { notFound++; continue; }
    if (c.dart_corp_code === corpCode) { alreadySet++; continue; }
    todo.push({ id: c.id, corpCode });
  }
  for (let i = 0; i < todo.length; i += 20) {
    await Promise.all(todo.slice(i, i + 20).map(async t => {
      const { error } = await supabase.from('companies').update({ dart_corp_code: t.corpCode }).eq('id', t.id);
      if (!error) updated++;
    }));
  }

  return res.status(200).json({
    ok: true,
    total_kr_companies: (krCompanies || []).length,
    mapping_size: mappingSize,
    updated, alreadySet, notFound,
  });
}

// ════════════════════════════════════════════════════════════
// 15) KR 종목명 일괄 검증 (DART 공식 회사명 vs DB 이름 대조)
// ════════════════════════════════════════════════════════════
// 우리 companies 테이블의 KR 종목들에 대해, DART에 등록된 공식 corp_name을 가져와서
// name_ko와 다르면 자동 보정. 잘못된 ticker→name 매핑(예: 001200.KS=삼성전기 같은 오류) 해결.
async function handleVerifyKrNames(req, res) {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'DART_API_KEY env not set' });
  const dryRun = req.body?.dry_run === true;

  const { data: krCompanies, error: listErr } = await supabase
    .from('companies')
    .select('id, ticker, name_ko, name_en, dart_corp_code')
    .eq('market', 'KR')
    .not('dart_corp_code', 'is', null);
  if (listErr) return res.status(500).json({ error: listErr.message });

  const results = { scanned: 0, matches: 0, mismatches: 0, fixed: 0, errors: 0, samples: [] };

  // 동시성 8로 제한해서 DART에 너무 많이 안 두드리게
  const CONCURRENCY = 8;
  for (let i = 0; i < krCompanies.length; i += CONCURRENCY) {
    const batch = krCompanies.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (c) => {
      try {
        const url = `https://opendart.fss.or.kr/api/company.json?crtfc_key=${apiKey}&corp_code=${c.dart_corp_code}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) { results.errors++; return; }
        const j = await r.json();
        if (j.status !== '000') { results.errors++; return; }

        results.scanned++;
        const officialName = (j.corp_name || '').trim();
        const officialEn = (j.corp_name_eng || '').trim();
        if (!officialName) return;

        if (officialName === (c.name_ko || '').trim()) {
          results.matches++;
          return;
        }

        // 불일치 발견
        results.mismatches++;
        if (results.samples.length < 30) {
          results.samples.push({
            ticker: c.ticker,
            db_name_ko: c.name_ko,
            db_name_en: c.name_en,
            dart_name_ko: officialName,
            dart_name_en: officialEn,
          });
        }

        if (!dryRun) {
          const update = { name_ko: officialName };
          if (officialEn) update.name_en = officialEn;
          const { error: upErr } = await supabase.from('companies').update(update).eq('id', c.id);
          if (!upErr) results.fixed++;
        }
      } catch { results.errors++; }
    }));
  }

  return res.status(200).json({ ok: true, dry_run: dryRun, ...results });
}

// company.html의 autoRegisterCompany가 브라우저에서 Yahoo Finance를 직접 호출하다
// CORS로 실패해(수정 완료) name_ko/name_en에 티커 코드가 그대로 저장된 KR 종목들
// 일괄 정리. dart_corp_code가 없어도 되도록 네이버 펀더멘털(/api/stock?type=fundamentals)
// 경유로 정확한 한글명을 다시 조회한다.
async function handleFixKrBrokenNames(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const dryRun = !!req.body?.dry_run;

  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, ticker, name_ko, name_en')
    .eq('market', 'KR');
  if (error) return res.status(500).json({ error: error.message });

  const broken = (companies || []).filter(c => c.name_ko === c.ticker || c.name_en === c.ticker);

  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `https://${req.headers.host}`;

  const results = [];
  for (const c of broken) {
    try {
      const [fundRes, quoteRes] = await Promise.all([
        fetch(`${base}/api/stock?type=fundamentals&ticker=${encodeURIComponent(c.ticker)}&nocache=1`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`${base}/api/quotes?tickers=${encodeURIComponent(c.ticker)}`).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      const nameKo = fundRes?.company || null;
      const shortName = quoteRes?.data?.[c.ticker]?.shortName || null;
      if (!nameKo) { results.push({ ticker: c.ticker, ok: false, error: '네이버에서 회사명 조회 실패' }); continue; }

      const update = {
        name_ko: nameKo,
        name_en: (shortName && shortName !== c.ticker) ? shortName : nameKo,
      };
      if (!dryRun) {
        const { error: upErr } = await supabase.from('companies').update(update).eq('id', c.id);
        if (upErr) { results.push({ ticker: c.ticker, ok: false, error: upErr.message }); continue; }
      }
      results.push({ ticker: c.ticker, ok: true, before: c.name_ko, after: update.name_ko });
    } catch (e) {
      results.push({ ticker: c.ticker, ok: false, error: e.message });
    }
  }

  return res.status(200).json({
    ok: true,
    dryRun,
    totalKr: companies?.length || 0,
    brokenFound: broken.length,
    fixed: results.filter(r => r.ok).length,
    results,
  });
}

// ════════════════════════════════════════════════════════════
// 16) 옵션 체인 요약 (Yahoo /v7/finance/options)
// ════════════════════════════════════════════════════════════
async function handleOptionsChain(req, res) {
  const ticker = (req.query?.ticker || '').toString().trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  if (/\.K[SQ]$/.test(ticker)) return res.status(400).json({ error: 'US tickers only (KR options not on Yahoo)' });

  try {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
    const r = await fetch(`https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}`, {
      headers: { 'User-Agent': ua, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.status(500).json({ error: `Yahoo HTTP ${r.status}` });
    const j = await r.json();
    const result = j.optionChain?.result?.[0];
    if (!result) return res.status(404).json({ error: 'No options data' });

    const quote = result.quote || {};
    const opts = result.options?.[0] || {};
    const calls = opts.calls || [];
    const puts  = opts.puts  || [];

    const totalCallOI = calls.reduce((s, c) => s + (c.openInterest || 0), 0);
    const totalPutOI  = puts.reduce((s, p) => s + (p.openInterest || 0), 0);
    const pcr = totalCallOI ? (totalPutOI / totalCallOI) : null;

    const topByOI = (arr, n = 5) => arr.slice().sort((a, b) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, n).map(o => ({
      strike: o.strike, lastPrice: o.lastPrice, openInterest: o.openInterest, volume: o.volume,
      impliedVol: o.impliedVolatility ? Math.round(o.impliedVolatility * 10000) / 100 : null,
    }));

    // ATM IV (가장 가까운 콜의 IV)
    const spot = quote.regularMarketPrice;
    const atmCall = calls.slice().sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
    const atmIV = atmCall?.impliedVolatility ? Math.round(atmCall.impliedVolatility * 10000) / 100 : null;

    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({
      ok: true,
      ticker,
      spot,
      expiration: opts.expirationDate ? new Date(opts.expirationDate * 1000).toISOString().slice(0, 10) : null,
      atmIV,             // ATM 내재변동성 (%)
      pcr,               // Put/Call OI 비율 (>1: 약세, <1: 강세)
      totalCallOI, totalPutOI,
      callsTop: topByOI(calls),
      putsTop:  topByOI(puts),
      allExpirations: (result.expirationDates || []).slice(0, 12).map(t => new Date(t * 1000).toISOString().slice(0, 10)),
    });
  } catch (e) {
    return res.status(500).json({ error: 'Options fetch failed: ' + e.message });
  }
}

// ════════════════════════════════════════════════════════════
// 17) SEC EDGAR 공시 (10-K / 10-Q / 8-K / Proxy)
// ════════════════════════════════════════════════════════════
async function handleSecFilings(req, res) {
  const ticker = (req.query?.ticker || '').toString().trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  if (/\.K[SQ]$/.test(ticker)) return res.status(400).json({ error: 'US tickers only' });

  const ua = `StockRipple/1.0 (${(process.env.ADMIN_EMAILS || 'noreply@example.com').split(',')[0]})`;

  try {
    // ticker → CIK 매핑
    const tickersResp = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(10000),
    });
    if (!tickersResp.ok) return res.status(500).json({ error: `SEC tickers HTTP ${tickersResp.status}` });
    const tickersData = await tickersResp.json();
    const entry = Object.values(tickersData).find(t => t.ticker === ticker);
    if (!entry) return res.status(404).json({ error: `Ticker ${ticker} not in SEC database` });
    const cik = String(entry.cik_str).padStart(10, '0');
    const companyName = entry.title;

    // submissions
    const subResp = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(10000),
    });
    if (!subResp.ok) return res.status(500).json({ error: `SEC submissions HTTP ${subResp.status}` });
    const subData = await subResp.json();
    const recent = subData.filings?.recent;
    if (!recent) return res.status(404).json({ error: 'No filings' });

    const FORMS_OF_INTEREST = ['10-K', '10-Q', '8-K', 'DEF 14A', 'S-1', 'S-3', '20-F'];
    const filings = [];
    for (let i = 0; i < (recent.form || []).length && filings.length < 20; i++) {
      const form = recent.form[i];
      if (!FORMS_OF_INTEREST.includes(form)) continue;
      const acc = recent.accessionNumber[i].replace(/-/g, '');
      const accDash = recent.accessionNumber[i];
      const date = recent.filingDate[i];
      const reportDate = recent.reportDate?.[i];
      filings.push({
        form,
        filed_at: date,
        period: reportDate,
        url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${encodeURIComponent(form)}&dateb=&owner=include&count=40`,
        doc_url: `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${acc}/${accDash}-index.htm`,
        primary_doc: recent.primaryDocument?.[i] || null,
      });
    }

    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ ok: true, ticker, cik, companyName, filings });
  } catch (e) {
    return res.status(500).json({ error: 'SEC fetch failed: ' + e.message });
  }
}

// ════════════════════════════════════════════════════════════
// 18) AI 시장 종합 (24h 뉴스 → Claude 요약)
// ════════════════════════════════════════════════════════════
async function handleAiMarketSummaryGet(req, res) {
  // ?history=N → 과거 리포트 목록 반환 (아카이브)
  const history = Math.min(parseInt(req.query?.history) || 0, 90);
  if (history > 0) {
    const { data } = await supabase
      .from('ai_market_summary')
      .select('*').order('created_at', { ascending: false }).limit(history);
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ ok: true, items: data || [] });
  }

  // 최신 캐시된 요약 반환
  const { data } = await supabase
    .from('ai_market_summary')
    .select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!data) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'No summary yet. POST /api/admin?action=ai-market-summary to generate.' });
  }
  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
  return res.status(200).json({ ok: true, ...data });
}

// KST 00/08/16시 중 가장 최근에 지난 시각의 UTC 시점을 구한다 — 하루 딱 3번(8시간 간격)만
// 생성하도록 하는 스케줄 창의 시작점. KST는 DST 없이 항상 UTC+9라 고정 오프셋으로 계산 가능.
function currentAiSummaryWindowStartUtc() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const windowHour = kst.getUTCHours() - (kst.getUTCHours() % 8); // 0, 8, 16 중 가장 최근
  const windowStartKst = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), windowHour, 0, 0);
  return new Date(windowStartKst - 9 * 3600 * 1000);
}

async function handleAiMarketSummaryPost(req, res) {
  if (!(await isFeatureEnabled(supabase, 'ai_market_summary'))) {
    return res.status(200).json({ ok: true, generated: false, reason: 'disabled' });
  }

  // 하루 3번(KST 00시/08시/16시)만 생성 — 그 스케줄 창 안에서 이미 생성됐으면 스킵.
  // 매시간 크론이 불러도 실제 Claude 호출은 8시간에 1번뿐. 수동 강제 생성(force)은 항상 허용.
  if (!req.body?.force) {
    const windowStart = currentAiSummaryWindowStartUtc();
    const { data: last } = await supabase.from('ai_market_summary')
      .select('created_at').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (last?.created_at && new Date(last.created_at) >= windowStart) {
      return res.status(200).json({ ok: true, generated: false, reason: 'already generated this window', windowStart: windowStart.toISOString() });
    }
  }

  // 최근 24h 분석된 이슈 60건 수집
  const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: issues } = await supabase
    .from('issues')
    .select('title, summary, sectors, published_at, analyses(ai_summary, confidence_score)')
    .eq('is_analyzed', true)
    .gte('published_at', sinceIso)
    .order('published_at', { ascending: false })
    .limit(60);

  if (!issues?.length) return res.status(200).json({ ok: true, generated: false, reason: 'No recent issues' });

  const ctx = issues.map(i => {
    const conf = i.analyses?.[0]?.confidence_score;
    return `[${(i.published_at || '').slice(0, 16)}] (${conf || '?'}점) ${i.title}\n  ${i.analyses?.[0]?.ai_summary || i.summary || ''}`.slice(0, 400);
  }).join('\n\n');

  const dynamic = `당신은 한국어 금융 시장 분석가입니다. 아래 지난 24시간 분석 이슈 ${issues.length}건을 종합해서 오늘의 시장 종합 보고서를 작성하세요.

${ctx.slice(0, 12000)}

다음 JSON만 반환 (다른 텍스트 없이):
{
  "headline": "오늘 시장을 한 문장으로 (40자 내외)",
  "regime": "RISK-ON 또는 RISK-OFF 또는 MIXED",
  "bullish_drivers": ["강세 요인 1 (한 문장)", "강세 요인 2", "강세 요인 3"],
  "bearish_drivers": ["약세 요인 1", "약세 요인 2"],
  "sectors_winning": ["수혜 섹터 1", "수혜 섹터 2", "수혜 섹터 3"],
  "sectors_losing": ["피해 섹터 1", "피해 섹터 2"],
  "key_events_today": ["주요 이벤트 1 (한 문장)", "주요 이벤트 2", "주요 이벤트 3"],
  "watch_tomorrow": ["내일 주시 1", "내일 주시 2"]
}

규칙: 사실 기반, 객관적, 한국어, 추측 금지. 강세/약세 요인은 본문에 명시된 것만.`;

  const result = await submitAgentJob({
    pipeline: 'ai_market_summary',
    items: [{ itemId: 'main', static: '', dynamic }],
    payload: { based_on_issues: issues.length },
  });
  return res.status(200).json({ ok: true, generated: false, queued: result.submitted, reason: result.reason });
}

async function finalizeAiMarketSummary(row) {
  const text = extractJobText(row, 'main');
  if (!text) throw new Error('No agent response for ai_market_summary');
  const parsed = parseJobJson(text);
  const dbRow = {
    headline: parsed.headline,
    regime: parsed.regime,
    bullish_drivers: parsed.bullish_drivers || [],
    bearish_drivers: parsed.bearish_drivers || [],
    sectors_winning: parsed.sectors_winning || [],
    sectors_losing: parsed.sectors_losing || [],
    key_events_today: parsed.key_events_today || [],
    watch_tomorrow: parsed.watch_tomorrow || [],
    based_on_issues: row.payload?.based_on_issues || 0,
    created_at: new Date().toISOString(),
  };
  await supabase.from('ai_market_summary').insert(dbRow);
  return dbRow;
}

// ════════════════════════════════════════════════════════════
// 18-a) 섹터 파급 지도 — 최근 30일 분석에서 섹터 노드/파급 엣지/종목 집계
//   뉴스 분석의 "직접 섹터 → 파급 섹터" 방향성 데이터를 그래프로 변환.
//   x=30일 강도(장기), y=7일 강도(단기) 사분면 + 섹터별 다음 섹터 + 추천 종목
// ════════════════════════════════════════════════════════════
const SM_TAG_RULES = [
  ['AI',       /(?:^|[^a-z])ai(?:[^a-z]|$)|인공지능|생성형|llm|챗gpt|chatgpt|claude|copilot|에이전트/i],
  ['반도체',    /반도체|hbm|파운드리|메모리|d램|dram|낸드|nand|웨이퍼|semiconductor|엔비디아|nvidia|gpu|칩(?:[^가-힣]|$)|chip/i],
  ['전기차',    /전기차|테슬라|tesla|자율주행|(?:^|[^a-z])ev(?:[^a-z]|$)|모빌리티/i],
  ['배터리',    /배터리|이차전지|2차전지|양극재|음극재|전고체|리튬|battery/i],
  ['바이오',    /바이오|제약|신약|임상|fda|헬스케어|의료|glp-?1|비만치료|항암|biotech|pharma/i],
  ['에너지',    /에너지|원전|원자력|smr|태양광|풍력|수소|정유|유가|lng|전력|energy|solar|nuclear/i],
  ['핀테크',    /핀테크|결제|송금|fintech|payment/i],
  ['금융',     /금융|은행|보험|증권|금리|연준|fed(?:[^a-z]|$)|중앙은행|채권/i],
  ['크립토',    /암호화폐|비트코인|이더리움|스테이블코인|블록체인|crypto|bitcoin|stablecoin/i],
  ['클라우드',  /클라우드|데이터센터|cloud|aws|azure|saas/i],
  ['로봇',     /로봇|휴머노이드|robot/i],
  ['방산·우주', /방산|국방|미사일|무기|전투기|위성|우주|로켓|발사체|defense|missile|aerospace/i],
  ['게임',     /게임|엔씨소프트|크래프톤|넥슨|넷마블|gaming/i],
  ['엔터',     /엔터테인먼트|k-?팝|아이돌|하이브|콘텐츠|드라마|영화|ott|넷플릭스|스트리밍/i],
  ['소비재',    /소비재|유통|화장품|뷰티|식품|음료|리테일|패션|이커머스/i],
  ['자동차',    /자동차|현대차|기아|완성차|(?:^|[^a-z])oem(?:[^a-z]|$)/i],
  ['물류·운송', /물류|해운|운송|항공|운임|공급망|logistics|shipping/i],
  // 주의: '인프라'는 "AI 인프라/클라우드 인프라/전력 인프라"에 광범위하게 등장 → 건설로 오분류되므로 제외
  ['건설·부동산', /건설|부동산|시멘트|주택|토목|리츠|재건축|아파트/i],
  ['철강·소재',  /철강|포스코|구리|알루미늄|소재|화학|정밀화학/i],
];
function smTagsOf(text) {
  if (!text) return [];
  const tags = [];
  for (const [tag, re] of SM_TAG_RULES) if (re.test(text)) tags.push(tag);
  return tags;
}

async function handleSectorMapGet(req, res) {
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const since7Ms = Date.now() - 7 * 86400000;

  // 시간 기준은 뉴스 발행 시점(published_at) — 분석 시점(created_at)은 백로그 일괄 처리 때
  // 옛 뉴스가 "최근"으로 잡혀 단기/장기 비율이 왜곡됨
  const { data: analyses, error } = await supabase
    .from('analyses')
    .select('created_at, direct_sectors, ripple_effects, issues!inner(published_at), analysis_companies(upside_pct, confidence, ripple_sector, entry_date, rationale, companies(ticker, name_ko, name_en, market))')
    .gte('issues.published_at', since30)
    .order('created_at', { ascending: false })
    .limit(1500);
  if (error) return res.status(500).json({ error: error.message });

  const nodes = {};
  const nodeOf = (t) => (nodes[t] ||= { tag: t, cnt7: 0, cnt30: 0, comps: new Map() });
  const edgeW = {};
  // 종목 랭킹: 30일간 분석 등장 빈도 + 최신 매수논리(th) — "다음에 뭐 담지?" 섹션용
  const stockStats = {};

  for (const a of analyses || []) {
    const isRecent = new Date(a.issues?.published_at || a.created_at).getTime() >= since7Ms;
    const fromTags = [...new Set(smTagsOf((a.direct_sectors || []).join(' ')))];
    const toTags = new Set();
    for (const r of a.ripple_effects || []) smTagsOf(r?.sector || '').forEach(t => toTags.add(t));

    for (const t of new Set([...fromTags, ...toTags])) {
      const n = nodeOf(t);
      n.cnt30++;
      if (isRecent) n.cnt7++;
    }
    for (const f of fromTags) for (const t of toTags) {
      if (f !== t) edgeW[`${f}>${t}`] = (edgeW[`${f}>${t}`] || 0) + 1;
    }

    // 파급 섹터별 추천 종목 (티커당 최고 신뢰도 1건 유지)
    for (const ac of a.analysis_companies || []) {
      const co = ac.companies;
      if (!co?.ticker) continue;
      let mom1m = null, keyThesis = null;
      const fm = (ac.rationale || '').match(/\[FUND\](\{[^\n]*\})/);
      if (fm) { try { mom1m = JSON.parse(fm[1]).mom1m ?? null; } catch {} }
      const tm = (ac.rationale || '').match(/\[TRADE\](\{[^\n]*\})/);
      if (tm) { try { keyThesis = JSON.parse(tm[1]).th ?? null; } catch {} }

      // 종목 랭킹 집계
      const st = (stockStats[co.ticker] ||= {
        ticker: co.ticker, name: co.name_ko || co.name_en || co.ticker,
        market: co.market || (/\.K[SQ]$/i.test(co.ticker) ? 'KR' : 'US'),
        cnt: 0, sumUp: 0, nUp: 0, bestConf: 0, th: null, latest: '', tags: new Set(),
      });
      st.cnt++;
      if (ac.upside_pct != null) { st.sumUp += Number(ac.upside_pct); st.nUp++; }
      if ((ac.confidence || 0) > st.bestConf) st.bestConf = ac.confidence || 0;
      if ((ac.entry_date || '') > st.latest) { st.latest = ac.entry_date || ''; if (keyThesis) st.th = keyThesis; }
      smTagsOf(ac.ripple_sector || '').forEach(t => st.tags.add(t));
      for (const t of smTagsOf(ac.ripple_sector || '')) {
        const m = nodeOf(t).comps;
        const prev = m.get(co.ticker);
        // 티커당 최신 분석 1건 유지 — 구형 파이프라인의 느슨한 섹터 매칭보다 신형(검증된) 분석 우선
        if (!prev || (ac.entry_date || '') > (prev._ed || '')) {
          m.set(co.ticker, {
            _ed: ac.entry_date || '',
            ticker: co.ticker,
            name: co.name_ko || co.name_en || co.ticker,
            market: co.market || (/\.K[SQ]$/i.test(co.ticker) ? 'KR' : 'US'),
            upside: ac.upside_pct, confidence: ac.confidence,
            mom1m, entry_date: (ac.entry_date || '').slice(0, 10),
          });
        }
      }
    }
  }

  const sectors = Object.values(nodes)
    .filter(n => n.cnt30 >= 2)
    .map(n => ({
      tag: n.tag, cnt7: n.cnt7, cnt30: n.cnt30,
      // heat: 최근 7일 강도가 30일 주평균 대비 몇 배인가 (>1 가속, <1 감속)
      heat: n.cnt30 ? Math.round((n.cnt7 / Math.max(1, n.cnt30 / 4.3)) * 100) / 100 : 0,
      companies: [...n.comps.values()]
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0) || (b.entry_date || '').localeCompare(a.entry_date || ''))
        .slice(0, 6)
        .map(({ _ed, ...c }) => c),
    }))
    .sort((a, b) => b.cnt7 - a.cnt7 || b.cnt30 - a.cnt30);

  const edges = Object.entries(edgeW)
    .map(([k, weight]) => { const [from, to] = k.split('>'); return { from, to, weight }; })
    .filter(e => e.weight >= 2)
    .sort((a, b) => b.weight - a.weight);

  const top_stocks = Object.values(stockStats)
    .filter(s => s.cnt >= 1)
    .sort((a, b) => b.cnt - a.cnt || b.bestConf - a.bestConf)
    .slice(0, 30)
    .map(s => ({
      ticker: s.ticker, name: s.name, market: s.market, cnt: s.cnt,
      avgUpside: s.nUp ? Math.round((s.sumUp / s.nUp) * 10) / 10 : null,
      bestConf: s.bestConf || null,
      th: s.th, latest: (s.latest || '').slice(0, 10),
      tags: [...s.tags].slice(0, 3),
    }));

  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=7200');
  return res.status(200).json({
    ok: true, window_days: 30, based_on: (analyses || []).length,
    generated_at: new Date().toISOString(),
    sectors, edges, top_stocks,
  });
}

// ════════════════════════════════════════════════════════════
// 18-b) 주간 일정 (토·일 cron — 다음 주차 경제지표/실적/연준 일정)
// ════════════════════════════════════════════════════════════
async function handleWeeklyScheduleGet(req, res) {
  const { data } = await supabase
    .from('weekly_schedule')
    .select('*').order('week_start', { ascending: false }).limit(1).maybeSingle();
  if (!data) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'No weekly schedule yet.' });
  }
  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=7200');
  return res.status(200).json({ ok: true, ...data });
}

async function handleWeeklySchedulePost(req, res) {
  if (!(await isFeatureEnabled(supabase, 'weekly_schedule'))) {
    return res.status(200).json({ ok: true, generated: false, reason: 'disabled' });
  }

  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `https://${req.headers.host}`;

  // ── 대상 주 월~일 범위 (KST) ──
  // 토·일: 다음 주를 생성 / 월~금: 진행 중인 이번 주를 갱신
  // (ForexFactory가 nextweek 데이터를 늦게 여는 경우가 있어, 주중 매일 upsert로 지표를 채워넣는다)
  const KST_MS = 9 * 3600000;
  const nowK = new Date(Date.now() + KST_MS);
  const dowK = nowK.getUTCDay();                    // KST 요일 (0=일)
  const dayOffset = dowK === 6 ? 2 : dowK === 0 ? 1 : -(dowK - 1);
  const monK = new Date(Date.UTC(nowK.getUTCFullYear(), nowK.getUTCMonth(), nowK.getUTCDate() + dayOffset));
  const weekStart = monK.toISOString().slice(0, 10);
  const rangeStartMs = monK.getTime() - KST_MS;     // KST 월요일 00:00의 UTC 시각
  const rangeEndMs = rangeStartMs + 7 * 86400000;

  // 주차 라벨: 해당 월 1일의 요일 오프셋 기준 (예: 2026-07-06 → "2026년 7월 2주 차")
  const firstOfMonth = new Date(Date.UTC(monK.getUTCFullYear(), monK.getUTCMonth(), 1));
  const weekOfMonth = Math.ceil((monK.getUTCDate() + firstOfMonth.getUTCDay()) / 7);
  const weekLabel = `${monK.getUTCFullYear()}년 ${monK.getUTCMonth() + 1}월 ${weekOfMonth}주 차`;

  // ── 1) 데이터 소스 병렬 수집 ──
  //  a. 경제지표+연준 (자체 market-pulse edge — ForexFactory IP 차단 우회)
  //  b. 주요 기업 실적 (메가캡+조기발표조 20종목)
  //  c. 미 국채 입찰 (TreasuryDirect 공식 API — Note/Bond)
  //  d. 최근 뉴스 (예정 이벤트 추출용 — 상장/지수편입/주총/월매출 등)
  const [econRes, earnRes, tdRes, newsRes] = await Promise.all([
    fetch(`${base}/api/market-pulse?type=economic&limit=60`, { signal: AbortSignal.timeout(15000) })
      .then(r => r.json()).catch(() => ({ items: [] })),
    fetch(`${base}/api/earnings`, { signal: AbortSignal.timeout(20000) })
      .then(r => r.json()).catch(() => ({ items: [] })),
    fetch('https://www.treasurydirect.gov/TA_WS/securities/upcoming?format=json',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) })
      .then(r => r.json()).catch(() => []),
    supabase.from('issues')
      .select('title, published_at')
      .gte('published_at', new Date(Date.now() - 10 * 86400000).toISOString())
      .order('published_at', { ascending: false })
      .limit(350),
  ]);

  const econItems = (econRes.items || []).filter(e => {
    const t = new Date(e.date).getTime();
    return t >= rangeStartMs && t < rangeEndMs;
  });
  const earnItems = (earnRes.items || []).filter(e => {
    if (!e.date) return false;
    const t = new Date(`${e.date}T12:00:00Z`).getTime();
    return t >= rangeStartMs && t < rangeEndMs;
  });

  // 국채 입찰: Note/Bond만 (Bill 단기물은 노이즈). 입찰은 통상 13:00 ET = 익일 02:00 KST
  const tdItems = (Array.isArray(tdRes) ? tdRes : []).filter(s => {
    if (!/^(Note|Bond)$/i.test(s.securityType || '')) return false;
    const t = new Date(`${(s.auctionDate || '').slice(0, 10)}T17:00:00Z`).getTime(); // 13:00 EDT
    return t >= rangeStartMs && t < rangeEndMs;
  }).map(s => {
    const ym = (s.securityTerm || '').match(/^(\d+)-Year/);
    const years = ym ? Math.round(parseInt(ym[1]) + ((s.securityTerm.match(/(\d+)-Month/) || [])[1] ? 1 : 0)) : null;
    return {
      dateUtcMs: new Date(`${(s.auctionDate || '').slice(0, 10)}T17:00:00Z`).getTime(),
      title: `🇺🇸 ${years ? `${years}년물` : s.securityTerm} 국채 입찰${/Month/.test(s.securityTerm || '') ? ' (리오프닝)' : ''}`,
    };
  });

  const wsPayloadBase = { weekStart, weekLabel, rangeStartMs, rangeEndMs, econItems, earnItems, tdItems };

  // 뉴스가 있으면 이벤트 추출(stage 'events')부터 큐에 넣고, 없으면 newsEvents=[]로 바로
  // 조립 단계(stage 'highlights' 직행)로 넘어간다 — 기존 `if (anthropic && newsRes?.data?.length)` 분기와 동일한 게이트.
  if (newsRes?.data?.length) {
    const titles = newsRes.data.map(n => n.title).filter(Boolean).slice(0, 300).join('\n');

    // 경제지표 실제 발표치는 뉴스 분석 기반으로 찾는다(2026-07-16, ForexFactory+FMP 캘린더가
    // 실측으로 며칠씩 완전히 죽어있던 사고 이후 — FMP_API_KEY 만료 확인됨, ForexFactory도
    // Vercel에서만 계속 비어옴). econItems에 이미 있는 지표는 actual만 채우고, 캘린더가 아예
    // 비어서 econItems에 없는 지표도 뉴스에서 새로 찾아서 추가한다 — 항상 시도(캘린더 상태와
    // 무관하게). WS_CANON_INDICATORS 목록과 정확히 일치하는 이름만 인정해서 오매칭/창작 방지.
    const actualsAsk = `

또한 위 뉴스 제목 중에 아래 "주요 경제지표" 목록에 해당하는 지표의 실제 발표치가 명확히 언급된 게 있으면
추출하세요(예: "Consumer Price Index: Inflation At 3.5% In June" → 목록의 지표명과 정확히 일치하면 그 수치).
반드시 아래 목록의 지표명과 정확히 일치하는 것만, 수치가 뉴스에 명시적으로 나온 경우만, 그 지표가 실제로
발표된 날짜(뉴스에 언급되지 않았으면 뉴스 게재일)도 함께. 추측·계산·창작 절대 금지 — 확실하지 않으면 포함하지 마세요.

주요 경제지표 목록(미국):
${WS_CANON_INDICATORS.join(', ')}`;

    const dynamic = `아래는 최근 10일간 수집된 금융 뉴스 제목들입니다. 이 중에서 ${weekStart} ~ ${new Date(rangeEndMs - 86400000).toISOString().slice(0, 10)} 사이에 예정된 "구체적 이벤트"만 추출하세요 (기업 상장/ADR 상장, 지수 편입, 주주총회, 잠정 실적발표, 월간 매출 발표, 제품 출시, 정책 시행 등).

규칙:
- 뉴스에 날짜나 시점("다음 주", "7월 7일" 등)이 실제로 언급된 이벤트만. 날짜 추측/창작 절대 금지
- 이미 지나간 일, 단순 시황/전망 기사는 제외
- 확실한 것이 없으면 빈 배열
${actualsAsk}

JSON만 반환: {"events":[{"date":"YYYY-MM-DD","title":"이벤트 설명 (30자 내)"}], "indicatorResults":[{"date":"YYYY-MM-DD","titleKo":"목록의 지표명 그대로","actual":"실제 수치(원문 단위 그대로)"}]}

뉴스 제목:
${titles.slice(0, 15000)}`;
    const result = await submitAgentJob({ pipeline: 'weekly_schedule', stage: 'events', items: [{ itemId: 'main', static: '', dynamic }], payload: wsPayloadBase });
    return res.status(200).json({ ok: true, generated: false, queued: result.submitted, reason: result.reason });
  }

  return continueWeeklyScheduleAfterEvents(res, { ...wsPayloadBase, newsEvents: [] });
}

// 뉴스 기반 경제지표 실제치 추출에서 인정하는 지표명 화이트리스트 — market-data.js의
// NAME_KO 한국어 표기와 맞춰뒀다(다른 이름 쓰면 매칭 안 되게 해서 오매칭/창작 방지).
const WS_CANON_INDICATORS = [
  '소비자물가 (MoM)', '근원 CPI (MoM)', '소비자물가 (YoY)', '근원 CPI (YoY)',
  '생산자물가 (MoM)', '근원 PPI (MoM)', '생산자물가 (YoY)', '근원 PPI (YoY)',
  '비농업 신규고용 (NFP)', '실업률', 'ADP 비농업 고용', '신규실업급여 청구', '계속실업급여 청구',
  'GDP (QoQ)', 'GDP 예비치 (QoQ)', '소매판매 (MoM)', '근원 소매판매 (MoM)',
  'ISM 제조업 PMI', 'ISM 서비스업 PMI', '제조업 PMI (예비)', '서비스업 PMI (예비)',
  'PCE 물가 (MoM)', '근원 PCE 물가 (MoM)', 'PCE 물가 (YoY)', '근원 PCE 물가 (YoY)',
  '미시간대 소비자심리', '미시간대 소비자심리 (예비)', '소비자신뢰지수 (CB)',
  'FOMC 기준금리', '신규주택착공', '기존주택판매', '신규주택판매', '내구재주문 (MoM)',
];

// ── 일자별 조립 (KST 시각 기준) — stage 'events' 완료 후와 "뉴스 없음" 직행 경로 공용 ──
function assembleWeekDays({ econItems, earnItems, tdItems, newsEvents, KST_MS }) {
  const DAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
  const FLAG = { USD: '🇺🇸', EUR: '🇪🇺', JPY: '🇯🇵' };
  const dayMap = {};
  const addItem = (dateStr, item) => { (dayMap[dateStr] ||= []).push(item); };

  for (const e of econItems) {
    const dK = new Date(new Date(e.date).getTime() + KST_MS);
    const isFed = /speaks|testifies|speech|fomc member|fed chair|fomc press/i.test(e.title || '');
    // 예상치만 있고 실제 발표치는 표시가 안 되던 문제 — market-pulse(type=economic)가 이미
    // ForexFactory/FMP에서 actual을 채워주는데 여기서 안 읽고 있었다. 발표 후엔 같이 노출.
    const stat = [e.forecast ? `예상 ${e.forecast}` : '', e.actual ? `발표 ${e.actual}` : ''].filter(Boolean).join('/');
    addItem(dK.toISOString().slice(0, 10), {
      time: dK.toISOString().slice(11, 16),
      type: isFed ? '연준' : '지표',
      title: `${FLAG[e.country] || e.country} ${e.titleKo || e.title}${stat ? ` (${stat})` : ''}`,
      stars: e.impact === 'High' ? 3 : 2,
    });
  }
  for (const e of earnItems) {
    addItem(e.date, {
      time: e.callTime === 'BMO' ? '장전' : e.callTime === 'AMC' ? '장후' : '',
      type: '실적',
      title: `${e.company || e.ticker} (${e.ticker})${e.epsConsensus != null ? ` — 컨센서스 EPS $${Number(e.epsConsensus).toFixed(2)}` : ''}${e.dateEstimated ? ' ※예정일 추정' : ''}`,
      stars: 2,
    });
  }
  for (const t of tdItems) {
    const dK = new Date(t.dateUtcMs + KST_MS);
    addItem(dK.toISOString().slice(0, 10), {
      time: dK.toISOString().slice(11, 16),
      type: '지표',
      title: t.title,
      stars: 2,
    });
  }
  for (const ev of newsEvents) {
    addItem(ev.date, { time: '', type: '이벤트', title: ev.title, stars: 3 });
  }

  return Object.entries(dayMap)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, items]) => ({
      date,
      weekday: DAY_KO[new Date(`${date}T00:00:00Z`).getUTCDay()],
      items: items.sort((a, b) => (a.time || '99').localeCompare(b.time || '99')),
    }));
}

function computeHighlightsFallback({ newsEvents, econItems, earnItems }) {
  let highlights = [
    ...newsEvents.slice(0, 3).map(e => `${e.title} (${e.date.slice(5).replace('-', '/')})`),
    ...econItems.filter(e => e.impact === 'High').slice(0, 3).map(e => `${e.titleKo || e.title}`),
  ].slice(0, 6);
  if (!highlights.length && earnItems.length) {
    highlights = earnItems.slice(0, 5).map(e =>
      `${e.company || e.ticker} 실적 발표 (${e.date?.slice(5).replace('-', '/')})`);
  }
  return highlights;
}

// stage 'events' 완료 처리(agent-poll에서 호출) — newsEvents 확정 후 일자 조립 + 하이라이트
// 폴백 계산까지 마치고 stage 'highlights' 큐를 이어서 제출한다.
async function finalizeWeeklyScheduleEvents(row) {
  const text = extractJobText(row, 'main');
  let newsEvents = [];
  let econItems = row.payload.econItems || [];
  if (text) {
    try {
      const parsed = parseJobJson(text);
      const { rangeStartMs, rangeEndMs } = row.payload;
      newsEvents = (parsed.events || []).filter(e => {
        if (!e?.date || !e?.title) return false;
        const t = new Date(`${e.date}T12:00:00Z`).getTime();
        return t >= rangeStartMs && t < rangeEndMs;
      }).slice(0, 10);

      // 뉴스에서 찾은 실제 발표치를 econItems에 병합 — WS_CANON_INDICATORS 화이트리스트와
      // 정확히 일치하는 이름만 인정(오매칭/창작 방지). 이미 econItems에 있는 지표면 actual만
      // 채우고(기존 actual은 덮어쓰지 않음), 캘린더 API가 아예 못 준 지표는 뉴스만으로 새
      // 항목을 만들어 추가한다 — ForexFactory/FMP가 통째로 죽어도(2026-07-16 실측: FMP 키
      // 만료 + ForexFactory가 Vercel에서만 계속 빈 응답) 지표 섹션이 완전히 비지 않게 하려는
      // 목적. 이번 주 범위(rangeStartMs~rangeEndMs) 밖 날짜는 무시.
      if (Array.isArray(parsed.indicatorResults)) {
        const { rangeStartMs: rMs, rangeEndMs: rMe } = row.payload;
        for (const r of parsed.indicatorResults) {
          if (!r?.titleKo || !r?.actual || !r?.date || !WS_CANON_INDICATORS.includes(r.titleKo)) continue;
          const t = new Date(`${r.date}T12:00:00Z`).getTime();
          if (isNaN(t) || t < rMs || t >= rMe) continue;
          const idx = econItems.findIndex(e => e.titleKo === r.titleKo);
          if (idx >= 0) {
            if (econItems[idx].actual == null) econItems[idx] = { ...econItems[idx], actual: r.actual };
          } else {
            econItems.push({
              date: `${r.date}T12:00:00.000Z`, titleKo: r.titleKo, title: r.titleKo,
              country: 'USD', impact: 'High', forecast: null, previous: null,
              actual: r.actual, lowerIsBetter: false,
            });
          }
        }
      }
    } catch { /* 파싱 실패 시 newsEvents=[]로 계속 진행(기존 동작과 동일) */ }
  }
  return continueWeeklyScheduleAfterEvents(null, { ...row.payload, econItems, newsEvents });
}

const WS_KST_MS = 9 * 3600000;

// res가 있으면(동기 "뉴스 없음" 직행 경로) 그 자리에서 응답, null이면(agent-poll finalize 경로)
// stage 'highlights' 큐만 제출하고 반환한다.
async function continueWeeklyScheduleAfterEvents(res, ctx) {
  const { weekStart, weekLabel, econItems, earnItems, tdItems, newsEvents } = ctx;

  if (!econItems.length && !earnItems.length && !tdItems.length && !newsEvents.length) {
    if (res) return res.status(200).json({ ok: true, generated: false, reason: '다음 주 일정 데이터 없음', weekStart });
    return;
  }

  const days = assembleWeekDays({ econItems, earnItems, tdItems, newsEvents, KST_MS: WS_KST_MS });
  const highlightsFallback = computeHighlightsFallback({ newsEvents, econItems, earnItems });
  const flat = days.flatMap(d => d.items.map(i => `${d.date}(${d.weekday}) ${i.time} [${i.type}] ${i.title}`)).join('\n');
  const dynamic = `다음 주(${weekLabel}) 미국 시장 일정입니다. 시장 파급력이 큰 순서로 하이라이트 5개를 한 문장씩 뽑아주세요. 날짜를 "(7/8)" 형식으로 포함. JSON만 반환: {"highlights":["...","..."]}\n\n${flat.slice(0, 4000)}`;

  const result = await submitAgentJob({
    pipeline: 'weekly_schedule',
    stage: 'highlights',
    items: [{ itemId: 'main', static: '', dynamic }],
    payload: {
      week_start: weekStart, week_label: weekLabel, days,
      based_on: { econ: econItems.length, earnings: earnItems.length },
      highlightsFallback,
    },
  });
  if (res) return res.status(200).json({ ok: true, generated: false, queued: result.submitted, reason: result.reason });
}

// stage 'highlights' 완료 처리(agent-poll에서 호출) — 최종 weekly_schedule row upsert
async function finalizeWeeklyScheduleHighlights(row) {
  const text = extractJobText(row, 'main');
  let highlights = row.payload?.highlightsFallback || [];
  if (text) {
    try {
      const parsed = parseJobJson(text);
      if (Array.isArray(parsed.highlights) && parsed.highlights.length) highlights = parsed.highlights.slice(0, 6);
    } catch { /* 파싱 실패 시 폴백 유지 */ }
  }

  const dbRow = {
    week_start: row.payload.week_start,
    week_label: row.payload.week_label,
    highlights,
    days: row.payload.days,
    based_on: row.payload.based_on,
    created_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('weekly_schedule').upsert(dbRow, { onConflict: 'week_start' });
  if (error) throw new Error(`weekly_schedule upsert 실패: ${error.message}`);
  return dbRow;
}

// ════════════════════════════════════════════════════════════
// 19) 데일리 리포트 (국장/미장 — 장 마감 후 하루 정리)
// ════════════════════════════════════════════════════════════
const DR_INDICES = {
  KR: [
    { symbol: '^KS11',  name: 'KOSPI' },
    { symbol: '^KQ11',  name: 'KOSDAQ' },
    { symbol: 'KRW=X',  name: 'USD/KRW' },
  ],
  US: [
    { symbol: '^GSPC',  name: 'S&P 500' },
    { symbol: '^IXIC',  name: 'NASDAQ' },
    { symbol: '^DJI',   name: 'DOW' },
    { symbol: '^VIX',   name: 'VIX' },
  ],
};

async function fetchDrIndexQuote(symbol, name) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    const result = (await r.json())?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta?.regularMarketPrice) return null;
    const price = meta.regularMarketPrice;
    // 전일 종가는 일별 종가 시계열에서 (KR 지수는 meta.previousClose가 null이고
    // chartPreviousClose는 range 시작 이전 종가라 등락률이 틀어짐)
    const closes = (result?.indicators?.quote?.[0]?.close || []).filter(v => v != null);
    const prev = closes.length >= 2 ? closes[closes.length - 2] : (meta.previousClose ?? null);
    let changePercent = null;
    if (prev) changePercent = ((price - prev) / prev) * 100;
    else changePercent = meta.regularMarketChangePercent ?? null;
    return { name, price, changePercent: changePercent != null ? Math.round(changePercent * 100) / 100 : null };
  } catch { return null; }
}

// 리포트 대상 거래일: 해당 시장 타임존의 오늘 날짜 (장 마감 직후 생성 기준)
function drReportDate(market) {
  return new Date().toLocaleDateString('en-CA', { timeZone: market === 'KR' ? 'Asia/Seoul' : 'America/New_York' });
}

// dateStr('YYYY-MM-DD')이 timeZone 기준 그 날짜 00:00~24:00에 해당하는 UTC 구간을 계산.
// 과거 거래일 리포트 소급 생성 시 뉴스 수집 창을 그 하루로 정확히 좁히는 데 사용
// (DST 유무와 무관하게 그 UTC 시점 기준 실제 오프셋을 Intl로 직접 읽어와 계산하므로 안전).
function localDayBoundsUtc(dateStr, timeZone) {
  const probe = new Date(`${dateStr}T00:00:00Z`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(probe).map(x => [x.type, x.value]));
  const asLocalMs = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second);
  const offsetMs = asLocalMs - probe.getTime();
  const startUtc = new Date(probe.getTime() - offsetMs);
  return { startUtc, endUtc: new Date(startUtc.getTime() + 24 * 3600 * 1000) };
}

// ════════════════════════════════════════════════════════════
// 19) 예정 catalyst 레지스트리 (seed 수동 + 뉴스 기반 AI 추출)
// ════════════════════════════════════════════════════════════
function catalystTodayKST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

// market: 'KR'|'US'|null → 해당 시장 + GLOBAL, 아직 안 지난 것, 중요도·날짜 순
async function fetchUpcomingCatalysts(market) {
  const today = catalystTodayKST();
  let q = supabase.from('catalysts').select('*').eq('status', 'upcoming');
  if (market) q = q.in('market', [market, 'GLOBAL']);
  const { data, error } = await q
    .order('importance', { ascending: false })
    .order('event_date', { ascending: true, nullsFirst: false })
    .limit(40);
  if (error) return [];   // 테이블 미생성(마이그레이션 전) 등에도 리포트 생성은 계속되도록
  return (data || []).filter(c => !c.event_date || c.event_date >= today);
}

function normalizeCatalystRow(c, origin) {
  if (!c || !c.title) return null;
  const eff = origin || c.origin || 'ai';
  if (eff === 'ai' && !c.source) return null;   // AI 추출분은 근거(source) 없으면 폐기
  const market = ['KR', 'US', 'GLOBAL'].includes((c.market || '').toUpperCase()) ? c.market.toUpperCase() : 'GLOBAL';
  const cat = (c.category || '기타').toString().slice(0, 20);
  const ed = /^\d{4}-\d{2}-\d{2}$/.test(c.event_date || '') ? c.event_date : null;
  const key = (c.dedupe_key
    || `ai:${market}:${(c.ticker || c.company || '').toString().toLowerCase().replace(/\s+/g, '')}:${cat}:${ed || (c.date_text || '').toString().slice(0, 12)}`
  ).slice(0, 200);
  return {
    market, ticker: c.ticker || null, company: c.company || null,
    title: c.title.toString().slice(0, 200), category: cat,
    event_date: ed, date_text: c.date_text || null,
    importance: [1, 2, 3].includes(+c.importance) ? +c.importance : 2,
    status: 'upcoming', origin: origin || c.origin || 'ai',
    source: c.source || null, note: c.note || null,
    dedupe_key: key, updated_at: new Date().toISOString(),
  };
}

async function handleCatalystsGet(req, res) {
  const market = ((req.query?.market || '') + '').toUpperCase();
  const mkt = market === 'KR' || market === 'US' ? market : null;
  const items = await fetchUpcomingCatalysts(mkt);
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
  return res.status(200).json({ ok: true, market: mkt || 'ALL', items });
}

async function handleCatalystsPost(req, res) {
  const today = catalystTodayKST();

  // (a) 수동 추가/수정 — body.insert = 객체 또는 배열
  if (req.body?.insert) {
    const rows = (Array.isArray(req.body.insert) ? req.body.insert : [req.body.insert])
      .map(r => normalizeCatalystRow(r, r.origin || 'seed')).filter(Boolean);
    if (!rows.length) return res.status(400).json({ error: 'no valid rows' });
    const { error } = await supabase.from('catalysts').upsert(rows, { onConflict: 'dedupe_key' });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, inserted: rows.length });
  }

  // (b) 지난 이벤트 정리 (event_date < 오늘 → passed)
  await supabase.from('catalysts')
    .update({ status: 'passed', updated_at: new Date().toISOString() })
    .eq('status', 'upcoming').not('event_date', 'is', null).lt('event_date', today);

  const { data: news } = await supabase.from('issues')
    .select('title, published_at')
    .gte('published_at', new Date(Date.now() - 14 * 86400000).toISOString())
    .order('published_at', { ascending: false }).limit(300);

  // (b2) (b)의 날짜 기반 만료로 못 잡는 catalyst 정리 — event_date가 없거나(미확정),
  //      또는 event_date가 아직 안 지났어도(예: PDUFA 목표일 7/23으로 등록됐지만 실제
  //      결과가 그보다 먼저 나온 경우, 예: HLB 리보세라닙 — 목표일 전에 CRL로 조기 결론)
  //      기업명 + 카테고리 키워드가 함께 등장하는 최근 뉴스가 있으면 "이미 벌어진 일"로 보고 passed 처리.
  //      (예: 날짜가 "7/7 또는 7/24 유력"처럼 미확정 상태로 남아있던 삼성전자 실적이 실제 발표된 뒤에도
  //       계속 "다가오는 핵심 이벤트"에 예정으로 재노출되던 문제 — 리포트가 같은 뉴스로 실적 결과를
  //       recap에 쓰면서도 catalysts 섹션엔 여전히 미확정 예정으로 박아 자기모순을 일으켰음)
  const CATEGORY_HAPPEN_PAT = {
    'FDA': /FDA|식약처|승인|허가|CRL|심사\s*결과|임상\s*결과/,
    'IPO': /상장|ADR|IPO|나스닥\s*상장/,
    '실적': /실적|잠정|영업이익|매출|순이익|EPS|어닝/,
    '편입': /편입|MSCI|나스닥100/,
    '정책': /정책|법안|시행|규제/,
    'M&A': /인수|합병|M&A|지분\s*취득/,
  };
  // "임박·예정·전망" 등 미래형 표현이 붙은 기사는 카테고리 키워드가 있어도 아직 안 벌어진 것 —
  // (예: "SK하이닉스 ADR 상장 임박" 오탐 방지).
  const NOT_HAPPENED_YET = /예정|임박|앞두고|앞서|전망|기대|추진\s*중|곧|예상|앞둔|D-\d/;
  if (news?.length) {
    const { data: openCatalysts } = await supabase.from('catalysts')
      .select('id, company, category').eq('status', 'upcoming');
    const titles2 = news.map(n => n.title).filter(Boolean);
    const toResolve = (openCatalysts || []).filter(c => {
      const pat = c.company && CATEGORY_HAPPEN_PAT[c.category];
      return pat && titles2.some(t => t.includes(c.company) && pat.test(t) && !NOT_HAPPENED_YET.test(t));
    });
    if (toResolve.length) {
      await supabase.from('catalysts')
        .update({ status: 'passed', updated_at: new Date().toISOString() })
        .in('id', toResolve.map(c => c.id));
    }
  }

  // (c) 최근 뉴스 제목 → forward catalyst AI 추출
  if (!(await isFeatureEnabled(supabase, 'catalysts'))) {
    return res.status(200).json({ ok: true, aiExtract: false, reason: 'disabled' });
  }
  if (!news?.length) return res.status(200).json({ ok: true, aiExtract: true, added: 0, reason: 'no news' });

  // 신선도 가드: 매시간 크론이 불러도 3시간 이내 재추출은 스킵 — 예정 이벤트는 시간 단위로
  // 안 바뀌므로 매시간 다시 뽑을 이유가 없음(기존엔 가드가 아예 없어 상시 비용의 큰 축이었음).
  // catalysts 테이블 자체의 최신 row로는 "마지막 시도 시각"을 알 수 없어(새로 뽑을 게
  // 없으면 새 row가 안 생김) 별도 상태 테이블로 추적.
  if (!req.body?.force) {
    const { data: state } = await supabase.from('catalysts_extraction_state').select('last_extracted_at').eq('id', 1).maybeSingle();
    if (state?.last_extracted_at && Date.now() - new Date(state.last_extracted_at).getTime() < 3 * 3600 * 1000) {
      return res.status(200).json({ ok: true, aiExtract: false, reason: 'fresh', ageMin: Math.round((Date.now() - new Date(state.last_extracted_at).getTime()) / 60000) });
    }
  }
  // 호출 자체(성공/실패 무관)를 먼저 기록 — 실패해도 매시간 재시도가 몰리지 않도록
  await supabase.from('catalysts_extraction_state').upsert({ id: 1, last_extracted_at: new Date().toISOString() });

  const { data: existing } = await supabase.from('catalysts').select('title, ticker').eq('status', 'upcoming').limit(60);
  const existingStr = (existing || []).map(e => `- ${e.ticker || ''} ${e.title}`).join('\n');
  const titles = news.map(n => n.title).filter(Boolean).slice(0, 260).join('\n');

  const dynamic = `아래 최근 2주 금융 뉴스 제목에서 "앞으로 예정된 대형 catalyst"만 추출하세요.
대상: FDA/식약처 심사·PDUFA, 상장/IPO/ADR/나스닥 상장, 지수 편입(MSCI/나스닥100 등), 잠정/정식 실적발표 예정, 대형 정책 시행, 대형 M&A 종결.
제외: 이미 벌어진 일, 단순 시황/전망 기사.

날짜 원칙 (매우 중요):
- event_date는 뉴스 제목에 "구체적 날짜(예: 7월 23일, 2026-07-10)"가 명확히 적힌 경우에만 YYYY-MM-DD로 채운다.
- 날짜가 애매/추정/미확정이거나 뉴스마다 엇갈리면 event_date=null 로 두고 date_text에 불확실성을 명시한다(예: "7월 말(미확정)", "7월 초 잠정").
- 날짜를 추측하거나 창작하지 말 것. 확실하지 않으면 무조건 null.
- 각 항목은 근거가 된 뉴스 제목의 요지를 source에 반드시 남긴다. source가 없으면 그 항목은 추출하지 않는다.

이미 등록된 것(중복 추출 금지):
${existingStr || '(없음)'}

JSON만 반환 (다른 텍스트 없이):
{"catalysts":[{"market":"KR|US|GLOBAL","ticker":"티커 또는 null","company":"기업명","title":"이벤트(35자내)","category":"FDA|IPO|실적|편입|정책|M&A|기타","event_date":"YYYY-MM-DD 또는 null","date_text":"시점/불확실성 표기 또는 null","importance":1|2|3,"source":"근거 뉴스 제목 요지"}]}

뉴스 제목:
${titles.slice(0, 14000)}`;

  const result = await submitAgentJob({
    pipeline: 'catalysts',
    items: [{ itemId: 'main', static: '', dynamic }],
    payload: { today },
  });
  return res.status(200).json({ ok: true, aiExtract: false, queued: result.submitted, reason: result.reason });
}

async function finalizeCatalysts(row) {
  const text = extractJobText(row, 'main');
  if (!text) throw new Error('No agent response for catalysts');
  const parsed = parseJobJson(text);
  const today = row.payload?.today || catalystTodayKST();

  const rows = (parsed.catalysts || []).map(c => normalizeCatalystRow(c, 'ai')).filter(Boolean)
    .filter(r => !r.event_date || r.event_date >= today);
  let added = 0;
  if (rows.length) {
    const { error, count } = await supabase.from('catalysts')
      .upsert(rows, { onConflict: 'dedupe_key', ignoreDuplicates: true, count: 'exact' });
    if (!error) added = count ?? rows.length;
  }
  return { candidates: rows.length, added };
}

// ════════════════════════════════════════════════════════════
// 20) 장중 실시간 수집 트리거 (브라우저 구동)
// ════════════════════════════════════════════════════════════
let _liveLastTrigger = 0;   // 워밍 인스턴스 내 버스트 방지(베스트에포트)

// KR 09:00–15:40 KST / US 09:30–16:00 ET (평일) 정규장 여부
function liveMarketState() {
  const now = new Date();
  const parse = tz => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
    const g = t => p.find(x => x.type === t)?.value;
    return { wd: g('weekday'), min: (parseInt(g('hour')) % 24) * 60 + parseInt(g('minute')) };
  };
  const wk = w => w !== 'Sat' && w !== 'Sun';
  const kr = parse('Asia/Seoul'), us = parse('America/New_York');
  const krOpen = wk(kr.wd) && kr.min >= 540 && kr.min <= 940;   // 09:00–15:40 (마감 직후까지 여유)
  const usOpen = wk(us.wd) && us.min >= 570 && us.min < 960;    // 09:30–16:00
  return { krOpen, usOpen, any: krOpen || usOpen };
}

// ── 코스피200 선물 ±5% 감지 → 사이드카 "발동 조건" 조기경보 ──────────────
// 진짜 KRX 사이드카는 뉴스보다 훨씬 빠르니, 뉴스 키워드 감지(analyze.js)와
// 별개로 선물 급변을 직접 봐서 먼저 배너를 켠다. 다만 이건 KRX가 공식
// 발동을 선언한 게 아니라 "발동 조건에 해당하는 변동폭이 감지됐다"는
// 근사치다 — 1분 지속 여부까지 확인하는 게 아니라 라이브 리프레시가 호출될
// 때(방문자가 있을 때마다, 최소 90초 간격)마다 순간 변동률만 본다.
let _futuresLastCheck = 0;
const SIDECAR_THRESHOLD = 5; // KRX 규정: 선물 전일종가 대비 ±5%
async function checkFuturesSidecar() {
  const now = Date.now();
  if (now - _futuresLastCheck < 90000) return;
  _futuresLastCheck = now;

  // KRX 사이드카는 09:05~14:50(종료 40분 전까지)에만 유효
  const kst = new Date(now + 9 * 3600000);
  const minOfDay = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  if (minOfDay < 545 || minOfDay > 890) return;

  try {
    const r = await fetch('https://polling.finance.naver.com/api/realtime/domestic/index/FUT', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    const d = j?.datas?.[0];
    const ratio = parseFloat(d?.fluctuationsRatioRaw);
    // marketStatus는 이미 위에서 KR 정규장 시간대로 걸러졌으니 여기선 값 유효성만 확인
    if (!d || isNaN(ratio) || Math.abs(ratio) < SIDECAR_THRESHOLD) return;

    const { data: cur } = await supabase.from('site_announcement').select('active, source, auto_expires_at').eq('id', 1).maybeSingle();
    if (cur?.source === 'manual') {
      if (cur.active) return; // 관리자가 켠 배너 보존
      // 관리자가 방금 끈 배너 — auto_expires_at을 뮤트 마감시각으로 사용(handleSetAnnouncement 참고).
      // 이게 없으면 다음 90초 리프레시에서 조건이 여전히 참이라 바로 다시 켜져버린다.
      if (cur.auto_expires_at && new Date(cur.auto_expires_at) > new Date()) return;
    }

    const dir = ratio > 0 ? '매수' : '매도';
    const message = `🚨 [속보] 코스피200 선물 ${ratio > 0 ? '+' : ''}${ratio.toFixed(2)}% — ${dir}사이드카 발동 조건 감지 (KRX 공식 확인 전)`;
    const startedAt = new Date().toISOString();
    await supabase.from('site_announcement').upsert({
      id: 1, active: true, message, source: 'auto', source_issue_id: null,
      auto_expires_at: new Date(now + 2 * 3600000).toISOString(), updated_at: startedAt,
    });
    if (!cur?.active) {
      await supabase.from('announcement_log').update({ ended_at: startedAt }).is('ended_at', null);
      await supabase.from('announcement_log').insert({ source: 'auto', message, started_at: startedAt });
    }
  } catch (e) {
    console.error('futures sidecar check failed:', e.message);
  }
}

async function handleLiveRefresh(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const mk = liveMarketState();
  if (!mk.any) return res.status(200).json({ ok: true, triggered: false, reason: 'market closed' });
  if (mk.krOpen) checkFuturesSidecar().catch(() => {}); // 뉴스 수집 스로틀과 무관하게 항상 시도(자체 90s 게이트 有)

  const now = Date.now();
  // (1) 인스턴스 버스트 방지: 같은 워밍 인스턴스에서 60s 내 재호출 차단
  if (now - _liveLastTrigger < 60000) {
    return res.status(200).json({ ok: true, triggered: false, reason: 'throttled' });
  }
  // (2) 인스턴스 간 레이트리밋: 최근 75s 내 수집된 이슈가 있으면 이미 방금 수집된 것 → 스킵
  try {
    const { data: recent } = await supabase.from('issues')
      .select('created_at').order('created_at', { ascending: false }).limit(1);
    const lastMs = recent?.[0]?.created_at ? new Date(recent[0].created_at).getTime() : 0;
    if (now - lastMs < 75000) {
      _liveLastTrigger = now;
      return res.status(200).json({ ok: true, triggered: false, reason: 'recently collected', ageSec: Math.round((now - lastMs) / 1000) });
    }
  } catch { /* 조회 실패해도 아래로 진행 */ }

  _liveLastTrigger = now;
  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `https://${req.headers.host}`;
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ADMIN_SECRET}` };
  const faf = (path, body) => {
    fetch(`${base}${path}`, { method: 'POST', headers: authHeaders, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(55000) }).catch(() => {});
  };
  // RSS 수집(무료) + 소량 분석 큐 적재 — agent-submit은 Anthropic을 호출하지 않고
  // analyze_batches(engine='agent')에 프롬프트만 쌓는다(비용 없음). 이전엔 동기 경로
  // (limit:2, max_chain:1)로 방문자 트래픽마다 실제 Claude를 호출해 비용이 났었음
  // (75s 크로스인스턴스 게이트가 있어도 동시접속자가 많으면 배수로 불어남 — 2026-07).
  // 즉시성은 포기하되(스케줄 에이전트가 큐를 비울 때까지 대기) 비용은 0으로.
  faf('/api/fetch?type=rss');
  faf('/api/analyze?mode=agent-submit', { limit: 2 });
  // AI 시장 종합도 함께 갱신(서버 3h 신선도 가드로 Claude는 최대 3시간에 1회만) — 장중 브라우저가 열려 있으면 자동 최신화
  faf('/api/admin?action=ai-market-summary');
  return res.status(200).json({ ok: true, triggered: true, market: mk.krOpen ? 'KR' : 'US' });
}

async function handleDailyReportGet(req, res) {
  const market = ((req.query?.market || 'US') + '').toUpperCase() === 'KR' ? 'KR' : 'US';
  const history = Math.min(parseInt(req.query?.history) || 0, 90);

  if (history > 0) {
    const { data } = await supabase
      .from('daily_reports').select('*')
      .eq('market', market)
      .order('report_date', { ascending: false }).limit(history);
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ ok: true, market, items: data || [] });
  }

  const date = ((req.query?.date || '') + '').slice(0, 10);
  let q = supabase.from('daily_reports').select('*').eq('market', market);
  const { data } = date
    ? await q.eq('report_date', date).maybeSingle()
    : await q.order('report_date', { ascending: false }).limit(1).maybeSingle();
  if (!data) {
    // 404를 CDN에 캐시하면 리포트 생성 직후에도 한동안 "없음"으로 보임
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'No report yet' });
  }
  // 최신 리포트는 재생성 직후 빨리 반영되도록 짧게 캐시 (기존 600s는 재생성 후 최대 10분 stale)
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  return res.status(200).json({ ok: true, ...data });
}

async function handleDailyReportPost(req, res) {
  if (!(await isFeatureEnabled(supabase, 'daily_report'))) {
    return res.status(200).json({ ok: true, generated: false, reason: 'disabled' });
  }

  const market = ((req.body?.market || req.query?.market || 'US') + '').toUpperCase() === 'KR' ? 'KR' : 'US';
  // focus='earnings' — 미장 마감+실적 발표가 몰리는 새벽 슬롯(KST 7:15)용 변형. 별도 리포트/테이블이
  // 아니라 같은 daily_reports 행에 실적 뉴스 비중을 높인 프롬프트로 덮어쓰는 것뿐(upsert라 안전).
  const focus = ((req.body?.focus || req.query?.focus || '') + '').toLowerCase() === 'earnings' ? 'earnings' : null;
  // 과거 날짜 소급 생성용(예: 크레딧 소진으로 놓친 날) — date를 명시하면 그 날짜로 라벨링하고,
  // 뉴스 수집 창도 그 거래일(해당 시장 타임존 00:00~24:00) 하루로 정확히 좁힌다.
  // 안 주면 기존 그대로 "오늘 날짜 + 최근 24h" 자동 생성 동작 (매일 cron이 쓰는 기본 경로는 변경 없음).
  const overrideDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.date || '') ? req.body.date : null;
  const reportDate = overrideDate || drReportDate(market);
  const marketLabel = market === 'KR' ? '한국 증시(국장)' : '미국 증시(미장)';

  // 1) 실제 지수 마감 데이터 (AI가 지어내지 않도록 직접 수집)
  const indices = (await Promise.all(
    DR_INDICES[market].map(x => fetchDrIndexQuote(x.symbol, x.name))
  )).filter(Boolean);

  // 2) 뉴스 수집 창 — 기본은 최근 24h, date 백필 시에는 그 거래일 하루로 정확히 좁힘
  let issuesQuery = supabase
    .from('issues')
    .select('title, summary, sectors, published_at, analyses(ai_summary, confidence_score)')
    .eq('is_analyzed', true);
  if (overrideDate) {
    const tz = market === 'KR' ? 'Asia/Seoul' : 'America/New_York';
    const { startUtc, endUtc } = localDayBoundsUtc(overrideDate, tz);
    issuesQuery = issuesQuery.gte('published_at', startUtc.toISOString()).lte('published_at', endUtc.toISOString());
  } else {
    issuesQuery = issuesQuery.gte('published_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  }
  const { data: issues } = await issuesQuery
    .order('published_at', { ascending: false })
    .limit(60);

  if (!issues?.length && !indices.length) {
    return res.status(200).json({ ok: true, generated: false, reason: 'No recent issues or index data' });
  }

  const ctx = (issues || []).map(i => {
    return `[${(i.published_at || '').slice(0, 16)}] ${i.title}\n  ${i.analyses?.[0]?.ai_summary || i.summary || ''}`.slice(0, 400);
  }).join('\n\n');

  const idxStr = indices.map(i =>
    `${i.name}: ${i.price}${i.changePercent != null ? ` (${i.changePercent >= 0 ? '+' : ''}${i.changePercent}%)` : ''}`
  ).join(' | ');

  // 다가오는 대형 catalyst — 오늘 뉴스에 없어도 리포트가 미리 surface하도록 주입
  const upcoming = await fetchUpcomingCatalysts(market);
  const catStr = upcoming.length
    ? upcoming.slice(0, 12).map(c => {
        const when = c.event_date || c.date_text || '시점 미정';
        const imp = c.importance >= 3 ? '★★★' : c.importance === 2 ? '★★' : '★';
        return `- [${imp}] (${when}) ${c.company ? c.company + ' — ' : ''}${c.title}${c.category ? ` [${c.category}]` : ''}`;
      }).join('\n')
    : '(등록된 예정 catalyst 없음)';

  const prompt = `당신은 한국어 금융 시장 분석가입니다. ${reportDate}일자 ${marketLabel} 장 마감 데일리 리포트를 작성하세요.

■ 실제 지수 마감 데이터 (이 수치만 사용, 지어내지 말 것):
${idxStr || '(지수 데이터 없음)'}

■ 다가오는 대형 catalyst (예정 이벤트 — 오늘 뉴스에 없더라도 시장이 주목하는 핵심):
${catStr}

■ 지난 24시간 뉴스/이슈 ${issues?.length || 0}건:
${ctx.slice(0, 10000)}

작성 지침:
1. ${marketLabel}과 직접 관련된 내용 위주. 관련 없는 이슈는 제외.
2. 오늘의 가장 큰 동인(핵심 catalyst) 1~2개를 먼저 판별해 headline과 recap 맨 앞에 세울 것 — 단순 나열 금지.
3. 위 "예정 catalyst" 중 이 시장에 중요한 것(특히 ★★★)은 반드시 upcoming_catalysts에 반영하고, 필요하면 tomorrow에도 언급.
   단, "지난 24시간 뉴스"에 그 catalyst가 이미 실제로 발생(실적 발표됨·FDA 결과 나옴·상장 완료 등)했다는
   내용이 있으면 — 그 사실은 이미 recap/top_events에 반영했을 것이므로 — upcoming_catalysts에는
   "예정"인 것처럼 다시 넣지 말고 제외한다. 같은 리포트 안에서 "이미 발표됨"과 "예정"을 동시에
   말하는 자기모순을 절대 만들지 말 것.
4. 사실 기반·객관적·한국어. 추측/날짜 창작 금지 — 지수·본문·catalyst 목록에 있는 것만 사용.${focus === 'earnings' ? `
5. ⭐ 이번 리포트는 장 마감 직후 실적 발표가 몰리는 시간대에 생성됩니다. "지난 24시간 뉴스"에 있는
   실적 발표(어닝서프라이즈/쇼크, 가이던스 상향·하향, EPS·매출 발표 등) 관련 이슈를 최우선으로
   추려서 headline·recap·top_events에 반영하세요. 실적 발표가 없는 날이면 이 지침은 무시하고
   평소처럼 가장 큰 동인 위주로 작성.` : ''}

다음 JSON만 반환 (다른 텍스트 없이):
{
  "headline": "오늘 ${marketLabel}의 가장 큰 동인을 담은 한 문장 (40자 내외)",
  "mood": "상승 또는 하락 또는 혼조 (지수 데이터 기준)",
  "recap": ["가장 큰 동인부터, 오늘 시장 흐름 요약 문장 1", "문장 2", "문장 3"],
  "top_events": ["오늘 주요 이벤트/뉴스 1 (한 문장)", "이벤트 2", "이벤트 3"],
  "sector_notes": ["섹터/종목 특징 1", "특징 2"],
  "upcoming_catalysts": ["다가오는 핵심 이벤트(시점 포함, 예: 'HLB FDA 재심사 결과 — 7월 말') 1", "이벤트 2", "이벤트 3"],
  "tomorrow": ["다음 거래일 관전 포인트 1", "포인트 2"]
}`;

  const result = await submitAgentJob({
    pipeline: 'daily_report',
    items: [{ itemId: 'main', static: '', dynamic: prompt }],
    payload: {
      market, reportDate, indices,
      based_on_issues: issues?.length || 0,
      overrideDate,
    },
  });
  return res.status(200).json({ ok: true, generated: false, queued: result.submitted, reason: result.reason });
}

async function finalizeDailyReport(row) {
  const text = extractJobText(row, 'main');
  if (!text) throw new Error('No agent response for daily_report');
  const parsed = parseJobJson(text);
  const { market, reportDate, indices, based_on_issues, overrideDate } = row.payload || {};

  const dbRow = {
    market,
    report_date: reportDate,
    headline: parsed.headline || '',
    mood: ['상승', '하락', '혼조'].includes(parsed.mood) ? parsed.mood : '혼조',
    indices,
    recap: parsed.recap || [],
    top_events: parsed.top_events || [],
    sector_notes: parsed.sector_notes || [],
    catalysts: Array.isArray(parsed.upcoming_catalysts) ? parsed.upcoming_catalysts.slice(0, 6) : [],
    tomorrow: parsed.tomorrow || [],
    based_on_issues: based_on_issues || 0,
    created_at: overrideDate
      ? `${overrideDate}T${market === 'KR' ? '07:40:00' : '21:10:00'}Z`
      : new Date().toISOString(),
  };
  let { error } = await supabase.from('daily_reports').upsert(dbRow, { onConflict: 'market,report_date' });
  if (error && /catalysts/i.test(error.message || '')) {
    const { catalysts, ...rowNoCat } = dbRow;
    ({ error } = await supabase.from('daily_reports').upsert(rowNoCat, { onConflict: 'market,report_date' }));
  }
  if (error) throw new Error('DB upsert failed: ' + error.message);
  return dbRow;
}

// ════════════════════════════════════════════════════════════
// 20) AI 기능 on/off — Claude 토큰을 쓰는 자동 파이프라인 개별/일괄 제어
//     (lib/feature-flags.js의 각 핸들러가 실제 Claude 호출 직전에 이 값을 확인)
// ════════════════════════════════════════════════════════════
async function handleFeatureFlagsGet(req, res) {
  const { data } = await supabase.from('feature_flags').select('key, enabled, updated_at');
  const byKey = Object.fromEntries((data || []).map(r => [r.key, r]));
  const flags = FEATURE_FLAG_DEFS.map(d => ({
    key: d.key,
    label: d.label,
    enabled: byKey[d.key]?.enabled !== false,   // 행 없으면(마이그레이션 전) 기본 활성화
    updated_at: byKey[d.key]?.updated_at || null,
  }));
  return res.status(200).json({ ok: true, flags });
}

async function handleFeatureFlagsPost(req, res) {
  const { key, keys, enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled(boolean) required' });

  const validKeys = new Set(FEATURE_FLAG_DEFS.map(d => d.key));
  // key/keys를 안 주면 "전체" — 대시보드의 일괄 on/off 버튼이 쓰는 경로.
  const targetKeys = key ? [key] : Array.isArray(keys) ? keys : [...validKeys];
  const rows = targetKeys.filter(k => validKeys.has(k))
    .map(k => ({ key: k, enabled, updated_at: new Date().toISOString() }));
  if (!rows.length) return res.status(400).json({ error: 'no valid keys' });

  const { error } = await supabase.from('feature_flags').upsert(rows, { onConflict: 'key' });
  if (error) return res.status(500).json({ error: 'feature_flags upsert 실패: ' + error.message + ' (db/feature-flags.sql 실행 여부 확인)' });
  return res.status(200).json({ ok: true, updated: rows.map(r => r.key), enabled });
}

// ════════════════════════════════════════════════════════════
// 21) agent_jobs 폴링 — analyze.js의 batch-poll과 별개. extract_investments/
//     ai_market_summary/weekly_schedule/catalysts/daily_report/company_summary
//     6개 파이프라인 공용. 스케줄 Claude Code 에이전트가 response를 채운 job을
//     파이프라인별 finalize 함수로 완료 처리(DB 저장까지)한다.
// ════════════════════════════════════════════════════════════
const AGENT_JOB_FINALIZERS = {
  extract_investments: { main: finalizeExtractInvestments },
  ai_market_summary:   { main: finalizeAiMarketSummary },
  catalysts:           { main: finalizeCatalysts },
  daily_report:        { main: finalizeDailyReport },
  weekly_schedule:      { events: finalizeWeeklyScheduleEvents, highlights: finalizeWeeklyScheduleHighlights },
};

// claim(submitted→processing) 직후 finalize 도중 함수가 죽으면(Vercel 타임아웃 등) 그 row는
// response가 이미 있는데도 status만 processing에 영구히 멈춰 다음 poll의 select(status=submitted)에
// 아예 안 걸리는 버그가 있었다(id=99 실사례, 2026-07-15). finalize는 DB upsert 한 번뿐이라 몇 초면
// 끝나야 정상이므로, 이 시간을 넘겨 processing인 row는 죽은 것으로 보고 같은 poll에서 바로 재시도한다.
const PROCESSING_STUCK_TIMEOUT_MS = 10 * 60 * 1000;

async function handleAgentPoll(req, res) {
  const { data: rows, error } = await supabase.from('agent_jobs').select('*')
    .in('status', ['submitted', 'processing']).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: 'agent_jobs table not ready: ' + error.message });
  if (!rows?.length) return res.status(200).json({ ok: true, checked: 0 });

  const outcomes = [];
  for (const row of rows) {
    const age = Date.now() - new Date(row.created_at).getTime();

    // 방금 다른(동시) poll 호출이 claim해서 아직 finalize 중일 수 있는 신선한 processing → 건드리지 않고 대기
    if (row.status === 'processing' && age <= PROCESSING_STUCK_TIMEOUT_MS) {
      outcomes.push({ id: row.id, pipeline: row.pipeline, stage: row.stage, status: 'processing' });
      continue;
    }

    if (!row.response) {
      if (age > JOB_STUCK_TIMEOUT_MS) {
        const { data: claimed } = await supabase.from('agent_jobs')
          .update({ status: 'timeout', completed_at: new Date().toISOString() })
          .eq('id', row.id).eq('status', row.status).select();
        outcomes.push({ id: row.id, pipeline: row.pipeline, stage: row.stage, status: claimed?.length ? 'timeout' : 'already_claimed' });
      } else {
        outcomes.push({ id: row.id, pipeline: row.pipeline, stage: row.stage, status: 'processing' });
      }
      continue;
    }

    const { data: claimed } = await supabase.from('agent_jobs')
      .update({ status: 'processing' }).eq('id', row.id).eq('status', row.status).select();
    if (!claimed?.length) { outcomes.push({ id: row.id, pipeline: row.pipeline, stage: row.stage, status: 'already_claimed' }); continue; }

    try {
      // company_summary는 stage에 티커가 들어가므로 finalizer는 pipeline만으로 고정 조회
      const finalizer = row.pipeline === 'company_summary'
        ? finalizeCompanySummary
        : AGENT_JOB_FINALIZERS[row.pipeline]?.[row.stage];
      if (!finalizer) throw new Error(`no finalizer for ${row.pipeline}/${row.stage}`);
      const result = await finalizer(row, req);
      await supabase.from('agent_jobs').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', row.id);
      outcomes.push({ id: row.id, pipeline: row.pipeline, stage: row.stage, status: 'completed', result });
    } catch (e) {
      await supabase.from('agent_jobs').update({ status: 'submitted' }).eq('id', row.id);
      outcomes.push({ id: row.id, pipeline: row.pipeline, stage: row.stage, status: 'error', error: e.message });
    }
  }
  return res.status(200).json({ ok: true, checked: rows.length, outcomes });
}
