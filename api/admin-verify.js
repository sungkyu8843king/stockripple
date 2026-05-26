import { verifyAdmin } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const result = await verifyAdmin(req.headers.authorization);
  if (!result.ok) return res.status(401).json({ error: result.error });
  return res.status(200).json({ ok: true, mode: result.mode, email: result.email });
}
