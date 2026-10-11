const $ = id => document.getElementById(id);
const state = { userId: '', productId: '', sessionId: '', card: null, page: 'chat', pending: null, abort: null, csrf: '', expectedSkill: null, lastResult: null };
let refreshTimer;
const labels = { AI_ACTIVE: 'AI服务', HANDOFF_PENDING: '等待人工', HUMAN_ACTIVE: '人工处理中', RESOLVED: '已结束' };
const roleNames = { user: '用户', assistant: '客服', human: '人工坐席', system: '系统状态' };
const handoffNames = { pending: '等待人工接入', active: '人工处理中', resolved: '已结束' };
const feedbackNames = { helpful: '有帮助', unresolved: '没解决', request_human: '请求人工' };
function notify(text) { $('notification').textContent = text; }
function node(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
function action(text, fn) {
  const b = node('button', text); b.type = 'button';
  b.addEventListener('click', () => guarded(fn)); return b;
}
function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
}
async function guarded(fn) { try { await fn(); } catch (error) { notify(error.message); } }
async function api(path, method = 'GET', body, signal) {
  const response = await fetch(path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(!['GET', 'HEAD'].includes(method) && state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) { clearInterval(refreshTimer); $('operator-workspace').hidden = true; $('operator-login').hidden = false; }
    const details = result.error?.issues?.map(issue => `${issue.path || '输入'}：${issue.message}`).join('；');
    throw new Error(`${result.error?.code ?? response.status}: ${details || result.error?.message || '请求失败'}`);
  }
  return result;
}
const userPath = () => `/api/users/${encodeURIComponent(state.userId)}`;
const sessionPath = () => `${userPath()}/sessions/${encodeURIComponent(state.sessionId)}`;
function requireSession() { if (!state.sessionId) throw new Error('请先新建或选择会话。'); }
function setPending(value) { state.pending = value; if (value) sessionStorage.setItem('beauty-pending', JSON.stringify(value)); else sessionStorage.removeItem('beauty-pending'); }

