/**
 * fetch.js — fetch-news + fetch-rss 통합
 * POST /api/fetch?type=news → NewsAPI 수집
 * POST /api/fetch?type=rss  → RSS 피드 수집
 */
import { createClient } from '@supabase/supabase-js';
import { verifyAdmin } from '../lib/auth.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const _auth = await verifyAdmin(req.headers.authorization);
  if (!_auth.ok) return res.status(401).json({ error: _auth.error });

  const type = (req.query?.type || 'news').toString();
  if (type === 'rss') return handleRss(res);
  return handleNews(res);
}

// ─── NewsAPI 수집 ────────────────────────────────────────
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const QUERIES = [
  { q: 'Trump tariff trade policy executive order sanctions',     sectors: ['정치·외교', '무역', '관세'] },
  { q: 'Federal Reserve interest rate inflation monetary policy', sectors: ['경제지표', '금리', '연준'] },
  { q: 'earnings revenue profit quarterly results beat miss',     sectors: ['실적발표', '주식'] },
  { q: 'semiconductor AI chip NVDA AMD Intel TSMC',               sectors: ['반도체', 'AI'] },
  { q: 'electric vehicle battery EV Tesla BYD',                   sectors: ['전기차', '배터리'] },
  { q: 'pharmaceutical biotech drug FDA approval',                sectors: ['바이오', '제약'] },
  { q: 'cloud computing software Microsoft Google Amazon',        sectors: ['클라우드', 'IT'] },
  { q: 'fintech banking cryptocurrency Bitcoin Ethereum',         sectors: ['핀테크', '금융'] },
  { q: 'renewable energy solar wind climate',                     sectors: ['에너지', '친환경'] },
  { q: 'supply chain logistics shipping freight',                 sectors: ['물류', '공급망'] },
  { q: '트럼프 관세 무역 외교 제재',                              sectors: ['정치·외교', '무역', '관세'] },
  { q: '금리 인플레이션 CPI 연준 한국은행',                        sectors: ['경제지표', '금리'] },
  { q: '반도체 AI 인공지능 삼성 SK하이닉스',                       sectors: ['반도체', 'AI'] },
  { q: '실적 어닝 매출 영업이익 주가',                             sectors: ['실적발표', '주식'] },
];

