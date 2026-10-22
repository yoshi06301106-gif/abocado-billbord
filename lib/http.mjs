import { AppError } from './store.mjs';
export const htmlEscape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
export function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
}
export function headers(res) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}
export async function body(req, type = 'application/json') {
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== type) throw new AppError('送信形式が不正です。', 415);
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 128000) throw new AppError('入力が大きすぎます。', 413); chunks.push(chunk); }
  const data = Buffer.concat(chunks).toString('utf8');
  if (type !== 'application/json') return Object.fromEntries(new URLSearchParams(data));
  try { const parsed = JSON.parse(data); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); return parsed; }
  catch { throw new AppError('JSON形式が不正です。'); }
}
