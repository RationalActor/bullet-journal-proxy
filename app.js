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
    const req = indexedDB.open('bulletJournalDB', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('entries')) {
        const s = d.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!d.objectStoreNames.contains('habits')) {
        d.createObjectStore('habits', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('habitLogs')) {
        const s = d.createObjectStore('habitLogs', { keyPath: 'id' });
        s.createIndex('habitDate', ['habitId', 'date'], { unique: true });
        s.createIndex('date', 'date');
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
  fm += `---\n${e.content}\n`;
  return fm;
}
function habitLogToMarkdown(log, habit) {
  return `---\ntype: habit\nhabit_name: ${habit.name}\ndirection: ${habit.direction}\nvalue: ${log.value}\ndate: ${log.date}\n---\n${habit.name}: ${log.value}\n`;
}
function entryFilename(e) { return `${e.time.replace(/:/g, '-')}.md`; }
function habitLogFilename(habit) { return `habit-${slugify(habit.name)}.md`; }

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

  const [entries, habits, habitLogs] = await Promise.all([getAll('entries'), getAll('habits'), getAll('habitLogs')]);
  const habitById = Object.fromEntries(habits.map(h => [h.id, h]));

  const dirtyEntries = entries.filter(e => e.dirty);
  const dirtyLogs = habitLogs.filter(l => l.dirty && habitById[l.habitId]);

  let okCount = 0, failCount = 0;

  for (const e of dirtyEntries) {
    const ok = await syncOne({ store: 'entries', record: e, dateForPath: e.date, filename: entryFilename(e), markdown: entryToMarkdown(e) });
    ok ? okCount++ : failCount++;
  }
  for (const l of dirtyLogs) {
    const habit = habitById[l.habitId];
    const ok = await syncOne({ store: 'habitLogs', record: l, dateForPath: l.date, filename: habitLogFilename(habit), markdown: habitLogToMarkdown(l, habit) });
    ok ? okCount++ : failCount++;
  }

  Settings.lastSync = new Date().toLocaleString();
  renderSyncStatus();
  if (failCount > 0) {
    statusEl.textContent += ` Done, but ${failCount} item(s) couldn't sync (no connection?) — they'll retry next time.`;
  }
  // re-render whatever's on screen so remotePath/dirty updates reflect
  renderActiveTab();
}

async function renderSyncStatus() {
  const [entries, habitLogs] = await Promise.all([getAll('entries'), getAll('habitLogs')]);
  const pending = entries.filter(e => e.dirty).length + habitLogs.filter(l => l.dirty).length;
  const el = document.getElementById('syncStatus');
  el.textContent = `Last synced: ${Settings.lastSync || 'never'}. Pending: ${pending} item(s).`;
}

// ---------- Today tab ----------
let todaySymbol = 'note'; // note | event | task
const SYMBOLS = { note: '•', event: '○', task: '▢' };

function renderAddRow(container, targetDate) {
  container.innerHTML = `
    <div class="add-row">
      <div class="symbol-toggle">
        <button class="symbol-btn" data-sym="note">•</button>
        <button class="symbol-btn" data-sym="event">○</button>
        <button class="symbol-btn" data-sym="task">▢</button>
      </div>
      <input type="text" placeholder="Write it down…" id="addInput-${targetDate}" />
      <button class="add-btn" id="addBtn-${targetDate}">+</button>
    </div>`;
  const buttons = container.querySelectorAll('.symbol-btn');
  function setActive(sym) {
    todaySymbol = sym;
    buttons.forEach(b => b.classList.toggle('active', b.dataset.sym === sym));
  }
  setActive(todaySymbol);
  buttons.forEach(b => b.addEventListener('click', () => setActive(b.dataset.sym)));

  const input = container.querySelector(`#addInput-${targetDate}`);
  const addBtn = container.querySelector(`#addBtn-${targetDate}`);
  async function submit() {
    const text = input.value.trim();
    if (!text) return;
    const now = new Date();
    const entry = {
      id: uid(),
      date: targetDate,
      time: timeStr(now),
      type: todaySymbol,
      content: text,
      done: false,
      dirty: true,
      remotePath: null,
    };
    await put('entries', entry);
    input.value = '';
    renderActiveTab();
  }
  addBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });
}

