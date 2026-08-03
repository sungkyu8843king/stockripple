# StockRipple — 파급효과 주식 전망 분석 플랫폼

뉴스 이슈의 파급효과를 Claude로 분석해 수혜 기업과 상승 가능성을 예측하는 플랫폼. 1인 운영 서비스, 실 사용자 있음.

## 배포 정보

| 항목 | 값 |
|------|----|
| GitHub repo | `sungkyu8843king/stockripple` |
| 배포 URL | `https://stockripple-sungkyu.vercel.app` |
| 배포 | **`git push origin master`** → Vercel 자동배포 (Hobby 플랜) |
| DB | Supabase (PostgreSQL + REST API) |
| AI | Claude (`@anthropic-ai/sdk`), 전량 `claude-haiku-4-5-20251001` |

`.env.notes.txt`: `ADMIN_SECRET`/`CRON_SECRET`은 Vercel 환경변수로 저장돼 있음(로컬엔 값 없음) — 어드민 패널(`/admin/`) Settings 탭에 `ADMIN_SECRET` 입력 필요. 다른 키: `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`(서버), `SUPABASE_ANON_KEY`(클라 하드코딩, 공개 정보), `ANTHROPIC_API_KEY`, `NEWS_API_KEY`, `FMP_API_KEY`(무료 250req/day).

---

## ⚠️ Vercel Hobby 12개 서버리스 함수 한도 — 새 `api/*.js` 파일 함부로 추가 금지

한 번 이 한도 초과로 배포 전체가 깨진 적 있음(`218a46b`). `api/`에 파일 11개 유지 중. **새 API가 필요하면 새 파일을 만들지 말고**, 성격이 비슷한 기존 파일에 `action=`/`type=`/`source=` 쿼리 파라미터로 라우팅을 추가하고 `vercel.json`의 `rewrites`로 예쁜 URL을 매핑할 것 (기존 패턴 참고: `/api/quotes` → `api/market-data.js?source=quotes`).

```
api/admin.js        — 어드민 전용 + 공개 조회 다수. action= 라우팅으로 40+ 엔드포인트 통합 (아래 참고)
                       ※ 2026-08-03 추가: render-analysis/render-company(SEO 프리렌더, HTML 반환)·sitemap(XML 반환)·company-news
api/admin-static.js — admin/index.html의 셸(shell)/로직(logic)을 텍스트 파일로 서빙 (lib/admin-dashboard-logic.txt)
api/analyze.js       — 뉴스→AI 분석 파이프라인 (Message Batches API, 아래 참고)
api/cron-daily.js    — Vercel cron(01:00 UTC 1회) 오케스트레이터, fire-and-forget로 여러 작업 트리거
api/fetch.js         — NewsAPI + RSS 뉴스 수집
api/feedback.js      — 피드백 챗위젯 저장
api/indices.js       — 지수 스파크라인(홈 대시보드 폴링) + ?chart=심볼id&range= 단일 지표 일봉 히스토리(market-detail.html 차트용, 완전히 분기된 별도 경로)
                       ※ market-data.js에 source=etf(action=list/detail/holders) 추가됨 — /api/etf로 rewrite (ETF 목록/상세/역조회)
api/kr-market.js     — 국장 요약(지수카드/인기검색/수급) — kr-market.html 전용
api/market-data.js   — quotes/technicals/earnings/market-pulse/kr-overtime/us-market 통합 (source= 라우팅). source=toss 하위에 action= 라우팅으로 토스증권 공식 API 10종 추가 통합: prices/quote(통합가+정규장·시간외 변동 분해)/rankings/rankings-all(홈 실시간 랭킹)/investor-trading/orderbook/meta(시총·경고뱃지)/daily(일별시세표)/candles(차트)/fx(환율)
api/notify.js        — 텔레그램 알림
api/stock.js         — 종목 상세: price/chart/fundamentals(KR=네이버, US=FMP)/investors/score-factors
```

---

## ⚠️ SEO 딥링크 프리렌더 (2026-08-03) — `/analysis/:id`·`/stock/:ticker`는 이제 정적 파일이 아니다

검색 유입이 0에 가까웠던 근본 원인: `robots.txt`/`sitemap.xml`이 아예 없었고, 개별 이슈·종목 페이지의 OG 태그가 전부 `"이슈 분석 — StockRipple"` 고정 문구였다(프레임워크 SSR이 없는 정적 HTML이라 rewrite가 파일을 그대로 서빙). 검색 유저는 "StockRipple"이 아니라 "아마존 실적 수혜주" 같은 키워드로 들어오므로 페이지마다 고유 제목·설명이 필요했다.

- **`api/admin.js`의 `render-analysis`/`render-company` 액션이 정적 HTML을 읽어 `<!-- SEO:START -->…<!-- SEO:END -->` 블록만 갈아끼워 서빙한다.** 나머지 바이트는 원본 그대로라 클라이언트 하이드레이션은 기존과 동일하게 동작. **`analysis.html`/`company.html`의 이 마커를 지우거나 이름을 바꾸면 치환이 조용히 실패하고 기본 문구가 그대로 노출된다.**
- **`readFileSync` 경로는 반드시 리터럴 문자열로 둘 것** — Vercel 빌드의 `@vercel/nft`가 정적 스캔으로 람다 번들 포함 파일을 정하기 때문에, 경로를 `req.query`로 조립하면 배포본에 파일이 없어 런타임에 터진다. `vercel.json`의 `functions["api/admin.js"].includeFiles`가 안전망.
- **⚠️ Vercel 라우팅 순서는 `redirects` → 파일시스템 → `rewrites`다.** 즉 `/company.html`처럼 **실제 파일이 있는 경로는 rewrite가 절대 발화하지 않는다.** 레거시 쿼리 URL(`?ticker=`/`?id=`, 사이트 내부에 90곳 있었음)을 예쁜 URL로 모으려고 `redirects`(307)를 쓴 이유. 실측 검증 후 `permanent: true`로 승격 예정 — 301은 브라우저가 영구 캐시해 롤백이 사실상 불가능하니 성급히 바꾸지 말 것.
- `sitemap.xml`도 `action=sitemap`으로 동적 생성(고정 페이지 + `ai_digest` 있는 최신 이슈 500 + 전체 종목). DB가 죽어도 고정 경로만 담은 유효 XML로 fail-open.
- **메타태그에 들어가는 데이터는 `issues`/`companies` 공개 필드뿐** — `analyses`/`analysis_companies`(수혜기업·신뢰도·상승여력)는 검색엔진에 노출되면 되돌릴 수 없으므로 절대 금지. 종목 페이지에 JSON-LD를 붙이지 않은 것도 같은 이유(`Product`/`FinancialProduct`는 투자상품 추천으로 읽힐 소지).
- `seoEsc()`는 HTML 이스케이프 + **공백 정규화**를 같이 한다 — 값에 개행이 하나만 남아도 meta 속성이 그 자리에서 끊겨 `<head>` 전체가 깨진다(실측 확인). DB 제목·종목명에 개행이 없다고 믿지 말 것.

## 공유 이미지 카드 (`analysis.html`, 2026-08-03)

오픈채팅·주식 커뮤니티에서는 링크보다 이미지 한 장이 훨씬 잘 퍼진다. "🖼 이미지로 공유" 버튼이 html2canvas(CDN)로 1080px 카드를 굽고 저장/복사를 제공한다.

