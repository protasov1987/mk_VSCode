// === КОНСТАНТЫ И ГЛОБАЛЬНЫЕ МАССИВЫ ===
const API_ENDPOINT = '/api/data';

let cards = [];
let ops = [];
let centers = [];
let workorderSearchTerm = '';
let workorderStatusFilter = 'ALL';
let archiveSearchTerm = '';
let archiveStatusFilter = 'ALL';
let apiOnline = false;
const workorderOpenCards = new Set();
let activeCardDraft = null;
let activeCardOriginalId = null;
let activeCardIsNew = false;
let cardsSearchTerm = '';
let workorderContractTerm = '';
let archiveContractTerm = '';
let attachmentContext = null;
const ATTACH_ACCEPT = '.pdf,.doc,.docx,.jpg,.jpeg,.png,.zip,.rar,.7z';
const ATTACH_MAX_SIZE = 15 * 1024 * 1024; // 15 MB
let logContextCardId = null;
let clockIntervalId = null;

function setConnectionStatus(message, variant = 'info') {
  const banner = document.getElementById('server-status');
  if (!banner) return;

  if (!message) {
    banner.classList.add('hidden');
    return;
  }

  banner.textContent = message;
  banner.className = `status-banner status-${variant}`;
}

function startRealtimeClock() {
  const el = document.getElementById('realtime-clock');
  if (!el) return;
  const update = () => {
    const now = new Date();
    const date = now.toLocaleDateString('ru-RU');
    const time = now.toLocaleTimeString('ru-RU');
    el.textContent = `${date} ${time}`;
  };
  update();
  if (clockIntervalId) clearInterval(clockIntervalId);
  clockIntervalId = setInterval(update, 1000);
}

// === УТИЛИТЫ ===
function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
}

function generateRawOpCode() {
  return 'OP-' + Math.random().toString(36).substring(2, 6).toUpperCase();
}

function generateUniqueOpCode(used = new Set()) {
  let code = generateRawOpCode();
  let attempt = 0;
  const taken = new Set(used);
  while ((taken.has(code) || !code) && attempt < 1000) {
    code = generateRawOpCode();
    attempt++;
  }
  return code;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSecondsToHMS(sec) {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const hh = h.toString().padStart(2, '0');
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  return hh + ':' + mm + ':' + ss;
}

function formatDateTime(ts) {
  if (!ts) return '-';
  try {
    return new Date(ts).toLocaleString();
  } catch (e) {
    return '-';
  }
}

function formatStartEnd(op) {
  const start = op.firstStartedAt || op.startedAt;
  let endLabel = '-';
  if (op.status === 'PAUSED') {
    const pauseTs = op.lastPausedAt || Date.now();
    endLabel = formatDateTime(pauseTs) + ' (П)';
  } else if (op.finishedAt) {
    endLabel = formatDateTime(op.finishedAt);
  } else if (op.status === 'DONE' && op.finishedAt) {
    endLabel = formatDateTime(op.finishedAt);
  } else if (op.status === 'IN_PROGRESS') {
    endLabel = '-';
  }

  return '<div class="nk-lines"><div>Н: ' + escapeHtml(formatDateTime(start)) + '</div><div>К: ' + escapeHtml(endLabel) + '</div></div>';
}

// Время операции с учётом пауз / продолжений
function getOperationElapsedSeconds(op) {
  const base = typeof op.elapsedSeconds === 'number' ? op.elapsedSeconds : 0;
  if (op.status === 'IN_PROGRESS' && op.startedAt) {
    return base + (Date.now() - op.startedAt) / 1000;
  }
  return base;
}

function autoResizeComment(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function cloneCard(card) {
  return JSON.parse(JSON.stringify(card));
}

function toSafeCount(val) {
  const num = parseInt(val, 10);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
}

function formatStepCode(step) {
  return String(step * 5).padStart(3, '0');
}

function getOperationQuantity(op, card) {
  if (op && (op.quantity || op.quantity === 0)) {
    const q = toSafeCount(op.quantity);
    return Number.isFinite(q) ? q : '';
  }
  if (card && (card.quantity || card.quantity === 0)) {
    const q = toSafeCount(card.quantity);
    return Number.isFinite(q) ? q : '';
  }
  return '';
}

function renumberAutoCodesForCard(card) {
  if (!card || !Array.isArray(card.operations)) return;
  const opsSorted = [...card.operations].sort((a, b) => (a.order || 0) - (b.order || 0));
  let autoIndex = 0;
  opsSorted.forEach(op => {
    if (op.autoCode) {
      autoIndex++;
      op.opCode = formatStepCode(autoIndex);
    }
  });
}

function ensureAttachments(card) {
  if (!card) return;
  if (!Array.isArray(card.attachments)) card.attachments = [];
  card.attachments = card.attachments.map(file => ({
    id: file.id || genId('file'),
    name: file.name || 'file',
    type: file.type || 'application/octet-stream',
    size: typeof file.size === 'number' ? file.size : 0,
    content: typeof file.content === 'string' ? file.content : '',
    createdAt: file.createdAt || Date.now()
  }));
}

function ensureCardMeta(card, options = {}) {
  if (!card) return;
  const { skipSnapshot = false } = options;
  if (card.quantity == null) card.quantity = '';
  if (typeof card.drawing !== 'string') card.drawing = card.drawing ? String(card.drawing) : '';
  if (typeof card.material !== 'string') card.material = card.material ? String(card.material) : '';
  if (typeof card.contractNumber !== 'string') card.contractNumber = card.contractNumber ? String(card.contractNumber) : '';
  if (typeof card.createdAt !== 'number') {
    card.createdAt = Date.now();
  }
  if (!Array.isArray(card.logs)) {
    card.logs = [];
  }
  if (!card.initialSnapshot && !skipSnapshot) {
    const snapshot = cloneCard(card);
    snapshot.logs = [];
    card.initialSnapshot = snapshot;
  }
  card.operations = card.operations || [];
  card.operations.forEach(op => {
    op.goodCount = toSafeCount(op.goodCount || 0);
    op.scrapCount = toSafeCount(op.scrapCount || 0);
    op.holdCount = toSafeCount(op.holdCount || 0);
    op.quantity = getOperationQuantity(op, card);
    op.autoCode = Boolean(op.autoCode);
    op.additionalExecutors = Array.isArray(op.additionalExecutors)
      ? op.additionalExecutors.map(name => (name || '').toString()).slice(0, 2)
      : [];
  });
  renumberAutoCodesForCard(card);
}

function formatLogValue(val) {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  try {
    return JSON.stringify(val);
  } catch (err) {
    return String(val);
  }
}

function recordCardLog(card, { action, object, field = null, targetId = null, oldValue = '', newValue = '' }) {
  if (!card) return;
  ensureCardMeta(card);
  card.logs.push({
    id: genId('log'),
    ts: Date.now(),
    action: action || 'update',
    object: object || '',
    field,
    targetId,
    oldValue: formatLogValue(oldValue),
    newValue: formatLogValue(newValue)
  });
}

function opLogLabel(op) {
  return formatOpLabel(op) || 'Операция';
}

function dataUrlToBlob(dataUrl, fallbackType = 'application/octet-stream') {
  const parts = (dataUrl || '').split(',');
  if (parts.length < 2) return new Blob([], { type: fallbackType });
  const match = parts[0].match(/data:(.*);base64/);
  const mime = match ? match[1] : fallbackType;
  const binary = atob(parts[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

function formatBytes(size) {
  if (!size) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let idx = 0;
  let s = size;
  while (s >= 1024 && idx < units.length - 1) {
    s /= 1024;
    idx++;
  }
  return s.toFixed(Math.min(1, idx)).replace(/\.0$/, '') + ' ' + units[idx];
}

// === EAN-13: генерация и прорисовка ===
function computeEAN13CheckDigit(base12) {
  if (!/^\d{12}$/.test(base12)) {
    throw new Error('Базовый код для EAN-13 должен содержать 12 цифр');
  }
  let sumEven = 0;
  let sumOdd = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(base12.charAt(i), 10);
    if ((i + 1) % 2 === 0) {
      sumEven += digit;
    } else {
      sumOdd += digit;
    }
  }
  const total = sumOdd + sumEven * 3;
  const mod = total % 10;
  const check = (10 - mod) % 10;
  return String(check);
}

function generateEAN13() {
  let base = '';
  for (let i = 0; i < 12; i++) {
    base += Math.floor(Math.random() * 10);
  }
  const check = computeEAN13CheckDigit(base);
  return base + check;
}

function generateUniqueEAN13() {
  let attempt = 0;
  while (attempt < 1000) {
    const code = generateEAN13();
    if (!cards.some(c => c.barcode === code)) return code;
    attempt++;
  }
  return generateEAN13();
}

function drawBarcodeEAN13(canvas, code) {
  if (!canvas || !code || !/^\d{13}$/.test(code)) return;
  const ctx = canvas.getContext('2d');

  const patternsA = {
    0: '0001101', 1: '0011001', 2: '0010011', 3: '0111101', 4: '0100011',
    5: '0110001', 6: '0101111', 7: '0111011', 8: '0110111', 9: '0001011'
  };
  const patternsB = {
    0: '0100111', 1: '0110011', 2: '0011011', 3: '0100001', 4: '0011101',
    5: '0111001', 6: '0000101', 7: '0010001', 8: '0001001', 9: '0010111'
  };
  const patternsC = {
    0: '1110010', 1: '1100110', 2: '1101100', 3: '1000010', 4: '1011100',
    5: '1001110', 6: '1010000', 7: '1000100', 8: '1001000', 9: '1110100'
  };
  const parityMap = {
    0: 'AAAAAA',
    1: 'AABABB',
    2: 'AABBAB',
    3: 'AABBBA',
    4: 'ABAABB',
    5: 'ABBAAB',
    6: 'ABBBAA',
    7: 'ABABAB',
    8: 'ABABBA',
    9: 'ABBABA'
  };

  const digits = code.split('').map(d => parseInt(d, 10));
  const first = digits[0];
  const parity = parityMap[first];
  let bits = '101'; // левая рамка

  for (let i = 1; i <= 6; i++) {
    const d = digits[i];
    const p = parity[i - 1];
    bits += (p === 'A' ? patternsA[d] : patternsB[d]);
  }

  bits += '01010'; // центральная рамка

  for (let i = 7; i <= 12; i++) {
    const d = digits[i];
    bits += patternsC[d];
  }

  bits += '101'; // правая рамка

  const barWidth = 2;
  const barHeight = 80;
  const fontHeight = 16;
  const width = bits.length * barWidth;
  const height = barHeight + fontHeight + 10;

  canvas.width = width;
  canvas.height = height;

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#000';
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === '1') {
      ctx.fillRect(i * barWidth, 0, barWidth, barHeight);
    }
  }

  ctx.font = '14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(code, width / 2, barHeight + fontHeight);
}

function getBarcodeDataUrl(code) {
  const canvas = document.createElement('canvas');
  drawBarcodeEAN13(canvas, code || '');
  return canvas.toDataURL('image/png');
}

function openBarcodeModal(card) {
  const modal = document.getElementById('barcode-modal');
  const canvas = document.getElementById('barcode-canvas');
  const codeSpan = document.getElementById('barcode-modal-code');
  if (!modal || !canvas || !codeSpan) return;

  if (!card.barcode || !/^\d{13}$/.test(card.barcode)) {
    card.barcode = generateUniqueEAN13();
    saveData();
    renderCardsTable();
    renderWorkordersTable();
  }

  drawBarcodeEAN13(canvas, card.barcode);
  codeSpan.textContent = card.barcode;
  modal.style.display = 'flex';
}

function closeBarcodeModal() {
  const modal = document.getElementById('barcode-modal');
  if (modal) modal.style.display = 'none';
}

function setupBarcodeModal() {
  const modal = document.getElementById('barcode-modal');
  if (!modal) return;
  const closeBtn = document.getElementById('btn-close-barcode');
  const printBtn = document.getElementById('btn-print-barcode');

  if (closeBtn) {
    closeBtn.addEventListener('click', closeBarcodeModal);
  }

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeBarcodeModal();
    }
  });

  if (printBtn) {
    printBtn.addEventListener('click', () => {
      const canvas = document.getElementById('barcode-canvas');
      const codeSpan = document.getElementById('barcode-modal-code');
      if (!canvas) return;
      const dataUrl = canvas.toDataURL('image/png');
      const code = codeSpan ? codeSpan.textContent : '';
      const win = window.open('', '_blank');
      if (!win) return;
      win.document.write('<html><head><title>Печать штрихкода</title></head><body style="text-align:center;">');
      win.document.write('<img src="' + dataUrl + '" style="max-width:100%;"><br>');
      win.document.write('<div style="margin-top:8px; font-size:16px;">' + code + '</div>');
      win.document.write('</body></html>');
      win.document.close();
      win.focus();
      win.print();
    });
  }
}

// === МОДЕЛЬ ОПЕРАЦИИ МАРШРУТА ===
function createRouteOpFromRefs(op, center, executor, plannedMinutes, order, options = {}) {
  const { code, autoCode = false, quantity } = options;
  return {
    id: genId('rop'),
    opId: op.id,
    opCode: code || op.code || op.opCode || generateUniqueOpCode(collectUsedOpCodes()),
    opName: op.name,
    centerId: center.id,
    centerName: center.name,
    executor: executor || '',
    plannedMinutes: plannedMinutes || op.recTime || 30,
    quantity: quantity === '' || quantity == null ? '' : toSafeCount(quantity),
    autoCode,
    status: 'NOT_STARTED',
    firstStartedAt: null,
    startedAt: null,
    lastPausedAt: null,
    finishedAt: null,
    actualSeconds: null,
    elapsedSeconds: 0,
    order: order || 1,
    comment: '',
    goodCount: 0,
    scrapCount: 0,
    holdCount: 0
  };
}