async function renderEntryList(container, targetDate) {
  const range = IDBKeyRange.only(targetDate);
  const entries = (await getAllByIndex('entries', 'date', range)).sort((a, b) => a.time.localeCompare(b.time));

  if (entries.length === 0) {
    container.innerHTML = `<div class="empty-state">Nothing logged yet — the page is waiting.</div>`;
    return;
  }

  container.innerHTML = entries.map(e => `
    <div class="entry-row" data-id="${e.id}">
      <div class="entry-symbol" data-id="${e.id}">${e.type === 'task' ? (e.done ? '✓' : '▢') : SYMBOLS[e.type]}</div>
      <div>
        <div class="entry-content ${e.type === 'task' && e.done ? 'done' : ''}">${escapeHtml(e.content)}</div>
        <div class="entry-time">${e.time.slice(0, 5)}</div>
      </div>
      <button class="entry-del" data-del="${e.id}">×</button>
    </div>
  `).join('');

  container.querySelectorAll('.entry-symbol').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.dataset.id;
      const entry = entries.find(e => e.id === id);
      if (entry.type !== 'task') return;
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
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function renderTodayTab() {
  renderAddRow(document.getElementById('today-add-slot'), today());
  await renderEntryList(document.getElementById('today-list-slot'), today());
}

// ---------- Habits tab ----------
let habitFormOpen = null; // 'boost' | 'diminish' | null

function habitFormHtml(direction) {
  const showTrackingChoice = direction === 'boost'; // diminish is always a count
  return `
    <div class="inline-form" id="habitForm-${direction}" data-tracking="check">
      <input type="text" placeholder="Habit name" id="habitName-${direction}" />
      ${showTrackingChoice ? `
      <div class="row">
        <button type="button" class="track-btn active" data-track="check">Check off</button>
        <button type="button" class="track-btn" data-track="count">Count</button>
      </div>
      <input type="number" min="1" placeholder="Daily goal (optional)" id="habitTarget-${direction}" style="display:none" />
      ` : ''}
      <div class="form-actions">
        <button class="save" id="habitSave-${direction}">Add</button>
        <button id="habitCancel-${direction}">Cancel</button>
      </div>
    </div>`;
}

async function renderHabitsTab() {
  const habits = await getAll('habits');
  const boostHabits = habits.filter(h => h.direction === 'boost' && !h.archived);
  const diminishHabits = habits.filter(h => h.direction === 'diminish' && !h.archived);

  const last7 = [...Array(7)].map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return dateStr(d);
  });

  const allLogs = await getAll('habitLogs');
  const logMap = {}; // habitId -> date -> value
  allLogs.forEach(l => {
    logMap[l.habitId] = logMap[l.habitId] || {};
    logMap[l.habitId][l.date] = l.value;
  });

  function streakRow(habit) {
    const trackingType = habit.direction === 'diminish' ? 'count' : (habit.trackingType || 'check');
    return `<div class="streak-row">${last7.map(d => {
      const v = (logMap[habit.id] || {})[d] || 0;
      const filled = (trackingType === 'count' && habit.direction === 'boost' && habit.target) ? v >= habit.target : v > 0;
      const isToday = d === today();
      const showNumber = trackingType === 'count' && v > 0;
      return `<div class="streak-dot ${filled ? 'filled ' + habit.direction : ''} ${isToday ? 'today' : ''}">${showNumber ? v : ''}</div>`;
    }).join('')}</div>`;
  }

  const boostListEl = document.getElementById('boost-list');
  boostListEl.innerHTML = (habitFormOpen === 'boost' ? habitFormHtml('boost') : '') + (boostHabits.map(h => {
    const val = (logMap[h.id] || {})[today()] || 0;
    const trackingType = h.trackingType || 'check';
    if (trackingType === 'count') {
      return `
        <div class="habit-card">
          <div class="habit-top">
            <div class="habit-name">${escapeHtml(h.name)}</div>
            <div class="stepper boost-stepper">
              <button data-step="-1" data-id="${h.id}">−</button>
              <div class="count">${val}${h.target ? '/' + h.target : ''}</div>
              <button data-step="1" data-id="${h.id}">+</button>
            </div>
          </div>
          ${streakRow(h)}
        </div>`;
    }
    const doneToday = val > 0;
    return `
      <div class="habit-card">
        <div class="habit-top">
          <div class="habit-name">${escapeHtml(h.name)}</div>
          <div class="habit-controls">
            <button class="habit-checkbox ${doneToday ? 'done' : ''}" data-toggle="${h.id}">${doneToday ? '✓' : ''}</button>
          </div>
        </div>
        ${streakRow(h)}
      </div>`;
  }).join('') || (habitFormOpen === 'boost' ? '' : '<div class="empty-state">No boost habits yet.</div>'));

  const diminishListEl = document.getElementById('diminish-list');
  diminishListEl.innerHTML = (habitFormOpen === 'diminish' ? habitFormHtml('diminish') : '') + (diminishHabits.map(h => {
    const countToday = (logMap[h.id] || {})[today()] || 0;
    return `
      <div class="habit-card">
        <div class="habit-top">
          <div class="habit-name">${escapeHtml(h.name)}</div>
          <div class="stepper">
            <button data-step="-1" data-id="${h.id}">−</button>
            <div class="count">${countToday}</div>
            <button data-step="1" data-id="${h.id}">+</button>
          </div>
        </div>
        ${streakRow(h)}
      </div>`;
  }).join('') || (habitFormOpen === 'diminish' ? '' : '<div class="empty-state">No diminish habits yet.</div>'));

  // wire up form(s)
  ['boost', 'diminish'].forEach(direction => {
    const formEl = document.getElementById(`habitForm-${direction}`);
    const save = document.getElementById(`habitSave-${direction}`);
    const cancel = document.getElementById(`habitCancel-${direction}`);

    if (direction === 'boost' && formEl) {
      formEl.querySelectorAll('.track-btn').forEach(b => {
        b.addEventListener('click', () => {
          formEl.querySelectorAll('.track-btn').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          formEl.dataset.tracking = b.dataset.track;
          const targetInput = document.getElementById('habitTarget-boost');
          if (targetInput) targetInput.style.display = b.dataset.track === 'count' ? 'block' : 'none';
        });
      });
    }

    if (save) save.addEventListener('click', async () => {
      const name = document.getElementById(`habitName-${direction}`).value.trim();
      if (!name) return;
      let trackingType = direction === 'diminish' ? 'count' : (formEl.dataset.tracking || 'check');
      let target = null;
      if (direction === 'boost' && trackingType === 'count') {
        const t = document.getElementById('habitTarget-boost').value;
        target = t ? parseInt(t, 10) : null;
      }
      await put('habits', { id: uid(), name, direction, trackingType, target, archived: false });
      habitFormOpen = null;
      renderActiveTab();
    });
    if (cancel) cancel.addEventListener('click', () => { habitFormOpen = null; renderActiveTab(); });
  });

  // wire up boost checkboxes
  boostListEl.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const habitId = btn.dataset.toggle;
      await setHabitLog(habitId, today(), ((logMap[habitId] || {})[today()] || 0) > 0 ? 0 : 1);
      renderActiveTab();
    });
  });
  // wire up diminish steppers + count-based boost steppers
  [...diminishListEl.querySelectorAll('[data-step]'), ...boostListEl.querySelectorAll('[data-step]')].forEach(btn => {
    btn.addEventListener('click', async () => {
      const habitId = btn.dataset.id;
      const delta = parseInt(btn.dataset.step, 10);
      const current = (logMap[habitId] || {})[today()] || 0;
      await setHabitLog(habitId, today(), Math.max(0, current + delta));
      renderActiveTab();
    });
  });
}

