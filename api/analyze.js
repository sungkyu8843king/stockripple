import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';
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
  // Vercel 60초 타임아웃. 2-패스 분석(후보발굴 + 애널리스트 결정)으로 이슈당 ~18초 → 1회 최대 3건
  const HARD_CAP = 3;
  const limit = Math.min(rawBody.limit ?? 5, HARD_CAP);
  const force_recent = Math.min(rawBody.force_recent ?? 0, HARD_CAP);
  // 체이닝: 1회 호출은 5건이 한계지만, 처리 후 스스로를 재호출해 여러 배치를 이어서 처리
  // (각 호출은 새 60초 예산을 받음). 크론(일일 자동)은 기본 4회(20건/일)로 비용 제한.
  // 수동으로 max_chain을 올려서 한 번에 더 큰 배치를 처리할 수 있음 (절대 상한 60회 = 300건).
  const DEFAULT_MAX_CHAIN = 4;
  const ABSOLUTE_MAX_CHAIN = 60;
  const MAX_CHAIN = Math.min(Math.max(parseInt(rawBody.max_chain ?? DEFAULT_MAX_CHAIN, 10) || DEFAULT_MAX_CHAIN, 1), ABSOLUTE_MAX_CHAIN);
  const chainCount = Math.min(Math.max(parseInt(rawBody.chain_count ?? 0, 10) || 0, 0), MAX_CHAIN);

  // 48시간 지난 미분석 이슈는 스킵 처리 — 오래된 뉴스에 "현재가 진입" 분석은 무의미하고 백로그만 쌓임
  // (is_analyzed=true지만 analyses row가 없으므로 피드의 analyses!inner 조인에는 노출되지 않음)
  let staleSkipped = 0;
  {
    const staleCutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const { count } = await supabase
      .from('issues')
      .update({ is_analyzed: true }, { count: 'exact' })
      .eq('is_analyzed', false)
      .lt('published_at', staleCutoff);
    staleSkipped = count || 0;
  }

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
  if (!issues?.length) return res.status(200).json({ message: 'No issues to analyze', count: 0, reanalyzed, staleSkipped });

  const results = { analyzed: 0, errors: [], corrections: [], excluded: [], processed: [] };

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

      // ── 1단계: 후보 티커 검증/교정 + 시장 데이터 수집 (병렬) ──
      const allCompanyTasks = [];
      for (const ripple of analysis.rippleEffects || []) {
        for (const co of ripple.companies || []) {
          allCompanyTasks.push({ ripple, co });
        }
      }
      const pickedTickers = [];
      const candidates = [];

      await Promise.all(allCompanyTasks.map(async ({ ripple, co }) => {
        let valid = await validateTicker(co.ticker);
        if (!valid) {
          results.errors.push(`Invalid ticker skipped: ${co.ticker} (${co.name_ko})`);
          return;
        }

        // 티커 실존 ≠ 회사 일치. AI가 "삼성전자" 의도로 000810.KS(삼성화재)를 주는 환각 차단
        if (!namesMatch(co, valid.longName)) {
          const resolved = await resolveTickerByName(co);
          if (!resolved) {
            results.errors.push(`Name mismatch skipped: ${co.ticker} "${co.name_en || co.name_ko}" ≠ Yahoo "${valid.longName || '?'}"`);
            return;
          }
          if (resolved !== co.ticker) {
            const revalid = await validateTicker(resolved);
            if (!revalid) {
              results.errors.push(`Name mismatch skipped: ${co.ticker} "${co.name_en || co.name_ko}" (교정 후보 ${resolved} 시세 조회 실패)`);
              return;
            }
            results.corrections.push(`${co.ticker} → ${resolved} ("${co.name_en || co.name_ko}", Yahoo: ${revalid.longName || '?'})`);
            co.ticker = resolved;
            valid = revalid;
          }
          // resolved === co.ticker 이면 검색 결과가 AI 티커를 확인해준 것 (음역 등으로 토큰 비교만 실패한 케이스)
        }

        const [stats, fund] = await Promise.all([
          fetchPriceStats(co.ticker),
          fetchFundamentals(co.ticker),
        ]);
        candidates.push({ ripple, co, valid, stats, fund, fundScore: scoreFundamentals(fund) });
      }));

      // 티커 교정으로 같은 종목이 중복될 수 있음 → 첫 후보만 유지
      const seenTickers = new Set();
      const uniqCandidates = candidates.filter(c => {
        const t = c.co.ticker.toUpperCase();
        if (seenTickers.has(t)) return false;
        seenTickers.add(t);
        return true;
      });

      if (uniqCandidates.length) {
        // ── 2단계: 애널리스트 패스 — 실제 시장 데이터를 보고 매수/제외 결정 ──
        const decisions = await decideTrades(issue, analysis, uniqCandidates);

        for (const cand of uniqCandidates) {
          const t = cand.co.ticker.toUpperCase();
          const d = decisions[t];
          const s = cand.stats;

          if (!d || d.action !== 'buy') {
            results.excluded.push(`${cand.co.ticker}: ${d?.exclude_reason || '애널리스트 패스 제외'}`);
            continue;
          }
          // 하드 필터: 명백한 하락 추세는 AI 판단과 무관하게 차단 (떨어지는 칼 잡기 금지)
          if (s && s.ret1m != null && s.ret1m < -10 && s.aboveSma50 === false) {
            results.excluded.push(`${cand.co.ticker}: 하락 추세 (1M ${s.ret1m}%, 50일선 아래)`);
            continue;
          }

          clampTrade(d, s);
          const momScore = scoreMomentum(s);
          let composite = (d.confidence ?? 50) + (cand.fundScore ?? 0) + momScore;
          composite = Math.max(0, Math.min(100, Math.round(composite)));
          // 게재 게이트: AI 확신 + 펀더멘털 + 모멘텀 종합 60점 미만은 게재하지 않음 (소수 정예)
          if (composite < 60) {
            results.excluded.push(`${cand.co.ticker}: 종합점수 ${composite} 미달 (AI ${d.confidence ?? 50}, 펀더 ${cand.fundScore ?? '-'}, 모멘텀 ${momScore})`);
            continue;
          }

          const companyId = await upsertCompany(cand.co, cand.valid);

          const tradeMeta = {
            elp: d.entry_low_pct, ehp: d.entry_high_pct,
            tp:  d.upside_pct,    sl:  d.stop_loss_pct,
            tf:  d.time_frame,    th:  d.key_thesis,    rk: d.key_risk,
          };
          const cleanMeta = Object.fromEntries(
            Object.entries(tradeMeta).filter(([_, v]) => v != null && v !== '')
          );
          const fund = cand.fund;
          const fundMeta = (fund || s) ? {
            ...(fund ? {
              pe: fund.pe, pb: fund.pb, roe: fund.roe,
              opm: fund.operatingMargin, de: fund.debtToEquity, cr: fund.currentRatio,
              rev_yoy: fund.revenueGrowthYoY, ni_yoy: fund.netIncomeGrowthYoY,
            } : {}),
            ...(s ? { mom1m: s.ret1m, mom3m: s.ret3m, atrm: s.atrMonthPct, ma50: s.aboveSma50 ? 1 : 0 } : {}),
            score: cand.fundScore, moms: momScore,
          } : null;

          let enrichedRationale = cand.co.rationale || d.key_thesis || '';
          if (Object.keys(cleanMeta).length) enrichedRationale += `\n\n[TRADE]${JSON.stringify(cleanMeta)}`;
          if (fundMeta) enrichedRationale += `\n\n[FUND]${JSON.stringify(fundMeta)}`;

          await supabase.from('analysis_companies').insert({
            analysis_id: savedAnalysis.id,
            company_id: companyId,
            ripple_sector: cand.ripple.sector,
            rationale: enrichedRationale,
            upside_pct: d.upside_pct,
            confidence: composite,
            entry_price: cand.valid.price,
            entry_date: new Date().toISOString(),
          });
          pickedTickers.push(`${cand.co.ticker}(${composite}%)`);
        }
      }

      await supabase.from('issues').update({ is_analyzed: true }).eq('id', issue.id);
      results.analyzed++;
      results.processed.push({
        title: issue.title?.slice(0, 80) || '(제목 없음)',
        companies: pickedTickers.slice(0, 8),
        duration_ms: Date.now() - issueStart,
        relevance: analysis.relevance_score,
      });

      const tickers = pickedTickers.slice(0, 5).join(', ');
      await sendNotify(
        `📊 <b>StockRipple 새 분석</b>\n${issue.title}\n\n게재 종목: ${tickers || '— (전원 제외)'}\n신뢰도: ${analysis.confidence_score || 50}%`,
        req
      ).catch(() => {});

      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      results.errors.push(`Issue "${issue.title?.slice(0, 50)}": ${err.message}`);
    }
  }

  // 이번 배치가 꽉 찼다면(=limit만큼 처리) 백로그가 더 남아있을 가능성이 높음 → 다음 배치를 이어서 트리거
  // waitUntil로 감싸서 res.json() 응답 이후에도 이 요청이 실제로 전송될 때까지 함수 인스턴스가
  // 살아있도록 보장 (평범한 fire-and-forget fetch는 응답 직후 인스턴스가 얼어붙어 유실될 수 있음)
  if (!issue_id && issues.length === limit && chainCount < MAX_CHAIN - 1) {
    waitUntil(triggerNextChain(req, limit, chainCount + 1, MAX_CHAIN));
  }

  return res.status(200).json({ ...results, reanalyzed, staleSkipped, chainCount, maxChain: MAX_CHAIN });
}

