const $ = id => document.getElementById(id);
const state = { csrf: '', productId: '', sessionId: '', card: null, abort: null, pending: null };
const labels = { AI_ACTIVE: '正在为你服务', HANDOFF_PENDING: '等待人工', HUMAN_ACTIVE: '人工已接入', RESOLVED: '服务已结束' };
const roles = { user: '我', assistant: '美妆顾问', human: '人工客服', system: '服务提示' };
const factLabels = { skinType: '你确认的肤质倾向', sensation: '使用感受', budget: '预算', texturePreference: '质地偏好' };
function el(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
function notice(text) { $('customer-notice').textContent = text; }
async function safely(fn) { try { await fn(); } catch { notice('暂时无法完成操作，请刷新后重试，或联系人工。'); } }
async function api(path, method = 'GET', body, signal) {
  const response = await fetch(path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(!['GET', 'HEAD'].includes(method) && state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.code ?? '请求失败');
  return data;
}
const path = () => `/api/customer/sessions/${state.sessionId}`;
function pending(value) { state.pending = value; $('check').hidden = !value; if (value) sessionStorage.setItem('customer-pending', JSON.stringify(value)); else sessionStorage.removeItem('customer-pending'); }
async function sessions() {
  const { items } = await api('/api/customer/sessions');
  if (!items.some(s => s.sessionId === state.sessionId)) state.sessionId = items.at(-1)?.sessionId ?? '';
  $('sessions').replaceChildren();
  for (const item of items) { const option = el('option', `${new Date(item.createdAt).toLocaleString()} · ${labels[item.status]}`); option.value = item.sessionId; $('sessions').append(option); }
  $('sessions').value = state.sessionId; await messages();
}
async function newSession() {
  if (!state.productId) { notice('客服资料正在准备中，请稍后再来。'); return false; }
  const result = await api('/api/customer/sessions', 'POST', { productId: state.productId }); state.sessionId = result.sessionId; await sessions(); return true;
}
async function messages() {
  if (!state.sessionId) { $('messages').replaceChildren(el('p', '欢迎！可以直接发送你的问题。', 'muted')); return; }
  const id = state.sessionId; const result = await api(`${path()}/messages?limit=200&offset=0`);
  if (id !== state.sessionId) return;
  $('session-state').textContent = labels[result.session.status];
  const box = $('messages'); const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 70; box.replaceChildren();
  for (const message of result.items) {
    const bubble = el('div', undefined, `message ${message.role}`); bubble.append(el('div', roles[message.role], 'meta'), el('div', message.content));
    for (const source of message.sources ?? []) bubble.append(el('span', `依据：${source.title}`, 'source-label'));
    if (['assistant', 'human'].includes(message.role)) {
      const buttons = el('div', undefined, 'actions');
      for (const [text, type] of [['有帮助', 'helpful'], ['没解决', 'unresolved'], ['需要人工', 'request_human']]) {
        const button = el('button', text); button.type = 'button'; button.addEventListener('click', () => safely(async () => {
          const result = await api(`/api/customer/messages/${message.messageId}/feedback`, 'POST', { type }); notice(result.prompt); await messages();
        })); buttons.append(button);
      }
      bubble.append(buttons);
    }
    box.append(bubble);
  }
  if (atEnd) box.scrollTop = box.scrollHeight;
}
function renderCard(card) {
  state.card = card; $('preferences').value = card.preferences.join('\n'); $('concerns').value = card.concerns.join('\n'); $('facts').replaceChildren();
  for (const key of new Set(['skinType', 'sensation', 'budget', ...Object.keys(card.confirmedFacts)])) {
    const label = el('label', factLabels[key] ?? key); const input = document.createElement('input'); input.dataset.field = key; input.maxLength = 1000; input.value = card.confirmedFacts[key]?.value ?? ''; label.append(input); $('facts').append(label);
  }
}
$('card-form').addEventListener('submit', event => { event.preventDefault(); safely(async () => {
  const facts = {};
  for (const input of $('facts').querySelectorAll('input')) {
    const value = input.value.trim(); if (!value) continue;
    const old = state.card.confirmedFacts[input.dataset.field]; facts[input.dataset.field] = { value, sourceMessageId: old?.value === value ? old.sourceMessageId : null };
  }
  const lines = id => $(id).value.split('\n').map(s => s.trim()).filter(Boolean);
  const result = await api('/api/customer/card', 'PATCH', { expectedVersion: state.card.version, confirmedFacts: facts, preferences: lines('preferences'), concerns: lines('concerns') });
  renderCard(result); notice('你的资料已保存。');
}); });
$('new-session').addEventListener('click', () => safely(newSession));
$('sessions').addEventListener('change', () => safely(async () => { state.sessionId = $('sessions').value; await messages(); }));
$('send-form').addEventListener('submit', event => { event.preventDefault(); safely(async () => {
  if (state.abort) return;
  const content = $('message').value.trim(); if (!content) return;
  if (!state.sessionId && !await newSession()) return;
  const attempt = { sessionId: state.sessionId, requestId: crypto.randomUUID() }; pending(attempt);
  state.abort = new AbortController(); $('send').disabled = true; $('cancel').disabled = false; $('sessions').disabled = true; $('new-session').disabled = true; notice('正在理解你的问题、核对可用资料…');
  try {
    const result = await api(`${path()}/consult`, 'POST', { requestId: attempt.requestId, content }, state.abort.signal);
    notice(result.message); $('message').value = ''; pending(null);
  } catch (error) { notice(error.name === 'AbortError' ? '已停止等待，可以查看上次处理结果。' : '连接暂时中断，先查看上次处理结果，避免重复发送。'); }
  finally { state.abort = null; $('send').disabled = false; $('cancel').disabled = true; $('sessions').disabled = false; $('new-session').disabled = false; await messages(); }
}); });
$('cancel').addEventListener('click', () => state.abort?.abort());
$('human').addEventListener('click', () => safely(async () => { if (!state.sessionId && !await newSession()) return; const result = await api(`${path()}/handoff`, 'POST', { reason: '用户请求人工服务' }); notice(result.message); await messages(); }));
$('check').addEventListener('click', () => safely(async () => { if (!state.pending) return; const p = state.pending; const result = await api(`/api/customer/sessions/${p.sessionId}/runs/${p.requestId}`); if (result.result) { notice(result.result.message); pending(null); } else notice('请求仍在处理中，请稍候。'); await messages(); }));
safely(async () => {
  const auth = await api('/api/auth/customer/start', 'POST', {}); state.csrf = auth.csrfToken;
  const info = await api('/api/customer/bootstrap'); state.productId = info.products[0]?.productId ?? '';
  $('service-status').textContent = !state.productId ? '服务准备中' : info.serviceAvailable ? '欢迎咨询' : '可留言或联系人工';
  notice(!state.productId ? '客服资料正在准备中，请稍后再来。' : info.products[0]?.dataKind === 'demo' ? '当前为演示资料，我们会明确区分示例与真实商品信息。' : '有什么问题，随时告诉我。');
  renderCard(info.card); await sessions();
  try { pending(JSON.parse(sessionStorage.getItem('customer-pending') ?? 'null')); } catch { pending(null); }
  setInterval(() => { if (!document.hidden) safely(messages); }, 5000);
});
