import { renderFaceGuide } from './face-illustration.js';
import { createPageTransition } from './motion/page-transition.js';
import { createButterflyFlight } from './motion/butterfly-flight.js';
import { initPointerLighting } from './motion/pointer-lighting.js';
import { initCursorParticles } from './motion/cursor-particles.js';

const $ = id => document.getElementById(id);
const state = { csrf: '', productId: '', sessionId: '', sessions: [], card: null, abort: null, pending: null, videoPhotos: [] };
const labels = { AI_ACTIVE: '正在为你服务', HANDOFF_PENDING: '等待人工', HUMAN_ACTIVE: '人工已接入', RESOLVED: '服务已结束' };
const shortLabels = { AI_ACTIVE: '服务中', HANDOFF_PENDING: '等人工', HUMAN_ACTIVE: '人工接入', RESOLVED: '已结束' };
const roles = { user: '我', assistant: '美妆顾问', human: '人工客服', system: '服务提示' };
const factLabels = { skinType: '你确认的肤质倾向', sensation: '使用感受', budget: '预算', texturePreference: '质地偏好' };
function el(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
function notice(text) { $('customer-notice').textContent = text; }
function renderView(view, focus = false) {
  const consulting = view === 'consult';
  $('home-view').hidden = consulting;
  $('consult-view').hidden = !consulting;
  $('home-link').hidden = !consulting;
  document.title = consulting ? '在线咨询 · 暖颜' : '暖颜 · 专属美妆顾问';
  if (focus && consulting) $('message').focus();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
const butterflyFlight = createButterflyFlight($('motion-butterfly'));
const transitionTo = createPageTransition({ render: renderView, afterRender: (view, animated) => butterflyFlight.moveTo(view, animated) });
let currentView = null;
function showView(view, focus = false, animate = true) {
  if (currentView === view) { if (focus && view === 'consult') $('message').focus(); return; }
  currentView = view;
  void transitionTo(view, { animate, focus });
}
function openConsult(focus = false) { if (location.hash !== '#consult') location.hash = 'consult'; showView('consult', focus); }
window.addEventListener('hashchange', () => showView(location.hash === '#consult' ? 'consult' : 'home'));
$('home-link').addEventListener('click', () => { location.hash = 'home'; showView('home'); });
$('start-consultation').addEventListener('click', () => openConsult(true));
$('view-consultations').addEventListener('click', () => { openConsult(); $('new-session').focus(); });
const videoDialog = $('video-moment-dialog');
$('start-video-moment').addEventListener('click', () => {
  if (typeof videoDialog.showModal === 'function') videoDialog.showModal();
  else videoDialog.setAttribute('open', '');
});
for (const button of document.querySelectorAll('.topic-card')) button.addEventListener('click', () => {
  $('message').value = button.dataset.prompt ?? '';
  openConsult(true);
});
showView(location.hash === '#consult' ? 'consult' : 'home', false, false);
initPointerLighting();
initCursorParticles($('cursor-spray'));
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
const supportedPhotoTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
function formatBytes(value) { return value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
function refreshVideoMoment() {
  const count = state.videoPhotos.length;
  $('video-photo-count').textContent = `已选 ${count} / 建议 15 张`;
  const list = $('video-photo-list'); list.replaceChildren();
  if (!count) list.append(el('p', '还没有选择照片。可一次选多张，也可分次补充。', 'muted'));
  for (const [index, photo] of state.videoPhotos.entries()) {
    const item = el('article', undefined, 'video-photo-item');
    const preview = el('img'); preview.src = `data:${photo.mediaType};base64,${photo.dataBase64}`; preview.alt = `已选照片 ${index + 1}`;
    const copy = el('div'); copy.append(el('strong', `${index + 1}. ${photo.originalName}`),
      el('small', `${new Date(photo.capturedAt).toLocaleDateString()} · ${formatBytes(photo.byteSize)}`));
    const remove = el('button', '移除', 'video-remove'); remove.type = 'button'; remove.addEventListener('click', () => { state.videoPhotos.splice(index, 1); refreshVideoMoment(); });
    item.append(preview, copy, remove); list.append(item);
  }
  $('video-submit').disabled = count < 5 || !$('video-authorize').checked;
}
function readDataUrl(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
}
async function shrinkPhoto(file) {
  const source = await readDataUrl(file);
  const image = new Image(); image.src = source; await image.decode();
  const maximum = 1280; const scale = Math.min(1, maximum / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const output = canvas.toDataURL('image/jpeg', 0.72); const dataBase64 = output.slice(output.indexOf(',') + 1); const byteSize = Math.floor(dataBase64.length * 3 / 4);
  if (byteSize > 900 * 1024) throw new Error('压缩后仍超过900KB，请换一张较小的照片。');
  return { photoId: `photo-${state.videoPhotos.length + 1}`, originalName: file.name.slice(0, 180) || '未命名照片.jpg',
    mediaType: 'image/jpeg', capturedAt: new Date(file.lastModified || Date.now()).toISOString(), dataBase64, byteSize };
}
$('video-add-photos').addEventListener('click', () => $('video-photo-input').click());
$('video-photo-input').addEventListener('change', async event => {
  const input = event.currentTarget; const files = [...input.files ?? []]; input.value = '';
  const remaining = 20 - state.videoPhotos.length;
  const accepted = files.filter(file => supportedPhotoTypes.has(file.type)).slice(0, remaining);
  if (!accepted.length) { $('video-moment-feedback').textContent = '请选择 JPG、PNG 或 WebP 格式的照片。'; return; }
  $('video-add-photos').disabled = true; $('video-moment-feedback').className = 'form-feedback'; $('video-moment-feedback').textContent = '正在压缩照片以便本机测试…';
  try {
    for (const file of accepted) state.videoPhotos.push(await shrinkPhoto(file));
    state.videoPhotos.forEach((photo, index) => { photo.photoId = `photo-${index + 1}`; });
    $('video-moment-feedback').textContent = files.length > accepted.length ? '已达到最多20张；其余照片没有加入。' : '';
  } catch (error) { $('video-moment-feedback').textContent = error instanceof Error ? error.message : '照片暂时无法读取，请换一张再试。'; }
  finally { $('video-add-photos').disabled = false; refreshVideoMoment(); }
});
$('video-authorize').addEventListener('change', refreshVideoMoment);
$('video-submit').addEventListener('click', () => safely(async () => {
  const button = $('video-submit'); button.disabled = true; $('video-moment-feedback').className = 'form-feedback'; $('video-moment-feedback').textContent = '正在把授权素材交给“悦见时刻”测试…';
  try {
    const result = await api('/api/customer/video-moments', 'POST', { authorized: true, photos: state.videoPhotos.map(({ byteSize, ...photo }) => photo) });
    $('video-moment-feedback').classList.add('success');
    $('video-moment-feedback').textContent = `${result.message} 已接收 ${result.photoCount} 张，目标约 ${result.requestedDurationSeconds} 秒。`;
  } catch {
    $('video-moment-feedback').classList.add('error'); $('video-moment-feedback').textContent = '素材没有提交成功，请确认已选择5至20张、总大小不超过12MB的照片。';
  } finally { refreshVideoMoment(); }
}));
async function sessions() {
  const { items } = await api('/api/customer/sessions');
  if (!items.some(s => s.sessionId === state.sessionId)) state.sessionId = items.at(-1)?.sessionId ?? '';
  state.sessions = items;
  renderSessions();
  await messages();
}
function renderSessions() {
  const nav = $('session-groups'); nav.replaceChildren();
  const grouped = new Map();
  for (const item of [...state.sessions].reverse()) {
    const topic = item.topic || '日常护肤';
    if (!grouped.has(topic)) grouped.set(topic, []);
    grouped.get(topic).push(item);
  }
  $('history-count').textContent = String(state.sessions.length);
  if (!state.sessions.length) { nav.append(el('p', '还没有咨询记录，开始聊聊吧。', 'history-empty')); return; }
  for (const [topic, items] of grouped) {
    const group = el('section', undefined, 'session-topic-group');
    group.append(el('h3', topic, 'session-topic-title'));
    for (const item of items) {
      const button = el('button', undefined, `session-history-item${item.sessionId === state.sessionId ? ' active' : ''}`);
      button.type = 'button'; button.dataset.sessionId = item.sessionId;
      if (item.sessionId === state.sessionId) button.setAttribute('aria-current', 'page');
      button.disabled = Boolean(state.abort);
      button.append(el('strong', item.summary || '新咨询', 'session-summary'),
        el('span', item.preview && item.preview !== item.summary ? item.preview : (item.summary === '新咨询' ? '还没有发送消息' : labels[item.status] || '咨询记录'), 'session-preview'));
      const footer = el('span', undefined, 'session-meta');
      footer.append(el('span', shortLabels[item.status] || '咨询记录'), el('time', new Date(item.createdAt).toLocaleDateString()));
      button.append(footer); group.append(button);
    }
    nav.append(group);
  }
}
async function newSession() {
  state.productId = $('product-select').value || state.productId;
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
    if (message.productCards?.length) {
      const cards = el('div', undefined, 'product-cards');
      for (const product of message.productCards) {
        const card = el('article', undefined, 'product-card');
        if (product.imageUrl) { const image = el('img'); image.src = product.imageUrl; image.alt = product.name; image.loading = 'lazy'; card.append(image); }
        card.append(el('strong', product.name), el('p', `${product.shade} · ${product.texture}`),
          el('p', product.dataKind === 'demo' ? '演示商品，仅用于测试推荐流程' : '已审核商品资料', 'small muted'));
        if (product.price !== undefined) card.append(el('p', `参考价格 ¥${product.price}`, 'small'));
        card.append(el('p', `资料依据：${product.sourceId}`, 'small muted'));
        cards.append(card);
      }
      bubble.append(cards);
    }
    if (message.visualGuide) { const guide = renderFaceGuide(message.visualGuide); if (guide) bubble.append(guide); }
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
$('card-form').addEventListener('submit', event => { event.preventDefault(); (async () => {
  const button = $('save-profile'); const feedback = $('profile-feedback');
  button.disabled = true; button.textContent = '正在保存…'; feedback.className = 'form-feedback'; feedback.textContent = '正在保存你的资料…';
  try {
  const facts = {};
  for (const input of $('facts').querySelectorAll('input')) {
    const value = input.value.trim(); if (!value) continue;
    const old = state.card.confirmedFacts[input.dataset.field]; facts[input.dataset.field] = { value, sourceMessageId: old?.value === value ? old.sourceMessageId : null };
  }
  const lines = id => $(id).value.split('\n').map(s => s.trim()).filter(Boolean);
  const result = await api('/api/customer/card', 'PATCH', { expectedVersion: state.card.version, confirmedFacts: facts, preferences: lines('preferences'), concerns: lines('concerns') });
  renderCard(result); notice('你的资料已保存。'); feedback.classList.add('success'); feedback.textContent = '已保存，下次咨询会参考这些信息。';
  } catch (error) {
    const message = error instanceof Error && error.message === 'CARD_VERSION_CONFLICT'
      ? '资料刚刚有更新，请刷新页面后再保存。'
      : '暂时没有保存成功，请稍后重试。';
    notice(message); feedback.classList.add('error'); feedback.textContent = message;
  } finally { button.disabled = false; button.textContent = '保存我的资料'; }
})(); });
$('new-session').addEventListener('click', () => safely(newSession));
$('session-groups').addEventListener('click', event => {
  const button = event.target.closest('[data-session-id]');
  if (!button || button.disabled) return;
  safely(async () => { state.sessionId = button.dataset.sessionId; renderSessions(); await messages(); });
});
$('send-form').addEventListener('submit', event => { event.preventDefault(); safely(async () => {
  if (state.abort) return;
  const content = $('message').value.trim(); if (!content) return;
  if (!state.sessionId && !await newSession()) return;
  const attempt = { sessionId: state.sessionId, requestId: crypto.randomUUID() }; pending(attempt);
  state.abort = new AbortController(); $('send').disabled = true; $('cancel').disabled = false; renderSessions(); $('new-session').disabled = true; notice('正在理解你的问题、核对可用资料…');
  try {
    const result = await api(`${path()}/consult`, 'POST', { requestId: attempt.requestId, content }, state.abort.signal);
    notice(result.message); $('message').value = ''; pending(null);
  } catch (error) { notice(error.name === 'AbortError' ? '已停止等待，可以查看上次处理结果。' : '连接暂时中断，先查看上次处理结果，避免重复发送。'); }
  finally { state.abort = null; $('send').disabled = false; $('cancel').disabled = true; $('new-session').disabled = false; await sessions(); }
}); });
$('cancel').addEventListener('click', () => state.abort?.abort());
$('human').addEventListener('click', () => safely(async () => { if (!state.sessionId && !await newSession()) return; const result = await api(`${path()}/handoff`, 'POST', { reason: '用户请求人工服务' }); notice(result.message); await messages(); }));
$('check').addEventListener('click', () => safely(async () => { if (!state.pending) return; const p = state.pending; const result = await api(`/api/customer/sessions/${p.sessionId}/runs/${p.requestId}`); if (result.result) { notice(result.result.message); pending(null); } else notice('请求仍在处理中，请稍候。'); await messages(); }));
safely(async () => {
  const auth = await api('/api/auth/customer/start', 'POST', {}); state.csrf = auth.csrfToken;
  const info = await api('/api/customer/bootstrap'); state.productId = info.products[0]?.productId ?? '';
  $('product-select').replaceChildren();
  for (const product of info.products) {
    const option = el('option', `${product.name}${product.dataKind === 'demo' ? ' · 演示' : ''}`); option.value = product.productId;
    $('product-select').append(option);
  }
  $('product-select').value = state.productId;
  $('service-status').textContent = !state.productId ? '服务准备中' : info.serviceAvailable ? '欢迎咨询' : '可留言或联系人工';
  notice(!state.productId ? '客服资料正在准备中，请稍后再来。' : info.products[0]?.dataKind === 'demo' ? '当前为演示资料，我们会明确区分示例与真实商品信息。' : '有什么问题，随时告诉我。');
  renderCard(info.card); await sessions();
  try { pending(JSON.parse(sessionStorage.getItem('customer-pending') ?? 'null')); } catch { pending(null); }
  setInterval(() => { if (!document.hidden) safely(messages); }, 5000);
});
