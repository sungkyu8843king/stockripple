import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { verifyAdmin } from '../lib/auth.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await verifyAdmin(req.headers.authorization);
  if (!auth.ok) return res.status(401).json({ error: auth.error });

  const rawBody = req.body || {};
  const issue_id = rawBody.issue_id;
  // Vercel 60초 타임아웃 + 펀더멘털 fetch 추가로 1회 최대 5건 (이슈당 ~10초)
  const HARD_CAP = 5;
  const limit = Math.min(rawBody.limit ?? 5, HARD_CAP);
  const force_recent = Math.min(rawBody.force_recent ?? 0, HARD_CAP);

  // force_recent: 최근 N개 이슈를 무조건 재분석 (기존 분석 삭제 후 재생성)
  let reanalyzed = 0;
  if (force_recent > 0) {
    const { data: recentIssues } = await supabase
      .from('issues')
      .select('id, analyses(id)')
      .order('published_at', { ascending: false })
      .limit(force_recent);

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

  const results = { analyzed: 0, errors: [], processed: [] };

  for (const issue of issues) {
    const issueStart = Date.now();
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

      // 모든 ripple effects의 companies를 한꺼번에 병렬 처리 (속도 핵심)
      const allCompanyTasks = [];
      for (const ripple of analysis.rippleEffects || []) {
        for (const co of ripple.companies || []) {
          allCompanyTasks.push({ ripple, co });
        }
      }
      const pickedTickers = [];

      await Promise.all(allCompanyTasks.map(async ({ ripple, co }) => {
        // 모순된 매매 정보 자동 보정 (AI 환각 방지)
        if (co.upside_pct != null && co.upside_pct <= 0) {
          results.errors.push(`Skipped ${co.ticker}: 음수 upside_pct (${co.upside_pct}%) — 매수 추천 불가`);
          return;
        }
        if (co.target_pct != null && co.target_pct <= 0) {
          // upside_pct로 대체
          co.target_pct = co.upside_pct;
        }
        if (co.stop_loss_pct != null && co.stop_loss_pct >= 0) {
          // 양수 손절은 음수로 강제
          co.stop_loss_pct = -Math.abs(co.stop_loss_pct);
        }

        const valid = await validateTicker(co.ticker);
        if (!valid) {
          results.errors.push(`Invalid ticker skipped: ${co.ticker} (${co.name_ko})`);
          return;
        }
        const companyId = await upsertCompany(co, valid);

        // 펀더멘털 fetch + 점수 보정 (병렬 처리됨)
        const fund = await fetchFundamentals(co.ticker);
        const fundScore = scoreFundamentals(fund);

        let adjConfidence = co.confidence ?? 50;
        if (fundScore != null) {
          adjConfidence = Math.max(0, Math.min(100, adjConfidence + fundScore));
        }

        const tradeMeta = {
          elp: co.entry_low_pct, ehp: co.entry_high_pct,
          tp:  co.target_pct,    sl:  co.stop_loss_pct,
          tf:  co.time_frame,    th:  co.key_thesis,    rk: co.key_risk,
        };
        const cleanMeta = Object.fromEntries(
          Object.entries(tradeMeta).filter(([_, v]) => v != null && v !== '')
        );
        const fundMeta = fund ? {
          pe: fund.pe, pb: fund.pb, roe: fund.roe,
          opm: fund.operatingMargin, de: fund.debtToEquity, cr: fund.currentRatio,
          rev_yoy: fund.revenueGrowthYoY, ni_yoy: fund.netIncomeGrowthYoY,
          score: fundScore,
        } : null;

        let enrichedRationale = co.rationale || '';
        if (Object.keys(cleanMeta).length) enrichedRationale += `\n\n[TRADE]${JSON.stringify(cleanMeta)}`;
        if (fundMeta) enrichedRationale += `\n\n[FUND]${JSON.stringify(fundMeta)}`;

        await supabase.from('analysis_companies').insert({
          analysis_id: savedAnalysis.id,
          company_id: companyId,
          ripple_sector: ripple.sector,
          rationale: enrichedRationale,
          upside_pct: co.upside_pct,
          confidence: adjConfidence,
          entry_price: valid.price,
          entry_date: new Date().toISOString(),
        });
        pickedTickers.push(`${co.ticker}(${adjConfidence}%)`);
      }));

      await supabase.from('issues').update({ is_analyzed: true }).eq('id', issue.id);
      results.analyzed++;
      results.processed.push({
        title: issue.title?.slice(0, 80) || '(제목 없음)',
        companies: pickedTickers.slice(0, 8),
        duration_ms: Date.now() - issueStart,
        relevance: analysis.relevance_score,
      });

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

      await new Promise(r => setTimeout(r, 200));
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

📌 부호 일관성 (반드시 지킬 것):
- target_pct: **반드시 양수 (+)** — 매수 추천이므로 목표는 무조건 상승. upside_pct와 일치
- stop_loss_pct: **반드시 음수 (-)** — 손절선은 진입가 아래
- upside_pct: 양수만. 음수면 그 종목은 rippleEffects에 넣지 말 것 (매수 추천 = 상승 예상이어야 함)

⚠️ 만약 종목이 하락할 것으로 예상되면 → rippleEffects의 companies에서 제외하거나 impact:negative 섹터로만 분류 (그 섹터 내 companies는 비워둘 것)

매매 정보 상세:
- entry_low_pct / entry_high_pct: 진입 가격대 (현재가 대비 %). 예: -2 ~ +1이면 현재가에서 -2%~+1% 사이에서 매수
  · 강하게 추천이면 좁게 (-1 ~ +1), 조정 기대시 넓게 (-5 ~ 0)
- target_pct: 양수만. 목표가까지 기대 수익률. upside_pct와 동일 값
- stop_loss_pct: 음수만. 보통 -5 ~ -10% 사이. target_pct의 절댓값보다 작아야 함 (손익비 의미)
- time_frame: 보유 기간. "1w"(단기 1주) / "1m"(중기 1개월) / "3m"(중장기 3개월) / "6m"(장기 6개월) 중 하나
- key_thesis: "왜 지금 사야 하는가" 한 문장 (15자~40자, 구체적·실행 가능한 근거)
- key_risk: "무엇이 잘못될 수 있나" 한 문장 (15자~40자)

티커 규칙:
- 반드시 Yahoo Finance에서 실제로 거래되는 종목만 사용
- 한국 주식 티커: 반드시 6자리 숫자.KS 형식 (예: 005930.KS=삼성전자, 000660.KS=SK하이닉스, 035420.KS=NAVER, 051910.KS=LG화학)
- 미국 주식: NYSE/NASDAQ 실제 상장 티커만 사용 (예: AAPL, MSFT, NVDA, TSLA)
- 확실하지 않은 티커는 절대 추측하지 말고 제외할 것

⭐ 펀더멘털 고려 (시스템이 자동 검증):
- 종목 선택 시 다음 조건을 우선 고려: 수익성(ROE/영업이익률) 양호, 부채비율 적정(<2), 매출 성장세
- 시스템이 자동으로 PE/PB/ROE/부채비율/유동비율/매출성장 데이터를 가져와 confidence를 조정합니다
- 적자 기업이나 부채비율 3+인 부실 기업은 가능한 한 회피 (테마주/모멘텀 이슈가 명확하지 않은 경우)
- 동일 섹터 내에서는 펀더멘털 우수 기업 우선 (단, 뉴스 임팩트가 압도적이면 예외 OK)

⭐ 회사명 정확성 (매우 중요 - 환각 금지):
- name_en은 회사의 정식 영문 법인명 (예: LRCX → "Lam Research", AVGO → "Broadcom")
- name_ko는 한국에서 통용되는 정식 한국어 회사명. 영문명의 음역이거나 한국에서 공식 사용하는 이름.
  · 예: Lam Research → "램 리서치", Broadcom → "브로드컴", Micron → "마이크론 테크놀로지"
  · 절대 다른 회사의 제품명/브랜드명 사용 금지 (예: LRCX를 "라이젠"이라고 하면 안 됨 — Ryzen은 AMD 제품)
- 티커와 회사명이 매칭되는지 확실하지 않으면 그 종목을 제외할 것`;

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

// ── 펀더멘털 fetch (FMP stable, 무료 엔드포인트만) ────────
async function fetchFundamentals(ticker) {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;
  if (/\.KS$|\.KQ$/i.test(ticker)) return null;  // 한국 주식은 FMP 무료에서 안 됨

  const fmp = (path) => fetch(`https://financialmodelingprep.com${path}${path.includes('?') ? '&' : '?'}apikey=${key}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) })
    .then(r => r.ok ? r.json() : null).catch(() => null);

  try {
    const [quote, incomeQ, balanceQ] = await Promise.all([
      fmp(`/stable/quote?symbol=${encodeURIComponent(ticker)}`),
      fmp(`/stable/income-statement?symbol=${encodeURIComponent(ticker)}&period=quarter&limit=5`),
      fmp(`/stable/balance-sheet-statement?symbol=${encodeURIComponent(ticker)}&period=quarter&limit=1`),
    ]);
    const qt  = Array.isArray(quote) ? quote[0] : quote;
    const inc      = Array.isArray(incomeQ)  ? incomeQ[0]  : null;
    const incYoY   = Array.isArray(incomeQ)  ? (incomeQ[3] || incomeQ[4] || null) : null;
    const bal      = Array.isArray(balanceQ) ? balanceQ[0] : null;
    if (!qt && !inc) return null;

    const n = v => (v == null || isNaN(Number(v))) ? null : Number(v);
    const div = (a, b) => (n(a) != null && n(b) != null && n(b) !== 0) ? (n(a) / n(b)) : null;
    const pct = (a, b) => (n(a) != null && n(b) != null && n(b) !== 0) ? ((n(a) - n(b)) / Math.abs(n(b)) * 100) : null;

    const revenue   = n(inc?.revenue);
    const opInc     = n(inc?.operatingIncome);
    const netInc    = n(inc?.netIncome);
    const equity    = n(bal?.totalStockholdersEquity);
    const debt      = n(bal?.totalDebt) || n(bal?.longTermDebt);
    const ca        = n(bal?.totalCurrentAssets);
    const cl        = n(bal?.totalCurrentLiabilities);

    return {
      pe:  n(qt?.pe),
      pb:  div(n(qt?.price), div(equity, n(qt?.sharesOutstanding))),
      roe: div(netInc, equity) != null ? div(netInc, equity) * 100 : null,
      operatingMargin: div(opInc, revenue) != null ? div(opInc, revenue) * 100 : null,
      debtToEquity:    div(debt, equity),
      currentRatio:    div(ca, cl),
      revenueGrowthYoY:   incYoY ? pct(revenue, incYoY.revenue) : null,
      netIncomeGrowthYoY: incYoY ? pct(netInc, incYoY.netIncome) : null,
    };
  } catch { return null; }
}

// 펀더멘털 점수 -30 ~ +30 (AI confidence 보정용)
function scoreFundamentals(f) {
  if (!f) return null;
  let score = 0;
  // ROE: 높을수록 좋음
  if (f.roe != null) {
    if (f.roe > 20) score += 8;
    else if (f.roe > 10) score += 4;
    else if (f.roe < 0) score -= 8;
  }
  // 영업이익률
  if (f.operatingMargin != null) {
    if (f.operatingMargin > 20) score += 6;
    else if (f.operatingMargin > 10) score += 3;
    else if (f.operatingMargin < 0) score -= 8;
  }
  // 매출 성장 (YoY)
  if (f.revenueGrowthYoY != null) {
    if (f.revenueGrowthYoY > 20) score += 6;
    else if (f.revenueGrowthYoY > 5) score += 3;
    else if (f.revenueGrowthYoY < -10) score -= 6;
  }
  // 부채비율
  if (f.debtToEquity != null) {
    if (f.debtToEquity < 0.5) score += 4;
    else if (f.debtToEquity > 3) score -= 6;
  }
  // 유동비율
  if (f.currentRatio != null) {
    if (f.currentRatio > 2) score += 3;
    else if (f.currentRatio < 1) score -= 5;
  }
  // PE: 너무 비싸면 감점
  if (f.pe != null) {
    if (f.pe > 50) score -= 4;
    else if (f.pe > 0 && f.pe < 20) score += 3;
  }
  return Math.max(-30, Math.min(30, score));
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
  // Yahoo가 알려주는 공식 회사명을 신뢰의 원천으로 사용 (AI 환각 방지)
  const officialName = priceData?.longName || null;
  // AI가 준 name_ko가 의심스러우면 (영어 공식명에 포함된 토큰과 다른 회사명일 때) 영어명으로 대체
  // 예: LRCX의 longName이 "Lam Research Corporation"인데 AI가 "라이젠"이라고 했다면 → "Lam Research" 로 대체
  let nameKo = co.name_ko || '';
  if (officialName) {
    const officialLower = officialName.toLowerCase();
    const koLower       = nameKo.toLowerCase();
    // 한글 변형 확인: 영어 longName의 첫 단어가 한글 이름에 음역으로 포함되는지 대충 확인
    // 너무 엄격하면 정상 데이터도 거부하므로, 공식명을 fallback으로만 사용
    if (!nameKo || nameKo.length < 2) nameKo = officialName;
  }

  const { data: existing } = await supabase
    .from('companies')
    .select('id, name_en, name_ko')
    .eq('ticker', co.ticker)
    .single();

  // 기존 row가 있어도 공식 영어명이 비어 있으면 업데이트
  if (existing) {
    if (officialName && (!existing.name_en || existing.name_en === existing.name_ko)) {
      await supabase.from('companies').update({ name_en: officialName }).eq('id', existing.id);
    }
    return existing.id;
  }

  const insertData = {
    ticker:  co.ticker,
    name_ko: nameKo,
    name_en: officialName || co.name_en || co.name_ko,
    market:  co.market,
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