function triggerNextChain(req, limit, nextChainCount, maxChain) {
  const base = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `https://${req.headers.host}`;
  // 다음 배치의 완료까지 기다리지 않음 — 요청이 실제로 전달되는 것만 확인하면 충분
  // (짧은 타임아웃으로 waitUntil이 붙잡고 있는 시간을 최소화)
  return fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.ADMIN_SECRET}`,
    },
    body: JSON.stringify({ limit, chain_count: nextChainCount, max_chain: maxChain }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

// ─── 티커-회사명 일치 검증 (AI 환각 차단) ────────────────
const NAME_STOP_TOKENS = new Set([
  'inc', 'corp', 'corporation', 'co', 'ltd', 'limited', 'plc', 'ag', 'sa', 'nv',
  'holdings', 'holding', 'group', 'company', 'companies', 'class', 'the', 'and',
]);

function nameTokens(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !NAME_STOP_TOKENS.has(t));
}

function stripKoName(s) {
  return (s || '').replace(/\(주\)|주식회사|㈜/g, '').replace(/[^가-힣a-z0-9]/gi, '').toLowerCase();
}

/**
 * AI가 준 회사명(name_en/name_ko)과 Yahoo 공식명(longName)이 같은 회사인지 판정.
 * false여도 바로 버리지 않고 resolveTickerByName()으로 2차 확인 (음역 차이 등 보수적 처리).
 */
function namesMatch(co, officialName) {
  if (!officialName) return true; // 공식명 없으면 검증 불가 → 통과
  // 공식명이 한국어면 name_ko와 포함 관계 비교 (예: "에스케이하이닉스(주)" vs "SK하이닉스"는 실패 → 검색 폴백)
  if (/[가-힣]/.test(officialName)) {
    const off = stripKoName(officialName);
    const ko = stripKoName(co.name_ko);
    return !!(ko && off && (off.includes(ko) || ko.includes(off)));
  }
  const offT = nameTokens(officialName);
  const aiT = nameTokens(co.name_en);
  if (!offT.length || !aiT.length) return false;
  const offSet = new Set(offT);
  const overlap = aiT.filter(t => offSet.has(t)).length;
  // 짧은 쪽 기준 60% 이상 겹쳐야 동일 회사로 인정
  // "Samsung Electronics" vs "Samsung Fire & Marine Insurance" → 1/2 = 50% → 불일치
  return overlap / Math.min(aiT.length, offT.length) >= 0.6;
}

/**
 * Yahoo 검색으로 회사명 → 티커 역조회.
 * - AI 티커가 검색 결과에 있으면 그대로 반환 (이름 표기 차이였던 것)
 * - 없으면 같은 시장(KR/US)의 최상위 종목으로 교정 티커 반환
 * - 결과 없으면 null (해당 종목 스킵)
 */
async function resolveTickerByName(co) {
  for (const q of [co.name_en, co.name_ko]) {
    if (!q || q.length < 2) continue;
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=6&newsCount=0`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data = await res.json();
      const quotes = (data.quotes || []).filter(x => x.symbol && (!x.quoteType || x.quoteType === 'EQUITY'));
      if (!quotes.length) continue;
      if (quotes.some(x => x.symbol.toUpperCase() === co.ticker.toUpperCase())) return co.ticker;
      const wantKr = co.market === 'KR' || /\.K[SQ]$/i.test(co.ticker);
      // 교정 후보는 정규 시장만: KR은 KOSPI/KOSDAQ, US는 NYSE/NASDAQ 계열 (OTC·해외 2차상장 제외)
      const US_EXCHANGES = new Set(['NYQ', 'NMS', 'NGM', 'NCM', 'NYS', 'NAS', 'ASE', 'PCX', 'BTS']);
      const cand = quotes.find(x => wantKr
        ? /\.K[SQ]$/i.test(x.symbol)
        : US_EXCHANGES.has(x.exchange));
      if (cand) return cand.symbol;
    } catch {}
  }
  return null;
}

