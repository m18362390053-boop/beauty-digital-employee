import { renderFaceGuide } from './face-illustration.js';
import { createPageTransition } from './motion/page-transition.js';
import { createButterflyFlight } from './motion/butterfly-flight.js';
import { initPointerLighting } from './motion/pointer-lighting.js';
import { initHomePortal } from './motion/home-portal.js';
import { initSkincareSchedule } from './skincare-schedule.js';

const $ = id => document.getElementById(id);
const state = { csrf: '', productId: '', sessionId: '', sessions: [], card: null, abort: null, pending: null, videoPhotos: [], routine: null, careProducts: [], productPhoto: null, visionAbort: null, visionConfigured: false, imageProvider: null, asrConfigured: false, ttsConfigured: false, recorder: null, voice: null, voiceUrl: null, voiceAbort: null };
const labels = { AI_ACTIVE: '正在为你服务', HANDOFF_PENDING: '等待人工', HUMAN_ACTIVE: '人工已接入', RESOLVED: '服务已结束' };
const shortLabels = { AI_ACTIVE: '服务中', HANDOFF_PENDING: '等人工', HUMAN_ACTIVE: '人工接入', RESOLVED: '已结束' };
const roles = { user: '我', assistant: '美妆顾问', human: '人工客服', system: '服务提示' };
const factLabels = { skinType: '你确认的肤质倾向', sensation: '使用感受', budget: '预算', texturePreference: '质地偏好' };
function el(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
function notice(text) { $('customer-notice').textContent = text; }
function renderView(view, focus = false) {
  const home = view === 'home';
  const consulting = view === 'consult';
  const schedule = view === 'schedule';
  $('home-view').hidden = !home;
  $('consult-view').hidden = !consulting;
  $('schedule-view').hidden = !schedule;
  $('home-link').hidden = home;
  if (home) homePortal.reset();
  document.title = consulting ? '在线咨询 · 暖颜' : schedule ? '护肤日程 · 暖颜' : '暖颜 · 专属美妆顾问';
  if (focus && consulting) $('message').focus();
  if (focus && schedule) $('schedule-title').focus();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
const butterflyFlight = createButterflyFlight($('motion-butterfly'));
const homePortal = initHomePortal(document.querySelector('.home-portal'));
const transitionTo = createPageTransition({ render: renderView, afterRender: (view, animated) => butterflyFlight.moveTo(view, animated) });
let currentView = null;
function showView(view, focus = false, animate = true) {
  if (currentView === view) { if (focus && view === 'consult') $('message').focus(); if (focus && view === 'schedule') $('schedule-title').focus(); return Promise.resolve(); }
  currentView = view;
  return transitionTo(view, { animate, focus });
}
function openConsult(focus = false) { if (location.hash !== '#consult') location.hash = 'consult'; return showView('consult', focus); }
function openSchedule(focus = false) { if (location.hash !== '#schedule') location.hash = 'schedule'; return showView('schedule', focus); }
function viewFromHash() { return location.hash === '#consult' ? 'consult' : location.hash === '#schedule' ? 'schedule' : 'home'; }
window.addEventListener('hashchange', () => showView(viewFromHash()));
$('home-link').addEventListener('click', () => { location.hash = 'home'; showView('home'); });
$('start-consultation').addEventListener('click', () => { void homePortal.choose('consult', () => openConsult(true)); });
$('view-records').addEventListener('click', () => { void homePortal.choose('records', async () => { await openConsult(false); ($('session-groups').querySelector('button') ?? $('new-session')).focus(); }); });
$('view-schedule').addEventListener('click', () => openSchedule(true));
const videoDialog = $('video-moment-dialog');
$('start-video-moment').addEventListener('click', () => {
  void homePortal.choose('moment', () => {
    safely(loadVideoMoments);
    if (typeof videoDialog.showModal === 'function') videoDialog.showModal();
    else videoDialog.setAttribute('open', '');
  });
});
for (const button of document.querySelectorAll('.topic-card')) button.addEventListener('click', () => {
  $('message').value = button.dataset.prompt ?? '';
  openConsult(true);
});
showView(viewFromHash(), false, false);
initPointerLighting();
const skincareShareToken = new URLSearchParams(location.search).get('share') ?? '';
const skincareSchedule = initSkincareSchedule({
  recognize: imageBase64 => api('/api/customer/product-ocr', 'POST', { imageBase64 }),
  shareToken: skincareShareToken,
  syncSchedule: (share, document) => document === undefined
    ? api(`/api/customer/skincare-schedule?share=${encodeURIComponent(share)}`)
    : api('/api/customer/skincare-schedule', 'PUT', { share, document }),
});
async function safely(fn) { try { await fn(); } catch { notice('暂时无法完成操作，请刷新后重试，或联系人工。'); } }
async function api(path, method = 'GET', body, signal) {
  const response = await fetch(path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(!['GET', 'HEAD'].includes(method) && state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.code ?? '请求失败');
  return data;
}
const path = () => `/api/customer/sessions/${state.sessionId}`;
function visionReady() { $('recognize-care-photo').disabled = !state.visionConfigured || !state.productPhoto || !$('care-photo-authorize').checked || Boolean(state.visionAbort); }
function clearProductPhoto() {
  state.productPhoto = null; $('care-photo').value = ''; $('care-photo-preview').removeAttribute('src');
  $('care-photo-preview').hidden = true; $('care-photo-authorize').checked = false; visionReady();
}
$('care-photo').addEventListener('change', async event => {
  const file = event.currentTarget.files?.[0]; clearProductPhoto();
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5_000_000) {
    $('care-photo-status').textContent = '请选择不超过5MB的 JPG、PNG 或 WebP 包装照片。'; return;
  }
  try {
    const image = new Image(); image.src = await readDataUrl(file); await image.decode();
    const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale)); canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    let photo = canvas.toDataURL('image/jpeg', .78); if (photo.length > 1_300_000) photo = canvas.toDataURL('image/jpeg', .5);
    if (photo.length > 1_300_000) throw new Error('照片压缩后仍超过1MB，请换一张更小的图。');
    state.productPhoto = { mediaType: 'image/jpeg', dataBase64: photo.slice(photo.indexOf(',') + 1) };
    $('care-photo-preview').src = photo; $('care-photo-preview').hidden = false;
    $('care-photo-status').textContent = `照片仅在本页预览；勾选授权并点击按钮后才会发给${state.imageProvider === 'volcano' ? '火山方舟' : 'DeepSeek'}。`; visionReady();
  } catch (error) { $('care-photo-status').textContent = error instanceof Error ? error.message : '照片无法读取，请重新选择。'; clearProductPhoto(); }
});
$('care-photo-authorize').addEventListener('change', visionReady);
$('cancel-care-photo').addEventListener('click', () => state.visionAbort?.abort());
$('recognize-care-photo').addEventListener('click', () => safely(async () => {
  if (!state.productPhoto || !$('care-photo-authorize').checked || !state.visionConfigured) return;
  const photo = state.productPhoto; const abort = new AbortController(); state.visionAbort = abort;
  $('cancel-care-photo').hidden = false; $('care-photo-status').textContent = '正在识别包装文字，不会直接确认商品…'; visionReady();
  $('care-photo-candidates').replaceChildren();
  try {
    const result = await api('/api/customer/packaging/recognize', 'POST', { authorized: true, image: photo }, abort.signal);
    $('care-photo-status').textContent = result.notice;
    const box = $('care-photo-candidates');
    if (result.observed.visibleName || result.observed.visibleSpecification) box.append(el('p',
      `模型读到的名称/规格（请核对包装）：${result.observed.visibleName || '名称不清'} ${result.observed.visibleSpecification}`));
    if (result.observed.visibleText) box.append(el('p', `模型读到的其他文字（未经商品审核）：${result.observed.visibleText}`));
    if (!result.items.length) box.append(el('p', '没有可供确认的已导入商品；识别文字不会自动确认 SKU 或生成护理步骤。', 'muted'));
    for (const product of result.items) {
      const button = el('button', `我确认是 ${product.name}${product.dataKind === 'demo' ? '（虚构演示）' : ''}，以此开始新咨询`);
      button.type = 'button'; button.addEventListener('click', () => safely(async () => {
        $('product-select').value = product.productId;
        if (await newSession()) { openConsult(); careNotice(`已用你确认的 ${product.name} 开始新咨询；图像候选没有自动创建护理计划。`); }
      })); box.append(button);
    }
  } catch (error) {
    $('care-photo-status').textContent = error?.name === 'AbortError' ? '已停止等待；没有确认商品。'
      : error instanceof Error && error.message === 'VISION_NOT_CONFIGURED' ? '图片识别未配置，请用文字查候选。'
        : '图片识别没有完成，请稍后重试或输入包装文字；没有确认商品。';
  } finally { state.visionAbort = null; $('cancel-care-photo').hidden = true; clearProductPhoto(); }
}));
function careNotice(message) { $('care-candidates').textContent = message; }
function renderCare() {
  const routine = state.routine;
  $('care-controls').hidden = !routine || routine.status !== 'active';
  $('care-text-controls').hidden = !routine || routine.status !== 'active';
  $('start-care').disabled = Boolean(routine && routine.status === 'active');
  $('speak-care').disabled = !state.ttsConfigured || !routine || routine.status !== 'active';
  $('record-care').disabled = !state.asrConfigured || !routine || routine.status !== 'active';
  const box = $('care-state'); box.replaceChildren();
  if (!routine) { box.append(el('p', '还没有进行中的护理流程。', 'muted')); return; }
  if (routine.status !== 'active') { box.append(el('p', routine.status === 'finished' ? '本次流程已结束。只有确认过的步骤才会留下完成记录。' : '本次流程已停止。')); return; }
  if (routine.plan) box.append(el('p', `已核验计划 ${routine.plan.planId} / ${routine.plan.version} · 适用范围：${routine.plan.scope} · 审核记录：${routine.plan.reviewSource.title}`, 'small'));
  const step = routine.current; const panel = el('div', undefined, 'care-step');
  panel.append(el('strong', `第 ${routine.currentStep + 1} / ${routine.steps.length} 步：${step.productName}`),
    el('p', step.instruction), el('p', `资料来源：${step.sourceTitle} · ${step.productVersion}${step.dataKind === 'demo' ? ' · 虚构演示资料' : ''}`, 'small'));
  for (const caution of step.caution) panel.append(el('p', `注意：${caution}`, 'small'));
  box.append(panel);
}
async function refreshCareEvents() {
  const { items } = await api('/api/customer/care-events'); const box = $('care-events'); box.replaceChildren();
  const active = items.filter(item => !item.voidedAt);
  if (!active.length) { box.append(el('p', '还没有已确认的护理记录。', 'muted')); return; }
  for (const item of active) {
    const product = state.careProducts.find(product => product.productId === item.productId);
    const row = el('div', undefined, 'care-event'); row.append(el('span', `${new Date(item.createdAt).toLocaleString()} · ${product?.name ?? item.productId} · 第 ${item.stepIndex + 1} 步`));
    const remove = el('button', '删除误记'); remove.type = 'button';
    remove.addEventListener('click', () => safely(async () => {
      if (!confirm('确定撤销这条完成记录吗？')) return;
      await api(`/api/customer/care-events/${item.eventId}`, 'DELETE'); await refreshCareEvents();
    }));
    row.append(remove); box.append(row);
  }
}
async function setupCare() {
  const [products, current, capabilities] = await Promise.all([api('/api/customer/routines/products'), api('/api/customer/routines/current'), api('/api/customer/input/capabilities')]);
  state.visionConfigured = capabilities.imageRecognition === 'configured_unverified';
  state.imageProvider = capabilities.imageProvider;
  state.asrConfigured = capabilities.asr === 'configured_unverified'; state.ttsConfigured = capabilities.tts === 'configured_unverified';
  $('care-image-provider').textContent = state.imageProvider === 'volcano' ? '火山方舟' : state.imageProvider === 'deepseek' ? 'DeepSeek' : '图片服务';
  $('record-consult').disabled = !state.asrConfigured;
  $('speech-status').textContent = state.asrConfigured ? '语音转写已配置但未验收；录音后务必核对草稿。' : '语音转写未配置，可继续打字。';
  $('care-photo-status').textContent = state.visionConfigured
    ? `图片识别已配置但尚未验证效果。只拍产品包装，需另行授权外发${state.imageProvider === 'volcano' ? '火山方舟' : 'DeepSeek'}。`
    : '图片识别未配置。可先输入包装文字找候选；不会上传照片。';
  visionReady();
  state.careProducts = products.items; state.routine = current.routine;
  $('care-products').replaceChildren(...products.items.map(product => {
    const option = el('option', `${product.name}${product.dataKind === 'demo' ? ' · 虚构演示' : ''}`); option.value = product.productId; return option;
  }));
  $('care-products').selectedIndex = -1;
  if (!products.items.length) careNotice('目前没有已审核使用说明的产品；请先从运营端导入产品资料。');
  renderCare(); await refreshCareEvents();
}
$('find-care-products').addEventListener('click', () => safely(async () => {
  const observedText = $('package-text').value.trim(); if (observedText.length < 2) { careNotice('请输入至少两个字的瓶身文字。'); return; }
  const result = await api('/api/customer/packaging/candidates', 'POST', { observedText });
  careNotice(result.items.length ? `找到 ${result.items.length} 个文字匹配候选；请本人核对列表和实物，再手动选择。` : '没有匹配到已审核用法的产品；请检查名称或请组员补充资料，不能猜测。');
  for (const option of $('care-products').options) option.selected = result.items.some(item => item.productId === option.value);
}));
$('start-care').addEventListener('click', () => safely(async () => {
  const productIds = [...$('care-products').selectedOptions].map(option => option.value);
  if (!productIds.length || productIds.length > 3) { careNotice('请本人确认并选择 1–3 件产品。'); return; }
  $('start-care').disabled = true;
  try {
    state.routine = await api('/api/customer/routines', 'POST', { requestId: crypto.randomUUID(), period: $('care-period').value, productIds, confirmed: true });
    careNotice('已按你确认的产品建立流程；这不是图像识别结果。'); renderCare();
  } catch (error) { careNotice(error instanceof Error ? `未能开始：${error.message}` : '未能开始护理，请检查产品使用资料。'); }
  finally { renderCare(); }
}));
$('care-controls').addEventListener('click', event => {
  const button = event.target.closest('[data-care-action]'); if (!button || !state.routine) return;
  safely(async () => {
    for (const control of $('care-controls').querySelectorAll('button')) control.disabled = true;
    try {
      stopVoice();
      const action = button.dataset.careAction;
      state.routine = await api(`/api/customer/routines/${state.routine.routineId}/actions`, 'POST', {
        requestId: crypto.randomUUID(), expectedStep: state.routine.currentStep, action, source: 'screen',
      });
      careNotice(action === 'confirm' ? '这一阶段已由你确认并记录。' : action === 'skip' ? '已跳过；未记作完成。' : action === 'stop' ? '已停止。' : '正在显示当前步骤，没有推进。');
      renderCare(); await refreshCareEvents();
    } catch (error) { careNotice(error instanceof Error ? `操作未完成：${error.message}` : '操作未完成，请刷新后重试。'); }
    finally { for (const control of $('care-controls').querySelectorAll('button')) control.disabled = false; }
  });
});
$('send-care-command').addEventListener('click', () => safely(async () => {
  if (!state.routine || !$('care-command').value.trim()) return;
  $('send-care-command').disabled = true;
  try {
    stopVoice();
    state.routine = await api(`/api/customer/routines/${state.routine.routineId}/text-commands`, 'POST', {
      requestId: crypto.randomUUID(), expectedStep: state.routine.currentStep, text: $('care-command').value.trim(),
    });
    $('care-command').value = ''; careNotice('文字指令已处理；只有“好了”或“完成”会记录完成。');
    renderCare(); await refreshCareEvents();
  } catch (error) { careNotice(error instanceof Error ? error.message : '文字指令没有处理成功。'); }
  finally { $('send-care-command').disabled = false; }
}));
function stopVoice() {
  state.voiceAbort?.abort(); state.voiceAbort = null;
  state.voice?.pause(); state.voice = null;
  if (state.voiceUrl) URL.revokeObjectURL(state.voiceUrl);
  state.voiceUrl = null; $('stop-speech').hidden = true;
}
$('stop-speech').addEventListener('click', stopVoice);
$('speak-care').addEventListener('click', () => safely(async () => {
  if (!state.routine?.current || !state.ttsConfigured) return;
  stopVoice(); const controller = new AbortController(); state.voiceAbort = controller;
  const step = state.routine.currentStep; const routineId = state.routine.routineId; $('speak-care').disabled = true;
  try {
    const result = await api('/api/customer/speech/synthesize', 'POST', { authorized: true, routineId }, controller.signal);
    if (controller.signal.aborted || state.routine?.currentStep !== step || state.routine?.routineId !== routineId) return;
    state.voiceAbort = null;
    await playVoice(result);
  } catch { if (!controller.signal.aborted) { stopVoice(); careNotice('暂时无法朗读，请阅读屏幕上的步骤文字。'); } }
  finally { $('speak-care').disabled = !state.ttsConfigured || state.routine?.status !== 'active'; }
}));
async function playVoice(result) {
  const bytes = Uint8Array.from(atob(result.dataBase64), letter => letter.charCodeAt(0));
  state.voiceUrl = URL.createObjectURL(new Blob([bytes], { type: result.mediaType }));
  state.voice = new Audio(state.voiceUrl); $('stop-speech').hidden = false;
  state.voice.onended = stopVoice; await state.voice.play();
}
async function recordTo(target) {
  if (!state.asrConfigured || state.recorder) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder?.isTypeSupported('audio/webm')) {
    $('speech-status').textContent = '浏览器不支持 WebM 录音；请使用文字输入。'; return;
  }
  stopVoice(); // Prevent our own TTS from being recorded and turned into a command.
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { $('speech-status').textContent = '没有取得麦克风授权；可继续打字。'; return; }
  const chunks = []; const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' }); state.recorder = recorder;
  $('record-consult').disabled = true; $('record-care').disabled = true; $('stop-recording').hidden = false;
  $('speech-status').textContent = '录音中；完成后点击停止。音频尚未发送。';
  const timeout = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, 20_000);
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.onstop = async () => {
    clearTimeout(timeout); stream.getTracks().forEach(track => track.stop()); state.recorder = null;
    $('stop-recording').hidden = true; $('record-consult').disabled = !state.asrConfigured; renderCare();
    const blob = new Blob(chunks, { type: 'audio/webm' });
    if (!blob.size || blob.size > 2_000_000) { $('speech-status').textContent = '录音为空或超过2MB，请缩短录音。'; return; }
    $('speech-status').textContent = '正在转写；不会自动发送或执行。';
    try {
      const wav = await recordedWav(blob);
      const dataBase64 = (await readDataUrl(wav)).split(',')[1];
      const result = await api('/api/customer/speech/transcribe', 'POST', { authorized: true, mediaType: 'audio/wav', dataBase64 });
      $(target).value = result.text; $(target).focus();
      $('speech-status').textContent = result.text ? '转写已填入草稿；核对无误后请手动点击发送。' : '没听清楚，请重新录制或打字。';
    } catch { $('speech-status').textContent = '转写失败；没有执行任何指令。请使用文字输入。'; }
  };
  recorder.start();
}
$('record-consult').addEventListener('click', () => recordTo('message'));
$('record-care').addEventListener('click', () => recordTo('care-command'));
$('stop-recording').addEventListener('click', () => { if (state.recorder?.state === 'recording') state.recorder.stop(); });
async function recordedWav(blob) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000; const length = Math.ceil(decoded.duration * rate);
    if (!length || length > 320_000) throw new Error('录音时间过长');
    const offline = new OfflineAudioContext(1, length, rate);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
    const samples = (await offline.startRendering()).getChannelData(0);
    const buffer = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(buffer);
    const chars = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
    chars(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); chars(8, 'WAVE'); chars(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    chars(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) { const value = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true); }
    return new Blob([buffer], { type: 'audio/wav' });
  } finally { await context.close(); }
}
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
async function loadVideoMoments() {
  const { items } = await api('/api/customer/video-moments'); const box = $('saved-video-moments'); box.replaceChildren();
  if (!items.length) { box.append(el('p', '没有保存的照片批次。', 'muted')); return; }
  for (const item of items) {
    const row = el('div', undefined, 'care-event');
    row.append(el('span', `${new Date(item.createdAt).toLocaleString()} · ${item.photoCount} 张 · 未生成视频`));
    const remove = el('button', '删除这批照片'); remove.type = 'button';
    remove.addEventListener('click', () => safely(async () => {
      if (!confirm('确定删除这批已保存照片及清单吗？此操作无法恢复。')) return;
      remove.disabled = true;
      try { await api(`/api/customer/video-moments/${item.jobId}`, 'DELETE'); await loadVideoMoments(); }
      catch { remove.disabled = false; $('video-moment-feedback').textContent = '删除失败，请稍后再试。'; }
    })); row.append(remove); box.append(row);
  }
}
$('video-submit').addEventListener('click', () => safely(async () => {
  const button = $('video-submit'); button.disabled = true; $('video-moment-feedback').className = 'form-feedback'; $('video-moment-feedback').textContent = '正在把授权素材交给“悦见时刻”测试…';
  try {
    const result = await api('/api/customer/video-moments', 'POST', { authorized: true, photos: state.videoPhotos.map(({ byteSize, ...photo }) => photo) });
    $('video-moment-feedback').classList.add('success');
    $('video-moment-feedback').textContent = `${result.message} 已接收 ${result.photoCount} 张，目标约 ${result.requestedDurationSeconds} 秒。`;
    state.videoPhotos = []; $('video-authorize').checked = false; await loadVideoMoments();
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
      if (state.ttsConfigured && message.content.length <= 500 && message.content !== '当前智能客服暂时无法完成回复。您的消息已保存，可以稍后重试或请求人工。') {
        const speak = el('button', '朗读这条回复'); speak.type = 'button';
        speak.addEventListener('click', () => safely(async () => {
          speak.disabled = true; stopVoice(); const controller = new AbortController(); state.voiceAbort = controller;
          try {
            const audio = await api('/api/customer/speech/synthesize', 'POST', { authorized: true, messageId: message.messageId }, controller.signal);
            if (controller.signal.aborted) return;
            state.voiceAbort = null; await playVoice(audio);
          } catch { if (!controller.signal.aborted) { stopVoice(); notice('播报失败，仍可阅读这条文字回复。'); } }
          finally { speak.disabled = false; }
        })); buttons.append(speak);
      }
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
  await skincareSchedule.hydrateShared();
  const info = await api('/api/customer/bootstrap'); state.productId = info.products[0]?.productId ?? '';
  $('product-select').replaceChildren();
  for (const product of info.products) {
    const option = el('option', `${product.name}${product.dataKind === 'demo' ? ' · 演示' : ''}`); option.value = product.productId;
    $('product-select').append(option);
  }
  $('product-select').value = state.productId;
  $('service-status').textContent = !state.productId ? '服务准备中' : info.serviceAvailable ? '欢迎咨询' : '可留言或联系人工';
  notice(!state.productId ? '客服资料正在准备中，请稍后再来。' : info.products[0]?.dataKind === 'demo' ? '当前为演示资料，我们会明确区分示例与真实商品信息。' : '有什么问题，随时告诉我。');
  renderCard(info.card); await Promise.all([sessions(), setupCare()]);
  try { pending(JSON.parse(sessionStorage.getItem('customer-pending') ?? 'null')); } catch { pending(null); }
  setInterval(() => { if (!document.hidden) safely(messages); }, 5000);
});
