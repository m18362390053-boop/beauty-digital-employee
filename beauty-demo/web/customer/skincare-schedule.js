const STORAGE_KEY = 'warm-beauty-skincare-schedule-v1';
const PERIODS = ['morning', 'evening'];
const PERIOD_LABELS = { morning: '早上', evening: '晚上', both: '早晚' };
const OBSERVATION_LABELS = { steady: '变化不大', improved: '有些改善', fluctuating: '状态有起伏' };
const today = new Date();
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const parseDate = value => { const [year, month, day] = value.split('-').map(Number); return new Date(year, month - 1, day); };
const shiftDate = (value, amount) => { const date = parseDate(value); date.setDate(date.getDate() + amount); return dateKey(date); };
const expiryFromOpening = (openedOn, months) => {
  if (!openedOn || !months) return '';
  const opened = parseDate(openedOn);
  const targetMonth = opened.getMonth() + Number(months);
  const lastDay = new Date(opened.getFullYear(), targetMonth + 1, 0).getDate();
  const expiry = new Date(opened.getFullYear(), targetMonth, Math.min(opened.getDate(), lastDay));
  return dateKey(expiry);
};
const monthKey = value => value.slice(0, 7);
const defaultData = () => ({
  products: [],
  checks: {},
  observations: {},
  ocrDraft: null,
});

function readData() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (parsed && Array.isArray(parsed.products) && parsed.checks && parsed.observations) {
      parsed.products = parsed.products.map(product => ({ ...product, startDate: product.startDate ?? '0000-01-01' }));
      return parsed;
    }
  } catch { /* An invalid local record should not prevent the schedule from opening. */ }
  return defaultData();
}

