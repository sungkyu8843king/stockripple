/**
 * 전략적 투자/지분 데이터베이스
 * 기업이 보유한 주요 전략적 투자/지분 — 본업 외 미래 성장축에 미리 베팅한 자산
 *
 * 사용처:
 *  - api/analyze.js: 뉴스 이슈 분석 시 "이 섹터 테마면 어떤 상장사가 지분을 통해 간접 수혜를 받는가" 컨텍스트
 *  - api/admin.js?action=summary: 종목 상세 페이지의 종합 분석에서 "전략적 노출" 섹션 생성
 *
 * 데이터는 공개된 사실 기반 (지분율은 분기 변동 가능). 추가/수정 시 출처 확인 필수.
 */

export const STRATEGIC_INVESTMENTS = {
  // ─── 한국 ─────────────────────────────────────────────────
  '017670.KS': {
    name: 'SK텔레콤',
    bets: [
      { target: 'Anthropic',           theme: 'AI',           detail: '직접 투자 + 한국 내 Claude 엔터프라이즈 독점 파트너십', highlight: true },
      { target: 'SK브로드밴드 5G AI 인프라', theme: 'AI 인프라',     detail: '엣지 컴퓨팅·AI 데이터센터 자체 구축' },
      { target: 'Tmap Mobility',       theme: '자율주행',       detail: 'AI 내비게이션·모빌리티 플랫폼' },
    ],
  },
  '005930.KS': {
    name: '삼성전자',
    bets: [
      { target: 'HBM3E/HBM4',          theme: 'AI 메모리',      detail: 'NVIDIA AI 가속기용 HBM 공급망 진입 (SK하이닉스와 경쟁)', highlight: true },
      { target: 'Tenstorrent',         theme: 'AI 반도체',      detail: 'AI 가속기 파운드리 수주' },
      { target: 'Rainbow Robotics',    theme: '휴머노이드 로봇', detail: '약 15% 지분 — 산업용/서비스 로봇' },
      { target: 'Samsung NEXT',        theme: 'AI 스타트업',    detail: '글로벌 AI/딥테크 VC 활동' },
    ],
  },
  '000660.KS': {
    name: 'SK하이닉스',
    bets: [
      { target: 'HBM3E',               theme: 'AI 메모리',      detail: 'NVIDIA H100/H200/B100용 HBM 사실상 독점 공급', highlight: true },
    ],
  },
  '035420.KS': {
    name: 'NAVER',
    bets: [
      { target: 'HyperCLOVA X',        theme: 'AI',           detail: '국내 1위 한국어 거대언어모델 (자체)', highlight: true },
      { target: 'Naver Cloud',         theme: '클라우드',       detail: '국내 SaaS 인프라 1위' },
      { target: 'Wallypapers (글로벌 웹툰)', theme: '콘텐츠 IP', detail: 'AI 콘텐츠 생성 결합' },
    ],
  },
  '035720.KS': {
    name: '카카오',
    bets: [
      { target: 'Kakao Brain (KoGPT/Karlo)', theme: 'AI',     detail: '한국어 멀티모달 모델 자체 개발', highlight: true },
      { target: '카카오모빌리티',           theme: '자율주행',    detail: '국내 1위 택시 호출 플랫폼' },
    ],
  },
  '005380.KS': {
    name: '현대차',
    bets: [
      { target: 'Boston Dynamics',     theme: '휴머노이드 로봇', detail: '~80% 지분 — Atlas/Spot 로봇 글로벌 1위', highlight: true },
      { target: 'Motional (Aptiv JV)', theme: '자율주행',       detail: '50% 지분 — 레벨4 로보택시' },
      { target: 'Supernal',            theme: 'UAM 도심항공',   detail: '자회사 — e-VTOL 항공기 개발' },
    ],
  },
  '015760.KS': {
    name: '한국전력',
    bets: [
      { target: 'SMR (소형모듈원전)',   theme: '원자력·AI 전력',  detail: 'AI 데이터센터 전력수요 폭증 대응', highlight: true },
    ],
  },
  '207940.KS': {
    name: '삼성바이오로직스',
    bets: [
      { target: 'CDMO 글로벌 1위',      theme: '바이오 위탁생산', detail: '항체의약품·세포치료제 위탁생산', highlight: true },
    ],
  },
  '105560.KS': {
    name: 'KB금융',
    bets: [
      { target: 'Liiv M (디지털금융)',   theme: '핀테크',         detail: '국내 1위 디지털 뱅킹 플랫폼' },
    ],
  },
  '055550.KS': {
    name: '신한지주',
    bets: [
      { target: '신한AI',             theme: 'AI 금융',        detail: 'AI 기반 자산관리/리스크 분석' },
    ],
  },
  '042700.KS': {
    name: '한미반도체',
    bets: [
      { target: 'HBM TC 본더',        theme: 'AI 메모리 장비',  detail: 'HBM 본딩 장비 글로벌 점유율 70%+', highlight: true },
    ],
  },
  '373220.KS': {
    name: 'LG에너지솔루션',
    bets: [
      { target: 'ESS (에너지저장장치)', theme: 'AI 데이터센터 전력', detail: '대규모 AI 인프라용 ESS 공급' },
      { target: '북미 EV 배터리',     theme: 'EV',             detail: 'GM/Stellantis JV 다수' },
    ],
  },

  // ─── 미국 ─────────────────────────────────────────────────
  'GOOGL': {
    name: 'Alphabet (구글)',
    bets: [
      { target: 'Anthropic',           theme: 'AI',          detail: '$3B+ 투자 — Claude의 최대 외부 투자자 중 하나', highlight: true },
      { target: 'DeepMind / Gemini',   theme: 'AI',          detail: '자체 LLM 개발' },
      { target: 'Waymo',               theme: '자율주행',     detail: '자회사 — 로보택시 상용화 1위' },
      { target: 'Verily, X Lab',       theme: '바이오/딥테크', detail: '장기 R&D 옵션' },
    ],
  },
  'AMZN': {
    name: 'Amazon (아마존)',
    bets: [
      { target: 'Anthropic',           theme: 'AI',          detail: '$8B 투자 — Claude 최대 외부 투자자, AWS Bedrock 독점 효과', highlight: true },
      { target: 'Project Kuiper',      theme: '우주·위성통신', detail: 'Starlink 경쟁 저궤도 위성망' },
      { target: 'Rivian',              theme: 'EV',          detail: '~16% 지분 — 전기 배달트럭' },
      { target: 'Zoox',                theme: '자율주행',     detail: '자회사 — 로보택시' },
    ],
  },
  'MSFT': {
    name: 'Microsoft (마이크로소프트)',
    bets: [
      { target: 'OpenAI',              theme: 'AI',          detail: '$13B+ — GPT/ChatGPT/Sora 최대 투자자', highlight: true },
      { target: 'GitHub Copilot',      theme: 'AI 개발도구',  detail: '자회사 — 개발자 생산성 도구 1위' },
      { target: 'Mistral AI',          theme: 'AI',          detail: '유럽 LLM 파트너십' },
    ],
  },
  'NVDA': {
    name: 'NVIDIA (엔비디아)',
    bets: [
      { target: 'AI GPU H100/B100',    theme: 'AI 가속기',    detail: '글로벌 AI 학습용 GPU 90%+ 점유', highlight: true },
      { target: 'CoreWeave',           theme: 'AI 클라우드',  detail: '소수 지분 + 우선 GPU 할당' },
      { target: 'Cohere, Mistral, Recursion 등', theme: 'AI 응용', detail: 'AI 생태계 다수 투자' },
    ],
  },
  'TSLA': {
    name: 'Tesla (테슬라)',
    bets: [
      { target: 'xAI',                 theme: 'AI',          detail: '머스크 보유 — Grok 모델, Tesla 차량 연동 잠재', highlight: true },
      { target: 'Optimus',             theme: '휴머노이드 로봇', detail: '자체 R&D — 인간형 로봇 양산 계획' },
      { target: 'Dojo',                theme: 'AI 인프라',    detail: 'FSD 학습용 자체 슈퍼컴 칩' },
      { target: 'Energy / Powerwall',  theme: 'ESS',         detail: 'AI 데이터센터 전력 솔루션' },
    ],
  },
  'META': {
    name: 'Meta (메타)',
    bets: [
      { target: 'LLaMA',               theme: 'AI',          detail: '오픈소스 LLM 1위 (자체)', highlight: true },
      { target: 'Reality Labs',        theme: 'XR/메타버스',  detail: 'Quest VR + AR 안경 (Orion)' },
    ],
  },
  'AAPL': {
    name: 'Apple (애플)',
    bets: [
      { target: 'Apple Intelligence',  theme: 'AI',          detail: '온디바이스 AI — iPhone/Mac 통합 (자체)', highlight: true },
    ],
  },
  'ORCL': {
    name: 'Oracle (오라클)',
    bets: [
      { target: 'OCI (Cloud Infra)',   theme: 'AI 클라우드',  detail: 'OpenAI 슈퍼컴퓨터 인프라 공급 계약', highlight: true },
    ],
  },
  'AVGO': {
    name: 'Broadcom (브로드컴)',
    bets: [
      { target: 'AI 가속기 ASIC',       theme: 'AI 반도체',    detail: 'Google TPU, Meta MTIA 등 빅테크 커스텀 칩 위탁설계', highlight: true },
    ],
  },
};

