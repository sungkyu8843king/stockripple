export default async function handler(req, res) {
  const type = req.query?.type;
  if (type === 'analyst') return handleAnalyst(req, res);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');

  const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const WATCH_TICKERS = [
    'AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','INTC','QCOM',
    'NFLX','ORCL','CRM','AVGO','MU',
  ];

  // ── Step 1: Yahoo Finance 인증 크럼 취득 ──────────────────────────────
  let crumb = '';
  let cookieStr = '';
  try {
    const consent = await fetch('https://finance.yahoo.com/', {
      headers: BASE_HEADERS,
      signal: AbortSignal.timeout(6000),
    });
    // 필요한 쿠키만 추출 (A3, GUC, cmp 등)
    const raw = consent.headers.get('set-cookie') || '';
    cookieStr = raw
      .split(/,(?=[^ ])/)
      .map(s => s.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');

    const cr = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...BASE_HEADERS, Cookie: cookieStr },
      signal: AbortSignal.timeout(5000),
    });
    if (cr.ok) crumb = (await cr.text()).trim();
  } catch {}

  const qsUrl = (ticker, modules) => {
    const base = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${encodeURIComponent(modules)}`;
    return crumb ? `${base}&crumb=${encodeURIComponent(crumb)}` : base;
  };
  const qsHeaders = { ...BASE_HEADERS, ...(cookieStr ? { Cookie: cookieStr } : {}) };

  // ── Step 2: 이번 주 실적 캘린더 (Yahoo Finance) ───────────────────────
  const today = new Date();
  const startDate = new Date(today); startDate.setDate(today.getDate() - 10);
  const endDate   = new Date(today); endDate.setDate(today.getDate() + 10);
  const fmt = d => d.toISOString().split('T')[0];

  let calData = [];
  // 여러 URL 조합 시도 (Yahoo Finance API 불안정)
  const calUrls = [
    `https://query1.finance.yahoo.com/v1/finance/visualization/earningscalendar?startDate=${fmt(startDate)}&endDate=${fmt(endDate)}&size=50&offset=0`,
    `https://query2.finance.yahoo.com/v1/finance/visualization/earningscalendar?startDate=${fmt(startDate)}&endDate=${fmt(endDate)}&size=50&offset=0`,
  ];
  for (const calUrl of calUrls) {
    try {
      const cr = await fetch(calUrl, { headers: qsHeaders, signal: AbortSignal.timeout(8000) });
      if (cr.ok) {
        const cj = await cr.json();
        const rows = cj.finance?.result?.[0]?.rows || [];
        if (rows.length > 0) { calData = rows; break; }
      }
    } catch {}
  }

  const todayStr = fmt(today);
  const startStr = fmt(startDate);

  // ── Step 3: 각 티커별 상세 데이터 취득 ───────────────────────────────
  const enrichTicker = async (ticker, base = {}) => {
    try {
      // earningsHistory 추가: 최근 발표된 실제 EPS 결과 취득
      const url = qsUrl(ticker, 'calendarEvents,earningsTrend,earningsHistory,financialData');
      const r = await fetch(url, { headers: qsHeaders, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return base;
      const json = await r.json();
      const qs = json.quoteSummary?.result?.[0];
      if (!qs) return base;

      const ce = qs.calendarEvents;
      const et = qs.earningsTrend?.trend;
      const eh = qs.earningsHistory?.history || [];
      const fd = qs.financialData;

      // 실적 발표 예정일 결정: base.date → calendarEvents → earningsHistory 최신
      let date = base.date ?? null;
      let epsActual = base.epsActual ?? null;

      if (!date && ce?.earningsDate?.[0]?.fmt) {
        date = ce.earningsDate[0].fmt;
      }

      // earningsHistory: 최근 발표 결과 (과거 10일 이내)
      if (!date || date < startStr) {
        const recentHistory = eh
          .filter(h => h.quarter?.fmt && h.quarter.fmt >= startStr && h.quarter.fmt <= todayStr)
          .sort((a, b) => (b.quarter?.fmt || '').localeCompare(a.quarter?.fmt || ''));
        if (recentHistory.length > 0) {
          const latest = recentHistory[0];
          date = latest.quarter?.fmt || date;
          epsActual = epsActual ?? latest.epsActual?.raw ?? null;
          base = {
            ...base,
            date,
            epsActual,
            epsEstimate: base.epsEstimate ?? latest.epsEstimate?.raw ?? null,
          };
        }
      }

      // EPS 추정치
      let epsConsensus = base.epsEstimate ?? null;
      let whisper = null, epsLow = null, epsGrowth = null, revEstimate = null;
      const currentQ = et?.find(t => t.period === '0q') || et?.[0];
      if (currentQ?.earningsEstimate) {
        const est = currentQ.earningsEstimate;
        if (epsConsensus == null) epsConsensus = est.avg?.raw ?? null;
        whisper   = est.high?.raw ?? null;
        epsLow    = est.low?.raw  ?? null;
        epsGrowth = currentQ.growth?.raw ?? null;
      }
      if (currentQ?.revenueEstimate) {
        revEstimate = currentQ.revenueEstimate.avg?.raw ?? null;
      }

      // 목표주가 / 투자의견
      const priceTarget  = fd?.targetMeanPrice?.raw  ?? null;
      const targetHigh   = fd?.targetHighPrice?.raw  ?? null;
      const targetLow    = fd?.targetLowPrice?.raw   ?? null;
      const currentPrice = fd?.currentPrice?.raw     ?? null;
      const recKey       = fd?.recommendationKey     ?? null;
      const analystCount = fd?.numberOfAnalystOpinions?.raw ?? null;

      // IV: ATM 콜 내재변동성
      let iv = null;
      try {
        const optR = await fetch(
          `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}`,
          { headers: BASE_HEADERS, signal: AbortSignal.timeout(5000) }
        );
        if (optR.ok) {
          const optJ = await optR.json();
          const opt  = optJ.optionChain?.result?.[0];
          if (opt) {
            const price = opt.quote?.regularMarketPrice ?? currentPrice;
            const calls = opt.options?.[0]?.calls || [];
            if (calls.length && price) {
              const atm = calls.reduce((b, c) =>
                Math.abs(c.strike - price) < Math.abs(b.strike - price) ? c : b
              );
              if (atm.impliedVolatility != null)
                iv = Math.round(atm.impliedVolatility * 1000) / 10;
            }
          }
        }
      } catch {}

      return {
        ...base,
        ticker,
        date,
        epsConsensus,
        epsActual,
        whisper,
        epsLow,
        epsGrowth,
        revEstimate,
        priceTarget,
        targetHigh,
        targetLow,
        currentPrice,
        recKey,
        analystCount,
        iv,
      };
    } catch {
      return base;
    }
  };

  let items = [];

  if (calData.length > 0) {
    // 캘린더 데이터 있음 → 캘린더 항목 enrich
    const bases = calData.slice(0, 10).map(row => ({
      ticker:      row.ticker,
      company:     row.companyshortName || row.company || row.ticker,
      date:        row.startdatetime?.split('T')[0] ?? null,
      epsEstimate: row.epsestimate ?? null,
      epsActual:   row.epsactual   ?? null,
      callTime:    row.startdatetimetype ?? null,
    }));
    const enriched = await Promise.allSettled(bases.map(b => enrichTicker(b.ticker, b)));
    items = enriched.map((r, i) => r.status === 'fulfilled' ? r.value : bases[i]);
  } else {
    // 캘린더 없음 → 주요 종목별 실적 직접 조회 (과거 earningsHistory + 미래 calendarEvents)
    const enriched = await Promise.allSettled(
      WATCH_TICKERS.slice(0, 12).map(t => enrichTicker(t, { ticker: t, company: t }))
    );
    const allItems = enriched
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    // 날짜 범위 내 항목만 포함 (과거10일 ~ 미래10일), 날짜 없는 것은 마지막에
    items = allItems
      .filter(it => !it.date || (it.date >= startStr && it.date <= fmt(endDate)))
      .sort((a, b) => {
        if (!a.date && !b.date) return 0;
        if (!a.date) return 1;
        if (!b.date) return -1;
        return new Date(a.date) - new Date(b.date);
      });
  }

  // company명이 ticker인 경우 quoteSummary shortName으로 보완 (별도 v8 차트 API)
  const fillNames = items.filter(it => it.company === it.ticker).map(async it => {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(it.ticker)}?interval=1d&range=1d`,
        { headers: BASE_HEADERS, signal: AbortSignal.timeout(4000) }
      );
      if (!r.ok) return;
      const j = await r.json();
      const meta = j.chart?.result?.[0]?.meta;
      if (meta?.shortName || meta?.longName) it.company = meta.shortName || meta.longName;
    } catch {}
  });
  await Promise.allSettled(fillNames);

  return res.status(200).json({
    ok: true,
    items,
    source: calData.length > 0 ? 'calendar' : 'tickers',
    ts: Date.now(),
  });
}

// ─── Analyst ratings handler (?type=analyst) ─────────────────────────────
async function handleAnalyst(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');

  const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const TICKERS = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN', 'TSLA', 'AMD', 'QCOM', 'NFLX'];

  // ── Step 1: 크럼 취득 (quoteSummary 요청용) ───────────────────────────
  let crumb = '';
  let cookieStr = '';
  try {
    const consent = await fetch('https://finance.yahoo.com/', {
      headers: BASE_HEADERS, signal: AbortSignal.timeout(6000),
    });
    const raw = consent.headers.get('set-cookie') || '';
    cookieStr = raw.split(/,(?=[^ ])/).map(s => s.split(';')[0].trim()).filter(Boolean).join('; ');
    const cr = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...BASE_HEADERS, Cookie: cookieStr }, signal: AbortSignal.timeout(5000),
    });
    if (cr.ok) crumb = (await cr.text()).trim();
  } catch {}

  const qsHeaders = { ...BASE_HEADERS, ...(cookieStr ? { Cookie: cookieStr } : {}) };

  // ── Step 2: v7/quote API로 기본 데이터 일괄 취득 (크럼 불필요) ──────────
  let quoteMap = {};
  try {
    const symbols = TICKERS.join(',');
    const qr = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=shortName,longName,regularMarketPrice,targetMeanPrice,targetHighPrice,targetLowPrice,numberOfAnalystOpinions,recommendationKey`,
      { headers: BASE_HEADERS, signal: AbortSignal.timeout(10000) }
    );
    if (qr.ok) {
      const qj = await qr.json();
      for (const q of qj.quoteResponse?.result || []) {
        quoteMap[q.symbol] = q;
      }
    }
  } catch {}

  // ── Step 3: 티커별 recommendationTrend + upgradeDowngradeHistory ──────
  const fetchAnalyst = async (ticker) => {
    try {
      const encoded = encodeURIComponent(ticker);
      const q = quoteMap[ticker] || {};

      // quoteSummary: trend + upgrade/downgrade 히스토리
      let dist = null, recent = [];
      try {
        let url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encoded}?modules=${encodeURIComponent('recommendationTrend,upgradeDowngradeHistory')}`;
        if (crumb) url += `&crumb=${encodeURIComponent(crumb)}`;
        const r = await fetch(url, { headers: qsHeaders, signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const json = await r.json();
          const qs = json.quoteSummary?.result?.[0];
          if (qs) {
            const rt = qs.recommendationTrend?.trend?.[0];
            if (rt) {
              dist = {
                strongBuy:  rt.strongBuy  ?? 0,
                buy:        rt.buy        ?? 0,
                hold:       rt.hold       ?? 0,
                sell:       rt.sell       ?? 0,
                strongSell: rt.strongSell ?? 0,
              };
            }
            const udh = qs.upgradeDowngradeHistory?.history?.slice(0, 4) || [];
            recent = udh.map(h => ({
              firm:      h.firm      || '',
              toGrade:   h.toGrade   || '',
              fromGrade: h.fromGrade || '',
              action:    h.action    || 'main',
              date:      h.epochGradeDate
                ? new Date(h.epochGradeDate * 1000).toISOString().split('T')[0] : null,
            }));
          }
        }
      } catch {}

      const price      = q.regularMarketPrice ?? null;
      const targetMean = q.targetMeanPrice    ?? null;
      const recKey     = q.recommendationKey  ?? null;

      // 데이터가 아무것도 없으면 null 반환
      if (!price && !targetMean && !dist) return null;

      return {
        ticker,
        shortName:    q.shortName || q.longName || ticker,
        price,
        targetMean,
        targetHigh:   q.targetHighPrice ?? null,
        targetLow:    q.targetLowPrice  ?? null,
        recKey,
        analystCount: q.numberOfAnalystOpinions ?? null,
        dist,
        recent,
      };
    } catch { return null; }
  };

  const results = await Promise.allSettled(TICKERS.map(fetchAnalyst));
  const items = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  return res.status(200).json({ ok: true, items, ts: Date.now() });
}
