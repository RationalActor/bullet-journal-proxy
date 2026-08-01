// ---------- tiny date helpers (always LOCAL time, never UTC) ----------
function pad(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function timeStr(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function today() { return dateStr(new Date()); }
function slugify(s) { return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function uid() { return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2)); }

// ---------- IndexedDB ----------
let db;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('bulletJournalDB', 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('entries')) {
        const s = d.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!d.objectStoreNames.contains('habits')) {
        d.createObjectStore('habits', { keyPath: 'id' });
      }
      // legacy store from v1 (one aggregate value per habit per day) - no longer written to,
      // kept only so old installs don't error; superseded by habitOccurrences below.
      if (!d.objectStoreNames.contains('habitLogs')) {
        const s = d.createObjectStore('habitLogs', { keyPath: 'id' });
        s.createIndex('habitDate', ['habitId', 'date'], { unique: true });
        s.createIndex('date', 'date');
      }
      // v2: each tap is its own timestamped occurrence, same shape as a journal entry.
      if (!d.objectStoreNames.contains('habitOccurrences')) {
        const s = d.createObjectStore('habitOccurrences', { keyPath: 'id' });
        s.createIndex('date', 'date');
        s.createIndex('habitId', 'habitId');
      }
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) { return db.transaction(store, mode).objectStore(store); }
function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function put(store, obj) { return reqToPromise(tx(store, 'readwrite').put(obj)); }
function del(store, id) { return reqToPromise(tx(store, 'readwrite').delete(id)); }
function getAll(store) { return reqToPromise(tx(store, 'readonly').getAll()); }
function getAllByIndex(store, index, range) {
  return reqToPromise(tx(store, 'readonly').index(index).getAll(range));
}

// ---------- settings (localStorage — tiny, no need for IndexedDB) ----------
const Settings = {
  get url() { return localStorage.getItem('bj_url') || ''; },
  set url(v) { localStorage.setItem('bj_url', v); },
  get secret() { return localStorage.getItem('bj_secret') || ''; },
  set secret(v) { localStorage.setItem('bj_secret', v); },
  get lastSync() { return localStorage.getItem('bj_lastSync') || ''; },
  set lastSync(v) { localStorage.setItem('bj_lastSync', v); },
};

// ---------- markdown formatting (matches the existing repo convention) ----------
function entryToMarkdown(e) {
  let fm = `---\ntype: ${e.type}\ntimestamp: ${e.date}T${e.time}\nreviewed: true\n`;
  if (e.type === 'task') fm += `done: ${!!e.done}\n`;
  if (e.type === 'gratitude' && e.prompt) fm += `prompt: "${e.prompt.replace(/"/g, '\\"')}"\n`;
  fm += `---\n${e.content}\n`;
  return fm;
}
function entryFilename(e) { return `${e.time.replace(/:/g, '-')}.md`; }

function habitOccToMarkdown(occ, habit) {
  return `---\ntype: habit\nhabit_name: ${habit.name}\ndirection: ${habit.direction}\nvalue: ${occ.value}\ntimestamp: ${occ.date}T${occ.time}\n---\n${habit.name}: ${occ.value}\n`;
}
function habitOccFilename(occ, habit) {
  return `${occ.time.replace(/:/g, '-')}-habit-${slugify(habit.name)}.md`;
}

