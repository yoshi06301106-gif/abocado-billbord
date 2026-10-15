import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openStore, AppError } from './lib/store.mjs';
import { openAccess } from './lib/access.mjs';
import { createGateway } from './lib/gateway.mjs';
import { body as readBody } from './lib/http.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
export function createApp({ database = resolve(root, 'data/board.sqlite'), publicUrl = null } = {}) {
  const store = openStore(database);
  const access = openAccess(database);
  const gateway = publicUrl ? createGateway({ store, access, publicUrl }) : null;
  // Per-process capability; same-origin page receives it. Never persisted or logged.
  const token = randomBytes(32).toString('hex');
  const assets = new Map([['/', ['index.html', 'text/html']], ['/app.mjs', ['app.mjs', 'text/javascript']], ['/features.mjs', ['features.mjs', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
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
        if (req.method === 'GET' && url.pathname === '/api/connections') return send(200, { ...access.list(), mcpUrl: publicUrl ? `${new URL(publicUrl).origin}/mcp` : null });
        if (req.method === 'POST' && url.pathname.startsWith('/api/connections/')) {
          const input = await readBody(req);
          if (url.pathname === '/api/connections/approve') return send(200, access.approve(input.id, input.author, input.topics, store.read().topics.filter(t => !t.archived).map(t => t.id)));
          if (url.pathname === '/api/connections/deny') { access.deny(input.id); return send(200, { ok: true }); }
          if (url.pathname === '/api/connections/revoke') { access.revoke(input.id); return send(200, { ok: true }); }
        }
        if (req.method === 'GET' && url.pathname === '/api/export') {
          res.setHeader('Content-Disposition', 'attachment; filename="abocado.backup.json"');
          return send(200, store.read());
        }
        if (req.method === 'POST' && url.pathname === '/api/action') {
          const input = await readBody(req);
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
  server.board = { gateway };
  server.on('close', () => { gateway?.close(); access.close(); store.close(); });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
  const server = createApp({ database: process.env.BOARD_DB ? resolve(process.env.BOARD_DB) : undefined, publicUrl: process.env.MCP_PUBLIC_URL || null });
  if (server.board.gateway) {
    const mcpPort = Number(process.env.MCP_PORT || 3002);
    if (!Number.isInteger(mcpPort) || mcpPort < 1 || mcpPort > 65535 || mcpPort === port) throw new Error('MCP_PORTは画面と異なるポートを指定してください。');
    server.board.gateway.listen(mcpPort, '127.0.0.1', () => console.log(`AI connection: ${new URL(process.env.MCP_PUBLIC_URL).origin}/mcp`));
    server.board.gateway.on('error', e => { console.error(e.message); server.close(); });
  }
  server.listen(port, '127.0.0.1', () => console.log(`abocado: http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; server.close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