async function setHabitLog(habitId, dateVal, value) {
  const range = IDBKeyRange.only([habitId, dateVal]);
  const existing = await getAllByIndex('habitLogs', 'habitDate', range);
  const record = existing[0] || { id: uid(), habitId, date: dateVal, remotePath: null };
  record.value = value;
  record.dirty = true;
  await put('habitLogs', record);
}

document.getElementById('addBoostBtn').addEventListener('click', () => { habitFormOpen = 'boost'; renderActiveTab(); });
document.getElementById('addDiminishBtn').addEventListener('click', () => { habitFormOpen = 'diminish'; renderActiveTab(); });

// ---------- Month tab ----------
let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth(); // 0-indexed
let selectedDate = null;

async function renderMonthTab() {
  const label = new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  document.getElementById('monthLabel').textContent = label;

  const allEntries = await getAll('entries');
  const datesWithEntries = new Set(allEntries.map(e => e.date));

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
    const hasEntries = datesWithEntries.has(dStr);
    html += `<div class="cal-day ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}" data-date="${dStr}">
      <span>${day}</span>${hasEntries ? '<div class="cal-dot"></div>' : ''}
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
    renderAddRow(document.getElementById('month-add-slot'), selectedDate);
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
  habits: () => ['Habits', 'boost what helps, ease what doesn\u2019t'],
  month: () => ['Month', ''],
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