- **실제 페이지를 스크린샷하지 않는다** — 광고·네비까지 딸려온다. 화면 밖(`#shareCardStage`) 전용 템플릿을 따로 그려 캡처한다. `display:none`은 못 쓴다(html2canvas가 크기를 못 잼).
- 카드는 **테마와 무관하게 항상 다크로 굽는다**(var() 대신 색상값을 박음) — 퍼지는 이미지가 보는 사람 설정에 따라 달라지면 브랜드가 흐려진다.
- **🚫 재료는 `issue`의 공개 필드(title/ai_digest/summary/news_analysis/published_at)뿐.** `analysis`·`companies` 변수는 절대 참조 금지 — 이미지로 저장돼 커뮤니티에 퍼지는 순간 회수가 불가능해 이 코드베이스에서 가장 위험한 노출 경로다.
- 텍스트 절단은 CSS `-webkit-line-clamp`가 아니라 JS(`_clip`)로 한다 — html2canvas가 line-clamp를 제대로 렌더하지 않는다.

## 페이지 구조 (2026-07 전면 재구조화)

`index.html`은 원래 3800+줄짜리 단일 페이지였다가, 정보 밀도 완화를 위해 전용 페이지로 분리됨. 홈은 이제 각 섹션의 **미리보기 카드**만 보여주고 "더보기"로 전용 페이지 유도.

| 페이지 | 역할 |
|--------|------|
| `index.html` | 홈 — 피드 + 각 섹션 미리보기 |
| `news.html` | 뉴스 전용 피드 — 2026-07-27 "🌡️ 지금 산업 온도" 보드 추가(news_analysis.sectors 톤 집계) |
| `heatmap.html` | 히트맵 전용 (섹터 드릴다운 뷰 포함) |
| `kr-market.html` | 국장·미장 현황 — 2026-07-31 전면 재설계(밤사이 브리지·시장 온도계·수급차트·뉴스vs주가·시간대 모드, 아래 전용 섹션 참고) |
| `picks.html` | 매수 후보 — ⚠️ 2026-07-21부터 공개 노출 중단(아래 유사투자자문업 섹션), 데이터는 비공개 유지 |
| `sectors.html` | 섹터 지도 |
| `analysis.html` | 이슈 상세 — 2026-07-21 대폭 축소(수혜기업/신뢰도 제거, ai_digest 요약 중심) |
| `company.html` | 종목 상세(딥링크 `/stock/:ticker`) — "📰 최근 뉴스 언급"은 2026-08-03에 `company-news` API 기반으로 재작성됨(구버전은 anon 차단된 `analysis_companies`를 직접 조회해 늘 빈 섹션이었음). 직접 언급(이름 ilike) 우선, 5건 미만이면 `news_analysis.sectors` 업종 부분일치로 보충. Toss 공식 API 기반 통합가+정규장/시간외 변동 분해, 호가창, 일별시세표, lightweight-charts 캔들+매물대 차트, AI 종합분석/펀더멘털/DART/투자자동향/옵션체인/애널리스트 컨센서스. 예측 수치(상승여력%·신뢰도%·STRONG BUY 등)는 없음 — 적중률이 낮아(20%대) 신뢰 근거로 못 씀, 대신 "파급효과" 정성적 뉴스 연결만 제공 |
| `market-detail.html` | 시장지표 상세(지수/원자재/환율/암호화폐) — Toss/Yahoo 소스, lightweight-charts 자체 차트(1개월/6개월/1년) + 52주 레인지. `?sym=` 쿼리로 지표 선택(`MKT` 객체가 지원 목록) |
| `etf.html` | ETF 탐색 — 국내 상장 ETF 전체(~1,150종) 목록(카테고리 탭·수익률/거래대금 정렬·검색) + `?code=`로 상세(총보수·추적오차·괴리율·순자산·기간수익률 D1~Y10·자산/국가/섹터 배분·상위10 구성종목·자금유입). 전부 네이버 무키 소스, 저장 없이 실시간. 상세는 lightweight-charts 없이 순수 데이터. ETF↔종목 링크: 상세의 국내 구성종목은 company.html로, company.html의 "이 종목을 담은 ETF" 역조회는 etf.html로 상호 연결 |
| `talks.html` | 말말말 — 이슈 주제별(예: 미·이란 전쟁, 코스피 레버리지) 타임라인 페이지. `TOPICS` 배열에 주제 추가하면 끝, 연관 지수·종목 시세 카드 + issues DB 키워드 필터 뉴스 타임라인 |
| `terminal.html` | 블룸버그풍 터미널 화면(지수 스트립·마켓펄스·섹터모멘텀). nav에는 없고 URL로만 접근 |
| `portfolio.html` | **모의투자** — 2026-08-01 전면 재작성(아래 전용 섹션). nav 라벨도 "페이퍼 트레이딩"→"📝 모의투자" |
| `account.html` | 계정 |
| `admin/index.html` | 어드민 (셸만 정적, 로직은 `/api/admin-logic`에서 fetch) |
| `privacy.html`, `terms.html` | 개인정보처리방침·이용약관 (2026-07-22, 푸터 링크) |

**공용 로직은 `app.js`(4300+줄, `/app.js`)** — `index/heatmap/kr-market/picks/sectors` 5개 페이지가 공유(auth·관심종목·인사이트카드·지수·캘린더·히트맵 렌더링·국장현황 등 거의 전부). **이 파일을 고치면 5개 페이지에 동시 영향** — 한 페이지만 고치려는 의도면 그 페이지의 인라인 `<script>`를 찾을 것. `announcement-bar.js`(긴급 안내 배너), `sr-pulse.js`는 대부분 페이지가 개별 로드.

**헤더/푸터/로그인/검색은 `site-header.js`(2026-07-22 통합)** — 이전의 "인증 JS 4곳 중복" 구조를 이 파일 하나로 합쳤다. 헤더 구조·로그인 규칙·검색 로직 변경은 이 파일만 고치면 전체 페이지 반영. 사용법(각 페이지): supabase CDN → `/site-header.js`(동기 로드 필수, defer 금지) → `<div id="site-header-mount"></div><script>renderSiteHeader('/현재페이지.html')</script>`, 푸터는 `renderSiteFooter()`, 페이지 스크립트 끝에 `initAuth()` 1회. **예외**: `app.js`(5개 공유 페이지)와 `analysis.html`은 관심종목 캐시 때문에 `initAuth`/`renderUserMenu`를 자기 것으로 재선언해 덮어쓴다 — site-header.js에서 그 두 함수 이름을 바꾸면 이 덮어쓰기가 조용히 깨진다. 회원가입 비밀번호 규칙: 영문+숫자+특수문자 8자 이상(`validateSignupPassword`).

## ⚠️ 유사투자자문업 리스크 대응 (2026-07-21 방향 전환)

"매수 후보/신뢰도%/상승여력/파급효과 수혜기업" 등 **투자판단으로 읽힐 수 있는 데이터의 공개 노출을 전면 중단**했다. UI 제거만으론 부족해서(브라우저의 공개 anon key로 Supabase REST를 직접 치면 그대로 노출) **`db/disable-public-recommendations.sql`이 실제 차단 지점** — `analyses`/`analysis_companies`/`company_ai_summary`의 anon SELECT 정책을 DROP했다. service_role(서버 API)은 RLS 우회라 파이프라인은 계속 돈다. **새 기능을 만들 때 이 3개 테이블을 anon(브라우저 직접 쿼리)으로 읽는 코드를 다시 넣으면 안 됨** — 서버 API 경유로도 이 데이터를 공개 응답에 담지 말 것. 대체 파이프라인(투자판단 없는 순수 사실 서술만): `article_digest`(issues.ai_digest 컬럼, 기사 2~3문장 요약), `rank_reason`(rank_reasons 테이블, 홈 랭킹 종목별 12~28자 토스 스타일 테마 문구 — 예: "반도체주 동반 강세"). 재개 조건(신고 완료 등) 충족 시 원본 CREATE POLICY 복원으로 되돌릴 수 있다.