function renderReadiness(settings) {
  $('provider-status').textContent = `Jev：${settings.jevConfigured ? '已配置' : '未配置'} / 回复模型：${settings.chatConfigured ? '已配置' : '未配置'}`;
  const warning = $('setup-warning'); warning.hidden = settings.jevConfigured && settings.chatConfigured;
  warning.replaceChildren();
  if (!warning.hidden) warning.append(node('span', '智能回答尚未就绪：请先填写模型密钥。 '), action('前往业务配置', () => openPage('setup')));
}

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
  state.lastResult = result;
  $('route-result').textContent = JSON.stringify(result, null, 2);
  $('download-route-json').disabled = false;
  const summary = $('run-summary'); summary.replaceChildren();
  for (const [label, value] of [['结果', result.status], ['决策来源', result.route?.routeStatus ?? '未执行'],
    ['Jev原始选择', result.route?.rawAnswers?.primary_skill?.choice ?? '无'], ['实际Skill', result.generation?.skillId ?? '无'],
    ['版本', result.generation?.skillVersion ?? '—'], ['来源数', result.sourceRefs.length]]) summary.append(node('p', `${label}：${value}`, 'small'));
  if (state.expectedSkill) summary.append(node('p', result.generation?.skillId === state.expectedSkill ? '✓ 实际执行了目标Skill' : '本次未执行目标Skill，请查看风险/追问/兜底原因。'));
  summary.append(action('查看完整执行证据', async () => { await openPage('runs'); $('run-select').value = result.runId; await loadRunDetail(result.runId); }));
  notify(`${result.status} · ${result.answerKind}${result.warnings.length ? ' · ' + result.warnings.join(', ') : ''}`);
}
$('chat-form').addEventListener('submit', event => {
  event.preventDefault(); guarded(async () => {
    if (state.abort) return;
    if (!state.sessionId) {
      if (!state.userId || !state.productId) throw new Error('请先初始化用户和产品资料。');
      const session = await api(`${userPath()}/sessions`, 'POST', { productId: state.productId });
      state.sessionId = session.sessionId; await loadSessions();
    }
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
    article.append(node('h2', `${ticket.userId} · ${handoffNames[ticket.status]}`), node('p', `工单 ${ticket.id} · ${ticket.reason}`, 'small muted'));
    const details = node('details'); details.append(node('summary', '会话摘要与原话来源'));
    details.append(node('p', `产品：${ticket.summary.product ?? '未提供'}`), node('p', `诉求：${ticket.summary.request ?? '待核实'}`), node('p', `时间：${ticket.summary.onsetTime ?? '待核实'}`));
    for (const fact of ticket.summary.reportedFacts ?? []) details.append(node('p', fact.text), node('p', `原话消息 ${fact.messageId}`, 'small muted'));
    article.append(details);
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
async function openPage(name) {
  state.page = name;
  document.querySelectorAll('.page').forEach(page => { page.hidden = page.id !== `page-${state.page}`; });
  document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('selected', b.dataset.page === name));
  if (state.page === 'card') await loadCard();
  if (state.page === 'handoff') await loadHandoffs();
  if (state.page === 'dashboard') await loadDashboard();
  if (state.page === 'setup') await loadSetup();
  if (state.page === 'runs') await loadRuns();
}
document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => guarded(() => openPage(button.dataset.page))));

async function loadSetup() {
  const [models, skills] = await Promise.all([api('/api/settings/models'), api('/api/skills')]);
  renderReadiness(models);
  $('models-summary').textContent = `Jev ${models.jevConfigured ? '已配置' : '未配置'}；回复模型 ${models.chatConfigured ? '已配置' : '未配置'}；保存位置：${models.persisted ? '本机data目录' : '当前进程'}${models.warning ? '。' + models.warning : ''}`;
  $('chat-url').value = models.chatBaseUrl; $('chat-model').value = models.chatModel;
  const intents = $('skill-intent'); intents.replaceChildren(node('option', '使用文件定义')); intents.firstChild.value = '';
  for (const [id, description] of Object.entries(skills.intents)) { const option = node('option', `${id} · ${description}`); option.value = id; intents.append(option); }
  const list = $('skill-list'); list.replaceChildren();
  for (const item of skills.items) {
    const box = node('article', undefined, 'panel');
    box.append(node('h2', `${item.skill.id} · ${item.enabled ? '已启用' : '已停用'}`), node('p', item.skill.description),
      node('p', `${item.skill.version} · ${item.origin} · ${item.skill.knowledge.length}份随包知识 · ${item.skill.intents.join(', ')}`, 'small muted'));
    const detail = node('details'); detail.append(node('summary', '当前 Agent 使用的 Skill 文档'), node('pre', item.skill.instructions));
    for (const doc of item.skill.knowledge) detail.append(node('h3', doc.title), node('pre', doc.content)); box.append(detail);
    box.append(action(item.enabled ? '停用' : '启用', async () => { await api(`/api/skills/${item.skill.id}`, 'PATCH', { enabled: !item.enabled }); await loadSetup(); notify('Skill状态已更新，下一条新咨询立即生效。'); }));
    box.append(action('文档 / 历史版本', async () => {
      const history = await api(`/api/skills/${item.skill.id}/versions`); versionBox.replaceChildren();
      for (const version of history.items) {
        const row = node('div', undefined, 'panel'); row.append(node('strong', `${version.version}${version.active ? ' · 当前版本' : ''}`));
        row.append(action('预览 SKILL.md', async () => {
          const doc = await api(`/api/skills/${item.skill.id}/versions/${encodeURIComponent(version.version)}`);
          preview.textContent = doc.markdown; preview.hidden = false;
        }));
        const link = node('a', '导出ZIP'); link.href = `/api/skills/${item.skill.id}/versions/${encodeURIComponent(version.version)}/export`; row.append(link);
        if (!version.active) row.append(action('启用此版本', async () => {
          await api(`/api/skills/${item.skill.id}/activate`, 'POST', { version: version.version, expectedCurrentVersion: item.skill.version });
          await loadSetup(); notify('版本已切换，新请求使用此版本，历史执行仍保留原快照。');
        }));
        versionBox.append(row);
      }
    }));
    box.append(action('去测试实际选择', async () => {
      state.expectedSkill = item.skill.id; $('expected-skill').textContent = `待验证Skill：${item.skill.id}。请输入匹配或对照问题；这里不会强制路由到它。`;
      await openPage('chat'); $('message-input').focus();
    }));
    const versionBox = node('div'); const preview = node('pre'); preview.hidden = true; box.append(versionBox, preview);
    list.append(box);
  }
}
$('refresh-setup').addEventListener('click', () => guarded(loadSetup));
$('initialize-demo').addEventListener('click', () => guarded(async () => {
  await api('/api/setup/demo', 'POST', {}); location.reload();
}));
$('model-form').addEventListener('submit', event => {
  event.preventDefault(); guarded(async () => {
    const input = { chatBaseUrl: $('chat-url').value.trim(), chatModel: $('chat-model').value.trim() };
    if ($('typesafe-key').value.trim()) input.typesafeApiKey = $('typesafe-key').value.trim();
    if ($('chat-key').value.trim()) input.chatApiKey = $('chat-key').value.trim();
    await api('/api/settings/models', 'PUT', input);
    $('typesafe-key').value = ''; $('chat-key').value = ''; await loadSetup(); notify('模型配置已保存并生效。请验证连接，再发送一条新咨询。');
  });
});
$('check-models').addEventListener('click', () => guarded(async () => {
  const button = $('check-models'); button.disabled = true; $('model-check-result').textContent = '正在真实验证，最多45秒…';
  try {
    const result = await api('/api/settings/models/check', 'POST', {});
    const explain = item => {
      if (item.ok) return `成功 ${item.message}`;
      if (/HTTP_402/.test(item.message)) return `失败：可能余额或额度不足。请到服务商后台确认，并在上方换用有额度的 API Key 后保存、重新验证。`;
      if (/HTTP_429/.test(item.message)) return `失败：请求过快或额度不足。请稍后重试；若持续出现，请确认服务商余额并在上方更换 API Key。`;
      if (/HTTP_401|HTTP_403/.test(item.message)) return `失败：API Key 被拒绝。请在上方更换正确的 Key 后保存、重新验证。`;
      return `失败 ${item.message}`;
    };
    $('model-check-result').textContent = `Jev：${explain(result.jev)}\n回复模型：${explain(result.chat)}`;
  } finally { button.disabled = false; }
}));
$('skill-upload-form').addEventListener('submit', event => {
  event.preventDefault(); guarded(async () => {
    const file = $('skill-file').files[0]; if (!file) throw new Error('请选择Skill文件。');
    if (file.size > 2_000_000) throw new Error('文件最大2MB。');
    const overrides = {};
    if ($('skill-id').value.trim()) overrides.id = $('skill-id').value.trim();
    if ($('skill-version').value.trim()) overrides.version = $('skill-version').value.trim();
    if ($('skill-description').value.trim()) overrides.description = $('skill-description').value.trim();
    if ($('skill-intent').value) overrides.intents = [$('skill-intent').value];
    if ($('skill-requires-knowledge').value) overrides.requiresKnowledge = $('skill-requires-knowledge').value === 'true';
    const zipped = file.name.toLowerCase().endsWith('.zip');
    let content;
    if (zipped) { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); content = btoa(binary); }
    else content = await file.text();
    const result = await api('/api/skills/import', 'POST', { filename: file.name, content, encoding: zipped ? 'base64' : 'utf8', overrides });
    await loadSetup(); notify(`Skill ${result.skill.id} 已导入并启用，下一条咨询可被Jev选中。`);
  });
});
$('product-upload-form').addEventListener('submit', event => {
  event.preventDefault(); guarded(async () => {
    const file = $('product-file').files[0]; if (!file) return;
    if (file.size > 2_000_000) throw new Error('产品JSON最大2MB。');
    const result = await api('/api/imports/products', 'POST', JSON.parse(await file.text()));
    notify(`产品 ${result.productId} ${result.version} 已导入；刷新网页读取新资料。`);
  });
});
async function boot() {
  try { state.pending = JSON.parse(sessionStorage.getItem('beauty-pending') ?? 'null'); } catch { setPending(null); }
  const [health, status, users, products] = await Promise.all([api('/health'), api('/api/status'), api('/api/users'), api('/api/products')]);
  $('health').textContent = health.database ? '● 数据库已连接' : '数据库异常';
  renderReadiness(status.providers);
  $('notice').textContent = `策略：${status.policyStatus}（${status.policyVersion}）。${status.notice}`;
  for (const user of users.items) { const option = node('option', `${user.displayName} (${user.userId})`); option.value = user.userId; $('user-select').append(option); }
  state.userId = users.items[0]?.userId ?? ''; state.productId = products.items[0]?.productId ?? '';
  if (!state.userId || !state.productId) {
    await openPage('setup'); notify('首次使用：点击“初始化演示数据”，再配置模型和上传Skill。'); return;
  }
  const knowledge = await api(`/api/products/${state.productId}/knowledge`);
  $('knowledge').replaceChildren(node('p', knowledge.name), node('p', `资料类型：${knowledge.dataKind} · ${knowledge.version}`, 'small muted'));
  for (const fact of knowledge.facts) $('knowledge').append(node('p', fact.text, 'small'), node('p', `依据 ${fact.sourceId}`, 'small muted'));
  await loadCard(); await loadSessions();
  if (state.pending) notify('有一条上次未核对的请求，可点击“查询上次请求”。');
  refreshTimer = setInterval(() => { if (state.page === 'chat' && !document.hidden) guarded(loadChat); if (state.page === 'dashboard' && !document.hidden) guarded(loadDashboard); }, 5000);
}
async function loadRuns() {
  const previous = $('run-select').value;
  const { items } = await api('/api/ops/runs'); $('run-select').replaceChildren();
  for (const run of items) { const option = node('option', `${run.createdAt} · ${run.userName} · ${run.status} · ${run.input.slice(0, 40)}`); option.value = run.runId; $('run-select').append(option); }
  if (items.some(run => run.runId === previous)) $('run-select').value = previous;
  if ($('run-select').value) await loadRunDetail($('run-select').value); else $('run-detail').replaceChildren(node('p', '暂无执行记录。'));
}
async function loadRunDetail(id) {
  if (!id) return;
  const data = await api(`/api/ops/runs/${id}`); const box = $('run-detail'); box.replaceChildren();
  const summary = node('article', undefined, 'panel'); summary.append(node('h2', data.input), node('p', `${data.status} · ${data.createdAt} · runId ${data.runId}`, 'small muted'));
  for (const [label, value] of Object.entries(data.summary)) summary.append(node('p', `${label}：${Array.isArray(value) ? value.join('、') : value ?? '—'}`));
  box.append(summary);
  const timeline = node('article', undefined, 'panel'); timeline.append(node('h2', '真实执行时间线'));
  for (const event of data.events) {
    const step = node('div', undefined, 'evidence-step'); step.append(node('strong', event.title), node('p', event.createdAt, 'small muted'));
    for (const [key, value] of Object.entries(event.readable)) step.append(node('p', `${key}：${Array.isArray(value) ? value.join('、') : value ?? '—'}`, 'small'));
    timeline.append(step);
  }
  if (!data.events.length) timeline.append(node('p', '这是旧版记录，没有完整事件快照；下方只展示当时已保存的结果。'));
  box.append(timeline);
  if (data.snapshot?.card) {
    const card = node('article', undefined, 'panel'); card.append(node('h2', `实际读取的资料卡 · v${data.snapshot.card.version}`));
    card.append(node('p', `偏好：${data.snapshot.card.preferences.join('、') || '未填写'}`), node('p', `关注点：${data.snapshot.card.concerns.join('、') || '未填写'}`));
    for (const [key, fact] of Object.entries(data.snapshot.card.confirmedFacts)) card.append(node('p', `${key}：${fact.value}`)); box.append(card);
  }
  if (data.snapshot?.skill) {
    const skill = node('article', undefined, 'panel'); skill.append(node('h2', `实际执行文档 · ${data.snapshot.skill.id} / ${data.snapshot.skill.version}`), node('pre', data.snapshot.skill.instructions)); box.append(skill);
  }
  if (data.snapshot?.knowledge) {
    const evidence = node('article', undefined, 'panel'); evidence.append(node('h2', '实际提供给回复模型的知识片段'));
    for (const fact of data.snapshot.knowledge.facts) { const source = data.snapshot.knowledge.sources.find(s => s.sourceId === fact.sourceId); evidence.append(node('h3', source?.title ?? fact.sourceId), node('p', fact.text), node('p', `依据 ${fact.sourceId}`, 'small muted')); }
    box.append(evidence);
  }
  const follow = node('article', undefined, 'panel'); follow.append(node('h2', '会话后续活动'));
  follow.append(node('p', `人工状态：${data.handoff ? handoffNames[data.handoff.status] : '无人工工单'}`));
  for (const f of data.feedback) follow.append(node('p', `反馈 ${feedbackNames[f.type] ?? f.type} · ${f.updatedAt} · ${f.reason || '无附加原因'}`));
  for (const reply of data.humanReplies) follow.append(node('p', `人工：${reply.content}`)); box.append(follow);
  const debug = node('details', undefined, 'panel');
  const debugSummary = node('summary', undefined, 'details-summary'); debugSummary.append(node('span', '开发调试JSON'));
  const download = action('下载 JSON', event => {
    event?.preventDefault?.(); event?.stopPropagation?.();
    downloadJson(data, `beauty-run-${data.runId}.json`);
    notify(`已下载执行记录 ${data.runId}.json`);
  });
  download.classList.add('compact');
  download.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
  debugSummary.append(download); debug.append(debugSummary, node('pre', JSON.stringify(data, null, 2))); box.append(debug);
}
$('download-route-json').addEventListener('click', event => {
  event.preventDefault(); event.stopPropagation();
  if (!state.lastResult) return;
  downloadJson(state.lastResult, `beauty-route-${state.lastResult.runId}.json`);
  notify(`已下载调试记录 ${state.lastResult.runId}.json`);
});
$('refresh-runs').addEventListener('click', () => guarded(loadRuns));
$('load-run').addEventListener('click', () => guarded(() => loadRunDetail($('run-select').value)));
$('operator-login-form').addEventListener('submit', event => {
  event.preventDefault();
  (async () => {
    try { await api('/api/auth/operator/login', 'POST', { password: $('operator-password').value }); $('operator-password').value = ''; location.reload(); }
    catch (error) { $('operator-login-message').textContent = error.message; }
  })();
});
$('operator-logout').addEventListener('click', () => guarded(async () => { await api('/api/auth/operator/logout', 'POST', {}); location.reload(); }));
guarded(async () => {
  const auth = await api('/api/auth/operator/status');
  if (!auth.authenticated) return;
  state.csrf = auth.csrfToken; $('operator-login').hidden = true; $('operator-workspace').hidden = false;
  await boot();
});