// ---------- sync ----------
async function syncOne({ store, record, dateForPath, filename, markdown }) {
  const headers = { 'Content-Type': 'application/json', 'x-app-secret': Settings.secret };
  const base = Settings.url.replace(/\/$/, '');
  try {
    if (record.remotePath) {
      const resp = await fetch(`${base}/api/entries`, {
        method: 'PUT', headers,
        body: JSON.stringify({ path: record.remotePath, content: markdown }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ? JSON.stringify(data.error) : resp.statusText);
    } else {
      const resp = await fetch(`${base}/api/entries`, {
        method: 'POST', headers,
        body: JSON.stringify({ date: dateForPath, filename, content: markdown }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ? JSON.stringify(data.error) : resp.statusText);
      record.remotePath = data.path;
    }
    record.dirty = false;
    await put(store, record);
    return true;
  } catch (err) {
    console.error('sync failed for', store, record.id, err);
    return false;
  }
}

async function syncAll() {
  const statusEl = document.getElementById('syncStatus');
  if (!Settings.url || !Settings.secret) {
    statusEl.textContent = 'Add your proxy URL and app secret above, then save, before syncing.';
    return;
  }
  statusEl.textContent = 'Syncing…';

  const [entries, habits, habitOccs] = await Promise.all([getAll('entries'), getAll('habits'), getAll('habitOccurrences')]);
  const habitById = Object.fromEntries(habits.map(h => [h.id, h]));

  const dirtyEntries = entries.filter(e => e.dirty);
  const dirtyOccs = habitOccs.filter(o => o.dirty && habitById[o.habitId]);

  let okCount = 0, failCount = 0;

  for (const e of dirtyEntries) {
    const ok = await syncOne({ store: 'entries', record: e, dateForPath: e.date, filename: entryFilename(e), markdown: entryToMarkdown(e) });
    ok ? okCount++ : failCount++;
  }
  for (const o of dirtyOccs) {
    const habit = habitById[o.habitId];
    const ok = await syncOne({ store: 'habitOccurrences', record: o, dateForPath: o.date, filename: habitOccFilename(o, habit), markdown: habitOccToMarkdown(o, habit) });
    ok ? okCount++ : failCount++;
  }

  Settings.lastSync = new Date().toLocaleString();
  renderSyncStatus();
  if (failCount > 0) {
    statusEl.textContent += ` Done, but ${failCount} item(s) couldn't sync (no connection?) — they'll retry next time.`;
  }
  renderActiveTab();
}

async function renderSyncStatus() {
  const [entries, habitOccs] = await Promise.all([getAll('entries'), getAll('habitOccurrences')]);
  const pending = entries.filter(e => e.dirty).length + habitOccs.filter(o => o.dirty).length;
  const el = document.getElementById('syncStatus');
  el.textContent = `Last synced: ${Settings.lastSync || 'never'}. Pending: ${pending} item(s).`;
}

// ---------- shared helpers ----------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const SYMBOLS = { note: '•', event: '○', task: '▢' };
const PLACEHOLDERS = { note: 'Jot a note…', event: 'What happened…', task: 'What needs doing…' };

// ---------- shared: add row (note/event/task/habit) ----------
let addMode = 'note'; // note | event | task | habit

async function renderAddRow(container, targetDate) {
  const habits = await getAll('habits');
  const now = new Date();
  container.innerHTML = `
    <div class="add-row">
      <div class="add-row-meta">
        <input type="date" class="meta-input" id="addDate-${targetDate}" value="${targetDate}" />
        <input type="time" class="meta-input" id="addTime-${targetDate}" value="${pad(now.getHours())}:${pad(now.getMinutes())}" step="1" />
      </div>
      <div class="add-row-main">
        <div class="symbol-toggle">
          <button class="symbol-btn" data-sym="note">\u2022</button>
          <button class="symbol-btn" data-sym="event">\u25cb</button>
          <button class="symbol-btn" data-sym="task">\u25a2</button>
          <button class="symbol-btn" data-sym="habit">\u21dd</button>
        </div>
        <div class="input-area" id="addInputArea-${targetDate}"></div>
      </div>
    </div>`;

  const buttons = container.querySelectorAll('.symbol-btn');
  const inputArea = container.querySelector(`#addInputArea-${targetDate}`);
  const dateInput = container.querySelector(`#addDate-${targetDate}`);
  const timeInput = container.querySelector(`#addTime-${targetDate}`);

  function chosenDateTime() {
    const d = dateInput.value || targetDate;
    let t = timeInput.value || `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    if (t.length === 5) t += ':00'; // HH:MM -> HH:MM:SS
    return { date: d, time: t };
  }

  function renderInputArea() {
    if (addMode === 'habit') {
      const active = habits.filter(h => !h.archived);
      if (active.length === 0) {
        inputArea.innerHTML = `<div class="hint" style="padding:8px 4px;">No habits yet \u2014 add one in the Habits tab first.</div>`;
        return;
      }
      inputArea.innerHTML = `<div class="habit-chip-row">${active.map(h =>
        `<button class="habit-chip" data-habit="${h.id}">${escapeHtml(h.name)}</button>`
      ).join('')}</div>`;
      inputArea.querySelectorAll('.habit-chip').forEach(chip => {
        chip.addEventListener('click', async () => {
          const habitId = chip.dataset.habit;
          const { date, time } = chosenDateTime();
          await put('habitOccurrences', {
            id: uid(), habitId, date, time,
            value: 1, dirty: true, remotePath: null,
          });
          renderActiveTab();
        });
      });
    } else {
      inputArea.innerHTML = `
        <div class="text-input-row">
          <input type="text" placeholder="${PLACEHOLDERS[addMode] || 'Write it down\u2026'}" id="addInput-${targetDate}" />
          <button class="add-btn" id="addBtn-${targetDate}">+</button>
        </div>`;
      const input = inputArea.querySelector(`#addInput-${targetDate}`);
      const addBtn = inputArea.querySelector(`#addBtn-${targetDate}`);
      async function submit() {
        const text = input.value.trim();
        if (!text) return;
        const { date, time } = chosenDateTime();
        const entry = {
          id: uid(), date, time, type: addMode,
          content: text, done: false, dirty: true, remotePath: null,
        };
        await put('entries', entry);
        input.value = '';
        renderActiveTab();
      }
      addBtn.addEventListener('click', submit);
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });
    }
  }

  function setActive(sym) {
    addMode = sym;
    buttons.forEach(b => b.classList.toggle('active', b.dataset.sym === sym));
    renderInputArea();
  }
  setActive(addMode);
  buttons.forEach(b => b.addEventListener('click', () => setActive(b.dataset.sym)));
}

// ---------- shared: entry list, now interleaving habit occurrences by time ----------
async function renderEntryList(container, targetDate) {
  const range = IDBKeyRange.only(targetDate);
  const [rawEntries, habitOccs, habits] = await Promise.all([
    getAllByIndex('entries', 'date', range),
    getAllByIndex('habitOccurrences', 'date', range),
    getAll('habits'),
  ]);
  const entries = rawEntries.filter(e => e.type !== 'gratitude'); // gratitude lives in its own tab
  const habitById = Object.fromEntries(habits.map(h => [h.id, h]));

  const rows = [
    ...entries.map(e => ({ kind: 'entry', time: e.time, data: e })),
    ...habitOccs.filter(o => habitById[o.habitId]).map(o => ({ kind: 'habit', time: o.time, data: o, habit: habitById[o.habitId] })),
  ].sort((a, b) => a.time.localeCompare(b.time));

  if (rows.length === 0) {
    container.innerHTML = `<div class="empty-state">Nothing logged yet — the page is waiting.</div>`;
    return;
  }

  container.innerHTML = rows.map(r => {
    if (r.kind === 'entry') {
      const e = r.data;
      return `
        <div class="entry-row" data-id="${e.id}">
          <div class="entry-symbol" data-id="${e.id}">${e.type === 'task' ? (e.done ? '✓' : '▢') : SYMBOLS[e.type]}</div>
          <div>
            <div class="entry-content ${e.type === 'task' && e.done ? 'done' : ''}">${escapeHtml(e.content)}</div>
            <div class="entry-time">${e.time.slice(0, 5)}</div>
          </div>
          <button class="entry-del" data-del="${e.id}">×</button>
        </div>`;
    }
    const occ = r.data, habit = r.habit;
    const isCount = habit.trackingType === 'count';
    const label = isCount && occ.value > 1 ? `${habit.name} ×${occ.value}` : habit.name;
    return `
      <div class="entry-row habit-row" data-occ="${occ.id}">
        <div class="habit-symbol">✓</div>
        <div>
          <div class="entry-content habit-content">${escapeHtml(label)}</div>
          <div class="entry-time">${occ.time.slice(0, 5)} · habit</div>
        </div>
        <button class="entry-del" data-delhabit="${occ.id}">×</button>
      </div>`;
  }).join('');

  container.querySelectorAll('.entry-symbol').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.dataset.id;
      const entry = entries.find(e => e.id === id);
      if (!entry || entry.type !== 'task') return;
      entry.done = !entry.done;
      entry.dirty = true;
      el.classList.add('tapped');
      await put('entries', entry);
      renderActiveTab();
    });
  });
  container.querySelectorAll('[data-del]').forEach(el => {
    el.addEventListener('click', async () => {
      await del('entries', el.dataset.del);
      renderActiveTab();
    });
  });
  container.querySelectorAll('[data-delhabit]').forEach(el => {
    el.addEventListener('click', async () => {
      await del('habitOccurrences', el.dataset.delhabit);
      renderActiveTab();
    });
  });
}

