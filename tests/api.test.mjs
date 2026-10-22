import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../lib/store.mjs';
import { openAccess } from '../lib/access.mjs';
import { createGateway } from '../lib/gateway.mjs';
import { createCredentialFile } from '../scripts/credential.mjs';
import { smoke } from '../scripts/smoke.mjs';

test('REST and MCP share scoped identity, receipts, replay safety, and revocation', async () => {
  const store = openStore(':memory:'), access = openAccess(':memory:');
  const gateway = createGateway({ store, access, publicUrl: 'https://board.example' });
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const create = title => store.dispatch({ action: 'createTopic', title, brief: 'test', revision: store.read().revision }).result;
  const shared = create('shared'), hidden = create('hidden');
  const issue = (readOnly = false) => access.issueCredential({ author: 'Ludy', topics: [shared], validTopics: [shared, hidden], resource: 'https://board.example/mcp', readOnly });
  const credential = issue();
  const send = (path, payload, token = credential.access_token, headers = {}) => fetch(base + path, { method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  try {
    assert.deepEqual(await (await fetch(base + '/healthz')).json(), { ok: true, service: 'abocado-gateway' });
    assert.equal((await fetch(base + '/api/v1/topics')).status, 401);
    assert.equal((await fetch(base + '/api/session')).status, 404);
    assert.equal((await send('/api/v1/topics', null, credential.access_token, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await send('/api/v1/topics/' + hidden)).status, 403);
    const current = await (await send('/api/v1/topics/' + shared)).json();
    const input = { topic_id: shared, round: 1, revision: current.revision, content: 'API test', request_id: 'api_request_001', references: [] };
    assert.equal((await send('/api/v1/proposals', { ...input, author: 'Ken' })).status, 400);
    assert.equal((await send('/api/v1/proposals', input, issue(true).access_token)).status, 403);
    assert.equal((await send('/api/v1/proposals', { ...input, revision: -1 })).status, 409);
    const post = await (await send('/api/v1/proposals', input)).json();
    assert.equal(post.author, 'Ludy'); assert.equal(post.source, 'api');
    assert.deepEqual(await (await send('/api/v1/proposals', input)).json(), post);
    assert.equal((await send('/api/v1/proposals', { ...input, content: 'changed' })).status, 409);
    const rpc = await (await send('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_receipt', arguments: { post_id: post.id } } })).json();
    assert.deepEqual(JSON.parse(rpc.result.content[0].text), post);
    assert.equal((await send('/api/v1/receipts/' + post.id, null, issue().access_token)).status, 404);
    assert.equal((await send('/api/v1/proposals')).status, 405);
    const adapter = (url, options) => fetch(url.replace('https://board.example', base), options);
    assert.equal((await smoke({ url: 'https://board.example', token: credential.access_token, topicId: shared, fetchImpl: adapter })).mode, 'read-only');
    assert.equal(store.read().posts.length, 1);
    const report = await smoke({ url: 'https://board.example', token: credential.access_token, topicId: shared, write: true, fetchImpl: adapter });
    assert.equal(report.ok, true); assert.equal(report.gemini_verified, false); assert.equal(store.read().posts.length, 2);
    access.revoke(credential.grant_id);
    assert.equal((await send('/api/v1/topics')).status, 401);
  } finally { await new Promise(r => gateway.close(r)); access.close(); store.close(); }
});

test('local credentials expire, bind audience, validate grants and persist only hashed secrets', () => {
  let now = 1000;
  const dir = mkdtempSync(join(tmpdir(), 'abocado-access-')), dbfile = join(dir, 'access.sqlite');
  let access = openAccess(dbfile, { clock: () => now });
  try {
    const args = { author: 'Ludy', topics: ['shared'], validTopics: ['shared'], resource: 'https://board.example/mcp', ttl: 60 };
    for (const extra of [{ author: 'Ken' }, { topics: ['hidden'] }, { ttl: 0 }, { ttl: 604801 }, { resource: 'http://board.example/mcp' }]) assert.throws(() => access.issueCredential({ ...args, ...extra }));
    const credential = access.issueCredential(args);
    assert.equal(access.authenticate(credential.access_token, args.resource).author, 'Ludy');
    assert.throws(() => access.authenticate(credential.access_token, 'https://other.example/mcp'));
    access.close(); access = openAccess(dbfile, { clock: () => now });
    assert.equal(access.authenticate(credential.access_token, args.resource).id, credential.grant_id);
    const db = new DatabaseSync(dbfile);
    const records = JSON.stringify(db.prepare('SELECT * FROM access_records').all()); db.close();
    assert.ok(!records.includes(credential.access_token));
    assert.ok(!JSON.stringify(access.list()).includes(credential.access_token));
    now += 60000;
    assert.throws(() => access.authenticate(credential.access_token, args.resource), /認証/);
  } finally { access.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('credential file refuses overwrite, wrong database, and archived topic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abocado-credential-')), database = join(dir, 'board.sqlite');
  const store = openStore(database);
  const topic = store.dispatch({ action: 'createTopic', title: 'test', brief: 'test', revision: 0 }).result;
  const output = join(dir, 'ludy.credential.json');
  try {
    const args = { database, output, url: 'https://board.example', topics: [topic] };
    const result = createCredentialFile(args), credential = JSON.parse(readFileSync(output, 'utf8'));
    assert.ok(!JSON.stringify(result).includes(credential.access_token));
    assert.throws(() => createCredentialFile(args), /上書き/);
    assert.throws(() => createCredentialFile({ ...args, output: join(dir, 'other.credential.json'), database: join(dir, 'missing.sqlite') }), /既存/);
    store.dispatch({ action: 'archiveTopic', topicId: topic, archived: true, revision: store.read().revision });
    assert.throws(() => createCredentialFile({ ...args, output: join(dir, 'archived.credential.json') }), /共有議題/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
