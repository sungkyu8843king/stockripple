import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { issue_id, limit = 3 } = req.body || {};

  let query = supabase.from('issues').select('*').eq('is_analyzed', false);
  if (issue_id) query = supabase.from('issues').select('*').eq('id', issue_id);
  else query = query.order('published_at', { ascending: false }).limit(limit);

  const { data: issues, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  if (!issues?.length) return res.status(200).json({ message: 'No issues to analyze', count: 0 });

  const results = { analyzed: 0, errors: [] };

  for (const issue of issues) {
    try {
      const analysis = await analyzeIssue(issue);

      const { data: savedAnalysis, error: analysisErr } = await supabase
        .from('analyses')
        .insert({
          issue_id: issue.id,
          direct_sectors: analysis.directSectors || [],
          ripple_effects: analysis.rippleEffects || [],
          ai_summary: analysis.summary,
          confidence_score: analysis.confidence_score || 50,
        })
        .select()
        .single();

      if (analysisErr) throw new Error(analysisErr.message);

      for (const ripple of analysis.rippleEffects || []) {
        for (const co of ripple.companies || []) {
          const companyId = await upsertCompany(co);
          await supabase.from('analysis_companies').insert({
            analysis_id: savedAnalysis.id,
            company_id: companyId,
            ripple_sector: ripple.sector,
            rationale: co.rationale,
            upside_pct: co.upside_pct,
            confidence: co.confidence,
          });
        }
      }

      await supabase.from('issues').update({ is_analyzed: true }).eq('id', issue.id);
      results.analyzed++;

      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      results.errors.push(`Issue "${issue.title?.slice(0, 50)}": ${err.message}`);
    }
  }

  return res.status(200).json(results);
}

async function analyzeIssue(issue) {
  const prompt = `당신은 글로벌 주식시장 분석 전문가입니다. 다음 뉴스/이슈를 분석하여 파급효과와 수혜 기업을 찾아주세요.

이슈 제목: ${issue.title}
요약: ${issue.summary || '없음'}
관련 섹터: ${issue.sectors?.join(', ') || '미분류'}

다음 형식으로 JSON만 반환하세요 (다른 텍스트 없이):
{
  "summary": "이슈의 핵심 내용과 시장 영향 2-3문장",
  "directSectors": ["직접 영향받는 섹터1", "섹터2"],
  "rippleEffects": [
    {
      "sector": "파급 섹터명 (한국어)",
      "impact": "positive 또는 negative 또는 neutral",
      "reason": "왜 이 섹터에 파급효과가 생기는지 설명",
      "companies": [
        {
          "ticker": "AAPL 또는 005930.KS 형식",
          "name_ko": "기업명 한국어",
          "name_en": "Company Name English",
          "market": "US 또는 KR",
          "rationale": "이 기업이 수혜를 받는 구체적 이유",
          "upside_pct": 15,
          "confidence": 70
        }
      ]
    }
  ],
  "confidence_score": 75
}

규칙:
- rippleEffects는 2-4개, 각 섹터당 기업은 2-3개
- 한국 기업(KR)과 미국 기업(US)을 균형있게 포함
- upside_pct는 현실적으로 5-50% 범위
- confidence는 0-100 (데이터 확실성 기반)
- 반드시 실존하는 상장 기업의 실제 티커 사용`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('JSON not found in response');

  return JSON.parse(jsonMatch[0]);
}

async function upsertCompany(co) {
  const { data: existing } = await supabase
    .from('companies')
    .select('id')
    .eq('ticker', co.ticker)
    .single();

  if (existing) return existing.id;

  const { data: newCo } = await supabase
    .from('companies')
    .insert({
      ticker: co.ticker,
      name_ko: co.name_ko,
      name_en: co.name_en,
      market: co.market,
    })
    .select()
    .single();

  return newCo.id;
}
