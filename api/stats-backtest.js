/**
 * stats-backtest.js
 * 전체 예측 통계 + 백테스트 결과 집계.
 * 인증 필요 (admin).
 *
 * GET /api/stats-backtest
 * Response:
 *   {
 *     ok: true,
 *     overall: { total, verified1d, verified7d, verified30d, accuracy1d, accuracy7d, accuracy30d },
 *     byConfidence: [ { bucket, total, accuracy7d, avgActualReturn7d } ],
 *     bySector: [ { sector, total, accuracy7d, avgActualReturn7d } ],
 *     backtest: {
 *       totalTrades, winRate, avgReturn, bestTrade, worstTrade,
 *       cumulativeReturn,    // 누적 수익률 (모든 거래 동일 비중)
 *       byPeriod: { 1d: {...}, 7d: {...}, 30d: {...} },
 *       topWinners: [ { ticker, name, return } ],
 *       topLosers:  [ { ticker, name, return } ],
 *     },
 *     timeline: [ { date, avgReturn7d } ]   // 일자별 7일 수익률 평균
 *   }
 */
import { createClient } from '@supabase/supabase-js';
import { verifyAdmin } from '../lib/auth.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  const _a = await verifyAdmin(req.headers.authorization);
  if (!_a.ok) return res.status(401).json({ error: _a.error });

  try {
    // 모든 검증된 분석 데이터 가져오기
    const { data, error } = await supabase
      .from('analysis_companies')
      .select(`
        upside_pct, confidence, ripple_sector, entry_date, entry_price,
        is_accurate_1d, actual_return_1d,
        is_accurate_7d, actual_return_7d,
        is_accurate_30d, actual_return_30d,
        companies(ticker, name_ko, market)
      `)
      .limit(5000);
    if (error) return res.status(500).json({ error: error.message });

    const rows = data || [];
    if (!rows.length) return res.status(200).json({ ok: true, empty: true });

    // ── 전체 통계 ──────────────────────────────
    const overall = {
      total: rows.length,
      verified1d:  rows.filter(r => r.is_accurate_1d  != null).length,
      verified7d:  rows.filter(r => r.is_accurate_7d  != null).length,
      verified30d: rows.filter(r => r.is_accurate_30d != null).length,
    };
    overall.accuracy1d  = accuracyOf(rows, '1d',  0.3);
    overall.accuracy7d  = accuracyOf(rows, '7d',  1.5);
    overall.accuracy30d = accuracyOf(rows, '30d', 3.0);

    // ── 신뢰도 버킷별 정확도 ───────────────────
    const buckets = [
      { label: '0-40',  min: 0,  max: 40 },
      { label: '40-60', min: 40, max: 60 },
      { label: '60-80', min: 60, max: 80 },
      { label: '80-100', min: 80, max: 101 },
    ];
    const byConfidence = buckets.map(b => {
      const bucket = rows.filter(r => (r.confidence || 0) >= b.min && (r.confidence || 0) < b.max);
      return {
        bucket: b.label,
        total: bucket.length,
        accuracy7d: accuracyOf(bucket, '7d', 1.5),
        avgActualReturn7d: avgReturn(bucket, '7d'),
        avgUpside: avg(bucket.map(r => r.upside_pct)),
      };
    });

    // ── 섹터별 정확도 ───────────────────────────
    const sectorMap = {};
    for (const r of rows) {
      const s = r.ripple_sector || '미분류';
      if (!sectorMap[s]) sectorMap[s] = [];
      sectorMap[s].push(r);
    }
    const bySector = Object.entries(sectorMap)
      .filter(([, arr]) => arr.length >= 3)
      .map(([sector, arr]) => ({
        sector,
        total: arr.length,
        accuracy7d: accuracyOf(arr, '7d', 1.5),
        avgActualReturn7d: avgReturn(arr, '7d'),
        avgUpside: avg(arr.map(r => r.upside_pct)),
      }))
      .sort((a, b) => (b.accuracy7d || 0) - (a.accuracy7d || 0))
      .slice(0, 15);

    // ── 백테스트 ────────────────────────────────
    const verified7d = rows.filter(r => r.actual_return_7d != null && r.entry_price != null);
    const winners    = verified7d.filter(r => r.actual_return_7d > 0);

    // 종목별 누적 (티커당 한 줄로 통합)
    const byTickerMap = {};
    for (const r of verified7d) {
      const t = r.companies?.ticker;
      if (!t) continue;
      if (!byTickerMap[t]) byTickerMap[t] = { ticker: t, name: r.companies?.name_ko || t, market: r.companies?.market || 'US', returns: [] };
      byTickerMap[t].returns.push(r.actual_return_7d);
    }
    const byTicker = Object.values(byTickerMap).map(t => ({
      ...t,
      n: t.returns.length,
      avg: avg(t.returns),
      total: t.returns.reduce((s, v) => s + v, 0),
    }));
    const topWinners = [...byTicker].sort((a, b) => b.total - a.total).slice(0, 10);
    const topLosers  = [...byTicker].sort((a, b) => a.total - b.total).slice(0, 10);

    const backtest = {
      totalTrades: verified7d.length,
      winRate:     verified7d.length ? Math.round(winners.length / verified7d.length * 100) : 0,
      avgReturn:   avg(verified7d.map(r => r.actual_return_7d)),
      bestTrade:   verified7d.length ? Math.max(...verified7d.map(r => r.actual_return_7d)) : 0,
      worstTrade:  verified7d.length ? Math.min(...verified7d.map(r => r.actual_return_7d)) : 0,
      cumulativeReturn: verified7d.reduce((s, r) => s + r.actual_return_7d, 0),
      byPeriod: {
        '1d':  periodStats(rows, '1d',  0.3),
        '7d':  periodStats(rows, '7d',  1.5),
        '30d': periodStats(rows, '30d', 3.0),
      },
      topWinners,
      topLosers,
    };

    // ── 일자별 평균 수익률 (시계열) ────────────
    const byDateMap = {};
    for (const r of verified7d) {
      const d = (r.entry_date || '').split('T')[0];
      if (!d) continue;
      if (!byDateMap[d]) byDateMap[d] = [];
      byDateMap[d].push(r.actual_return_7d);
    }
    const timeline = Object.entries(byDateMap)
      .map(([date, arr]) => ({ date, count: arr.length, avgReturn7d: avg(arr) }))
      .filter(d => d.count >= 2)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-60);  // 최근 60일

    return res.status(200).json({
      ok: true,
      overall,
      byConfidence,
      bySector,
      backtest,
      timeline,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function accuracyOf(rows, period, minAbs) {
  const accKey = `is_accurate_${period}`;
  const retKey = `actual_return_${period}`;
  const verified = rows.filter(r => r[accKey] != null);
  if (!verified.length) return null;
  const hits = verified.filter(r => r[accKey] === true && Math.abs(r[retKey] || 0) >= minAbs);
  return Math.round(hits.length / verified.length * 100);
}
function avgReturn(rows, period) {
  const retKey = `actual_return_${period}`;
  const values = rows.map(r => r[retKey]).filter(v => v != null);
  if (!values.length) return null;
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length * 100) / 100;
}
function avg(arr) {
  const filtered = arr.filter(v => v != null);
  if (!filtered.length) return null;
  return Math.round(filtered.reduce((s, v) => s + v, 0) / filtered.length * 100) / 100;
}
function periodStats(rows, period, minAbs) {
  const accKey = `is_accurate_${period}`;
  const retKey = `actual_return_${period}`;
  const verified = rows.filter(r => r[accKey] != null);
  if (!verified.length) return { verified: 0, accuracy: null, avgReturn: null };
  const hits = verified.filter(r => r[accKey] === true && Math.abs(r[retKey] || 0) >= minAbs);
  return {
    verified: verified.length,
    accuracy: Math.round(hits.length / verified.length * 100),
    avgReturn: avg(verified.map(r => r[retKey])),
    winRate:   Math.round(verified.filter(r => r[retKey] > 0).length / verified.length * 100),
  };
}
