import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';

test('HTTP workflow, capability protection, origin/host checks and safe export', async () => {
  const server = createApp({ database: ':memory:' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base); assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await page.text(), /lang="ja"/);
    assert.equal((await fetch(`${base}/api/state`)).status, 403);
    assert.equal((await fetch(`${base}/api/session`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
    const badHost = await new Promise((resolve, reject) => {
      http.get(`${base}/api/session`, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(badHost, 403);
    assert.equal((await fetch(`${base}/api/session`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const { token } = await (await fetch(`${base}/api/session`)).json();
    const headers = { 'X-Board-Token': token, 'Content-Type': 'application/json' };
    let response = await fetch(`${base}/api/action`, { method: 'POST', headers, body: JSON.stringify({ action: 'createTopic', revision: 0, title: '🍐 音楽', brief: '<img src=x onerror=alert(1)>' }) });
    assert.equal(response.status, 200); const saved = await response.json();
    assert.equal(saved.state.topics[0].title, '🍐 音楽');
    response = await fetch(`${base}/api/action`, { method: 'POST', headers, body: JSON.stringify({ action: 'archiveTopic', revision: 0, topicId: saved.result, archived: true }) });
    assert.equal(response.status, 409);
    assert.equal((await fetch(`${base}/api/action`, { method: 'POST', headers, body: '{broken' })).status, 400);
    assert.equal((await fetch(`${base}/api/action`, { method: 'POST', headers: { 'X-Board-Token': token }, body: '{}' })).status, 415);
    assert.equal((await fetch(`${base}/api/action`, { method: 'POST', headers, body: JSON.stringify({ large: 'a'.repeat(128001) }) })).status, 413);
    response = await fetch(`${base}/api/export`, { headers });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/);
    assert.deepEqual(await response.json(), saved.state);
    assert.equal((await fetch(`${base}/data/board.sqlite`)).status, 404);
    assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/style.css`)).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('connection diagnostics are available only through the protected local operator API', async () => {
  const server = createApp({ database: ':memory:', publicUrl: 'https://board.example' });
  const gateway = server.board.gateway;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  const local = `http://127.0.0.1:${server.address().port}`, remote = `http://127.0.0.1:${gateway.address().port}`;
  try {
    await fetch(remote + '/mcp');
    assert.equal((await fetch(local + '/api/connections')).status, 403);
    assert.equal((await fetch(remote + '/api/connections')).status, 404);
    const { token } = await (await fetch(local + '/api/session')).json();
    const result = await (await fetch(local + '/api/connections', { headers: { 'X-Board-Token': token } })).json();
    assert.ok(result.diagnostics.events.some(e => e.stage === 'authentication' && e.status === 401));
    assert.ok(!JSON.stringify(result).includes(token));
  } finally { await new Promise(r => server.close(r)); }
});
