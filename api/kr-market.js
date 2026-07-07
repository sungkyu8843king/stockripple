/**
 * kr-market.js — 국장 전체 랭킹
 * GET ?type=volume-top&market=ALL|KOSPI|KOSDAQ  → 거래량 상위
 * GET ?type=limit-up                             → 상한가
 * GET ?type=limit-down                           → 하한가
 * GET ?type=flow-top                             → 시총 상위 ~150종목의 5일 외국인+기관 순매수 랭킹
 *
 * finance.naver.com 레거시 페이지(거래량상위/상한가/하한가)는 EUC-KR 인코딩.
 * Node 서버리스 런타임(Edge 아님)의 native TextDecoder('euc-kr')로 디코딩한다
 * — Edge 런타임은 축소된 ICU라 미지원 가능성이 있어 이 파일은 edge config를 쓰지 않는다.
 */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};
const MOBILE_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; StockRipple/1.0)' };

async function fetchEucKr(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  return new TextDecoder('euc-kr').decode(buf);
}

const num = s => {
  const n = parseFloat(String(s ?? '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
};

function tdCells(rowHtml) {
  return [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
    .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}
function codeOf(rowHtml) {
  const m = rowHtml.match(/code=(\d{6})/);
  return m ? m[1] : null;
}
function nameOf(rowHtml) {
  const m = rowHtml.match(/<a href="\/item\/main\.naver\?code=\d+"[^>]*>([^<]+)<\/a>/);
  return m ? m[1].trim() : null;
}
function rowsOf(html) {
  return (html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []).filter(r => r.includes('item/main'));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const type = (req.query?.type || 'volume-top').toString();
  try {
    if (type === 'volume-top')  return await handleVolumeTop(req, res);
    if (type === 'limit-up')    return await handleLimitList(req, res, 'up');
    if (type === 'limit-down')  return await handleLimitList(req, res, 'down');
    if (type === 'flow-top')    return await handleFlowTop(req, res);
    return res.status(400).json({ ok: false, error: 'unknown type' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── 거래량 상위 (finance.naver.com/sise/sise_quant.naver) ─────────────
// 컬럼 순서(td): 0=순위 1=종목명 2=현재가 3=등락구분+등락폭 4=등락률 5=거래량(주)
// 6=거래대금(백만원) 7=시가 8=고가 9=시가총액(억원) 10=PER 11=PBR
async function handleVolumeTop(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=180, stale-while-revalidate=600');
  const market = (req.query.market || 'ALL').toString().toUpperCase();
  const sosokList = market === 'KOSPI' ? [0] : market === 'KOSDAQ' ? [1] : [0, 1];
  const suffix = { 0: 'KS', 1: 'KQ' };
  const label  = { 0: 'KOSPI', 1: 'KOSDAQ' };

  const items = [];
  for (const sosok of sosokList) {
    const html = await fetchEucKr(`https://finance.naver.com/sise/sise_quant.naver?sosok=${sosok}`);
    for (const row of rowsOf(html)) {
      const code = codeOf(row), name = nameOf(row);
      if (!code || !name) continue;
      const c = tdCells(row);
      items.push({
        ticker: `${code}.${suffix[sosok]}`,
        name, market: label[sosok],
        price: num(c[2]), changePercent: num(c[4]),
        volume: num(c[5]), tradingValueM: num(c[6]),
      });
    }
  }
  items.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  return res.status(200).json({ ok: true, items: items.slice(0, 40), ts: Date.now() });
}

// ─── 상한가/하한가 (finance.naver.com/sise/sise_upper.naver, sise_lower.naver) ──
// 한 페이지에 코스피/코스닥 테이블 2개가 같이 옴. 컬럼: 0=순위 1=? 2=연속일수
// 3=종목명 4=현재가 5=등락폭(상한가/하한가) 6=등락률 7=거래량(주) 8~10=기타
async function handleLimitList(req, res, dir) {
  res.setHeader('Cache-Control', 'public, s-maxage=180, stale-while-revalidate=600');
  const url = dir === 'up'
    ? 'https://finance.naver.com/sise/sise_upper.naver'
    : 'https://finance.naver.com/sise/sise_lower.naver';
  const html = await fetchEucKr(url);

  // 코스피/코스닥 테이블 경계로 분리해 시장 라벨 부여
  const kospiIdx  = html.indexOf('코스피 시세정보');
  const kosdaqIdx = html.indexOf('코스닥 시세정보');
  const segments = [];
  if (kospiIdx >= 0 && kosdaqIdx >= 0) {
    segments.push({ market: 'KOSPI',  suffix: 'KS', html: html.slice(kospiIdx, kosdaqIdx) });
    segments.push({ market: 'KOSDAQ', suffix: 'KQ', html: html.slice(kosdaqIdx) });
  } else {
    segments.push({ market: 'KR', suffix: 'KS', html });
  }

  const items = [];
  for (const seg of segments) {
    for (const row of rowsOf(seg.html)) {
      const code = codeOf(row), name = nameOf(row);
      if (!code || !name) continue;
      const c = tdCells(row);
      items.push({
        ticker: `${code}.${seg.suffix}`,
        name, market: seg.market,
        price: num(c[4]), changePercent: num(c[6]),
        volume: num(c[7]), streakDays: num(c[2]),
      });
    }
  }
  return res.status(200).json({ ok: true, items, ts: Date.now() });
}

// ─── 5일 외국인+기관 순매수 TOP (시총 상위 ~150종목 집계) ──────────────
// 유니버스: KOSPI 시총 top100 + KOSDAQ 시총 top50 (m.stock.naver 모바일 API, JSON)
// 각 종목의 최근 5일 외국인/기관 순매수 수량 × 종가 ≈ 순매수 금액을 합산해 랭킹.
// 전체 ~2,500종목이 아닌 시총 상위 표본 기준 — 소형 테마주 수급은 반영되지 않음.
async function fetchMarketValueUniverse(category, pageSize) {
  const out = [];
  const perPage = 50;
  for (let page = 1; out.length < pageSize; page++) {
    const r = await fetch(`https://m.stock.naver.com/api/stocks/marketValue/${category}?page=${page}&pageSize=${perPage}`,
      { headers: MOBILE_HEADERS, signal: AbortSignal.timeout(7000) });
    if (!r.ok) break;
    const j = await r.json();
    const stocks = j?.stocks || [];
    if (!stocks.length) break;
    out.push(...stocks);
    if (stocks.length < perPage) break;
  }
  return out.slice(0, pageSize);
}

async function fetchFlow5d(code) {
  try {
    const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/trend?pageSize=5&page=1`,
      { headers: MOBILE_HEADERS, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const list = await r.json();
    if (!Array.isArray(list) || !list.length) return null;
    let foreignVal = 0, instVal = 0, foreignQty = 0, instQty = 0;
    for (const d of list) {
      const price = num(d.closePrice) || 0;
      const f = num(d.foreignerPureBuyQuant) || 0;
      const i = num(d.organPureBuyQuant) || 0;
      foreignVal += f * price; instVal += i * price;
      foreignQty += f; instQty += i;
    }
    return { foreignVal, instVal, foreignQty, instQty, days: list.length };
  } catch { return null; }
}

// ETF/ETN은 시총 상위에 자주 끼지만 "종목" 수급 랭킹 취지에는 노이즈 — 이름 접두사로 제외
const ETF_PREFIX = /^(KODEX|TIGER|KBSTAR|ARIRANG|SOL|ACE|HANARO|KOSEF|KINDEX|PLUS|RISE|마이다스|파워)\s/;

async function handleFlowTop(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=1800');

  const [kospi, kosdaq] = await Promise.all([
    fetchMarketValueUniverse('KOSPI', 120),
    fetchMarketValueUniverse('KOSDAQ', 60),
  ]);
  const universe = [...kospi, ...kosdaq]
    .filter(s => s.itemCode && s.stockName && !ETF_PREFIX.test(s.stockName))
    .map(s => ({
      code: s.itemCode, name: s.stockName,
      suffix: s.sosok === '1' ? 'KQ' : 'KS',
      market: s.sosok === '1' ? 'KOSDAQ' : 'KOSPI',
    }));

  const flows = await Promise.all(universe.map(async u => {
    const f = await fetchFlow5d(u.code);
    return f ? { ...u, ...f } : null;
  }));
  const valid = flows.filter(Boolean);
  const withSmart = valid.map(v => ({ ...v, smartVal: v.foreignVal + v.instVal }));
  const inflow  = withSmart.slice().sort((a, b) => b.smartVal - a.smartVal).slice(0, 20);
  const outflow = withSmart.slice().sort((a, b) => a.smartVal - b.smartVal).slice(0, 20);

  const shape = v => ({
    ticker: `${v.code}.${v.suffix}`, name: v.name, market: v.market,
    foreignVal5d: Math.round(v.foreignVal), instVal5d: Math.round(v.instVal),
    smartVal5d: Math.round(v.smartVal),
  });

  return res.status(200).json({
    ok: true,
    universeSize: universe.length,
    dataSize: valid.length,
    inflow: inflow.map(shape),
    outflow: outflow.map(shape),
    ts: Date.now(),
  });
}