function recalcCardStatus(card) {
  const opsArr = card.operations || [];
  if (!opsArr.length) {
    card.status = 'NOT_STARTED';
    return;
  }
  const hasActive = opsArr.some(o => o.status === 'IN_PROGRESS' || o.status === 'PAUSED');
  const allDone = opsArr.length > 0 && opsArr.every(o => o.status === 'DONE');
  const hasNotStarted = opsArr.some(o => o.status === 'NOT_STARTED' || !o.status);
  if (hasActive) {
    card.status = 'IN_PROGRESS';
  } else if (allDone && !hasNotStarted) {
    card.status = 'DONE';
  } else {
    card.status = 'NOT_STARTED';
  }
}

function statusBadge(status) {
  if (status === 'IN_PROGRESS') return '<span class="badge status-in-progress">В работе</span>';
  if (status === 'PAUSED') return '<span class="badge status-paused">Пауза</span>';
  if (status === 'DONE') return '<span class="badge status-done">Завершена</span>';
  return '<span class="badge status-not-started">Не начата</span>';
}

function cardStatusText(card) {
  const opsArr = card.operations || [];

  const hasStartedOrDoneOrPaused = opsArr.some(o =>
    o.status === 'IN_PROGRESS' || o.status === 'DONE' || o.status === 'PAUSED'
  );
  if (!opsArr.length || !hasStartedOrDoneOrPaused) {
    return 'Не запущена';
  }

  const inProgress = opsArr.find(o => o.status === 'IN_PROGRESS');
  if (inProgress) {
    const sec = getOperationElapsedSeconds(inProgress);
    return formatOpLabel(inProgress) + ' (' + formatSecondsToHMS(sec) + ')';
  }

  const paused = opsArr.find(o => o.status === 'PAUSED');
  if (paused) {
    const sec = getOperationElapsedSeconds(paused);
    return formatOpLabel(paused) + ' (пауза ' + formatSecondsToHMS(sec) + ')';
  }

  const allDone = opsArr.length > 0 && opsArr.every(o => o.status === 'DONE');
  if (allDone) {
    return 'Завершена';
  }

  const notStartedOps = opsArr.filter(o => o.status === 'NOT_STARTED' || !o.status);
  if (notStartedOps.length) {
    let next = notStartedOps[0];
    notStartedOps.forEach(o => {
      const curOrder = typeof next.order === 'number' ? next.order : 999999;
      const newOrder = typeof o.order === 'number' ? o.order : 999999;
      if (newOrder < curOrder) next = o;
    });
    return formatOpLabel(next) + ' (ожидание)';
  }

  return 'Не запущена';
}

function getCardProcessState(card) {
  const opsArr = card.operations || [];
  const hasInProgress = opsArr.some(o => o.status === 'IN_PROGRESS');
  const hasPaused = opsArr.some(o => o.status === 'PAUSED');
  const allDone = opsArr.length > 0 && opsArr.every(o => o.status === 'DONE');
  const allNotStarted = opsArr.length > 0 && opsArr.every(o => o.status === 'NOT_STARTED' || !o.status);
  const hasAnyDone = opsArr.some(o => o.status === 'DONE');

  if (allDone) return { key: 'DONE', label: 'Выполнено', className: 'done' };
  if (hasInProgress && hasPaused) return { key: 'MIXED', label: 'Смешанно', className: 'mixed' };
  if (hasInProgress) return { key: 'IN_PROGRESS', label: 'Выполняется', className: 'in-progress' };
  if (hasPaused) return { key: 'PAUSED', label: 'Пауза', className: 'paused' };
  if (allNotStarted) return { key: 'NOT_STARTED', label: 'Не запущена', className: 'not-started' };
  if (hasAnyDone) return { key: 'IN_PROGRESS', label: 'Выполняется', className: 'in-progress' };
  return { key: 'NOT_STARTED', label: 'Не запущена', className: 'not-started' };
}

function renderCardStateBadge(card) {
  const state = getCardProcessState(card);
  if (state.key === 'DONE') {
    return '<span class="status-pill status-pill-done" title="Выполнено">✓</span>';
  }
  if (state.key === 'MIXED') {
    return '<span class="status-pill status-pill-mixed" title="Смешанный статус">Смешанно</span>';
  }
  return '<span class="status-pill status-pill-' + state.className + '">' + state.label + '</span>';
}

function getCardComment(card) {
  const opsArr = card.operations || [];
  const priority = ['IN_PROGRESS', 'PAUSED', 'DONE', 'NOT_STARTED'];
  for (const status of priority) {
    const found = opsArr.find(o => o.status === status && o.comment);
    if (found) return found.comment;
  }
  const fallback = opsArr.find(o => o.comment);
  return fallback ? fallback.comment : '';
}

function formatOpLabel(op) {
  const code = op.opCode || op.code || '';
  const name = op.opName || op.name || '';
  return code ? `[${code}] ${name}` : name;
}

function renderOpLabel(op) {
  return escapeHtml(formatOpLabel(op));
}

function renderOpName(op) {
  const name = op.opName || op.name || '';
  return escapeHtml(name);
}

function collectUsedOpCodes() {
  const used = new Set();
  ops.forEach(o => {
    if (o.code) used.add(o.code);
  });
  cards.forEach(card => {
    (card.operations || []).forEach(op => {
      if (op.opCode) used.add(op.opCode);
    });
  });
  return used;
}

function ensureOperationCodes() {
  const used = collectUsedOpCodes();
  ops = ops.map(op => {
    const next = { ...op };
    if (!next.code || used.has(next.code)) {
      next.code = generateUniqueOpCode(used);
    }
    used.add(next.code);
    return next;
  });

  const opMap = Object.fromEntries(ops.map(op => [op.id, op]));
  cards = cards.map(card => {
    const clonedCard = { ...card };
    clonedCard.operations = (clonedCard.operations || []).map(op => {
      const next = { ...op };
      const source = next.opId ? opMap[next.opId] : null;
      if (source && source.code) {
        next.opCode = source.code;
      }
      if (!next.opCode || used.has(next.opCode)) {
        next.opCode = generateUniqueOpCode(used);
      }
      used.add(next.opCode);
      return next;
    });
    return clonedCard;
  });
}

// === ХРАНИЛИЩЕ ===
async function saveData() {
  try {
    if (!apiOnline) {
      setConnectionStatus('Сервер недоступен — изменения не сохраняются. Проверьте, что запущен server.js.', 'error');
      return;
    }

    const res = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cards, ops, centers })
    });
    if (!res.ok) {
      throw new Error('Ответ сервера ' + res.status);
    }
    setConnectionStatus('', 'info');
  } catch (err) {
    apiOnline = false;
    setConnectionStatus('Не удалось сохранить данные на сервер: ' + err.message, 'error');
    console.error('Ошибка сохранения данных на сервер', err);
  }
}

function ensureDefaults() {
  if (!centers.length) {
    centers = [
      { id: genId('wc'), name: 'Механическая обработка', desc: 'Токарные и фрезерные операции' },
      { id: genId('wc'), name: 'Покрытия / напыление', desc: 'Покрытия, термическое напыление' },
      { id: genId('wc'), name: 'Контроль качества', desc: 'Измерения, контроль, визуальный осмотр' }
    ];
  }

  if (!ops.length) {
    const used = new Set();
    ops = [
      { id: genId('op'), code: generateUniqueOpCode(used), name: 'Токарная обработка', desc: 'Черновая и чистовая', recTime: 40 },
      { id: genId('op'), code: generateUniqueOpCode(used), name: 'Напыление покрытия', desc: 'HVOF / APS', recTime: 60 },
      { id: genId('op'), code: generateUniqueOpCode(used), name: 'Контроль размеров', desc: 'Измерения, оформление протокола', recTime: 20 }
    ];
  }

  if (!cards.length) {
    const demoId = genId('card');
    const op1 = ops[0];
    const op2 = ops[1];
    const op3 = ops[2];
    const wc1 = centers[0];
    const wc2 = centers[1];
    const wc3 = centers[2];
    cards = [
      {
        id: demoId,
        barcode: generateUniqueEAN13(),
        name: 'Вал привода Ø60',
        quantity: 1,
        drawing: 'DWG-001',
        material: 'Сталь',
        orderNo: 'DEMO-001',
        desc: 'Демонстрационная карта для примера.',
        status: 'NOT_STARTED',
        archived: false,
        attachments: [],
        operations: [
          createRouteOpFromRefs(op1, wc1, 'Иванов И.И.', 40, 1),
          createRouteOpFromRefs(op2, wc2, 'Петров П.П.', 60, 2),
          createRouteOpFromRefs(op3, wc3, 'Сидоров С.С.', 20, 3)
        ]
      }
    ];
  }
}

async function loadData() {
  try {
    const res = await fetch(API_ENDPOINT);
    if (!res.ok) throw new Error('Ответ сервера ' + res.status);
    const payload = await res.json();
    cards = Array.isArray(payload.cards) ? payload.cards : [];
    ops = Array.isArray(payload.ops) ? payload.ops : [];
    centers = Array.isArray(payload.centers) ? payload.centers : [];
    apiOnline = true;
    setConnectionStatus('', 'info');
  } catch (err) {
    console.warn('Не удалось загрузить данные с сервера, используем пустые коллекции', err);
    apiOnline = false;
    setConnectionStatus('Нет соединения с сервером: данные будут только в этой сессии', 'error');
    cards = [];
    ops = [];
    centers = [];
  }

  ensureDefaults();
  ensureOperationCodes();

  cards.forEach(c => {
    if (!c.barcode || !/^\d{13}$/.test(c.barcode)) {
      c.barcode = generateUniqueEAN13();
    }
    c.archived = Boolean(c.archived);
    ensureAttachments(c);
    ensureCardMeta(c);
    c.operations = c.operations || [];
    c.operations.forEach(op => {
      if (typeof op.elapsedSeconds !== 'number') {
        op.elapsedSeconds = 0;
      }
      op.goodCount = toSafeCount(op.goodCount || 0);
      op.scrapCount = toSafeCount(op.scrapCount || 0);
      op.holdCount = toSafeCount(op.holdCount || 0);
      if (typeof op.firstStartedAt !== 'number') {
        op.firstStartedAt = op.startedAt || null;
      }
      if (typeof op.lastPausedAt !== 'number') {
        op.lastPausedAt = null;
      }
      if (typeof op.comment !== 'string') {
        op.comment = '';
      }
      if (op.status === 'DONE' && op.actualSeconds != null && !op.elapsedSeconds) {
        op.elapsedSeconds = op.actualSeconds;
      }
    });
    recalcCardStatus(c);
  });

  if (apiOnline) {
    await saveData();
  }
}

// === РЕНДЕРИНГ ДАШБОРДА ===
function renderDashboard() {
  const statsContainer = document.getElementById('dashboard-stats');
  const activeCards = cards.filter(c => !c.archived);
  const cardsCount = activeCards.length;
  const inWork = activeCards.filter(c => c.status === 'IN_PROGRESS').length;
  const done = activeCards.filter(c => c.status === 'DONE').length;
  const notStarted = cardsCount - inWork - done;

  statsContainer.innerHTML = '';
  const stats = [
    { label: 'Всего карт', value: cardsCount },
    { label: 'Не запущено', value: notStarted },
    { label: 'В работе', value: inWork },
    { label: 'Завершено', value: done }
  ];
  stats.forEach(st => {
    const div = document.createElement('div');
    div.className = 'stat-block';
    div.innerHTML = '<span>' + st.label + '</span><strong>' + st.value + '</strong>';
    statsContainer.appendChild(div);
  });

  const dashTableWrapper = document.getElementById('dashboard-cards');
  const eligibleCards = activeCards.filter(card => card.status !== 'DONE' && (card.operations || []).some(o => o.status && o.status !== 'NOT_STARTED'));
  if (!eligibleCards.length) {
    dashTableWrapper.innerHTML = '<p>Ещё нет незавершённых карт с выполненными операциями.</p>';
    return;
  }

  const limited = eligibleCards.slice(0, 5);
  let html = '<table><thead><tr><th>№ карты (EAN-13)</th><th>Наименование</th><th>Заказ</th><th>Статус / операции</th><th>Сделано деталей</th><th>Выполнено операций</th><th>Комментарии</th></tr></thead><tbody>';

  limited.forEach(card => {
    const opsArr = card.operations || [];
    const activeOps = opsArr.filter(o => o.status === 'IN_PROGRESS' || o.status === 'PAUSED');
    let statusHtml = '';

    let opsForDisplay = [];
    if (card.status === 'DONE') {
      statusHtml = '<span class="dash-card-completed">Завершена</span>';
    } else if (!opsArr.length || opsArr.every(o => o.status === 'NOT_STARTED' || !o.status)) {
      statusHtml = 'Не запущена';
    } else if (activeOps.length) {
      opsForDisplay = activeOps;
      activeOps.forEach(op => {
        const elapsed = getOperationElapsedSeconds(op);
        const plannedSec = (op.plannedMinutes || 0) * 60;
        let cls = 'dash-op';
        if (op.status === 'PAUSED') {
          cls += ' dash-op-paused';
        }
        if (plannedSec && elapsed > plannedSec) {
          cls += ' dash-op-overdue';
        }
        statusHtml += '<span class="' + cls + '">' +
          renderOpLabel(op) + ' — ' + formatSecondsToHMS(elapsed) +
          '</span>';
      });
    } else {
      const notStartedOps = opsArr.filter(o => o.status === 'NOT_STARTED' || !o.status);
      if (notStartedOps.length) {
        let next = notStartedOps[0];
        notStartedOps.forEach(o => {
          const curOrder = typeof next.order === 'number' ? next.order : 999999;
          const newOrder = typeof o.order === 'number' ? o.order : 999999;
          if (newOrder < curOrder) next = o;
        });
        opsForDisplay = [next];
        statusHtml = renderOpLabel(next) + ' (ожидание)';
      } else {
        statusHtml = 'Не запущена';
      }
    }

    const qtyTotal = toSafeCount(card.quantity);
    const qtyLines = opsForDisplay.length
      ? opsForDisplay.map(op => {
        const good = toSafeCount(op.goodCount || 0);
        const qtyText = qtyTotal > 0 ? (good + ' из ' + qtyTotal) : '—';
        return '<div class="dash-qty-line">' + qtyText + '</div>';
      })
      : [];

    const completedCount = opsArr.filter(o => o.status === 'DONE').length;
    const commentLines = opsForDisplay
      .filter(o => o.comment)
      .map(o => '<div class="dash-comment-line"><span class="dash-comment-op">' + renderOpLabel(o) + ':</span> ' + escapeHtml(o.comment) + '</div>');
    const qtyCell = qtyLines.length ? qtyLines.join('') : '—';
    const commentCell = commentLines.join('');

    html += '<tr>' +
      '<td>' + escapeHtml(card.barcode || '') + '</td>' +
      '<td>' + escapeHtml(card.name) + '</td>' +
      '<td>' + escapeHtml(card.orderNo || '') + '</td>' +
      '<td><span class="dashboard-card-status" data-card-id="' + card.id + '">' + statusHtml + '</span></td>' +
      '<td>' + qtyCell + '</td>' +
      '<td>' + completedCount + ' из ' + (card.operations ? card.operations.length : 0) + '</td>' +
      '<td>' + commentCell + '</td>' +
      '</tr>';
  });

  html += '</tbody></table>';
  dashTableWrapper.innerHTML = html;
}

