import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openStore, AppError } from './lib/store.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
export function createApp({ database = resolve(root, 'data/board.sqlite') } = {}) {
  const store = openStore(database);
  // Per-process capability; same-origin page receives it. Never persisted or logged.
  const token = randomBytes(32).toString('hex');
  const assets = new Map([['/', ['index.html', 'text/html']], ['/app.mjs', ['app.mjs', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      const address = server.address();
      const expected = `127.0.0.1:${address.port}`;
      // Reject DNS rebinding, cross-site requests, and proxy exposure.
      if (req.headers.host !== expected && req.headers.host !== `localhost:${address.port}`) throw new AppError('ローカル接続のみ利用できます。', 403);
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new AppError('別サイトからの接続を拒否しました。', 403);
      if (req.headers.origin && ![`http://${expected}`, `http://localhost:${address.port}`].includes(req.headers.origin)) throw new AppError('接続元が不正です。', 403);
      const url = new URL(req.url, `http://${expected}`);
      if (req.method === 'GET' && url.pathname === '/api/session') return send(200, { token });
      if (url.pathname.startsWith('/api/')) {
        const provided = req.headers['x-board-token'];
        if (typeof provided !== 'string' || !/^[a-f0-9]{64}$/.test(provided) || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) throw new AppError('画面を再読み込みしてください。', 403);
        if (req.method === 'GET' && url.pathname === '/api/state') return send(200, store.read());
        if (req.method === 'GET' && url.pathname === '/api/export') {
          res.setHeader('Content-Disposition', 'attachment; filename="abocado.backup.json"');
          return send(200, store.read());
        }
        if (req.method === 'POST' && url.pathname === '/api/action') {
          if (req.headers['content-type'] !== 'application/json') throw new AppError('JSON形式で送信してください。', 415);
          const chunks = []; let bytes = 0;
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > 128000) throw new AppError('入力が大きすぎます。', 413);
            chunks.push(chunk);
          }
          let input;
          try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('JSON形式が不正です。'); }
          return send(200, store.dispatch(input));
        }
        return send(404, { error: '見つかりません。' });
      }
      if (req.method !== 'GET' || !assets.has(url.pathname)) return send(404, { error: '見つかりません。' });
      const [file, type] = assets.get(url.pathname);
      const content = await readFile(resolve(root, 'public', file));
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(content);
    } catch (error) {
      if (!(error instanceof AppError)) console.error('Request failed:', error.message);
      send(error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : '保存に失敗しました。データを消さずにアプリを再起動してください。' });
    }
  });
  server.on('close', () => store.close());
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
  const server = createApp({ database: process.env.BOARD_DB ? resolve(process.env.BOARD_DB) : undefined });
  server.listen(port, '127.0.0.1', () => console.log(`abocado: http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; server.close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
