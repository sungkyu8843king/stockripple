export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  const WATCH_TICKERS = [
    'AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','INTC','QCOM',
    'NFLX','ORCL','CRM','AVGO','MU','TSM','ASML',
  ];

  try {
    const today = new Date();
    const startDate = new Date(today); startDate.setDate(today.getDate() - 3);
    const endDate = new Date(today);   endDate.setDate(today.getDate() + 14);
    const fmt = d => d.toISOString().split('T')[0];

    // 1) Yahoo Finance earnings calendar
    const calUrl = `https://query1.finance.yahoo.com/v1/finance/visualization/earningscalendar?startDate=${fmt(startDate)}&endDate=${fmt(endDate)}&size=20&offset=0`;
    let calData = [];
    try {
      const cr = await fetch(calUrl, { headers, signal: AbortSignal.timeout(8000) });
      if (cr.ok) {
        const cj = await cr.json();
        calData = cj.finance?.result?.[0]?.rows || [];
      }
    } catch {}

    let baseItems = [];
    if (calData.length > 0) {
      baseItems = calData.slice(0, 12).map(row => ({
        ticker:      row.ticker,
        company:     row.companyshortName || row.company || row.ticker,
        date:        row.startdatetime?.split('T')[0],
        epsEstimate: row.epsestimate ?? null,
        epsActual:   row.epsactual ?? null,
        callTime:    row.startdatetimetype, // 'AMC' | 'BMO' | 'TNS'
      }));
    } else {
      // Fallback: watched tickers with basic data
      const fetchBasic = async (ticker) => {
        try {
          const encoded = encodeURIComponent(ticker);
          const r = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=3mo&range=1y`,
            { headers, signal: AbortSignal.timeout(5000) }
          );
          if (!r.ok) return null;
          const json = await r.json();
          const meta = json.chart?.result?.[0]?.meta;
          if (!meta) return null;
          return { ticker, company: meta.shortName || meta.longName || ticker, date: null, epsEstimate: null, epsActual: null, callTime: null };
        } catch { return null; }
      };
      const settled = await Promise.allSettled(WATCH_TICKERS.slice(0, 12).map(fetchBasic));
      baseItems = settled.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    }

    // 2) Enrich each item with: EPS range (whisper proxy), Rev estimate, IV, price target
    const enrichItem = async (item) => {
      try {
        const encoded = encodeURIComponent(item.ticker);

        // quoteSummary: earningsTrend + financialData
        const qsUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encoded}?modules=earningsTrend%2CfinancialData`;
        const qsR = await fetch(qsUrl, { headers, signal: AbortSignal.timeout(7000) });
        let epsConsensus = item.epsEstimate, epsHigh = null, epsLow = null, epsGrowth = null;
        let revEstimate = null, priceTarget = null, targetHigh = null, targetLow = null;
        let analystCount = null, recKey = null, currentPrice = null;

        if (qsR.ok) {
          const qsJ = await qsR.json();
          const qs = qsJ.quoteSummary?.result?.[0];
          if (qs) {
            const et = qs.earningsTrend?.trend?.[0];
            const fd = qs.financialData;

            if (et?.earningsEstimate) {
              const est = et.earningsEstimate;
              if (epsConsensus == null) epsConsensus = est.avg?.raw ?? null;
              epsHigh  = est.high?.raw ?? null;
              epsLow   = est.low?.raw  ?? null;
              epsGrowth = et.growth?.raw ?? null;
              analystCount = est.numberOfAnalysts?.raw ?? null;
            }
            if (et?.revenueEstimate) {
              revEstimate = et.revenueEstimate.avg?.raw ?? null;
            }
            if (fd) {
              priceTarget  = fd.targetMeanPrice?.raw ?? null;
              targetHigh   = fd.targetHighPrice?.raw ?? null;
              targetLow    = fd.targetLowPrice?.raw  ?? null;
              currentPrice = fd.currentPrice?.raw    ?? null;
              recKey       = fd.recommendationKey    ?? null;
              if (analystCount == null) analystCount = fd.numberOfAnalystOpinions?.raw ?? null;
            }
          }
        }

        // IV from options chain (front-month ATM call)
        let iv = null;
        try {
          const optUrl = `https://query2.finance.yahoo.com/v7/finance/options/${encoded}`;
          const optR = await fetch(optUrl, { headers, signal: AbortSignal.timeout(6000) });
          if (optR.ok) {
            const optJ = await optR.json();
            const opt = optJ.optionChain?.result?.[0];
            if (opt) {
              const price = opt.quote?.regularMarketPrice ?? currentPrice;
              const calls = opt.options?.[0]?.calls || [];
              if (calls.length && price) {
                const atm = calls.reduce((best, c) =>
                  Math.abs(c.strike - price) < Math.abs(best.strike - price) ? c : best
                );
                if (atm.impliedVolatility != null) iv = Math.round(atm.impliedVolatility * 1000) / 10;
              }
            }
          }
        } catch {}

        // Whisper = high-end analyst EPS estimate (buy-side proxy)
        const whisper = epsHigh;

        return {
          ...item,
          company: item.company,
          epsConsensus,
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
        return item;
      }
    };

    // Enrich up to 8 items in parallel (keep under timeout budget)
    const enriched = await Promise.allSettled(baseItems.slice(0, 8).map(enrichItem));
    const items = enriched.map((r, i) => r.status === 'fulfilled' ? r.value : baseItems[i]);

    return res.status(200).json({
      ok: true,
      items,
      source: calData.length > 0 ? 'calendar' : 'tickers',
      ts: Date.now(),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