// === РЕНДЕРИНГ ТЕХ.КАРТ ===
function renderCardsTable() {
  const wrapper = document.getElementById('cards-table-wrapper');
  const visibleCards = cards.filter(c => !c.archived);
  if (!visibleCards.length) {
    wrapper.innerHTML = '<p>Список технологических карт пуст. Нажмите «Создать карту».</p>';
    return;
  }

  const termRaw = cardsSearchTerm.trim();
  let sortedCards = [...visibleCards];
  if (termRaw) {
    sortedCards.sort((a, b) => cardSearchScore(b, termRaw) - cardSearchScore(a, termRaw));
  }
  const filteredCards = termRaw
    ? sortedCards.filter(card => cardSearchScore(card, termRaw) > 0)
    : sortedCards;

  if (!filteredCards.length) {
    wrapper.innerHTML = '<p>Карты по запросу не найдены.</p>';
    return;
  }

  let html = '<table><thead><tr>' +
    '<th>№ карты (EAN-13)</th><th>Наименование</th><th>Заказ</th><th>Статус</th><th>Операций</th><th>Файлы</th><th>Действия</th>' +
    '</tr></thead><tbody>';
  filteredCards.forEach(card => {
    const filesCount = (card.attachments || []).length;
    html += '<tr>' +
      '<td><button class="btn-link barcode-link" data-id="' + card.id + '">' + escapeHtml(card.barcode || '') + '</button></td>' +
      '<td>' + escapeHtml(card.name) + '</td>' +
      '<td>' + escapeHtml(card.orderNo || '') + '</td>' +
      '<td>' + cardStatusText(card) + '</td>' +
      '<td>' + (card.operations ? card.operations.length : 0) + '</td>' +
      '<td><button class="btn-small clip-btn" data-attach-card="' + card.id + '">📎 <span class="clip-count">' + filesCount + '</span></button></td>' +
      '<td><div class="table-actions">' +
      '<button class="btn-small" data-action="edit-card" data-id="' + card.id + '">Открыть</button>' +
      '<button class="btn-small" data-action="print-card" data-id="' + card.id + '">Печать</button>' +
      '<button class="btn-small" data-action="copy-card" data-id="' + card.id + '">Копировать</button>' +
      '<button class="btn-small btn-danger" data-action="delete-card" data-id="' + card.id + '">Удалить</button>' +
      '</div></td>' +
      '</tr>';
  });
  html += '</tbody></table>';
  wrapper.innerHTML = html;

  wrapper.querySelectorAll('button[data-action="edit-card"]').forEach(btn => {
    btn.addEventListener('click', () => {
      openCardModal(btn.getAttribute('data-id'));
    });
  });

  wrapper.querySelectorAll('button[data-action="copy-card"]').forEach(btn => {
    btn.addEventListener('click', () => {
      duplicateCard(btn.getAttribute('data-id'));
    });
  });

  wrapper.querySelectorAll('button[data-action="print-card"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = cards.find(c => c.id === btn.getAttribute('data-id'));
      if (!card) return;
      printCardView(card);
    });
  });

  wrapper.querySelectorAll('button[data-action="delete-card"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      cards = cards.filter(c => c.id !== id);
      saveData();
      renderEverything();
    });
  });

  wrapper.querySelectorAll('.barcode-link').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const card = cards.find(c => c.id === id);
      if (!card) return;
      openBarcodeModal(card);
    });
  });

  wrapper.querySelectorAll('button[data-attach-card]').forEach(btn => {
    btn.addEventListener('click', () => {
      openAttachmentsModal(btn.getAttribute('data-attach-card'), 'live');
    });
  });
}

function duplicateCard(cardId) {
  const card = cards.find(c => c.id === cardId);
  if (!card) return;
  const copy = cloneCard(card);
  copy.id = genId('card');
  copy.barcode = generateUniqueEAN13();
  copy.name = (card.name || '') + ' (копия)';
  copy.status = 'NOT_STARTED';
  copy.archived = false;
  copy.logs = [];
  copy.createdAt = Date.now();
  copy.initialSnapshot = null;
  copy.attachments = (copy.attachments || []).map(file => ({
    ...file,
    id: genId('file'),
    createdAt: Date.now()
  }));
  copy.operations = (copy.operations || []).map((op, idx) => ({
    ...op,
    id: genId('rop'),
    status: 'NOT_STARTED',
    startedAt: null,
    finishedAt: null,
    elapsedSeconds: 0,
    actualSeconds: null,
    comment: '',
    goodCount: 0,
    scrapCount: 0,
    holdCount: 0,
    order: typeof op.order === 'number' ? op.order : idx + 1
  }));
  recalcCardStatus(copy);
  ensureCardMeta(copy);
  if (!copy.initialSnapshot) {
    const snapshot = cloneCard(copy);
    snapshot.logs = [];
    copy.initialSnapshot = snapshot;
  }
  recordCardLog(copy, { action: 'Создание копии', object: 'Карта', oldValue: card.barcode || '', newValue: copy.barcode || '' });
  cards.push(copy);
  saveData();
  renderEverything();
}

function createEmptyCardDraft() {
  return {
    id: genId('card'),
    barcode: generateUniqueEAN13(),
    name: 'Новая карта',
    quantity: '',
    drawing: '',
    material: '',
    contractNumber: '',
    orderNo: '',
    desc: '',
    status: 'NOT_STARTED',
    archived: false,
    createdAt: Date.now(),
    logs: [],
    initialSnapshot: null,
    attachments: [],
    operations: []
  };
}

function openCardModal(cardId) {
  const modal = document.getElementById('card-modal');
  if (!modal) return;
  activeCardOriginalId = cardId || null;
  if (cardId) {
    const card = cards.find(c => c.id === cardId);
    if (!card) return;
    activeCardDraft = cloneCard(card);
    activeCardIsNew = false;
  } else {
    activeCardDraft = createEmptyCardDraft();
    activeCardIsNew = true;
  }
  ensureCardMeta(activeCardDraft, { skipSnapshot: activeCardIsNew });
  document.getElementById('card-modal-title').textContent = activeCardIsNew ? 'Создание карты' : 'Редактирование карты';
  document.getElementById('card-id').value = activeCardDraft.id;
  document.getElementById('card-name').value = activeCardDraft.name || '';
  document.getElementById('card-qty').value = activeCardDraft.quantity != null ? activeCardDraft.quantity : '';
  document.getElementById('card-order').value = activeCardDraft.orderNo || '';
  document.getElementById('card-drawing').value = activeCardDraft.drawing || '';
  document.getElementById('card-material').value = activeCardDraft.material || '';
  document.getElementById('card-contract').value = activeCardDraft.contractNumber || '';
  document.getElementById('card-desc').value = activeCardDraft.desc || '';
  document.getElementById('card-status-text').textContent = cardStatusText(activeCardDraft);
  const attachBtn = document.getElementById('card-attachments-btn');
  if (attachBtn) {
    attachBtn.innerHTML = '📎 Файлы (' + (activeCardDraft.attachments ? activeCardDraft.attachments.length : 0) + ')';
  }
  const routeCodeInput = document.getElementById('route-op-code');
  if (routeCodeInput) routeCodeInput.value = '';
  const routeQtyInput = document.getElementById('route-qty');
  if (routeQtyInput) routeQtyInput.value = activeCardDraft.quantity !== '' ? activeCardDraft.quantity : '';
  renderRouteTableDraft();
  fillRouteSelectors();
  modal.classList.remove('hidden');
}

