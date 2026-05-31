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

  // ─── 바이오/제약 ───────────────────────────────────────────
  'LLY': {
    name: 'Eli Lilly (일라이 릴리)',
    bets: [
      { target: 'Mounjaro/Zepbound (GLP-1 비만치료제)', theme: '바이오·비만치료', detail: '글로벌 비만시장 폭발 — 시가총액 $700B+ 의약 빅테크화', highlight: true },
      { target: 'Donanemab',          theme: '알츠하이머',     detail: 'FDA 승인 알츠하이머 항체치료' },
    ],
  },
  'NVO': {
    name: 'Novo Nordisk (노보 노디스크)',
    bets: [
      { target: 'Ozempic/Wegovy (GLP-1)', theme: '바이오·비만치료', detail: 'GLP-1 시장 점유 + 차세대 경구용 개발', highlight: true },
    ],
  },
  'MRNA': {
    name: 'Moderna (모더나)',
    bets: [
      { target: 'mRNA 백신 플랫폼',     theme: '바이오·mRNA',  detail: '암 백신·독감·HIV 등 mRNA 응용 확장', highlight: true },
    ],
  },
  'JNJ': {
    name: 'Johnson & Johnson (J&J)',
    bets: [
      { target: 'Janssen 신약 파이프라인', theme: '바이오·항암제', detail: '다발성 골수종·암 치료제 다수' },
      { target: '의료기기',            theme: '의료기기',       detail: 'Auris 로봇수술 — Ethicon 통합' },
    ],
  },
  '068270.KS': {
    name: '셀트리온',
    bets: [
      { target: '바이오시밀러',         theme: '바이오시밀러',   detail: '램시마·트룩시마·허쥬마 글로벌 점유', highlight: true },
      { target: '짐펜트라 (램시마SC)',  theme: '신약',          detail: '미국 직판 — 신약 분류로 가격 프리미엄' },
    ],
  },
  '128940.KS': {
    name: '한미약품',
    bets: [
      { target: 'GLP-1 비만치료제',     theme: '바이오·비만치료', detail: 'MSD 라이선스 — 차세대 GLP-1 후보물질' },
    ],
  },
  '196170.KQ': {
    name: '알테오젠',
    bets: [
      { target: 'Hybrozyme (ALT-B4)',  theme: '바이오·플랫폼',  detail: 'MSD 키트루다 SC 제형 변경 기술 라이선스', highlight: true },
    ],
  },
  '326030.KS': {
    name: 'SK바이오팜',
    bets: [
      { target: 'Cenobamate (엑스코프리)', theme: '신약·뇌전증', detail: 'FDA 승인 — 미국 직판 매출 성장' },
    ],
  },

  // ─── 우주·위성·방산 ───────────────────────────────────────
  'RKLB': {
    name: 'Rocket Lab (로켓랩)',
    bets: [
      { target: 'Electron/Neutron 로켓', theme: '우주·발사체', detail: '소형 위성 발사 2위 + 중형 Neutron 개발 중', highlight: true },
    ],
  },
  'ASTS': {
    name: 'AST SpaceMobile',
    bets: [
      { target: 'BlueBird 위성망',      theme: '위성통신',      detail: '스마트폰 직접 위성통신 — Verizon·AT&T 협력', highlight: true },
    ],
  },
  'IRDM': {
    name: 'Iridium Communications',
    bets: [
      { target: 'L-band 위성망',       theme: '위성통신',      detail: '글로벌 IoT·항공·해운 위성통신 인프라' },
    ],
  },
  'LMT': {
    name: 'Lockheed Martin',
    bets: [
      { target: 'F-35 스텔스 / THAAD', theme: '방산',         detail: '미국 최대 방산 — AI 자율무기 통합' },
    ],
  },
  'RTX': {
    name: 'RTX (Raytheon)',
    bets: [
      { target: 'Patriot 미사일 / GPS',theme: '방산',         detail: '미사일 방어·우주 시스템' },
    ],
  },
  '012450.KS': {
    name: '한화에어로스페이스',
    bets: [
      { target: 'K9 자주포 / 천궁 방공망', theme: '방산',      detail: '폴란드·UAE 대형 수주 — K-방산 대표주', highlight: true },
      { target: '한화시스템 (위성)',     theme: '우주',         detail: '저궤도 위성 자체 발사 계획' },
    ],
  },
  '047810.KS': {
    name: '한국항공우주산업 (KAI)',
    bets: [
      { target: 'FA-50 / KF-21',      theme: '방산·항공',     detail: '경전투기 수출 — 동남아·동유럽', highlight: true },
    ],
  },
  '079550.KS': {
    name: 'LIG넥스원',
    bets: [
      { target: '천궁-II / 현궁',      theme: '방산·미사일',   detail: '대공·대전차 미사일 — UAE·사우디 수주' },
    ],
  },
  '064350.KS': {
    name: '현대로템',
    bets: [
      { target: 'K2 흑표 전차',        theme: '방산·지상',     detail: '폴란드 K2 전차 1000대 + 2차 계약 기대', highlight: true },
    ],
  },

  // ─── 원자력·에너지 ────────────────────────────────────────
  'CEG': {
    name: 'Constellation Energy',
    bets: [
      { target: '원자력 발전소 운영',    theme: '원자력·AI 전력', detail: 'MS 데이터센터 전용 원전 PPA 체결', highlight: true },
    ],
  },
  'VST': {
    name: 'Vistra Corp',
    bets: [
      { target: '원전 + 가스 발전',     theme: '원자력·AI 전력', detail: 'AI 데이터센터향 전력 PPA 다수' },
    ],
  },
  'BWXT': {
    name: 'BWX Technologies',
    bets: [
      { target: 'SMR 원자로',          theme: 'SMR',          detail: '미 해군 잠수함 원자로 + 민수 SMR 개발', highlight: true },
    ],
  },
  '034020.KS': {
    name: '두산에너빌리티',
    bets: [
      { target: 'SMR 주기기 / 대형 원전', theme: 'SMR·원자력',  detail: 'NuScale SMR 주기기 공급 + 체코 원전 수주', highlight: true },
    ],
  },
  '009830.KS': {
    name: '한화솔루션',
    bets: [
      { target: 'Q CELLS (태양광)',    theme: '재생에너지',     detail: '미국 IRA 수혜 — 조지아 솔라셀 공장' },
    ],
  },

  // ─── 배터리·EV (반도체 외) ────────────────────────────────
  '006400.KS': {
    name: '삼성SDI',
    bets: [
      { target: '46파이 원통형 배터리', theme: 'EV 배터리',     detail: 'BMW·Stellantis JV — 전고체 배터리 R&D', highlight: true },
    ],
  },
  '096770.KS': {
    name: 'SK이노베이션',
    bets: [
      { target: 'SK온 (배터리)',       theme: 'EV 배터리',     detail: '포드·현대차 JV — 북미 4공장' },
    ],
  },

  // ─── 콘텐츠·엔터테인먼트 ──────────────────────────────────
  '352820.KS': {
    name: '하이브',
    bets: [
      { target: 'BTS · NewJeans · Seventeen', theme: 'K-팝 IP', detail: '글로벌 팬덤 플랫폼 Weverse 운영', highlight: true },
    ],
  },
  '041510.KQ': {
    name: 'SM엔터테인먼트',
    bets: [
      { target: 'aespa · NCT · EXO',  theme: 'K-팝 IP',       detail: '카카오 자회사화 — 글로벌 유통 확대' },
    ],
  },
  '035900.KQ': {
    name: 'JYP엔터테인먼트',
    bets: [
      { target: 'Stray Kids · TWICE · ITZY', theme: 'K-팝 IP', detail: '북미 데뷔 그룹 (VCHA) — 트리플 미디어 IP' },
    ],
  },
  '122870.KS': {
    name: '와이지엔터테인먼트',
    bets: [
      { target: 'BLACKPINK',           theme: 'K-팝 IP',       detail: '솔로 활동 활성화 + 신인 그룹 BABYMONSTER' },
    ],
  },
  'NFLX': {
    name: 'Netflix',
    bets: [
      { target: '광고 요금제 + 라이브 스포츠', theme: '스트리밍·광고', detail: 'NFL 크리스마스 · WWE Raw — 광고 매출 폭증', highlight: true },
    ],
  },
  'DIS': {
    name: 'Disney',
    bets: [
      { target: 'Disney+ / Hulu / ESPN', theme: '스트리밍',    detail: 'D2C 흑자 전환 + ESPN 단독 OTT' },
      { target: '테마파크 + IP',        theme: '엔터·IP',       detail: 'Marvel·Star Wars·Pixar' },
    ],
  },

  // ─── 게임 ────────────────────────────────────────────────
  '036570.KS': {
    name: '엔씨소프트',
    bets: [
      { target: 'TL (Throne and Liberty)', theme: '게임·MMORPG', detail: '아마존 게임즈 글로벌 퍼블리싱 — 신성장 동력', highlight: true },
    ],
  },
  '259960.KS': {
    name: '크래프톤',
    bets: [
      { target: 'PUBG · 인조이 (Life Sim)', theme: '게임·AI', detail: '생성형 AI 기반 라이프 시뮬레이션 신작', highlight: true },
    ],
  },
  '251270.KS': {
    name: '넷마블',
    bets: [
      { target: '나혼렙 ARISE',        theme: '게임·IP',       detail: '한국 웹툰 IP 글로벌 1위 — 미국·일본 흥행' },
    ],
  },

  // ─── 핀테크·결제 ──────────────────────────────────────────
  'V': {
    name: 'Visa',
    bets: [
      { target: 'Visa Direct (실시간 송금)', theme: '핀테크·결제', detail: 'B2B·해외송금 디지털화 — Crypto 결제 통합' },
    ],
  },
  'COIN': {
    name: 'Coinbase',
    bets: [
      { target: 'BTC ETF 커스터디',    theme: '암호화폐',      detail: 'iShares·Fidelity 등 대부분 BTC 현물 ETF 수탁', highlight: true },
    ],
  },
  '323410.KS': {
    name: '카카오뱅크',
    bets: [
      { target: '국내 1위 인터넷전문은행', theme: '핀테크',      detail: '카카오 생태계 락인 — 청년·MZ 점유율' },
    ],
  },

  // ─── 이커머스·플랫폼 ──────────────────────────────────────
  'CPNG': {
    name: 'Coupang',
    bets: [
      { target: '로켓배송 / Coupang Eats',theme: '이커머스·물류',detail: '한국 1위 + 대만 시장 진출 흑자' },
      { target: 'Farfetch',           theme: '명품 이커머스',  detail: '인수 — 글로벌 럭셔리 플랫폼' },
    ],
  },
  'SHOP': {
    name: 'Shopify',
    bets: [
      { target: 'Shop Pay + AI Sidekick', theme: 'AI·이커머스', detail: '머천트용 AI 어시스턴트 — GMV 가속화' },
    ],
  },
  'MELI': {
    name: 'MercadoLibre',
    bets: [
      { target: 'Mercado Pago',        theme: '핀테크',         detail: '라틴아메리카 1위 결제 + 신용 플랫폼', highlight: true },
    ],
  },

  // ─── 클라우드·SaaS·AI 응용 ────────────────────────────────
  'CRM': {
    name: 'Salesforce',
    bets: [
      { target: 'Agentforce (AI 에이전트)', theme: 'AI 응용',  detail: '엔터프라이즈 AI 에이전트 플랫폼 1위 후보', highlight: true },
    ],
  },
  'SNOW': {
    name: 'Snowflake',
    bets: [
      { target: 'Cortex AI / Data Cloud', theme: 'AI·데이터',  detail: '기업 데이터에 LLM 직접 결합' },
    ],
  },
  'PLTR': {
    name: 'Palantir',
    bets: [
      { target: 'AIP (AI Platform)',  theme: 'AI 응용·국방',  detail: 'AI 의사결정 플랫폼 — 미군·NATO 다수 수주', highlight: true },
    ],
  },
  'NOW': {
    name: 'ServiceNow',
    bets: [
      { target: 'Now Assist (AI)',    theme: 'AI 응용',       detail: '워크플로우 자동화 AI — 엔터프라이즈 IT 표준' },
    ],
  },

  // ─── 화장품·소비재 (K-뷰티) ───────────────────────────────
  '090430.KS': {
    name: '아모레퍼시픽',
    bets: [
      { target: 'Cosrx · 라네즈 미국 성장', theme: 'K-뷰티',    detail: 'Amazon·Sephora 직판 — 미국 매출 급증' },
    ],
  },
  '161890.KS': {
    name: '한국콜마',
    bets: [
      { target: 'OEM/ODM 글로벌',     theme: '뷰티 OEM',      detail: '인디 K-뷰티 브랜드 폭증의 수혜', highlight: true },
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
 * Supabase에서 자동 추출된 전략 투자 항목 조회 (티커 기준)
 * @param {object} supabase - Supabase client
 * @param {string} ticker
 * @returns {Promise<Array<{target, theme, detail, highlight, stake_info, seen_count}>>}
 */
export async function getDbBets(supabase, ticker) {
  if (!supabase || !ticker) return [];
  try {
    const { data, error } = await supabase
      .from('strategic_investments')
      .select('target_name, theme, detail, highlight, stake_info, seen_count, confidence')
      .eq('investor_ticker', ticker)
      .eq('status', 'active')
      .order('highlight', { ascending: false })
      .order('seen_count', { ascending: false })
      .limit(10);
    if (error) return [];
    return (data || []).map(d => ({
      target: d.target_name,
      theme: d.theme,
      detail: d.stake_info ? `${d.detail} (${d.stake_info})` : d.detail,
      highlight: d.highlight,
      _fromDb: true,
      _confidence: d.confidence,
      _seenCount: d.seen_count,
    }));
  } catch { return []; }
}

/**
 * 하드코딩 + DB 항목 합쳐서 프롬프트용 텍스트 생성
 * 중복은 target 기준 dedupe (하드코딩 우선)
 */
export async function formatMergedBetsForPrompt(supabase, ticker) {
  const hardcoded = getStrategicBets(ticker);
  const dbBets = await getDbBets(supabase, ticker);
  const hardcodedTargets = new Set((hardcoded?.bets || []).map(b => b.target.toLowerCase()));
  const merged = [
    ...(hardcoded?.bets || []),
    ...dbBets.filter(b => !hardcodedTargets.has((b.target || '').toLowerCase())),
  ];
  if (!merged.length) return null;
  const name = hardcoded?.name || ticker;
  const lines = merged.map(b => {
    const star = b.highlight ? '⭐ ' : '- ';
    const tag  = b._fromDb ? ' [AI추출]' : '';
    return `${star}${b.target} (${b.theme}): ${b.detail}${tag}`;
  });
  return `${name}의 주요 전략적 투자/사업 노출:\n${lines.join('\n')}`;
}

/**
 * DB에서 특정 테마에 노출된 모든 상장사 조회 (analyze.js용)
 */
export async function getDbCompaniesByTheme(supabase, themes, max = 12) {
  if (!supabase) return [];
  const keys = Array.isArray(themes) ? themes : [themes];
  if (!keys.length) return [];
  try {
    // theme 또는 detail에 키워드 포함 ilike OR 조건
    const orClause = keys
      .slice(0, 8)  // 너무 많으면 쿼리 길어짐
      .flatMap(k => [`theme.ilike.%${k}%`, `detail.ilike.%${k}%`, `target_name.ilike.%${k}%`])
      .join(',');
    const { data } = await supabase
      .from('strategic_investments')
      .select('investor_ticker, investor_name, target_name, theme, detail, stake_info, highlight, seen_count')
      .eq('status', 'active')
      .or(orClause)
      .order('highlight', { ascending: false })
      .order('seen_count', { ascending: false })
      .limit(max);
    return (data || []).map(d => ({
      ticker: d.investor_ticker,
      name:   d.investor_name || d.investor_ticker,
      bet: {
        target:    d.target_name,
        theme:     d.theme,
        detail:    d.stake_info ? `${d.detail} (${d.stake_info})` : d.detail,
        highlight: d.highlight,
      },
      _fromDb: true,
    }));
  } catch { return []; }
}

/**
 * 하드코딩 + DB 항목 합친 테마 검색 (analyze.js 뉴스 분석용)
 */
export async function formatMergedThemeBetsForPrompt(supabase, themes, max = 16) {
  const hardcoded = getCompaniesByTheme(themes);
  const dbMatches = await getDbCompaniesByTheme(supabase, themes, max);
  const seen = new Set(hardcoded.map(m => `${m.ticker}|${m.bet.target}`.toLowerCase()));
  const merged = [
    ...hardcoded,
    ...dbMatches.filter(m => !seen.has(`${m.ticker}|${m.bet.target}`.toLowerCase())),
  ].slice(0, max);
  if (!merged.length) return null;
  const lines = merged.map(m => {
    const tag = m._fromDb ? ' [AI추출]' : '';
    return `- ${m.ticker} (${m.name}): ${m.bet.target} — ${m.bet.detail}${tag}`;
  });
  return `이 테마에 전략적으로 노출된 상장사 (참고용):\n${lines.join('\n')}`;
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