/**
 * 특정 티커의 전략적 투자 정보 반환
 * @param {string} ticker - "017670.KS" 또는 "GOOGL" 형식
 * @returns {{name, bets} | null}
 */
export function getStrategicBets(ticker) {
  if (!ticker) return null;
  return STRATEGIC_INVESTMENTS[ticker] || STRATEGIC_INVESTMENTS[ticker.toUpperCase()] || null;
}

/**
 * 특정 테마/섹터에 노출된 모든 상장사 반환
 *  - 키워드 매칭: theme 또는 detail에 포함되면 매칭
 *  - 예: getCompaniesByTheme('AI') → SK텔레콤/Alphabet/Amazon/MSFT/Tesla 등
 * @param {string|string[]} themes - "AI" 또는 ["AI","로봇"] 등
 * @returns {Array<{ticker, name, bet}>}
 */
export function getCompaniesByTheme(themes) {
  const keys = Array.isArray(themes) ? themes : [themes];
  if (!keys.length) return [];
  const out = [];
  for (const [ticker, info] of Object.entries(STRATEGIC_INVESTMENTS)) {
    for (const bet of info.bets) {
      const hay = `${bet.theme} ${bet.detail} ${bet.target}`.toLowerCase();
      if (keys.some(k => hay.includes(k.toLowerCase()))) {
        out.push({ ticker, name: info.name, bet });
        break;  // 한 회사당 한 번만
      }
    }
  }
  return out;
}

/**
 * 프롬프트 주입용 컴팩트 텍스트 (회사 1곳 기준)
 */
export function formatBetsForPrompt(ticker) {
  const info = getStrategicBets(ticker);
  if (!info) return null;
  const lines = info.bets.map(b => {
    const star = b.highlight ? '⭐ ' : '- ';
    return `${star}${b.target} (${b.theme}): ${b.detail}`;
  });
  return `${info.name}의 주요 전략적 투자/사업 노출:\n${lines.join('\n')}`;
}

/**
 * 프롬프트 주입용 컴팩트 텍스트 (테마 기준 — 뉴스 분석 시)
 */
export function formatThemeBetsForPrompt(themes, max = 12) {
  const matches = getCompaniesByTheme(themes).slice(0, max);
  if (!matches.length) return null;
  const lines = matches.map(m => `- ${m.ticker} (${m.name}): ${m.bet.target} — ${m.bet.detail}`);
  return `이 테마에 전략적으로 노출된 상장사 (참고용):\n${lines.join('\n')}`;
}