function closeCardModal() {
  const modal = document.getElementById('card-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.getElementById('card-form').reset();
  document.getElementById('route-form').reset();
  document.getElementById('route-table-wrapper').innerHTML = '';
  activeCardDraft = null;
  activeCardOriginalId = null;
  activeCardIsNew = false;
}

function saveCardDraft() {
  if (!activeCardDraft) return;
  const draft = cloneCard(activeCardDraft);
  draft.operations = (draft.operations || []).map((op, idx) => ({
    ...op,
    order: typeof op.order === 'number' ? op.order : idx + 1,
    goodCount: toSafeCount(op.goodCount || 0),
    scrapCount: toSafeCount(op.scrapCount || 0),
    holdCount: toSafeCount(op.holdCount || 0),
    quantity: getOperationQuantity(op, draft),
    autoCode: Boolean(op.autoCode),
    additionalExecutors: Array.isArray(op.additionalExecutors) ? op.additionalExecutors.slice(0, 2) : []
  }));
  renumberAutoCodesForCard(draft);
  recalcCardStatus(draft);

  if (activeCardIsNew || activeCardOriginalId == null) {
    ensureCardMeta(draft);
    if (!draft.initialSnapshot) {
      const snapshot = cloneCard(draft);
      snapshot.logs = [];
      draft.initialSnapshot = snapshot;
    }
    recordCardLog(draft, { action: 'Создание карты', object: 'Карта', oldValue: '', newValue: draft.name || draft.barcode });
    cards.push(draft);
  } else {
    const idx = cards.findIndex(c => c.id === activeCardOriginalId);
    if (idx >= 0) {
      const original = cloneCard(cards[idx]);
      ensureCardMeta(original);
      ensureCardMeta(draft);
      draft.createdAt = original.createdAt || draft.createdAt;
      draft.initialSnapshot = original.initialSnapshot || draft.initialSnapshot;
      draft.logs = Array.isArray(original.logs) ? original.logs : [];
      logCardDifferences(original, draft);
      cards[idx] = draft;
    }
  }
  saveData();
  renderEverything();
  closeCardModal();
}

function syncCardDraftFromForm() {
  if (!activeCardDraft) return;
  activeCardDraft.name = document.getElementById('card-name').value.trim();
  const qtyRaw = document.getElementById('card-qty').value.trim();
  const qtyVal = qtyRaw === '' ? '' : Math.max(0, parseInt(qtyRaw, 10) || 0);
  activeCardDraft.quantity = Number.isFinite(qtyVal) ? qtyVal : '';
  activeCardDraft.orderNo = document.getElementById('card-order').value.trim();
  activeCardDraft.drawing = document.getElementById('card-drawing').value.trim();
  activeCardDraft.material = document.getElementById('card-material').value.trim();
  activeCardDraft.contractNumber = document.getElementById('card-contract').value.trim();
  activeCardDraft.desc = document.getElementById('card-desc').value.trim();
}

function logCardDifferences(original, updated) {
  if (!original || !updated) return;
  const cardRef = updated;
  const fields = ['name', 'orderNo', 'desc', 'quantity', 'drawing', 'material', 'contractNumber'];
  fields.forEach(field => {
    if ((original[field] || '') !== (updated[field] || '')) {
      recordCardLog(cardRef, { action: 'Изменение поля', object: 'Карта', field, oldValue: original[field] || '', newValue: updated[field] || '' });
    }
  });

  if (original.status !== updated.status) {
    recordCardLog(cardRef, { action: 'Статус карты', object: 'Карта', field: 'status', oldValue: original.status, newValue: updated.status });
  }

  if (original.archived !== updated.archived) {
    recordCardLog(cardRef, { action: 'Архивирование', object: 'Карта', field: 'archived', oldValue: original.archived, newValue: updated.archived });
  }

  const originalAttachments = Array.isArray(original.attachments) ? original.attachments.length : 0;
  const updatedAttachments = Array.isArray(updated.attachments) ? updated.attachments.length : 0;
  if (originalAttachments !== updatedAttachments) {
    recordCardLog(cardRef, { action: 'Файлы', object: 'Карта', field: 'attachments', oldValue: originalAttachments, newValue: updatedAttachments });
  }

  const originalOps = Array.isArray(original.operations) ? original.operations : [];
  const updatedOps = Array.isArray(updated.operations) ? updated.operations : [];
  const originalMap = new Map(originalOps.map(op => [op.id, op]));
  const updatedMap = new Map(updatedOps.map(op => [op.id, op]));

  updatedOps.forEach(op => {
    const prev = originalMap.get(op.id);
    if (!prev) {
      recordCardLog(cardRef, { action: 'Добавление операции', object: opLogLabel(op), targetId: op.id, oldValue: '', newValue: `${op.centerName || ''} / ${op.executor || ''}`.trim() });
      return;
    }

    if ((prev.centerName || '') !== (op.centerName || '')) {
      recordCardLog(cardRef, { action: 'Изменение операции', object: opLogLabel(op), field: 'centerName', targetId: op.id, oldValue: prev.centerName || '', newValue: op.centerName || '' });
    }
    if ((prev.opCode || '') !== (op.opCode || '') || (prev.opName || '') !== (op.opName || '')) {
      recordCardLog(cardRef, { action: 'Изменение операции', object: opLogLabel(op), field: 'operation', targetId: op.id, oldValue: opLogLabel(prev), newValue: opLogLabel(op) });
    }
    if ((prev.executor || '') !== (op.executor || '')) {
      recordCardLog(cardRef, { action: 'Исполнитель', object: opLogLabel(op), field: 'executor', targetId: op.id, oldValue: prev.executor || '', newValue: op.executor || '' });
    }
    if ((prev.plannedMinutes || 0) !== (op.plannedMinutes || 0)) {
      recordCardLog(cardRef, { action: 'Плановое время', object: opLogLabel(op), field: 'plannedMinutes', targetId: op.id, oldValue: prev.plannedMinutes || 0, newValue: op.plannedMinutes || 0 });
    }
    if ((prev.order || 0) !== (op.order || 0)) {
      recordCardLog(cardRef, { action: 'Порядок операции', object: opLogLabel(op), field: 'order', targetId: op.id, oldValue: prev.order || 0, newValue: op.order || 0 });
    }
  });

  originalOps.forEach(op => {
    if (!updatedMap.has(op.id)) {
      recordCardLog(cardRef, { action: 'Удаление операции', object: opLogLabel(op), targetId: op.id, oldValue: `${op.centerName || ''} / ${op.executor || ''}`.trim(), newValue: '' });
    }
  });
}

function getAttachmentTargetCard() {
  if (!attachmentContext) return null;
  if (attachmentContext.source === 'draft') {
    return activeCardDraft;
  }
  return cards.find(c => c.id === attachmentContext.cardId);
}

function renderAttachmentsModal() {
  const modal = document.getElementById('attachments-modal');
  if (!modal || !attachmentContext) return;
  const card = getAttachmentTargetCard();
  const title = document.getElementById('attachments-title');
  const list = document.getElementById('attachments-list');
  const uploadHint = document.getElementById('attachments-upload-hint');
  if (!card || !list || !title || !uploadHint) return;
  ensureAttachments(card);
  title.textContent = card.name || card.barcode || 'Файлы карты';
  const files = card.attachments || [];
  if (!files.length) {
    list.innerHTML = '<p>Файлы ещё не добавлены.</p>';
  } else {
    let html = '<table class="attachments-table"><thead><tr><th>Имя файла</th><th>Размер</th><th>Дата</th><th>Действия</th></tr></thead><tbody>';
    files.forEach(file => {
      const date = new Date(file.createdAt || Date.now()).toLocaleString();
      const downloadAttr = attachmentContext.source === 'live'
        ? 'href="/files/' + file.id + '" target="_blank" rel="noopener"'
        : '';
      html += '<tr>' +
        '<td>' + escapeHtml(file.name || 'файл') + '</td>' +
        '<td>' + escapeHtml(formatBytes(file.size)) + '</td>' +
        '<td>' + escapeHtml(date) + '</td>' +
        '<td><div class="table-actions">' +
        (attachmentContext.source === 'live'
          ? '<a class="btn-small" ' + downloadAttr + '>Скачать</a>'
          : '<button class="btn-small" data-download-id="' + file.id + '">Скачать</button>') +
        '</div></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    list.innerHTML = html;
  }
  uploadHint.textContent = 'Допустимые форматы: pdf, doc, jpg, архив. Максимум ' + formatBytes(ATTACH_MAX_SIZE) + '.';

  if (attachmentContext.source !== 'live') {
    list.querySelectorAll('button[data-download-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-download-id');
        const cardRef = getAttachmentTargetCard();
        if (!cardRef) return;
        const file = (cardRef.attachments || []).find(f => f.id === id);
        if (!file || !file.content) return;
        const blob = dataUrlToBlob(file.content, file.type);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = file.name || 'file';
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 5000);
      });
    });
  }
}

