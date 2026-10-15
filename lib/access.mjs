import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { AppError, AI_PEOPLE } from './store.mjs';
const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const bad = (message = '認証リクエストが不正です。', status = 400) => { throw new AppError(message, status); };
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function openAccess(filename, { clock = Date.now } = {}) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS access_records(kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind,id));`);
  const get = (kind, id) => { const row = db.prepare('SELECT json FROM access_records WHERE kind=? AND id=?').get(kind, String(id ?? '')); return row ? JSON.parse(row.json) : null; };
  const all = kind => db.prepare('SELECT json FROM access_records WHERE kind=?').all(kind).map(row => JSON.parse(row.json));
  const put = (kind, id, record) => db.prepare('INSERT OR REPLACE INTO access_records VALUES (?,?,?)').run(kind, id, JSON.stringify(record));
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch(e) { db.exec('ROLLBACK'); throw e; } };
  function cleanup() { db.prepare("DELETE FROM access_records WHERE kind IN ('pending','code','token') AND json_extract(json,'$.expiresAt') < ?").run(clock()); }
  function register(input) {
    cleanup();
    if (all('client').length >= 500) bad('登録上限です。', 429);
    if (!Array.isArray(input.redirect_uris) || !input.redirect_uris.length || input.redirect_uris.length > 5) bad();
    const redirects = input.redirect_uris.map(raw => {
      if (typeof raw !== 'string' || raw.length > 2000) bad();
      let url; try { url = new URL(raw); } catch { bad(); }
      if (url.hash || url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) bad('HTTPSまたはループバックの戻り先を指定してください。');
      return raw;
    });
    const method = input.token_endpoint_auth_method || 'none';
    if (!['none','client_secret_post','client_secret_basic'].includes(method)) bad();
    const id = secret(), clientSecret = method === 'none' ? null : secret();
    const client = { id, name: String(input.client_name || '名前未設定のアプリ').slice(0, 120), redirects, method, secretHash: clientSecret && hash(clientSecret), createdAt: clock() };
    put('client', id, client);
    return { client_id: id, client_name: client.name, redirect_uris: redirects, token_endpoint_auth_method: method,
      grant_types: ['authorization_code'], response_types: ['code'], ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}) };
  }
  function start(params, issuer) {
    cleanup();
    const client = get('client', params.client_id);
    if (!client || !client.redirects.includes(params.redirect_uri)) bad('登録済みの戻り先と一致しません。');
    if (params.response_type !== 'code' || params.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge || '')) bad('PKCE S256が必要です。');
    if (params.resource !== `${issuer}/mcp`) bad('接続先resourceが一致しません。');
    const scopes = (params.scope || 'board:read board:post').split(' ').filter(Boolean);
    if (scopes.some(s => !['board:read','board:post'].includes(s)) || !scopes.includes('board:read')) bad('権限が不正です。');
    if ((params.state || '').length > 2000 || all('pending').length >= 100) bad('接続リクエストが多すぎます。', 429);
    const id = secret();
    put('pending', id, { id, clientId: client.id, clientName: client.name, redirect: params.redirect_uri, challenge: params.code_challenge,
      state: params.state || '', resource: params.resource, scope: scopes.join(' '), status: 'pending', expiresAt: clock() + 600000, createdAt: clock() });
    return id;
  }
  function list() {
    cleanup();
    return { pending: all('pending').filter(p => p.status === 'pending').map(({ id, clientName, redirect, scope, createdAt }) => ({ id, clientName, redirect, scope, createdAt })),
      grants: all('grant').map(({ id, author, topics, clientName, revoked, createdAt, lastUsedAt }) => ({ id, author, topics, clientName, revoked, createdAt, lastUsedAt })) };
  }
  function approve(id, author, topics, validTopics) {
    return transaction(() => {
      const p = get('pending', id);
      if (!p || p.status !== 'pending' || p.expiresAt < clock()) bad('接続リクエストが期限切れです。', 409);
      if (!AI_PEOPLE.includes(author) || !Array.isArray(topics) || !topics.length || topics.length > 100 || topics.some(t => !validTopics.includes(t))) bad('投稿者と共有する議題を選択してください。');
      const grant = { id: secret(), author, topics: [...new Set(topics)], clientId: p.clientId, clientName: p.clientName, resource: p.resource, scope: p.scope, revoked: false, createdAt: clock() };
      put('grant', grant.id, grant); put('pending', id, { ...p, status: 'approved', grantId: grant.id });
      return { id: grant.id, author, topics: grant.topics };
    });
  }
  function revoke(id) {
    const g = get('grant', id); if (!g) bad('接続が見つかりません。', 404);
    put('grant', id, { ...g, revoked: true });
  }
  function deny(id) { const p = get('pending', id); if (p) put('pending', id, { ...p, status: 'denied' }); }
  function progress(id) {
    return transaction(() => {
      const p = get('pending', id);
      if (!p || p.expiresAt < clock()) bad('接続リクエストが期限切れです。', 410);
      if (p.status === 'denied') {
        const redirect = new URL(p.redirect); redirect.searchParams.set('error', 'access_denied'); if (p.state) redirect.searchParams.set('state', p.state); return { redirect: redirect.href };
      }
      if (p.status !== 'approved') return { status: p.status };
      const code = secret(); put('code', hash(code), { ...p, expiresAt: clock() + 120000 }); put('pending', id, { ...p, status: 'issued' });
      const redirect = new URL(p.redirect); redirect.searchParams.set('code', code); if (p.state) redirect.searchParams.set('state', p.state);
      return { redirect: redirect.href };
    });
  }
  function exchange(input, basic) {
    return transaction(() => {
      let clientId = input.client_id, clientSecret = input.client_secret, usedMethod = clientSecret ? 'client_secret_post' : 'none';
      if (basic) {
        const decoded = Buffer.from(basic, 'base64').toString('utf8'), colon = decoded.indexOf(':');
        if (colon < 0) bad('クライアント認証が不正です。', 401);
        clientId = decodeURIComponent(decoded.slice(0, colon)); clientSecret = decodeURIComponent(decoded.slice(colon + 1)); usedMethod = 'client_secret_basic';
      }
      const client = get('client', clientId);
      if (!client || client.method !== usedMethod || (client.secretHash && !safeEqual(hash(String(clientSecret || '')), client.secretHash))) bad('クライアント認証に失敗しました。', 401);
      if (input.grant_type !== 'authorization_code' || typeof input.code !== 'string') bad();
      const key = hash(input.code), code = get('code', key);
      if (!code || code.expiresAt < clock() || code.clientId !== clientId || code.redirect !== input.redirect_uri || code.resource !== input.resource) bad('認可コードが無効です。');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier || '')) bad('PKCE verifierが不正です。');
      if (!safeEqual(createHash('sha256').update(input.code_verifier).digest('base64url'), code.challenge)) bad('PKCE検証に失敗しました。');
      const grant = get('grant', code.grantId); if (!grant || grant.revoked) bad('接続は解除されています。', 403);
      const token = secret(); put('token', hash(token), { grantId: grant.id, expiresAt: clock() + 3600000 });
      db.prepare("DELETE FROM access_records WHERE kind='code' AND id=?").run(key);
      return { access_token: token, token_type: 'Bearer', expires_in: 3600, scope: grant.scope };
    });
  }
  function authenticate(raw, resource) {
    if (typeof raw !== 'string' || raw.length > 100) bad('認証が必要です。', 401);
    const token = get('token', hash(raw)), grant = token && get('grant', token.grantId);
    if (!token || token.expiresAt < clock() || !grant || grant.revoked || grant.resource !== resource) bad('認証が必要です。', 401);
    put('grant', grant.id, { ...grant, lastUsedAt: clock() }); return grant;
  }
  return { register, start, list, approve, deny, revoke, progress, exchange, authenticate, close: () => db.close() };
}