export function initSkincareSchedule({ recognize, shareToken = '', syncSchedule } = {}) {
  const $ = id => document.getElementById(id);
  const localStorageKey = shareToken ? `${STORAGE_KEY}:${shareToken.slice(0, 12)}` : STORAGE_KEY;
  let data = readData();
  try {
    const sharedLocal = JSON.parse(localStorage.getItem(localStorageKey) ?? 'null');
    if (sharedLocal?.products && sharedLocal?.checks && sharedLocal?.observations) data = sharedLocal;
  } catch { /* Keep the existing local schedule if its shared copy is invalid. */ }
  let remoteReady = false;
  let dirtyLocal = false;
  let syncChain = Promise.resolve();
  let remoteUpdatedAt = '';
  let lastSyncedSnapshot = '';
  let selectedDate = dateKey(today);
  let visibleMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const save = () => {
    try {
      const snapshot = JSON.stringify(data);
      localStorage.setItem(STORAGE_KEY, snapshot);
      if (shareToken) localStorage.setItem(localStorageKey, snapshot);
      $('schedule-storage-feedback').hidden = true;
      dirtyLocal = true;
      if (shareToken && remoteReady && syncSchedule) {
        const copy = JSON.parse(snapshot);
        syncChain = syncChain.then(() => syncSchedule(shareToken, copy)).then(result => {
          remoteUpdatedAt = result.updatedAt ?? remoteUpdatedAt;
          lastSyncedSnapshot = snapshot;
          dirtyLocal = false;
          $('schedule-sync-feedback').textContent = '已同步到同一链接打开的电脑和手机';
        }).catch(() => {
          $('schedule-sync-feedback').textContent = '本机已保存；共享同步暂时失败，请检查连接后再试';
        });
      }
      return true;
    }
    catch { $('schedule-storage-feedback').textContent = '这次更改暂时没有保存到浏览器，请清理存储空间后重试。'; $('schedule-storage-feedback').hidden = false; return false; }
  };
  const completedCount = day => Object.values(data.checks[day] ?? {}).filter(Boolean).length;
  const isDayComplete = day => completedCount(day) > 0;
  const productPeriods = period => period === 'both' ? PERIODS : [period];
  const visibleProducts = () => data.products.filter(product => !(/（示例）$/.test(product.name) && !product.category));
  const categoryGroup = category => ['洁面'].includes(category) ? 'cleansing' : ['口红', '彩妆'].includes(category) ? 'makeup' : ['洗发护发', '造型护理'].includes(category) ? 'hair' : 'skincare';
  const scheduledFor = (product, day) => (product.startDate ?? '0000-01-01') <= day
    && (!product.endDate || day < product.endDate)
    && (!product.weekdays || product.weekdays.includes(parseDate(day).getDay()))
    && (!product.expiry || day <= product.expiry);
  const dayProducts = day => visibleProducts().filter(product => scheduledFor(product, day));
  const weekdayText = product => !product.weekdays || product.weekdays.length === 7 ? '每天' : `周${product.weekdays.map(day => '日一二三四五六'[day]).join('、')}`;
  const formatDate = value => {
    const date = parseDate(value);
    return `${date.getMonth() + 1}月${date.getDate()}日 · ${['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()]}`;
  };
  function renderHabits() {
    const todayKey = dateKey(today);
    let streak = 0;
    let cursor = isDayComplete(todayKey) ? todayKey : shiftDate(todayKey, -1);
    while (isDayComplete(cursor) && streak < 366) { streak += 1; cursor = shiftDate(cursor, -1); }
    const weekday = (today.getDay() + 6) % 7;
    const monday = shiftDate(todayKey, -weekday);
    const weekCount = Array.from({ length: 7 }, (_, index) => shiftDate(monday, index)).filter(day => day <= todayKey && isDayComplete(day)).length;
    $('schedule-streak').textContent = String(streak);
    $('schedule-week-count').textContent = `本周 ${weekCount} 次`;
    const todayProducts = dayProducts(todayKey);
    $('schedule-tonight-copy').textContent = todayProducts.length
      ? `今天安排了 ${todayProducts.filter(item => productPeriods(item.period).includes('evening')).length} 步晚间护理`
      : '先添加一件护肤品，日程就会出现';
  }
  function renderCalendar() {
    const year = visibleMonth.getFullYear(); const month = visibleMonth.getMonth();
    $('calendar-title').textContent = `${year} 年 ${month + 1} 月`;
    const firstDay = new Date(year, month, 1); const offset = (firstDay.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const totalCells = Math.ceil((offset + daysInMonth) / 7) * 7;
    const grid = $('calendar-grid'); grid.replaceChildren();
    for (let index = 0; index < totalCells; index += 1) {
      const dayNumber = index - offset + 1;
      const inMonth = dayNumber >= 1 && dayNumber <= daysInMonth;
      const date = new Date(year, month, dayNumber);
      const key = dateKey(date);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'calendar-day';
      button.disabled = !inMonth;
      if (inMonth) {
        button.setAttribute('aria-label', `${formatDate(key)}${isDayComplete(key) ? '，有护理打卡' : ''}`);
        button.append(document.createTextNode(String(dayNumber)));
        if (key === dateKey(today)) button.classList.add('today');
        if (key === selectedDate) { button.classList.add('selected'); button.setAttribute('aria-current', 'date'); }
        if (isDayComplete(key)) { const dot = document.createElement('span'); dot.className = 'calendar-check-dot'; dot.setAttribute('aria-hidden', 'true'); button.append(dot); }
        button.addEventListener('click', () => { selectedDate = key; renderCalendar(); renderDay(); renderObservations(); });
      }
      grid.append(button);
    }
  }
  function renderProducts() {
    const list = $('schedule-products'); list.replaceChildren();
    const activeProducts = visibleProducts().filter(product => !product.endDate);
    $('schedule-product-count').textContent = `${activeProducts.length} 件`;
    const draft = data.ocrDraft;
    if (draft?.candidates?.length) {
      const pending = document.createElement('li'); pending.className = 'ocr-pending';
      const title = document.createElement('strong'); title.textContent = '待核对的识别结果';
      const candidate = document.createElement('p'); candidate.textContent = draft.candidates.join(' / ');
      const when = document.createElement('small'); when.textContent = '手机拍摄识别 · 请核对后补全产品信息';
      const review = document.createElement('button'); review.type = 'button'; review.textContent = '核对并补全'; review.addEventListener('click', () => { showEntry(); $('schedule-product-name').value = draft.candidates[0]; $('schedule-product-category').focus(); });
      pending.append(title, candidate, when, review); list.append(pending);
    }
    if (!activeProducts.length) {
      const empty = document.createElement('li'); empty.className = 'schedule-product-empty';
      empty.textContent = '还没有已保存的产品。点右上角“添加护肤品”开始记录。'; list.append(empty); return;
    }
    for (const product of activeProducts) {
      const item = document.createElement('li'); item.className = `schedule-product-item category-${categoryGroup(product.category)}`;
      const copy = document.createElement('div'); copy.className = 'product-copy';
      const name = document.createElement('strong'); name.textContent = product.name;
      const detail = document.createElement('small'); detail.textContent = `${product.category || '护肤'} · ${product.area ? `用于${product.area} · ` : ''}${PERIOD_LABELS[product.period] ?? '早上'}`;
      const dates = document.createElement('p'); dates.className = 'product-dates'; dates.textContent = `开封 ${product.openedOn || '未记录'}　预计用至 ${product.expiry || '待计算'}`;
      const track = document.createElement('div'); track.className = 'product-timeline'; track.setAttribute('role', 'img'); track.setAttribute('aria-label', `建议使用周期：${product.openedOn || '未记录'} 至 ${product.expiry || '待计算'}`);
      const bar = document.createElement('span'); bar.className = 'product-timeline-bar'; const now = dateKey(today); const spanStart = product.openedOn || now; const spanEnd = product.expiry || now;
      const monthsApart = (a, b) => { const x = parseDate(a); const y = parseDate(b); return (y.getFullYear() - x.getFullYear()) * 12 + y.getMonth() - x.getMonth(); };
      const monthOffset = Math.max(0, Math.min(11, monthsApart(`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-01`, `${spanStart.slice(0,7)}-01`)));
      const monthsDuration = Math.max(1, Math.min(12 - monthOffset, monthsApart(spanStart, spanEnd)));
      bar.style.setProperty('--timeline-start', `${monthOffset * 8.333}%`); bar.style.setProperty('--timeline-width', `${monthsDuration * 8.333}%`); track.append(bar);
      const months = document.createElement('div'); months.className = 'product-timeline-months';
      for (let i = 0; i < 12; i += 1) { const tick = document.createElement('span'); tick.textContent = `${(today.getMonth() + i) % 12 + 1}月`; months.append(tick); }
      copy.append(name, detail, dates, track, months);
      const controls = document.createElement('div'); controls.className = 'product-controls';
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'product-edit'; edit.textContent = '编辑';
      edit.setAttribute('aria-label', `编辑${product.name}`);
      edit.addEventListener('click', () => {
        const editor = document.createElement('form'); editor.className = 'product-inline-editor';
        const productName = document.createElement('input'); productName.value = product.name; productName.maxLength = 80; productName.required = true; productName.setAttribute('aria-label', '产品名称');
        const category = document.createElement('select'); category.required = true; category.setAttribute('aria-label', '产品类别');
        for (const value of ['', '洁面', '化妆水', '精华', '乳液', '面霜', '防晒', '眼霜', '面膜', '其他']) { const option = document.createElement('option'); option.value = value; option.textContent = value || '选择类别'; category.append(option); }
        category.value = product.category ?? '';
        const shelfLife = document.createElement('input'); shelfLife.type = 'number'; shelfLife.min = '1'; shelfLife.max = '60'; shelfLife.required = true; shelfLife.value = product.shelfLifeMonths ?? ''; shelfLife.setAttribute('aria-label', '开封后保质期，月');
        const openedOn = document.createElement('input'); openedOn.type = 'date'; openedOn.required = true; openedOn.value = product.openedOn ?? ''; openedOn.setAttribute('aria-label', '开封日期');
        const area = document.createElement('input'); area.required = true; area.maxLength = 40; area.value = product.area ?? ''; area.setAttribute('aria-label', '使用区域');
        const period = document.createElement('select'); period.setAttribute('aria-label', '使用时段');
        for (const [value, label] of Object.entries(PERIOD_LABELS)) { const option = document.createElement('option'); option.value = value; option.textContent = label; period.append(option); }
        period.value = product.period;
        const weekdays = document.createElement('select'); weekdays.setAttribute('aria-label', '使用频率');
        for (const [value, label] of [['daily', '每天'], ['weekdays', '每周一至五'], ['weekends', '每周末']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; weekdays.append(option); }
        weekdays.value = !product.weekdays || product.weekdays.length === 7 ? 'daily' : product.weekdays.length === 5 ? 'weekdays' : 'weekends';
        const saveEdit = document.createElement('button'); saveEdit.type = 'submit'; saveEdit.textContent = '保存';
        const cancelEdit = document.createElement('button'); cancelEdit.type = 'button'; cancelEdit.textContent = '取消';
        editor.append(category, productName, shelfLife, openedOn, period, area, weekdays, saveEdit, cancelEdit);
        item.replaceChildren(editor); productName.focus();
        cancelEdit.addEventListener('click', () => renderProducts());
        editor.addEventListener('submit', event => {
          event.preventDefault(); const newName = productName.value.trim(); if (!newName) { productName.focus(); return; }
          const selectedDays = weekdays.value === 'daily' ? [0,1,2,3,4,5,6] : weekdays.value === 'weekdays' ? [1,2,3,4,5] : [0,6];
          if (!selectedDays.length) { $('schedule-feedback').textContent = '请至少选择一天。'; weekdays.focus(); return; }
          if (openedOn.value > dateKey(today)) { $('schedule-feedback').textContent = '开封日期不能晚于今天。'; openedOn.focus(); return; }
          const old = { ...product };
          Object.assign(product, { category: category.value, name: newName, shelfLifeMonths: Number(shelfLife.value), openedOn: openedOn.value, area: area.value.trim(), period: period.value, weekdays: selectedDays, expiry: expiryFromOpening(openedOn.value, shelfLife.value) });
          const oldChecks = JSON.parse(JSON.stringify(data.checks));
          if (product.period !== old.period) for (const day of Object.keys(data.checks)) {
            for (const part of PERIODS) if (!productPeriods(product.period).includes(part)) delete data.checks[day][`${product.id}:${part}`];
          }
          if (save()) renderAll(); else { Object.assign(product, old); data.checks = oldChecks; renderAll(); }
        });
      });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'product-remove'; remove.textContent = '停用';
      remove.setAttribute('aria-label', `停止安排${product.name}，保留过去打卡`);
      remove.addEventListener('click', () => {
        product.endDate = shiftDate(dateKey(today), 1);
        if (!save()) delete product.endDate;
        renderAll();
      });
      controls.append(edit, remove); item.append(copy, controls); list.append(item);
    }
  }
  function renderDay() {
    $('schedule-day-title').textContent = selectedDate === dateKey(today) ? `今天 · ${formatDate(selectedDate)}` : formatDate(selectedDate);
    const done = completedCount(selectedDate);
    const planned = dayProducts(selectedDate)
      .reduce((total, product) => total + productPeriods(product.period).length, 0);
    $('schedule-day-summary').textContent = done ? `已完成 ${done} / ${planned} 项` : planned ? `安排 ${planned} 步` : '还没安排';
    const events = $('schedule-events'); events.replaceChildren();
    for (const period of PERIODS) {
      const items = dayProducts(selectedDate).filter(product => productPeriods(product.period).includes(period));
      const block = document.createElement('section'); block.className = `schedule-period schedule-period-${period}`;
      const heading = document.createElement('div'); heading.className = 'period-heading';
      const title = document.createElement('h3'); title.textContent = period === 'morning' ? '早上' : '晚上';
      const timing = document.createElement('span'); timing.textContent = period === 'morning' ? '洗脸后 · 按自己的节奏' : '睡前 · 一步一步来';
      heading.append(title, timing); block.append(heading);
      if (!items.length) {
        const empty = document.createElement('p'); empty.className = 'period-empty'; empty.textContent = '这段时间还没有安排。可以在“我的护肤品”里添加。'; block.append(empty);
      }
      for (const product of items) {
        const checkKey = `${product.id}:${period}`;
        const row = document.createElement('article'); row.className = 'schedule-event';
        const marker = document.createElement('span'); marker.className = 'event-marker'; marker.setAttribute('aria-hidden', 'true');
        const copy = document.createElement('div'); copy.className = 'event-copy';
        const name = document.createElement('strong'); name.textContent = product.name;
        const note = document.createElement('small'); note.textContent = product.area ? `用于${product.area} · 按包装说明使用` : product.note || '按产品标签说明使用';
        copy.append(name, note);
        const checked = Boolean(data.checks[selectedDate]?.[checkKey]);
        const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = `event-check${checked ? ' is-checked' : ''}`;
        const inFuture = selectedDate > dateKey(today);
        toggle.disabled = inFuture; toggle.title = inFuture ? '当天还没到，暂时不能打卡' : '';
        toggle.setAttribute('aria-pressed', String(checked)); toggle.setAttribute('aria-label', `${checked ? '取消' : '完成'}${product.name}`); toggle.textContent = checked ? '已完成' : '好了';
        toggle.addEventListener('click', () => {
          data.checks[selectedDate] ??= {};
          if (checked) delete data.checks[selectedDate][checkKey]; else data.checks[selectedDate][checkKey] = true;
          if (!save()) { if (checked) data.checks[selectedDate][checkKey] = true; else delete data.checks[selectedDate][checkKey]; }
          renderAll();
        });
        row.append(marker, copy, toggle); block.append(row);
      }
      events.append(block);
    }
    const isToday = selectedDate === dateKey(today);
    $('schedule-start-evening').disabled = !isToday || !dayProducts(selectedDate).some(product => productPeriods(product.period).includes('evening'));
    $('schedule-start-evening').title = isToday ? '' : '选择今天后，才能开始今晚的护肤';
  }
  function renderObservations() {
    const month = monthKey(selectedDate);
    const selected = data.observations[selectedDate];
    const selectedDateValue = parseDate(selectedDate);
    $('observation-title').textContent = `${selectedDateValue.getFullYear()}年${selectedDateValue.getMonth() + 1}月 · 皮肤观察`;
    $('observation-status').value = selected?.status ?? 'steady';
    $('observation-note').value = selected?.note ?? '';
    const entries = Object.entries(data.observations).filter(([day, value]) => monthKey(day) === month && value?.note).sort(([a], [b]) => b.localeCompare(a));
    $('observation-month-count').textContent = entries.length ? `这个月 ${entries.length} 次` : '还没有记录';
    const history = $('observation-history'); history.replaceChildren();
    if (!entries.length) { const empty = document.createElement('p'); empty.className = 'observation-empty'; empty.textContent = '写下一点小感受，下次回来看就有迹可循。'; history.append(empty); return; }
    for (const [day, value] of entries.slice(0, 5)) {
      const article = document.createElement('article'); article.className = 'observation-entry';
      const label = document.createElement('span'); label.textContent = OBSERVATION_LABELS[value.status] ?? OBSERVATION_LABELS.steady;
      const date = document.createElement('time'); date.dateTime = day; date.textContent = `${parseDate(day).getMonth() + 1}月${parseDate(day).getDate()}日`;
      const note = document.createElement('p'); note.textContent = value.note;
      article.append(label, date, note); history.append(article);
    }
  }
  function renderAll() { renderHabits(); renderCalendar(); renderDay(); renderProducts(); renderObservations(); }

  $('calendar-prev').addEventListener('click', () => { visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1); renderCalendar(); });
  $('calendar-next').addEventListener('click', () => { visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1); renderCalendar(); });
  $('calendar-today').addEventListener('click', () => { selectedDate = dateKey(today); visibleMonth = new Date(today.getFullYear(), today.getMonth(), 1); renderAll(); });
  $('schedule-start-evening').addEventListener('click', () => {
    const first = document.querySelector('.schedule-period-evening .event-check:not(.is-checked)') ?? document.querySelector('.schedule-period-evening .event-check');
    first?.focus(); first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  const form = $('schedule-product-form');
  const photoInput = $('schedule-product-photo');
  const uploadInput = $('schedule-product-upload');
  const ocrResult = $('schedule-ocr-result');
  const clearScan = () => { ocrResult.hidden = true; ocrResult.replaceChildren(); photoInput.value = ''; uploadInput.value = ''; };
  const showEntry = () => { $('schedule-panel').hidden = true; $('products-panel').hidden = true; $('product-entry-panel').hidden = false; $('schedule-bottom-nav').hidden = true; $('schedule-product-opened').value ||= dateKey(today); };
  const showInventory = () => { $('schedule-panel').hidden = true; $('product-entry-panel').hidden = true; $('products-panel').hidden = false; $('schedule-bottom-nav').hidden = false; document.querySelector('[data-schedule-tab="products"]').setAttribute('aria-current', 'page'); document.querySelector('[data-schedule-tab="schedule"]').removeAttribute('aria-current'); };
  const showSchedule = () => { $('products-panel').hidden = true; $('product-entry-panel').hidden = true; $('schedule-panel').hidden = false; $('schedule-bottom-nav').hidden = false; document.querySelector('[data-schedule-tab="schedule"]').setAttribute('aria-current', 'page'); document.querySelector('[data-schedule-tab="products"]').removeAttribute('aria-current'); };
  $('schedule-open-camera').addEventListener('click', () => photoInput.click());
  $('schedule-scan-product').addEventListener('click', () => uploadInput.click());
  for (const input of [photoInput, uploadInput]) input.addEventListener('change', async () => { const file = input.files?.[0]; input.value = ''; if (file) await recognizePhoto(file); });
  async function recognizePhoto(file) {
    ocrResult.hidden = false; ocrResult.textContent = '正在识别包装文字…';
    const scanButton = $('schedule-scan-product'); scanButton.disabled = true; $('schedule-open-camera').disabled = true;
    try {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(file.type) || file.size > 24_000_000) throw new Error('请选择小于 24 MB 的清晰包装照片。');
      const image = new Image(); const url = URL.createObjectURL(file); image.src = url;
      try { await image.decode(); } finally { URL.revokeObjectURL(url); }
      let scale = Math.min(1, 3000 / Math.max(image.naturalWidth, image.naturalHeight));
      let canvas = document.createElement('canvas'); let base64 = '';
      for (const quality of [.94, .88, .8]) {
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d', { willReadFrequently: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
        base64 = canvas.toDataURL('image/jpeg', quality).split(',')[1] ?? '';
        if (base64.length <= 7_300_000) break;
        scale *= .85;
      }
      if (!base64 || base64.length > 7_300_000) throw new Error('照片太大，请靠近包装重拍，或从相册选择。');
      const result = await recognize(base64);
      ocrResult.replaceChildren();
      const message = document.createElement('p'); message.textContent = result.message; ocrResult.append(message);
      if (result.candidates?.length) {
        data.ocrDraft = { candidates: result.candidates.slice(0, 8), recognizedAt: new Date().toISOString() };
        if (save()) { $('schedule-sync-feedback').textContent = '识别结果已同步到电脑，等待核对'; }
        $('schedule-product-name').value = result.candidates[0];
        const suggestions = document.createElement('div'); suggestions.className = 'product-ocr-suggestions';
        for (const name of result.candidates) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = name;
          button.addEventListener('click', () => { $('schedule-product-name').value = name; $('schedule-product-name').focus(); });
          suggestions.append(button);
        }
        ocrResult.append(suggestions);
        $('schedule-product-name').focus();
      }
    } catch (error) { ocrResult.textContent = error?.message?.startsWith('请选择') || error?.message?.startsWith('照片') ? error.message : '这张照片没有读清文字。请让包装占满画面、点按文字对焦、避开反光后重拍；也可以手动填写。'; }
    finally { scanButton.disabled = false; $('schedule-open-camera').disabled = false; }
  }
  $('schedule-add-product').addEventListener('click', () => { form.reset(); clearScan(); $('schedule-product-opened').value = dateKey(today); showEntry(); $('schedule-product-name').focus(); });
  $('schedule-cancel-product').addEventListener('click', showInventory);
  $('schedule-entry-cancel').addEventListener('click', () => { form.reset(); clearScan(); showInventory(); });
  for (const button of document.querySelectorAll('[data-schedule-tab]')) button.addEventListener('click', () => button.dataset.scheduleTab === 'products' ? showInventory() : showSchedule());
  form.addEventListener('submit', event => {
    event.preventDefault(); const name = $('schedule-product-name').value.trim();
    if (!name) { $('schedule-product-name').focus(); return; }
    const weekdays = [...form.querySelectorAll('.product-weekdays input:checked')].map(input => Number(input.value));
    if (!weekdays.length) { $('schedule-feedback').textContent = '请至少选择一天。'; return; }
    const openedOn = $('schedule-product-opened').value;
    if (openedOn > dateKey(today)) { $('schedule-feedback').textContent = '开封日期不能晚于今天。'; return; }
    data.products.push({ id: crypto.randomUUID(), category: $('schedule-product-category').value, name, shelfLifeMonths: Number($('schedule-product-shelf-life').value), openedOn, area: $('schedule-product-area').value.trim(), period: $('schedule-product-period').value, weekdays, expiry: expiryFromOpening(openedOn, $('schedule-product-shelf-life').value), startDate: dateKey(today) });
    if (save()) { data.ocrDraft = null; save(); form.reset(); clearScan(); showInventory(); $('schedule-feedback').textContent = '已保存并加入日程。'; renderAll(); }
    else data.products.pop();
  });
  $('schedule-observation-form').addEventListener('submit', event => {
    event.preventDefault(); const note = $('observation-note').value.trim();
    if (!note) { $('observation-feedback').textContent = '先写一句感受，再保存吧。'; $('observation-note').focus(); return; }
    if (selectedDate > dateKey(today)) { $('observation-feedback').textContent = '未来日期还不能记录观察。'; return; }
    const old = data.observations[selectedDate];
    data.observations[selectedDate] = { status: $('observation-status').value, note };
    if (save()) { $('observation-feedback').textContent = '记下了，下次可以回来看看。'; renderObservations(); }
    else if (old) data.observations[selectedDate] = old; else delete data.observations[selectedDate];
  });
  renderAll();
  return {
    showSchedule,
    async hydrateShared() {
      if (!shareToken || !syncSchedule) {
        $('schedule-sync-feedback').textContent = '此页面为本机日程；请使用同一共享链接在手机和电脑查看';
        return;
      }
      try {
        const response = await syncSchedule(shareToken);
        if (response.document) {
          data = response.document;
          remoteUpdatedAt = response.updatedAt ?? '';
          lastSyncedSnapshot = JSON.stringify(data);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
          localStorage.setItem(localStorageKey, JSON.stringify(data));
          renderAll();
          $('schedule-sync-feedback').textContent = '已连接共享日程，手机和电脑将显示相同记录';
        } else {
          $('schedule-sync-feedback').textContent = '共享日程已建立';
          remoteReady = true;
          save();
        }
        remoteReady = true;
        if (dirtyLocal) save();
        window.setInterval(async () => {
          if (document.hidden) return;
          try {
            const latest = await syncSchedule(shareToken);
            if (!latest.document || !latest.updatedAt || latest.updatedAt === remoteUpdatedAt || !form.hidden) return;
            if (JSON.stringify(data) !== lastSyncedSnapshot) return;
            data = latest.document;
            remoteUpdatedAt = latest.updatedAt;
            lastSyncedSnapshot = JSON.stringify(data);
            localStorage.setItem(STORAGE_KEY, lastSyncedSnapshot);
            localStorage.setItem(localStorageKey, lastSyncedSnapshot);
            renderAll();
            $('schedule-sync-feedback').textContent = '手机或电脑上的日程已更新';
          } catch { /* Keep the last synced data visible while the other device is offline. */ }
        }, 4000);
      } catch {
        $('schedule-sync-feedback').textContent = '共享日程连接失败；本机记录仍会保留';
      }
    },
  };
}
