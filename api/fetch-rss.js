import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 한국 뉴스 관련성 키워드 (이 중 하나라도 없으면 저장 안 함)
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

// 국내외 금융 RSS 피드 목록
const RSS_FEEDS = [
  // 국내
  { url: 'https://www.hankyung.com/feed/stock',                name: '한국경제',     sectors: ['증권', '주식'],  isKorean: true },
  { url: 'https://www.hankyung.com/feed/finance',              name: '한국경제',     sectors: ['금융', '경제'],  isKorean: true },
  { url: 'https://www.edaily.co.kr/rss/rss.asp?sitetype=stock',name: '이데일리',     sectors: ['증권', '주식'],  isKorean: true },
  { url: 'https://rss.etnews.com/Section901.xml',              name: 'ETNews',       sectors: ['IT', '반도체'],  isKorean: true },
  // 해외
  { url: 'https://feeds.reuters.com/reuters/businessNews',     name: 'Reuters',      sectors: ['글로벌', '경제'] },
  { url: 'https://feeds.reuters.com/reuters/technologyNews',   name: 'Reuters Tech', sectors: ['IT', '기술'] },
  { url: 'https://feeds.marketwatch.com/marketwatch/topstories/', name: 'MarketWatch', sectors: ['주식', '글로벌'] },
  { url: 'https://www.investing.com/rss/news_1.rss',           name: 'Investing.com',sectors: ['글로벌', '경제'] },
  { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', name: 'CNBC Markets', sectors: ['글로벌', '주식'] },
  // 트럼프 Truth Social (정치·외교 이슈)
  { url: 'https://truthsocial.com/@realDonaldTrump.rss',       name: 'Truth Social', sectors: ['정치·외교', '트럼프'], isTrump: true },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = { fetched: 0, saved: 0, errors: [] };

  for (const feed of RSS_FEEDS) {
    try {
      const items = await fetchRSS(feed.url);
      for (const item of items) {
        if (!item.title || !item.link) continue;

        // 트럼프 글: 24시간 이내만 저장
        if (feed.isTrump && item.pubDate) {
          const age = Date.now() - new Date(item.pubDate).getTime();
          if (age > 24 * 3600 * 1000) continue;
        }

        // 한국 뉴스: 주식시장 관련 키워드 없으면 스킵
        if (feed.isKorean) {
          const titleText = item.title || '';
          const hasKeyword = KO_STOCK_KEYWORDS.some(kw => titleText.includes(kw));
          if (!hasKeyword) continue;
        }

        // 중복 체크
        const { data: exists } = await supabase
          .from('issues').select('id').eq('source_url', item.link).maybeSingle();
        if (exists) continue;

        results.fetched++;

        const cleanText = (s) => s ? s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
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
    } catch (err) {
      results.errors.push(`${feed.name}: ${err.message}`);
    }
  }

  return res.status(200).json(results);
}

async function fetchRSS(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockRipple/1.0; +https://stockripple.vercel.app)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return parseRSS(xml);
}

function parseRSS(xml) {
  const items = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/gi);
  for (const match of itemMatches) {
    const block = match[1];
    items.push({
      title:       extractTag(block, 'title'),
      link:        extractTag(block, 'link') || extractTag(block, 'guid'),
      description: extractTag(block, 'description'),
      pubDate:     extractTag(block, 'pubDate'),
    });
    if (items.length >= 20) break; // 피드당 최대 20건
  }
  return items;
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<\\!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}
