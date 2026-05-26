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

  const { issue_id, limit = 10, force_recent = 0 } = req.body || {};

  // force_recent: 최근 N개 이슈를 무조건 재분석 (기존 분석 삭제 후 재생성)
  let reanalyzed = 0;
  if (force_recent > 0) {
    const { data: recentIssues } = await supabase
      .from('issues')
      .select('id, analyses(id)')
      .order('published_at', { ascending: false })
      .limit(Math.min(force_recent, 50));

    const analysisIds = (recentIssues || []).flatMap(i => (i.analyses || []).map(a => a.id));
    if (analysisIds.length) {
      // 자식 테이블 먼저 삭제
      await supabase.from('analysis_companies').delete().in('analysis_id', analysisIds);
      await supabase.from('analyses').delete().in('id', analysisIds);
    }
    const ids = (recentIssues || []).map(i => i.id);
    if (ids.length) {
      await supabase.from('issues').update({ is_analyzed: false }).in('id', ids);
      reanalyzed = ids.length;
    }
  }

  let query = supabase.from('issues').select('*').eq('is_analyzed', false);
  if (issue_id) query = supabase.from('issues').select('*').eq('id', issue_id);
  else query = query.order('published_at', { ascending: false }).limit(limit);

  const { data: issues, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  if (!issues?.length) return res.status(200).json({ message: 'No issues to analyze', count: 0, reanalyzed });

  const results = { analyzed: 0, errors: [] };

  for (const issue of issues) {
    try {
      const analysis = await analyzeIssue(issue);

      // 관련성 낮은 이슈 제거 (비상장 스타트업, 생활경제, 스포츠 등)
      if ((analysis.relevance_score ?? 100) < 40) {
        await supabase.from('issues').delete().eq('id', issue.id);
        results.errors.push(`Irrelevant (score ${analysis.relevance_score}), deleted: "${issue.title?.slice(0, 60)}"`);
        continue;
      }

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
          const valid = await validateTicker(co.ticker);
          if (!valid) {
            results.errors.push(`Invalid ticker skipped: ${co.ticker} (${co.name_ko})`);
            continue;
          }
          const companyId = await upsertCompany(co, valid);
          // 매매 정보를 rationale 끝에 구조화된 마커로 임베드 (DB 스키마 변경 불필요)
          const tradeMeta = {
            elp: co.entry_low_pct,       // entry_low_pct
            ehp: co.entry_high_pct,      // entry_high_pct
            tp:  co.target_pct,          // target_pct
            sl:  co.stop_loss_pct,       // stop_loss_pct
            tf:  co.time_frame,          // time_frame
            th:  co.key_thesis,          // key_thesis
            rk:  co.key_risk,            // key_risk
          };
          const cleanMeta = Object.fromEntries(
            Object.entries(tradeMeta).filter(([_, v]) => v != null && v !== '')
          );
          const enrichedRationale = Object.keys(cleanMeta).length
            ? `${co.rationale || ''}\n\n[TRADE]${JSON.stringify(cleanMeta)}`
            : co.rationale;

          await supabase.from('analysis_companies').insert({
            analysis_id: savedAnalysis.id,
            company_id: companyId,
            ripple_sector: ripple.sector,
            rationale: enrichedRationale,
            upside_pct: co.upside_pct,
            confidence: co.confidence,
            entry_price: valid.price,
            entry_date: new Date().toISOString(),
          });
        }
      }

      await supabase.from('issues').update({ is_analyzed: true }).eq('id', issue.id);
      results.analyzed++;

      const tickers = (analysis.rippleEffects || [])
        .flatMap(r => r.companies || [])
        .filter(c => c.ticker)
        .map(c => `${c.ticker}(${c.upside_pct > 0 ? '+' : ''}${c.upside_pct}%)`)
        .slice(0, 5)
        .join(', ');
      await sendNotify(
        `📊 <b>StockRipple 새 분석</b>\n${issue.title}\n\n수혜 기업: ${tickers || '—'}\n신뢰도: ${analysis.confidence_score || 50}%`,
        req
      ).catch(() => {});

      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      results.errors.push(`Issue "${issue.title?.slice(0, 50)}": ${err.message}`);
    }
  }

  return res.status(200).json({ ...results, reanalyzed });
}

async function sendNotify(message, req) {
  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `https://${req.headers.host}`;
  await fetch(`${base}/api/notify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.ADMIN_SECRET}`,
    },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(10000),
  });
}

