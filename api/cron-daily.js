/**
 * 종합 수집 + 분석 파이프라인 (Vercel Cron / 수동 트리거)
 * 순서:
 *  1. fetch-news  — NewsAPI 키워드 수집 (트럼프·경제·실적·섹터)
 *  2. fetch-rss   — RSS 피드 수집 (국내외 + Truth Social)
 *  3. collect-events — 경제지표 발표 결과 + 기업실적 결과 + 트럼프 신글 저장
 *  4. analyze     — 미분석 이슈 AI 분석 (limit 8)
 *  5. check-accuracy — 기존 분석 정확도 업데이트
 */
export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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
    call('/api/fetch-news'),
    call('/api/fetch-rss'),
  ]);
  log.news = newsData;
  log.rss  = rssData;

  // 2. 실시간 이벤트 수집 (경제지표·실적·트럼프) + 즉시 분석
  log.events = await call('/api/collect-events');

  // 3. 남은 미분석 이슈 추가 분석
  await new Promise(r => setTimeout(r, 1000));
  log.analyze = await call('/api/analyze', { limit: 8 });

  // 4. 정확도 체크
  await new Promise(r => setTimeout(r, 1000));
  log.accuracy = await call('/api/check-accuracy');

  return res.status(200).json({
    success: true,
    timestamp: new Date().toISOString(),
    ...log,
  });
}
