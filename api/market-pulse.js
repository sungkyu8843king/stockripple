/**
 * market-pulse.js — Vercel Edge Function
 * Cloudflare IP로 실행되어 ForexFactory IP 차단 우회
 * GET ?type=trump    → Truth Social RSS 최신 글
 * GET ?type=economic → ForexFactory 이번주/다음주 캘린더
 */
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type') || 'economic';
  if (type === 'trump') return handleTrump();
  return handleEconomic();
}

// ─── Trump Truth Social ────────────────────────────────────────────────────
async function handleTrump() {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300',
  };

  try {
    const r = await fetch('https://truthsocial.com/@realDonaldTrump.rss', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      return new Response(JSON.stringify({ ok: false, error: `HTTP ${r.status}`, items: [] }), { headers: corsHeaders });
    }
    const xml   = await r.text();
    const items = parseRss(xml, 5);
    return new Response(JSON.stringify({ ok: true, items, ts: Date.now() }), { headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message, items: [] }), { headers: corsHeaders });
  }
}

function parseRss(xml, max = 5) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null && items.length < max) {
    const block   = m[1];
    const desc    = getTag(block, 'description') || getTag(block, 'content:encoded');
    const link    = getTag(block, 'link') || getTag(block, 'guid');
    const pubDate = getTag(block, 'pubDate');
    const text = (desc || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (text.length > 5) {
      items.push({
        text,
        link: link || 'https://truthsocial.com/@realDonaldTrump',
        publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
      });
    }
  }
  return items;
}

function getTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, 'i');
  const m  = xml.match(re);
  return m ? (m[1] ?? m[2] ?? '').trim() : '';
}

