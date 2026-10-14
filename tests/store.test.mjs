import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, AI_PEOPLE } from '../lib/store.mjs';

function fixture(filename = ':memory:') {
  const store = openStore(filename);
  const act = (action, fields = {}) => store.dispatch({ action, revision: store.read().revision, ...fields });
  const topicId = act('createTopic', { title: '新しい曲の方向', brief: '音楽の方向を決める' }).result;
  const post = (author, round, refs = []) => act('post', { topicId, author, round, content: `${author}の案 R${round}`, references: refs }).result;
  return { store, act, topicId, post };
}
test('full 3-round workflow, revisions, decisions and memory retain provenance', () => {
  const { store, act, topicId, post } = fixture();
  try {
    assert.throws(() => act('advance', { topicId }), /投稿を揃えて/);
    assert.throws(() => act('decide', { topicId, author: 'Ken' }), /Round 3/);
    const r1 = AI_PEOPLE.map(a => post(a, 1)); post('Ken', 1);
    act('advance', { topicId });
    assert.throws(() => post('Love', 1), /現在のラウンド/);
    assert.throws(() => post('Love', 2), /参照/);
    const r2 = AI_PEOPLE.map(a => post(a, 2, [r1[0], r1[1]]));
    act('advance', { topicId });
    assert.throws(() => post('Tina', 3, [r1[0]]), /ひとつ前/);
    const r3 = AI_PEOPLE.map(a => post(a, 3, [r2[0]]));
    assert.throws(() => act('advance', { topicId }), /これ以上/);
    assert.throws(() => act('decide', { topicId, author: 'Love' }), /Ken/);
    assert.throws(() => act('decide', { topicId, author: 'Ken', references: [r1[0]] }), /最終案/);
    const decisionId = act('decide', { topicId, author: 'Ken', references: [r3[0]], content: 'この案に決定', reason: '実行可能' }).result;
    assert.throws(() => post('Ken', 3, [r2[0]]), /決定済み/);
    const nextId = act('decide', { topicId, author: 'Ken', references: [r3[1]], content: '修正して採用', reason: '制約を再確認' }).result;
    const memoryId = act('saveMemory', { title: '今後の方針', content: '小さく始める', decisionId: nextId }).result;
    act('saveMemory', { memoryId, title: '方針改訂', content: '週1回更新' });
    const s = store.read();
    assert.equal(s.posts.length, 10); assert.ok(s.posts.every(p => p.source === 'manual'));
    assert.equal(s.decisions[1].supersedes, decisionId);
    assert.equal(s.topics[0].status, 'decided');
    assert.equal(s.memories[0].decisionId, nextId);
    assert.equal(s.memoryHistory.length, 2); assert.equal(s.memoryHistory[0].content, '小さく始める');
    assert.equal(s.events.length, s.revision);
  } finally { store.close(); }
});
test('stale writes and invalid actions roll back; archive preserves all data', () => {
  const { store, act, topicId, post } = fixture();
  try {
    const revision = store.read().revision; const id = post('Love', 1);
    assert.throws(() => store.dispatch({ action: 'editTopic', revision, topicId, title: '上書き', brief: '競合' }), e => e.status === 409);
    const before = store.read();
    assert.throws(() => post('Unknown', 1), /投稿者/);
    assert.throws(() => act('editTopic', { topicId, title: ' ', brief: '背景' }), /議題名/);
    assert.throws(() => act('saveMemory', { title: 'a', content: 'b', decisionId: 'invalid' }), /決定履歴/);
    assert.deepEqual(store.read(), before);
    act('archiveTopic', { topicId, archived: true });
    assert.throws(() => post('Ken', 1), /アーカイブ/);
    assert.equal(store.read().posts[0].id, id);
    act('archiveTopic', { topicId, archived: false }); post('Ken', 1);
    assert.equal(store.read().posts.length, 2);
  } finally { store.close(); }
});
test('SQLite survives restart, including Unicode, and concurrent store instances use revision checks', () => {
  const folder = mkdtempSync(join(tmpdir(), 'abocado-test-')); const file = join(folder, 'board.sqlite');
  let a, b;
  try {
    const f = fixture(file); a = f.store; f.post('Tina', 1);
    const saved = a.read(); a.close(); a = openStore(file); b = openStore(file);
    assert.deepEqual(a.read(), saved);
    a.dispatch({ action: 'saveMemory', revision: saved.revision, title: '🍐 日本語', content: '<script>alert(1)</script>は文字として保存' });
    assert.throws(() => b.dispatch({ action: 'archiveTopic', revision: saved.revision, topicId: f.topicId, archived: true }), e => e.status === 409);
    assert.equal(b.read().memories[0].title, '🍐 日本語');
  } finally { a?.close(); b?.close(); rmSync(folder, { recursive: true, force: true }); }
});
test('cross-topic references and skipped rounds are rejected', () => {
  const { store, act, topicId, post } = fixture();
  try {
    const first = post('Love', 1); post('Ludy', 1); post('Tina', 1); act('advance', { topicId });
    const secondTopic = act('createTopic', { title: '別の議題', brief: '背景' }).result;
    const second = act('post', { topicId: secondTopic, round: 1, author: 'Love', content: '別案', references: [] }).result;
    assert.throws(() => post('Love', 2, [second]), /ひとつ前/);
    assert.throws(() => post('Love', 2, [first, first]), /参照投稿/);
    assert.throws(() => act('post', { topicId: secondTopic, round: 3, author: 'Love', content: 'スキップ' }), /現在のラウンド/);
  } finally { store.close(); }
});