// ---------- Today tab ----------
async function renderTodayTab() {
  await renderAddRow(document.getElementById('today-add-slot'), today());
  await renderEntryList(document.getElementById('today-list-slot'), today());
  await renderGratitudeNudge();
}

async function renderGratitudeNudge() {
  const slot = document.getElementById('today-gratitude-nudge-slot');
  const range = IDBKeyRange.only(today());
  const todaysEntries = await getAllByIndex('entries', 'date', range);
  const hasGratitude = todaysEntries.some(e => e.type === 'gratitude');
  if (hasGratitude) { slot.innerHTML = ''; return; }
  slot.innerHTML = `<button class="gratitude-nudge" id="gratitudeNudgeBtn">♡ Gratitude — not logged today →</button>`;
  document.getElementById('gratitudeNudgeBtn').addEventListener('click', () => {
    activeTab = 'gratitude';
    gratitudeSeg = 'write';
    renderActiveTab();
  });
}

// ---------- Habits tab (read-only aggregate report; logging happens in Today/Month) ----------
let habitFormOpen = false;

function habitFormHtml() {
  return `
    <div class="inline-form" id="habitForm" data-tracking="check">
      <input type="text" placeholder="Habit name" id="habitName" />
      <div class="row">
        <button type="button" class="track-btn active" data-track="check">Check off</button>
        <button type="button" class="track-btn" data-track="count">Count</button>
      </div>
      <input type="number" min="1" placeholder="Daily goal (optional)" id="habitTarget" style="display:none" />
      <div class="form-actions">
        <button class="save" id="habitSave">Add</button>
        <button id="habitCancel">Cancel</button>
      </div>
    </div>`;
}

