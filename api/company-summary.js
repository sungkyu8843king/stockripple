/**
 * company-summary.js
 * GET /api/company-summary?ticker=LRCX
 *
 * 종목별 AI 종합 분석:
 *  - 회사 개요 (어떤 비즈니스, 주요 제품/매출 구성)
 *  - 현재 매수 후보 종합 근거 (최근 분석들 통합)
 *  - 핵심 리스크
 *  - 시장에서의 포지션
 *
 * 24시간 동안 companies.ai_summary 필드에 캐시.
 * 인증 불필요 (공개 정보).
 */
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;  // 24시간

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');

  const ticker = (req.query?.ticker || '').toString().trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  if (!anthropic) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });

  try {
    // 1) 회사 정보 조회 (CDN 캐시가 1시간 — 자주 안 부름)
    const { data: company } = await supabase
      .from('companies')
      .select('id, ticker, name_ko, name_en, market, sector')
      .eq('ticker', ticker)
      .single();

    if (!company) return res.status(404).json({ error: 'company not found' });

    // 2) 최근 분석 5건 가져오기 (rationale + ai_summary)
    const { data: recent } = await supabase
      .from('analysis_companies')
      .select(`
        upside_pct, confidence, rationale, entry_date, ripple_sector,
        analyses(ai_summary, issues(title, published_at))
      `)
      .eq('company_id', company.id)
      .order('entry_date', { ascending: false })
      .limit(8);

    const analyses = (recent || []).map(r => ({
      sector: r.ripple_sector,
      upside: r.upside_pct,
      confidence: r.confidence,
      rationale: (r.rationale || '').split('[TRADE]')[0].trim(),
      issueTitle: r.analyses?.issues?.title || '',
      issueSummary: r.analyses?.ai_summary || '',
      date: r.entry_date,
    }));

    // 3) Claude 호출
    const prompt = `당신은 주식 분석 전문가입니다. 아래 회사에 대해 한국 투자자를 위한 종합 분석 보고서를 작성하세요.

회사 정보:
- 티커: ${ticker}
- 한국명: ${company.name_ko || '없음'}
- 영문명: ${company.name_en || '없음'}
- 시장: ${company.market === 'KR' ? '한국' : '미국'}

최근 AI 분석들 (${analyses.length}건):
${analyses.map((a, i) => `
${i+1}. [${a.date?.slice(0,10)}] ${a.issueTitle}
   - 섹터: ${a.sector || '미분류'}, 예상 상승: ${a.upside ?? '?'}%, 신뢰도: ${a.confidence ?? '?'}%
   - 근거: ${a.rationale.slice(0, 200)}
`).join('\n')}

다음 JSON만 반환하세요 (다른 텍스트 없이):
{
  "overview": "회사 개요 - 어떤 사업을 하는지, 주력 제품/서비스, 시장 점유율 (2-3문장, 150자 내외)",
  "thesis": "현재 매수 후보로 거론되는 종합 근거 (위 분석들 통합) (2-3문장, 200자 내외)",
  "key_risks": ["주요 리스크 1 (한 문장)", "주요 리스크 2 (한 문장)"],
  "competitive_position": "이 회사의 시장 내 경쟁 우위 또는 약점 (1-2문장)",
  "watch_points": ["투자자가 주시해야 할 핵심 포인트 1", "포인트 2"],
  "sector": "회사의 주력 섹터 한국어",
  "korean_name_check": "한국명이 회사의 정확한 명칭이면 'ok', 아니면 정확한 한국명"
}

규칙:
- 사실에 근거. 추측이나 일반론 금지
- 한국어로 작성
- 마케팅 문구 없이 객관적으로
- 위 분석 데이터가 부족하면 회사에 대한 기본 정보로 채우되, 추측은 표시`;

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content[0].text.trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON in AI response');
    const parsed = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));

    return res.status(200).json({
      ok: true,
      ticker,
      company: { name_ko: company.name_ko, name_en: company.name_en, market: company.market, sector: company.sector },
      ...parsed,
      analyses_count: analyses.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
