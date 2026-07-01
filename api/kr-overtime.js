/**
 * kr-overtime.js — Vercel Edge Function
 * GET /api/kr-overtime?codes=005930,000660&session=pre|post
 *   → { ok: true, data: { '005930': { pct, price }, ... } }
 *
 * Yahoo Finance는 KRX(.KS/.KQ) 종목의 시간외 데이터를 제공하지 않아
 * 네이버 금융의 비공식 실시간 시세 API(overMarketPriceInfo)를 사용한다.
 * KRX 시간외 세션 자체가 08:30–09:00(전일 종가 고정) / 15:40–18:00(종가매매+단일가)로
 * 정해져 있으므로, 네이버가 보내는 태그값에 의존하지 않고 KST 시각으로 직접 세션을 판별한다.
 */
export const config = { runtime: 'edge' };

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, */*',
};

function kstMinuteOfDay() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return kst.getUTCHours() * 60 + kst.getUTCMinutes();
}

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=15',
  };

  const { searchParams } = new URL(req.url);
  const codes = (searchParams.get('codes') || '').split(',').map(c => c.trim()).filter(Boolean).slice(0, 100);
  const session = (searchParams.get('session') || '').toString();

  if (!codes.length || (session !== 'pre' && session !== 'post')) {
    return new Response(JSON.stringify({ ok: false, error: 'codes and session=pre|post required', data: {} }), {
      status: 400, headers: cors,
    });
  }

  const minOfDay = kstMinuteOfDay();
  const inWindow = session === 'pre'
    ? (minOfDay >= 510 && minOfDay < 540)    // 08:30–09:00 시간외 종가매매 (전일 종가 고정)
    : (minOfDay >= 940 && minOfDay < 1080);  // 15:40–18:00 시간외 종가매매+단일가

  if (!inWindow) {
    return new Response(JSON.stringify({ ok: true, data: {}, ts: Date.now() }), { headers: cors });
  }

  try {
    const url = `https://polling.finance.naver.com/api/realtime/domestic/stock/${codes.join(',')}`;
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('naver fetch failed');
    const j = await r.json();
    const data = {};
    for (const item of (j.datas || [])) {
      const over = item.overMarketPriceInfo;
      const closePrice = parseFloat(item.closePriceRaw);
      if (!over || !closePrice) continue;
      const overPrice = parseFloat(String(over.overPrice || '').replace(/,/g, ''));
      if (!overPrice) continue;
      const pct = ((overPrice - closePrice) / closePrice) * 100;
      data[item.itemCode] = { pct: Math.round(pct * 100) / 100, price: overPrice };
    }
    return new Response(JSON.stringify({ ok: true, data, ts: Date.now() }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e), data: {} }), { status: 502, headers: cors });
  }
}
