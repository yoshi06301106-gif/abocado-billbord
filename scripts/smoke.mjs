import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A deterministic client test, never evidence that Gemini itself posted.
export async function smoke({ url, token, topicId, write = false, fetchImpl = fetch }) {
  const base = new URL(url);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('BOARD_URLはHTTPSオリジンにしてください。');
  if (!token || !topicId) throw new Error('BOARD_TOKENとBOARD_TOPICが必要です。');
  const request = async (path, payload) => {
    const response = await fetchImpl(`${base.origin}${path}`, { method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.error_description || data.error}`);
    return data;
  };
  const list = await request('/api/v1/topics');
  assert.ok(list.topics.some(t => t.id === topicId), '共有議題が見つかりません。');
  const current = await request(`/api/v1/topics/${encodeURIComponent(topicId)}`);
  if (!write) return { ok: true, mode: 'read-only', author: current.author, topic_id: topicId };
  assert.equal(current.topic.round, 1, '書き込みテストには専用のRound 1議題を使ってください。');
  const input = { topic_id: topicId, content: '疎通テスト（検証クライアント。Gemini本人の発言ではありません）', round: 1, revision: current.revision, request_id: `smoke_${randomUUID()}`, references: [] };
  const post = await request('/api/v1/proposals', input);
  assert.equal(post.author, current.author);
  assert.equal(post.content, input.content);
  const replay = await request('/api/v1/proposals', input);
  assert.equal(replay.id, post.id);
  const receipt = await request(`/api/v1/receipts/${encodeURIComponent(post.id)}`);
  assert.deepEqual(receipt, post);
  return { ok: true, mode: 'write-read-replay', author: post.author, post_id: post.id, created_at: post.createdAt, gemini_verified: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--write')) throw new Error('引数は --write のみです。');
    console.log(JSON.stringify(await smoke({ url: process.env.BOARD_URL, token: process.env.BOARD_TOKEN, topicId: process.env.BOARD_TOPIC, write: process.argv.includes('--write') }), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
