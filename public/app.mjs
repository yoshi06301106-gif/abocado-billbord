import { createFeatures } from './features.mjs';
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stamp = value => new Date(value).toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const people = ['Ken', 'Love', 'Ludy', 'Tina'];
const names = ['', '独立案', 'レビュー', '最終案'];
const descriptions = ['', 'まずはそれぞれの視点で。ほかの案を読まず、独立したアイデアを投稿してください。', '独立案を読み、良い点・懸念点・改善策を具体的にレビューします。', 'レビューを踏まえ、実行できる最終案と次の一歩をまとめます。'];
let state, token, selected, view = 'board', shownRound = 1, archived = false, query = '', author = 'Love', dialogSave, dialogRevision;
let noticeTimer;
const drafts = new Map();
const features = createFeatures({ getState: () => state, api, change, render, notify, keepDraft, editor, field: (...args) => field(...args), escape, stamp });
function notify(message, error = false) {
  const box = $('#notice'); box.textContent = message; box.className = `visible${error ? ' error' : ''}`;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { box.className = ''; }, error ? 12000 : 4500);
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'X-Board-Token': token, ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '接続に失敗しました。');
  return data;
}
async function change(action, fields, revision = state.revision) {
  const response = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, revision, ...fields }) });
  state = response.state; return response.result;
}
function topic() { return state.topics.find(t => t.id === selected); }
function roundComplete(t) { return people.slice(1).every(a => state.posts.some(p => p.topicId === t.id && p.round === t.round && p.author === a)); }
const avatar = a => `<span class="avatar ${a}">${a.slice(0, 1)}</span>`;
function references(ids) {
  return ids.length ? `<div class="refs">参照：${ids.map(id => { const p = state.posts.find(p => p.id === id); return `<span>${p ? escape(`${p.author} / R${p.round} · ${p.content.slice(0, 45)}`) : '不明な投稿'}</span>`; }).join('')}</div>` : '';
}
function postCard(p) {
  return `<article class="post"><div class="post-head">${avatar(p.author)}<strong>${p.author}</strong><small>${p.source === 'mcp' ? 'MCP経由・許可した接続から投稿' : p.source === 'api' ? 'API経由・許可した接続から投稿' : '手動で記録'}</small><time datetime="${p.createdAt}">${stamp(p.createdAt)}</time></div><p class="prose">${escape(p.content)}</p>${references(p.references)}</article>`;
}
function checks(posts, name = 'references') {
  return `<div class="checkboxes">${posts.map(p => `<label><input type="checkbox" name="${name}" value="${p.id}"><span><strong>${p.author}</strong> / R${p.round} — ${escape(p.content.slice(0, 150))}</span></label>`).join('')}</div>`;
}
function render() {
  $('#app').innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><span class="logo">●</span><div>abocado<small>MULTI AI BOARD</small></div></div><nav class="nav" aria-label="メイン"><button data-view="board" class="${view === 'board' ? 'active' : ''}">▤ 議題ボード</button><button data-view="memory" class="${view === 'memory' ? 'active' : ''}">◇ メモリー</button><button data-view="history" class="${view === 'history' ? 'active' : ''}">◷ 決定履歴</button><button data-view="connections" class="${view === 'connections' ? 'active' : ''}">⇄ AI接続</button></nav><div class="sidebar-info"><strong><span class="dot"></span>手動＋許可したAIの投稿</strong>外部接続は「AI接続」で確認できます。接続からの投稿はMCP・API経由と表示します。<br>保存先：このPCのSQLite</div></aside><main class="main"><div class="topline"><span>WORKSPACE / abocadoプロジェクト</span><div class="top-actions"><button class="quiet small" data-refresh>再読み込み</button><button class="secondary small" data-export>バックアップ ↓</button></div></div>${view === 'board' ? board() : view === 'memory' ? memoryView() : view === 'connections' ? features.connectionsView() : historyView()}<footer class="footer">abocado · アイデアを持ち寄り、Kenが決める。 / ローカルMVP</footer></main></div>`;
  bind(); features.bind();
}
function board() {
  const topics = state.topics.filter(t => t.archived === archived && `${t.title} ${t.brief}`.toLowerCase().includes(query.toLowerCase()));
  return `<div class="heading"><div><div class="eyebrow">From ideas to decisions</div><h1>みんなの案を、ひとつの決定へ。</h1><p class="muted">独立した視点を重ねて、プロジェクトの次の一歩を。</p></div><button data-new-topic>＋ 新しい議題</button></div><div class="participants">${people.map(a => `<div class="person-card">${avatar(a)}<div><strong>${a}</strong><small>${a === 'Ken' ? 'オーナー · 最終決定' : '接続はAI接続で確認'}</small></div></div>`).join('')}</div><div class="workspace"><section class="panel list-panel" aria-label="議題一覧"><div class="list-header"><span>議題 <span class="badge">${topics.length}</span></span><button class="quiet small" data-archives>${archived ? '進行中を見る' : '保管済み'}</button></div><input class="search" id="search" aria-label="議題を検索" placeholder="議題を検索…" value="${escape(query)}">${topics.map(t => `<button class="topic-item ${t.id === selected ? 'selected' : ''}" data-topic="${t.id}"><strong>${escape(t.title)}</strong><span>${t.status === 'decided' ? '✓ 決定済み' : `Round ${t.round} · ${names[t.round]}`}　${stamp(t.updatedAt)}</span></button>`).join('') || '<p class="muted">議題はまだありません。</p>'}</section><section class="panel" aria-label="議題の詳細">${topic() ? detail(topic()) : `<div class="empty"><div class="empty-icon">◇</div><h2>最初の議題をはじめましょう</h2><p>相談したいこと、決めたいことをひとつ。<br>Love・Ludy・Tinaの視点をここに集めます。</p><button data-new-topic>＋ 議題を作成</button></div>`}</section></div>`;
}
function detail(t) {
  const posts = state.posts.filter(p => p.topicId === t.id && p.round === shownRound);
  const decisions = state.decisions.filter(d => d.topicId === t.id);
  const d = decisions.at(-1);
  const missing = people.slice(1).filter(a => !state.posts.some(p => p.topicId === t.id && p.round === t.round && p.author === a));
  return `<div class="detail-top"><div><span class="badge ${d ? 'done' : ''}">${t.archived ? '保管済み' : d ? '✓ Kenが決定済み' : '議論中'}</span><h2>${escape(t.title)}</h2></div><div><button class="quiet small" data-edit-topic ${t.archived || d ? 'disabled' : ''}>編集</button><button class="quiet small" data-archive>${t.archived ? '議題を戻す' : '保管する'}</button></div></div><p class="prose brief">${escape(t.brief)}</p><div class="rounds">${[1, 2, 3].map(r => `<button class="round ${shownRound === r ? 'active' : ''}" data-round="${r}" ${r > t.round ? 'disabled' : ''}>${r < t.round ? '✓ ' : ''}ROUND ${r}<b>${names[r]}</b></button>`).join('')}</div><div class="round-info">${descriptions[shownRound]}<br>現在：Round ${t.round} ${missing.length ? ` / ${missing.join('・')}の投稿待ち` : ' / 3人の投稿が揃いました'}</div><div class="section-title"><h3>${names[shownRound]} <span class="badge">${posts.length} 投稿</span></h3><button class="secondary small" data-copy>AI用の依頼文をコピー</button></div>${shownRound === 1 && t.round === 1 ? '<details><summary class="muted">独立案の投稿を見る（ほかの案を読まずに投稿してください）</summary>' : ''}${posts.map(postCard).join('') || '<p class="empty muted">まだ投稿がありません。各AIの回答を手動で記録しましょう。</p>'}${shownRound === 1 && t.round === 1 ? '</details>' : ''}${!t.archived && !d && shownRound === t.round ? composer(t) : ''}${!t.archived && !d && t.round < 3 ? `<div class="form-footer"><span class="muted">3人の投稿が揃うと、次に進めます。</span><button data-advance ${roundComplete(t) ? '' : 'disabled'}>Round ${t.round + 1}へ進む →</button></div>` : ''}${!t.archived && t.round === 3 ? `<div class="decision">${d ? `<h3>✓ Kenの決定</h3><p class="prose">${escape(d.content)}</p><p class="prose muted">理由：${escape(d.reason)}</p>${references(d.references)}<p class="muted">${stamp(d.createdAt)} · 決定履歴 ${decisions.length}件</p><button class="secondary small" data-memory-decision="${d.id}">メモリーに残す</button> <button class="quiet small" data-decide>決定を改訂する</button>` : `<h3>最後は、Kenが決める。</h3><p class="muted">最終案を選び、決定内容と理由を残しましょう。</p><button data-decide ${roundComplete(t) ? '' : 'disabled'}>Kenの決定を記録</button>`}</div>` : ''}${features.timeline(t)}`;
}
function composer(t) {
  const draft = drafts.get(`${t.id}:${t.round}`) || { content: '', references: [], author };
  return `<form id="post-form" class="composer"><h3>投稿を記録する</h3><p class="muted">AIが自動で投稿する機能はありません。Kenの意見も記録できます。</p><label for="author">投稿者</label><select id="author" name="author">${people.map(a => `<option ${a === draft.author ? 'selected' : ''}>${a}</option>`).join('')}</select><label for="content">${names[t.round]}の内容</label><textarea id="content" name="content" required maxlength="20000" placeholder="AIの回答を貼り付ける、またはKenの意見を書く…">${escape(draft.content)}</textarea>${t.round > 1 ? `<label>参照した${names[t.round - 1]}（1件以上）</label>${checks(state.posts.filter(p => p.topicId === t.id && p.round === t.round - 1))}` : ''}<div class="form-footer"><span class="muted">保存済みの投稿は履歴として残ります。</span><button type="submit">投稿を保存</button></div></form>`;
}
function memoryView() {
  return `<div class="heading"><div><div class="eyebrow">Project memory</div><h1>積み重ねたことを、次の議題へ。</h1><p class="muted">共通方針・制約・決定を保存。AI用の依頼文にも含まれます。</p></div><button data-new-memory>＋ メモリーを追加</button></div><div class="memory-grid">${state.memories.map(m => `<article class="panel memory-card"><header><h2>${escape(m.title)}</h2><button class="quiet small" data-edit-memory="${m.id}">編集</button></header><p class="prose">${escape(m.content)}</p><p class="muted">${stamp(m.updatedAt)}${m.decisionId ? ' · Kenの決定から作成' : ''}</p><details class="history"><summary class="muted">変更履歴</summary>${state.memoryHistory.filter(h => h.id === m.id).toReversed().map(h => `<div class="post"><time class="muted">${stamp(h.updatedAt)}</time><h3>${escape(h.title)}</h3><p class="prose">${escape(h.content)}</p></div>`).join('')}</details></article>`).join('') || '<div class="panel empty"><h2>プロジェクトの記憶をここに</h2><p>大切な方針や決定を、次の話し合いに持ち越しましょう。</p></div>'}</div>`;
}
function historyView() {
  return `<div class="heading"><div><div class="eyebrow">Decision log</div><h1>Kenの決定と、その理由。</h1><p class="muted">改訂前の決定も残ります。保管済みの議題も含みます。</p></div></div><section class="panel history">${state.decisions.toReversed().map(d => { const t = state.topics.find(t => t.id === d.topicId); return `<article class="post"><span class="badge">${d.supersedes ? '改訂' : '初回決定'}</span><h2>${escape(t?.title)}</h2><time>${stamp(d.createdAt)} · Ken</time><p class="prose">${escape(d.content)}</p><p class="prose muted">理由：${escape(d.reason)}</p>${references(d.references)}<button class="quiet small" data-memory-decision="${d.id}">メモリーに残す</button><button class="quiet small" data-open-topic="${d.topicId}">議題を見る →</button></article>`; }).join('') || '<div class="empty">まだ決定はありません。3つのラウンドを進めて、最初の決定を残しましょう。</div>'}<details><summary>操作履歴（${state.events.length}件）</summary>${state.events.toReversed().map(e => `<p class="muted">${stamp(e.at)} · ${escape(({ createTopic: '議題を作成', editTopic: '議題を編集', archiveTopic: '議題の保管状態を変更', post: '手動投稿を記録', advance: '次のラウンドへ進行', decide: 'Kenの決定を記録', saveMemory: 'メモリーを保存' })[e.action] || e.action)} · #${e.revision}</p>`).join('')}</details></section>`;
}
function keepDraft() {
  const form = $('#post-form'), t = topic();
  if (form && t) drafts.set(`${t.id}:${t.round}`, { content: form.elements.content.value, author: form.elements.author.value, references: [...form.querySelectorAll('[name="references"]:checked')].map(e => e.value) });
}
function bind() {
  document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { keepDraft(); view = b.dataset.view; render(); if (view === 'connections') features.loadConnections(); });
  document.querySelectorAll('[data-new-topic]').forEach(b => b.onclick = () => topicEditor());
  document.querySelectorAll('[data-topic],[data-open-topic]').forEach(b => b.onclick = () => { keepDraft(); selected = b.dataset.topic || b.dataset.openTopic; shownRound = topic().round; view = 'board'; archived = topic().archived; render(); });
  document.querySelectorAll('[data-round]').forEach(b => b.onclick = () => { keepDraft(); shownRound = Number(b.dataset.round); render(); });
  document.querySelectorAll('[data-memory-decision]').forEach(b => b.onclick = () => memoryEditor(null, b.dataset.memoryDecision));
  document.querySelectorAll('[data-edit-memory]').forEach(b => b.onclick = () => memoryEditor(b.dataset.editMemory));
  if ($('[data-new-memory]')) $('[data-new-memory]').onclick = () => memoryEditor();
  if ($('[data-edit-topic]')) $('[data-edit-topic]').onclick = () => topicEditor(topic());
  if ($('[data-archives]')) $('[data-archives]').onclick = () => { keepDraft(); archived = !archived; selected = state.topics.find(t => t.archived === archived)?.id; shownRound = topic()?.round || 1; render(); };
  if ($('#search')) $('#search').oninput = e => { const pos = e.target.selectionStart; keepDraft(); query = e.target.value; render(); $('#search').focus(); $('#search').setSelectionRange(pos, pos); };
  $('[data-refresh]').onclick = async () => { keepDraft(); try { state = await api('/api/state'); shownRound = Math.min(shownRound, topic()?.round || 1); render(); notify('最新の保存内容を読み込みました。入力中の投稿は保持しています。'); } catch (e) { notify(e.message, true); } };
  $('[data-export]').onclick = async () => { try { const data = await api('/api/export'); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `abocado-${new Date().toISOString().replace(/[:.]/g, '-')}.backup.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notify('バックアップを書き出しました。'); } catch (e) { notify(e.message, true); } };
  if ($('[data-archive]')) $('[data-archive]').onclick = async () => { keepDraft(); try { await change('archiveTopic', { topicId: selected, archived: !topic().archived }); archived = topic().archived; render(); notify(archived ? '議題を保管しました。投稿はすべて残っています。' : '議題を戻しました。'); } catch (e) { notify(e.message, true); } };
  if ($('[data-advance]')) $('[data-advance]').onclick = async () => { keepDraft(); try { await change('advance', { topicId: selected }); shownRound = topic().round; render(); notify(`Round ${shownRound}に進みました。`); } catch (e) { notify(e.message, true); } };
  if ($('[data-copy]')) $('[data-copy]').onclick = copyContext;
  if ($('[data-decide]')) $('[data-decide]').onclick = decisionEditor;
  const form = $('#post-form');
  if (form) {
    const draft = drafts.get(`${selected}:${topic().round}`);
    form.querySelectorAll('[name="references"]').forEach(e => { e.checked = draft?.references.includes(e.value) || false; });
    form.oninput = keepDraft;
    form.onsubmit = async e => {
      e.preventDefault(); keepDraft(); const data = new FormData(form); const t = topic(); const revision = state.revision;
      const controls = [...form.elements]; controls.forEach(c => { c.disabled = true; });
      try { author = data.get('author'); await change('post', { topicId: t.id, round: t.round, author, content: data.get('content'), references: data.getAll('references') }, revision); drafts.delete(`${t.id}:${t.round}`); render(); notify('手動投稿を保存しました。'); } catch (error) { notify(error.message, true); } finally { controls.forEach(c => { c.disabled = false; }); }
    };
  }
}
function editor(title, fields, save) {
  dialogRevision = state.revision;
  $('#editor-fields').innerHTML = `<h2>${title}</h2>${fields}`; dialogSave = save; $('#editor-submit').hidden = !save; $('#cancel').textContent = save ? 'キャンセル' : '閉じる'; $('#editor').showModal();
}
const field = (name, label, value = '', multiline = false, max = 20000) => `<label for="edit-${name}">${label}</label>${multiline ? `<textarea id="edit-${name}" name="${name}" required maxlength="${max}">${escape(value)}</textarea>` : `<input id="edit-${name}" name="${name}" required maxlength="${max}" value="${escape(value)}">`}`;
function topicEditor(t) {
  editor(t ? '議題を編集' : '新しい議題', `${field('title', '議題名', t?.title, false, 200)}${field('brief', '背景・目的・決めたいこと', t?.brief, true)}`, async data => {
    const id = await change(t ? 'editTopic' : 'createTopic', { topicId: t?.id, title: data.get('title'), brief: data.get('brief') }, dialogRevision);
    keepDraft(); selected = id; shownRound = topic().round; view = 'board'; archived = false;
  });
}
function memoryEditor(id, decisionId) {
  const m = state.memories.find(m => m.id === id); const d = state.decisions.find(d => d.id === decisionId); const t = d && state.topics.find(t => t.id === d.topicId);
  editor(m ? 'メモリーを編集' : 'メモリーを追加', `${field('title', 'メモリー名', m?.title ?? t?.title, false, 200)}${field('content', '次の議題に引き継ぐこと', m?.content ?? (d ? `${d.content}\n\n理由：${d.reason}` : ''), true)}<p class="muted">変更前の内容も履歴に残ります。</p>`, async data => {
    await change('saveMemory', { memoryId: id, decisionId, title: data.get('title'), content: data.get('content') }, dialogRevision); keepDraft(); view = 'memory';
  });
}
function decisionEditor() {
  const t = topic(); const d = state.decisions.filter(d => d.topicId === t.id).at(-1);
  editor(d ? 'Kenの決定を改訂' : 'Kenの決定を記録', `${field('content', '決定内容', d?.content, true)}${field('reason', '決定理由', d?.reason, true)}<label>採用・参考にした最終案（1件以上）</label>${checks(state.posts.filter(p => p.topicId === t.id && p.round === 3))}<p class="muted">Kenとして記録します。改訂前の決定も保持します。</p>`, async data => {
    await change('decide', { topicId: t.id, author: 'Ken', content: data.get('content'), reason: data.get('reason'), references: data.getAll('references') }, dialogRevision); shownRound = 3; keepDraft();
  });
  if (d) $('#editor').querySelectorAll('[name="references"]').forEach(e => { e.checked = d.references.includes(e.value); });
}
async function copyContext() {
  const t = topic();
  const content = [`abocadoプロジェクト / ${t.title}`, `現在の依頼: Round ${t.round} ${names[t.round]}`, t.brief, descriptions[t.round],
    '\nプロジェクトメモリー', ...state.memories.map(m => `${m.title}\n${m.content}`),
    ...(t.round > 1 ? ['\nこれまでの投稿', ...state.posts.filter(p => p.topicId === t.id && p.round < t.round).map(p => `Round ${p.round} / ${p.author}\n${p.content}`)] : []),
    '\n提案を文章で回答してください。外部への操作や自動投稿は行わず、Kenが回答を手動で記録します。'].join('\n\n');
  try { await navigator.clipboard.writeText(content); notify('依頼文をコピーしました。対象のAIに貼り付けてください。'); }
  catch { editor('AI用の依頼文', `${field('context', 'コピーしてAIに貼り付けてください', content, true)}<p class="muted">この画面の内容は保存されません。</p>`, null); }
}
$('#cancel').onclick = () => $('#editor').close();
$('#editor-form').onsubmit = async e => {
  e.preventDefault(); const b = $('#editor-submit'); b.disabled = true;
  try { if (!dialogSave) { $('#editor').close(); return; } await dialogSave(new FormData(e.target), dialogRevision); $('#editor').close(); render(); notify('保存しました。'); }
  catch (error) { notify(error.message, true); }
  finally { b.disabled = false; }
};
try {
  const session = await api('/api/session'); token = session.token; state = await api('/api/state');
  selected = state.topics.find(t => !t.archived)?.id; shownRound = topic()?.round || 1; render();
} catch (error) { $('#app').innerHTML = `<div class="panel error-panel"><h1>接続できませんでした</h1><p>${escape(error.message)}</p><p>アプリが起動していることを確認し、この画面を再読み込みしてください。</p></div>`; }
