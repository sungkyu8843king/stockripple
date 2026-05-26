/**
 * 종합 수집 + 분석 파이프라인 (Vercel Cron / 수동 트리거)
 * 순서:
 *  1. fetch-news  — NewsAPI 키워드 수집 (트럼프·경제·실적·섹터)
 *  2. fetch-rss   — RSS 피드 수집 (국내외 + Truth Social)
 *  3. collect-events — 경제지표 발표 결과 + 기업실적 결과 + 트럼프 신글 저장 (인라인)
 *  4. analyze     — 미분석 이슈 AI 분석 (limit 8)
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

  const log = {};

  // 1. 뉴스 수집 (병렬)
  const [newsData, rssData] = await Promise.all([
    call('/api/fetch?type=news'),
    call('/api/fetch?type=rss'),
  ]);
  log.news = newsData;
  log.rss  = rssData;

  // 2. 실시간 이벤트 수집 (경제지표·실적·트럼프) + 즉시 분석
  log.events = await collectEvents(base);

  // 3. 남은 미분석 이슈 추가 분석
  await new Promise(r => setTimeout(r, 1000));
  log.analyze = await call('/api/analyze', { limit: 20 });

  // 4. 정확도 체크
  await new Promise(r => setTimeout(r, 1000));
  log.accuracy = await call('/api/check-accuracy');

  return res.status(200).json({
    success: true,
    timestamp: new Date().toISOString(),
    ...log,
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
