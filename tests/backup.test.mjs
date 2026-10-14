import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/store.mjs';

test('live SQLite backup restores the full state and refuses to overwrite an existing backup', () => {
  const folder = mkdtempSync(join(tmpdir(), 'abocado-backup-test-'));
  const file = join(folder, 'board.sqlite'), dest = join(folder, 'backup.sqlite');
  const script = fileURLToPath(new URL('../scripts/backup.mjs', import.meta.url));
  let store, restored;
  try {
    store = openStore(file);
    store.dispatch({ action: 'createTopic', revision: 0, title: '既存データ 🎶', brief: '消さずに保全する' });
    const saved = store.read();
    execFileSync(process.execPath, [script, dest], { env: { ...process.env, BOARD_DB: file }, stdio: 'pipe' });
    restored = openStore(dest); assert.deepEqual(restored.read(), saved); restored.close(); restored = null;
    assert.throws(() => execFileSync(process.execPath, [script, dest], { env: { ...process.env, BOARD_DB: file }, stdio: 'pipe' }), /出力先が存在/);
    assert.deepEqual(store.read(), saved);
  } finally { restored?.close(); store?.close(); rmSync(folder, { recursive: true, force: true }); }
});
