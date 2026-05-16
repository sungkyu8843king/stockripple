import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 국내외 금융 RSS 피드 목록
const RSS_FEEDS = [
  { url: 'https://www.hankyung.com/feed/stock',          name: '한국경제',     sector: '증권' },
  { url: 'https://www.hankyung.com/feed/finance',        name: '한국경제',     sector: '금융' },
  { url: 'https://www.edaily.co.kr/rss/rss.asp?sitetype=stock', name: '이데일리', sector: '증권' },
  { url: 'https://rss.etnews.com/Section901.xml',        name: 'ETNews',      sector: 'IT·반도체' },
  { url: 'https://feeds.feedburner.com/businessinsider', name: 'Business Insider', sector: '글로벌' },
  { url: 'https://feeds.reuters.com/reuters/businessNews', name: 'Reuters',   sector: '글로벌' },
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

        // 중복 체크
        const { data: exists } = await supabase
          .from('issues')
          .select('id')
          .eq('source_url', item.link)
          .single();
        if (exists) continue;

        results.fetched++;

        const { error } = await supabase.from('issues').insert({
          title: item.title.slice(0, 300),
          summary: item.description?.replace(/<[^>]+>/g, '').slice(0, 500) || null,
          source_url: item.link,
          source_name: feed.name,
          published_at: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
          sectors: [feed.sector],
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