async function addAttachmentsFromFiles(fileList) {
  const card = getAttachmentTargetCard();
  if (!card || !fileList || !fileList.length) return;
  ensureAttachments(card);
  const beforeCount = card.attachments.length;
  const filesArray = Array.from(fileList);
  const allowed = ATTACH_ACCEPT.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  const newFiles = [];

  for (const file of filesArray) {
    const ext = ('.' + (file.name.split('.').pop() || '')).toLowerCase();
    if (allowed.length && !allowed.includes(ext)) {
      alert('Тип файла не поддерживается: ' + file.name);
      continue;
    }
    if (file.size > ATTACH_MAX_SIZE) {
      alert('Файл ' + file.name + ' превышает лимит ' + formatBytes(ATTACH_MAX_SIZE));
      continue;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    newFiles.push({
      id: genId('file'),
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      content: dataUrl,
      createdAt: Date.now()
    });
  }

  if (newFiles.length) {
    card.attachments.push(...newFiles);
    recordCardLog(card, { action: 'Файлы', object: 'Карта', field: 'attachments', oldValue: beforeCount, newValue: card.attachments.length });
    if (attachmentContext.source === 'live') {
      await saveData();
      renderEverything();
    }
    renderAttachmentsModal();
    updateAttachmentCounters(card.id);
  }
}

function openAttachmentsModal(cardId, source = 'live') {
  const modal = document.getElementById('attachments-modal');
  if (!modal) return;
  const card = source === 'draft' ? activeCardDraft : cards.find(c => c.id === cardId);
  if (!card) return;
  attachmentContext = { cardId: card.id, source };
  renderAttachmentsModal();
  modal.classList.remove('hidden');
}

function closeAttachmentsModal() {
  const modal = document.getElementById('attachments-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  const input = document.getElementById('attachments-input');
  if (input) input.value = '';
  attachmentContext = null;
}

function updateAttachmentCounters(cardId) {
  const count = (() => {
    if (activeCardDraft && activeCardDraft.id === cardId) {
      return (activeCardDraft.attachments || []).length;
    }
    const card = cards.find(c => c.id === cardId);
    return card ? (card.attachments || []).length : 0;
  })();

  const cardBtn = document.getElementById('card-attachments-btn');
  if (cardBtn && activeCardDraft && activeCardDraft.id === cardId) {
    cardBtn.innerHTML = '📎 Файлы (' + count + ')';
  }
}

function buildLogHistoryTable(card) {
  const logs = (card.logs || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (!logs.length) return '<p>История изменений пока отсутствует.</p>';
  let html = '<table><thead><tr><th>Дата/время</th><th>Тип действия</th><th>Объект</th><th>Старое значение</th><th>Новое значение</th></tr></thead><tbody>';
  logs.forEach(entry => {
    const date = new Date(entry.ts || Date.now()).toLocaleString();
    html += '<tr>' +
      '<td>' + escapeHtml(date) + '</td>' +
      '<td>' + escapeHtml(entry.action || '') + '</td>' +
      '<td>' + escapeHtml(entry.object || '') + (entry.field ? ' (' + escapeHtml(entry.field) + ')' : '') + '</td>' +
      '<td>' + escapeHtml(entry.oldValue || '') + '</td>' +
      '<td>' + escapeHtml(entry.newValue || '') + '</td>' +
      '</tr>';
  });
  html += '</tbody></table>';
  return html;
}

function buildExecutorHistory(card, op) {
  const entries = (card.logs || [])
    .filter(entry => entry.targetId === op.id && entry.field === 'executor')
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (!entries.length) {
    return op.executor || '';
  }
  const chain = [];
  entries.forEach((entry, idx) => {
    if (idx === 0 && entry.oldValue) chain.push(entry.oldValue);
    if (entry.newValue) chain.push(entry.newValue);
  });
  if (!chain.length && op.executor) chain.push(op.executor);
  return chain.filter(Boolean).join(' → ');
}

function buildSummaryTable(card) {
  const opsSorted = [...(card.operations || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!opsSorted.length) return '<p>Маршрут пока пуст.</p>';
  let html = '<table><thead><tr>' +
    '<th>Порядок</th><th>Участок</th><th>Код операции</th><th>Операция</th><th>Исполнитель</th><th>План (мин)</th><th>Статус</th><th>Дата и время Н/К</th><th>Текущее / факт. время</th><th>Комментарии</th>' +
    '</tr></thead><tbody>';

  opsSorted.forEach((op, idx) => {
    const rowId = card.id + '::' + op.id;
    const elapsed = getOperationElapsedSeconds(op);
    let timeCell = '';
    if (op.status === 'IN_PROGRESS' || op.status === 'PAUSED') {
      timeCell = '<span class="wo-timer" data-row-id="' + rowId + '">' + formatSecondsToHMS(elapsed) + '</span>';
    } else if (op.status === 'DONE') {
      const seconds = typeof op.elapsedSeconds === 'number' && op.elapsedSeconds
        ? op.elapsedSeconds
        : (op.actualSeconds || 0);
      timeCell = formatSecondsToHMS(seconds);
    }

    const executorHistory = buildExecutorHistory(card, op) || op.executor || '';
    const startEndCell = formatStartEnd(op);

    html += '<tr data-row-id="' + rowId + '">' +
      '<td>' + (idx + 1) + '</td>' +
      '<td>' + escapeHtml(op.centerName) + '</td>' +
      '<td>' + escapeHtml(op.opCode || '') + '</td>' +
      '<td>' + renderOpName(op) + '</td>' +
      '<td>' + escapeHtml(executorHistory) + '</td>' +
      '<td>' + (op.plannedMinutes || '') + '</td>' +
      '<td>' + statusBadge(op.status) + '</td>' +
      '<td>' + startEndCell + '</td>' +
      '<td>' + timeCell + '</td>' +
      '<td>' + escapeHtml(op.comment || '') + '</td>' +
      '</tr>';

    html += renderQuantityRow(card, op, { readonly: true, colspan: 10 });
  });

  html += '</tbody></table>';
  return html;
}

function buildInitialSummaryTable(card) {
  const opsSorted = [...(card.operations || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!opsSorted.length) return '<p>Маршрут пока пуст.</p>';
  let html = '<table><thead><tr>' +
    '<th>Порядок</th><th>Участок</th><th>Код операции</th><th>Операция</th><th>Исполнитель</th><th>План (мин)</th>' +
    '</tr></thead><tbody>';

  opsSorted.forEach((op, idx) => {
    const executorHistory = buildExecutorHistory(card, op) || op.executor || '';

    html += '<tr>' +
      '<td>' + (idx + 1) + '</td>' +
      '<td>' + escapeHtml(op.centerName) + '</td>' +
      '<td>' + escapeHtml(op.opCode || '') + '</td>' +
      '<td>' + renderOpName(op) + '</td>' +
      '<td>' + escapeHtml(executorHistory) + '</td>' +
      '<td>' + (op.plannedMinutes || '') + '</td>' +
      '</tr>';
  });

  html += '</tbody></table>';
  return html;
}

function buildInitialSnapshotHtml(card) {
  if (!card) return '';
  const snapshot = card.initialSnapshot || card;
  const qtyText = formatQuantityValue(snapshot.quantity);
  const metaHtml = '<div class="log-initial-meta">' +
    '<div><strong>Наименование:</strong> ' + escapeHtml(snapshot.name || '') + '</div>' +
    '<div><strong>Количество, шт:</strong> ' + escapeHtml(qtyText || '') + '</div>' +
    '<div><strong>Заказ:</strong> ' + escapeHtml(snapshot.orderNo || '') + '</div>' +
    '<div><strong>Чертёж / обозначение:</strong> ' + escapeHtml(snapshot.drawing || '') + '</div>' +
    '<div><strong>Материал:</strong> ' + escapeHtml(snapshot.material || '') + '</div>' +
    '<div><strong>Описание:</strong> ' + escapeHtml(snapshot.desc || '') + '</div>' +
    '</div>';
  const opsHtml = buildInitialSummaryTable(snapshot);
  return metaHtml + opsHtml;
}

function renderInitialSnapshot(card) {
  const container = document.getElementById('log-initial-view');
  if (!container || !card) return;
  container.innerHTML = buildInitialSnapshotHtml(card);
}

function renderLogModal(cardId) {
  const modal = document.getElementById('log-modal');
  if (!modal) return;
  const card = cards.find(c => c.id === cardId);
  if (!card) return;
  logContextCardId = card.id;
  const barcodeCanvas = document.getElementById('log-barcode-canvas');
  drawBarcodeEAN13(barcodeCanvas, card.barcode || '');
  const barcodeNum = document.getElementById('log-barcode-number');
  if (barcodeNum) {
    if (barcodeCanvas && card.barcode) {
      barcodeNum.textContent = '';
      barcodeNum.classList.add('hidden');
    } else {
      barcodeNum.textContent = card.barcode || '';
      barcodeNum.classList.remove('hidden');
    }
  }
  const nameEl = document.getElementById('log-card-name');
  if (nameEl) nameEl.textContent = card.name || '';
  const orderEl = document.getElementById('log-card-order');
  if (orderEl) orderEl.textContent = card.orderNo || '';
  const statusEl = document.getElementById('log-card-status');
  if (statusEl) statusEl.textContent = cardStatusText(card);
  const createdEl = document.getElementById('log-card-created');
  if (createdEl) createdEl.textContent = new Date(card.createdAt || Date.now()).toLocaleString();

  renderInitialSnapshot(card);
  const historyContainer = document.getElementById('log-history-table');
  if (historyContainer) historyContainer.innerHTML = buildLogHistoryTable(card);
  const summaryContainer = document.getElementById('log-summary-table');
  if (summaryContainer) summaryContainer.innerHTML = buildSummaryTable(card);

  modal.classList.remove('hidden');
}

function openLogModal(cardId) {
  renderLogModal(cardId);
}

function closeLogModal() {
  const modal = document.getElementById('log-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  logContextCardId = null;
}

function printCardView(card, { blankQuantities = false } = {}) {
  if (!card) return;
  const barcodeData = getBarcodeDataUrl(card.barcode || '');
  const opsHtml = buildOperationsTable(card, { readonly: true, quantityPrintBlanks: blankQuantities });
  const qtyText = formatQuantityValue(card.quantity);
  const win = window.open('', '_blank');
  if (!win) return;
  const styles = `
    @page { size: A4 portrait; margin: 12mm; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; vertical-align: top; }
    thead { background: #f3f4f6; }
    .print-header { display: flex; gap: 16px; align-items: flex-start; }
    .barcode-box { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
    .barcode-box img { max-height: 80px; }
    .meta-stack { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 6px 16px; margin-top: 6px; }
    .meta-item { font-size: 13px; }
    .op-qty-row td { background: #f9fafb; }
    .qty-row-content { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .qty-row-content label { font-weight: 600; }
  `;
  win.document.write('<html><head><title>Маршрутная карта</title><style>' + styles + '</style></head><body>');
  win.document.write('<div class="print-header">');
  win.document.write('<div class="barcode-box">');
  if (barcodeData) {
    win.document.write('<img src="' + barcodeData + '" alt="barcode" />');
  } else if (card.barcode) {
    win.document.write('<strong>' + escapeHtml(card.barcode) + '</strong>');
  }
  win.document.write('</div>');
  win.document.write('<div class="meta-stack">');
  if (!barcodeData && card.barcode) {
    win.document.write('<div class="meta-item"><strong>№ карты:</strong> ' + escapeHtml(card.barcode) + '</div>');
  }
  win.document.write('<div class="meta-item"><strong>Наименование:</strong> ' + escapeHtml(card.name || '') + '</div>');
  win.document.write('<div class="meta-item"><strong>Количество, шт:</strong> ' + escapeHtml(qtyText || '') + '</div>');
  win.document.write('<div class="meta-item"><strong>Заказ:</strong> ' + escapeHtml(card.orderNo || '') + '</div>');
  win.document.write('<div class="meta-item"><strong>Чертёж / обозначение:</strong> ' + escapeHtml(card.drawing || '') + '</div>');
  win.document.write('<div class="meta-item"><strong>Материал:</strong> ' + escapeHtml(card.material || '') + '</div>');
  win.document.write('<div class="meta-item"><strong>Описание:</strong> ' + escapeHtml(card.desc || '') + '</div>');
  win.document.write('</div>');
  win.document.write('</div>');
  win.document.write('<h3>Маршрут выполнения операций</h3>');
  win.document.write(opsHtml);
  win.document.write('</body></html>');
  win.document.close();
  win.focus();
  win.print();
}

function printSummaryTable() {
  if (!logContextCardId) return;
  const card = cards.find(c => c.id === logContextCardId);
  if (!card) return;
  const summaryHtml = buildSummaryTable(card);
  const barcodeData = getBarcodeDataUrl(card.barcode || '');
  const win = window.open('', '_blank');
  if (!win) return;
  const styles = `
    @page { size: A4 landscape; margin: 20mm; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; vertical-align: top; }
    thead { background: #f3f4f6; }
    .op-qty-row td { background: #f9fafb; }
    .qty-row-content { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .qty-row-content label { font-weight: 600; }
    .barcode-print { display: flex; align-items: center; gap: 12px; margin: 8px 0; }
    .meta-print { margin: 2px 0; font-size: 13px; }
    .meta-stack { display: flex; flex-direction: column; gap: 2px; }
    .summary-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .summary-header .meta-stack { align-items: flex-end; text-align: right; }
  `;
  win.document.write('<html><head><title>Сводная таблица</title><style>' + styles + '</style></head><body>');
  win.document.write('<h2>' + escapeHtml(card.name || '') + '</h2>');
  win.document.write('<div class="summary-header">');
  win.document.write('<div class="barcode-print">');
  if (barcodeData) {
    win.document.write('<img src="' + barcodeData + '" style="max-height:80px;" />');
  }
  win.document.write('<div class="meta-stack">');
  if (!barcodeData && card.barcode) {
    win.document.write('<div class="meta-print"><strong>№ карты:</strong> ' + escapeHtml(card.barcode) + '</div>');
  }
  win.document.write('<div class="meta-print"><strong>Заказ:</strong> ' + escapeHtml(card.orderNo || '') + '</div>');
  win.document.write('</div></div>');
  win.document.write('<div class="meta-stack">');
  win.document.write('<div class="meta-print"><strong>Количество, шт:</strong> ' + escapeHtml(formatQuantityValue(card.quantity)) + '</div>');
  win.document.write('<div class="meta-print"><strong>Чертёж / обозначение:</strong> ' + escapeHtml(card.drawing || '') + '</div>');
  win.document.write('<div class="meta-print"><strong>Материал:</strong> ' + escapeHtml(card.material || '') + '</div>');
  win.document.write('<div class="meta-print"><strong>Описание:</strong> ' + escapeHtml(card.desc || '') + '</div>');
  win.document.write('<div class="meta-print"><strong>Статус:</strong> ' + escapeHtml(cardStatusText(card)) + '</div>');
  win.document.write('</div>');
  win.document.write('</div>');
  win.document.write(summaryHtml);
  win.document.write('</body></html>');
  win.document.close();
  win.focus();
  win.print();
}

function printFullLog() {
  if (!logContextCardId) return;
  const card = cards.find(c => c.id === logContextCardId);
  if (!card) return;
  const barcodeData = getBarcodeDataUrl(card.barcode || '');
  const initialHtml = buildInitialSnapshotHtml(card);
  const historyHtml = buildLogHistoryTable(card);
  const summaryHtml = buildSummaryTable(card);
  const win = window.open('', '_blank');
  if (!win) return;
  const styles = `
    @page { size: A4 landscape; margin: 12mm; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    h2, h3, h4 { margin: 8px 0; }
    .meta-print { margin: 6px 0; font-size: 13px; }
    .barcode-print { display: flex; align-items: center; gap: 12px; margin: 8px 0; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; vertical-align: top; }
    thead { background: #f3f4f6; }
    .op-qty-row td { background: #f9fafb; }
    .qty-row-content { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .qty-row-content label { font-weight: 600; }
    .section-spacer { margin-top: 12px; }
  `;
  win.document.write('<html><head><title>История изменений</title><style>' + styles + '</style></head><body>');
  win.document.write('<h2>' + escapeHtml(card.name || '') + '</h2>');
  win.document.write('<div class="meta-print"><strong>Заказ:</strong> ' + escapeHtml(card.orderNo || '') + '</div>');
  win.document.write('<div class="meta-print"><strong>Количество, шт:</strong> ' + escapeHtml(formatQuantityValue(card.quantity)) + '</div>');
  win.document.write('<div class="meta-print"><strong>Чертёж / обозначение:</strong> ' + escapeHtml(card.drawing || '') + '</div>');
  win.document.write('<div class="meta-print"><strong>Материал:</strong> ' + escapeHtml(card.material || '') + '</div>');
  win.document.write('<div class="meta-print"><strong>Статус:</strong> ' + escapeHtml(cardStatusText(card)) + '</div>');
  win.document.write('<div class="meta-print"><strong>Создана:</strong> ' + escapeHtml(new Date(card.createdAt || Date.now()).toLocaleString()) + '</div>');
  if (barcodeData) {
    win.document.write('<div class="barcode-print"><img src="' + barcodeData + '" style="max-height:80px;" /></div>');
  } else if (card.barcode) {
    win.document.write('<div class="barcode-print"><strong>' + escapeHtml(card.barcode) + '</strong></div>');
  }
  win.document.write('<div class="section-spacer"><h3>Вид карты при создании</h3>' + initialHtml + '</div>');
  win.document.write('<div class="section-spacer"><h3>История изменений</h3>' + historyHtml + '</div>');
  win.document.write('<div class="section-spacer"><h3>Сводная таблица операций</h3>' + summaryHtml + '</div>');
  win.document.write('</body></html>');
  win.document.close();
  win.focus();
  win.print();
}

function setupLogModal() {
  const modal = document.getElementById('log-modal');
  const closeBtn = document.getElementById('log-close');
  const printBtn = document.getElementById('log-print-summary');
  const printAllBtn = document.getElementById('log-print-all');
  const closeBottomBtn = document.getElementById('log-close-bottom');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => closeLogModal());
  }
  if (closeBottomBtn) {
    closeBottomBtn.addEventListener('click', () => closeLogModal());
  }
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeLogModal();
    });
  }
  if (printBtn) {
    printBtn.addEventListener('click', () => printSummaryTable());
  }
  if (printAllBtn) {
    printAllBtn.addEventListener('click', () => printFullLog());
  }
}

// === МАРШРУТ КАРТЫ (ЧЕРЕЗ МОДАЛЬНОЕ ОКНО) ===
function renderRouteTableDraft() {
  const wrapper = document.getElementById('route-table-wrapper');
  if (!wrapper || !activeCardDraft) return;
  const opsArr = activeCardDraft.operations || [];
  renumberAutoCodesForCard(activeCardDraft);
  if (!opsArr.length) {
    wrapper.innerHTML = '<p>Маршрут пока пуст. Добавьте операции ниже.</p>';
    document.getElementById('card-status-text').textContent = cardStatusText(activeCardDraft);
    return;
  }
  const sortedOps = [...opsArr].sort((a, b) => (a.order || 0) - (b.order || 0));
  let html = '<table><thead><tr>' +
    '<th>Порядок</th><th>Участок</th><th>Код операции</th><th>Операция</th><th>Кол-во изделий</th><th>Исполнитель</th><th>План (мин)</th><th>Статус</th><th>Действия</th>' +
    '</tr></thead><tbody>';
  sortedOps.forEach((o, index) => {
    html += '<tr data-rop-id="' + o.id + '">' +
      '<td>' + (index + 1) + '</td>' +
      '<td>' + escapeHtml(o.centerName) + '</td>' +
      '<td><input class="route-code-input" data-rop-id="' + o.id + '" value="' + escapeHtml(o.opCode || '') + '" /></td>' +
      '<td>' + renderOpName(o) + '</td>' +
      '<td><input type="number" min="0" class="route-qty-input" data-rop-id="' + o.id + '" value="' + escapeHtml(getOperationQuantity(o, activeCardDraft)) + '"></td>' +
      '<td><input class="executor-input" data-rop-id="' + o.id + '" value="' + escapeHtml(o.executor || '') + '" placeholder="ФИО" /></td>' +
      '<td>' + (o.plannedMinutes || '') + '</td>' +
      '<td>' + statusBadge(o.status) + '</td>' +
      '<td><div class="table-actions">' +
      '<button class="btn-small" data-action="move-up">↑</button>' +
      '<button class="btn-small" data-action="move-down">↓</button>' +
      '<button class="btn-small btn-danger" data-action="delete">Удалить</button>' +
      '</div></td>' +
      '</tr>';
  });
  html += '</tbody></table>';
  wrapper.innerHTML = html;

  wrapper.querySelectorAll('tr[data-rop-id]').forEach(row => {
    const ropId = row.getAttribute('data-rop-id');
    row.querySelectorAll('button[data-action]').forEach(btn => {
      const action = btn.getAttribute('data-action');
      btn.addEventListener('click', () => {
        if (!activeCardDraft) return;
        if (action === 'delete') {
          activeCardDraft.operations = activeCardDraft.operations.filter(o => o.id !== ropId);
          renumberAutoCodesForCard(activeCardDraft);
        } else if (action === 'move-up' || action === 'move-down') {
          moveRouteOpInDraft(ropId, action === 'move-up' ? -1 : 1);
        }
        document.getElementById('card-status-text').textContent = cardStatusText(activeCardDraft);
        renderRouteTableDraft();
      });
    });
  });

  wrapper.querySelectorAll('.executor-input').forEach(input => {
    input.addEventListener('input', e => {
      const ropId = input.getAttribute('data-rop-id');
      const value = (e.target.value || '').trim();
      const op = activeCardDraft.operations.find(o => o.id === ropId);
      if (!op) return;
      op.executor = value;
      document.getElementById('card-status-text').textContent = cardStatusText(activeCardDraft);
    });
  });

  wrapper.querySelectorAll('.route-code-input').forEach(input => {
    input.addEventListener('blur', e => {
      if (!activeCardDraft) return;
      const ropId = input.getAttribute('data-rop-id');
      const op = activeCardDraft.operations.find(o => o.id === ropId);
      if (!op) return;
      const prev = op.opCode || '';
      const value = (e.target.value || '').trim();
      if (!value) {
        op.autoCode = true;
      } else {
        op.autoCode = false;
        op.opCode = value;
      }
      renumberAutoCodesForCard(activeCardDraft);
      if (prev !== op.opCode && !activeCardIsNew) {
        recordCardLog(activeCardDraft, { action: 'Код операции', object: opLogLabel(op), field: 'opCode', targetId: op.id, oldValue: prev, newValue: op.opCode });
      }
      renderRouteTableDraft();
    });
  });

  wrapper.querySelectorAll('.route-qty-input').forEach(input => {
    input.addEventListener('input', e => {
      e.target.value = toSafeCount(e.target.value);
    });
    input.addEventListener('blur', e => {
      if (!activeCardDraft) return;
      const ropId = input.getAttribute('data-rop-id');
      const op = activeCardDraft.operations.find(o => o.id === ropId);
      if (!op) return;
      const prev = getOperationQuantity(op, activeCardDraft);
      const raw = e.target.value;
      if (raw === '') {
        op.quantity = '';
      } else {
        op.quantity = toSafeCount(raw);
      }
      if (prev !== op.quantity && !activeCardIsNew) {
        recordCardLog(activeCardDraft, { action: 'Количество изделий', object: opLogLabel(op), field: 'operationQuantity', targetId: op.id, oldValue: prev, newValue: op.quantity });
      }
      renderRouteTableDraft();
    });
  });
}

function moveRouteOpInDraft(ropId, delta) {
  if (!activeCardDraft) return;
  const opsArr = [...(activeCardDraft.operations || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const idx = opsArr.findIndex(o => o.id === ropId);
  if (idx < 0) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= opsArr.length) return;
  const tmpOrder = opsArr[idx].order;
  opsArr[idx].order = opsArr[newIdx].order;
  opsArr[newIdx].order = tmpOrder;
  activeCardDraft.operations = opsArr;
  renumberAutoCodesForCard(activeCardDraft);
}

function fillRouteSelectors() {
  const opSelect = document.getElementById('route-op');
  const centerSelect = document.getElementById('route-center');
  opSelect.innerHTML = '';
  centerSelect.innerHTML = '';
  const current = opSelect.value;
  ops.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = formatOpLabel(o);
    opSelect.appendChild(opt);
  });
  if (current) {
    opSelect.value = current;
  }
  centers.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    centerSelect.appendChild(opt);
  });
}

