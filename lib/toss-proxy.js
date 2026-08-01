// 토스증권 공식 API 프록시(GCP 고정 IP VM) 경유 공통 호출자.
// api/market-data.js에 있던 동일 로직을 그대로 옮겨온 것 — api/indices.js도 KR 지수
// (KOSPI/KOSDAQ) 보정을 위해 필요해서 공유 lib으로 분리(2026-07). api/market-data.js는
// 이미 안정적으로 동작 중이라 회귀 위험을 피하려고 그 파일 안의 정의는 그대로 두었음
// (약간의 중복이지만 그쪽을 건드리지 않는 게 더 안전).
export function tossProxyConfigured() {
  return !!(process.env.TOSS_PROXY_URL && process.env.TOSS_PROXY_SECRET);
}

export async function callTossProxy(path, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(`${process.env.TOSS_PROXY_URL}${path}`, {
        headers: { 'x-proxy-secret': process.env.TOSS_PROXY_SECRET },
        signal: AbortSignal.timeout(6000),
      });
      if (r.ok) return await r.json();
    } catch { /* 다음 시도로 폴백 */ }
    if (attempt < retries) await new Promise(r => setTimeout(r, 400));
  }
  return null;
}
