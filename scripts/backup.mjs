import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = process.env.BOARD_DB ? resolve(process.env.BOARD_DB) : resolve(root, 'data/board.sqlite');
const dest = resolve(process.argv[2] || resolve(root, `data/backups/board-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`));
if (!existsSync(source)) throw new Error('保存データがありません。先にアプリを起動してください。');
if (existsSync(dest)) throw new Error('出力先が存在します。上書きせず別のファイル名を選んでください。');
mkdirSync(dirname(dest), { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
try { await backup(db, dest); console.log(`バックアップを保存しました: ${dest}`); }
finally { db.close(); }
