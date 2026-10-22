import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const PEOPLE = ['Ken', 'Love', 'Ludy', 'Tina'];
export const AI_PEOPLE = PEOPLE.slice(1);
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new AppError(message, status); };
function text(value, name, max = 20000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name}を1〜${max}文字で入力してください。`);
  return value.trim();
}
const now = () => new Date().toISOString();

export function openStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  // No destructive migrations: unsupported versions fail closed.
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 2) { db.close(); throw new Error('このデータベースは新しい版で作成されています。対応するアプリを使用してください。'); }
  db.exec(`CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
    PRAGMA user_version=2;`);
  db.prepare('INSERT OR IGNORE INTO state VALUES (1, ?)').run(JSON.stringify({
    schemaVersion: 1, revision: 0, topics: [], posts: [], decisions: [],
    memories: [], memoryHistory: [], events: []
  }));
  const read = () => ({ feedback: [], statusHistory: [], verificationNotes: [], ...JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json), schemaVersion: 2 });
  function mutate(expected, action, fn, actor = 'Ken') {
    db.exec('BEGIN IMMEDIATE');
    try {
      const state = read();
      if (!Number.isSafeInteger(expected) || expected !== state.revision) fail('別の画面で更新されています。再読み込みしてからもう一度保存してください。', 409);
      const result = fn(state);
      state.revision++;
      state.events.push({ id: randomUUID(), action, at: now(), actor, revision: state.revision });
      db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(state));
      db.exec('COMMIT');
      return { state, result };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function topic(state, id, active = true) {
    const found = state.topics.find(t => t.id === id);
    if (!found) fail('議題が見つかりません。', 404);
    if (active && found.archived) fail('アーカイブ済みの議題です。先に戻してください。');
    return found;
  }
  const complete = (state, t) => AI_PEOPLE.every(author => state.posts.some(p => p.topicId === t.id && p.round === t.round && p.author === author));
  function dispatch(input, context = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('入力形式が不正です。');
    const { action, revision } = input;
    return mutate(revision, action, state => {
      switch (action) {
        case 'createTopic': {
          const t = { id: randomUUID(), title: text(input.title, '議題名', 200), brief: text(input.brief, '議題の説明'),
            round: 1, status: 'open', archived: false, createdAt: now(), updatedAt: now() };
          state.topics.unshift(t); return t.id;
        }
        case 'editTopic': {
          const t = topic(state, input.topicId);
          if (t.status === 'decided') fail('決定済みの議題は編集できません。新しい議題を作成してください。');
          t.title = text(input.title, '議題名', 200); t.brief = text(input.brief, '議題の説明'); t.updatedAt = now(); return t.id;
        }
        case 'archiveTopic': {
          const t = topic(state, input.topicId, false);
          if (typeof input.archived !== 'boolean') fail('アーカイブ指定が不正です。');
          t.archived = input.archived; t.updatedAt = now(); return t.id;
        }
        case 'post': {
          const t = topic(state, input.topicId);
          if (t.status !== 'open') fail('決定済みの議題には投稿できません。');
          if (!PEOPLE.includes(input.author)) fail('投稿者を選択してください。');
          if (input.round !== t.round) fail('現在のラウンドに投稿してください。');
          const refs = input.references ?? [];
          if (!Array.isArray(refs) || refs.length > 30 || new Set(refs).size !== refs.length) fail('参照投稿が不正です。');
          if (refs.some(id => !state.posts.some(p => p.id === id && p.topicId === t.id && p.round === t.round - 1))) fail('ひとつ前のラウンドの投稿を参照してください。');
          if (t.round > 1 && !refs.length) fail('レビュー・最終案はひとつ前のラウンドの投稿を参照してください。');
          if (t.round === 1 && refs.length) fail('独立案には参照を付けられません。');
          const p = { id: randomUUID(), topicId: t.id, author: input.author, round: t.round,
            content: text(input.content, '投稿内容'), references: refs, source: context.clientId ? (context.transport === 'api' ? 'api' : 'mcp') : 'manual', createdAt: now(),
            ...(context.clientId ? { clientId: context.clientId, requestId: context.requestId, fingerprint: context.fingerprint, recordedBy: input.author } : { recordedBy: 'Ken' }) };
          state.posts.push(p); t.updatedAt = now(); return p.id;
        }
        case 'advance': {
          const t = topic(state, input.topicId);
          if (t.status !== 'open' || t.round >= 3) fail('これ以上ラウンドを進められません。');
          if (!complete(state, t)) fail('Love・Ludy・Tinaの投稿を揃えてください。');
          t.round++; t.updatedAt = now(); return t.id;
        }
        case 'decide': {
          const t = topic(state, input.topicId);
          if (input.author !== 'Ken') fail('決定はKenとして記録してください。', 403);
          if (t.round !== 3 || !complete(state, t)) fail('Round 3の3人の最終案を揃えてから決定してください。');
          const refs = input.references;
          if (!Array.isArray(refs) || !refs.length || refs.length > 30 || new Set(refs).size !== refs.length || refs.some(id => !state.posts.some(p => p.id === id && p.topicId === t.id && p.round === 3))) fail('採用・参考にした最終案を選択してください。');
          const decision = { id: randomUUID(), topicId: t.id, author: 'Ken', content: text(input.content, '決定内容'),
            reason: text(input.reason, '決定理由'), references: refs, createdAt: now(), supersedes: state.decisions.filter(d => d.topicId === t.id).at(-1)?.id ?? null };
          state.decisions.push(decision); t.status = 'decided'; t.updatedAt = now(); return decision.id;
        }
        case 'saveMemory': {
          const content = text(input.content, 'メモリー');
          const title = text(input.title, 'メモリー名', 200);
          let memory = input.memoryId ? state.memories.find(m => m.id === input.memoryId) : null;
          if (input.memoryId && !memory) fail('メモリーが見つかりません。', 404);
          const decisionId = input.decisionId ?? memory?.decisionId ?? null;
          if (decisionId && !state.decisions.some(d => d.id === decisionId)) fail('決定履歴が見つかりません。');
          if (!memory) { memory = { id: randomUUID(), createdAt: now() }; state.memories.push(memory); }
          Object.assign(memory, { title, content, decisionId, updatedAt: now() });
          state.memoryHistory.push({ ...memory, versionId: randomUUID() }); return memory.id;
        }
        case 'addFeedback': {
          const d = state.decisions.find(d => d.id === input.decisionId);
          if (!d) fail('対象の決定が見つかりません。', 404);
          if (!PEOPLE.includes(input.author)) fail('発言者を選択してください。');
          const verdict = input.verdict || 'unrated';
          if (!['unrated', 'good', 'mixed', 'bad'].includes(verdict)) fail('評価が不正です。');
          const optional = (value, name, max = 5000) => value === undefined || value === '' ? '' : text(value, name, max);
          const previous = input.supersedes ? state.feedback.find(f => f.id === input.supersedes) : null;
          if (input.supersedes && (!previous || previous.decisionId !== d.id || state.feedback.some(f => f.supersedes === previous.id))) fail('訂正対象が最新ではないか、別の決定の結果です。', 409);
          const f = { id: randomUUID(), decisionId: d.id, topicId: d.topicId, author: input.author,
            recordedBy: 'Ken', content: text(input.content, '結果・感想'), summary: optional(input.summary, '要約'),
            verdict, evidence: optional(input.evidence, '根拠'), nextAction: optional(input.nextAction, '次の一歩'),
            supersedes: previous?.id ?? null, createdAt: now() };
          state.feedback.push(f); return f.id;
        }
        case 'setDecisionStatus': {
          if (!state.decisions.some(d => d.id === input.decisionId)) fail('対象の決定が見つかりません。', 404);
          if (!['testing', 'confirmed', 'review', 'stopped'].includes(input.status)) fail('方針の状態が不正です。');
          const event = { id: randomUUID(), decisionId: input.decisionId, status: input.status, reason: text(input.reason, '変更理由', 5000), author: 'Ken', createdAt: now() };
          state.statusHistory.push(event); return event.id;
        }
        case 'addVerificationNote': {
          if (!state.decisions.some(d => d.id === input.decisionId)) fail('対象の決定が見つかりません。', 404);
          const n = { id: randomUUID(), decisionId: input.decisionId, content: text(input.content, '確認の目安', 5000), author: 'Ken', createdAt: now() };
          state.verificationNotes.push(n); return n.id;
        }
        default: fail('対応していない操作です。');
      }
    }, context.actor || 'Ken');
  }
  function postDirect(input, grant) {
    if (!AI_PEOPLE.includes(grant.author) || !grant.topics.includes(input.topicId)) fail('この議題への投稿は許可されていません。', 403);
    const requestId = text(input.requestId, '再送ID', 120);
    if (!/^[a-zA-Z0-9_-]{8,120}$/.test(requestId)) fail('再送IDは8〜120文字の英数字・ハイフン・アンダースコアで指定してください。');
    const fingerprint = createHash('sha256').update(JSON.stringify([input.topicId, input.round, input.content, input.references ?? []])).digest('hex');
    const old = read().posts.find(p => p.clientId === grant.id && p.requestId === requestId);
    if (old) {
      if (old.fingerprint !== fingerprint) fail('同じ再送IDで内容が変更されています。', 409);
      return old;
    }
    const { result, state } = dispatch({ ...input, action: 'post', author: grant.author }, { actor: grant.author, clientId: grant.id, requestId, fingerprint, transport: grant.transport });
    return state.posts.find(p => p.id === result);
  }
  return { read, dispatch, postDirect, close: () => db.close() };
}