// === СПРАВОЧНИКИ ===
function renderCentersTable() {
  const wrapper = document.getElementById('centers-table-wrapper');
  if (!centers.length) {
    wrapper.innerHTML = '<p>Список участков пуст.</p>';
    return;
  }
  let html = '<table><thead><tr><th>Название</th><th>Описание</th><th>Действия</th></tr></thead><tbody>';
  centers.forEach(center => {
    html += '<tr>' +
      '<td>' + escapeHtml(center.name) + '</td>' +
      '<td>' + escapeHtml(center.desc || '') + '</td>' +
      '<td><button class="btn-small btn-danger" data-id="' + center.id + '">Удалить</button></td>' +
      '</tr>';
  });
  html += '</tbody></table>';
  wrapper.innerHTML = html;
  wrapper.querySelectorAll('button[data-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      if (confirm('Удалить участок? Он останется в уже созданных маршрутах как текст.')) {
        centers = centers.filter(c => c.id !== id);
        saveData();
        renderCentersTable();
        fillRouteSelectors();
      }
    });
  });
}

function renderOpsTable() {
  const wrapper = document.getElementById('ops-table-wrapper');
  if (!ops.length) {
    wrapper.innerHTML = '<p>Список операций пуст.</p>';
    return;
  }
  let html = '<table><thead><tr><th>Код операции</th><th>Название</th><th>Описание</th><th>Рек. время (мин)</th><th>Действия</th></tr></thead><tbody>';
  ops.forEach(o => {
    html += '<tr>' +
      '<td>' + escapeHtml(o.code || '') + '</td>' +
      '<td>' + escapeHtml(o.name) + '</td>' +
      '<td>' + escapeHtml(o.desc || '') + '</td>' +
      '<td>' + (o.recTime || '') + '</td>' +
      '<td><button class="btn-small btn-danger" data-id="' + o.id + '">Удалить</button></td>' +
      '</tr>';
  });
  html += '</tbody></table>';
  wrapper.innerHTML = html;
  wrapper.querySelectorAll('button[data-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      if (confirm('Удалить операцию? Она останется в уже созданных маршрутах как текст.')) {
        ops = ops.filter(o => o.id !== id);
        saveData();
        renderOpsTable();
        fillRouteSelectors();
      }
    });
  });
}

// === МАРШРУТНЫЕ КВИТАНЦИИ ===
function getAllRouteRows() {
  const rows = [];
  cards.forEach(card => {
    (card.operations || []).forEach(op => {
      rows.push({ card, op });
    });
  });
  return rows;
}

function cardSearchScore(card, term) {
  if (!term) return 0;
  const t = term.toLowerCase();
  const digits = term.replace(/\s+/g, '');
  let score = 0;
  if (card.barcode) {
    if (card.barcode === digits) score += 200;
    else if (card.barcode.indexOf(digits) !== -1) score += 100;
  }
  if (card.name && card.name.toLowerCase().includes(t)) score += 50;
  if (card.orderNo && card.orderNo.toLowerCase().includes(t)) score += 50;
  if (card.contractNumber && card.contractNumber.toLowerCase().includes(t)) score += 50;
  return score;
}

function renderExecutorCell(op, card, { readonly = false } = {}) {
  const extras = Array.isArray(op.additionalExecutors) ? op.additionalExecutors : [];
  if (readonly) {
    const extrasText = extras.filter(Boolean).length
      ? '<div class="additional-executor-list">' + extras.map(name => '<span class="executor-chip">' + escapeHtml(name) + '</span>').join('') + '</div>'
      : '';
    return '<div class="executor-cell readonly">' +
      '<div class="executor-name">' + escapeHtml(op.executor || '') + '</div>' +
      extrasText +
      '</div>';
  }

  const cardId = card ? card.id : '';
  let html = '<div class="executor-cell" data-card-id="' + cardId + '" data-op-id="' + op.id + '">';
  html += '<div class="executor-row primary">' +
    '<span class="executor-name">' + escapeHtml(op.executor || '') + '</span>' +
    (extras.length < 2 ? '<button type="button" class="icon-btn add-executor-btn" data-card-id="' + cardId + '" data-op-id="' + op.id + '">+</button>' : '') +
    '</div>';

  extras.forEach((name, idx) => {
    const canAddMore = extras.length < 2 && idx === extras.length - 1;
    html += '<div class="executor-row extra" data-extra-index="' + idx + '">' +
      '<input type="text" class="additional-executor-input" data-card-id="' + cardId + '" data-op-id="' + op.id + '" data-extra-index="' + idx + '" value="' + escapeHtml(name || '') + '" placeholder="Доп. исполнитель" />' +
      (canAddMore ? '<button type="button" class="icon-btn add-executor-btn" data-card-id="' + cardId + '" data-op-id="' + op.id + '">+</button>' : '') +
      '<button type="button" class="icon-btn remove-executor-btn" data-card-id="' + cardId + '" data-op-id="' + op.id + '" data-extra-index="' + idx + '">-</button>' +
      '</div>';
  });

  html += '</div>';
  return html;
}

