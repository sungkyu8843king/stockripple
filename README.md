# StockRipple — 파급효과 주식 전망

뉴스 이슈의 파급효과를 AI로 분석해 수혜 기업과 상승 가능성을 예측하는 플랫폼.

## 배포 준비

### 1. Supabase 설정
1. [supabase.com](https://supabase.com)에서 새 프로젝트 생성
2. SQL Editor에서 `supabase-schema.sql` 실행
3. Settings → API에서 URL과 키 복사

### 2. API 키 준비
| 서비스 | 키 이름 | 발급처 |
|--------|---------|--------|
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Supabase → Settings → API |
| Claude AI | `ANTHROPIC_API_KEY` | console.anthropic.com |
| NewsAPI | `NEWS_API_KEY` | newsapi.org (무료 100콜/일) |
| 직접 생성 | `ADMIN_SECRET` | 랜덤 문자열 (openssl rand -hex 32) |
| 직접 생성 | `CRON_SECRET` | 랜덤 문자열 |

### 3. 프론트엔드 Supabase 연결
`index.html`, `analysis.html`, `admin/index.html`에서 아래 두 줄 수정:
```js
const SUPABASE_URL = 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-key';
```

### 4. Vercel 배포
```bash
npm install -g vercel
vercel --prod
```
Vercel 대시보드 → Settings → Environment Variables에서 모든 키 추가.

## 사용 방법

1. `/admin/` 접속 → 설정 탭에서 `ADMIN_SECRET` 입력 (localStorage 저장)
2. "뉴스 수집 실행" → 뉴스 저장
3. "AI 분석" → Claude가 파급효과 분석
4. `/` 메인 피드에서 결과 확인

## 자동화 (Vercel Cron)
매일 오전 10시(KST, UTC+1)에 자동 수집+분석.  
`vercel.json`의 `schedule`로 조정 가능.

## 구조
```
index.html          — 메인 피드
analysis.html       — 분석 상세
admin/index.html    — 관리자
api/fetch-news.js   — 뉴스 수집 (serverless)
api/analyze.js      — Claude AI 분석 (serverless)
api/stock-price.js  — 주가 조회 Yahoo Finance (serverless)
api/cron-daily.js   — 일일 크론 (serverless)
supabase-schema.sql — DB 스키마
```
