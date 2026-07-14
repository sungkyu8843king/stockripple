/**
 * 종합 수집 + 분석 파이프라인 (Vercel Cron / 수동 트리거)
 * 순서:
 *  1. fetch-news  — NewsAPI 키워드 수집 (트럼프·경제·실적·섹터)
 *  2. fetch-rss   — RSS 피드 수집 (국내외 + Truth Social)
 *  3. collect-events — 경제지표 발표 결과 + 기업실적 결과 + 트럼프 신글 저장 (인라인)
 *  4. analyze     — 미분석 이슈 AI 분석 (1회 5건 × 최대 4회 자기 체이닝 = 최대 20건/일)
 *  5. check-accuracy — 기존 분석 정확도 업데이트
 */
import { createClient } from '@supabase/supabase-js';
import { verifyAdmin } from '../lib/auth.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  const result = await verifyAdmin(req.headers.authorization);
  if (!result.ok) return res.status(401).json({ error: result.error });

  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : `https://${req.headers.host}`;

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.ADMIN_SECRET}`,
  };

  const call = async (path, body = null) => {
    try {
      const opts = { method: 'POST', headers: authHeaders, signal: AbortSignal.timeout(55000) };
      if (body) opts.body = JSON.stringify(body);
      const r = await fetch(`${base}${path}`, opts);
      return r.ok ? await r.json() : { error: `HTTP ${r.status}` };
    } catch (e) {
      return { error: e.message };
    }
  };

  // 모든 작업을 fire-and-forget으로 즉시 발사 후 바로 응답
  // — 각 API는 독립적으로 60s 예산을 가짐 (vercel.json maxDuration 설정)
  // — cron-daily 자체는 3~5초 안에 200 응답 반환 (timeout 없음)
  const faf = (path, body) => {
    fetch(`${base}${path}`, {
      method: 'POST', headers: authHeaders,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(55000),
    }).catch(() => {});
  };

  faf('/api/fetch?type=news');
  faf('/api/fetch?type=rss');
  faf('/api/market-pulse?type=trump');
  // Claude Code 에이전트 큐에 제출만 하고 끝 — Anthropic 비용 없음. 완료 처리는
  // analyze-backlog.yml의 10분 주기 폴링(mode=batch-poll)이 이어받는다.
  faf('/api/analyze?mode=agent-submit', { limit: 30 });
  faf('/api/admin?action=extract-investments', { since_hours: 48, max: 25 });
  faf('/api/admin?action=dart-poll', { days: 2 });
  faf('/api/admin?action=dart-sync-corp-codes');  // 신규 KR 종목의 corp_code 자동 매핑 (예: 히트맵에 추가된 HLB류)
  faf('/api/admin?action=ai-market-summary');
  faf('/api/check-accuracy');

  // 주간 일정: 토·일은 다음 주 생성, 평일은 진행 중인 주 갱신 (지표 늦게 열리는 경우 자동 보충)
  faf('/api/admin?action=weekly-schedule');
  // 예정 catalyst: 지난 이벤트 정리 + 최근 뉴스에서 forward catalyst 자동 추출
  faf('/api/admin?action=catalysts');

  const jobs = ['fetch-news','fetch-rss','trump','analyze','extract-investments','dart-poll','dart-sync-corp-codes','ai-market-summary','check-accuracy','weekly-schedule','catalysts'];
  return res.status(200).json({
    success: true,
    timestamp: new Date().toISOString(),
    message: `${jobs.length}개 작업을 백그라운드에서 실행 중 (각각 독립 실행, 최대 55초)`,
    jobs,
  });
}

// ─── Inlined collect-events logic ────────────────────────────────────────
async function collectEvents(base) {
  const results = { trump: 0, economic: 0, earnings: 0, analyzed: 0, errors: [] };

  // 1. 트럼프 Truth Social 신규 글
  try {
    const r = await fetch(`${base}/api/market-pulse?type=trump`, { signal: AbortSignal.timeout(12000) });
    const j = await r.json();
    for (const post of j.items || []) {
      if (!post.text || !post.publishedAt) continue;
      const age = Date.now() - new Date(post.publishedAt).getTime();
      if (age > 6 * 3600 * 1000) continue;

      const { data: exists } = await supabase.from('issues').select('id')
        .eq('source_url', post.link).maybeSingle();
      if (exists) continue;

      const title = `[트럼프] ${post.text.slice(0, 120)}${post.text.length > 120 ? '…' : ''}`;
      const { error } = await supabase.from('issues').insert({
        title,
        summary: post.text.slice(0, 800),
        source_url: post.link,
        source_name: 'Truth Social',
        published_at: post.publishedAt,
        sectors: ['정치·외교', '트럼프', '미국'],
        tags: ['Trump', 'TruthSocial', '트럼프', '관세', '무역'],
        is_analyzed: false,
      });
      if (!error) results.trump++;
    }
  } catch (e) { results.errors.push(`Trump: ${e.message}`); }

  // 2. 경제지표 발표 결과 수집
  try {
    const r = await fetch(`${base}/api/market-pulse?type=economic`, { signal: AbortSignal.timeout(12000) });
    const j = await r.json();

    for (const item of j.items || []) {
      if (!item.actual || !item.date) continue;
      const age = Date.now() - new Date(item.date).getTime();
      if (age > 7 * 86400 * 1000 || age < 0) continue;

      const { data: exists } = await supabase.from('issues').select('id')
        .ilike('title', `%${item.titleKo || item.title}%`)
        .ilike('title', `%${item.actual}%`)
        .maybeSingle();
      if (exists) continue;

      const beatMiss = (() => {
        if (!item.forecast) return '';
        const a = parseFloat(item.actual.replace(/[^0-9.\-]/g, ''));
        const f = parseFloat(item.forecast.replace(/[^0-9.\-]/g, ''));
        if (isNaN(a) || isNaN(f)) return '';
        const diff = a - f;
        if (Math.abs(diff) < 0.001) return ' (예상 부합)';
        return (item.lowerIsBetter ? diff < 0 : diff > 0)
          ? ' ▲ 예상 상회' : ' ▼ 예상 하회';
      })();

      const flag = { USD:'🇺🇸', EUR:'🇪🇺', JPY:'🇯🇵' }[item.country] || item.country;
      const title = `${flag} [경제지표] ${item.titleKo || item.title}: ${item.actual}${beatMiss}`;
      const summary = [
        `발표: ${item.actual}`,
        item.forecast ? `예상: ${item.forecast}` : null,
        item.previous ? `이전: ${item.previous}` : null,
        beatMiss ? beatMiss.trim() : null,
      ].filter(Boolean).join(' | ');

      const countryLabel = { USD:'미국경제', EUR:'유럽경제', JPY:'일본경제' }[item.country] || '글로벌';
      const { error } = await supabase.from('issues').insert({
        title,
        summary,
        source_url: `https://www.forexfactory.com/calendar`,
        source_name: 'ForexFactory',
        published_at: new Date(item.date).toISOString(),
        sectors: ['경제지표', countryLabel, item.impact === 'High' ? '고영향' : '중영향'],
        tags: [item.title, item.country, '경제지표'],
        is_analyzed: false,
      });
      if (!error) results.economic++;
    }
  } catch (e) { results.errors.push(`Economic: ${e.message}`); }

  // 3. 기업 실적 발표 결과 수집
  try {
    const r = await fetch(`${base}/api/earnings`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();

    for (const item of j.items || []) {
      if (!item.epsActual || !item.date) continue;
      const age = Date.now() - new Date(item.date).getTime();
      if (age > 7 * 86400 * 1000 || age < 0) continue;

      const { data: exists } = await supabase.from('issues').select('id')
        .ilike('title', `%${item.ticker}%실적%`)
        .gte('published_at', new Date(Date.now() - 14 * 86400 * 1000).toISOString())
        .maybeSingle();
      if (exists) continue;

      const consensus = item.epsConsensus ?? item.epsEstimate ?? null;
      const beatMiss = consensus != null
        ? (item.epsActual >= consensus ? ' ▲ 어닝서프라이즈' : ' ▼ 어닝쇼크')
        : '';

      const title = `[실적] ${item.company || item.ticker} EPS $${Number(item.epsActual).toFixed(2)}${beatMiss}`;
      const summaryParts = [
        `EPS 발표: $${Number(item.epsActual).toFixed(2)}`,
        consensus != null ? `컨센서스: $${Number(consensus).toFixed(2)}` : null,
        item.revEstimate ? `매출 예상: $${(item.revEstimate/1e9).toFixed(1)}B` : null,
        item.callTime === 'BMO' ? '장전 발표' : item.callTime === 'AMC' ? '장후 발표' : null,
      ].filter(Boolean).join(' | ');

      const { error } = await supabase.from('issues').insert({
        title,
        summary: summaryParts,
        source_url: `https://finance.yahoo.com/quote/${item.ticker}/financials`,
        source_name: 'Yahoo Finance',
        published_at: new Date(item.date).toISOString(),
        sectors: ['실적발표', '주식', item.ticker],
        tags: [item.ticker, item.company || item.ticker, '실적', 'earnings'],
        is_analyzed: false,
      });
      if (!error) results.earnings++;
    }
  } catch (e) { results.errors.push(`Earnings: ${e.message}`); }

  // 4. 새로 저장된 이슈 즉시 AI 분석
  const totalNew = results.trump + results.economic + results.earnings;
  if (totalNew > 0) {
    try {
      const analyzeRes = await fetch(`${base}/api/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.ADMIN_SECRET}`,
        },
        body: JSON.stringify({ limit: Math.min(totalNew + 5, 20) }),
        signal: AbortSignal.timeout(60000),
      });
      const analyzeData = await analyzeRes.json();
      results.analyzed = analyzeData.analyzed || 0;
      if (analyzeData.errors?.length) {
        results.errors.push(...analyzeData.errors.slice(0, 3));
      }
    } catch (e) { results.errors.push(`Analyze: ${e.message}`); }
  }

  return { ok: true, ...results, ts: new Date().toISOString() };
}