// ─── 주가 통계 (모멘텀·변동성) — 애널리스트 패스의 입력 데이터 ────────
async function fetchPriceStats(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=6mo`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data.chart?.result?.[0];
    const q = result?.indicators?.quote?.[0];
    if (!q?.close) return null;

    // null 봉 제거 (거래정지일 등)
    const bars = [];
    for (let i = 0; i < q.close.length; i++) {
      if (q.close[i] != null && q.high[i] != null && q.low[i] != null) {
        bars.push({ c: q.close[i], h: q.high[i], l: q.low[i] });
      }
    }
    if (bars.length < 25) return null;

    const last = bars[bars.length - 1].c;
    const r = (n) => bars.length > n ? Math.round(((last - bars[bars.length - 1 - n].c) / bars[bars.length - 1 - n].c) * 1000) / 10 : null;
    const sma = (n) => bars.length >= n ? bars.slice(-n).reduce((a, b) => a + b.c, 0) / n : null;

    // ATR(14) % — 일간 평균 변동폭. 월간 기대 변동폭 ≈ 일간 ATR% × √21
    let trSum = 0, trN = 0;
    for (let i = Math.max(1, bars.length - 14); i < bars.length; i++) {
      const tr = Math.max(
        bars[i].h - bars[i].l,
        Math.abs(bars[i].h - bars[i - 1].c),
        Math.abs(bars[i].l - bars[i - 1].c)
      );
      trSum += tr / bars[i].c;
      trN++;
    }
    const atrDayPct = trN ? (trSum / trN) * 100 : null;

    const sma20 = sma(20), sma50 = sma(50);
    const high6m = Math.max(...bars.map(b => b.h));

    return {
      ret5d:  r(5),
      ret1m:  r(21),
      ret3m:  r(63),
      aboveSma20: sma20 != null ? last > sma20 : null,
      aboveSma50: sma50 != null ? last > sma50 : null,
      pctFrom6mHigh: high6m ? Math.round(((last - high6m) / high6m) * 1000) / 10 : null,
      atrMonthPct: atrDayPct != null ? Math.round(atrDayPct * Math.sqrt(21) * 10) / 10 : null,
    };
  } catch { return null; }
}

// 모멘텀 점수 -20 ~ +20 (종합점수 보정용)
function scoreMomentum(s) {
  if (!s) return 0;
  let sc = 0;
  if (s.ret1m != null) sc += s.ret1m > 5 ? 6 : s.ret1m > 0 ? 3 : s.ret1m < -10 ? -10 : -4;
  if (s.ret3m != null) sc += s.ret3m > 10 ? 5 : s.ret3m > 0 ? 2 : s.ret3m < -20 ? -6 : -2;
  if (s.aboveSma20 != null) sc += s.aboveSma20 ? 3 : -3;
  if (s.aboveSma50 != null) sc += s.aboveSma50 ? 4 : -4;
  if (s.pctFrom6mHigh != null) sc += s.pctFrom6mHigh > -10 ? 2 : s.pctFrom6mHigh < -40 ? -4 : 0;
  return Math.max(-20, Math.min(20, sc));
}

// 목표/손절을 실제 변동성 범위로 강제 (AI가 임의 숫자를 만들어도 여기서 교정)
const TF_FACTOR = { '1w': 0.5, '1m': 1, '3m': 1.7, '6m': 2.4 };
function clampTrade(d, stats) {
  if (!['1w', '1m', '3m', '6m'].includes(d.time_frame)) d.time_frame = '1m';
  const atrM = stats?.atrMonthPct;
  if (atrM && atrM > 0) {
    const base = atrM * (TF_FACTOR[d.time_frame] || 1);   // 해당 기간의 기대 변동폭
    const lo = Math.max(2, base * 0.4), hi = base * 1.6;
    let tp = d.upside_pct;
    if (tp == null || !(tp > 0)) tp = base;
    tp = Math.min(Math.max(tp, lo), hi);
    d.upside_pct = Math.round(tp * 10) / 10;
  } else {
    // 변동성 데이터 없으면 보수적 상한
    let tp = d.upside_pct;
    if (tp == null || !(tp > 0)) tp = 8;
    d.upside_pct = Math.min(tp, 20);
  }
  // 손절: 목표의 40~70% (손익비 1.4~2.5 보장)
  let sl = d.stop_loss_pct;
  if (sl == null || sl >= 0) sl = -(d.upside_pct * 0.5);
  sl = Math.min(Math.max(sl, -(d.upside_pct * 0.7)), -(d.upside_pct * 0.4));
  d.stop_loss_pct = Math.round(sl * 10) / 10;
  // 진입 밴드 기본값
  if (d.entry_low_pct == null || d.entry_high_pct == null) { d.entry_low_pct = -2; d.entry_high_pct = 1; }
}

// ─── 2단계: 애널리스트 패스 — 실데이터를 보고 매수/제외 결정 ────────
async function decideTrades(issue, analysis, candidates) {
  const rows = candidates.map(c => ({
    ticker: c.co.ticker,
    name: c.co.name_ko || c.co.name_en,
    sector: c.ripple.sector,
    why: (c.co.rationale || '').slice(0, 120),
    price_data: c.stats ? {
      ret_5d: c.stats.ret5d, ret_1m: c.stats.ret1m, ret_3m: c.stats.ret3m,
      above_sma20: c.stats.aboveSma20, above_sma50: c.stats.aboveSma50,
      pct_from_6m_high: c.stats.pctFrom6mHigh, atr_month_pct: c.stats.atrMonthPct,
    } : null,
    fundamentals: c.fund ? {
      pe: c.fund.pe, roe: c.fund.roe, op_margin: c.fund.operatingMargin,
      debt_equity: c.fund.debtToEquity, rev_yoy: c.fund.revenueGrowthYoY,
      fund_score: c.fundScore,
    } : null,
  }));

  const prompt = `당신은 미국 기관투자자(헤지펀드)의 바이사이드 주식 애널리스트입니다. 아래 뉴스 이슈에 대해 리서치팀이 올린 수혜 후보들을 실제 시장 데이터로 검증하고, 매수 추천할 종목만 선별하세요.

애널리스트 원칙:
1. 데이터가 논리를 뒷받침하지 않으면 제외. "수혜 기대"만으로 하락 추세 종목을 사지 않는다.
2. catalyst(뉴스) → mechanism(매출/이익 경로) → timeframe이 명확하지 않으면 제외.
3. 목표수익률은 종목의 실제 변동성(atr_month_pct) 안에서. 한 달에 5%도 안 움직이는 종목에 +15% 목표는 무효.
4. 확신이 없으면 제외가 정답. 전원 제외도 훌륭한 결정이다. 게재 수보다 적중률이 평가 기준.

뉴스 이슈: ${issue.title}
이슈 요약: ${(analysis.summary || issue.summary || '').slice(0, 300)}

후보 종목 데이터 (price_data: %단위, above_*: 이평선 상회 여부, atr_month_pct: 월간 기대 변동폭%):
${JSON.stringify(rows)}

JSON만 반환:
{"decisions":[{"ticker":"...","action":"buy 또는 exclude","exclude_reason":"제외 시 한 문장","confidence":70,"upside_pct":8,"entry_low_pct":-2,"entry_high_pct":1,"stop_loss_pct":-4,"time_frame":"1w|1m|3m|6m","key_thesis":"왜 지금 사는가 한 문장 (데이터 근거 포함)","key_risk":"핵심 리스크 한 문장"}]}

buy 규칙:
- upside_pct: atr_month_pct × 기간계수(1w=0.5, 1m=1, 3m=1.7, 6m=2.4)의 0.5~1.5배 범위 내 양수
- stop_loss_pct: 음수, 절댓값은 upside_pct의 40~70% (손익비 ≥ 1.4)
- confidence: 0-100. 뉴스 연결 강도 × 데이터 정합성. 관성적으로 70을 주지 말 것 — 근거가 평범하면 50대
- ret_1m < -10 이고 above_sma50=false인 종목은 반드시 exclude
- price_data가 null인 종목은 확신이 매우 높지 않으면 exclude
- 모든 후보에 대해 decisions에 하나씩 반드시 응답할 것`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('decideTrades: JSON not found');
  const parsed = parseJsonSafe(jsonMatch[0]);

  const map = {};
  for (const d of parsed.decisions || []) {
    if (d?.ticker) map[d.ticker.toUpperCase()] = d;
  }
  return map;
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
  // 전략적 투자 노출 컨텍스트: 이슈의 섹터·제목·요약에서 키워드 뽑아 관련 상장사 후보 제시
  let strategicCtx = '';
  try {
    const mod = await import('../lib/strategic-investments.js');
    // 이슈에서 테마 키워드 후보 추출
    const haystack = `${issue.title || ''} ${issue.summary || ''} ${(issue.sectors || []).join(' ')}`.toLowerCase();
    const THEME_KEYWORDS = [
      // AI / LLM
      'ai', '인공지능', 'llm', 'gpt', 'claude', 'anthropic', 'openai', 'gemini', 'grok', 'mistral', 'cohere', 'agentforce', 'copilot',
      // 반도체
      '반도체', 'hbm', 'gpu', '메모리', '파운드리', 'asic', 'tpu',
      // 로봇 / 자율주행
      '로봇', '휴머노이드', 'boston dynamics', 'optimus', '자율주행', 'waymo', 'robotaxi', '로보택시', 'fsd',
      // 우주 / 위성 / UAM
      '우주', '위성', 'spacex', 'starlink', 'kuiper', '로켓', 'rocket lab', 'uam', 'evtol',
      // 방산
      '방산', '국방', '미사일', '전투기', '전차', 'k2 흑표', 'k9', 'f-35', 'patriot', 'thaad', '천궁',
      // 바이오 / 제약 / GLP-1
      '바이오', 'cdmo', '의약품', '제약', 'mrna', 'glp-1', 'glp1', '비만치료', 'wegovy', 'ozempic', 'mounjaro', '항암제', '알츠하이머', 'fda', '신약', '바이오시밀러',
      // EV / 배터리 / 에너지
      'ev', '전기차', '배터리', 'ess', '전고체', '리튬',
      // 원자력
      '원자력', 'smr', '데이터센터', '원전', '핵발전',
      // 재생에너지
      '재생에너지', '태양광', '풍력', '수소', '암모니아',
      // 클라우드 / SaaS / 데이터
      '클라우드', 'saas', 'aws', 'azure', 'oci', '데이터 플랫폼', 'snowflake', 'databricks',
      // XR / 메타버스
      'xr', 'vr', 'ar', '메타버스',
      // 핀테크 / 결제 / 암호화폐
      '핀테크', '결제', '암호화폐', '비트코인', 'btc', 'crypto', 'stablecoin', '스테이블코인', 'etf',
      // 게임
      '게임', 'mmorpg', 'pubg', '인조이', '나혼렙', '엔씨', '크래프톤', '넷마블',
      // 콘텐츠 / 엔터 / K-팝
      'k-팝', 'k팝', 'kpop', 'bts', 'blackpink', 'newjeans', '하이브', '스트리밍', 'netflix', 'disney',
      // 이커머스 / 플랫폼
      '이커머스', '쿠팡', 'coupang', 'shopify', 'amazon', '물류',
      // K-뷰티 / 소비재
      'k-뷰티', 'k뷰티', '화장품', '아모레', '코스맥스',
    ];
    const matched = THEME_KEYWORDS.filter(k => haystack.includes(k));
    if (matched.length) {
      // 하드코딩 + DB 자동누적 항목 병합
      const formatted = await mod.formatMergedThemeBetsForPrompt(supabase, matched, 16);
      if (formatted) strategicCtx = `\n\n🎯 ${formatted}\n주의: 위 상장사들 중 뉴스 테마와 정말 부합하는 곳은 적극 포함시키되, "지분 보유 → 선반영" 논리는 rationale에 명시할 것. [AI추출] 태그는 자동 누적된 것이라 더 보수적으로 검증. 단순 나열 금지.`;
    }
  } catch {}

  const prompt = `당신은 글로벌 주식시장 리서치 애널리스트입니다. 다음 뉴스/이슈의 파급효과와 수혜 후보 기업을 찾아주세요.
(주의: 지금은 "후보 발굴" 단계입니다. 매매 수치(목표가·손절가)는 이후 실제 시장 데이터를 보고 별도 단계에서 결정하므로 여기서 만들지 마세요.)

이슈 제목: ${issue.title}
요약: ${issue.summary || '없음'}
관련 섹터: ${issue.sectors?.join(', ') || '미분류'}${strategicCtx}

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
          "rationale": "이 기업이 수혜를 받는 구체적 이유 — catalyst(뉴스)가 이 기업의 매출/이익에 닿는 경로(mechanism)를 명시"
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
- 하락이 예상되는 종목은 companies에 넣지 말 것 (impact:negative 섹터는 companies를 비워둘 것)
- rationale에 3차 이상 간접 연결(뉴스→A→B→이 기업)은 금지. 최대 2차 파급까지만.

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

⭐ 전략적 투자/지분 기반 간접 수혜 (선반영 논리) — 반도체에만 국한되지 말 것:
- 본업이 다른 분야인데 해당 테마에 전략적 지분/사업을 보유한 경우 적극 발굴
  [AI]   SK텔레콤 → Anthropic 투자 → Claude 성공 시 선반영
         알파벳·아마존 → Anthropic 투자 → Claude 매출 직접 수혜
         마이크로소프트 → OpenAI → GPT/Sora 성장 시 수혜
         Salesforce → Agentforce (엔터프라이즈 AI 에이전트)
  [로봇] 현대차 → Boston Dynamics 80% → 휴머노이드 테마 수혜
         삼성전자 → Rainbow Robotics 15% → 산업/서비스 로봇
  [우주] 한화에어로스페이스 → 한화시스템 위성 → 저궤도 위성통신
         RKLB → Neutron 로켓 → SpaceX 대안
  [방산] 한화에어로/KAI/현대로템 → 폴란드·UAE 수주 → 지정학 리스크 시 선반영
  [원전] 두산에너빌리티 → NuScale SMR 주기기 → AI 데이터센터 전력 테마
         CEG·VST → MS·AWS 원전 PPA → AI 인프라 전력 공급
  [비만/GLP-1] LLY/NVO → 비만치료제 글로벌 시장 / 한미약품 → MSD GLP-1 라이선스
  [바이오] 셀트리온 → 미국 직판 / 알테오젠 → 키트루다 SC 변경 기술
  [K-팝/콘텐츠] 하이브·SM·JYP·YG → 글로벌 팬덤 + 북미 진출
  [핀테크] 코인베이스 → BTC ETF 커스터디 / MELI → 라틴 결제
  [K-뷰티] 아모레·한국콜마 → 미국 Amazon/Sephora 직판
  [게임] 엔씨 TL → 아마존 글로벌 퍼블리싱 / 크래프톤 인조이 → 생성형 AI 게임
- 이런 종목은 rationale에 "OO에 지분 보유 → 선반영" 논리를 한 줄로 명시
- 위 컨텍스트에 ⭐ 표시된 항목은 가장 강한 연결고리. 우선 검토

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

  // DB 캐시 확인 (24h 이내면 FMP 호출 안 함)
  try {
    const { data } = await supabase
      .from('companies')
      .select('fundamentals, fundamentals_updated_at')
      .eq('ticker', ticker)
      .maybeSingle();
    if (data?.fundamentals && data?.fundamentals_updated_at) {
      const age = Date.now() - new Date(data.fundamentals_updated_at).getTime();
      if (age < 24 * 3600 * 1000) {
        const f = data.fundamentals;
        // 캐시된 데이터에서 필요한 필드만 추출 반환
        return {
          pe: f.pe, pb: f.pb,
          roe: f.roe, operatingMargin: f.operatingMargin,
          debtToEquity: f.debtToEquity, currentRatio: f.currentRatio,
          revenueGrowthYoY: f.revenueGrowthYoY,
          netIncomeGrowthYoY: f.netIncomeGrowthYoY,
        };
      }
    }
  } catch {}

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