**AI 큐 운영(토큰 절감, 2026-07-21~22)**: 스케줄 Claude Code 에이전트는 **KST 고정 12슬롯 시간표**로 돌고, agent-queue per-cycle 한도는 5/5로 축소됨(구 20/25). 파이프라인 추가 시 어드민 패널의 시간표 문서와 맞출 것.

**뉴스 이슈 분석 짝수시 추가(2026-07-28)**: 위 12슬롯 시간표(`stockripple-analyze-agent`, cron `15 1-23/2 * * *`, 홀수시)와 별도로, 짝수시 전용 자매 스케줄 작업 `stockripple-news-only-agent`(cron `15 0-22/2 * * *`)가 추가됨 — 이 작업은 뉴스분석 제출 + `analyze_batches`(이슈 discover/decide) 처리만 하고 `agent_jobs`(나머지 6개 파이프라인 + article_digest/rank_reason)는 전혀 건드리지 않는다. 목적은 뉴스 이슈 판단 신선도를 2시간 주기에서 1시간 주기로 좁히는 것 — 나머지 파이프라인과 슬롯별 추가 제출(AI 시장종합/종목분석/데일리 등)은 여전히 홀수시 2시간 주기 그대로. 두 스케줄 작업 모두 `C:\Users\S9_User\.claude\scheduled-tasks\`에 SKILL.md로 존재.

**`news_analysis` — article_digest 확장(2026-07-27, 다른 계정 작업)**: `article_digest` 파이프라인이 기존 `ai_digest`(순수 요약) 외에 같은 큐 항목 하나로 `issues.news_analysis` jsonb 컬럼(`{keypoints:["핵심1",...], sectors:[{name,tone:"pos|neg|neu"}]}`)도 함께 채우도록 확장됨(`db/news-analysis.sql` — **아직 실행 안 됨, 마이그레이션 전까지는 컬럼 없이 우아하게 폴백**). `sectors[].tone`은 "이 뉴스가 어떤 산업 테마에 우호적/비우호적인가"라는 편집성 분류일 뿐 특정 종목을 지목하지 않아 `analyses`/`analysis_companies`와 무관 — `expose_ripple_effects` 게이트 대상이 아니고 노출 여부와 무관하게 항상 응답에 포함됨. `news.html`에 이 톤을 최근~120건 집계한 "🌡️ 지금 산업 온도" 보드가 추가됐고, `analysis.html`(이슈 상세)에도 🔑 핵심 포인트 + 📡 산업 영향 톤 칩이 추가됨. 스케줄 Claude Code 에이전트(`stockripple-analyze-agent` SKILL.md)의 `article_digest` 응답 스키마도 이 3필드로 갱신해둠.

**⚠️ 노출 게이트는 `analyze`가 아니라 `expose_ripple_effects`(2026-07-27 분리)**: 원래 `handleIssuesFeed`/`handleInsightsRaw`/`handleSectorMapGet`(`api/admin.js`) 셋 다 "매수후보/신뢰도/파급효과 데이터를 공개 응답에 넣을지"를 `analyze` 플래그 하나로 판단하고 있었다 — `analyze`는 원래 "분석 파이프라인을 실행할지"(비용/운영 목적)를 위한 플래그인데, 같은 스위치가 노출 여부까지 겸하고 있어서 **`analyze`를 다른 이유로(예: 파이프라인 재개 테스트) 다시 켜면 공개 API가 조용히 다시 노출**되는 사고가 있었다(2026-07-25에 켜진 채로 이틀간 방치돼 있다가 2026-07-27 뉴스피드 점검 중 발견). 지금은 별도 fail-closed 플래그 `expose_ripple_effects`(기본 false, `lib/feature-flags.js`의 `isFeatureEnabledStrict()`로 확인 — 행 없거나 조회 실패 시도 OFF)로 분리했다. **`analyze`는 파이프라인 on/off만 담당, 공개 노출은 오직 `expose_ripple_effects`가 결정** — 새 엔드포인트에서 이 3개 테이블(analyses/analysis_companies 조인, ripple_effects, confidence_score, 매수후보 companies)을 다시 노출하려 하면 반드시 `isFeatureEnabledStrict(supabase, 'expose_ripple_effects')`로 게이트할 것, `isFeatureEnabled(supabase, 'analyze')`로 게이트하면 이 사고가 재발한다.

## ⚠️ TradingView 무료 임베드 — 지수 심볼 절반이 아예 안 뜸

`market-detail.html`이 원래 TradingView `widgetembed` iframe을 썼는데, 실측(2026-07)해보니 12개 시장지표 중 **NASDAQ:IXIC(나스닥종합)/KRX:KOSPI/KRX:KOSDAQ/TVC:VIX/NASDAQ:SOX/CME_MINI:NQ1!(나스닥100선물) 6개가 "TradingView 에서만 제공되는 심볼입니다" 에러**로 아예 안 뜸(TVC:/CBOE: 등 다른 프리픽스로 바꿔도 동일 — 해당 지수 자체가 무료 임베드 티어에서 제외된 것). FOREXCOM:SPXUSD/FOREXCOM:DJI/FX_IDC:USDKRW/BITSTAMP:BTCUSD/TVC:GOLD/TVC:USOIL는 정상 작동. → **해결책은 TradingView 심볼을 계속 바꿔가며 찾는 게 아니라 자체 차트로 대체**: `api/indices.js`의 `?chart=심볼id&range=` 브랜치가 Yahoo 일봉을 반환하고, `market-detail.html`이 lightweight-charts(area series)로 직접 그림 — 12개 전부 이 방식이라 TradingView 가용성 문제 자체가 없음. 다른 화면에 차트를 새로 넣을 때도 TradingView 무료 임베드부터 시도하지 말고 이 패턴(Yahoo 히스토리 + lightweight-charts)을 먼저 고려할 것.

---

## 시장현황(`kr-market.html`) v2 — 2026-07-31 전면 재설계

랭킹 나열 위주였던 페이지를 "지금 뭘 봐야 하는지"에 답하는 화면으로 재구성했다. **모든 신규 로직은 `kr-market.html` 맨 아래 인라인 `<script>`(IIFE)에 있고 `app.js`에 의존하지 않는다** — `app.js`는 5개 페이지 공유라 여기에 이 페이지 전용 코드를 더 넣지 말 것. 기존 랭킹 블록(`loadKrMarket`/`switchKrMarket`)만 `app.js` 것을 계속 쓰는데, 그건 **`index.html`도 같이 쓰므로 지우면 안 된다**.

- **① 밤사이 브리지**: 하드코딩된 `BRIDGE` 테이블(미국 종목군 → 한국 공급망 대응 종목군, 4개 테마)로 양쪽 평균 등락률을 구해 차이를 '갭'으로 표시. `국장 미반영(+)`/`국장 선반영(−)`, |갭|≥3%p면 ⚡. 데이터는 `/api/indices` + `/api/quotes`(KR·US 티커 혼합 조회 가능). 테마·종목을 늘리려면 `BRIDGE` 배열만 고치면 된다.
- **② 시장 온도계**: VIX·외국인 5일 순매수·USD/KRW 등락률·코스피 52주 위치를 각각 0~100으로 정규화 후 가중평균(1.1/1.1/0.9/0.9) → 반원 SVG 게이지. 구성요소가 하나라도 빠지면 남은 것만으로 계산한다(전부 실패해야 에러 표시).
- **③ 투자자별 수급**: **네이버 캡처 PNG를 버렸다.** 다크모드에서 흰 판이 뜨고 확대·툴팁이 불가능했음. 지금은 `/api/toss?action=investor-trading` 20거래일 JSON으로 자체 SVG 막대차트(개인/외국인/기관 3계열, 일별↔누적 토글, hover 툴팁). 차트 SVG는 `min-width:520px`이고 `.fl-chart`가 `overflow-x:auto` — **페이지 전체가 아니라 차트 안에서만 가로 스크롤**된다.
- **④ 뉴스 온도 vs 실제 주가**: `issues.news_analysis.sectors[].tone` 집계(최근 120건, `app.js`의 `loadSectorTemp`와 같은 소스)를 `SEC_MAP`(산업명 키워드 → 대표 종목 티커)으로 실제 평균 등락률과 교차해 "뉴스↑ 주가↓" 괴리를 찾는다. 산업명은 AI가 자유 생성하므로 `SEC_MAP`은 **부분일치(`includes`)** 로 매칭하고, 같은 종목군에 매핑된 산업은 뉴스 건수 최다 1개만 남긴다. `sectors[].tone`은 `expose_ripple_effects` 게이트 대상이 아님(위 섹션 참고).
- **⑤ NOW 바**: KST 시각으로 개장준비/장중/마감/미장대기/미장장중/새벽/휴장 7개 모드를 판정해 문구·강조색·남은시간을 바꾼다. **로컬 시계가 어긋난 전례가 있어 `Date.now()+9h`로 UTC에서 직접 환산**한다(`kstNow()`).

시각 토큰은 기존 것만 쓴다(`--bg2`/`--border`/`--blue`/`--font-mono` 등). 한국 관례대로 **상승=`--red`, 하락=`--blue`** — 신규 코드에서도 반드시 지킬 것.

### ⓪ 국장 시세 / 해외 추정가 + 실측 정확도 (2026-07-31)

같은 카드 UI가 시간대에 따라 **국장 실제 시세**와 **해외 신호 기반 추정가** 두 모드로 갈린다. 모드 판정은 **서버가 KST로** 하고 `live`/`session`으로 내려준다:

| KST | session | 표시 |
|---|---|---|
| 09:00~15:30 | `regular` | 정규장 실시간 체결가 |
| 15:30~20:00 | `nxt` | 넥스트장(대체거래소) 통합가 — 토스 `/prices` `lastPrice` |
| 20:00~22:30 | `closed` | 거래 없음, 마지막 시세 유지 |
| 22:30~09:00 · 주말 | (추정) | 해외 신호로 역산한 추정가 |

**⚠️ 22:30 이전에 추정하면 안 된다** — 미국장이 열리기 전이라 EWY/ADR이 전날 세션 값이고, 17시간 묵은 신호로 예측하는 꼴이 된다. 이 경계를 앞당기지 말 것.

```
추정등락% = Σ(소스등락% × beta × w) / Σ(w)     ← 사용 가능한 소스만
추정가    = 직전 종가 × (1 + 추정등락%/100)
```

- **모델은 서버 `api/market-data.js`의 `EST_MODEL`에 있다.** 개장 전 스냅샷을 크론이 기록해야 정확도를 누적 측정할 수 있는데, 모델이 클라이언트에만 있으면 서버가 같은 값을 재현할 수 없어서다. 튜닝은 이 객체 하나(`targets[].sources[]`의 `w`=신뢰 가중치, `beta`=소스 민감도)만 고치면 되고 **클라이언트는 렌더링만 한다** — `kr-market.html`에 모델을 다시 넣지 말 것.
- 소스가 죽으면 자동 제외되고 **남은 소스로 가중치가 재정규화**된다. 카드에 반영 소스·신뢰도(소스 수 + 표준편차 기반 4단계)·직전 종가·실측 평균오차를 노출해 근거를 검증할 수 있다.
- 원재료: `?source=kr-proxy` — EWY(MSCI 한국 ETF)·`^SOX`·`KRW=X`·ADR/직상장 8종(SKM/KB/PKX/LPL/WF/SHG/KEP/**SKHY**). ADR을 늘리려면 `KR_PROXY_SYMBOLS`에 추가. **SKHY(SK하이닉스, 2026-07-31 NASDAQ 직상장)** 발견 후 EST_MODEL도 같이 갱신 — 그 전엔 미국 상장 자체가 없어 삼성전자처럼 binance perp+EWY+SOX로 추정했지만, 이제 다른 6개 ADR 종목과 같은 패턴(adr:SKHY w2.2 + ewy w0.5)으로 훨씬 직접적인 신호를 쓴다. 삼성전자는 여전히 미국 상장이 없어(런던/슈투트가르트 등 유럽 예탁만 있음, 실측 확인) 기존 방식 유지 — 새 한국 종목의 미국 상장 여부는 감으로 판단하지 말고 Yahoo `v1/finance/search`로 실측 확인할 것(거래량까지 확인, OTC 휴지 종목이 섞여 나올 수 있음).
- **⚠️ 바이낸스 주식 perp는 Vercel에서 HTTP 451(지역 차단)** (2026-07-31 실측). 브라우저는 뚫릴 수 있어 클라이언트가 읽어 `?bn=티커:등락%,…`로 서버에 넘기면 모델에 합류한다. **DB에 남는 정확도 스냅샷은 서버 단독 계산이라 이 값에 오염되지 않는다.** 서버에서 직접 재시도하게 바꾸지 말 것.
- **KOSPI 선물은 Yahoo에 없다** — `KSU=F` 404, `^KS200`은 현물이라 장중에만 갱신. **코스피200 야간선물은 2026-08-01부터 KIS(한국투자증권) Open API로 반영** — 아래 전용 섹션 참고. `kis_night_future` 소스로 8종목 전부에 들어가 있고, `kr-market.html`에 별도 배너로도 보여준다(개별 종목 ADR과 달리 시장 전체 신호라서).

**실측 정확도 (`db/est-accuracy.sql` — Supabase에서 실행 필요)**
- `?action=record` (ADMIN/CRON 인증): KST 평일 07~09시면 그날 추정치를 스냅샷, 개장 후엔 실제 시가로 정산해 `error_pct`(= 실제 − 추정, 양수면 과소추정)를 채운다. **매시간 불러도 멱등** — 창 밖이면 서버가 스스로 스킵. `analyze-backlog.yml`이 호출한다.
- `?action=accuracy` (공개): 티커별 MAE·편향(bias)·표본수. 화면에 "실측 평균오차 ±N%p (M회)"로 표시.
- **감으로 beta를 고치지 말 것.** 2026-07-31 실측에서 삼성전자 추정 +9.5% vs 실제 +21.7%(시가 +24.2%)로 크게 과소추정했는데, 그날은 반도체 폭등이 겹친 극단값이라 하루치로 튜닝하면 과적합된다. `est_accuracy`가 며칠 쌓인 뒤 `bias`를 보고 조정할 것.
- 화면의 **"이건 예상 수치입니다" 경고는 사용자가 명시적으로 요구한 것**이니 임의로 빼지 말 것(유사투자자문업 리스크와도 직결). 장중 모드에서는 추정이 아니므로 자동으로 숨긴다.

**코스피200 야간선물(KIS Open API, 2026-08-01 추가)** — `api/market-data.js`의 `fetchKisNightFuture()`/`getKisToken()`/`getKisNightFutureCode()`.
- **한국투자증권 실계좌 + API키가 필요하다**(무료지만 계좌 개설 필수). `KIS_APP_KEY`/`KIS_APP_SECRET`은 Vercel 환경변수(로컬엔 값 없음, 다른 시크릿들과 동일 패턴).
- **⚠️ access_token 발급은 KIS 쪽에서 하루 단위로 제한된다.** 서버리스라 요청마다 프로세스가 새로 뜨므로 인메모리 캐싱이 안 되고, `kis_token_cache` 테이블(단일 행, service_role 전용 RLS — 다른 캐시 테이블과 달리 anon 읽기 정책 없음, `db/kis-token-cache.sql`)에 저장해 만료 전까지 재사용한다. **이 캐시를 건너뛰고 매 요청 재발급하는 코드로 절대 바꾸지 말 것** — 발급 제한에 걸리면 하루 종일 이 소스가 죽는다.
- 종목코드(`FID_INPUT_ISCD`, 예: `A01609`)는 분기 만기 롤오버가 있어 KIS가 공개 배포하는 마스터파일(`new.real.download.dws.co.kr/common/master/fo_cme_code.mst.zip`, 인증 불필요, EUC-KR 고정폭 텍스트)에서 KOSPI200 근월물(가장 빠른 만기)을 골라 같은 테이블에 하루 단위로 캐싱한다. 컬럼 레이아웃은 KIS 공식 예제(`github.com/koreainvestment/open-trading-api` `stocks_info/domestic_cme_future_code.py`)에서 이식.
- 실측 확인된 필드(`/uapi/domestic-futureoption/v1/quotations/inquire-price`, `tr_id: FHMIF10000000`, `FID_COND_MRKT_DIV_CODE=F`): `output1.futs_prpr`(현재가)·`output1.futs_prdy_ctrt`(전일대비율%)·`output1.futs_prdy_clpr`(전일종가). `output2`/`output3`은 참고용 코스피 종합/코스피200 현물 지수라 안 씀.
- 실패해도(계좌 문제·네트워크·만기 롤오버 실패 등) 다른 소스처럼 fail-open — `fetchKisNightFuture()`가 null 반환, 모델은 남은 소스로 재정규화.
- `?source=kis-test`(어드민 인증) — 디버그 전용, 원본 KIS 응답을 그대로 반환. 문제 생기면 여기부터 확인. `diag` 필드로 토큰발급/코드조회/시세조회 중 어느 단계까지 갔는지 알 수 있다.
- **⚠️ 프리징(값이 안 바뀐 채 실제 시세와 어긋남) 사고가 두 번 있었다 — `|등락률|>10%p` 체크만으로는 못 잡는다.** 1차(등락률 +18.79%로 몇 시간 고정, 실제 -4.78%)는 위 임계값 체크로 막았지만, 2차(2026-08-03, 값이 -3.72%로 고정, 실제는 -5.4%대까지 하락 — 사용자가 실측으로 발견)는 폭이 10%를 안 넘어 그 체크를 통과했다. `isKisNightFutureFrozen()`(`api/market-data.js`)이 별도로 감지 — 서버리스라 인메모리로 직전 값을 못 들고 있으니 `kis_token_cache`에 "값이 마지막으로 바뀐 시각"을 저장해두고(`db/kis-night-future-freeze.sql` 마이그레이션 필요, 실행 전엔 컬럼 없이 감지 기능만 fail-open으로 건너뜀), 같은 값이 **7분**(kr-market.html의 3분 자동새로고침 주기보다 넉넉히) 넘게 유지되면 무효 처리한다. **원인 자체(왜 KIS REST 스냅샷이 가끔 얼어붙는지)는 여전히 불명** — 이 감지는 증상 완화용 안전장치이지 근본 수정이 아니다.

## 모의투자 (`portfolio.html`) — 2026-08-01 전면 재작성

구 "가상 포트폴리오"를 실제 증권사 주문 화면 형태로 다시 만들었다. nav 라벨도 "페이퍼 트레이딩" → "**모의투자**"(`site-header.js`의 `SITE_NAV_ITEMS`). 페이지 전용 로직은 전부 `portfolio.html` 인라인 `<script>`에 있고 `app.js`에 의존하지 않는다.

- **⚠️ 재작성의 핵심 이유**: 구버전은 `analysis_companies`에서 "AI 추천 워치리스트"(STRONG BUY·신뢰도%·목표가·손절가·상승여력%)를 읽어 카드로 뿌렸는데, 그 테이블의 anon SELECT 정책은 `db/disable-public-recommendations.sql`로 이미 DROP된 상태(유사투자자문업 리스크, 위 섹션 참고)라 **실제로는 늘 빈 섹션이었다** — UI 껍데기만 남아 있었다. 재작성하면서 그 축을 통째로 걷어냈다. **이 페이지에 목표가·손절가·신뢰도·상승여력·매수후보류를 다시 넣지 말 것.**
- **"종목 찾기"는 투자판단이 아닌 객관적 시장 집계로만 채운다** — `/api/toss?action=rankings-all&market=KR|US`의 5개 카테고리(인기/거래대금/거래량/급등/급락). 화면에도 "매수·매도 의견이 아니다"라고 명시.
- **주문**: 종목 검색(자동완성) → 종목 선택 → 매수/매도 탭 → 수량(10/25/50/최대 비율 버튼) → 주문. 잔고 초과·보유수량 초과는 버튼 비활성 + 사유 표시.
- **검색 정렬(`rankSearch`)**: `companies` ilike 결과를 DB 순서 그대로 두면 "삼성"에 삼성전자가 10번째로 밀린다(계열사 과다). 이름 매칭 등급 → **토스 랭킹에서의 순위(`popScore`)** → 이름 길이 순으로 정렬한다. 랭킹 데이터는 종목찾기용으로 이미 받아둔 걸 재사용하므로 추가 호출이 없다.
- **매도는 FIFO + 로트 분할**: 일부만 팔면 원래 로트의 `quantity`를 줄이고, 판 만큼을 별도 `closed` 행으로 insert한다. 평균단가와 거래내역이 동시에 어긋나지 않게 하려면 이 방식이어야 한다.
- **손익은 "진입 시점 환율 고정"**(`entry_fx_rate`) — 미국 종목 환차익을 손익에서 빼고 순수 주가 수익률만 보여준다(구버전 정책 유지). 이 컬럼은 `db/paper-trading.sql` 이후 추가된 거라, 없으면 빼고 재시도하는 fail-open 처리가 `doBuy`에 있다.
- 로그인 게이트는 자체 로그인 폼을 복제하지 않고 `site-header.js`의 `openAuthModal()`을 그대로 부른다(구버전은 ~80줄짜리 로그인 UI를 중복 보유했었다).
- 폰트/토큰은 메인과 동일(Inter + JetBrains Mono, `--font-mono`). 상승=`--red`/하락=`--blue` 한국 관례 준수.

## ETF 서브시스템 (2026-07 신규)

`etf.html`(목록+상세) + company.html "이 종목을 담은 ETF"(역조회) + market-data.js `source=etf` 라우팅(`/api/etf` rewrite) + admin.js `crawl-etf-holdings` + `etf_holdings` 테이블.

**데이터 소스 — 전부 네이버, 키 불필요:**
- **전체 목록**: `finance.naver.com/api/sise/etfItemList.nhn` — **응답이 EUC-KR 인코딩**이라 `arrayBuffer` → `new TextDecoder('euc-kr')`로 디코드해야 종목명이 안 깨짐(UTF-8로 그냥 읽으면 깨짐, 실측). 필드: nowVal, changeRate, nav, threeMonthEarnRate, quant(거래량), amonut(거래대금, **백만원 단위**), etfTabCode(1 국내지수/2 업종·테마/3 파생/4 해외주식/5 원자재/6 채권·금리/7 기타).
- **개별 상세**: `m.stock.naver.com/api/stock/{code}/etfAnalysis` — UTF-8. 총보수·추적오차·괴리율·기간수익률(returnPerformanceList: D1/W1/M1/M3/M6/YTD/Y1/Y3/Y5/Y10)·자산/국가/섹터 배분·상위10 구성종목(etfTop10MajorConstituentAssets)·순유입.
  - **단위 함정(네이버 특유)**: `totalFee`/`chaseErrorRate`/`deviationRate`는 이미 **% 단위 숫자**(예 0.15=0.15%; 미국지수 ETF는 수수료 전쟁으로 0.0068% 같은 초저보수가 실제값). `marketValue`/`totalNav`는 숫자가 아니라 **이미 포맷된 문자열**("11조 5,043억") — `parseFloat` 하면 "115043"로 뭉개짐, 문자열 그대로 표시할 것. `cumulativeNetInflowList`는 **배열이 아니라 객체**(기간별 "136억" 문자열 필드).
  - 구성종목: 국내 종목만 `itemCode`(6자리)·`etfWeight`가 채워짐(해외주식(4)·원자재(5) ETF는 비어있음 — 역인덱스엔 자연히 기여 안 하지만, 총보수·순자산 등은 이 카테고리도 유의미해서 크롤 자체는 전 카테고리 대상으로 돈다).

**역조회(`etf_holdings` 테이블)**: "이 종목을 담은 ETF"는 각 ETF의 상위10 구성종목을 미리 크롤해 적재해둔 인덱스에서 조회(라이브 역조회는 불가능 — 종목→ETF API가 없음). `db/etf-holdings.sql`로 테이블 생성 후 `POST /api/admin?action=crawl-etf-holdings`(멱등 upsert, concurrency 12) — 어드민 패널 "전략투자 관리" 탭의 "🧺 ETF 보유종목 크롤" 버튼이 done:true 될 때까지 자동으로 이어서 호출한다(resumable, start/nextStart). 매일 cron-daily가 fire-and-forget로도 갱신. **상위10만 담으므로 "주요 보유" 신호**(소수 비중은 미포함) — KRX PDF(전체 구성내역)는 스크래핑 차단이라 안 씀.

**스냅샷(`etf_snapshot` 테이블)**: 목록 API엔 없는 총보수·추적오차·순자산·1일/1주 누적순유입을 저장 — crawl-etf-holdings가 종목당 이미 부르는 etfAnalysis 응답에서 추가 필드만 더 뽑아 같이 upsert(별도 API 호출 없음). 랭킹(`action=rankings`: 자금유입 상위/최저보수/순자산최대)에 사용. `marketValue`/`netInflow` 파싱은 `krwToNumber()`("11조 5,043억" → 숫자, admin.js)로 처리. **`issuer_name`(운용사, 2026-08-01 추가)**: `db/etf-snapshot-issuer.sql` 마이그레이션 필요 — 실행 전엔 목록 API(`handleEtfList`)가 그 컬럼 없이 자동 폴백하고, 실행 후에도 다음 `crawl-etf-holdings` 크론(매일)이 한 바퀴 돌아야 실제 값이 채워진다(즉시 수동 반영하려면 어드민 패널 "🧺 ETF 보유종목 크롤" 버튼). etf.html 목록에 운용사 배지 + "순자산" 정렬 옵션으로 노출.

**etf.html 랭킹 섹션**: 오늘 급등/급락·3개월수익률·거래대금 4종은 이미 로드된 목록 데이터에서 **클라이언트가 즉시 계산**(추가 호출 없음), 자금유입·최저보수 2종만 `action=rankings`로 서버 조회(스냅샷 없으면 "아직 데이터가 없어요"로 우아하게 표시).

**종목 검색(`action=holders&q=`)**: 티커 6자리면 바로 역조회, 아니면 `etf_holdings.stock_name` ILIKE로 후보 제안(자동완성) 후 선택 시 역조회. 역조회 결과는 편입비중뿐 아니라 그 ETF의 실시간 등락률·3개월수익률까지 목록 API와 조인해 같이 반환 — etf.html("종목으로 ETF 찾기")과 company.html(해당 종목 페이지) 둘 다 이 enriched 응답을 쓴다.

## 히트맵 트리맵 시총 캐시 (`shares_outstanding` 테이블, 2026-07-27~28)

`heatmap.html`의 Finviz 스타일 트리맵은 박스 크기를 **시가총액**(실시간가 × 상장주식수)으로 정한다. Yahoo v8 chart엔 시총·주식수가 없고 Yahoo v7·FMP는 막혀 있어, Toss meta(`action=meta`)가 주는 `sharesOutstanding`을 쓴다 — 히트맵 762종목 전부를 실시간 조회하면 렌더마다 762콜이라 대신 **캐시**한다.

- 최초 구현(`5aae05c`)은 762종목을 로컬 스크립트로 한 번 긁어 `/data/shares-outstanding.json`(13KB, 저장소 커밋) 정적 파일로만 뒀다 — 히트맵에 신규 종목이 추가되거나 상장폐지되면 수동으로 다시 긁어 재배포해야 하는 한계가 있었다.
- 이후 `shares_outstanding` 테이블(`db/shares-outstanding.sql`, anon 읽기 허용 — 발행주식수는 투자판단 데이터가 아니라 `expose_ripple_effects` 게이트 대상 아님)로 옮겨 **자동 갱신**되게 했다:
  - `POST /api/admin?action=crawl-shares-outstanding`(`handleCrawlSharesOutstanding`, admin 인증) — 대상 티커는 서버가 직접 못 읽는 클라이언트 목록 대신 `/data/shares-outstanding.json`의 키를 그대로 재사용. Toss 프록시가 동시성에 민감해(concurrency 6에서 절반 실패 실측) **concurrency 3** + 50초 시간예산의 resumable 크롤(`start`/`nextStart`, `crawl-etf-holdings`와 동일 패턴). **7일 이내에 이미 갱신됐으면 스킵**(`force:true`로 강제 가능) — 주식수는 분기 단위로만 바뀌므로 매일 돌 필요가 없다.
  - `cron-daily.js`가 매일 fire-and-forget으로 호출(핸들러 자체 신선도가드 덕에 실제 크롤은 주 1회만 실행).
  - `GET /api/admin?action=shares-outstanding`(`handleSharesOutstandingGet`, 공개) — 테이블 전체를 `{ticker: shares}` 맵으로 반환, `s-maxage=86400` 캐시.
  - `app.js`의 `loadSharesOutstanding()`이 이제 이 DB 엔드포인트를 우선 호출하고, 응답이 실패하거나 비어 있으면(마이그레이션 전 등) `/data/shares-outstanding.json` 정적 스냅샷으로 폴백 — 신규 종목의 주식수만 누락될 뿐 히트맵 자체가 비는 일은 없다.
- 상장주식수가 없는 종목은 거래대금으로 폴백해 박스가 사라지지 않게 한다(`app.js` `renderHeatmapTreemap`).

## ⚠️ CSS Grid/Flex 아이템 `min-width:auto` 함정 — 모바일 가로스크롤의 반복 원인

이 프로젝트에서 "모바일에서 화면이 넘친다/작게 보인다" 버그가 **여러 번** 재발했는데 전부 같은 원인이었다: Grid/Flex 아이템의 기본값은 `min-width:auto`라서, **줄바꿈 지점이 없는 콘텐츠**(원화 숫자 `₩1,406,000`, 티커, 긴 영문 이름)가 트랙/아이템을 콘텐츠 최소너비만큼 강제로 넓혀서 부모가 넘침 → 모바일 브라우저가 페이지 전체를 축소 렌더링하거나 가로스크롤 발생.

**새 카드/그리드를 추가할 때 항상**: `grid-template-columns`에 `minmax(0,1fr)` 사용(또는 자식에 `min-width:0`), 숫자/가격 표시엔 `overflow-wrap:break-word` 또는 `text-overflow:ellipsis` 방어. 최종 근본 수정은 `39b6d22`(메인 그리드 컬럼 min-width:0 누락) — 비슷한 버그 재발 시 그 커밋 diff 먼저 참고.

---

## AI 파이프라인 & 비용 관리

7/7~7/8경 Claude 비용이 시간당 $2까지 치솟은 사고가 있었음(원인: `company.html` "AI 종합분석"이 캐싱 없이 방문마다 호출 + 히트맵이 761개 종목으로 확장되며 크롤링 트래픽 급증). 지금은 다층 방어:

1. **`feature_flags` 테이블** (`db/feature-flags.sql`, `lib/feature-flags.js`) — Claude를 부르는 파이프라인 7종(`analyze`/`ai_market_summary`/`catalysts`/`daily_report`/`extract_investments`/`weekly_schedule`/`company_summary`)을 **배포 없이** 개별·일괄 on/off. 어드민 패널에서 즉시 차단 가능. 행이 없으면(마이그레이션 전) fail-open(활성화) — 이 레포의 다른 신선도가드와 동일 원칙.
2. **`company_ai_summary` 테이블** — 종목당 1일 1회 캐시. 게다가 **`db/ai-daily-budget.sql`**: 하루 전체 Claude 호출 상한(150회) 이중 안전장치, `increment_ai_budget` RPC.
3. **`api/analyze.js`가 Anthropic Message Batches API로 전환됨** (`a8bdc98`) — 입력 토큰 50% 할인 + 프롬프트 캐싱(`bedbbeb`). 흐름: `mode=batch-submit`(제출, `analyze-backlog.yml`이 최대 30건씩) → `mode=batch-poll`(10분마다 폴링) → `finalizeDiscoverStage`(후보기업 발굴) → `finalizeDecideStage`(매매정보 확정). 기존 "1회 호출=1건 즉시분석" 방식이 아니므로 **동기적으로 결과를 기다리는 코드를 짜면 안 됨** — 배치는 비동기.
4. `ai-market-summary`/`catalysts`는 신선도 가드 있음(전자는 KST 00/08/16시 고정 스케줄로 전환, `0b0c8d5`).

**비용 이상 감지 시 최우선 조치**: 어드민 패널 → AI on/off 스위치로 의심 파이프라인 즉시 차단 → 그 다음 코드 조사.

---

## ⚠️ GitHub Actions 스케줄이 자주 드롭됨 — catch-up 패턴이 표준

실측: 전용 `daily-reports.yml` 크론이 며칠씩 통째로 안 돈 사례 있음. 그래서 **매시간 도는 `analyze-backlog.yml`이 여러 작업의 "혹시 안 됐으면 채워넣기" 역할**을 겸함(데일리 리포트, AI 시장종합, catalyst 갱신 등). 새로 시간 민감한 자동화를 추가할 때 전용 크론 하나만 믿지 말고, 이미 안정적으로 도는 `analyze-backlog.yml`(매시 15분 + 10분마다 배치폴링)에 멱등 catch-up 스텝으로 얹는 걸 우선 고려.

---

## KR 데이터 소스 관련 주의사항 (직접 겪은 버그들)

- **Yahoo `v8/finance/chart`는 인증 없이 안정적**(가격/거래량/52주범위/상장일 등, 이 코드베이스 전역에서 신뢰). **`v10/finance/quoteSummary`(애널리스트 목표주가 등)는 crumb 인증이 필요하고 실제 테스트 중 몇 초 만에 401로 막힘 — 신뢰 불가, 쓰지 말 것.**
- **Naver `m.stock.naver.com/api/stock/{code}/integration`의 필드 단위가 통일돼 있지 않음**:
  - `totalInfos.marketValue`는 `"1,730조 4,985억"` 같은 **텍스트**(파싱 함수: `krMoney()`).
  - `industryCompareInfo[].marketValue`는 조/억 접미사 없는 **순수 숫자, 단위는 백만원(×1e6)**. 억원(×1e8)으로 잘못 곱하면 시총이 1만 배 부풀려짐 — 실제로 한 번 이 실수를 했었음(`c5ca61e`에서 수정). 새 필드 쓸 때 단위를 반드시 실측 검증할 것.
  - `consensusInfo.recommMean`(투자의견 1~5점): **척도 방향(1이 매수인지 5가 매수인지) 확정 불가** — 검색해도 출처마다 자기모순. 화면에 방향성 라벨로 쓰지 말 것, 목표주가 대비 상승여력%(부호 자명)만 노출.
- NewsAPI는 **한국어 인덱스 없음** — 한국어 텍스트 쿼리는 사실상 0건. KR 종목/이슈는 영어 고유명사(Samsung, SK Hynix, HLB 등)로 쿼리하거나 국내 RSS(한국경제/이데일리/매일경제/바이오 전문지 KoreaBiomed·HiT뉴스·바이오타임즈 + 구글뉴스 한국판 검색 RSS)로 커버. 해외 매체는 Bloomberg/BBC/MarketWatch/Investing/CNBC/SeekingAlpha + Reuters(공식 feeds.reuters.com 폐쇄돼 Google News의 `source:Reuters` 검색 RSS로 대체)/FinancialJuice(실시간 매크로 헤드라인) — `api/fetch.js`의 `RSS_FEEDS` 배열.
- **국장 종목이 뉴스와 안 엮이는 문제**: discover 프롬프트(`api/analyze.js` `ANALYZE_STATIC_PROMPT`)가 US 반도체/빅테크/EV 뉴스를 봐도 한국 공급망 상장사(삼성전자·SK하이닉스·LG에너지솔루션 등)를 자동으로는 잘 안 엮음 — "한국 공급망 매핑" 블록으로 명시적 예시를 프롬프트에 박아둠(2026-07). 동시에 "금값→저금리→반도체" 식 억지 매크로 연결 금지 조항도 있음. 국장 파급효과 카드가 오래 안 채워지면 이 프롬프트 블록부터 의심할 것.
- **국민연금 종목별 일별 매매(연기금등)는 무료로 못 구함** — 조사 결론(2026-07): KRX 공식 Open API(`openapi.krx.co.kr`)엔 투자자별 매매 데이터 자체가 없음(지수/시세류만). `data.krx.co.kr` 웹 화면("투자자별 거래실적(개별종목)", 상세보기 체크 시 연기금 등 세부분류 컬럼 존재 확인됨)은 세션+bld 화이트리스트 스크래핑 방지가 걸려있어 서버에서 자동 수집 실패(`LOGOUT` 에러 반환). 설사 뚫어도 KRX의 "연기금등" 카테고리는 국민연금+사학연금+공무원연금 등 공적연금 합산이라 국민연금 단독 수치가 아님(참고 사이트 fastjusik.com도 동일 한계를 스스로 명시). 국민연금 단독 정확한 수치는 DART 대량보유공시(5%+ 지분, 월 단위)뿐 — 일별 데이터는 없음.
- KR 종목명이 티커 코드 그대로 등록되는 버그가 반복 발생 — 어드민 액션 `fix-kr-broken-names`로 일괄 정리 가능(`adf52c2`).

---

## DB 스키마 메모

`db/*.sql`이 마이그레이션 소스지만 **번호가 없고 실행 이력 추적이 안 됨** — 새 기능 추가 시 `db/`에 새 `.sql` 만들고 사용자에게 Supabase SQL Editor에서 직접 실행 요청하는 게 이 프로젝트의 표준 흐름(자동 마이그레이션 없음). 모든 핸들러는 **컬럼/테이블이 아직 없어도 fail-open으로 죽지 않게** 방어적으로 짜여 있음(select 에러 메시지에 컬럼명 포함되면 구버전 select로 재시도하는 패턴 다수) — 새 컬럼 추가 시 이 패턴을 따를 것.

주요 테이블: `issues`/`analyses`/`analysis_companies`(핵심 분석 파이프라인), `companies`(종목 마스터 + 캐시된 fundamentals/ai_summary/price), `daily_reports`, `catalysts`(예정 이벤트 레지스트리), `weekly_schedule`, `feature_flags`, `company_ai_summary`, `page_views`/`company_views`(방문 통계), `site_announcement`/`announcement_log`(긴급 배너).

RLS 패턴: 전부 `anon`은 SELECT만 허용하는 공개 정책 + `service_role`(어드민 API)만 쓰기 가능. 새 테이블도 이 패턴 따를 것.

### ⚠️ RLS "무조건 허용" 정책의 함정 — `chat_messages` hidden 유출 (2026-08-02 보안 점검, 수정 완료)

`chat_messages`의 SELECT 정책이 과거 `USING (true)`였음 — 서버 API/클라이언트는 `hidden=true`(신고 3회 누적) 메시지 본문을 화면에서만 가렸을 뿐, RLS 정책 자체는 모든 행을 허용해서:
1. anon key로 테이블 직접 조회하면 숨김 처리된 메시지 원문이 그대로 보임.
2. 메시지가 숨겨지는 순간(`hidden: false→true`) Realtime UPDATE 이벤트가 anon 구독자 전원에게 원문이 든 전체 행을 브로드캐스트 — `chat.js`의 `replaceMsg()`는 그리는 시점에만 지울 뿐, 이미 네트워크로 나간 뒤였음.

`db/chat-hidden-rls-fix.sql`로 `USING (NOT hidden)`으로 좁힘(`db/chat.sql`도 동일하게 갱신). **일반적 교훈**: "서버/클라이언트가 화면에서 가린다"는 DB 정책이 허용된 것과 별개 — RLS `SELECT` 정책은 REST 직접조회와 Realtime 브로드캐스트 양쪽 다 통과시키는 게이트이므로, 민감 컬럼/행이 있는 테이블은 애플리케이션 레벨 필터링에 의존하지 말고 정책 자체에 조건을 넣을 것. 같은 이유로 다른 테이블에 "관리자만 봐야 하는 상태"를 담은 boolean(예: 차단/블라인드 플래그)이 생기면 이 패턴을 먼저 의심할 것.

이 점검에서 함께 발견했으나 사용자가 아직 수정 지시하지 않은 낮은 우선순위 항목(미조치, 필요시 참고): PostgREST `.or(ilike...)` 필터 조립 시 사용자 입력 미검증(4곳 어드민 게이트+3곳 클라이언트), 응답 헤더에 CSP/X-Frame-Options 없음, `chat.js`의 `esc()`가 홑따옴표(`'`) 미이스케이프, `lib/auth.js`의 `ADMIN_SECRET` 비교가 timing-safe 아님(`===`).

---

## 텔레그램 봇 알림 (2026-08-02)

리포트(AI 시장 종합/국장·미장 데일리) 완성 시 발송되는 알림에 **구독 경로가 두 갈래**:
1. `account.html` "알림 설정" — 로그인 계정이 Chat ID를 직접 붙여넣음(`@userinfobot`으로 확인) → `user_settings.telegram_chat_id`.
2. **공개 봇 구독(신규)** — 사이트 가입 없이 봇에 `/start`만 보내면 됨 → `telegram_subscribers`(`db/telegram-subscribers.sql`). 웹훅은 `api/notify.js`의 `?action=webhook`(리라이트: `/api/telegram-webhook`), `X-Telegram-Bot-Api-Secret-Token` 헤더를 `TELEGRAM_WEBHOOK_SECRET`과 비교해 검증. `/stop`으로 해제.

발송 로직(`api/admin.js` `notifyReportSubscribers`)은 두 경로의 chat_id를 합쳐서(Set으로 중복 제거) 보낸다 — 새 알림 대상을 추가할 땐 이 함수 하나만 건드리면 됨.

**필요 환경변수**: `TELEGRAM_BOT_TOKEN`(BotFather 발급), `TELEGRAM_CHAT_ID`(어드민 전용 단일 알림, `api/notify.js` 기본 POST), `TELEGRAM_WEBHOOK_SECRET`(웹훅 검증용 임의 문자열, 사용자가 직접 생성). **셋 다 절대 채팅에 붙여넣지 말 것** — Vercel 환경변수로만 설정. `setWebhook` 등록도 사용자 본인 로컬 터미널에서 토큰을 직접 넣어 실행하도록 안내(다른 시크릿 처리와 동일 원칙).

Vercel Hobby 12개 함수 한도 때문에 새 파일을 만들지 않고 기존 `api/notify.js`에 `action=webhook` 쿼리 라우팅으로 추가함 — 새 텔레그램 관련 기능도 이 파일에 액션만 추가할 것.

---

## 어드민 패널 (`/admin/`)

`admin/index.html`은 셸만 정적 HTML이고 실제 로직은 `lib/admin-dashboard-logic.txt`를 `/api/admin-logic`(→`api/admin-static.js`)에서 fetch해 실행 — 코드 수정 시 이 `.txt` 파일을 고칠 것(admin/index.html 자체가 아니라). `ADMIN_SECRET`으로 인증(헤더 `x-admin-pw` 또는 Bearer), 화이트리스트 이메일 로그인도 병행.

주요 기능: AI on/off 스위치, 종목 조회수 통계, 방문자 애널리틱스(유입경로/체류시간/이동경로), 회원관리(밴/탈퇴), 긴급 안내 배너 수동 제어, 데일리 리포트 소급 생성, KR 종목명 일괄 정리.