// 이벤트명 정규화 (ForexFactory/FMP 명명 차이 흡수)
function normalizeTitle(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/\bm\/m\b/g, 'mom').replace(/\by\/y\b/g, 'yoy').replace(/\bq\/q\b/g, 'qoq')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// ─── ForexFactory 경제지표 ─────────────────────────────────────────────────
async function handleEconomic() {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
  };

  const NAME_KO = {
    'CPI m/m': '소비자물가 (MoM)', 'Core CPI m/m': '근원 CPI (MoM)',
    'CPI y/y': '소비자물가 (YoY)', 'Core CPI y/y': '근원 CPI (YoY)',
    'Non-Farm Employment Change': '비농업 신규고용 (NFP)', 'Unemployment Rate': '실업률',
    'GDP q/q': 'GDP (QoQ)', 'Prelim GDP q/q': 'GDP 예비치 (QoQ)',
    'Federal Funds Rate': 'FOMC 기준금리', 'FOMC Statement': 'FOMC 성명서',
    'FOMC Meeting Minutes': 'FOMC 의사록', 'FOMC Press Conference': 'FOMC 기자회견',
    'Retail Sales m/m': '소매판매 (MoM)', 'Core Retail Sales m/m': '근원 소매판매 (MoM)',
    'PPI m/m': '생산자물가 (MoM)', 'Core PPI m/m': '근원 PPI (MoM)',
    'PPI y/y': '생산자물가 (YoY)', 'Core PPI y/y': '근원 PPI (YoY)',
    'ISM Manufacturing PMI': 'ISM 제조업 PMI', 'ISM Services PMI': 'ISM 서비스업 PMI',
    'ISM Non-Manufacturing PMI': 'ISM 비제조업 PMI',
    'Flash Manufacturing PMI': '제조업 PMI (예비)', 'Flash Services PMI': '서비스업 PMI (예비)',
    'Trade Balance': '무역수지', 'Building Permits': '건축허가',
    'Housing Starts': '신규주택착공', 'Existing Home Sales': '기존주택판매',
    'New Home Sales': '신규주택판매', 'Pending Home Sales m/m': '주택판매계약 (MoM)',
    'Durable Goods Orders m/m': '내구재주문 (MoM)', 'Core Durable Goods Orders m/m': '근원 내구재주문 (MoM)',
    'Consumer Confidence': '소비자신뢰지수 (CB)', 'Michigan Consumer Sentiment': '미시간대 소비자심리',
    'Prelim UoM Consumer Sentiment': '미시간대 소비자심리 (예비)', 'UoM Consumer Sentiment': '미시간대 소비자심리',
    'Initial Jobless Claims': '신규실업급여 청구', 'Continuing Jobless Claims': '계속실업급여 청구',
    'ADP Non-Farm Employment Change': 'ADP 비농업 고용', 'JOLTS Job Openings': 'JOLTS 채용공고',
    'PCE Price Index m/m': 'PCE 물가 (MoM)', 'Core PCE Price Index m/m': '근원 PCE 물가 (MoM)',
    'PCE Price Index y/y': 'PCE 물가 (YoY)', 'Core PCE Price Index y/y': '근원 PCE 물가 (YoY)',
    'Fed Chair Powell Speaks': '파월 Fed 의장 발언', 'Fed Speaks': 'Fed 위원 발언',
    'Treasury Sec. Speaks': '재무장관 발언', 'Treasury Secretary Speaks': '재무장관 발언',
    'Empire State Manufacturing Index': '뉴욕 제조업 지수',
    'Philly Fed Manufacturing Index': '필라델피아 Fed 제조업',
    'Industrial Production m/m': '산업생산 (MoM)', 'Capacity Utilization Rate': '설비가동률',
    'Nonfarm Productivity q/q': '비농업 생산성 (QoQ)', 'Unit Labor Costs q/q': '단위노동비용 (QoQ)',
    'ECB Main Refinancing Rate': 'ECB 기준금리', 'ECB Press Conference': 'ECB 기자회견',
    'BOJ Policy Rate': '일본은행 기준금리', 'BOE Official Bank Rate': '영란은행 기준금리',
    'Employment Change': '고용변화', 'Employment Cost Index q/q': '고용비용지수 (QoQ)',
    'Chicago PMI': '시카고 PMI', 'Challenger Job Cuts y/y': '챌린저 감원 (YoY)',
  };

  const LOWER_IS_BETTER = new Set([
    'Unemployment Rate', 'Initial Jobless Claims', 'Continuing Jobless Claims',
    'Core CPI m/m', 'CPI m/m', 'CPI y/y', 'Core CPI y/y',
    'PPI m/m', 'Core PPI m/m', 'PPI y/y', 'Core PPI y/y',
    'PCE Price Index m/m', 'Core PCE Price Index m/m',
    'Unit Labor Costs q/q', 'Challenger Job Cuts y/y',
  ]);

  try {
    const fmpKey = process.env.FMP_API_KEY;
    const today  = new Date();
    const past   = new Date(today.getTime() - 7 * 86400000);
    const future = new Date(today.getTime() + 14 * 86400000);
    const fmpFrom = past.toISOString().split('T')[0];
    const fmpTo   = future.toISOString().split('T')[0];

    // FMP economic calendar 여러 엔드포인트 명 cascade 시도
    const fetchFMPEconomic = async () => {
      if (!fmpKey) return { data: [], status: 'no-key' };
      const urls = [
        `https://financialmodelingprep.com/stable/economic-calendar?from=${fmpFrom}&to=${fmpTo}&apikey=${fmpKey}`,
        `https://financialmodelingprep.com/stable/economics-calendar?from=${fmpFrom}&to=${fmpTo}&apikey=${fmpKey}`,
        `https://financialmodelingprep.com/api/v3/economic_calendar?from=${fmpFrom}&to=${fmpTo}&apikey=${fmpKey}`,
      ];
      const tried = [];
      for (const url of urls) {
        try {
          const r = await fetch(url, { headers, signal: AbortSignal.timeout(7000) });
          const path = url.split('?')[0].split('/').slice(-1)[0];
          if (r.ok) {
            const j = await r.json();
            if (Array.isArray(j) && j.length) return { data: j, status: `ok-${path}`, tried };
            tried.push(`${path}:empty`);
          } else {
            tried.push(`${path}:${r.status}`);
          }
        } catch (e) { tried.push(`err:${e.message}`); }
      }
      return { data: [], status: 'all-failed', tried };
    };

    const [tw, nw, lw, fmpResult] = await Promise.allSettled([
      fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers, signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : []),
      fetch('https://nfs.faireconomy.media/ff_calendar_nextweek.json', { headers, signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : []),
      fetch('https://nfs.faireconomy.media/ff_calendar_lastweek.json', { headers, signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : []),
      fetchFMPEconomic(),
    ]);

    const fmp = { status: 'fulfilled', value: fmpResult.status === 'fulfilled' ? fmpResult.value.data : [] };
    const fmpStatus = fmpResult.status === 'fulfilled' ? fmpResult.value.status : 'rejected';
    const fmpTried  = fmpResult.status === 'fulfilled' ? fmpResult.value.tried : [];

    let raw = [
      ...(lw.status === 'fulfilled' && Array.isArray(lw.value) ? lw.value : []),
      ...(tw.status === 'fulfilled' && Array.isArray(tw.value) ? tw.value : []),
      ...(nw.status === 'fulfilled' && Array.isArray(nw.value) ? nw.value : []),
    ];

    // FMP economic calendar로 actual 값 보강 (ForexFactory JSON엔 actual 필드 없음)
    const fmpArr = fmp.status === 'fulfilled' && Array.isArray(fmp.value) ? fmp.value : [];
    // FMP country: 'US', 'EU', 'JP' → ForexFactory currency: 'USD', 'EUR', 'JPY'
    const COUNTRY_TO_CURRENCY = { US:'USD', EU:'EUR', JP:'JPY', GB:'GBP', CN:'CNY', DE:'EUR', FR:'EUR' };
    const fmpByKey = {};  // key: "currency|normalizedTitle" → FMP event
    for (const e of fmpArr) {
      const title = e?.event || e?.title;
      if (!title) continue;
      const curr  = (e.currency || COUNTRY_TO_CURRENCY[(e.country || '').toUpperCase()] || e.country || '').toUpperCase();
      const key   = `${curr}|${normalizeTitle(title)}`;
      // 시간 기반: 가장 가까운 이벤트 우선 매칭
      const existing = fmpByKey[key];
      if (!existing) { fmpByKey[key] = e; continue; }
      const eMs   = new Date(e.date).getTime();
      const exMs  = new Date(existing.date).getTime();
      // actual 있는 쪽 우선, 없으면 더 최근
      if (e.actual != null && existing.actual == null) fmpByKey[key] = e;
      else if (e.actual == null && existing.actual != null) {}
      else if (eMs > exMs) fmpByKey[key] = e;
    }

    if (!raw.length) {
      return new Response(JSON.stringify({ ok: false, error: 'ForexFactory returned empty', items: [], fmpCount: fmpArr.length }), { headers: corsHeaders });
    }

    raw = raw.filter(e =>
      (e.country === 'USD' || e.country === 'EUR' || e.country === 'JPY') &&
      (e.impact === 'High' || e.impact === 'Medium')
    );

    const now         = Date.now();
    const windowStart = now - 7  * 86400000;
    const windowEnd   = now + 14 * 86400000;

    const items = raw
      .map(e => {
        let dateIso = null;
        try { const d = new Date(e.date); if (!isNaN(d)) dateIso = d.toISOString(); } catch {}
        // FMP에서 actual 보강 (currency + 정규화된 이벤트명 매칭)
        const matchKey = `${(e.country || '').toUpperCase()}|${normalizeTitle(e.title)}`;
        const fmpMatch = fmpByKey[matchKey];
        const ffActual  = (e.actual != null && e.actual !== '') ? String(e.actual) : null;
        const fmpActual = fmpMatch && fmpMatch.actual != null && fmpMatch.actual !== '' ? String(fmpMatch.actual) : null;
        const fmpFcast  = fmpMatch && fmpMatch.estimate != null && fmpMatch.estimate !== '' ? String(fmpMatch.estimate) : null;
        const fmpPrev   = fmpMatch && fmpMatch.previous != null && fmpMatch.previous !== '' ? String(fmpMatch.previous) : null;
        return {
          title:        e.title || '',
          titleKo:      NAME_KO[e.title] || e.title || '',
          country:      e.country || 'USD',
          impact:       e.impact  || 'Medium',
          date:         dateIso,
          dateRaw:      e.date || '',
          forecast:     (e.forecast != null && e.forecast !== '') ? String(e.forecast) : fmpFcast,
          previous:     (e.previous != null && e.previous !== '') ? String(e.previous) : fmpPrev,
          actual:       ffActual || fmpActual,  // ForexFactory 우선, 없으면 FMP
          lowerIsBetter: LOWER_IS_BETTER.has(e.title),
        };
      })
      .filter(e => {
        if (!e.date) return false;
        const t = new Date(e.date).getTime();
        return t >= windowStart && t <= windowEnd;
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 30);

    return new Response(JSON.stringify({
      ok: true,
      items,
      ts: Date.now(),
      fmp: { ok: !!fmpArr.length, count: fmpArr.length, withActual: fmpArr.filter(e => e?.actual != null).length, status: fmpStatus },
    }), { headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message, items: [] }), { status: 500, headers: corsHeaders });
  }
}