async function renderHabitsTab() {
  const habits = (await getAll('habits')).filter(h => !h.archived);

  const last7 = [...Array(7)].map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return dateStr(d);
  });

  const allOccs = await getAll('habitOccurrences');
  const sumMap = {}; // habitId -> date -> summed value
  allOccs.forEach(o => {
    sumMap[o.habitId] = sumMap[o.habitId] || {};
    sumMap[o.habitId][o.date] = (sumMap[o.habitId][o.date] || 0) + o.value;
  });

  function streakRow(habit) {
    const trackingType = habit.trackingType || 'check';
    return `<div class="streak-row">${last7.map(d => {
      const v = (sumMap[habit.id] || {})[d] || 0;
      const filled = (trackingType === 'count' && habit.target) ? v >= habit.target : v > 0;
      const isToday = d === today();
      const showNumber = trackingType === 'count' && v > 0;
      return `<div class="streak-dot ${filled ? 'filled' : ''} ${isToday ? 'today' : ''}">${showNumber ? v : ''}</div>`;
    }).join('')}</div>`;
  }

  function todayLabel(habit) {
    const v = (sumMap[habit.id] || {})[today()] || 0;
    const trackingType = habit.trackingType || 'check';
    if (trackingType === 'count') return `${v}${habit.target ? '/' + habit.target : ''} today`;
    return v > 0 ? 'Done today' : 'Not yet today';
  }

  const listEl = document.getElementById('habit-list');
  listEl.innerHTML = (habitFormOpen ? habitFormHtml() : '') + (habits.map(h => `
      <div class="habit-card">
        <div class="habit-top">
          <div class="habit-name">${escapeHtml(h.name)}</div>
          <div class="habit-today-total">${todayLabel(h)}</div>
        </div>
        ${streakRow(h)}
      </div>`).join('') || (habitFormOpen ? '' : '<div class="empty-state">No habits yet.</div>'));

  const formEl = document.getElementById('habitForm');
  if (formEl) {
    formEl.querySelectorAll('.track-btn').forEach(b => {
      b.addEventListener('click', () => {
        formEl.querySelectorAll('.track-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        formEl.dataset.tracking = b.dataset.track;
        const targetInput = document.getElementById('habitTarget');
        if (targetInput) targetInput.style.display = b.dataset.track === 'count' ? 'block' : 'none';
      });
    });

    document.getElementById('habitSave').addEventListener('click', async () => {
      const name = document.getElementById('habitName').value.trim();
      if (!name) return;
      const trackingType = formEl.dataset.tracking || 'check';
      let target = null;
      if (trackingType === 'count') {
        const t = document.getElementById('habitTarget').value;
        target = t ? parseInt(t, 10) : null;
      }
      await put('habits', { id: uid(), name, trackingType, target, archived: false });
      habitFormOpen = false;
      renderActiveTab();
    });
    document.getElementById('habitCancel').addEventListener('click', () => { habitFormOpen = false; renderActiveTab(); });
  }
}

