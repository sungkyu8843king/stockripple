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

## 페이지 구조 (2026-07 전면 재구조화)

`index.html`은 원래 3800+줄짜리 단일 페이지였다가, 정보 밀도 완화를 위해 전용 페이지로 분리됨. 홈은 이제 각 섹션의 **미리보기 카드**만 보여주고 "더보기"로 전용 페이지 유도.

| 페이지 | 역할 |
|--------|------|
| `index.html` | 홈 — 피드 + 각 섹션 미리보기 |
| `heatmap.html` | 히트맵 전용 (섹터 드릴다운 뷰 포함) |
| `kr-market.html` | 국장·미장 현황 (지수카드/인기검색/수급차트) |
| `picks.html` | 매수 후보 전용 |
| `sectors.html` | 섹터 지도 |
| `analysis.html` | 이슈 상세 분석 |
| `company.html` | 종목 상세 — Toss 공식 API 기반 통합가+정규장/시간외 변동 분해, 호가창, 일별시세표, lightweight-charts 캔들+매물대 차트, AI 종합분석/펀더멘털/DART/투자자동향/옵션체인/애널리스트 컨센서스. 예측 수치(상승여력%·신뢰도%·STRONG BUY 등)는 없음 — 적중률이 낮아(20%대) 신뢰 근거로 못 씀, 대신 "파급효과" 정성적 뉴스 연결만 제공 |
| `market-detail.html` | 시장지표 상세(지수/원자재/환율/암호화폐) — Toss/Yahoo 소스, lightweight-charts 자체 차트(1개월/6개월/1년) + 52주 레인지. `?sym=` 쿼리로 지표 선택(`MKT` 객체가 지원 목록) |
| `etf.html` | ETF 탐색 — 국내 상장 ETF 전체(~1,150종) 목록(카테고리 탭·수익률/거래대금 정렬·검색) + `?code=`로 상세(총보수·추적오차·괴리율·순자산·기간수익률 D1~Y10·자산/국가/섹터 배분·상위10 구성종목·자금유입). 전부 네이버 무키 소스, 저장 없이 실시간. 상세는 lightweight-charts 없이 순수 데이터. ETF↔종목 링크: 상세의 국내 구성종목은 company.html로, company.html의 "이 종목을 담은 ETF" 역조회는 etf.html로 상호 연결 |
| `talks.html` | 말말말 — 이슈 주제별(예: 미·이란 전쟁, 코스피 레버리지) 타임라인 페이지. `TOPICS` 배열에 주제 추가하면 끝, 연관 지수·종목 시세 카드 + issues DB 키워드 필터 뉴스 타임라인 |
| `terminal.html` | 페이퍼 트레이딩 |
| `portfolio.html`, `account.html` | 관심종목, 계정 |
| `admin/index.html` | 어드민 (셸만 정적, 로직은 `/api/admin-logic`에서 fetch) |

**공용 로직은 `app.js`(4300+줄, `/app.js`)** — `index/heatmap/kr-market/picks/sectors` 5개 페이지가 공유(auth·관심종목·인사이트카드·지수·캘린더·히트맵 렌더링·국장현황 등 거의 전부). **이 파일을 고치면 5개 페이지에 동시 영향** — 한 페이지만 고치려는 의도면 그 페이지의 인라인 `<script>`를 찾을 것. `announcement-bar.js`(긴급 안내 배너), `sr-pulse.js`는 대부분 페이지가 개별 로드.

**로그인/회원가입 JS는 4곳에 독립적으로 중복돼 있음**: `app.js`(5개 공유 페이지용) / `company.html` / `analysis.html` / `portfolio.html` — 전부 각자 `initAuth`/`renderUserMenu`/`toggleUserDropdown`/`doSignOut`/`openAuthModal`/`switchAuthMode`/`submitAuth`/`signInWithGoogle`/`validateSignupPassword` 함수명으로 통일돼 있으나 파일마다 별개 정의. **인증 관련 규칙(비밀번호 정책 등)을 바꾸면 4곳 다 고쳐야 함** — 하나만 고치면 나머지는 조용히 구식 규칙으로 남는다. `company.html`이 가장 완전한 참조 구현(검색창+피커 모달+동의 체크박스+유저메뉴 드롭다운까지 전부 있음) — 새 standalone 페이지에 인증을 추가할 땐 `company.html` 블록을 통째로 이식할 것. 현재 회원가입 비밀번호 규칙: 영문+숫자+특수문자 조합 8자 이상(`validateSignupPassword`).

## ⚠️ TradingView 무료 임베드 — 지수 심볼 절반이 아예 안 뜸

