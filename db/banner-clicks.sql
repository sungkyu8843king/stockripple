-- 배너/광고 클릭 집계 (인트로 배너, 쿠팡 파트너스 배너 각 슬롯) — 어드민 "배너 클릭" 패널용
-- 클라이언트는 이 테이블을 절대 직접 건드리지 않는다 — 기록/조회 모두
-- /api/admin(action=banner-click / action=banner-clicks)을 거쳐 서버(service role)로만 처리한다.
CREATE TABLE IF NOT EXISTS banner_clicks (
  slot TEXT NOT NULL,
  click_date DATE NOT NULL DEFAULT CURRENT_DATE,
  clicks INT NOT NULL DEFAULT 0,
  PRIMARY KEY (slot, click_date)
);
CREATE INDEX IF NOT EXISTS idx_banner_clicks_date ON banner_clicks(click_date DESC);

ALTER TABLE banner_clicks ENABLE ROW LEVEL SECURITY;
-- 정책을 하나도 만들지 않음 = anon/authenticated는 이 테이블에 전혀 접근 불가 (page_views와 동일 패턴).
-- service_role은 RLS를 우회하므로 서버(백엔드)는 정상적으로 읽고 쓸 수 있다.

-- 동시 클릭 경합 없이 카운트 증가 (company_views의 increment_company_view와 동일 패턴)
CREATE OR REPLACE FUNCTION increment_banner_click(p_slot TEXT)
RETURNS void AS $$
BEGIN
  INSERT INTO banner_clicks (slot, click_date, clicks)
  VALUES (p_slot, CURRENT_DATE, 1)
  ON CONFLICT (slot, click_date)
  DO UPDATE SET clicks = banner_clicks.clicks + 1;
END;
$$ LANGUAGE plpgsql;
