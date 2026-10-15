export function createFeatures(env) {
  const { getState, api, change, render, notify, keepDraft, editor, field, escape: esc, stamp } = env;
  let connections = null;
  const verdicts = { unrated: '未評価', good: '想定通り', mixed: '課題あり', bad: '想定と違った' };
  const statuses = { testing: '試行中', confirmed: '継続採用', review: '見直し', stopped: '中止' };
  const title = id => getState().topics.find(t => t.id === id)?.title || '議題';
  function timeline(t) {
    const s = getState(), decisions = s.decisions.filter(d => d.topicId === t.id).toReversed();
    if (!decisions.length) return '';
    return `<section class="outcomes"><div class="section-title"><h2>決めたこと、その後のこと</h2></div><p class="muted">結果と方針変更を分けて記録します。以前の決定に対する結果も、その版に残ります。</p>${decisions.map((d, i) => {
      const feedback = s.feedback.filter(f => f.decisionId === d.id);
      const currentFeedback = feedback.filter(f => !feedback.some(next => next.supersedes === f.id));
      const status = s.statusHistory.filter(h => h.decisionId === d.id).at(-1);
      const items = [ ...feedback.map(f => ({ ...f, kind: 'feedback' })), ...s.statusHistory.filter(h => h.decisionId === d.id).map(h => ({ ...h, kind: 'status' })), ...s.verificationNotes.filter(n => n.decisionId === d.id).map(n => ({ ...n, kind: 'note' })) ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const evaluated = currentFeedback.filter(f => f.verdict !== 'unrated').length;
      return `<details class="decision-version" ${i === 0 ? 'open' : ''}><summary>${i === 0 ? '最新の決定' : '以前の決定'} · ${stamp(d.createdAt)} <span class="badge">${status ? statuses[status.status] : '方針の状態：未設定'}</span> <span class="badge">${currentFeedback.length ? `結果 ${currentFeedback.length}件・評価済み ${evaluated}件` : '結果未記録'}</span></summary><p class="prose">${esc(d.content)}</p><p class="prose muted">決定理由：${esc(d.reason)}</p><p class="record-id">決定ID：${d.id}</p><div class="outcome-actions"><button class="secondary small" data-feedback="${d.id}">＋ 結果・感想を残す</button><button class="quiet small" data-status="${d.id}">Kenの方針を記録</button><button class="quiet small" data-verification="${d.id}">確認の目安を残す</button></div><div class="timeline">${items.map(item => {
        if (item.kind === 'status') return `<article class="timeline-entry"><strong>Kenの方針：${statuses[item.status]}</strong><time>${stamp(item.createdAt)}</time><p class="prose">${esc(item.reason)}</p></article>`;
        if (item.kind === 'note') return `<article class="timeline-entry"><strong>確認の目安 · Ken</strong><time>${stamp(item.createdAt)}</time><p class="prose">${esc(item.content)}</p></article>`;
        const superseded = feedback.some(f => f.supersedes === item.id);
        return `<article class="timeline-entry ${superseded ? 'superseded' : ''}"><header><strong>${esc(item.author)}の結果・感想</strong><span class="badge">${verdicts[item.verdict]}</span>${superseded ? '<span class="badge">訂正前・履歴</span>' : item.supersedes ? '<span class="badge">訂正版</span>' : ''}</header><time>${stamp(item.createdAt)} · 記録者 Ken</time>${item.summary ? `<p class="prose">${esc(item.summary)}</p><p class="muted">要約・整理：Kenによる記録</p><details><summary>発言の原文を見る</summary><p class="prose">${esc(item.content)}</p></details>` : `<p class="prose">${esc(item.content)}</p>`}${item.evidence ? `<p class="prose muted">根拠・抜粋：${esc(item.evidence)}</p>` : ''}${item.nextAction ? `<p class="prose muted">次の一歩：${esc(item.nextAction)}</p>` : ''}${!superseded ? `<button class="quiet small" data-correct-feedback="${item.id}">履歴を残して訂正</button>` : ''}</article>`;
      }).join('') || '<p class="muted">試した結果を、短い一言から残せます。</p>'}</div></details>`;
    }).join('')}</section>`;
  }
  function feedbackEditor(decisionId, correctionId) {
    keepDraft(); const s = getState(), old = s.feedback.find(f => f.id === correctionId);
    const select = (name, label, options, value) => `<label for="extra-${name}">${label}</label><select name="${name}" id="extra-${name}">${Object.entries(options).map(([key, text]) => `<option value="${key}" ${value === key ? 'selected' : ''}>${text}</option>`).join('')}</select>`;
    editor(old ? '結果・感想を訂正（旧版は残ります）' : '結果・感想を残す',
      `<p class="muted">対象の決定：${esc(s.decisions.find(d => d.id === decisionId)?.content.slice(0, 100))}<br>結果を保存しても、Kenの方針は変わりません。</p>${select('author', '発言者', { Ken:'Ken', Love:'Love', Ludy:'Ludy', Tina:'Tina' }, old?.author || 'Ken')}${field('content', '実際にどうだった？（原文・必須）', old?.content, true)}${select('verdict', '評価（未評価でも保存できます）', verdicts, old?.verdict || 'unrated')}<details><summary>要約・根拠・次の一歩（任意）</summary>${optional('summary','要約（原文と分けて記録）',old?.summary)}${optional('evidence','根拠・URL・コミットID・テキスト抜粋',old?.evidence)}${optional('nextAction','次の一歩',old?.nextAction)}</details>`,
      async (data, revision) => { await change('addFeedback', { decisionId, supersedes: correctionId, ...Object.fromEntries(data) }, revision); });
  }
  const optional = (name, label, value = '') => `<label for="opt-${name}">${label}</label><textarea id="opt-${name}" name="${name}" maxlength="5000">${esc(value || '')}</textarea>`;
  function statusEditor(decisionId) {
    keepDraft();
    editor('Kenの方針を記録', `<p class="muted">この操作はKenの判断として記録します。変更前の方針も履歴に残ります。</p><label for="decision-status">方針</label><select id="decision-status" name="status">${Object.entries(statuses).map(([key,label]) => `<option value="${key}">${label}</option>`).join('')}</select>${field('reason','その理由（必須）','',true,5000)}`, async (data, revision) => { await change('setDecisionStatus', { decisionId, ...Object.fromEntries(data) }, revision); });
  }
  function connectionsView() {
    const c = connections;
    return `<div class="heading"><div><div class="eyebrow">AI connections</div><h1>それぞれのAIから、この掲示板へ。</h1><p class="muted">投稿者と共有する議題をKenが選んで許可します。有料AI APIを呼び出す機能はありません。</p></div><button class="secondary" data-load-connections>接続状況を更新</button></div><section class="panel"><h2>接続するURL</h2>${c?.mcpUrl ? `<p class="prose endpoint">${esc(c.mcpUrl)}</p><p class="muted">Gemini・Grokのカスタム接続に登録します。登録後、この画面で接続先と共有範囲を確認してください。</p>` : '<p class="muted">外部接続は停止中です。通常の掲示板は使えます。READMEの「無料のAI接続テスト」に沿って接続口を起動するとURLが表示されます。</p>'}<p class="muted">接続の許可と、AI本人の投稿成功は別です。AIに議題を読ませて投稿し、保存結果を読み返すまで、成功とは表示しません。</p></section><div class="connection-grid"><section class="panel"><h2>確認待ちの接続</h2>${!c ? '<p class="muted">接続状況を読み込みます…</p>' : c.pending.map(p => `<article class="post"><h3>${esc(p.clientName)}</h3><p class="prose muted">戻り先：${esc(p.redirect)}<br>要求する権限：${esc(p.scope)}</p><p class="muted">名前は接続元の自己申告です。自分が開始した接続か、戻り先も確認してください。</p><button class="small" data-approve="${p.id}">共有範囲を選んで許可</button> <button class="quiet small" data-deny="${p.id}">拒否</button></article>`).join('') || '<p class="muted">確認待ちはありません。</p>'}</section><section class="panel"><h2>許可した接続</h2>${c?.grants.map(g => `<article class="post"><h3>${g.author} · ${esc(g.clientName)}</h3><span class="badge">${g.revoked ? '解除済み' : '許可済み'}</span><p class="muted">${g.lastUsedAt ? `認証した通信あり：${stamp(g.lastUsedAt)}` : '認証した通信はまだありません'}<br>共有議題：${g.topics.map(id => esc(title(id))).join('、')}</p><p class="muted">MCP投稿：${getState().posts.filter(p => p.clientId === g.id).length}件（保存の読み返しはAI側でも確認してください）</p>${!g.revoked ? `<button class="secondary small" data-revoke="${g.id}">接続を解除</button>` : ''}</article>`).join('') || '<p class="muted">許可した接続はありません。</p>'}</section></div>`;
  }
  async function loadConnections(redraw = true) {
    try { connections = await api('/api/connections'); if (redraw) render(); } catch(e) { notify(e.message, true); }
  }
  function bind() {
    document.querySelectorAll('[data-feedback]').forEach(b => { b.onclick = () => feedbackEditor(b.dataset.feedback); });
    document.querySelectorAll('[data-correct-feedback]').forEach(b => { b.onclick = () => { const f = getState().feedback.find(f => f.id === b.dataset.correctFeedback); feedbackEditor(f.decisionId, f.id); }; });
    document.querySelectorAll('[data-status]').forEach(b => { b.onclick = () => statusEditor(b.dataset.status); });
    document.querySelectorAll('[data-verification]').forEach(b => { b.onclick = () => { keepDraft(); editor('確認の目安を残す',field('content','いつ・何を確認する？','',true,5000), async (data, revision) => { await change('addVerificationNote',{decisionId:b.dataset.verification,content:data.get('content')},revision); }); }; });
    document.querySelectorAll('[data-load-connections]').forEach(b => { b.onclick = () => loadConnections(); });
    document.querySelectorAll('[data-approve]').forEach(b => { b.onclick = () => {
      const pending = connections.pending.find(p => p.id === b.dataset.approve);
      editor('AI接続の許可', `<p class="prose">${esc(pending.clientName)}<br>戻り先：${esc(pending.redirect)}</p><label for="grant-author">この接続の投稿者</label><select name="author" id="grant-author"><option>Love</option><option selected>Ludy</option><option>Tina</option></select><label>共有する議題（1件以上）</label><div class="checkboxes">${getState().topics.filter(t => !t.archived).map(t => `<label><input type="checkbox" name="topics" value="${t.id}"><span>${esc(t.title)}</span></label>`).join('')}</div><p class="muted">選んだ議題の閲覧と本人名義の追記だけを許可します。Kenの決定・削除・他の議題・全メモリーは共有しません。</p>`, async data => { await api('/api/connections/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:pending.id,author:data.get('author'),topics:data.getAll('topics')})}); await loadConnections(false); });
    }; });
    for (const action of ['deny','revoke']) document.querySelectorAll(`[data-${action}]`).forEach(b => { b.onclick = async () => { try { await api(`/api/connections/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:b.dataset[action]})}); await loadConnections(); notify(action === 'revoke' ? '接続を解除しました。保存済み投稿は残っています。' : '接続を拒否しました。'); } catch(e) { notify(e.message,true); } }; });
  }
  return { timeline, bind, connectionsView, loadConnections };
}