function buildOperationsTable(card, { readonly = false, quantityPrintBlanks = false } = {}) {
  const opsSorted = [...(card.operations || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  let html = '<table><thead><tr>' +
    '<th>Порядок</th><th>Участок</th><th>Код операции</th><th>Операция</th><th>Количество изделий</th><th>Исполнитель</th><th>План (мин)</th><th>Статус</th><th>Текущее / факт. время</th>' +
    (readonly ? '' : '<th>Действия</th>') +
    '<th>Комментарии</th>' +
    '</tr></thead><tbody>';

  opsSorted.forEach((op, idx) => {
    const rowId = card.id + '::' + op.id;
    const elapsed = getOperationElapsedSeconds(op);
    let timeCell = '';
    if (op.status === 'IN_PROGRESS' || op.status === 'PAUSED') {
      timeCell = '<span class="wo-timer" data-row-id="' + rowId + '">' + formatSecondsToHMS(elapsed) + '</span>';
    } else if (op.status === 'DONE') {
      const seconds = typeof op.elapsedSeconds === 'number' && op.elapsedSeconds
        ? op.elapsedSeconds
        : (op.actualSeconds || 0);
      timeCell = formatSecondsToHMS(seconds);
    }

    let actionsHtml = '';
    if (!readonly) {
      if (op.status === 'NOT_STARTED' || !op.status) {
        actionsHtml = '<button class="btn-primary" data-action="start" data-card-id="' + card.id + '" data-op-id="' + op.id + '">Начать</button>';
      } else if (op.status === 'IN_PROGRESS') {
        actionsHtml =
          '<button class="btn-secondary" data-action="pause" data-card-id="' + card.id + '" data-op-id="' + op.id + '">Пауза</button>' +
          '<button class="btn-secondary" data-action="stop" data-card-id="' + card.id + '" data-op-id="' + op.id + '">Завершить</button>';
      } else if (op.status === 'PAUSED') {
        actionsHtml =
          '<button class="btn-primary" data-action="resume" data-card-id="' + card.id + '" data-op-id="' + op.id + '">Продолжить</button>' +
          '<button class="btn-secondary" data-action="stop" data-card-id="' + card.id + '" data-op-id="' + op.id + '">Завершить</button>';
      } else if (op.status === 'DONE') {
        actionsHtml =
          '<button class="btn-primary" data-action="resume" data-card-id="' + card.id + '" data-op-id="' + op.id + '">Продолжить</button>';
      }
    }

    const commentCell = readonly || op.status === 'DONE'
      ? '<div class="comment-readonly">' + escapeHtml(op.comment || '') + '</div>'
      : '<textarea class="comment-input" data-card-id="' + card.id + '" data-op-id="' + op.id + '" maxlength="40" rows="1" placeholder="Комментарий">' + escapeHtml(op.comment || '') + '</textarea>';

    const actionsCell = readonly
      ? ''
      : '<td><div class="table-actions">' + actionsHtml + '</div></td>';

    html += '<tr data-row-id="' + rowId + '">' +
      '<td>' + (idx + 1) + '</td>' +
      '<td>' + escapeHtml(op.centerName) + '</td>' +
      '<td>' + escapeHtml(op.opCode || '') + '</td>' +
      '<td>' + renderOpName(op) + '</td>' +
      '<td>' + escapeHtml(getOperationQuantity(op, card)) + '</td>' +
      '<td>' + renderExecutorCell(op, card, { readonly }) + '</td>' +
      '<td>' + (op.plannedMinutes || '') + '</td>' +
      '<td>' + statusBadge(op.status) + '</td>' +
      '<td>' + timeCell + '</td>' +
      actionsCell +
      '<td>' + commentCell + '</td>' +
      '</tr>';

    html += renderQuantityRow(card, op, { readonly, colspan: readonly ? 10 : 11, blankForPrint: quantityPrintBlanks });
  });

  html += '</tbody></table>';
  return html;
}

function formatQuantityValue(val) {
  if (val === '' || val == null) return '';
  return val + ' шт';
}

function buildCardInfoBlock(card) {
  if (!card) return '';
  const items = [
    { label: 'Количество', value: formatQuantityValue(card.quantity) },
    { label: 'Чертёж / обозначение детали', value: card.drawing },
    { label: 'Материал', value: card.material },
    { label: 'Номер договора', value: card.contractNumber },
    { label: 'Описание', value: card.desc }
  ];

  let html = '<div class="card-info-block">';
  items.forEach(item => {
    const value = item.value ? escapeHtml(item.value) : '—';
    html += '<div class="info-row">' +
      '<strong>' + escapeHtml(item.label) + ':</strong>' +
      '<span>' + value + '</span>' +
      '</div>';
  });
  html += '</div>';
  return html;
}

function renderQuantityRow(card, op, { readonly = false, colspan = 9, blankForPrint = false } = {}) {
  const opQty = getOperationQuantity(op, card);
  const totalLabel = opQty === '' ? '—' : opQty + ' шт';
  const base = '<span class="qty-total">Количество изделий: ' + escapeHtml(totalLabel) + '</span>';
  const lockRow = readonly || op.status === 'DONE';
  const goodVal = op.goodCount != null ? op.goodCount : 0;
  const scrapVal = op.scrapCount != null ? op.scrapCount : 0;
  const holdVal = op.holdCount != null ? op.holdCount : 0;

  if (lockRow) {
    const chipGood = blankForPrint ? '____' : escapeHtml(goodVal);
    const chipScrap = blankForPrint ? '____' : escapeHtml(scrapVal);
    const chipHold = blankForPrint ? '____' : escapeHtml(holdVal);

    return '<tr class="op-qty-row"><td colspan="' + colspan + '">' +
      '<div class="qty-row-content readonly">' +
      base +
      '<span class="qty-chip">Годные: ' + chipGood + '</span>' +
      '<span class="qty-chip">Брак: ' + chipScrap + '</span>' +
      '<span class="qty-chip">Задержано: ' + chipHold + '</span>' +
      '</div>' +
      '</td></tr>';
  }

  return '<tr class="op-qty-row" data-card-id="' + card.id + '" data-op-id="' + op.id + '"><td colspan="' + colspan + '">' +
    '<div class="qty-row-content">' +
    base +
    '<label>Годные <input type="number" class="qty-input" data-qty-type="good" data-card-id="' + card.id + '" data-op-id="' + op.id + '" min="0" value="' + goodVal + '"></label>' +
    '<label>Брак <input type="number" class="qty-input" data-qty-type="scrap" data-card-id="' + card.id + '" data-op-id="' + op.id + '" min="0" value="' + scrapVal + '"></label>' +
    '<label>Задержано <input type="number" class="qty-input" data-qty-type="hold" data-card-id="' + card.id + '" data-op-id="' + op.id + '" min="0" value="' + holdVal + '"></label>' +
    '</div>' +
    '</td></tr>';
}

function renderWorkordersTable({ collapseAll = false } = {}) {
  const wrapper = document.getElementById('workorders-table-wrapper');
  const cardsWithOps = cards.filter(c => !c.archived && c.operations && c.operations.length);
  if (!cardsWithOps.length) {
    wrapper.innerHTML = '<p>Маршрутных операций пока нет.</p>';
    return;
  }

  if (collapseAll) {
    workorderOpenCards.clear();
  }

  const termRaw = workorderSearchTerm.trim();
  const contractTerm = workorderContractTerm.trim().toLowerCase();
  const filteredByStatus = cardsWithOps.filter(card => {
    const state = getCardProcessState(card);
    return workorderStatusFilter === 'ALL' || state.key === workorderStatusFilter;
  });

  if (!filteredByStatus.length) {
    wrapper.innerHTML = '<p>Нет карт, подходящих под выбранный фильтр.</p>';
    return;
  }

  let sortedCards = [...filteredByStatus];
  if (termRaw) {
    sortedCards.sort((a, b) => cardSearchScore(b, termRaw) - cardSearchScore(a, termRaw));
  }

  const filteredBySearch = termRaw
    ? sortedCards.filter(card => cardSearchScore(card, termRaw) > 0)
    : sortedCards;

  const filteredByContract = contractTerm
    ? filteredBySearch.filter(card => (card.contractNumber || '').toLowerCase().includes(contractTerm))
    : filteredBySearch;

  if (!filteredByContract.length) {
    wrapper.innerHTML = '<p>Карты по запросу не найдены.</p>';
    return;
  }

  let html = '';
  filteredByContract.forEach(card => {
    const opened = !collapseAll && workorderOpenCards.has(card.id);
    const stateBadge = renderCardStateBadge(card);
    const canArchive = card.status === 'DONE';
    const filesCount = (card.attachments || []).length;
    const barcodeInline = card.barcode
      ? ' • № карты: <span class="summary-barcode">' + escapeHtml(card.barcode) + ' <button type="button" class="btn-small btn-secondary wo-barcode-btn" data-card-id="' + card.id + '">Штрихкод</button></span>'
      : '';
    const contractText = card.contractNumber ? ' (Договор: ' + escapeHtml(card.contractNumber) + ')' : '';
    const filesButton = ' <button type="button" class="btn-small clip-btn inline-clip" data-attach-card="' + card.id + '">📎 <span class="clip-count">' + filesCount + '</span></button>';
    const logButton = ' <button type="button" class="btn-small btn-secondary log-btn" data-log-card="' + card.id + '">Log</button>';

    html += '<details class="wo-card" data-card-id="' + card.id + '"' + (opened ? ' open' : '') + '>' +
      '<summary>' +
      '<div class="summary-line">' +
      '<div class="summary-text">' +
      '<strong>' + escapeHtml(card.name || card.id) + '</strong>' +
      ' <span class="summary-sub">' +
      (card.orderNo ? ' (Заказ: ' + escapeHtml(card.orderNo) + ')' : '') + contractText +
      barcodeInline + filesButton + logButton +
      '</span>' +
      '</div>' +
      '<div class="summary-actions">' +
      ' ' + stateBadge +
      (canArchive ? ' <button type="button" class="btn-small btn-secondary archive-move-btn" data-card-id="' + card.id + '">Перенести в архив</button>' : '') +
      '</div>' +
      '</div>' +
      '</summary>';

    html += buildCardInfoBlock(card);
    html += buildOperationsTable(card, { readonly: false });
    html += '</details>';
  });

  wrapper.innerHTML = html;

  wrapper.querySelectorAll('.wo-card').forEach(detail => {
    const cardId = detail.getAttribute('data-card-id');
    if (detail.open && cardId) {
      workorderOpenCards.add(cardId);
    }
    detail.addEventListener('toggle', () => {
      if (!cardId) return;
      if (detail.open) {
        workorderOpenCards.add(cardId);
      } else {
        workorderOpenCards.delete(cardId);
      }
    });
  });

  wrapper.querySelectorAll('.wo-barcode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-card-id');
      const card = cards.find(c => c.id === id);
      if (!card) return;
      openBarcodeModal(card);
    });
  });

  wrapper.querySelectorAll('button[data-attach-card]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute('data-attach-card');
      openAttachmentsModal(id, 'live');
    });
  });

  wrapper.querySelectorAll('.log-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute('data-log-card');
      openLogModal(id);
    });
  });

  wrapper.querySelectorAll('.archive-move-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-card-id');
      const card = cards.find(c => c.id === id);
      if (!card) return;
      if (!card.archived) {
        recordCardLog(card, { action: 'Архивирование', object: 'Карта', field: 'archived', oldValue: false, newValue: true });
      }
      card.archived = true;
      saveData();
      renderEverything();
    });
  });

  wrapper.querySelectorAll('.comment-input').forEach(input => {
    autoResizeComment(input);
    const cardId = input.getAttribute('data-card-id');
    const opId = input.getAttribute('data-op-id');
    const card = cards.find(c => c.id === cardId);
    const op = card ? (card.operations || []).find(o => o.id === opId) : null;
    if (!op) return;

    input.addEventListener('focus', () => {
      input.dataset.prevComment = op.comment || '';
    });

    input.addEventListener('input', e => {
      const value = (e.target.value || '').slice(0, 40);
      e.target.value = value;
      op.comment = value;
      autoResizeComment(e.target);
    });

    input.addEventListener('blur', e => {
      const value = (e.target.value || '').slice(0, 40);
      e.target.value = value;
      const prev = input.dataset.prevComment || '';
      if (prev !== value) {
        recordCardLog(card, { action: 'Комментарий', object: opLogLabel(op), field: 'comment', targetId: op.id, oldValue: prev, newValue: value });
      }
      op.comment = value;
      saveData();
      renderDashboard();
    });
  });

  wrapper.querySelectorAll('.add-executor-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cardId = btn.getAttribute('data-card-id');
      const opId = btn.getAttribute('data-op-id');
      const card = cards.find(c => c.id === cardId);
      const op = card ? (card.operations || []).find(o => o.id === opId) : null;
      if (!card || !op) return;
      if (!Array.isArray(op.additionalExecutors)) op.additionalExecutors = [];
      if (op.additionalExecutors.length >= 2) return;
      op.additionalExecutors.push('');
      recordCardLog(card, { action: 'Доп. исполнитель', object: opLogLabel(op), field: 'additionalExecutors', targetId: op.id, oldValue: op.additionalExecutors.length - 1, newValue: op.additionalExecutors.length });
      saveData();
      workorderOpenCards.add(cardId);
      renderWorkordersTable();
    });
  });

  wrapper.querySelectorAll('.remove-executor-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cardId = btn.getAttribute('data-card-id');
      const opId = btn.getAttribute('data-op-id');
      const idx = parseInt(btn.getAttribute('data-extra-index'), 10);
      const card = cards.find(c => c.id === cardId);
      const op = card ? (card.operations || []).find(o => o.id === opId) : null;
      if (!card || !op || !Array.isArray(op.additionalExecutors)) return;
      if (idx < 0 || idx >= op.additionalExecutors.length) return;
      const removed = op.additionalExecutors.splice(idx, 1)[0];
      recordCardLog(card, { action: 'Доп. исполнитель', object: opLogLabel(op), field: 'additionalExecutors', targetId: op.id, oldValue: removed, newValue: 'удален' });
      saveData();
      workorderOpenCards.add(cardId);
      renderWorkordersTable();
    });
  });

  wrapper.querySelectorAll('.additional-executor-input').forEach(input => {
    input.addEventListener('focus', () => {
      input.dataset.prevVal = input.value || '';
    });
    input.addEventListener('blur', e => {
      const cardId = input.getAttribute('data-card-id');
      const opId = input.getAttribute('data-op-id');
      const idx = parseInt(input.getAttribute('data-extra-index'), 10);
      const card = cards.find(c => c.id === cardId);
      const op = card ? (card.operations || []).find(o => o.id === opId) : null;
      if (!card || !op || !Array.isArray(op.additionalExecutors)) return;
      const value = (e.target.value || '').trim();
      const prev = input.dataset.prevVal || '';
      if (idx < 0 || idx >= op.additionalExecutors.length) return;
      op.additionalExecutors[idx] = value;
      if (prev !== value) {
        recordCardLog(card, { action: 'Доп. исполнитель', object: opLogLabel(op), field: 'additionalExecutors', targetId: op.id, oldValue: prev, newValue: value });
        saveData();
        renderDashboard();
      }
    });
  });

  wrapper.querySelectorAll('.qty-input').forEach(input => {
    const cardId = input.getAttribute('data-card-id');
    const opId = input.getAttribute('data-op-id');
    const type = input.getAttribute('data-qty-type');
    const card = cards.find(c => c.id === cardId);
    const op = card ? (card.operations || []).find(o => o.id === opId) : null;
    if (!op || !card) return;

    input.addEventListener('input', e => {
      e.target.value = toSafeCount(e.target.value);
    });

    input.addEventListener('blur', e => {
      const val = toSafeCount(e.target.value);
      const fieldMap = { good: 'goodCount', scrap: 'scrapCount', hold: 'holdCount' };
      const field = fieldMap[type] || null;
      if (!field) return;
      const prev = toSafeCount(op[field] || 0);
      if (prev === val) return;
      op[field] = val;
      recordCardLog(card, { action: 'Количество деталей', object: opLogLabel(op), field, targetId: op.id, oldValue: prev, newValue: val });
      saveData();
      renderDashboard();
    });
  });

  wrapper.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-action');
      const cardId = btn.getAttribute('data-card-id');
      const opId = btn.getAttribute('data-op-id');
      const card = cards.find(c => c.id === cardId);
      if (!card) return;
      const op = (card.operations || []).find(o => o.id === opId);
      if (!op) return;
      const detail = btn.closest('.wo-card');
      if (detail && detail.open) {
        workorderOpenCards.add(cardId);
      }

      const prevStatus = op.status;
      const prevElapsed = op.elapsedSeconds || 0;
      const prevCardStatus = card.status;

      if (action === 'start') {
        const now = Date.now();
        if (!op.firstStartedAt) op.firstStartedAt = now;
        op.status = 'IN_PROGRESS';
        op.startedAt = now;
        op.lastPausedAt = null;
        op.finishedAt = null;
        op.actualSeconds = null;
        op.elapsedSeconds = 0;
      } else if (action === 'pause') {
        if (op.status === 'IN_PROGRESS') {
          const now = Date.now();
          const diff = op.startedAt ? (now - op.startedAt) / 1000 : 0;
          op.elapsedSeconds = (op.elapsedSeconds || 0) + diff;
          op.lastPausedAt = now;
          op.startedAt = null;
          op.status = 'PAUSED';
        }
      } else if (action === 'resume') {
        const now = Date.now();
        if (op.status === 'DONE' && typeof op.elapsedSeconds !== 'number') {
          op.elapsedSeconds = op.actualSeconds || 0;
        }
        if (!op.firstStartedAt) op.firstStartedAt = now;
        op.status = 'IN_PROGRESS';
        op.startedAt = now;
        op.lastPausedAt = null;
        op.finishedAt = null;
      } else if (action === 'stop') {
        const now = Date.now();
        if (op.status === 'IN_PROGRESS') {
          const diff = op.startedAt ? (now - op.startedAt) / 1000 : 0;
          op.elapsedSeconds = (op.elapsedSeconds || 0) + diff;
        }
        const qtyTotal = getOperationQuantity(op, card);
        if (qtyTotal > 0) {
          const sum = toSafeCount(op.goodCount || 0) + toSafeCount(op.scrapCount || 0) + toSafeCount(op.holdCount || 0);
          if (sum !== qtyTotal) {
            alert('Количество деталей не совпадает');
            return;
          }
        }
        op.startedAt = null;
        op.finishedAt = now;
        op.lastPausedAt = null;
        op.actualSeconds = op.elapsedSeconds || 0;
        op.status = 'DONE';
      }

      recalcCardStatus(card);
      if (prevStatus !== op.status) {
        recordCardLog(card, { action: 'Статус операции', object: opLogLabel(op), field: 'status', targetId: op.id, oldValue: prevStatus, newValue: op.status });
      }
      if (prevElapsed !== op.elapsedSeconds && op.status === 'DONE') {
        recordCardLog(card, { action: 'Факт. время', object: opLogLabel(op), field: 'elapsedSeconds', targetId: op.id, oldValue: Math.round(prevElapsed), newValue: Math.round(op.elapsedSeconds || 0) });
      }
      if (prevCardStatus !== card.status) {
        recordCardLog(card, { action: 'Статус карты', object: 'Карта', field: 'status', oldValue: prevCardStatus, newValue: card.status });
      }
      saveData();
      renderEverything();
    });
  });
}