document.getElementById('addHabitBtn').addEventListener('click', () => { habitFormOpen = true; renderActiveTab(); });

// ---------- Gratitude tab ----------
const GRATITUDE_PROMPTS = [
  'What surprised you today?',
  'Who are you grateful for right now, and why?',
  'What would today have been like without something you\u2019re glad you had?',
  'What\u2019s something small that made today better?',
  'What\u2019s something you often take for granted?',
];

let gratitudeSeg = 'write';
let currentGratitudePrompt = null;

function pickPrompt(excluding) {
  const options = GRATITUDE_PROMPTS.filter(p => p !== excluding);
  const pool = options.length ? options : GRATITUDE_PROMPTS;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function renderGratitudeTab() {
  document.querySelectorAll('#gratitudeSegmented .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.seg === gratitudeSeg));
  document.getElementById('gratitude-write-slot').hidden = gratitudeSeg !== 'write';
  document.getElementById('gratitude-browse-slot').hidden = gratitudeSeg !== 'browse';
  if (gratitudeSeg === 'write') await renderGratitudeWrite();
  else await renderGratitudeBrowse();
}

document.querySelectorAll('#gratitudeSegmented .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => { gratitudeSeg = btn.dataset.seg; renderGratitudeTab(); });
});

async function renderGratitudeWrite() {
  const slot = document.getElementById('gratitude-write-slot');
  if (!currentGratitudePrompt) currentGratitudePrompt = pickPrompt();

  slot.innerHTML = `
    <div class="gratitude-prompt">${escapeHtml(currentGratitudePrompt)}</div>
    <textarea class="gratitude-textarea" id="gratitudeInput" placeholder="Write freely…"></textarea>
    <button class="primary-btn" id="gratitudeSaveBtn">Save</button>
    <button class="link-btn" id="gratitudeNewPromptBtn">Try a different prompt</button>`;

  document.getElementById('gratitudeNewPromptBtn').addEventListener('click', () => {
    currentGratitudePrompt = pickPrompt(currentGratitudePrompt);
    renderGratitudeWrite();
  });

  document.getElementById('gratitudeSaveBtn').addEventListener('click', async () => {
    const text = document.getElementById('gratitudeInput').value.trim();
    if (!text) return;
    const now = new Date();
    await put('entries', {
      id: uid(), date: today(), time: timeStr(now), type: 'gratitude',
      content: text, prompt: currentGratitudePrompt, done: false, dirty: true, remotePath: null,
    });
    currentGratitudePrompt = null;
    slot.innerHTML = `<div class="empty-state">Saved — thank you.</div><button class="link-btn" id="gratitudeAgainBtn">Write another</button>`;
    document.getElementById('gratitudeAgainBtn').addEventListener('click', renderGratitudeWrite);
  });
}

async function renderGratitudeBrowse() {
  const slot = document.getElementById('gratitude-browse-slot');
  const all = (await getAll('entries'))
    .filter(e => e.type === 'gratitude')
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));

  if (all.length === 0) {
    slot.innerHTML = `<div class="empty-state">Nothing written yet.</div>`;
    return;
  }

  slot.innerHTML = all.map(e => {
    const niceDate = new Date(e.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return `
      <div class="gratitude-card">
        <button class="entry-del" data-delgrat="${e.id}">×</button>
        <div class="gratitude-card-date">${niceDate}</div>
        ${e.prompt ? `<div class="gratitude-card-prompt">${escapeHtml(e.prompt)}</div>` : ''}
        <div class="gratitude-card-content">${escapeHtml(e.content)}</div>
      </div>`;
  }).join('');

  slot.querySelectorAll('[data-delgrat]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await del('entries', btn.dataset.delgrat);
      renderGratitudeBrowse();
    });
  });
}

