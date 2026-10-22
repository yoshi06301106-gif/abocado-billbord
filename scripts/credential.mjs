// Run by Ken on the board host. No public credential-issuing endpoint.
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/store.mjs';
import { openAccess } from '../lib/access.mjs';

export function createCredentialFile({ database, output, url, author = 'Ludy', topics, ttl = 3600, readOnly = false }) {
  const target = resolve(output);
  if (!target.endsWith('.credential.json')) throw new Error('保存先は *.credential.json にしてください。');
  if (existsSync(target)) throw new Error('既存の認証ファイルは上書きしません。別の名前を指定してください。');
  if (!existsSync(database)) throw new Error('既存のBOARD_DBを指定してください。先に掲示板で議題を作成してください。');
  // Validate origin before opening the database or issuing a credential.
  const origin = new URL(url);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('--urlはHTTPSオリジンにしてください。');
  const store = openStore(database), access = openAccess(database);
  let credential;
  try {
    credential = access.issueCredential({ author, topics, validTopics: store.read().topics.filter(t => !t.archived).map(t => t.id), resource: `${origin.origin}/mcp`, ttl, readOnly });
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(credential, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    catch (e) { access.revoke(credential.grant_id); throw e; }
    return { path: target, grant_id: credential.grant_id, expires_at: credential.expires_at };
  } finally { access.close(); store.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { url: { type: 'string' }, topic: { type: 'string', multiple: true }, author: { type: 'string', default: 'Ludy' }, out: { type: 'string', default: '.runtime/ludy.credential.json' }, ttl: { type: 'string', default: '3600' }, 'read-only': { type: 'boolean', default: false } } });
    const database = process.env.BOARD_DB ? resolve(process.env.BOARD_DB) : fileURLToPath(new URL('../data/board.sqlite', import.meta.url));
    const result = createCredentialFile({ database, output: values.out, url: values.url, author: values.author, topics: values.topic, ttl: Number(values.ttl), readOnly: values['read-only'] });
    console.log(`認証ファイル: ${result.path}\n接続ID: ${result.grant_id}\n期限: ${result.expires_at}\n秘密値は表示しません。掲示板の「AI接続」で解除できます。`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
