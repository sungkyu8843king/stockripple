// Claude 토큰 소비 파이프라인의 on/off 상태 — db/feature-flags.sql 참조.
export const FEATURE_FLAG_DEFS = [
  { key: 'analyze',              label: '이슈 AI 분석 (뉴스 → 투자 아이디어)' },
  { key: 'ai_market_summary',    label: 'AI 시장 종합' },
  { key: 'catalysts',            label: '예정 catalyst AI 추출' },
  { key: 'daily_report',         label: '데일리 리포트 (국장/미장)' },
  { key: 'extract_investments',  label: '전략투자 추출 (DART/SEC 공시)' },
  { key: 'weekly_schedule',      label: '주간 일정 생성' },
  { key: 'company_summary',      label: '회사 AI 종합 분석 (회사 상세페이지)' },
  { key: 'article_digest',       label: '기사 요약 (매수판단 없는 순수 요약)' },
];

// 행이 없으면(마이그레이션 전 또는 조회 실패) 기본 활성화 — 안전장치 부재가 기능 자체를
// 막아버리지 않도록 한다(이 레포의 다른 신선도 가드들과 동일한 fail-open 원칙).
export async function isFeatureEnabled(supabase, key) {
  try {
    const { data } = await supabase.from('feature_flags').select('enabled').eq('key', key).maybeSingle();
    return data?.enabled !== false;
  } catch {
    return true;
  }
}