`market-detail.html`이 원래 TradingView `widgetembed` iframe을 썼는데, 실측(2026-07)해보니 12개 시장지표 중 **NASDAQ:IXIC(나스닥종합)/KRX:KOSPI/KRX:KOSDAQ/TVC:VIX/NASDAQ:SOX/CME_MINI:NQ1!(나스닥100선물) 6개가 "TradingView 에서만 제공되는 심볼입니다" 에러**로 아예 안 뜸(TVC:/CBOE: 등 다른 프리픽스로 바꿔도 동일 — 해당 지수 자체가 무료 임베드 티어에서 제외된 것). FOREXCOM:SPXUSD/FOREXCOM:DJI/FX_IDC:USDKRW/BITSTAMP:BTCUSD/TVC:GOLD/TVC:USOIL는 정상 작동. → **해결책은 TradingView 심볼을 계속 바꿔가며 찾는 게 아니라 자체 차트로 대체**: `api/indices.js`의 `?chart=심볼id&range=` 브랜치가 Yahoo 일봉을 반환하고, `market-detail.html`이 lightweight-charts(area series)로 직접 그림 — 12개 전부 이 방식이라 TradingView 가용성 문제 자체가 없음. 다른 화면에 차트를 새로 넣을 때도 TradingView 무료 임베드부터 시도하지 말고 이 패턴(Yahoo 히스토리 + lightweight-charts)을 먼저 고려할 것.

---

## ETF 서브시스템 (2026-07 신규)

`etf.html`(목록+상세) + company.html "이 종목을 담은 ETF"(역조회) + market-data.js `source=etf` 라우팅(`/api/etf` rewrite) + admin.js `crawl-etf-holdings` + `etf_holdings` 테이블.

**데이터 소스 — 전부 네이버, 키 불필요:**
- **전체 목록**: `finance.naver.com/api/sise/etfItemList.nhn` — **응답이 EUC-KR 인코딩**이라 `arrayBuffer` → `new TextDecoder('euc-kr')`로 디코드해야 종목명이 안 깨짐(UTF-8로 그냥 읽으면 깨짐, 실측). 필드: nowVal, changeRate, nav, threeMonthEarnRate, quant(거래량), amonut(거래대금, **백만원 단위**), etfTabCode(1 국내지수/2 업종·테마/3 파생/4 해외주식/5 원자재/6 채권·금리/7 기타).
- **개별 상세**: `m.stock.naver.com/api/stock/{code}/etfAnalysis` — UTF-8. 총보수·추적오차·괴리율·기간수익률(returnPerformanceList: D1/W1/M1/M3/M6/YTD/Y1/Y3/Y5/Y10)·자산/국가/섹터 배분·상위10 구성종목(etfTop10MajorConstituentAssets)·순유입.
  - **단위 함정(네이버 특유)**: `totalFee`/`chaseErrorRate`/`deviationRate`는 이미 **% 단위 숫자**(예 0.15=0.15%; 미국지수 ETF는 수수료 전쟁으로 0.0068% 같은 초저보수가 실제값). `marketValue`/`totalNav`는 숫자가 아니라 **이미 포맷된 문자열**("11조 5,043억") — `parseFloat` 하면 "115043"로 뭉개짐, 문자열 그대로 표시할 것. `cumulativeNetInflowList`는 **배열이 아니라 객체**(기간별 "136억" 문자열 필드).
  - 구성종목: 국내 종목만 `itemCode`(6자리)·`etfWeight`가 채워짐. 해외주식(4)·원자재(5) ETF는 비어있음 → 역인덱스 크롤 시 이 카테고리는 스킵.

**역조회(`etf_holdings` 테이블)**: "이 종목을 담은 ETF"는 각 ETF의 상위10 구성종목을 미리 크롤해 적재해둔 인덱스에서 조회(라이브 역조회는 불가능 — 종목→ETF API가 없음). `db/etf-holdings.sql`로 테이블 생성 후 `POST /api/admin?action=crawl-etf-holdings`(멱등 upsert, 국내보유 ETF만 ~750개, concurrency 12로 1회 완료). 매일 cron-daily가 fire-and-forget로 갱신. **상위10만 담으므로 "주요 보유" 신호**(소수 비중은 미포함) — KRX PDF(전체 구성내역)는 스크래핑 차단이라 안 씀.

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

---

## 어드민 패널 (`/admin/`)

`admin/index.html`은 셸만 정적 HTML이고 실제 로직은 `lib/admin-dashboard-logic.txt`를 `/api/admin-logic`(→`api/admin-static.js`)에서 fetch해 실행 — 코드 수정 시 이 `.txt` 파일을 고칠 것(admin/index.html 자체가 아니라). `ADMIN_SECRET`으로 인증(헤더 `x-admin-pw` 또는 Bearer), 화이트리스트 이메일 로그인도 병행.

주요 기능: AI on/off 스위치, 종목 조회수 통계, 방문자 애널리틱스(유입경로/체류시간/이동경로), 회원관리(밴/탈퇴), 긴급 안내 배너 수동 제어, 데일리 리포트 소급 생성, KR 종목명 일괄 정리.