async function handleNews(res) {
  if (!NEWS_API_KEY) return res.status(500).json({ error: 'NEWS_API_KEY not configured' });

  const results = { fetched: 0, saved: 0, errors: [] };
  // NewsAPI 무료 쿼터(100콜/일) 때문에 회당 5쿼리만 실행하되, 고정 slice는 뒤쪽 쿼리
  // (바이오·한국어)가 영원히 안 돌므로 실행 시각 기준으로 시작점을 순환시킨다
  const rotStart = (new Date().getUTCHours() * 2 + (new Date().getUTCMinutes() >= 30 ? 1 : 0)) % QUERIES.length;
  const selected = Array.from({ length: 5 }, (_, i) => QUERIES[(rotStart + i) % QUERIES.length]);
  for (const query of selected) {
    try {
      const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query.q)}&language=en&sortBy=publishedAt&pageSize=5&apiKey=${NEWS_API_KEY}`;
      const response = await fetch(url);
      const data = await response.json();
      if (data.status !== 'ok') { results.errors.push(`Query "${query.q}": ${data.message}`); continue; }

      for (const article of data.articles || []) {
        results.fetched++;
        // 주의: .single()/.maybeSingle()은 행이 2개 이상이면 에러를 반환하고, 에러를 "없음"으로
        // 해석하면 중복이 수집마다 1개씩 불어나는 자가증폭이 된다 → limit(1) 배열 체크 사용
        const { data: existing } = await supabase.from('issues').select('id').eq('source_url', article.url).limit(1);
        if (existing?.length) continue;
        const { error } = await supabase.from('issues').insert({
          title: article.title,
          summary: article.description || article.content?.slice(0, 500),
          source_url: article.url,
          source_name: article.source?.name,
          published_at: article.publishedAt,
          sectors: query.sectors,
          tags: query.q.split(' ').slice(0, 3),
          is_analyzed: false,
        });
        if (!error) results.saved++;
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      results.errors.push(`Query "${query.q}": ${err.message}`);
    }
  }
  return res.status(200).json(results);
}

// ─── RSS 수집 ────────────────────────────────────────────
const KO_STOCK_KEYWORDS = [
  '주가', '증시', '주식', '코스피', '코스닥', '나스닥', '다우', 'S&P',
  '상승', '하락', '급등', '급락', '강세', '약세',
  '반도체', '배터리', '전기차', 'AI', '인공지능',
  '금리', '채권', '환율', '인플레', '연준', '한국은행',
  '실적', '매출', '영업이익', '순이익', '어닝',
  '펀드', 'ETF', '투자', '시가총액', '시총',
  '증권', '배당', '공매도', '선물', '옵션',
  '관세', '무역', '수출', '수입', '제재',
  'IPO', '상장', '공모', '유상증자',
  '삼성', 'SK', 'LG', '현대', '포스코', '카카오', '네이버', 'NAVER',
];
const RSS_FEEDS = [
  // 한국 — User-Agent 차단 우회 위해 mobile 헤더 추가
  { url: 'https://www.hankyung.com/feed/stock',                 name: '한국경제',     sectors: ['증권', '주식'],   isKorean: true },
  { url: 'https://www.hankyung.com/feed/finance',               name: '한국경제',     sectors: ['금융', '경제'],   isKorean: true },
  { url: 'https://www.edaily.co.kr/rss/rss.asp?sitetype=stock', name: '이데일리',     sectors: ['증권', '주식'],   isKorean: true },
  { url: 'https://www.mk.co.kr/rss/30000001/',                  name: '매일경제',     sectors: ['증권', '주식'],   isKorean: true },

  // 해외 — Reuters 대체 (feeds.reuters.com 폐쇄)
  // Bloomberg 공개 RSS (politics/industries는 markets와 중복 심하고 연예 기사 섞여 제외)
  { url: 'https://feeds.bloomberg.com/markets/news.rss',         name: 'Bloomberg Markets',    sectors: ['주식', '글로벌'] },
  { url: 'https://feeds.bloomberg.com/economics/news.rss',       name: 'Bloomberg Economics',  sectors: ['경제', '글로벌'] },
  { url: 'https://feeds.bloomberg.com/technology/news.rss',      name: 'Bloomberg Technology', sectors: ['IT', '글로벌'] },
  { url: 'http://feeds.bbci.co.uk/news/business/rss.xml',        name: 'BBC Business', sectors: ['글로벌', '경제'] },
  { url: 'https://feeds.marketwatch.com/marketwatch/topstories/', name: 'MarketWatch', sectors: ['주식', '글로벌'] },
  { url: 'https://www.investing.com/rss/news_25.rss',           name: 'Investing 주식',sectors: ['주식', '글로벌'] },
  { url: 'https://www.investing.com/rss/news_301.rss',          name: 'Investing 경제',sectors: ['경제', '글로벌'] },
  { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', name: 'CNBC Markets', sectors: ['글로벌', '주식'] },
  { url: 'https://www.cnbc.com/id/15839135/device/rss/rss.html', name: 'CNBC Top',    sectors: ['글로벌', '경제'] },
  { url: 'https://seekingalpha.com/feed.xml',                    name: 'SeekingAlpha',sectors: ['주식', '분석'] },
  { url: 'https://truthsocial.com/@realDonaldTrump.rss',         name: 'Truth Social',sectors: ['정치·외교', '트럼프'], isTrump: true },
];

async function handleRss(res) {
  const results = { fetched: 0, saved: 0, errors: [], feedStatus: {} };

  // 모든 피드 병렬 fetch (각 6초 타임아웃 → 전체 ~6초 내에 끝)
  const fetchResults = await Promise.allSettled(
    RSS_FEEDS.map(feed => fetchRSS(feed.url).then(items => ({ feed, items })))
  );

  // 각 피드별 결과 순차 처리 (DB 부하 조절)
  for (let i = 0; i < fetchResults.length; i++) {
    const r = fetchResults[i];
    const feed = RSS_FEEDS[i];

    if (r.status === 'rejected') {
      const err = r.reason;
      const msg = err.message?.includes('fetch failed') ? 'DNS/네트워크 차단'
                : err.message?.includes('HTTP 403') ? 'HTTP 403 봇 차단'
                : err.message?.includes('HTTP 404') ? 'HTTP 404 (URL 변경)'
                : err.message?.includes('aborted') ? '타임아웃 (느린 서버)'
                : err.message || 'unknown';
      results.feedStatus[feed.name] = `❌ ${msg}`;
      results.errors.push(`${feed.name}: ${msg}`);
      continue;
    }

    const { items } = r.value;
    results.feedStatus[feed.name] = `ok (${items.length})`;

    for (const item of items) {
      if (!item.title || !item.link) continue;
      if (feed.isTrump && item.pubDate) {
        const age = Date.now() - new Date(item.pubDate).getTime();
        if (age > 24 * 3600 * 1000) continue;
      }
      if (feed.isKorean) {
        const hasKeyword = KO_STOCK_KEYWORDS.some(kw => item.title.includes(kw));
        if (!hasKeyword) continue;
      }
      // maybeSingle()은 중복이 이미 존재하면 에러 → "없음"으로 오인 → 중복 증폭. limit(1)로 체크
      const { data: exists } = await supabase.from('issues').select('id').eq('source_url', item.link).limit(1);
      if (exists?.length) continue;
      results.fetched++;
      const cleanText = s => s ? s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
      const title = feed.isTrump
        ? `[트럼프] ${cleanText(item.description || item.title)?.slice(0, 120) || item.title.slice(0, 120)}`
        : item.title.slice(0, 300);
      const { error } = await supabase.from('issues').insert({
        title,
        summary: cleanText(item.description)?.slice(0, 800) || null,
        source_url: item.link,
        source_name: feed.name,
        published_at: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
        sectors: feed.sectors || [feed.sector || '글로벌'],
        tags: feed.isTrump ? ['Trump', '트럼프', 'TruthSocial'] : [],
        is_analyzed: false,
      });
      if (!error) results.saved++;
    }
  }
  return res.status(200).json(results);
}

async function fetchRSS(url) {
  // 봇 차단 우회: 실제 Chrome 브라우저처럼 헤더 위장
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
  };
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseRSS(await res.text());
}
function parseRSS(xml) {
  const items = [];
  if (!xml || typeof xml !== 'string') return items;
  // RSS <item> 또는 Atom <entry>
  const itemRe = /<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi;
  const matches = xml.match(itemRe) || [];
  for (const block of matches) {
    const title       = extractTag(block, 'title');
    const link        = extractTag(block, 'link') || extractTag(block, 'guid') || extractTag(block, 'id');
    const description = extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content');
    const pubDate     = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated');
    if (title) items.push({ title, link, description, pubDate });
    if (items.length >= 20) break;
  }
  return items;
}
function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<\\!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}