function renderArchiveTable() {
  const wrapper = document.getElementById('archive-table-wrapper');
  const archivedCards = cards.filter(c => c.archived && c.operations && c.operations.length);
  if (!archivedCards.length) {
    wrapper.innerHTML = '<p>В архиве пока нет карт.</p>';
    return;
  }

  const termRaw = archiveSearchTerm.trim();
  const contractTerm = archiveContractTerm.trim().toLowerCase();
  const filteredByStatus = archivedCards.filter(card => {
    const state = getCardProcessState(card);
    return archiveStatusFilter === 'ALL' || state.key === archiveStatusFilter;
  });

  if (!filteredByStatus.length) {
    wrapper.innerHTML = '<p>Нет архивных карт, удовлетворяющих фильтру.</p>';
    return;
  }

  let sortedCards = [...filteredByStatus];
  if (termRaw) {
    sortedCards.sort((a, b) => cardSearchScore(b, termRaw) - cardSearchScore(a, termRaw));
  }

  const filteredBySearch = termRaw
    ? sortedCards.filter(card => cardSearchScore(card, termRaw) > 0)
    : sortedCards;

  const filteredByContract = contractTerm
    ? filteredBySearch.filter(card => (card.contractNumber || '').toLowerCase().includes(contractTerm))
    : filteredBySearch;

  if (!filteredByContract.length) {
    wrapper.innerHTML = '<p>Архивные карты по запросу не найдены.</p>';
    return;
  }

  let html = '';
  filteredByContract.forEach(card => {
    const stateBadge = renderCardStateBadge(card);
    const filesCount = (card.attachments || []).length;
    const barcodeInline = card.barcode
      ? ' • № карты: <span class="summary-barcode">' + escapeHtml(card.barcode) + ' <button type="button" class="btn-small btn-secondary wo-barcode-btn" data-card-id="' + card.id + '">Штрихкод</button></span>'
      : '';
    const contractText = card.contractNumber ? ' (Договор: ' + escapeHtml(card.contractNumber) + ')' : '';
    const filesButton = ' <button type="button" class="btn-small clip-btn inline-clip" data-attach-card="' + card.id + '">📎 <span class="clip-count">' + filesCount + '</span></button>';
    const logButton = ' <button type="button" class="btn-small btn-secondary log-btn" data-log-card="' + card.id + '">Log</button>';

    html += '<details class="wo-card">' +
      '<summary>' +
      '<div class="summary-line">' +
      '<div class="summary-text">' +
      '<strong>' + escapeHtml(card.name || card.id) + '</strong>' +
      ' <span class="summary-sub">' +
      (card.orderNo ? ' (Заказ: ' + escapeHtml(card.orderNo) + ')' : '') + contractText +
      barcodeInline + filesButton + logButton +
      '</span>' +
      '</div>' +
      '<div class="summary-actions">' +
      ' ' + stateBadge +
      ' <button type="button" class="btn-small btn-secondary repeat-card-btn" data-card-id="' + card.id + '">Повторить</button>' +
      '</div>' +
      '</div>' +
      '</summary>';

    html += buildCardInfoBlock(card);
    html += buildOperationsTable(card, { readonly: true });
    html += '</details>';
  });

  wrapper.innerHTML = html;

  wrapper.querySelectorAll('.wo-barcode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-card-id');
      const card = cards.find(c => c.id === id);
      if (!card) return;
      openBarcodeModal(card);
    });
  });

  wrapper.querySelectorAll('button[data-attach-card]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute('data-attach-card');
      openAttachmentsModal(id, 'live');
    });
  });

  wrapper.querySelectorAll('.log-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute('data-log-card');
      openLogModal(id);
    });
  });

  wrapper.querySelectorAll('.repeat-card-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-card-id');
      const card = cards.find(c => c.id === id);
      if (!card) return;
      const cloneOps = (card.operations || []).map(op => ({
        ...op,
        id: genId('rop'),
        status: 'NOT_STARTED',
        startedAt: null,
        finishedAt: null,
        actualSeconds: null,
        elapsedSeconds: 0,
        comment: ''
      }));
      const newCard = {
        ...card,
        id: genId('card'),
        barcode: generateUniqueEAN13(),
        name: (card.name || '') + ' (копия)',
        status: 'NOT_STARTED',
        archived: false,
        attachments: (card.attachments || []).map(file => ({
          ...file,
          id: genId('file'),
          createdAt: Date.now()
        })),
        operations: cloneOps
      };
      recalcCardStatus(newCard);
      cards.push(newCard);
      saveData();
      renderEverything();
    });
  });
}

// === ТАЙМЕР ===
function tickTimers() {
  const rows = getAllRouteRows().filter(r => r.op.status === 'IN_PROGRESS' && r.op.startedAt);
  rows.forEach(row => {
    const card = row.card;
    const op = row.op;
    const rowId = card.id + '::' + op.id;
    const span = document.querySelector('.wo-timer[data-row-id="' + rowId + '"]');
    if (span) {
      const elapsedSec = getOperationElapsedSeconds(op);
      span.textContent = formatSecondsToHMS(elapsedSec);
    }
  });

  renderDashboard();
}

// === НАВИГАЦИЯ ===
function setupNavigation() {
  const navButtons = document.querySelectorAll('.nav-btn');
  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target');
      if (!target) return;

      document.querySelectorAll('main section').forEach(sec => {
        sec.classList.remove('active');
      });
      const section = document.getElementById(target);
      if (section) {
        section.classList.add('active');
      }

      navButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (target === 'workorders') {
        renderWorkordersTable({ collapseAll: true });
      } else if (target === 'archive') {
        renderArchiveTable();
      }
    });
  });
}

function setupCardsTabs() {
  const tabButtons = document.querySelectorAll('.subtab-btn[data-cards-tab]');
  const panels = {
    list: document.getElementById('cards-list-panel'),
    directory: document.getElementById('cards-directory-panel')
  };

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-cards-tab');
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      Object.entries(panels).forEach(([key, panel]) => {
        if (panel) panel.classList.toggle('hidden', key !== target);
      });
    });
  });
}

// === ФОРМЫ ===
function setupForms() {
  document.getElementById('btn-new-card').addEventListener('click', () => {
    openCardModal();
  });

  const cardForm = document.getElementById('card-form');
  if (cardForm) {
    cardForm.addEventListener('submit', e => e.preventDefault());
  }

  const saveBtn = document.getElementById('card-save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      if (!activeCardDraft) return;
      syncCardDraftFromForm();
      document.getElementById('card-status-text').textContent = cardStatusText(activeCardDraft);
      saveCardDraft();
    });
  }

  const printDraftBtn = document.getElementById('card-print-btn');
  if (printDraftBtn) {
    printDraftBtn.addEventListener('click', () => {
      if (!activeCardDraft) return;
      syncCardDraftFromForm();
      printCardView(activeCardDraft, { blankQuantities: true });
    });
  }

  const cancelBtn = document.getElementById('card-cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      closeCardModal();
    });
  }

  document.getElementById('route-form').addEventListener('submit', e => {
    e.preventDefault();
    if (!activeCardDraft) return;
    const opId = document.getElementById('route-op').value;
    const centerId = document.getElementById('route-center').value;
    const executor = document.getElementById('route-executor').value.trim();
    const planned = parseInt(document.getElementById('route-planned').value, 10) || 30;
    const codeValue = document.getElementById('route-op-code').value.trim();
    const qtyInput = document.getElementById('route-qty').value.trim();
    const qtyValue = qtyInput === '' ? activeCardDraft.quantity : qtyInput;
    const opRef = ops.find(o => o.id === opId);
    const centerRef = centers.find(c => c.id === centerId);
    if (!opRef || !centerRef) return;
    const maxOrder = activeCardDraft.operations && activeCardDraft.operations.length
      ? Math.max.apply(null, activeCardDraft.operations.map(o => o.order || 0))
      : 0;
    const rop = createRouteOpFromRefs(opRef, centerRef, executor, planned, maxOrder + 1, {
      code: codeValue,
      autoCode: !codeValue,
      quantity: qtyValue
    });
    activeCardDraft.operations = activeCardDraft.operations || [];
    activeCardDraft.operations.push(rop);
    renumberAutoCodesForCard(activeCardDraft);
    document.getElementById('card-status-text').textContent = cardStatusText(activeCardDraft);
    renderRouteTableDraft();
    document.getElementById('route-form').reset();
    const qtyField = document.getElementById('route-qty');
    if (qtyField) qtyField.value = activeCardDraft.quantity !== '' ? activeCardDraft.quantity : '';
    fillRouteSelectors();
  });

  document.getElementById('center-form').addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('center-name').value.trim();
    const desc = document.getElementById('center-desc').value.trim();
    if (!name) return;
    centers.push({ id: genId('wc'), name: name, desc: desc });
    saveData();
    renderCentersTable();
    fillRouteSelectors();
    e.target.reset();
  });

      document.getElementById('op-form').addEventListener('submit', e => {
        e.preventDefault();
        const name = document.getElementById('op-name').value.trim();
        const desc = document.getElementById('op-desc').value.trim();
        const time = parseInt(document.getElementById('op-time').value, 10) || 30;
        if (!name) return;
        const used = collectUsedOpCodes();
        const code = generateUniqueOpCode(used);
        ops.push({ id: genId('op'), code, name: name, desc: desc, recTime: time });
        saveData();
        renderOpsTable();
        fillRouteSelectors();
        e.target.reset();
      });

  const cardsSearchInput = document.getElementById('cards-search');
  const cardsSearchClear = document.getElementById('cards-search-clear');
  if (cardsSearchInput) {
    cardsSearchInput.addEventListener('input', e => {
      cardsSearchTerm = e.target.value || '';
      renderCardsTable();
    });
  }
  if (cardsSearchClear) {
    cardsSearchClear.addEventListener('click', () => {
      cardsSearchTerm = '';
      if (cardsSearchInput) cardsSearchInput.value = '';
      renderCardsTable();
    });
  }

  const searchInput = document.getElementById('workorder-search');
  const searchClearBtn = document.getElementById('workorder-search-clear');
  const statusSelect = document.getElementById('workorder-status');
  const contractInput = document.getElementById('workorder-contract');
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      workorderSearchTerm = e.target.value || '';
      renderWorkordersTable({ collapseAll: true });
    });
  }
  if (contractInput) {
    contractInput.addEventListener('input', e => {
      workorderContractTerm = e.target.value || '';
      renderWorkordersTable({ collapseAll: true });
    });
  }
  if (searchClearBtn) {
    searchClearBtn.addEventListener('click', () => {
      workorderSearchTerm = '';
      if (searchInput) searchInput.value = '';
      workorderContractTerm = '';
      if (contractInput) contractInput.value = '';
      if (statusSelect) statusSelect.value = 'ALL';
      workorderStatusFilter = 'ALL';
      renderWorkordersTable({ collapseAll: true });
    });
  }

  if (statusSelect) {
    statusSelect.addEventListener('change', e => {
      workorderStatusFilter = e.target.value || 'ALL';
      renderWorkordersTable({ collapseAll: true });
    });
  }

  const archiveSearchInput = document.getElementById('archive-search');
  const archiveSearchClear = document.getElementById('archive-search-clear');
  const archiveStatusSelect = document.getElementById('archive-status');
  const archiveContractInput = document.getElementById('archive-contract');
  if (archiveSearchInput) {
    archiveSearchInput.addEventListener('input', e => {
      archiveSearchTerm = e.target.value || '';
      renderArchiveTable();
    });
  }
  if (archiveContractInput) {
    archiveContractInput.addEventListener('input', e => {
      archiveContractTerm = e.target.value || '';
      renderArchiveTable();
    });
  }
  if (archiveStatusSelect) {
    archiveStatusSelect.addEventListener('change', e => {
      archiveStatusFilter = e.target.value || 'ALL';
      renderArchiveTable();
    });
  }
  if (archiveSearchClear) {
    archiveSearchClear.addEventListener('click', () => {
      archiveSearchTerm = '';
      if (archiveSearchInput) archiveSearchInput.value = '';
      archiveContractTerm = '';
      if (archiveContractInput) archiveContractInput.value = '';
      archiveStatusFilter = 'ALL';
      if (archiveStatusSelect) archiveStatusSelect.value = 'ALL';
      renderArchiveTable();
    });
  }
}

// === ОБЩИЙ РЕНДЕР ===
function renderEverything() {
  renderDashboard();
  renderCardsTable();
  renderCentersTable();
  renderOpsTable();
  fillRouteSelectors();
  renderWorkordersTable();
  renderArchiveTable();
}

function setupAttachmentControls() {
  const modal = document.getElementById('attachments-modal');
  const closeBtn = document.getElementById('attachments-close');
  const addBtn = document.getElementById('attachments-add-btn');
  const input = document.getElementById('attachments-input');
  const cardBtn = document.getElementById('card-attachments-btn');

  if (closeBtn) {
    closeBtn.addEventListener('click', () => closeAttachmentsModal());
  }
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeAttachmentsModal();
    });
  }
  if (addBtn && input) {
    addBtn.addEventListener('click', () => input.click());
    input.addEventListener('change', (e) => {
      addAttachmentsFromFiles(e.target.files);
      input.value = '';
    });
  }
  if (cardBtn) {
    cardBtn.addEventListener('click', () => {
      if (!activeCardDraft) return;
      openAttachmentsModal(activeCardDraft.id, 'draft');
    });
  }
}

// === ИНИЦИАЛИЗАЦИЯ ===
document.addEventListener('DOMContentLoaded', async () => {
  startRealtimeClock();
  await loadData();
  setupNavigation();
  setupCardsTabs();
  setupForms();
  setupBarcodeModal();
  setupAttachmentControls();
  setupLogModal();
  renderEverything();
  setInterval(tickTimers, 1000);
});