async function analyzeIssue(issue) {
  const prompt = `당신은 글로벌 주식시장 분석 전문가입니다. 다음 뉴스/이슈를 분석하여 파급효과와 수혜 기업을 찾아주세요.

이슈 제목: ${issue.title}
요약: ${issue.summary || '없음'}
관련 섹터: ${issue.sectors?.join(', ') || '미분류'}

다음 형식으로 JSON만 반환하세요 (다른 텍스트 없이):
{
  "relevance_score": 75,
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
          "confidence": 70,
          "entry_low_pct": -2,
          "entry_high_pct": 1,
          "target_pct": 15,
          "stop_loss_pct": -7,
          "time_frame": "1m",
          "key_thesis": "한 문장 핵심 매수 논리 (왜 지금 사야 하는가)",
          "key_risk": "한 문장 핵심 리스크"
        }
      ]
    }
  ],
  "confidence_score": 75
}

규칙:
- relevance_score: 주식시장 투자 관련성 (0-100). 상장기업 실적/정책/금리/무역 등 투자에 직접 영향이면 70+, 간접적이면 40-70, 비상장 스타트업·생활경제·스포츠·연예 등 무관하면 40 미만
- relevance_score < 40이면 rippleEffects는 빈 배열로 반환
- rippleEffects는 2-4개, 각 섹터당 기업은 2-3개 (relevance_score >= 40인 경우만)
- 한국 기업(KR)과 미국 기업(US)을 균형있게 포함
- upside_pct는 현실적으로 5-50% 범위
- confidence는 0-100 (데이터 확실성 기반)

⭐ 매매 정보 (현재가 대비 % 단위, 매우 중요):
- entry_low_pct / entry_high_pct: 진입 가격대 (현재가 대비 %). 예: -2 ~ +1이면 현재가에서 -2%~+1% 사이에서 매수
  · 강하게 추천이면 좁게 (-1 ~ +1), 조정 기대시 넓게 (-5 ~ 0)
- target_pct: 목표가까지 기대 수익률 (%). upside_pct와 일치해야 함
- stop_loss_pct: 손절선 (음수, 보통 -5 ~ -10% 사이)
- time_frame: 보유 기간. "1w"(단기 1주) / "1m"(중기 1개월) / "3m"(중장기 3개월) / "6m"(장기 6개월) 중 하나
  · 단발 이슈/실적 모멘텀은 1w-1m, 구조적 변화는 3m-6m
- key_thesis: "왜 지금 사야 하는가" 한 문장 (15자~40자, 구체적·실행 가능한 근거)
- key_risk: "무엇이 잘못될 수 있나" 한 문장 (15자~40자)

티커 규칙:
- 반드시 Yahoo Finance에서 실제로 거래되는 종목만 사용
- 한국 주식 티커: 반드시 6자리 숫자.KS 형식 (예: 005930.KS=삼성전자, 000660.KS=SK하이닉스, 035420.KS=NAVER, 051910.KS=LG화학)
- 미국 주식: NYSE/NASDAQ 실제 상장 티커만 사용 (예: AAPL, MSFT, NVDA, TSLA)
- 확실하지 않은 티커는 절대 추측하지 말고 제외할 것`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('JSON not found in response');

  return parseJsonSafe(jsonMatch[0]);
}

async function validateTicker(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice && !meta?.previousClose) return null;
    return {
      price: meta.regularMarketPrice || meta.previousClose,
      marketCap: meta.marketCap || null,
      currency: meta.currency || 'USD',
      longName: meta.longName || meta.shortName || null,
    };
  } catch {
    return null;
  }
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    // Fix trailing commas before } or ]
    let fixed = text
      .replace(/,\s*([}\]])/g, '$1')
      // Remove control characters in strings
      .replace(/[\x00-\x1F\x7F]/g, ' ');
    try {
      return JSON.parse(fixed);
    } catch (_) {
      // Try to close unclosed JSON by finding last complete array/object
      const lastBrace = fixed.lastIndexOf('}');
      if (lastBrace > 0) {
        fixed = fixed.slice(0, lastBrace + 1);
        fixed = fixed.replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(fixed);
      }
      throw new Error('Failed to parse AI response as JSON');
    }
  }
}

async function upsertCompany(co, priceData = null) {
  const { data: existing } = await supabase
    .from('companies')
    .select('id')
    .eq('ticker', co.ticker)
    .single();

  if (existing) return existing.id;

  const insertData = {
    ticker: co.ticker,
    name_ko: co.name_ko,
    name_en: co.name_en || priceData?.longName || co.name_ko,
    market: co.market,
  };
  if (priceData) {
    insertData.current_price = priceData.price;
    insertData.market_cap = priceData.marketCap;
    insertData.currency = priceData.currency;
    insertData.price_updated_at = new Date().toISOString();
  }

  const { data: newCo } = await supabase
    .from('companies')
    .insert(insertData)
    .select()
    .single();

  return newCo.id;
}
