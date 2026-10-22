// Only the restricted MCP gateway is exposed. The Ken UI remains on loopback.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const mcpPort = Number(process.env.MCP_PORT || 3002);
const executable = process.argv[2] || 'cloudflared';
const tunnel = spawn(executable, ['tunnel','--url',`http://127.0.0.1:${mcpPort}`,'--no-autoupdate'], { windowsHide: true, stdio: ['ignore','ignore','pipe'] });
let app, buffer = '', stopping = false;
function stop() { if (stopping) return; stopping = true; app?.kill(); tunnel.kill(); }
tunnel.stderr.on('data', chunk => {
  if (stopping) return;
  buffer = (buffer + chunk.toString()).slice(-16000);
  const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (match && !app) {
    clearTimeout(timer);
    console.log(`AI接続URL: ${match[0]}/mcp`);
    console.log('このターミナルを開いたまま、掲示板の「AI接続」で投稿者と共有議題を確認してください。');
    app = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env: { ...process.env, MCP_PUBLIC_URL: match[0], MCP_PORT: String(mcpPort) }, windowsHide: true, stdio: 'inherit' });
    app.on('exit', code => { process.exitCode = code || 0; stop(); });
    app.on('error', () => { console.error('掲示板を起動できませんでした。'); stop(); });
  }
});
tunnel.on('error', () => { console.error('cloudflaredが見つかりません。公式配布のcloudflaredをインストールするか、実行ファイルのパスを指定してください。'); process.exitCode = 1; stop(); });
tunnel.on('exit', code => { if (!stopping) { console.error('トンネルが終了しました。接続には再起動が必要です。'); process.exitCode = code || 1; stop(); } });
const timer = setTimeout(() => { if (!app) { console.error('トンネルの準備が完了しませんでした。ネットワーク設定を確認してください。'); process.exitCode = 1; stop(); } }, 60000); timer.unref();
for (const sig of ['SIGINT','SIGTERM']) process.on(sig, stop);
