// coupang-feed-ad.js — 피드 상단 배너 광고(쿠팡 파트너스), 여러 페이지 공용.
// #feedAdSlot 엘리먼트가 있는 페이지에서 자동으로 채운다(defer로 로드되므로 DOM 파싱은 끝난 상태).
// iframe에 실제 정적 페이지(/coupang-ad-feed-*.html)를 물리는 이유(index.html에서 처음 정리된 내용):
// 1) <script> 태그를 템플릿 리터럴 문자열 안에 넣으면 HTML 파서가 종료 태그를 오인해 뒤 코드가
//    텍스트로 노출되는 사고, 2) g.js가 레거시 document.write() 방식이라 동적 주입 후엔 조용히
//    무시돼 광고가 안 뜸, 3) srcdoc은 진짜 URL이 없어 리퍼러 검증에 막힐 수 있음 — 세 가지를 모두 피한다.
//
// loadFeedAd()를 전역으로 노출 — etf.html처럼 #content 전체를 반복 재렌더하는 페이지는
// 재렌더할 때마다(= 매번 새 #feedAdSlot 엘리먼트가 생길 때마다) 직접 다시 호출해야 한다.
// dataset.loaded 가드로 같은 엘리먼트에 중복 삽입되는 것만 막는다.
function loadFeedAd() {
  const container = document.getElementById('feedAdSlot');
  if (!container || container.dataset.loaded) return;
  container.dataset.loaded = '1';
  const isMobile = window.innerWidth <= 768;
  const iframe = document.createElement('iframe');
  iframe.title = '광고';
  iframe.scrolling = 'no';
  iframe.src = isMobile ? '/coupang-ad-feed-mobile.html' : '/coupang-ad-feed-pc.html';
  iframe.style.cssText = `border:0;width:${isMobile ? 320 : 728}px;height:${isMobile ? 100 : 90}px;display:block;margin:0 auto;max-width:100%`;
  container.appendChild(iframe);
  const disclosure = document.createElement('div');
  disclosure.style.cssText = 'text-align:center;font-size:13px;color:var(--text3);margin-top:6px';
  disclosure.textContent = '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';
  container.appendChild(disclosure);
}
loadFeedAd(); // 정적 HTML에 #feedAdSlot이 이미 박혀 있는 페이지는 이 자동 1회 실행으로 충분