// ---------- Month tab ----------
let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth(); // 0-indexed
let selectedDate = null;

async function renderMonthTab() {
  const label = new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  document.getElementById('monthLabel').textContent = label;

  const [allEntries, allOccs] = await Promise.all([getAll('entries'), getAll('habitOccurrences')]);
  const datesWithContent = new Set([...allEntries.map(e => e.date), ...allOccs.map(o => o.date)]);

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const startOffset = firstOfMonth.getDay(); // 0=Sun
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  const dow = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  let html = dow.map(d => `<div class="cal-dow">${d}</div>`).join('');
  for (let i = 0; i < startOffset; i++) html += `<div class="cal-day empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const dStr = `${viewYear}-${pad(viewMonth + 1)}-${pad(day)}`;
    const isToday = dStr === today();
    const isSelected = dStr === selectedDate;
    const hasContent = datesWithContent.has(dStr);
    html += `<div class="cal-day ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}" data-date="${dStr}">
      <span>${day}</span>${hasContent ? '<div class="cal-dot"></div>' : ''}
    </div>`;
  }
  document.getElementById('calGrid').innerHTML = html;

  document.querySelectorAll('.cal-day[data-date]').forEach(el => {
    el.addEventListener('click', () => {
      selectedDate = el.dataset.date;
      renderMonthTab();
    });
  });

  const detailEl = document.getElementById('dayDetail');
  if (selectedDate) {
    const niceDate = new Date(selectedDate + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    detailEl.innerHTML = `<h2>${niceDate}</h2><div id="month-add-slot"></div><div id="month-list-slot"></div>`;
    await renderAddRow(document.getElementById('month-add-slot'), selectedDate);
    await renderEntryList(document.getElementById('month-list-slot'), selectedDate);
  } else {
    detailEl.innerHTML = '';
  }
}

document.getElementById('prevMonthBtn').addEventListener('click', () => {
  viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  renderMonthTab();
});
document.getElementById('nextMonthBtn').addEventListener('click', () => {
  viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  renderMonthTab();
});

// ---------- Settings tab ----------
function renderSettingsTab() {
  document.getElementById('vercelUrl').value = Settings.url;
  document.getElementById('appSecret').value = Settings.secret;
  renderSyncStatus();
}
document.getElementById('saveSettingsBtn').addEventListener('click', () => {
  Settings.url = document.getElementById('vercelUrl').value.trim();
  Settings.secret = document.getElementById('appSecret').value.trim();
  renderSyncStatus();
});
document.getElementById('syncNowBtn').addEventListener('click', syncAll);

// ---------- tab switching ----------
const TAB_TITLES = {
  today: () => ['Today', new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })],
  habits: () => ['Habits', 'showing up, one day at a time'],
  month: () => ['Month', ''],
  gratitude: () => ['Gratitude', ''],
  settings: () => ['Settings', ''],
};
let activeTab = 'today';

function renderActiveTab() {
  document.querySelectorAll('.view').forEach(v => v.hidden = v.dataset.view !== activeTab);
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
  const [title, sub] = TAB_TITLES[activeTab]();
  document.getElementById('topbarTitle').textContent = title;
  document.getElementById('topbarSub').textContent = sub;

  if (activeTab === 'today') renderTodayTab();
  if (activeTab === 'habits') renderHabitsTab();
  if (activeTab === 'month') renderMonthTab();
  if (activeTab === 'gratitude') renderGratitudeTab();
  if (activeTab === 'settings') renderSettingsTab();
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => { activeTab = btn.dataset.tab; renderActiveTab(); });
});

// ---------- boot ----------
(async function init() {
  await openDB();
  renderActiveTab();
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW registration failed', e); }
  }
})();
