/**
 * admin-logic.js — 어드민 대시보드 업무 로직(JS) 인증 뒤 제공
 * GET /api/admin-shell와 짝을 이룸: 마크업(HTML)만 숨겨도 view-source에
 * panels 라벨·showPanel·runPipeline 등 함수명/메뉴명이 그대로 남는 문제가
 * 있어, 로그인 화면 유지에 꼭 필요한 부트스트랩 코드(구글 로그인, 이메일
 * 화이트리스트 검사, 토큰 조회)만 admin/index.html에 남기고 나머지 업무
 * 로직 전체(lib/admin-dashboard-logic.txt, 원래 admin/index.html의
 * <script> 대부분)를 이 뒤로 옮겼다. verifyAdmin 통과해야만 원문 그대로
 * 반환되고, 프론트에서 실제 <script> 태그로 주입해 실행한다.
 *
 * .js가 아닌 .txt로 저장: Vercel/Node 모듈 로더가 이 파일을 import/require로
 * 실행 시도하면 document/window 등 브라우저 전용 전역 참조 때문에 즉시
 * 에러가 나므로, 순수 텍스트 자산으로만 다루기 위함.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { verifyAdmin } from '../lib/auth.js';

export default async function handler(req, res) {
  const auth = await verifyAdmin(req.headers.authorization);
  if (!auth.ok) return res.status(401).json({ error: auth.error });

  const code = readFileSync(join(process.cwd(), 'lib', 'admin-dashboard-logic.txt'), 'utf8');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(code);
}
