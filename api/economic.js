export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://www.forexfactory.com/',
    'Accept': 'application/json, text/plain, */*',
  };

  // Korean translations for major economic events
  const NAME_KO = {
    'CPI m/m': '소비자물가 (MoM)',
    'Core CPI m/m': '근원 CPI (MoM)',
    'CPI y/y': '소비자물가 (YoY)',
    'Non-Farm Employment Change': '비농업 신규고용 (NFP)',
    'Unemployment Rate': '실업률',
    'GDP q/q': 'GDP (QoQ)',
    'Prelim GDP q/q': 'GDP 예비치 (QoQ)',
    'Federal Funds Rate': 'FOMC 기준금리',
    'FOMC Statement': 'FOMC 성명서',
    'FOMC Meeting Minutes': 'FOMC 의사록',
    'Retail Sales m/m': '소매판매 (MoM)',
    'Core Retail Sales m/m': '근원 소매판매 (MoM)',
    'PPI m/m': '생산자물가 (MoM)',
    'Core PPI m/m': '근원 PPI (MoM)',
    'ISM Manufacturing PMI': 'ISM 제조업 PMI',
    'ISM Services PMI': 'ISM 서비스업 PMI',
    'ISM Non-Manufacturing PMI': 'ISM 비제조업 PMI',
    'Flash Manufacturing PMI': '제조업 PMI (예비)',
    'Flash Services PMI': '서비스업 PMI (예비)',
    'Trade Balance': '무역수지',
    'Building Permits': '건축허가',
    'Housing Starts': '신규주택착공',
    'Existing Home Sales': '기존주택판매',
    'New Home Sales': '신규주택판매',
    'Durable Goods Orders m/m': '내구재주문 (MoM)',
    'Core Durable Goods Orders m/m': '근원 내구재주문 (MoM)',
    'Consumer Confidence': '소비자신뢰지수 (CB)',
    'Michigan Consumer Sentiment': '미시간대 소비자심리',
    'Prelim UoM Consumer Sentiment': '미시간대 소비자심리 (예비)',
    'UoM Consumer Sentiment': '미시간대 소비자심리',
    'Initial Jobless Claims': '신규실업급여 청구',
    'Continuing Jobless Claims': '계속실업급여 청구',
    'ADP Non-Farm Employment Change': 'ADP 비농업 고용',
    'JOLTS Job Openings': 'JOLTS 채용공고',
    'PCE Price Index m/m': 'PCE 물가 (MoM)',
    'Core PCE Price Index m/m': '근원 PCE 물가 (MoM)',
    'PCE Price Index y/y': 'PCE 물가 (YoY)',
    'Core PCE Price Index y/y': '근원 PCE 물가 (YoY)',
    'Fed Chair Powell Speaks': '파월 Fed 의장 발언',
    'Fed Speaks': 'Fed 위원 발언',
    'Treasury Sec. Speaks': '재무장관 발언',
    'Empire State Manufacturing Index': '뉴욕 제조업 지수',
    'Philly Fed Manufacturing Index': '필라델피아 Fed 제조업',
    'Industrial Production m/m': '산업생산 (MoM)',
    'Capacity Utilization Rate': '설비가동률',
    'Nonfarm Productivity q/q': '비농업 생산성 (QoQ)',
    'Unit Labor Costs q/q': '단위 노동비용 (QoQ)',
    '10-y Bond Auction': '10년물 국채 입찰',
    '30-y Bond Auction': '30년물 국채 입찰',
    'ECB Main Refinancing Rate': 'ECB 기준금리',
    'ECB Press Conference': 'ECB 기자회견',
    'BOJ Policy Rate': '일본은행 기준금리',
    'BOE Official Bank Rate': '영란은행 기준금리',
  };

  // Which indicators are "lower is better" for beat/miss logic
  const LOWER_IS_BETTER = new Set([
    'Unemployment Rate', 'Initial Jobless Claims', 'Continuing Jobless Claims',
    'Core CPI m/m', 'CPI m/m', 'CPI y/y', 'PPI m/m', 'Core PPI m/m',
    'PCE Price Index m/m', 'Core PCE Price Index m/m',
  ]);

  try {
    const [tw, nw] = await Promise.allSettled([
      fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
        headers, signal: AbortSignal.timeout(8000),
      }).then(r => r.ok ? r.json() : []),
      fetch('https://nfs.faireconomy.media/ff_calendar_nextweek.json', {
        headers, signal: AbortSignal.timeout(8000),
      }).then(r => r.ok ? r.json() : []),
    ]);

    let raw = [
      ...(tw.status === 'fulfilled' && Array.isArray(tw.value) ? tw.value : []),
      ...(nw.status === 'fulfilled' && Array.isArray(nw.value) ? nw.value : []),
    ];

    // Filter: major currencies, high + medium impact only
    raw = raw.filter(e =>
      (e.country === 'USD' || e.country === 'EUR' || e.country === 'JPY') &&
      (e.impact === 'High' || e.impact === 'Medium')
    );

    // ForexFactory date format: "May 13, 2025 08:30am" — treat as US Eastern Time
    const parseET = (str) => {
      if (!str) return null;
      try {
        // Append timezone abbreviation; this approach isn't perfect but works for display
        const d = new Date(str + ' GMT-0400'); // EDT (US summer)
        if (!isNaN(d)) return d.toISOString();
        const d2 = new Date(str);
        if (!isNaN(d2)) return d2.toISOString();
      } catch {}
      return null;
    };

    const now = Date.now();
    const items = raw
      .map(e => ({
        title:    e.title || '',
        titleKo:  NAME_KO[e.title] || e.title || '',
        country:  e.country || 'USD',
        impact:   e.impact  || 'Medium',
        date:     parseET(e.date),
        dateRaw:  e.date || '',
        forecast: e.forecast || null,
        previous: e.previous || null,
        actual:   e.actual   || null,
        lowerIsBetter: LOWER_IS_BETTER.has(e.title),
      }))
      .filter(e => {
        if (!e.date) return false;
        const t = new Date(e.date).getTime();
        return t >= now - 86400000 && t <= now + 14 * 86400000;
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 30);

    return res.status(200).json({ ok: true, items, ts: Date.now() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, items: [] });
  }
}
