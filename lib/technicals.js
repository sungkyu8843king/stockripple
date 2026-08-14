// lib/technicals.js — RSI14/SMA20·50·200 + 시그널 판정 (Yahoo v8/chart 1년 일봉 기반).
// api/market-data.js(공개 /api/technicals 엔드포인트, 종목 페이지 지표 칩)와
// api/admin.js(company_summary AI 프롬프트에 실제 지표값을 근거로 주입)가 공유한다 —
// 두 곳이 서로 다른 계산을 쓰면 화면 칩과 AI 서술이 어긋나므로 반드시 이 파일 하나로 통일할 것.
const TECHNICALS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0',
  'Accept': 'application/json',
};

export async function fetchTechnicals(ticker) {
  try {
    // 1년 일봉 (RSI 14 + SMA 200 계산에 충분)
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1y`,
      { headers: TECHNICALS_HEADERS, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return [ticker, null];
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    if (!result) return [ticker, null];

    const closes = (result.indicators?.quote?.[0]?.close || []).filter(v => v != null);
    if (closes.length < 30) return [ticker, null];

    const price = closes[closes.length - 1];
    const sma20  = sma(closes, 20);
    const sma50  = sma(closes, 50);
    const sma200 = sma(closes, 200);
    const rsi14  = rsi(closes, 14);

    const signal = classifySignal({ price, sma20, sma50, sma200, rsi14 });

    return [ticker, {
      price:   round2(price),
      sma20:   sma20  != null ? round2(sma20)  : null,
      sma50:   sma50  != null ? round2(sma50)  : null,
      sma200:  sma200 != null ? round2(sma200) : null,
      rsi14:   rsi14  != null ? Math.round(rsi14) : null,
      vsSma20:  sma20  ? pct(price, sma20)  : null,
      vsSma50:  sma50  ? pct(price, sma50)  : null,
      vsSma200: sma200 ? pct(price, sma200) : null,
      signal,
    }];
  } catch {
    return [ticker, null];
  }
}

function sma(arr, n) {
  if (arr.length < n) return null;
  const slice = arr.slice(-n);
  return slice.reduce((s, v) => s + v, 0) / n;
}

// Wilder's RSI (period 14)
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  // 첫 평균
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  // 이후 Wilder smoothing
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function classifySignal({ price, sma20, sma50, sma200, rsi14 }) {
  // 골든크로스 (20 > 50 > 200) + 가격 > 모든 MA → 강세
  if (sma20 && sma50 && sma200 && price > sma20 && sma20 > sma50 && sma50 > sma200) {
    if (rsi14 >= 70) return 'overbought';       // 과매수
    if (rsi14 <= 30) return 'oversold_bull';    // 강세 추세 + 단기 과매도 (매수 기회)
    return 'strong_bullish';
  }
  // 데드크로스 (20 < 50 < 200) + 가격 < 모든 MA → 약세
  if (sma20 && sma50 && sma200 && price < sma20 && sma20 < sma50 && sma50 < sma200) {
    if (rsi14 <= 30) return 'oversold';
    return 'strong_bearish';
  }
  // 가격이 SMA50 위 + RSI 중립
  if (sma50 && price > sma50) {
    if (rsi14 >= 70) return 'overbought';
    if (rsi14 <= 30) return 'oversold_bull';
    return 'bullish';
  }
  // 가격이 SMA50 아래
  if (sma50 && price < sma50) {
    if (rsi14 <= 30) return 'oversold';
    return 'bearish';
  }
  if (rsi14 != null && rsi14 >= 70) return 'overbought';
  if (rsi14 != null && rsi14 <= 30) return 'oversold';
  return 'neutral';
}

function pct(a, b) {
  return Math.round((a - b) / b * 10000) / 100;
}
function round2(v) {
  return Math.round(v * 100) / 100;
}
