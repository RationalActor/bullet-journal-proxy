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
    const req = indexedDB.open('bulletJournalDB', 3);
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
      // v3: the iPhone calendar mirror. Unlike everything else this is never
      // authored here and never pushed — each import replaces it wholesale —
      // so it's one record ('snapshot'), not a per-event store.
      if (!d.objectStoreNames.contains('calendar')) {
        d.createObjectStore('calendar', { keyPath: 'id' });
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
function getById(store, id) {
  return reqToPromise(tx(store, 'readonly').get(id)).catch(() => null);
}
function getAllByIndex(store, index, range) {
  return reqToPromise(tx(store, 'readonly').index(index).getAll(range));
}

// Soft-delete: if a record was already synced (has a remotePath), mark it
// deleted+dirty so the tombstone pushes to GitHub and a pull elsewhere won't
// resurrect it. If it was never synced, there's nothing remote to tombstone,
// so just remove it locally.
async function markDeleted(store, id) {
  const rec = await getById(store, id);
  if (!rec) return;
  if (!rec.remotePath) {
    await del(store, id);
    return;
  }
  rec.deleted = true;
  rec.dirty = true;
  await put(store, rec);
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
  if (e.deleted) fm += `deleted: true\n`;
  fm += `---\n${e.content}\n`;
  return fm;
}
function entryFilename(e) { return `${e.time.replace(/:/g, '-')}.md`; }
function entryPath(e) { return `entries/${e.date}/${entryFilename(e)}`; }

function habitOccToMarkdown(occ, habit) {
  let fm = `---\ntype: habit\nhabit_id: ${habit.id}\nhabit_name: ${habit.name}\nvalue: ${occ.value}\n`;
  if (habit.unit) fm += `unit: ${habit.unit}\n`;
  fm += `timestamp: ${occ.date}T${occ.time}\n`;
  if (occ.deleted) fm += `deleted: true\n`;
  fm += `---\n${habit.name}: ${occ.value}${habit.unit ? ' ' + habit.unit : ''}\n`;
  return fm;
}
function habitOccFilename(occ, habit) {
  return `${occ.time.replace(/:/g, '-')}-habit-${slugify(habit.name)}.md`;
}
function habitOccPath(o, habit) { return `entries/${o.date}/${habitOccFilename(o, habit)}`; }

function habitToMarkdown(h) {
  let fm = `---\ntype: habit-definition\nname: ${h.name}\ntracking_type: ${h.trackingType || 'check'}\n`;
  if (h.target) fm += `target: ${h.target}\n`;
  if (h.unit) fm += `unit: ${h.unit}\n`;
  fm += `deleted: ${!!h.deleted}\n---\n${h.name}\n`;
  return fm;
}
function habitDefPath(h) { return `habits/${h.id}.md`; }

// Minimal frontmatter parser: splits "---\nkey: value\n...\n---\nbody" into fields + body.
function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { fields: {}, body: raw.trim() };
  const fields = {};
  match[1].split('\n').forEach((line) => {
    const idx = line.indexOf(':');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\"/g, '"');
    fields[key] = val;
  });
  return { fields, body: match[2].replace(/\n$/, '') };
}

// ---------- iPhone calendar mirror ----------
// An iOS Shortcut reads the Calendar app (which has already merged every
// account you're signed into) and PUTs one file, calendar/snapshot.md, through
// the same proxy everything else uses. The app only ever reads it.
//
// Each line is:  start | end | all-day | calendar | title
// Title comes last so a '|' inside an event name can't break the parse. This
// is deliberately not JSON: Shortcuts has no way to escape quotes in an event
// title, so a JSON writer would corrupt itself the first time you scheduled
// something with a quote in the name.

const CAL_PALETTE = [
  '#6E8B5E', '#A8543F', '#4F6D7A', '#A8823D', '#7D5A7B',
  '#3F7A6B', '#8C6239', '#5B6BA8', '#96566B', '#6B7F3F',
];

const CalendarPrefs = {
  read() {
    try {
      const p = JSON.parse(localStorage.getItem('bj_calPrefs')) || {};
      return { colors: p.colors || {}, hidden: p.hidden || {}, names: p.names || {} };
    } catch (e) {
      return { colors: {}, hidden: {}, names: {} };
    }
  },
  write(p) { localStorage.setItem('bj_calPrefs', JSON.stringify(p)); },
  // The first time a calendar appears, give it the lowest unused palette slot
  // and remember the choice. Assigning by hash instead would collide constantly
  // at ten calendars, and assigning by sort order would reshuffle every colour
  // the day you add an eleventh.
  ensure(names) {
    const p = this.read();
    let changed = false;
    for (const name of names) {
      if (p.colors[name] !== undefined) continue;
      const taken = new Set(Object.values(p.colors));
      let idx = CAL_PALETTE.findIndex((_, i) => !taken.has(i));
      if (idx === -1) idx = Object.keys(p.colors).length % CAL_PALETTE.length;
      p.colors[name] = idx;
      changed = true;
    }
    if (changed) this.write(p);
  },
  colorFor(name) {
    const i = this.read().colors[name];
    return CAL_PALETTE[i === undefined ? 0 : i];
  },
  setColorIndex(name, idx) {
    const p = this.read();
    p.colors[name] = idx;
    this.write(p);
  },
  // Accounts name their calendars unhelpfully — "Calendar", or your own name
  // repeated across four of them. The real name stays the key everywhere, since
  // that's what the snapshot reports; this is purely what gets displayed.
  labelFor(name) {
    const n = this.read().names[name];
    return (n && n.trim()) ? n.trim() : name;
  },
  setName(name, nickname) {
    const p = this.read();
    const v = (nickname || '').trim();
    if (v && v !== name) p.names[name] = v; else delete p.names[name];
    this.write(p);
  },
  isHidden(name) { return !!this.read().hidden[name]; },
  toggleHidden(name) {
    const p = this.read();
    if (p.hidden[name]) delete p.hidden[name]; else p.hidden[name] = true;
    this.write(p);
  },
};

const CAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// The shortcut writes "2026-08-03 09:00" with a plain space rather than a T.
// Emitting a literal T would mean quoting it as 'T' in the Shortcuts date
// format field, and iOS smart punctuation rewrites those quotes as curly ones,
// which ICU doesn't accept as delimiters — the pattern then fails silently and
// drops the time. A space needs no quoting, so the separator is fixed up here
// instead. A real T is still accepted, in case the format is ever changed back.
function calNormalizeStamp(s) {
  return (s || '').trim().replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/, '$1T$2');
}

// Every date an event touches, so a week-long trip shows up on all seven days
// rather than only the day it started.
function calSpanDays(startISO, endISO) {
  const firstDay = startISO.slice(0, 10);
  if (!endISO || endISO.slice(0, 10) <= firstDay) return [firstDay];

  // An end of exactly midnight belongs to the day before it. iOS reports an
  // all-day event as ending at 00:00 the next morning, and without this every
  // one of them would spill an extra day down the page.
  let lastDay = endISO.slice(0, 10);
  if (endISO.slice(11, 16) === '00:00') {
    const d = new Date(lastDay + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    lastDay = dateStr(d);
  }
  if (lastDay <= firstDay) return [firstDay];

  const days = [];
  const cur = new Date(firstDay + 'T00:00:00');
  const end = new Date(lastDay + 'T00:00:00');
  while (cur <= end && days.length < 60) { // guard against a malformed far-future end date
    days.push(dateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function parseCalendarSnapshot(raw) {
  // Normalise line endings first: parseFrontmatter matches on \n, and a file
  // with \r\n would fall through to its no-frontmatter branch — losing the
  // generated timestamp, which is the one field we can't do without.
  const { fields, body } = parseFrontmatter(raw.replace(/\r\n/g, '\n'));
  const events = [];
  let sourceCount = 0;
  let skipped = 0;
  let unparsedEnds = 0;

  // The shortcut runs two Find queries — one for the past window, one for the
  // future — because Shortcuts' "Any" combinator returns nothing and its
  // before/after filters won't accept variables. The two windows meet at "now",
  // so an event starting on the boundary comes back from both as byte-identical
  // lines. Collapse them here rather than making the shortcut's date maths
  // carry the burden of never overlapping.
  const seen = new Set();

  for (const line of body.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    const parts = text.split('|');
    if (parts.length < 5) { skipped++; continue; }

    const start = calNormalizeStamp(parts[0]);
    if (!CAL_ISO.test(start)) { skipped++; continue; }
    sourceCount++;

    // A date the shortcut left unformatted ("Aug 14, 2026 at 11:59 PM") still
    // leaves a usable event — it just collapses onto its first day. Count them
    // so Settings can say so out loud, instead of silently losing the back half
    // of every multi-day trip.
    const end = calNormalizeStamp(parts[1]);
    const endISO = CAL_ISO.test(end) ? end : '';
    if (!endISO) unparsedEnds++;

    // iOS writes all-day as Yes/No, but 1/true survive a format change.
    const allDay = /^(1|true|yes)$/i.test((parts[2] || '').trim());
    const calendar = (parts[3] || '').trim() || 'Unfiled';
    const title = parts.slice(4).join('|').trim() || '(untitled)';

    const days = calSpanDays(start, endISO);
    days.forEach((date, i) => {
      events.push({
        date,
        calendar,
        title,
        allDay,
        continued: i > 0,                                        // a later day of a multi-day event
        start: (allDay || i > 0) ? '' : start.slice(11, 16),
        end: (allDay || days.length > 1 || !endISO) ? '' : endISO.slice(11, 16),
      });
    });
  }

  // Only trust a range that actually parses. An unformatted one is still a
  // non-empty string, and comparing month dates against "Jun 28, 20" would
  // wrongly report every single month as outside the exported window.
  const asIso = (s) => {
    const v = calNormalizeStamp(s);
    return CAL_ISO.test(v) ? v : '';
  };

  return {
    id: 'snapshot',
    generated: calNormalizeStamp(fields.generated), // left unvalidated so a bad
    rangeStart: asIso(fields.range_start),          // value reads as "unreadable"
    rangeEnd: asIso(fields.range_end),              // rather than "never updated"
    sourceCount,
    skipped,
    unparsedEnds,
    events,
  };
}

// The whole point of a mirror is knowing how far behind it is.
function calStaleness(generatedISO) {
  if (!generatedISO) return { text: 'never updated', level: 'stale', exact: '' };
  const then = new Date(generatedISO);
  if (isNaN(then.getTime())) return { text: 'update time unreadable', level: 'stale', exact: '' };

  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  let rel;
  if (mins < 2) rel = 'just now'; // also covers a slightly-ahead phone clock
  else if (mins < 60) rel = `${mins} min ago`;
  else if (mins < 48 * 60) rel = `${Math.round(mins / 60)}h ago`;
  else rel = `${Math.round(mins / 1440)} days ago`;

  return {
    text: `updated ${rel}`,
    level: mins < 12 * 60 ? 'fresh' : mins < 48 * 60 ? 'aging' : 'stale',
    exact: then.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
  };
}

function getCalendarSnapshot() { return getById('calendar', 'snapshot'); }

function visibleCalendarEvents(snapshot) {
  if (!snapshot) return [];
  return snapshot.events.filter(e => !CalendarPrefs.isHidden(e.calendar));
}

function sortAppointments(list) {
  return list.slice().sort((a, b) =>
    (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1) ||
    (a.start || '').localeCompare(b.start || '') ||
    a.title.localeCompare(b.title)
  );
}

// showRange: the month list is tight, so it shows only a start time; the
// expanded day view has room for the full span.
function appointmentRowHtml(ev, showRange) {
  const color = CalendarPrefs.colorFor(ev.calendar); // always from CAL_PALETTE, never user text
  let when;
  if (ev.allDay) when = 'all day';
  else if (ev.continued) when = '···';
  else if (showRange && ev.end) when = `${ev.start}–${ev.end}`;
  else when = ev.start.replace(/^0/, '');

  return `
    <div class="appt-row">
      <span class="appt-dot" style="background:${color}"></span>
      <span class="appt-when">${escapeHtml(when)}</span>
      <span class="appt-title">${escapeHtml(ev.title)}</span>
      <span class="appt-cal" style="color:${color}" title="${escapeHtml(ev.calendar)}">${escapeHtml(CalendarPrefs.labelFor(ev.calendar))}</span>
    </div>`;
}

// ---------- sync: push local changes to GitHub ----------
async function syncOne({ store, record, path, markdown }) {
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
        body: JSON.stringify({ path, content: markdown }),
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
  const dirtyHabits = habits.filter(h => h.dirty);

  let okCount = 0, failCount = 0;

  for (const h of dirtyHabits) {
    const path = h.remotePath || habitDefPath(h);
    const ok = await syncOne({ store: 'habits', record: h, path, markdown: habitToMarkdown(h) });
    ok ? okCount++ : failCount++;
  }
  for (const e of dirtyEntries) {
    const path = e.remotePath || entryPath(e);
    const ok = await syncOne({ store: 'entries', record: e, path, markdown: entryToMarkdown(e) });
    ok ? okCount++ : failCount++;
  }
  for (const o of dirtyOccs) {
    const habit = habitById[o.habitId];
    const path = o.remotePath || habitOccPath(o, habit);
    const ok = await syncOne({ store: 'habitOccurrences', record: o, path, markdown: habitOccToMarkdown(o, habit) });
    ok ? okCount++ : failCount++;
  }

  // Pull as well as push, so "Sync now" is a full round-trip — that's what
  // refreshes the calendar mirror after the shortcut has run on the phone.
  await pullFromGitHub();

  Settings.lastSync = new Date().toLocaleString();
  renderSyncStatus();
  if (failCount > 0) {
    statusEl.textContent += ` Done, but ${failCount} item(s) couldn't sync (no connection?) — they'll retry next time.`;
  }
  renderActiveTab();
}

async function renderSyncStatus() {
  const [entries, habitOccs, habits] = await Promise.all([getAll('entries'), getAll('habitOccurrences'), getAll('habits')]);
  const pending = entries.filter(e => e.dirty).length + habitOccs.filter(o => o.dirty).length + habits.filter(h => h.dirty).length;
  const el = document.getElementById('syncStatus');
  el.textContent = `Last synced: ${Settings.lastSync || 'never'}. Pending: ${pending} item(s).`;
}

// ---------- pull: bring in changes made on other devices ----------
// Runs once automatically whenever the app opens/refreshes (no polling/timer).
// Merge rule: a local record with unsynced changes (dirty) always wins and is
// left alone — it'll push out on the next sync. Otherwise, GitHub is treated
// as authoritative and overwrites the local copy.
async function pullFromGitHub() {
  if (!Settings.url || !Settings.secret) return;
  const headers = { 'x-app-secret': Settings.secret };
  const base = Settings.url.replace(/\/$/, '');

  try {
    // ---- iPhone calendar snapshot (calendar/snapshot.md) ----
    // Fetched first: it's the most time-sensitive thing here, and it doesn't
    // depend on any of the merge logic below.
    const calResp = await fetch(`${base}/api/entries?folder=calendar`, { headers });
    if (calResp.ok) {
      const calData = await calResp.json();
      const snapFile = (calData.entries || []).find(f => f.filename === 'snapshot.md');
      if (snapFile) {
        const snapshot = parseCalendarSnapshot(snapFile.raw);
        CalendarPrefs.ensure([...new Set(snapshot.events.map(e => e.calendar))]);
        await put('calendar', snapshot); // wholesale replace — no merge, it's a mirror
      }
    }

    // ---- habit definitions (habits/<id>.md) ----
    const habitsResp = await fetch(`${base}/api/entries?folder=habits`, { headers });
    if (habitsResp.ok) {
      const habitsData = await habitsResp.json();
      for (const item of habitsData.entries || []) {
        const id = item.filename.replace(/\.md$/, '');
        const { fields } = parseFrontmatter(item.raw);
        const localExisting = await getById('habits', id);
        if (localExisting && localExisting.dirty) continue; // local pending edit wins
        await put('habits', {
          id,
          name: fields.name || (localExisting ? localExisting.name : '(untitled)'),
          trackingType: fields.tracking_type || 'check',
          target: fields.target ? parseInt(fields.target, 10) : null,
          unit: fields.unit || null,
          deleted: fields.deleted === 'true',
          dirty: false,
          remotePath: item.path,
        });
      }
    }

    // id -> habit lookup for matching occurrence files (used below)
    const habitsNow = await getAll('habits');
    const habitByRemoteId = Object.fromEntries(habitsNow.map(h => [h.id, h]));
    const habitByName = Object.fromEntries(habitsNow.map(h => [h.name, h])); // fallback for older files without habit_id

    // ---- entries + habit occurrences (entries/<date>/*.md) ----
    const localEntries = await getAll('entries');
    const localOccs = await getAll('habitOccurrences');
    const byPath = new Map();
    localEntries.forEach(e => { if (e.remotePath) byPath.set(e.remotePath, { store: 'entries', record: e }); });
    localOccs.forEach(o => { if (o.remotePath) byPath.set(o.remotePath, { store: 'habitOccurrences', record: o }); });

    const folderResp = await fetch(`${base}/api/entries?folder=entries`, { headers });
    if (!folderResp.ok) return;
    const folderData = await folderResp.json();
    const dateFolders = folderData.dirs || [];

    for (const dateFolder of dateFolders) {
      const dayResp = await fetch(`${base}/api/entries?date=${dateFolder}`, { headers });
      if (!dayResp.ok) continue;
      const dayData = await dayResp.json();

      for (const item of dayData.entries || []) {
        const existing = byPath.get(item.path);
        if (existing && existing.record.dirty) continue; // local pending edit wins

        const { fields, body } = parseFrontmatter(item.raw);
        const time = (fields.timestamp || '').split('T')[1] || '00:00:00';

        if (fields.type === 'habit') {
          const habit = (fields.habit_id && habitByRemoteId[fields.habit_id]) || habitByName[fields.habit_name];
          if (!habit) { console.warn('pull: no local habit match for', item.path); continue; }
          const rec = (existing && existing.store === 'habitOccurrences') ? existing.record : { id: uid() };
          rec.habitId = habit.id;
          rec.date = dateFolder;
          rec.time = time;
          rec.value = fields.value ? parseFloat(fields.value) : 1;
          rec.deleted = fields.deleted === 'true';
          rec.dirty = false;
          rec.remotePath = item.path;
          await put('habitOccurrences', rec);
        } else {
          const rec = (existing && existing.store === 'entries') ? existing.record : { id: uid() };
          rec.date = dateFolder;
          rec.time = time;
          rec.type = fields.type || 'note';
          rec.content = body;
          if (rec.type === 'task') rec.done = fields.done === 'true';
          if (rec.type === 'gratitude' && fields.prompt) rec.prompt = fields.prompt;
          rec.deleted = fields.deleted === 'true';
          rec.dirty = false;
          rec.remotePath = item.path;
          await put('entries', rec);
        }
      }
    }
  } catch (err) {
    console.error('pull failed', err);
  }
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
  const habits = (await getAll('habits')).filter(h => !h.deleted);
  const now = new Date();

  // Rescue anything half-typed before the markup below replaces it. This
  // function re-runs on every incidental re-render — ticking off a task,
  // logging a habit — and none of those should cost you a sentence you were
  // part-way through. Read from the live DOM rather than holding the draft in
  // a variable, so two add rows on different tabs can't bleed into each other.
  const liveInput = container.querySelector('.text-input-row input');
  let draft = liveInput ? liveInput.value : (container.dataset.draft || '');

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
    // Switching symbol rebuilds this area, so carry the draft across — including
    // out to habit mode and back, where there's no text field to hold it.
    const live = inputArea.querySelector('.text-input-row input');
    if (live) draft = live.value;
    container.dataset.draft = draft; // survives habit mode, where no field exists to hold it

    if (addMode === 'habit') {
      const active = habits;
      if (active.length === 0) {
        inputArea.innerHTML = `<div class="hint" style="padding:8px 4px;">No habits yet \u2014 add one in the Habits tab first.</div>`;
        return;
      }
      inputArea.innerHTML = `<div class="habit-chip-row">${active.map(h =>
        `<button class="habit-chip" data-habit="${h.id}">${escapeHtml(h.name)}</button>`
      ).join('')}</div>`;

      function openQuantityPrompt(habit) {
        const existing = inputArea.querySelector('.habit-qty-form');
        if (existing) existing.remove();
        const form = document.createElement('div');
        form.className = 'habit-qty-form';
        const unitLabel = habit.unit ? ` (${escapeHtml(habit.unit)})` : '';
        form.innerHTML = `
          <span class="habit-qty-label">${escapeHtml(habit.name)}${unitLabel}</span>
          <input type="number" class="habit-qty-input" id="habitQtyInput" min="0" step="any" value="1" />
          <button class="habit-qty-log" id="habitQtyLogBtn">Log</button>
          <button class="habit-qty-cancel" id="habitQtyCancelBtn">\u00d7</button>`;
        inputArea.appendChild(form);
        const qtyInput = form.querySelector('#habitQtyInput');
        qtyInput.focus();
        qtyInput.select();
        async function logIt() {
          const val = parseFloat(qtyInput.value);
          if (!val || val <= 0) return;
          const { date, time } = chosenDateTime();
          await put('habitOccurrences', {
            id: uid(), habitId: habit.id, date, time,
            value: val, dirty: true, remotePath: null,
          });
          renderActiveTab();
        }
        form.querySelector('#habitQtyLogBtn').addEventListener('click', logIt);
        form.querySelector('#habitQtyCancelBtn').addEventListener('click', () => form.remove());
        qtyInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') logIt(); });
      }

      inputArea.querySelectorAll('.habit-chip').forEach(chip => {
        chip.addEventListener('click', async () => {
          const habit = active.find(h => h.id === chip.dataset.habit);
          if (!habit) return;
          if (habit.trackingType === 'count') {
            openQuantityPrompt(habit);
            return;
          }
          const { date, time } = chosenDateTime();
          await put('habitOccurrences', {
            id: uid(), habitId: habit.id, date, time,
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
      input.value = draft;
      input.addEventListener('input', () => { container.dataset.draft = input.value; });
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

// ---------- shared: entry list, interleaving habit occurrences by time ----------
let editingEntryId = null;

// Content and time only, deliberately not the date. On pull an entry's date
// comes from its folder while its time comes from the frontmatter, so retiming
// is safe but re-dating would need the old file removed — and the proxy has no
// DELETE, so the entry would reappear on its original day at the next pull.
function entryEditFormHtml(e) {
  return `
    <div class="inline-form entry-edit">
      <input type="text" id="editContent-${e.id}" value="${escapeHtml(e.content)}" />
      <input type="time" id="editTime-${e.id}" value="${e.time}" step="1" />
      <div class="form-actions">
        <button class="save" id="editSave-${e.id}">Save</button>
        <button id="editCancel-${e.id}">Cancel</button>
      </div>
    </div>`;
}

async function renderEntryList(container, targetDate) {
  const range = IDBKeyRange.only(targetDate);
  const [rawEntries, habitOccs, habits] = await Promise.all([
    getAllByIndex('entries', 'date', range),
    getAllByIndex('habitOccurrences', 'date', range),
    getAll('habits'),
  ]);
  const entries = rawEntries.filter(e => e.type !== 'gratitude' && !e.deleted); // gratitude lives in its own tab
  const habitById = Object.fromEntries(habits.map(h => [h.id, h]));

  const rows = [
    ...entries.map(e => ({ kind: 'entry', time: e.time, data: e })),
    ...habitOccs
      .filter(o => !o.deleted && habitById[o.habitId] && !habitById[o.habitId].deleted)
      .map(o => ({ kind: 'habit', time: o.time, data: o, habit: habitById[o.habitId] })),
  ].sort((a, b) => a.time.localeCompare(b.time));

  if (rows.length === 0) {
    container.innerHTML = `<div class="empty-state">Nothing logged yet — the page is waiting.</div>`;
    return;
  }

  container.innerHTML = rows.map(r => {
    if (r.kind === 'entry') {
      const e = r.data;
      if (e.id === editingEntryId) return entryEditFormHtml(e);
      return `
        <div class="entry-row" data-id="${e.id}">
          <div class="entry-symbol" data-id="${e.id}">${e.type === 'task' ? (e.done ? '✓' : '▢') : SYMBOLS[e.type]}</div>
          <div class="entry-body" data-editentry="${e.id}">
            <div class="entry-content ${e.type === 'task' && e.done ? 'done' : ''}">${escapeHtml(e.content)}</div>
            <div class="entry-time">${e.time.slice(0, 5)}</div>
          </div>
          <button class="entry-del" data-del="${e.id}">×</button>
        </div>`;
    }
    const occ = r.data, habit = r.habit;
    const isCount = habit.trackingType === 'count';
    const unit = habit.unit ? ` ${habit.unit}` : '';
    const label = isCount ? `${habit.name} \u2014 ${occ.value}${unit}` : habit.name;
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
  // Tapping the text (or its time) opens the editor; the symbol still belongs
  // to ticking a task off.
  container.querySelectorAll('[data-editentry]').forEach(el => {
    el.addEventListener('click', () => {
      editingEntryId = el.dataset.editentry;
      renderActiveTab();
    });
  });

  if (editingEntryId) {
    const saveBtn = container.querySelector(`#editSave-${editingEntryId}`);
    // Absent when the entry being edited isn't on the day currently shown.
    if (saveBtn) {
      const contentInput = container.querySelector(`#editContent-${editingEntryId}`);
      const timeInput = container.querySelector(`#editTime-${editingEntryId}`);
      const closeEditor = () => { editingEntryId = null; renderActiveTab(); };

      async function saveEdit() {
        const entry = entries.find(x => x.id === editingEntryId);
        if (!entry) return closeEditor();
        const text = contentInput.value.trim();
        if (!text) return; // blanking the text is what the × is for
        let t = timeInput.value || entry.time;
        if (t.length === 5) t += ':00'; // HH:MM -> HH:MM:SS
        entry.content = text;
        entry.time = t;
        entry.dirty = true;
        // remotePath is deliberately left alone: the file keeps its original
        // HH-mm-ss name while the frontmatter carries the corrected time, and
        // pull reads the time from the frontmatter.
        await put('entries', entry);
        closeEditor();
      }

      saveBtn.addEventListener('click', saveEdit);
      contentInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') saveEdit(); });
      container.querySelector(`#editCancel-${editingEntryId}`).addEventListener('click', closeEditor);
    }
  }

  container.querySelectorAll('[data-del]').forEach(el => {
    el.addEventListener('click', async () => {
      await markDeleted('entries', el.dataset.del);
      renderActiveTab();
    });
  });
  container.querySelectorAll('[data-delhabit]').forEach(el => {
    el.addEventListener('click', async () => {
      await markDeleted('habitOccurrences', el.dataset.delhabit);
      renderActiveTab();
    });
  });
}

// ---------- Today tab ----------
// The tab still opens on today; it just no longer traps you there. Catching up
// on a day you missed, or laying out one that's coming, shouldn't mean going
// through the month grid.
let todayViewDate = today();

function shiftTodayView(days) {
  const d = new Date(todayViewDate + 'T00:00:00');
  d.setDate(d.getDate() + days);
  todayViewDate = dateStr(d);
  renderActiveTab();
}

async function renderTodayTab() {
  const onToday = todayViewDate === today();
  const label = new Date(todayViewDate + 'T00:00:00')
    .toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  const nav = document.getElementById('todayNav');
  nav.innerHTML = `
    <button class="icon-btn" id="todayPrevBtn">‹</button>
    <div class="day-nav-label">
      <span>${label}</span>
      ${onToday ? '' : '<button class="day-nav-back" id="todayJumpBtn">back to today</button>'}
    </div>
    <button class="icon-btn" id="todayNextBtn">›</button>`;

  document.getElementById('todayPrevBtn').addEventListener('click', () => shiftTodayView(-1));
  document.getElementById('todayNextBtn').addEventListener('click', () => shiftTodayView(1));
  if (!onToday) {
    document.getElementById('todayJumpBtn').addEventListener('click', () => {
      todayViewDate = today();
      renderActiveTab();
    });
  }

  // Same block the month view uses for a selected day: what was on the books
  // first, then what you made of it.
  const snapshot = await getCalendarSnapshot();
  const appts = sortAppointments(visibleCalendarEvents(snapshot).filter(e => e.date === todayViewDate));
  document.getElementById('today-appt-slot').innerHTML = appts.length
    ? `<div class="appt-day-block">${appts.map(e => appointmentRowHtml(e, true)).join('')}</div>`
    : '';

  await renderAddRow(document.getElementById('today-add-slot'), todayViewDate);
  await renderEntryList(document.getElementById('today-list-slot'), todayViewDate);
  await renderGratitudeNudge();
}

async function renderGratitudeNudge() {
  const slot = document.getElementById('today-gratitude-nudge-slot');
  // The nudge asks about today's practice, so it has nothing to say while
  // you're reading back through an earlier day.
  if (todayViewDate !== today()) { slot.innerHTML = ''; return; }
  const range = IDBKeyRange.only(today());
  const todaysEntries = await getAllByIndex('entries', 'date', range);
  const hasGratitude = todaysEntries.some(e => e.type === 'gratitude' && !e.deleted);
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
let editingHabitId = null;

function habitFormHtml() {
  return `
    <div class="inline-form" id="habitForm" data-tracking="check">
      <input type="text" placeholder="Habit name" id="habitName" />
      <div class="row">
        <button type="button" class="track-btn active" data-track="check">Check off</button>
        <button type="button" class="track-btn" data-track="count">Count</button>
      </div>
      <input type="number" min="1" placeholder="Daily goal (optional)" id="habitTarget" style="display:none" />
      <input type="text" placeholder="Unit, e.g. oz, reps (optional)" id="habitUnit" style="display:none" />
      <div class="form-actions">
        <button class="save" id="habitSave">Add</button>
        <button id="habitCancel">Cancel</button>
      </div>
    </div>`;
}

function habitEditFormHtml(h) {
  const trackingType = h.trackingType || 'check';
  const isCount = trackingType === 'count';
  return `
    <div class="inline-form" id="habitEditForm-${h.id}" data-tracking="${trackingType}">
      <input type="text" value="${escapeHtml(h.name)}" id="habitEditName-${h.id}" />
      <div class="row">
        <button type="button" class="track-btn ${!isCount ? 'active' : ''}" data-track="check">Check off</button>
        <button type="button" class="track-btn ${isCount ? 'active' : ''}" data-track="count">Count</button>
      </div>
      <input type="number" min="1" placeholder="Daily goal (optional)" id="habitEditTarget-${h.id}" value="${h.target || ''}" style="display:${isCount ? 'block' : 'none'}" />
      <input type="text" placeholder="Unit, e.g. oz, reps (optional)" id="habitEditUnit-${h.id}" value="${h.unit ? escapeHtml(h.unit) : ''}" style="display:${isCount ? 'block' : 'none'}" />
      <div class="form-actions">
        <button class="save" id="habitEditSave-${h.id}">Save</button>
        <button id="habitEditCancel-${h.id}">Cancel</button>
      </div>
      <button class="habit-delete-btn" id="habitEditDelete-${h.id}">Delete habit</button>
    </div>`;
}

async function renderHabitsTab() {
  const habits = (await getAll('habits')).filter(h => !h.deleted);

  const last7 = [...Array(7)].map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return dateStr(d);
  });

  const allOccs = (await getAll('habitOccurrences')).filter(o => !o.deleted);
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
    if (trackingType === 'count') {
      const unit = habit.unit ? ' ' + habit.unit : '';
      return `${v}${unit}${habit.target ? '/' + habit.target + unit : ''} today`;
    }
    return v > 0 ? 'Done today' : 'Not yet today';
  }

  const listEl = document.getElementById('habit-list');
  listEl.innerHTML = (habitFormOpen ? habitFormHtml() : '') + (habits.map(h => {
    if (editingHabitId === h.id) return habitEditFormHtml(h);
    return `
      <div class="habit-card">
        <div class="habit-top">
          <div class="habit-name">${escapeHtml(h.name)}</div>
          <div class="habit-top-right">
            <span class="habit-today-total">${todayLabel(h)}</span>
            <button class="habit-edit-btn" data-edit="${h.id}">Edit</button>
          </div>
        </div>
        ${streakRow(h)}
      </div>`;
  }).join('') || (habitFormOpen ? '' : '<div class="empty-state">No habits yet.</div>'));

  // wire the add-habit form
  const formEl = document.getElementById('habitForm');
  if (formEl) {
    formEl.querySelectorAll('.track-btn').forEach(b => {
      b.addEventListener('click', () => {
        formEl.querySelectorAll('.track-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        formEl.dataset.tracking = b.dataset.track;
        const isCount = b.dataset.track === 'count';
        const targetInput = document.getElementById('habitTarget');
        const unitInput = document.getElementById('habitUnit');
        if (targetInput) targetInput.style.display = isCount ? 'block' : 'none';
        if (unitInput) unitInput.style.display = isCount ? 'block' : 'none';
      });
    });

    document.getElementById('habitSave').addEventListener('click', async () => {
      const name = document.getElementById('habitName').value.trim();
      if (!name) return;
      const trackingType = formEl.dataset.tracking || 'check';
      let target = null, unit = null;
      if (trackingType === 'count') {
        const t = document.getElementById('habitTarget').value;
        target = t ? parseInt(t, 10) : null;
        const u = document.getElementById('habitUnit').value.trim();
        unit = u || null;
      }
      await put('habits', { id: uid(), name, trackingType, target, unit, deleted: false, dirty: true, remotePath: null });
      habitFormOpen = false;
      renderActiveTab();
    });
    document.getElementById('habitCancel').addEventListener('click', () => { habitFormOpen = false; renderActiveTab(); });
  }

  // wire each card's Edit button
  listEl.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      editingHabitId = btn.dataset.edit;
      habitFormOpen = false;
      renderActiveTab();
    });
  });

  // wire the edit form, if one is open
  if (editingHabitId) {
    const editFormEl = document.getElementById(`habitEditForm-${editingHabitId}`);
    if (editFormEl) {
      editFormEl.querySelectorAll('.track-btn').forEach(b => {
        b.addEventListener('click', () => {
          editFormEl.querySelectorAll('.track-btn').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          editFormEl.dataset.tracking = b.dataset.track;
          const isCount = b.dataset.track === 'count';
          const targetInput = document.getElementById(`habitEditTarget-${editingHabitId}`);
          const unitInput = document.getElementById(`habitEditUnit-${editingHabitId}`);
          if (targetInput) targetInput.style.display = isCount ? 'block' : 'none';
          if (unitInput) unitInput.style.display = isCount ? 'block' : 'none';
        });
      });

      document.getElementById(`habitEditSave-${editingHabitId}`).addEventListener('click', async () => {
        const habit = habits.find(h => h.id === editingHabitId);
        if (!habit) return;
        const name = document.getElementById(`habitEditName-${editingHabitId}`).value.trim();
        if (!name) return;
        const trackingType = editFormEl.dataset.tracking || 'check';
        let target = null, unit = null;
        if (trackingType === 'count') {
          const t = document.getElementById(`habitEditTarget-${editingHabitId}`).value;
          target = t ? parseInt(t, 10) : null;
          const u = document.getElementById(`habitEditUnit-${editingHabitId}`).value.trim();
          unit = u || null;
        }
        await put('habits', { ...habit, name, trackingType, target, unit, dirty: true });
        editingHabitId = null;
        renderActiveTab();
      });

      document.getElementById(`habitEditCancel-${editingHabitId}`).addEventListener('click', () => {
        editingHabitId = null;
        renderActiveTab();
      });

      document.getElementById(`habitEditDelete-${editingHabitId}`).addEventListener('click', async () => {
        const habit = habits.find(h => h.id === editingHabitId);
        const ok = confirm(`Delete "${habit ? habit.name : 'this habit'}"? This can\u2019t be undone. Past logged entries for it will stay in your synced files but won\u2019t show in the app anymore.`);
        if (!ok) return;
        if (habit) {
          if (habit.remotePath) {
            habit.deleted = true;
            habit.dirty = true;
            await put('habits', habit);
          } else {
            await del('habits', habit.id);
          }
        }
        editingHabitId = null;
        renderActiveTab();
      });
    }
  }
}

document.getElementById('addHabitBtn').addEventListener('click', () => { habitFormOpen = true; editingHabitId = null; renderActiveTab(); });

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
    .filter(e => e.type === 'gratitude' && !e.deleted)
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
      await markDeleted('entries', btn.dataset.delgrat);
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

  const [allEntries, allOccs, snapshot] = await Promise.all([
    getAll('entries'), getAll('habitOccurrences'), getCalendarSnapshot(),
  ]);
  const datesWithContent = new Set([
    ...allEntries.filter(e => !e.deleted).map(e => e.date),
    ...allOccs.filter(o => !o.deleted).map(o => o.date),
  ]);

  const monthPrefix = `${viewYear}-${pad(viewMonth + 1)}`;
  const monthAppts = visibleCalendarEvents(snapshot).filter(e => e.date.startsWith(monthPrefix));
  const apptsByDate = {};
  monthAppts.forEach(e => { (apptsByDate[e.date] = apptsByDate[e.date] || []).push(e); });

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
    // One pip per distinct calendar with something that day, capped at three —
    // the cell is a square the size of a fingertip, not a legend.
    const pips = [...new Set((apptsByDate[dStr] || []).map(e => e.calendar))]
      .slice(0, 3)
      .map(c => `<span class="cal-pip" style="background:${CalendarPrefs.colorFor(c)}"></span>`)
      .join('');
    html += `<div class="cal-day ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}" data-date="${dStr}">
      <span>${day}</span>
      <div class="cal-marks">${hasContent ? '<span class="cal-dot"></span>' : ''}${pips}</div>
    </div>`;
  }
  document.getElementById('calGrid').innerHTML = html;

  document.querySelectorAll('.cal-day[data-date]').forEach(el => {
    el.addEventListener('click', () => {
      selectedDate = el.dataset.date;
      renderMonthTab();
    });
  });

  renderMonthAppointments(document.getElementById('monthAppointments'), snapshot, monthAppts);

  const detailEl = document.getElementById('dayDetail');
  if (selectedDate) {
    const niceDate = new Date(selectedDate + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    detailEl.innerHTML = `<h2>${niceDate}</h2><div id="month-appt-slot"></div><div id="month-add-slot"></div><div id="month-list-slot"></div>`;

    // Appointments sit above the journal for the day: what was already on the
    // books, then what you made of it.
    const dayAppts = sortAppointments(visibleCalendarEvents(snapshot).filter(e => e.date === selectedDate));
    document.getElementById('month-appt-slot').innerHTML = dayAppts.length
      ? `<div class="appt-day-block">${dayAppts.map(e => appointmentRowHtml(e, true)).join('')}</div>`
      : '';

    await renderAddRow(document.getElementById('month-add-slot'), selectedDate);
    await renderEntryList(document.getElementById('month-list-slot'), selectedDate);
  } else {
    detailEl.innerHTML = '';
  }
}

function renderMonthAppointments(container, snapshot, monthAppts) {
  const stale = calStaleness(snapshot && snapshot.generated);
  const header = `
    <div class="appt-header">
      <h2>Appointments</h2>
      <span class="appt-stamp ${stale.level}" title="${escapeHtml(stale.exact)}">${escapeHtml(stale.text)}</span>
    </div>`;

  if (!snapshot) {
    container.innerHTML = header +
      `<div class="empty-state">No calendar snapshot yet — run the Calendar shortcut on your iPhone, then sync.</div>`;
    return;
  }

  if (monthAppts.length === 0) {
    // Distinguish "you have a free month" from "this month was never exported".
    const monthStart = `${viewYear}-${pad(viewMonth + 1)}-01`;
    const monthEnd = `${viewYear}-${pad(viewMonth + 1)}-31`;
    const outside = snapshot.rangeStart && snapshot.rangeEnd &&
      (monthEnd < snapshot.rangeStart.slice(0, 10) || monthStart > snapshot.rangeEnd.slice(0, 10));
    container.innerHTML = header + `<div class="empty-state">${
      outside ? 'Outside the exported date range.' : 'Nothing scheduled this month.'
    }</div>`;
    return;
  }

  const dowShort = ['Su', 'M', 'T', 'W', 'Th', 'F', 'S'];
  const byDate = {};
  monthAppts.forEach(e => { (byDate[e.date] = byDate[e.date] || []).push(e); });

  const rows = Object.keys(byDate).sort().map(date => {
    const d = new Date(date + 'T00:00:00');
    return `
      <div class="appt-day ${date === today() ? 'today' : ''} ${date === selectedDate ? 'selected' : ''}" data-apptday="${date}">
        <div class="appt-daymark">
          <span class="appt-daynum">${d.getDate()}</span>
          <span class="appt-dow">${dowShort[d.getDay()]}</span>
        </div>
        <div class="appt-items">${sortAppointments(byDate[date]).map(e => appointmentRowHtml(e, false)).join('')}</div>
      </div>`;
  }).join('');

  container.innerHTML = header + `<div class="appt-list">${rows}</div>`;

  container.querySelectorAll('[data-apptday]').forEach(el => {
    el.addEventListener('click', () => {
      selectedDate = el.dataset.apptday;
      renderMonthTab();
    });
  });
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
  renderCalendarSettings();
}

let openPaletteFor = null; // which calendar has its colour picker expanded

async function renderCalendarSettings() {
  const statusEl = document.getElementById('calStatus');
  const listEl = document.getElementById('calPrefsList');
  const snapshot = await getCalendarSnapshot();

  if (!snapshot) {
    statusEl.textContent = 'No calendar snapshot yet. Run the Calendar shortcut on your iPhone, then sync.';
    listEl.innerHTML = '';
    return;
  }

  const stale = calStaleness(snapshot.generated);
  const names = [...new Set(snapshot.events.map(e => e.calendar))].sort();
  const range = (snapshot.rangeStart && snapshot.rangeEnd)
    ? ` Covering ${snapshot.rangeStart.slice(0, 10)} to ${snapshot.rangeEnd.slice(0, 10)}.` : '';
  const bad = snapshot.skipped ? ` ${snapshot.skipped} line(s) couldn't be read.` : '';
  const ends = snapshot.unparsedEnds
    ? ` ${snapshot.unparsedEnds} event(s) had an unreadable end time and show on their first day only —` +
      ` check the End Date format in the shortcut.`
    : '';
  statusEl.textContent =
    `${snapshot.sourceCount} appointment(s) across ${names.length} calendar(s), ${stale.text}` +
    `${stale.exact ? ` (${stale.exact})` : ''}.${range}${bad}${ends}`;

  listEl.innerHTML = names.map(n => {
    const label = CalendarPrefs.labelFor(n);
    const renamed = label !== n;
    const hidden = CalendarPrefs.isHidden(n);
    const paletteOpen = openPaletteFor === n;
    return `
      <div class="cal-pref ${hidden ? 'off' : ''}">
        <div class="cal-pref-row">
          <button class="cal-swatch" data-swatch="${escapeHtml(n)}" style="background:${CalendarPrefs.colorFor(n)}" title="Change colour"></button>
          <div class="cal-pref-main">
            <input class="cal-nickname" type="text" data-nickname="${escapeHtml(n)}"
                   value="${renamed ? escapeHtml(label) : ''}" placeholder="${escapeHtml(n)}" />
            ${renamed ? `<span class="cal-pref-source">${escapeHtml(n)}</span>` : ''}
          </div>
          <button class="cal-toggle" data-toggle="${escapeHtml(n)}">${hidden ? 'Show' : 'Hide'}</button>
        </div>
        ${paletteOpen ? `<div class="cal-palette">${CAL_PALETTE.map((c, i) =>
          `<button class="cal-chip" data-pick="${escapeHtml(n)}" data-idx="${i}" style="background:${c}"></button>`
        ).join('')}</div>` : ''}
      </div>`;
  }).join('');

  listEl.querySelectorAll('[data-swatch]').forEach(btn => {
    btn.addEventListener('click', () => {
      openPaletteFor = openPaletteFor === btn.dataset.swatch ? null : btn.dataset.swatch;
      renderCalendarSettings();
    });
  });
  listEl.querySelectorAll('[data-pick]').forEach(btn => {
    btn.addEventListener('click', () => {
      CalendarPrefs.setColorIndex(btn.dataset.pick, parseInt(btn.dataset.idx, 10));
      openPaletteFor = null;
      renderCalendarSettings();
    });
  });
  // 'change' rather than 'input': it fires once you've finished, so re-rendering
  // the list can't yank the keyboard away mid-word.
  listEl.querySelectorAll('[data-nickname]').forEach(input => {
    input.addEventListener('change', () => {
      CalendarPrefs.setName(input.dataset.nickname, input.value);
      renderCalendarSettings();
    });
  });
  listEl.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', () => { CalendarPrefs.toggleHidden(btn.dataset.toggle); renderCalendarSettings(); });
  });
}
document.getElementById('saveSettingsBtn').addEventListener('click', () => {
  Settings.url = document.getElementById('vercelUrl').value.trim();
  Settings.secret = document.getElementById('appSecret').value.trim();
  renderSyncStatus();
});
document.getElementById('syncNowBtn').addEventListener('click', syncAll);

// ---------- tab switching ----------
const TAB_TITLES = {
  // The date lives in the day-nav now, the way the month label lives in its
  // own nav — no point printing it twice.
  today: () => [todayViewDate === today() ? 'Today' : 'Journal', ''],
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

  // One-time migration: habits created before cross-device sync existed have
  // never been pushed to GitHub at all. Mark them dirty so the next sync
  // creates their habits/<id>.md file.
  const existingHabits = await getAll('habits');
  for (const h of existingHabits) {
    if (h.dirty === undefined) {
      h.dirty = true;
      if (h.deleted === undefined) h.deleted = false;
      if (h.remotePath === undefined) h.remotePath = null;
      await put('habits', h);
    }
  }

  renderActiveTab(); // paint immediately from local data, don't block on network

  if (Settings.url && Settings.secret) {
    pullFromGitHub().then(() => renderActiveTab()); // refresh once pull completes
  }

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW registration failed', e); }
  }
})();
