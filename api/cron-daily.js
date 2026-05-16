export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.ADMIN_SECRET}`,
  };

  try {
    const newsRes = await fetch(`${base}/api/fetch-news`, { method: 'POST', headers });
    const newsData = await newsRes.json();

    await new Promise(r => setTimeout(r, 2000));

    const analyzeRes = await fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ limit: 5 }),
    });
    const analyzeData = await analyzeRes.json();

    return res.status(200).json({
      success: true,
      news: newsData,
      analysis: analyzeData,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
