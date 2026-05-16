import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const NEWS_API_KEY = process.env.NEWS_API_KEY;

const QUERIES = [
  // 시장 지배 테마
  { q: 'Trump tariff trade policy executive order sanctions', sectors: ['정치·외교', '무역', '관세'] },
  { q: 'Federal Reserve interest rate inflation monetary policy', sectors: ['경제지표', '금리', '연준'] },
  { q: 'earnings revenue profit quarterly results beat miss', sectors: ['실적발표', '주식'] },
  // 섹터별
  { q: 'semiconductor AI chip NVDA AMD Intel TSMC', sectors: ['반도체', 'AI'] },
  { q: 'electric vehicle battery EV Tesla BYD', sectors: ['전기차', '배터리'] },
  { q: 'pharmaceutical biotech drug FDA approval', sectors: ['바이오', '제약'] },
  { q: 'cloud computing software Microsoft Google Amazon', sectors: ['클라우드', 'IT'] },
  { q: 'fintech banking cryptocurrency Bitcoin Ethereum', sectors: ['핀테크', '금융'] },
  { q: 'renewable energy solar wind climate', sectors: ['에너지', '친환경'] },
  { q: 'supply chain logistics shipping freight', sectors: ['물류', '공급망'] },
  // 한국어
  { q: '트럼프 관세 무역 외교 제재', sectors: ['정치·외교', '무역', '관세'] },
  { q: '금리 인플레이션 CPI 연준 한국은행', sectors: ['경제지표', '금리'] },
  { q: '반도체 AI 인공지능 삼성 SK하이닉스', sectors: ['반도체', 'AI'] },
  { q: '실적 어닝 매출 영업이익 주가', sectors: ['실적발표', '주식'] },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!NEWS_API_KEY) {
    return res.status(500).json({ error: 'NEWS_API_KEY not configured' });
  }

  const results = { fetched: 0, saved: 0, errors: [] };

  for (const query of QUERIES.slice(0, 5)) {
    try {
      const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query.q)}&language=en&sortBy=publishedAt&pageSize=5&apiKey=${NEWS_API_KEY}`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.status !== 'ok') {
        results.errors.push(`Query "${query.q}": ${data.message}`);
        continue;
      }

      for (const article of data.articles || []) {
        results.fetched++;

        const existing = await supabase
          .from('issues')
          .select('id')
          .eq('source_url', article.url)
          .single();

        if (existing.data) continue;

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
