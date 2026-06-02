-- 사용자 보유 종목 companies 테이블 등록
-- 검색 + DART 분석 + 히트맵에서 정확히 찾히도록
INSERT INTO companies (ticker, name_ko, name_en, market, sector)
VALUES
  -- 레버리지 ETF
  ('TSLL',  'TSLA 2x롱 ETF',      'Direxion Daily TSLA Bull 2X ETF',        'US', 'ETF'),
  ('NVDL',  'NVDA 2x롱 ETF',      'GraniteShares 2x Long NVDA Daily ETF',   'US', 'ETF'),
  ('NOWL',  'NOW 2x롱 ETF',       'GraniteShares 2x Long ServiceNow ETF',   'US', 'ETF'),
  ('ARMG',  'ARM 2x롱 ETF',       'GraniteShares 2x Long ARM ETF',          'US', 'ETF'),
  -- 개별 종목
  ('SNDK',  '샌디스크',            'SanDisk Corporation',                    'US', '반도체·스토리지'),
  ('NASA',  'NASA ETF',           'Roundhill Space ETF',                    'US', 'ETF'),
  ('QUBT',  '퀀텀컴퓨팅',          'Quantum Computing Inc.',                 'US', '양자컴퓨팅'),
  ('BATL',  '바탈리언 오일',        'Battalion Oil Corp.',                   'US', '에너지'),
  ('BTBT',  '비트 디지털',          'Bit Digital Inc.',                      'US', '암호화폐'),
  ('USBC',  'US Bitcoin ETF',     'US Bitcoin ETF (USBC)',                  'US', 'ETF')
ON CONFLICT (ticker) DO UPDATE SET
  name_ko  = EXCLUDED.name_ko,
  name_en  = EXCLUDED.name_en,
  sector   = EXCLUDED.sector;
