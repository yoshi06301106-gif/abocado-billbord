import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../lib/store.mjs';

test('feedback is version-specific, corrections append, and outcomes never change Ken decisions', () => {
  const s = openStore(':memory:');
  const act = (action, input) => s.dispatch({ action, revision: s.read().revision, ...input });
  try {
    const topicId = act('createTopic',{title:'検証',brief:'背景'}).result;
    let refs = [];
    for (const round of [1,2,3]) {
      const next = ['Love','Ludy','Tina'].map(author => act('post',{topicId,round,author,content:`${author}案`,references:refs}).result);
      refs = next; if (round < 3) act('advance',{topicId});
    }
    const d1 = act('decide',{topicId,author:'Ken',content:'初案を試す',reason:'理由',references:refs}).result;
    const f1 = act('addFeedback',{decisionId:d1,author:'Ken',content:'まだ判断できない'}).result;
    assert.equal(s.read().feedback[0].verdict,'unrated'); assert.equal(s.read().statusHistory.length,0);
    const d2 = act('decide',{topicId,author:'Ken',content:'改訂を試す',reason:'見直し',references:refs}).result;
    const f2 = act('addFeedback',{decisionId:d1,author:'Ken',content:'旧案の試験は失敗',verdict:'bad',supersedes:f1}).result;
    assert.equal(s.read().feedback[1].decisionId,d1); assert.equal(s.read().feedback[1].supersedes,f1);
    assert.equal(s.read().statusHistory.length,0); assert.equal(s.read().decisions.at(-1).id,d2);
    assert.throws(() => act('addFeedback',{decisionId:d2,author:'Ken',content:'別版に移す',supersedes:f2}),/別の決定/);
    assert.throws(() => act('addFeedback',{decisionId:d1,author:'Ken',content:'古い訂正対象',supersedes:f1}),/最新/);
    act('setDecisionStatus',{decisionId:d1,status:'review',reason:'Kenが見直しと判断'});
    act('setDecisionStatus',{decisionId:d1,status:'stopped',reason:'Kenが中止'});
    act('addVerificationNote',{decisionId:d2,content:'1週間後に使いやすさを確認'});
    assert.equal(s.read().statusHistory.length,2); assert.equal(s.read().verificationNotes[0].decisionId,d2);
    assert.equal(s.read().feedback[0].content,'まだ判断できない');
  } finally { s.close(); }
});
test('v1 data upgrades additively without changing old posts and decisions', () => {
  const folder = mkdtempSync(join(tmpdir(),'abocado-v1-')), file = join(folder,'old.sqlite');
  const old = { schemaVersion:1,revision:7,topics:[{id:'old',title:'元データ'}],posts:[{id:'p',content:'過去の原文'}],decisions:[],memories:[],memoryHistory:[],events:[] };
  const db = new DatabaseSync(file); db.exec('CREATE TABLE state(id INTEGER PRIMARY KEY,json TEXT NOT NULL); PRAGMA user_version=1;'); db.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify(old)); db.close();
  try { const store = openStore(file); const data = store.read(); assert.deepEqual(data.posts,old.posts); assert.deepEqual(data.topics,old.topics); assert.equal(data.revision,7); assert.deepEqual(data.feedback,[]); store.close(); }
  finally { rmSync(folder,{recursive:true,force:true}); }
});
