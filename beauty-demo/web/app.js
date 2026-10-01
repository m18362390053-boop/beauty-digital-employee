const $ = id => document.getElementById(id);
const state = { userId: '', productId: '', sessionId: '', card: null, page: 'chat', pending: null, abort: null };
const labels = { AI_ACTIVE: 'AI服务', HANDOFF_PENDING: '等待人工', HUMAN_ACTIVE: '人工处理中', RESOLVED: '已结束' };
const roleNames = { user: '用户', assistant: '客服', human: '人工坐席', system: '系统状态' };
function notify(text) { $('notification').textContent = text; }
function node(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
function action(text, fn) {
  const b = node('button', text); b.type = 'button';
  b.addEventListener('click', () => guarded(fn)); return b;
}
async function guarded(fn) { try { await fn(); } catch (error) { notify(error.message); } }
async function api(path, method = 'GET', body, signal) {
  const response = await fetch(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const result = await response.json();
  if (!response.ok) throw new Error(`${result.error?.code ?? response.status}: ${result.error?.message ?? '请求失败'}`);
  return result;
}
const userPath = () => `/api/users/${encodeURIComponent(state.userId)}`;
const sessionPath = () => `${userPath()}/sessions/${encodeURIComponent(state.sessionId)}`;
function requireSession() { if (!state.sessionId) throw new Error('请先新建或选择会话。'); }
function setPending(value) { state.pending = value; if (value) sessionStorage.setItem('beauty-pending', JSON.stringify(value)); else sessionStorage.removeItem('beauty-pending'); }

async function loadCard(fillForm = true) {
  const userId = state.userId;
  const card = await api(`${userPath()}/card`);
  if (userId !== state.userId) return;
  state.card = card;
  $('memory-preview').replaceChildren(node('p', `用户：${card.userId}`, 'small'), node('p', `偏好：${card.preferences.join('、') || '未填写'}`), node('p', `关注点：${card.concerns.join('、') || '未填写'}`), node('p', `资料版本 ${card.version}`, 'muted small'));
  if (fillForm) {
    $('card-owner').textContent = `${card.userId} · 当前版本 ${card.version}`;
    $('preferences').value = card.preferences.join('\n'); $('concerns').value = card.concerns.join('\n');
    $('confirmed-facts').value = JSON.stringify(card.confirmedFacts, null, 2);
  }
}
async function loadSessions() {
  const { items } = await api(`${userPath()}/sessions`);
  const select = $('session-select'); select.replaceChildren();
  if (!items.some(s => s.sessionId === state.sessionId)) state.sessionId = items.at(-1)?.sessionId ?? '';
  for (const session of items) { const option = node('option', `${session.sessionId.slice(0, 8)} · ${labels[session.status]}`); option.value = session.sessionId; select.append(option); }
  select.value = state.sessionId;
  await loadChat();
}
async function loadChat() {
  if (!state.sessionId) { $('messages').replaceChildren(node('p', '新建一个会话开始。', 'muted')); $('session-status').textContent = '尚无会话'; return; }
  const id = state.sessionId;
  const [context, messages] = await Promise.all([api(`${sessionPath()}/context`), api(`${sessionPath()}/messages?limit=200&offset=0`)]);
  if (id !== state.sessionId) return;
  $('session-status').textContent = labels[context.session.status];
  const box = $('messages'); const stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 70;
  box.replaceChildren();
  if (!messages.items.length) box.append(node('p', '请输入您的咨询，或先在资料卡确认偏好。', 'muted'));
  for (const message of messages.items) {
    const article = node('div', undefined, `message ${message.role}`);
    const kind = message.metadata?.answerKind;
    article.append(node('div', `${roleNames[message.role]}${kind === 'template' ? ' · 明示模板/降级' : kind === 'generated' ? ' · 模型生成' : ''} · ${new Date(message.createdAt).toLocaleTimeString()}`, 'meta'));
    article.append(node('div', message.content));
    if (message.metadata?.sourceRefs?.length) article.append(node('div', `来源：${message.metadata.sourceRefs.join('、')}`, 'small muted'));
    if (['assistant', 'human'].includes(message.role)) {
      const buttons = node('div', undefined, 'actions');
      for (const [text, type] of [['有帮助', 'helpful'], ['没解决', 'unresolved'], ['转人工', 'request_human']]) {
        buttons.append(action(text, async () => {
          const result = await api(`${userPath()}/messages/${message.messageId}/feedback`, 'POST', { type, reason: '' });
          notify(result.prompt ?? '已进入人工流程。'); await loadChat();
        }));
      }
      article.append(buttons);
    }
    box.append(article);
  }
  if (stickToBottom) box.scrollTop = box.scrollHeight;
  if (messages.total > messages.items.length) box.prepend(node('p', '这里只展示前200条，完整记录可通过分页API读取。', 'small'));
}
function showResult(result) {
  $('route-result').textContent = JSON.stringify(result, null, 2);
  notify(`${result.status} · ${result.answerKind}${result.warnings.length ? ' · ' + result.warnings.join(', ') : ''}`);
}
$('chat-form').addEventListener('submit', event => {
  event.preventDefault(); guarded(async () => {
    requireSession(); if (state.abort) return;
    const content = $('message-input').value.trim(); if (!content) return;
    const attempt = { userId: state.userId, sessionId: state.sessionId, requestId: crypto.randomUUID(), content };
    setPending(attempt);
    state.abort = new AbortController(); $('send-message').disabled = true; $('stop-request').disabled = false;
    $('user-select').disabled = true; $('session-select').disabled = true; $('new-session').disabled = true;
    notify('正在处理，最长约45秒；可随时请求人工。');
    try {
      const result = await api(`${sessionPath()}/consult`, 'POST', { requestId: attempt.requestId, content }, state.abort.signal);
      showResult(result); $('message-input').value = ''; setPending(null);
    } catch (error) { notify(error.name === 'AbortError' ? '已停止等待，可查询上次请求确认后端状态。' : error.message); }
    finally {
      state.abort = null; $('send-message').disabled = false; $('stop-request').disabled = true;
      $('user-select').disabled = false; $('session-select').disabled = false; $('new-session').disabled = false;
      await loadChat();
    }
  });
});
$('stop-request').addEventListener('click', () => state.abort?.abort());
$('check-run').addEventListener('click', () => guarded(async () => {
  if (!state.pending) throw new Error('当前没有待核对请求。');
  const p = state.pending;
  const result = await api(`/api/users/${p.userId}/sessions/${p.sessionId}/runs/${p.requestId}`);
  if (result.result) { showResult(result.result); setPending(null); await loadChat(); }
  else notify(`请求状态：${result.state}`);
}));
$('request-human').addEventListener('click', () => guarded(async () => {
  requireSession(); const ticket = await api(`${sessionPath()}/handoff`, 'POST', { reason: '用户通过客服页请求人工' });
  notify(`人工工单 ${ticket.id}：${ticket.status}。请到人工接管页操作。`); await loadChat();
}));
$('new-session').addEventListener('click', () => guarded(async () => {
  if (!state.productId) throw new Error('请先导入产品资料。');
  const session = await api(`${userPath()}/sessions`, 'POST', { productId: state.productId });
  state.sessionId = session.sessionId; await loadSessions(); await loadCard();
}));
$('user-select').addEventListener('change', () => guarded(async () => { state.userId = $('user-select').value; state.sessionId = ''; await loadCard(); await loadSessions(); }));
$('session-select').addEventListener('change', () => guarded(async () => { state.sessionId = $('session-select').value; await loadChat(); }));
$('reload-card').addEventListener('click', () => guarded(() => loadCard()));
$('card-form').addEventListener('submit', event => {
  event.preventDefault(); guarded(async () => {
    if (!state.card) throw new Error('请先选择用户');
    const lines = id => $(id).value.split('\n').map(s => s.trim()).filter(Boolean);
    await api(`${userPath()}/card`, 'PATCH', { expectedVersion: state.card.version, confirmedFacts: JSON.parse($('confirmed-facts').value), preferences: lines('preferences'), concerns: lines('concerns') });
    await loadCard(); notify('资料已保存，新会话会使用这份资料。');
  });
});

async function loadHandoffs() {
  const { items } = await api('/api/handoffs'); const box = $('handoffs'); box.replaceChildren();
  if (!items.length) { box.append(node('p', '暂无人工工单。', 'muted')); return; }
  for (const ticket of items) {
    const article = node('article', undefined, 'panel');
    article.append(node('h2', `${ticket.userId} · ${ticket.status}`), node('p', `工单 ${ticket.id} · ${ticket.reason}`, 'small muted'));
    const details = node('details'); details.append(node('summary', '会话摘要与原话来源'), node('pre', JSON.stringify(ticket.summary, null, 2))); article.append(details);
    const controls = node('div', undefined, 'actions ticket-actions');
    if (ticket.status === 'pending') controls.append(action('接管', async () => { await api(`/api/handoffs/${ticket.id}/claim`, 'POST', {}); await loadHandoffs(); }));
    if (ticket.status === 'active') controls.append(action('结束接管', async () => { await api(`/api/handoffs/${ticket.id}/resolve`, 'POST', {}); await loadHandoffs(); }));
    controls.append(action('查看最新消息', async () => {
      const data = await api(`/api/users/${ticket.userId}/sessions/${ticket.session_id}/messages?limit=200&offset=0`);
      transcript.textContent = data.items.map(m => `${roleNames[m.role]}：${m.content}`).join('\n\n');
    }));
    article.append(controls); const transcript = node('pre', '点击“查看最新消息”读取人工队列中的新消息。'); article.append(transcript);
    if (ticket.status === 'active') {
      const input = document.createElement('textarea'); input.placeholder = '输入实际人工回复'; input.setAttribute('aria-label', '人工回复'); article.append(input);
      article.append(action('发送人工回复', async () => {
        const content = input.value.trim(); if (!content) throw new Error('请输入人工回复。');
        await api(`/api/handoffs/${ticket.id}/reply`, 'POST', { requestId: crypto.randomUUID(), content });
        input.value = ''; notify('人工回复已发送，可在客服页看到。');
      }));
    }
    box.append(article);
  }
}
function table(target, headers, rows) {
  const table = document.createElement('table'); const head = document.createElement('tr');
  headers.forEach(h => head.append(node('th', h))); table.append(head);
  for (const values of rows) { const row = document.createElement('tr'); values.forEach(v => row.append(node('td', String(v)))); table.append(row); }
  if (!rows.length) { const row = document.createElement('tr'); const cell = node('td', '暂无数据'); cell.colSpan = headers.length; row.append(cell); table.append(row); }
  $(target).replaceChildren(table);
}
async function loadDashboard() {
  const data = await api('/api/dashboard'); $('metrics-time').textContent = `更新于 ${new Date(data.updatedAt).toLocaleString()} · 评论与会话分区统计`;
  const cards = node('div', undefined, 'metric-grid');
  for (const [label, value] of [
    ['匿名评论样本', data.comments.sampleSize], ['客服会话', data.service.totalSessions], ['高风险会话', data.service.highRiskSessions],
    ['待人工', data.service.pendingHandoffs], ['人工处理中', data.service.activeHandoffs], ['有帮助反馈', data.service.helpful],
    ['没解决反馈', data.service.unresolved], ['有帮助率', data.service.helpfulRate === null ? '暂无' : `${(100 * data.service.helpfulRate).toFixed(1)}%`],
  ]) { const card = node('div', label, 'metric'); card.append(node('strong', String(value))); cards.append(card); }
  $('metrics').replaceChildren(cards);
  table('tag-table', ['标签', '数量', '占比', '评论ID'], data.comments.tags.map(x => [x.tag, x.count, `${(x.share * 100).toFixed(1)}%`, x.commentIds.join(', ')]));
  table('trend-table', ['月份', '数量', '评论ID'], data.comments.trend.map(x => [x.month === 'unknown' ? '发布日期未知' : x.month, x.count, x.commentIds.join(', ')]));
  table('pair-table', ['共现标签', '数量', '评论ID'], data.comments.cooccurrence.map(x => [x.tags.join(' + '), x.count, x.commentIds.join(', ')]));
  table('risk-table', ['会话ID', '历史最高风险', '运行ID'], data.service.riskSessions.map(x => [x.sessionId, x.risk, x.runIds.join(', ')]));
  $('metrics-json').textContent = JSON.stringify(data, null, 2);
}
$('refresh-handoffs').addEventListener('click', () => guarded(loadHandoffs));
$('refresh-dashboard').addEventListener('click', () => guarded(loadDashboard));
document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => guarded(async () => {
  state.page = button.dataset.page;
  document.querySelectorAll('.page').forEach(page => { page.hidden = page.id !== `page-${state.page}`; });
  document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('selected', b === button));
  if (state.page === 'card') await loadCard();
  if (state.page === 'handoff') await loadHandoffs();
  if (state.page === 'dashboard') await loadDashboard();
})));
async function boot() {
  try { state.pending = JSON.parse(sessionStorage.getItem('beauty-pending') ?? 'null'); } catch { setPending(null); }
  const [health, status, users, products] = await Promise.all([api('/health'), api('/api/status'), api('/api/users'), api('/api/products')]);
  $('health').textContent = health.database ? '● 数据库已连接' : '数据库异常';
  $('provider-status').textContent = `Jev：${status.providers.jevConfigured ? '已配置' : '未配置'} / 回复模型：${status.providers.chatConfigured ? '已配置' : '未配置'}`;
  $('notice').textContent = `策略：${status.policyStatus}（${status.policyVersion}）。${status.notice}`;
  for (const user of users.items) { const option = node('option', `${user.displayName} (${user.userId})`); option.value = user.userId; $('user-select').append(option); }
  state.userId = users.items[0]?.userId ?? ''; state.productId = products.items[0]?.productId ?? '';
  if (!state.userId || !state.productId) throw new Error('请先在项目目录运行 npm run seed:demo，或导入实际资料并创建用户，然后刷新。');
  const knowledge = await api(`/api/products/${state.productId}/knowledge`);
  $('knowledge').replaceChildren(node('p', knowledge.name), node('p', `资料类型：${knowledge.dataKind} · ${knowledge.version}`, 'small muted'));
  for (const fact of knowledge.facts) $('knowledge').append(node('p', fact.text, 'small'), node('p', `依据 ${fact.sourceId}`, 'small muted'));
  await loadCard(); await loadSessions();
  if (state.pending) notify('有一条上次未核对的请求，可点击“查询上次请求”。');
  setInterval(() => { if (state.page === 'chat' && !document.hidden) guarded(loadChat); if (state.page === 'dashboard' && !document.hidden) guarded(loadDashboard); }, 5000);
}
guarded(boot);
