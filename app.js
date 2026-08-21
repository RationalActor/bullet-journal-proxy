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
    const req = indexedDB.open('bulletJournalDB', 5);
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
      // v4: collections, and the undated items created inside one. Entries
      // migrated into a collection stay in the entries store and just carry a
      // collection id, so a day's log keeps its record of what was written.
      if (!d.objectStoreNames.contains('collections')) {
        d.createObjectStore('collections', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('collectionItems')) {
        const s = d.createObjectStore('collectionItems', { keyPath: 'id' });
        s.createIndex('collectionId', 'collectionId');
      }
      // v5: the shared family task list. Lives under family/ in the repo, which
      // is the only subtree the second person's secret can reach — the isolation
      // is enforced by the proxy, not by this app choosing not to look.
      if (!d.objectStoreNames.contains('familyTasks')) {
        const s = d.createObjectStore('familyTasks', { keyPath: 'id' });
        s.createIndex('assignee', 'assignee');
      }
      // Assignees and categories are data, not constants, so the list can grow
      // without a deploy. One record, replaced wholesale.
      if (!d.objectStoreNames.contains('familyConfig')) {
        d.createObjectStore('familyConfig', { keyPath: 'id' });
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

// ---------- privacy: encrypt what leaves for GitHub ----------
// Content marked private is encrypted before it's written to the repo and
// decrypted on the way back, so GitHub and Vercel only ever hold ciphertext.
// What stays on this device stays plaintext — the threat model here is the
// platforms, not a stolen phone, and the app should never lock you out of
// reading your own journal offline.
//
// A random master key does the encrypting. It's wrapped by a passphrase-derived
// key and the wrapped copy lives in the repo, so a new device only needs the
// passphrase. Keeping the master key separate from the passphrase means the
// passphrase can be changed later without re-encrypting a year of entries.
//
// Because local storage is plaintext anyway, caching the unwrapped key on the
// device gives nothing away that isn't already sitting beside it.

const ENC_PREFIX = 'enc:v1:';
const KEYINFO_PATH = 'crypto/keyinfo.md';
const PBKDF2_ITERATIONS = 310000;

function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64ToBytes(str) {
  const s = atob(str);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
function isEncrypted(v) { return typeof v === 'string' && v.startsWith(ENC_PREFIX); }

const Privacy = {
  masterKey: null,     // CryptoKey once unlocked
  keyInfo: null,       // { salt, iterations, wrapped, remotePath } from the repo

  get unlocked() { return !!this.masterKey; },
  // Holding the key counts as configured even before a pull has fetched the
  // key file — otherwise the private toggles vanish when you're offline.
  get configured() { return !!this.keyInfo || !!this.masterKey; },

  async deriveWrappingKey(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  },

  // iv is prepended to the ciphertext; AES-GCM's auth tag is what tells us a
  // wrong key was used, so no separate verifier is needed anywhere.
  async encryptWith(key, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    const out = new Uint8Array(iv.length + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), iv.length);
    return ENC_PREFIX + bytesToB64(out);
  },

  async decryptWith(key, payload) {
    const raw = b64ToBytes(payload.slice(ENC_PREFIX.length));
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12)
    );
    return new TextDecoder().decode(pt);
  },

  encrypt(text) { return this.encryptWith(this.masterKey, text); },
  decrypt(payload) { return this.decryptWith(this.masterKey, payload); },

  async importRawKey(bytes) {
    return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  },

  // Cached locally so you're not retyping a passphrase to protect content that
  // sits in plaintext in the same database.
  async remember() {
    const raw = await crypto.subtle.exportKey('raw', this.masterKey);
    localStorage.setItem('bj_masterKey', bytesToB64(raw));
  },
  forget() {
    localStorage.removeItem('bj_masterKey');
    this.masterKey = null;
  },
  // The key file is cached locally too. Without that, setting up privacy while
  // offline and then reloading would lose the wrapped key before it ever
  // reached the repo — leaving content only this one device could ever read.
  saveKeyInfoLocally() {
    if (this.keyInfo) localStorage.setItem('bj_keyInfo', JSON.stringify(this.keyInfo));
  },

  async restore() {
    try {
      const cached = localStorage.getItem('bj_keyInfo');
      if (cached) this.keyInfo = JSON.parse(cached);
    } catch (e) {
      localStorage.removeItem('bj_keyInfo');
    }
    const stored = localStorage.getItem('bj_masterKey');
    if (!stored) return false;
    try {
      this.masterKey = await this.importRawKey(b64ToBytes(stored));
      return true;
    } catch (e) {
      localStorage.removeItem('bj_masterKey');
      return false;
    }
  },

  // First-time setup: mint a master key and wrap it with the passphrase.
  async initialise(passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const master = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const kek = await this.deriveWrappingKey(passphrase, salt, PBKDF2_ITERATIONS);
    const rawMaster = await crypto.subtle.exportKey('raw', master);
    const wrapped = await this.encryptWith(kek, bytesToB64(rawMaster));

    this.masterKey = master;
    this.keyInfo = {
      salt: bytesToB64(salt),
      iterations: PBKDF2_ITERATIONS,
      wrapped,
      // A known string under the master key. Nothing else can tell a correct
      // recovery key from a wrong one, and silently accepting a wrong one would
      // encrypt content that could never be read back.
      probe: await this.encryptWith(master, 'bullet-journal-probe-v1'),
      remotePath: null,
      dirty: true,
    };
    await this.remember();
    this.saveKeyInfoLocally();
  },

  async unlock(passphrase) {
    if (!this.keyInfo) throw new Error('No key set up yet');
    const kek = await this.deriveWrappingKey(
      passphrase, b64ToBytes(this.keyInfo.salt), this.keyInfo.iterations
    );
    // Throws on the wrong passphrase — the GCM tag won't verify.
    const rawB64 = await this.decryptWith(kek, this.keyInfo.wrapped);
    this.masterKey = await this.importRawKey(b64ToBytes(rawB64));
    await this.remember();
  },

  // A written-down fallback, so a forgotten passphrase isn't the end of it.
  async recoveryKey() {
    const raw = await crypto.subtle.exportKey('raw', this.masterKey);
    return bytesToB64(raw);
  },
  async unlockWithRecoveryKey(keyB64) {
    const candidate = await this.importRawKey(b64ToBytes(keyB64.trim()));
    // Prove it before trusting it — throws if the probe won't decrypt.
    if (this.keyInfo && this.keyInfo.probe) {
      await this.decryptWith(candidate, this.keyInfo.probe);
    }
    this.masterKey = candidate;
    await this.remember();
  },

  keyInfoMarkdown() {
    return `---\ntype: key-info\nversion: 1\nkdf: PBKDF2-SHA256\niterations: ${this.keyInfo.iterations}\n` +
      `salt: ${this.keyInfo.salt}\nwrapped: ${this.keyInfo.wrapped}\n` +
      (this.keyInfo.probe ? `probe: ${this.keyInfo.probe}\n` : '') + `---\n` +
      `Wrapped content key for this journal. Do not edit by hand — losing this file, ` +
      `or the passphrase that unwraps it, makes private entries unreadable forever.\n`;
  },
};

// ---------- markdown formatting (matches the existing repo convention) ----------
async function entryToMarkdown(e) {
  let fm = `---\ntype: ${e.type}\ntimestamp: ${e.date}T${e.time}\nreviewed: true\n`;
  if (e.type === 'task') fm += `done: ${!!e.done}\n`;
  if (e.collection) fm += `collection: ${e.collection}\n`;
  if (e.private) fm += `private: true\n`;
  if (e.type === 'gratitude' && e.prompt) fm += `prompt: "${e.prompt.replace(/"/g, '\\"')}"\n`;
  if (e.deleted) fm += `deleted: true\n`;
  fm += `---\n${e.private ? await Privacy.encrypt(e.content) : e.content}\n`;
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

// A private collection's name is encrypted too — "Therapy" sitting in plaintext
// would give away most of what the encryption was for.
async function collectionToMarkdown(c) {
  const name = c.private ? await Privacy.encrypt(c.name) : c.name;
  return `---\ntype: collection\nname: ${name}\n` +
    (c.private ? 'private: true\n' : '') +
    `deleted: ${!!c.deleted}\n---\n${c.private ? '(private)' : c.name}\n`;
}
function collectionPath(c) { return `collections/${c.id}.md`; }

// Kept in a flat folder rather than nested under the collection, so a pull is
// one request regardless of how many collections exist.
async function collectionItemToMarkdown(it) {
  let fm = `---\ntype: collection-item\ncollection: ${it.collectionId}\nitem_type: ${it.type}\ncreated: ${it.created}\n`;
  if (it.type === 'task') fm += `done: ${!!it.done}\n`;
  if (it.private) fm += `private: true\n`;
  if (it.deleted) fm += `deleted: true\n`;
  fm += `---\n${it.private ? await Privacy.encrypt(it.content) : it.content}\n`;
  return fm;
}
function collectionItemPath(it) { return `collection-items/${it.id}.md`; }

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

// One meeting invited to several of your accounts arrives once per account,
// with a different calendar name each time. Same instant, same title — so
// collapse them into a single row that carries every calendar it came from,
// rather than showing the same appointment three times over.
//
// Runs after the visibility filter, so a merged row only ever shows colours for
// calendars you haven't hidden.
function mergeDuplicateAppointments(list) {
  const byKey = new Map();
  for (const ev of list) {
    const key = [
      ev.date, ev.start, ev.end,
      ev.allDay ? 1 : 0,
      ev.continued ? 1 : 0,
      ev.title.trim().toLowerCase().replace(/\s+/g, ' '),
    ].join('|');

    const hit = byKey.get(key);
    if (hit) {
      if (!hit.calendars.includes(ev.calendar)) hit.calendars.push(ev.calendar);
    } else {
      byKey.set(key, { ...ev, calendars: [ev.calendar] });
    }
  }
  return [...byKey.values()];
}

function appointmentsForDay(snapshot, date) {
  return sortAppointments(mergeDuplicateAppointments(
    visibleCalendarEvents(snapshot).filter(e => e.date === date)
  ));
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
  const cals = ev.calendars || [ev.calendar];
  // Always drawn from CAL_PALETTE, never from user text, so it's safe inline.
  const colors = cals.map(c => CalendarPrefs.colorFor(c));

  // One colour fills the dot; several slice it into equal wedges, so a meeting
  // sitting on two accounts reads as one appointment wearing two colours rather
  // than as two appointments.
  const slice = 100 / colors.length;
  const dot = colors.length === 1
    ? `background:${colors[0]}`
    : `background:conic-gradient(${colors
        .map((c, i) => `${c} ${(i * slice).toFixed(2)}% ${((i + 1) * slice).toFixed(2)}%`)
        .join(',')})`;

  let when;
  if (ev.allDay) when = 'all day';
  else if (ev.continued) when = '···';
  else if (showRange && ev.end) when = `${ev.start}–${ev.end}`;
  else when = ev.start.replace(/^0/, '');

  const label = cals.map(c => CalendarPrefs.labelFor(c)).join(' · ');
  // Single-calendar rows keep their colour on the label; a merged row has no
  // one colour to use, so it stays neutral and lets the dot do the talking.
  const labelStyle = colors.length === 1 ? ` style="color:${colors[0]}"` : '';

  return `
    <div class="appt-row">
      <span class="appt-dot" style="${dot}"></span>
      <span class="appt-when">${escapeHtml(when)}</span>
      <span class="appt-title">${escapeHtml(ev.title)}</span>
      <span class="appt-cal"${labelStyle} title="${escapeHtml(cals.join(', '))}">${escapeHtml(label)}</span>
    </div>`;
}

// ---------- family tasks ----------
// Shared with a second person, so two things differ from everything else here:
// writes carry the sha they were based on (see syncOne) and the list is stored
// under family/, the only subtree the family secret can reach.

const FAMILY_TASKS_DIR = 'family/tasks';
const FAMILY_CONFIG_PATH = 'family/config.md';

const DEFAULT_FAMILY_CONFIG = {
  assignees: [
    { id: 'michael', name: 'Michael' },
    { id: 'liz', name: 'Liz' },
    { id: 'shared', name: 'Shared' },
  ],
  categories: [
    { id: 'desk', name: 'Desk' },
    { id: 'house', name: 'House' },
    { id: 'charlotte', name: 'Charlotte' },
    { id: 'other', name: 'Other' },
  ],
};

const IMPORTANCE_LEVELS = [
  { id: 'low', name: 'Low', weight: 1 },
  { id: 'normal', name: 'Normal', weight: 2 },
  { id: 'high', name: 'High', weight: 3 },
];

function importanceWeight(id) {
  const level = IMPORTANCE_LEVELS.find(l => l.id === id);
  return level ? level.weight : 2;
}

// Days until due, negative once overdue. Dates are compared at local midnight so
// "due today" doesn't flip at an arbitrary hour.
function daysUntil(deadline) {
  if (!deadline) return null;
  const due = new Date(deadline + 'T00:00:00');
  if (isNaN(due.getTime())) return null;
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - midnight) / 86400000);
}

// Importance is the primary axis; the deadline amplifies rather than replaces
// it. Weighting importance ×3 against a pressure term capped at 5 means a
// high-importance task with no date (9) still outranks any low-importance task
// however overdue (max 8) — while a merely normal task that's slipped past its
// date (11) does climb above it, because overdue things genuinely nag.
function deadlinePressure(deadline) {
  const d = daysUntil(deadline);
  if (d === null) return 0;
  if (d < 0) return 5;
  if (d <= 1) return 4;
  if (d <= 3) return 3;
  if (d <= 7) return 2;
  if (d <= 14) return 1;
  return 0;
}

function taskScore(t) {
  return importanceWeight(t.importance) * 3 + deadlinePressure(t.deadline);
}

function taskBand(t) {
  const s = taskScore(t);
  if (s >= 12) return { id: 'critical', name: 'Critical' };
  if (s >= 9) return { id: 'high', name: 'High' };
  if (s >= 6) return { id: 'medium', name: 'Medium' };
  return { id: 'low', name: 'Low' };
}

function deadlineLabel(deadline) {
  const d = daysUntil(deadline);
  if (d === null) return '';
  if (d < -1) return `${Math.abs(d)} days overdue`;
  if (d === -1) return 'yesterday';
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d <= 14) return `in ${d} days`;
  return new Date(deadline + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function familyTaskToMarkdown(t) {
  let fm = `---\ntype: family-task\n`;
  fm += `assignee: ${t.assignee}\ncategory: ${t.category}\nimportance: ${t.importance}\n`;
  if (t.deadline) fm += `deadline: ${t.deadline}\n`;
  fm += `done: ${!!t.done}\n`;
  fm += `created: ${t.created}\ncreated_by: ${t.createdBy}\n`;
  fm += `updated: ${t.updated}\nupdated_by: ${t.updatedBy}\n`;
  if (t.deleted) fm += `deleted: true\n`;
  fm += `---\n${t.content}\n`;
  return fm;
}
function familyTaskPath(t) { return `${FAMILY_TASKS_DIR}/${t.id}.md`; }

// JSON in the body rather than frontmatter: the frontmatter parser is a flat
// key/value reader and these are lists of objects.
function familyConfigToMarkdown(cfg) {
  return `---\ntype: family-config\nupdated: ${cfg.updated || ''}\n---\n${JSON.stringify({
    assignees: cfg.assignees, categories: cfg.categories,
  }, null, 2)}\n`;
}

async function getFamilyConfig() {
  const stored = await getById('familyConfig', 'config');
  if (stored && stored.assignees && stored.categories) return stored;
  return { id: 'config', ...DEFAULT_FAMILY_CONFIG, dirty: false, remotePath: null };
}

function nameFromList(list, id, fallback) {
  const hit = (list || []).find(x => x.id === id);
  return hit ? hit.name : (fallback || id || '—');
}

// ---------- sync: push local changes to GitHub ----------
// Returns 'ok', 'conflict', or 'failed'.
//
// detectConflicts is opt-in per store, and deliberately so. It's on for the
// family list, which genuinely has two writers and a screen for reconciling.
// The journal has one author across their own devices and no such screen, so
// turning it on there would only manufacture 409s nobody could clear.
async function syncOne({ store, record, path, markdown, detectConflicts }) {
  const headers = { 'Content-Type': 'application/json', 'x-app-secret': Settings.secret };
  const base = Settings.url.replace(/\/$/, '');
  try {
    if (record.remotePath) {
      const resp = await fetch(`${base}/api/entries`, {
        method: 'PUT', headers,
        body: JSON.stringify({
          path: record.remotePath,
          content: markdown,
          // Saying "I edited the version with this sha". Omitted entirely when
          // the store hasn't opted in, which leaves last-write-wins in place.
          baseSha: detectConflicts ? (record.remoteSha || undefined) : undefined,
        }),
      });

      // Someone else wrote this file since we last read it. Keep our version
      // dirty, park theirs alongside, and let a person decide — never flatten
      // work that isn't ours.
      if (resp.status === 409) {
        const data = await resp.json();
        record.conflict = {
          remoteContent: data.currentContent,
          remoteSha: data.currentSha,
          at: new Date().toISOString(),
        };
        record.dirty = true;
        await put(store, record);
        return 'conflict';
      }

      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ? JSON.stringify(data.error) : resp.statusText);
      if (detectConflicts) record.remoteSha = data.sha;
    } else {
      const resp = await fetch(`${base}/api/entries`, {
        method: 'POST', headers,
        body: JSON.stringify({ path, content: markdown }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ? JSON.stringify(data.error) : resp.statusText);
      record.remotePath = data.path;
      if (detectConflicts) record.remoteSha = data.sha;
    }
    record.dirty = false;
    record.conflict = null;
    await put(store, record);
    return 'ok';
  } catch (err) {
    console.error('sync failed for', store, record.id, err);
    return 'failed';
  }
}

async function syncAll() {
  const statusEl = document.getElementById('syncStatus');
  if (!Settings.url || !Settings.secret) {
    statusEl.textContent = 'Add your proxy URL and app secret above, then save, before syncing.';
    return;
  }
  statusEl.textContent = 'Syncing…';

  const [entries, habits, habitOccs, collections, collectionItems, familyTasks, familyCfg] = await Promise.all([
    getAll('entries'), getAll('habits'), getAll('habitOccurrences'),
    getAll('collections'), getAll('collectionItems'), getAll('familyTasks'), getFamilyConfig(),
  ]);
  const habitById = Object.fromEntries(habits.map(h => [h.id, h]));

  // Two records must never go out: one marked private while we're locked (we'd
  // upload the very plaintext we promised to encrypt), and one pulled encrypted
  // that this device could never read (we'd overwrite ciphertext with a blank).
  // Both simply stay dirty and go on a later, unlocked sync.
  let heldBack = 0;
  const sendable = (r) => {
    if (r.locked) { heldBack++; return false; }
    if (r.private && !Privacy.unlocked) { heldBack++; return false; }
    return true;
  };

  const dirtyEntries = entries.filter(e => e.dirty && sendable(e));
  const dirtyOccs = habitOccs.filter(o => o.dirty && habitById[o.habitId]);
  const dirtyHabits = habits.filter(h => h.dirty);
  const dirtyCollections = collections.filter(c => c.dirty && sendable(c));
  const dirtyItems = collectionItems.filter(i => i.dirty && sendable(i));

  const dirtyTasks = familyTasks.filter(t => t.dirty);

  let okCount = 0, failCount = 0, conflictCount = 0;
  // syncOne answers with a word, not a boolean — 'failed' is truthy and would
  // otherwise be counted as a success.
  const tally = (r) => {
    if (r === 'ok') okCount++;
    else if (r === 'conflict') conflictCount++;
    else failCount++;
  };

  // The wrapped key goes first: without it in the repo, encrypted content that
  // followed would be unreadable on every other device.
  if (Privacy.keyInfo && Privacy.keyInfo.dirty) {
    try {
      const resp = await fetch(`${Settings.url.replace(/\/$/, '')}/api/entries`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-app-secret': Settings.secret },
        body: JSON.stringify({ path: KEYINFO_PATH, content: Privacy.keyInfoMarkdown() }),
      });
      if (!resp.ok) throw new Error(resp.statusText);
      Privacy.keyInfo.dirty = false;
      Privacy.keyInfo.remotePath = KEYINFO_PATH;
      Privacy.saveKeyInfoLocally();
      okCount++;
    } catch (err) {
      console.error('key info sync failed', err);
      failCount++;
    }
  }

  for (const h of dirtyHabits) {
    const path = h.remotePath || habitDefPath(h);
    tally(await syncOne({ store: 'habits', record: h, path, markdown: await habitToMarkdown(h) }));
  }
  // Definitions before their items, so a pull elsewhere never meets an item
  // whose collection doesn't exist yet.
  for (const c of dirtyCollections) {
    const path = c.remotePath || collectionPath(c);
    tally(await syncOne({ store: 'collections', record: c, path, markdown: await collectionToMarkdown(c) }));
  }
  for (const it of dirtyItems) {
    const path = it.remotePath || collectionItemPath(it);
    tally(await syncOne({ store: 'collectionItems', record: it, path, markdown: await collectionItemToMarkdown(it) }));
  }
  for (const e of dirtyEntries) {
    const path = e.remotePath || entryPath(e);
    tally(await syncOne({ store: 'entries', record: e, path, markdown: await entryToMarkdown(e) }));
  }
  for (const o of dirtyOccs) {
    const habit = habitById[o.habitId];
    const path = o.remotePath || habitOccPath(o, habit);
    tally(await syncOne({ store: 'habitOccurrences', record: o, path, markdown: await habitOccToMarkdown(o, habit) }));
  }
  // Config before tasks, so a task naming a freshly added category doesn't
  // arrive somewhere that can't render it.
  if (familyCfg.dirty) {
    tally(await syncOne({
      store: 'familyConfig', record: familyCfg,
      path: familyCfg.remotePath || FAMILY_CONFIG_PATH,
      markdown: familyConfigToMarkdown(familyCfg),
      detectConflicts: true,
    }));
  }
  for (const t of dirtyTasks) {
    const path = t.remotePath || familyTaskPath(t);
    tally(await syncOne({
      store: 'familyTasks', record: t, path,
      markdown: familyTaskToMarkdown(t),
      detectConflicts: true,
    }));
  }

  // Pull as well as push, so "Sync now" is a full round-trip — that's what
  // refreshes the calendar mirror after the shortcut has run on the phone.
  await pullFromGitHub();

  Settings.lastSync = new Date().toLocaleString();
  renderSyncStatus();
  if (failCount > 0) {
    statusEl.textContent += ` Done, but ${failCount} item(s) couldn't sync (no connection?) — they'll retry next time.`;
  }
  if (heldBack > 0) {
    statusEl.textContent += ` ${heldBack} private item(s) held back — unlock private content below to send them.`;
  }
  if (conflictCount > 0) {
    statusEl.textContent += ` ${conflictCount} item(s) were changed elsewhere and need reconciling — see the Family tab.`;
  }
  renderActiveTab();
}

async function renderSyncStatus() {
  const [entries, habitOccs, habits, collections, collectionItems] = await Promise.all([
    getAll('entries'), getAll('habitOccurrences'), getAll('habits'),
    getAll('collections'), getAll('collectionItems'),
  ]);
  const pending = [entries, habitOccs, habits, collections, collectionItems]
    .reduce((n, store) => n + store.filter(r => r.dirty).length, 0);
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
    // ---- wrapped content key (crypto/keyinfo.md) ----
    // Fetched before anything else, so encrypted records arriving below can be
    // opened straight away on a device that already knows the passphrase.
    const keyResp = await fetch(`${base}/api/entries?folder=crypto`, { headers });
    if (keyResp.ok) {
      const keyData = await keyResp.json();
      const keyFile = (keyData.entries || []).find(f => f.filename === 'keyinfo.md');
      if (keyFile && !(Privacy.keyInfo && Privacy.keyInfo.dirty)) {
        const { fields } = parseFrontmatter(keyFile.raw);
        if (fields.salt && fields.wrapped) {
          Privacy.keyInfo = {
            salt: fields.salt,
            iterations: parseInt(fields.iterations, 10) || PBKDF2_ITERATIONS,
            wrapped: fields.wrapped,
            probe: fields.probe || null,
            remotePath: keyFile.path,
            dirty: false,
          };
          Privacy.saveKeyInfoLocally();
        }
      }
    }

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

    // ---- family config (family/config.md) ----
    const famCfgResp = await fetch(`${base}/api/entries?folder=family`, { headers });
    if (famCfgResp.ok) {
      const famCfgData = await famCfgResp.json();
      const cfgFile = (famCfgData.entries || []).find(f => f.filename === 'config.md');
      const localCfg = await getById('familyConfig', 'config');
      if (cfgFile && !(localCfg && localCfg.dirty)) {
        const { fields, body } = parseFrontmatter(cfgFile.raw);
        try {
          const parsed = JSON.parse(body);
          await put('familyConfig', {
            id: 'config',
            assignees: parsed.assignees || DEFAULT_FAMILY_CONFIG.assignees,
            categories: parsed.categories || DEFAULT_FAMILY_CONFIG.categories,
            updated: fields.updated || '',
            dirty: false,
            remotePath: cfgFile.path,
            remoteSha: cfgFile.sha,
          });
        } catch (e) {
          console.warn('family config is not valid JSON, keeping the local copy');
        }
      }
    }

    // ---- family tasks (family/tasks/<id>.md) ----
    const tasksResp = await fetch(`${base}/api/entries?folder=${FAMILY_TASKS_DIR}`, { headers });
    if (tasksResp.ok) {
      const tasksData = await tasksResp.json();
      for (const item of tasksData.entries || []) {
        const id = item.filename.replace(/\.md$/, '');
        const localExisting = await getById('familyTasks', id);
        // A local edit that hasn't gone out yet wins for now; if the remote also
        // moved, the push will come back 409 and be reconciled deliberately.
        if (localExisting && localExisting.dirty) continue;
        const { fields, body } = parseFrontmatter(item.raw);
        await put('familyTasks', {
          id,
          content: body,
          assignee: fields.assignee || 'shared',
          category: fields.category || 'other',
          importance: fields.importance || 'normal',
          deadline: fields.deadline || null,
          done: fields.done === 'true',
          created: fields.created || '',
          createdBy: fields.created_by || '',
          updated: fields.updated || '',
          updatedBy: fields.updated_by || '',
          deleted: fields.deleted === 'true',
          dirty: false,
          conflict: null,
          remotePath: item.path,
          remoteSha: item.sha,
        });
      }
    }

    // ---- collections (collections/<id>.md) ----
    const colResp = await fetch(`${base}/api/entries?folder=collections`, { headers });
    if (colResp.ok) {
      const colData = await colResp.json();
      for (const item of colData.entries || []) {
        const id = item.filename.replace(/\.md$/, '');
        const { fields } = parseFrontmatter(item.raw);
        const localExisting = await getById('collections', id);
        if (localExisting && localExisting.dirty) continue; // local pending edit wins
        const name = await openPrivateField(fields.name || '');
        await put('collections', {
          id,
          name: name.locked ? '' : (name.value || (localExisting ? localExisting.name : '(untitled)')),
          private: name.private || fields.private === 'true',
          locked: name.locked,
          cipher: name.cipher,
          deleted: fields.deleted === 'true',
          dirty: false,
          remotePath: item.path,
        });
      }
    }

    // ---- collection items (collection-items/<id>.md) ----
    const itemsResp = await fetch(`${base}/api/entries?folder=collection-items`, { headers });
    if (itemsResp.ok) {
      const itemsData = await itemsResp.json();
      for (const item of itemsData.entries || []) {
        const id = item.filename.replace(/\.md$/, '');
        const { fields, body } = parseFrontmatter(item.raw);
        const localExisting = await getById('collectionItems', id);
        if (localExisting && localExisting.dirty) continue;
        const opened = await openPrivateField(body);
        await put('collectionItems', {
          id,
          collectionId: fields.collection || '',
          type: fields.item_type || 'task',
          content: opened.value,
          private: opened.private || fields.private === 'true',
          locked: opened.locked,
          cipher: opened.cipher,
          done: fields.done === 'true',
          created: fields.created || '',
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
          const opened = await openPrivateField(body);
          rec.date = dateFolder;
          rec.time = time;
          rec.type = fields.type || 'note';
          rec.content = opened.value;
          rec.private = opened.private || fields.private === 'true';
          rec.locked = opened.locked;
          rec.cipher = opened.cipher;
          if (rec.type === 'task') rec.done = fields.done === 'true';
          if (rec.type === 'gratitude' && fields.prompt) rec.prompt = fields.prompt;
          rec.collection = fields.collection || null;
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

// Open an encrypted field if we hold the key. If we don't, keep the ciphertext
// verbatim and mark the record locked: a device without the passphrase must be
// able to hold private content without being able to destroy it.
async function openPrivateField(raw) {
  if (!isEncrypted(raw)) return { value: raw, private: false, locked: false, cipher: null };
  if (Privacy.unlocked) {
    try {
      return { value: await Privacy.decrypt(raw), private: true, locked: false, cipher: null };
    } catch (e) {
      console.warn('could not decrypt with the current key');
    }
  }
  return { value: '', private: true, locked: true, cipher: raw };
}

// After unlocking, go back over everything held as ciphertext and open it.
async function openLockedRecords() {
  const jobs = [
    { store: 'entries', field: 'content' },
    { store: 'collectionItems', field: 'content' },
    { store: 'collections', field: 'name' },
  ];
  let opened = 0;
  for (const { store, field } of jobs) {
    for (const rec of await getAll(store)) {
      if (!rec.locked || !rec.cipher) continue;
      try {
        rec[field] = await Privacy.decrypt(rec.cipher);
        rec.locked = false;
        rec.cipher = null;
        await put(store, rec); // still not dirty — nothing changed upstream
        opened++;
      } catch (e) {
        // Wrong key for this record; leave it sealed rather than blanking it.
      }
    }
  }
  return opened;
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
function entryEditFormHtml(e, collections) {
  // Filing an entry into a collection is migration: it keeps its date and stays
  // in the day it was written, and also surfaces in the collection.
  const options = ['<option value="">— no collection —</option>'].concat(
    collections.filter(c => !c.deleted)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(c => `<option value="${c.id}"${e.collection === c.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`)
  );
  return `
    <div class="inline-form entry-edit">
      <input type="text" id="editContent-${e.id}" value="${escapeHtml(e.content)}" />
      <input type="time" id="editTime-${e.id}" value="${e.time}" step="1" />
      ${collections.some(c => !c.deleted)
        ? `<select id="editCollection-${e.id}">${options.join('')}</select>` : ''}
      ${Privacy.configured ? `
        <label class="check-row">
          <input type="checkbox" id="editPrivate-${e.id}"${e.private ? ' checked' : ''} />
          <span>Private — encrypt before it leaves this device</span>
        </label>` : ''}
      <div class="form-actions">
        <button class="save" id="editSave-${e.id}">Save</button>
        <button id="editCancel-${e.id}">Cancel</button>
      </div>
    </div>`;
}

async function renderEntryList(container, targetDate) {
  const range = IDBKeyRange.only(targetDate);
  const [rawEntries, habitOccs, habits, collections] = await Promise.all([
    getAllByIndex('entries', 'date', range),
    getAllByIndex('habitOccurrences', 'date', range),
    getAll('habits'),
    getAll('collections'),
  ]);
  const entries = rawEntries.filter(e => e.type !== 'gratitude' && !e.deleted); // gratitude lives in its own tab
  const habitById = Object.fromEntries(habits.map(h => [h.id, h]));
  const collectionById = Object.fromEntries(collections.map(c => [c.id, c]));

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
      // Sealed on this device: shown, but not editable and not deletable, so it
      // can't be overwritten by a device that can't read it.
      if (e.locked) {
        return `
          <div class="entry-row locked-row">
            <div class="entry-symbol">🔒</div>
            <div class="entry-body">
              <div class="entry-content locked-content">Private — unlock in Settings to read</div>
              <div class="entry-time">${e.time.slice(0, 5)}</div>
            </div>
          </div>`;
      }
      if (e.id === editingEntryId) return entryEditFormHtml(e, collections);
      const filedIn = e.collection && collectionById[e.collection] && !collectionById[e.collection].deleted
        ? collectionById[e.collection].name : null;
      return `
        <div class="entry-row" data-id="${e.id}">
          <div class="entry-symbol" data-id="${e.id}">${e.type === 'task' ? (e.done ? '✓' : '▢') : SYMBOLS[e.type]}</div>
          <div class="entry-body" data-editentry="${e.id}">
            <div class="entry-content ${e.type === 'task' && e.done ? 'done' : ''}">${escapeHtml(e.content)}</div>
            <div class="entry-time">
              ${e.time.slice(0, 5)}
              ${filedIn ? `<span class="entry-collection">${escapeHtml(filedIn)}</span>` : ''}
            </div>
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
        const collectionSelect = container.querySelector(`#editCollection-${editingEntryId}`);
        const privateBox = container.querySelector(`#editPrivate-${editingEntryId}`);
        entry.content = text;
        entry.time = t;
        if (collectionSelect) entry.collection = collectionSelect.value || null;
        if (privateBox) entry.private = privateBox.checked;
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
  const appts = appointmentsForDay(snapshot, todayViewDate);
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
    const dayAppts = appointmentsForDay(snapshot, selectedDate);
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
  // Merged per day rather than across the month, so a weekly meeting stays one
  // row per occurrence instead of collapsing into a single entry.
  mergeDuplicateAppointments(monthAppts).forEach(e => {
    (byDate[e.date] = byDate[e.date] || []).push(e);
  });

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

// ---------- Collections tab ----------
// A collection is a themed page — a reading list, a trip, a project. Two kinds
// of thing end up in one, and they're stored differently on purpose.
//
// Items created here are undated and live in their own store, so filing twenty
// books doesn't flood today's log with twenty entries. Entries migrated from the
// daily log stay entries and keep their date: the day's record shouldn't develop
// holes because you later decided something belonged to a project. The
// collection view merges both in chronological order.
let openCollectionId = null;
let collectionFormOpen = false;
let editingCollectionId = null;
let editingItemId = null;
let collectionAddMode = 'task'; // collections skew towards lists of things to do

async function renderCollectionsTab() {
  if (openCollectionId) await renderCollectionDetail();
  else await renderCollectionsList();
}

// Marking a collection private encrypts its name as well as its contents —
// "Therapy" sitting in plaintext would give away most of the point.
function privateCheckHtml(id, checked) {
  if (!Privacy.configured) return '';
  return `
    <label class="check-row">
      <input type="checkbox" id="${id}"${checked ? ' checked' : ''} />
      <span>Private — encrypt this collection and everything in it</span>
    </label>`;
}

function collectionFormHtml() {
  return `
    <div class="inline-form">
      <input type="text" placeholder="Collection name" id="collectionName" />
      ${privateCheckHtml('collectionPrivate', false)}
      <div class="form-actions">
        <button class="save" id="collectionSave">Add</button>
        <button id="collectionCancel">Cancel</button>
      </div>
    </div>`;
}

function collectionEditFormHtml(c) {
  return `
    <div class="inline-form">
      <input type="text" value="${escapeHtml(c.name)}" id="collectionEditName-${c.id}" />
      ${privateCheckHtml(`collectionEditPrivate-${c.id}`, c.private)}
      <div class="form-actions">
        <button class="save" id="collectionEditSave-${c.id}">Save</button>
        <button id="collectionEditCancel-${c.id}">Cancel</button>
      </div>
      <button class="habit-delete-btn" id="collectionEditDelete-${c.id}">Delete collection</button>
    </div>`;
}

async function renderCollectionsList() {
  document.getElementById('collection-detail-slot').innerHTML = '';
  const slot = document.getElementById('collections-list-slot');

  const [collections, items, entries] = await Promise.all([
    getAll('collections'), getAll('collectionItems'), getAll('entries'),
  ]);
  const live = collections.filter(c => !c.deleted).sort((a, b) => a.name.localeCompare(b.name));
  const countFor = (id) =>
    items.filter(i => !i.deleted && i.collectionId === id).length +
    entries.filter(e => !e.deleted && e.collection === id).length;

  const cards = live.map(c => {
    if (editingCollectionId === c.id) return collectionEditFormHtml(c);
    if (c.locked) {
      return `
        <div class="collection-card locked-row">
          <div class="collection-name locked-content">🔒 Private collection</div>
          <div class="collection-meta"><span class="collection-count">—</span></div>
        </div>`;
    }
    return `
      <div class="collection-card" data-open="${c.id}">
        <div class="collection-name">${c.private ? '🔒 ' : ''}${escapeHtml(c.name)}</div>
        <div class="collection-meta">
          <span class="collection-count">${countFor(c.id)}</span>
          <button class="habit-edit-btn" data-editcollection="${c.id}">Edit</button>
        </div>
      </div>`;
  }).join('');

  slot.innerHTML = `
    <div class="section-row">
      <h2>Collections</h2>
      <button class="link-btn" id="addCollectionBtn">+ Add</button>
    </div>
    ${collectionFormOpen ? collectionFormHtml() : ''}
    ${live.length === 0 && !collectionFormOpen
      ? `<div class="empty-state">No collections yet — a collection is a themed page, like a reading list, a trip, or a project.</div>`
      : cards}`;

  document.getElementById('addCollectionBtn').addEventListener('click', () => {
    collectionFormOpen = true;
    editingCollectionId = null;
    renderCollectionsTab();
  });

  if (collectionFormOpen) {
    const nameInput = document.getElementById('collectionName');
    async function saveNew() {
      const name = nameInput.value.trim();
      if (!name) return;
      const priv = document.getElementById('collectionPrivate');
      await put('collections', {
        id: uid(), name, private: !!(priv && priv.checked),
        deleted: false, dirty: true, remotePath: null,
      });
      collectionFormOpen = false;
      renderCollectionsTab();
    }
    document.getElementById('collectionSave').addEventListener('click', saveNew);
    nameInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') saveNew(); });
    document.getElementById('collectionCancel').addEventListener('click', () => {
      collectionFormOpen = false;
      renderCollectionsTab();
    });
  }

  slot.querySelectorAll('[data-open]').forEach(card => {
    card.addEventListener('click', () => {
      openCollectionId = card.dataset.open;
      renderCollectionsTab();
    });
  });
  slot.querySelectorAll('[data-editcollection]').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation(); // the whole card opens the collection; this button must not
      editingCollectionId = btn.dataset.editcollection;
      collectionFormOpen = false;
      renderCollectionsTab();
    });
  });

  if (editingCollectionId) {
    const id = editingCollectionId;
    const saveBtn = document.getElementById(`collectionEditSave-${id}`);
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const c = collections.find(x => x.id === id);
        const name = document.getElementById(`collectionEditName-${id}`).value.trim();
        if (!c || !name) return;
        const priv = document.getElementById(`collectionEditPrivate-${id}`);
        const isPrivate = priv ? priv.checked : !!c.private;
        await put('collections', { ...c, name, private: isPrivate, dirty: true });
        // Items inherit the collection's privacy, so flipping it re-encrypts (or
        // decrypts) everything filed there on the next sync.
        for (const it of items.filter(i => i.collectionId === id && !i.deleted && !i.locked)) {
          if (!!it.private !== isPrivate) await put('collectionItems', { ...it, private: isPrivate, dirty: true });
        }
        editingCollectionId = null;
        renderCollectionsTab();
      });
      document.getElementById(`collectionEditCancel-${id}`).addEventListener('click', () => {
        editingCollectionId = null;
        renderCollectionsTab();
      });
      document.getElementById(`collectionEditDelete-${id}`).addEventListener('click', async () => {
        const c = collections.find(x => x.id === id);
        const ok = confirm(`Delete "${c ? c.name : 'this collection'}"? Items created in it will go too. Entries you migrated here stay in their daily logs.`);
        if (!ok) return;
        // Items created in the collection die with it; migrated entries are only
        // unfiled, since they belong to their day first.
        for (const it of items.filter(i => i.collectionId === id && !i.deleted)) {
          await markDeleted('collectionItems', it.id);
        }
        for (const e of entries.filter(x => x.collection === id && !x.deleted)) {
          await put('entries', { ...e, collection: null, dirty: true });
        }
        await markDeleted('collections', id);
        editingCollectionId = null;
        renderCollectionsTab();
      });
    }
  }
}

async function renderCollectionDetail() {
  document.getElementById('collections-list-slot').innerHTML = '';
  const slot = document.getElementById('collection-detail-slot');

  const collection = await getById('collections', openCollectionId);
  if (!collection || collection.deleted) { // deleted on another device
    openCollectionId = null;
    return renderCollectionsList();
  }

  const [allItems, allEntries] = await Promise.all([getAll('collectionItems'), getAll('entries')]);
  const items = allItems.filter(i => !i.deleted && i.collectionId === collection.id);
  const migrated = allEntries.filter(e => !e.deleted && e.collection === collection.id);

  const rows = [
    ...items.map(i => ({ kind: 'item', sort: i.created || '', data: i })),
    ...migrated.map(e => ({ kind: 'entry', sort: `${e.date}T${e.time}`, data: e })),
  ].sort((a, b) => a.sort.localeCompare(b.sort));

  slot.innerHTML = `
    <button class="link-btn collection-back" id="backToCollections">‹ Collections</button>
    <div class="section-row">
      <h2>${escapeHtml(collection.name)}</h2>
      <button class="habit-edit-btn" id="editOpenCollection">Edit</button>
    </div>
    <div id="collection-add-slot"></div>
    <div id="collection-items-slot"></div>`;

  document.getElementById('backToCollections').addEventListener('click', () => {
    openCollectionId = null;
    editingItemId = null;
    renderCollectionsTab();
  });
  document.getElementById('editOpenCollection').addEventListener('click', () => {
    editingCollectionId = collection.id;
    openCollectionId = null;
    renderCollectionsTab();
  });

  renderCollectionAddRow(document.getElementById('collection-add-slot'), collection.id);

  const listEl = document.getElementById('collection-items-slot');
  if (rows.length === 0) {
    listEl.innerHTML = `<div class="empty-state">Nothing here yet.</div>`;
    return;
  }

  listEl.innerHTML = rows.map(r => {
    if (r.kind === 'item') {
      const it = r.data;
      if (it.locked) {
        return `
          <div class="entry-row locked-row">
            <div class="entry-symbol">🔒</div>
            <div class="entry-body">
              <div class="entry-content locked-content">Private — unlock in Settings to read</div>
            </div>
          </div>`;
      }
      if (it.id === editingItemId) {
        return `
          <div class="inline-form entry-edit">
            <input type="text" id="itemEdit-${it.id}" value="${escapeHtml(it.content)}" />
            <div class="form-actions">
              <button class="save" id="itemEditSave-${it.id}">Save</button>
              <button id="itemEditCancel-${it.id}">Cancel</button>
            </div>
          </div>`;
      }
      return `
        <div class="entry-row">
          <div class="entry-symbol" data-toggleitem="${it.id}">${it.type === 'task' ? (it.done ? '✓' : '▢') : SYMBOLS[it.type]}</div>
          <div class="entry-body" data-edititem="${it.id}">
            <div class="entry-content ${it.type === 'task' && it.done ? 'done' : ''}">${escapeHtml(it.content)}</div>
          </div>
          <button class="entry-del" data-delitem="${it.id}">×</button>
        </div>`;
    }
    // A migrated entry is shown here but still belongs to its day, so the × only
    // unfiles it rather than deleting it.
    const e = r.data;
    const when = new Date(e.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `
      <div class="entry-row">
        <div class="entry-symbol" data-toggleentry="${e.id}">${e.type === 'task' ? (e.done ? '✓' : '▢') : SYMBOLS[e.type]}</div>
        <div class="entry-body">
          <div class="entry-content ${e.type === 'task' && e.done ? 'done' : ''}">${escapeHtml(e.content)}</div>
          <div class="entry-time">from ${when}</div>
        </div>
        <button class="entry-del" data-unfile="${e.id}" title="Remove from this collection">×</button>
      </div>`;
  }).join('');

  listEl.querySelectorAll('[data-toggleitem]').forEach(el => {
    el.addEventListener('click', async () => {
      const it = items.find(x => x.id === el.dataset.toggleitem);
      if (!it || it.type !== 'task') return;
      await put('collectionItems', { ...it, done: !it.done, dirty: true });
      renderCollectionsTab();
    });
  });
  listEl.querySelectorAll('[data-edititem]').forEach(el => {
    el.addEventListener('click', () => { editingItemId = el.dataset.edititem; renderCollectionsTab(); });
  });
  listEl.querySelectorAll('[data-delitem]').forEach(el => {
    el.addEventListener('click', async () => {
      await markDeleted('collectionItems', el.dataset.delitem);
      renderCollectionsTab();
    });
  });
  listEl.querySelectorAll('[data-toggleentry]').forEach(el => {
    el.addEventListener('click', async () => {
      const e = migrated.find(x => x.id === el.dataset.toggleentry);
      if (!e || e.type !== 'task') return;
      await put('entries', { ...e, done: !e.done, dirty: true });
      renderCollectionsTab();
    });
  });
  listEl.querySelectorAll('[data-unfile]').forEach(el => {
    el.addEventListener('click', async () => {
      const e = migrated.find(x => x.id === el.dataset.unfile);
      if (!e) return;
      await put('entries', { ...e, collection: null, dirty: true });
      renderCollectionsTab();
    });
  });

  if (editingItemId) {
    const saveBtn = document.getElementById(`itemEditSave-${editingItemId}`);
    if (saveBtn) {
      const id = editingItemId;
      saveBtn.addEventListener('click', async () => {
        const it = items.find(x => x.id === id);
        const text = document.getElementById(`itemEdit-${id}`).value.trim();
        if (!it || !text) return;
        await put('collectionItems', { ...it, content: text, dirty: true });
        editingItemId = null;
        renderCollectionsTab();
      });
      document.getElementById(`itemEditCancel-${id}`).addEventListener('click', () => {
        editingItemId = null;
        renderCollectionsTab();
      });
    }
  }
}

// Simpler than the daily add row: no date, no time, no habits — a collection
// item is undated by definition.
function renderCollectionAddRow(container, collectionId) {
  const liveInput = container.querySelector('.text-input-row input');
  const draft = liveInput ? liveInput.value : (container.dataset.draft || '');

  container.innerHTML = `
    <div class="add-row">
      <div class="add-row-main">
        <div class="symbol-toggle">
          <button class="symbol-btn" data-sym="note">•</button>
          <button class="symbol-btn" data-sym="event">○</button>
          <button class="symbol-btn" data-sym="task">▢</button>
        </div>
        <div class="input-area">
          <div class="text-input-row">
            <input type="text" placeholder="Add to this collection…" id="collectionAddInput" />
            <button class="add-btn" id="collectionAddBtn">+</button>
          </div>
        </div>
      </div>
    </div>`;

  const input = container.querySelector('#collectionAddInput');
  input.value = draft;
  input.addEventListener('input', () => { container.dataset.draft = input.value; });

  // Switching symbol here only restyles the buttons — the field is never
  // rebuilt, so there's nothing for a draft to fall out of.
  const buttons = container.querySelectorAll('.symbol-btn');
  buttons.forEach(b => {
    b.classList.toggle('active', b.dataset.sym === collectionAddMode);
    b.addEventListener('click', () => {
      collectionAddMode = b.dataset.sym;
      buttons.forEach(x => x.classList.toggle('active', x.dataset.sym === collectionAddMode));
    });
  });

  async function submit() {
    const text = input.value.trim();
    if (!text) return;
    const now = new Date();
    // Inherit privacy from the collection — nobody should have to remember to
    // tick a box for each item filed into a private page.
    const parent = await getById('collections', collectionId);
    await put('collectionItems', {
      id: uid(),
      collectionId,
      type: collectionAddMode,
      content: text,
      private: !!(parent && parent.private),
      done: false,
      created: `${dateStr(now)}T${timeStr(now)}`,
      deleted: false,
      dirty: true,
      remotePath: null,
    });
    input.value = '';
    container.dataset.draft = '';
    renderCollectionsTab();
  }

  container.querySelector('#collectionAddBtn').addEventListener('click', submit);
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter') submit(); });
}

// ---------- Family tab ----------
let familyFormOpen = false;
let editingTaskId = null;
// A set of assignee ids, empty meaning "All". Every chip stands for exactly one
// assignee — "Mine" is just a friendlier label for your own id — so ticking two
// gives their union rather than two overlapping definitions fighting.
let familyFilters = new Set();
let familyShowDone = false;

function whoAmI() { return localStorage.getItem('bj_person') || 'michael'; }
function nowStamp() { const d = new Date(); return `${dateStr(d)}T${timeStr(d)}`; }

function taskFormHtml(cfg, t) {
  const id = t ? t.id : 'new';
  const val = (f, d) => (t && t[f] != null ? t[f] : d);
  const opts = (list, selected) => list
    .map(x => `<option value="${escapeHtml(x.id)}"${x.id === selected ? ' selected' : ''}>${escapeHtml(x.name)}</option>`)
    .join('');
  return `
    <div class="inline-form">
      <input type="text" id="taskContent-${id}" placeholder="What needs doing…" value="${t ? escapeHtml(t.content) : ''}" />
      <div class="field-grid">
        <label class="mini-field"><span>Who</span>
          <select id="taskAssignee-${id}">${opts(cfg.assignees, val('assignee', 'shared'))}</select></label>
        <label class="mini-field"><span>Category</span>
          <select id="taskCategory-${id}">${opts(cfg.categories, val('category', 'other'))}</select></label>
        <label class="mini-field"><span>Importance</span>
          <select id="taskImportance-${id}">${opts(IMPORTANCE_LEVELS, val('importance', 'normal'))}</select></label>
        <label class="mini-field"><span>Deadline</span>
          <input type="date" id="taskDeadline-${id}" value="${val('deadline', '') || ''}" /></label>
      </div>
      <div class="form-actions">
        <button class="save" id="taskSave-${id}">${t ? 'Save' : 'Add task'}</button>
        <button id="taskCancel-${id}">Cancel</button>
      </div>
      ${t ? `<button class="habit-delete-btn" id="taskDelete-${id}">Delete task</button>` : ''}
    </div>`;
}

// Their version arrives as raw markdown; show the fields that actually differ
// rather than making someone diff two blobs in their head.
function conflictHtml(t) {
  const { fields, body } = parseFrontmatter(t.conflict.remoteContent);
  const rows = [
    ['Task', t.content, body],
    ['Who', t.assignee, fields.assignee],
    ['Category', t.category, fields.category],
    ['Importance', t.importance, fields.importance],
    ['Deadline', t.deadline || '—', fields.deadline || '—'],
    ['Done', String(!!t.done), fields.done || 'false'],
  ].filter(([, mine, theirs]) => String(mine) !== String(theirs));

  return `
    <div class="conflict-box">
      <div class="conflict-head">Changed by someone else while you were editing</div>
      <div class="conflict-sub">${escapeHtml(fields.updated_by || 'someone')} saved a different version. Pick one to keep.</div>
      <table class="conflict-table">
        <tr><th></th><th>Yours</th><th>Theirs</th></tr>
        ${rows.map(([label, mine, theirs]) => `
          <tr>
            <td class="conflict-label">${escapeHtml(label)}</td>
            <td>${escapeHtml(String(mine))}</td>
            <td>${escapeHtml(String(theirs))}</td>
          </tr>`).join('')}
      </table>
      <div class="form-actions">
        <button class="save" data-keepmine="${t.id}">Keep mine</button>
        <button data-keeptheirs="${t.id}">Use theirs</button>
      </div>
    </div>`;
}

function taskRowHtml(t, cfg) {
  const band = taskBand(t);
  const due = deadlineLabel(t.deadline);
  const overdue = t.deadline && daysUntil(t.deadline) < 0;
  return `
    <div class="task-row band-${band.id} ${t.done ? 'is-done' : ''}">
      <button class="task-check" data-toggletask="${t.id}">${t.done ? '✓' : ''}</button>
      <div class="task-body" data-edittask="${t.id}">
        <div class="task-title">${escapeHtml(t.content)}</div>
        <div class="task-meta">
          <span class="task-chip who">${escapeHtml(nameFromList(cfg.assignees, t.assignee))}</span>
          <span class="task-chip">${escapeHtml(nameFromList(cfg.categories, t.category))}</span>
          ${t.importance !== 'normal'
            ? `<span class="task-chip imp-${t.importance}">${escapeHtml(nameFromList(IMPORTANCE_LEVELS, t.importance))}</span>` : ''}
          ${due ? `<span class="task-chip due${overdue ? ' overdue' : ''}">${escapeHtml(due)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

async function renderFamilyTab() {
  const slot = document.getElementById('family-slot');
  const cfg = await getFamilyConfig();
  const all = (await getAll('familyTasks')).filter(t => !t.deleted);
  const me = whoAmI();

  // Anything mid-conflict floats to the top: it's blocking a sync, and it's the
  // only thing here that can't resolve itself.
  const conflicted = all.filter(t => t.conflict);

  let visible = all.filter(t => familyShowDone || !t.done);
  if (familyFilters.size > 0) visible = visible.filter(t => familyFilters.has(t.assignee));

  // Highest score first; among equals, the nearer deadline, then oldest.
  visible.sort((a, b) =>
    (taskScore(b) - taskScore(a)) ||
    ((daysUntil(a.deadline) ?? 9999) - (daysUntil(b.deadline) ?? 9999)) ||
    String(a.created).localeCompare(String(b.created))
  );

  // Your own name would read as a duplicate of "Mine", so it doesn't get a chip
  // of its own; Shared does, since "what could either of us pick up" is a real
  // question. ALL_CHIP is a reset rather than a filter — underscores can't
  // occur in a generated assignee id (slugify emits only [a-z0-9-]) so it can't
  // collide with a real one, and it survives a round trip through a data-
  // attribute, which anything the HTML parser rewrites would not.
  const ALL_CHIP = '__all__';
  const filters = [
    { id: ALL_CHIP, name: 'All' },
    { id: me, name: 'Mine' },
  ]
    .concat(cfg.assignees.filter(a => a.id !== me && a.id !== 'shared'))
    .concat(cfg.assignees.filter(a => a.id === 'shared'));

  slot.innerHTML = `
    <div class="section-row">
      <h2>Family Tasks</h2>
      <button class="link-btn" id="addTaskBtn">+ Add</button>
    </div>
    ${conflicted.map(conflictHtml).join('')}
    ${familyFormOpen ? taskFormHtml(cfg, null) : ''}
    <div class="filter-row">
      ${filters.map(f => {
        const on = f.id === ALL_CHIP ? familyFilters.size === 0 : familyFilters.has(f.id);
        return `<button class="filter-chip${on ? ' active' : ''}" data-filter="${escapeHtml(f.id)}">${escapeHtml(f.name)}</button>`;
      }).join('')}
      <button class="filter-chip done-chip${familyShowDone ? ' active' : ''}" id="toggleDoneBtn">Done</button>
    </div>
    <div id="task-list">
      ${visible.length === 0
        ? `<div class="empty-state">Nothing here${familyFilters.size === 0 ? ' yet' : ' for these filters'}.</div>`
        : visible.map(t => editingTaskId === t.id ? taskFormHtml(cfg, t) : taskRowHtml(t, cfg)).join('')}
    </div>`;

  document.getElementById('addTaskBtn').addEventListener('click', () => {
    familyFormOpen = true; editingTaskId = null; renderFamilyTab();
  });
  slot.querySelectorAll('[data-filter]').forEach(b => {
    b.addEventListener('click', () => {
      const id = b.dataset.filter;
      // Untick the last remaining chip and you're back to All, which is the
      // same state as none selected — no need for a separate way out.
      if (id === ALL_CHIP) familyFilters.clear();
      else if (familyFilters.has(id)) familyFilters.delete(id);
      else familyFilters.add(id);
      renderFamilyTab();
    });
  });
  document.getElementById('toggleDoneBtn').addEventListener('click', () => {
    familyShowDone = !familyShowDone; renderFamilyTab();
  });

  if (familyFormOpen) wireTaskForm(cfg, null);
  if (editingTaskId) {
    const t = all.find(x => x.id === editingTaskId);
    if (t) wireTaskForm(cfg, t);
  }

  slot.querySelectorAll('[data-toggletask]').forEach(el => {
    el.addEventListener('click', async () => {
      const t = all.find(x => x.id === el.dataset.toggletask);
      if (!t) return;
      await put('familyTasks', {
        ...t, done: !t.done, updated: nowStamp(), updatedBy: whoAmI(), dirty: true,
      });
      renderFamilyTab();
    });
  });
  slot.querySelectorAll('[data-edittask]').forEach(el => {
    el.addEventListener('click', () => {
      editingTaskId = el.dataset.edittask; familyFormOpen = false; renderFamilyTab();
    });
  });

  // Reconciliation. "Keep mine" re-bases onto their sha so the next push
  // overwrites cleanly; "use theirs" adopts their version and stops being dirty.
  slot.querySelectorAll('[data-keepmine]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const t = all.find(x => x.id === btn.dataset.keepmine);
      if (!t) return;
      await put('familyTasks', {
        ...t, remoteSha: t.conflict.remoteSha, conflict: null, dirty: true,
      });
      renderFamilyTab();
    });
  });
  slot.querySelectorAll('[data-keeptheirs]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const t = all.find(x => x.id === btn.dataset.keeptheirs);
      if (!t) return;
      const { fields, body } = parseFrontmatter(t.conflict.remoteContent);
      await put('familyTasks', {
        ...t,
        content: body,
        assignee: fields.assignee || t.assignee,
        category: fields.category || t.category,
        importance: fields.importance || t.importance,
        deadline: fields.deadline || null,
        done: fields.done === 'true',
        updated: fields.updated || t.updated,
        updatedBy: fields.updated_by || t.updatedBy,
        remoteSha: t.conflict.remoteSha,
        conflict: null,
        dirty: false,
      });
      renderFamilyTab();
    });
  });
}

function wireTaskForm(cfg, t) {
  const id = t ? t.id : 'new';
  const get = (p) => document.getElementById(`${p}-${id}`);

  get('taskSave').addEventListener('click', async () => {
    const content = get('taskContent').value.trim();
    if (!content) return;
    const base = t || {
      id: uid(), created: nowStamp(), createdBy: whoAmI(),
      deleted: false, remotePath: null, remoteSha: null,
    };
    await put('familyTasks', {
      ...base,
      content,
      assignee: get('taskAssignee').value,
      category: get('taskCategory').value,
      importance: get('taskImportance').value,
      deadline: get('taskDeadline').value || null,
      done: t ? !!t.done : false,
      updated: nowStamp(),
      updatedBy: whoAmI(),
      conflict: t ? t.conflict : null,
      dirty: true,
    });
    familyFormOpen = false; editingTaskId = null;
    renderFamilyTab();
  });

  get('taskCancel').addEventListener('click', () => {
    familyFormOpen = false; editingTaskId = null; renderFamilyTab();
  });

  if (t) {
    get('taskDelete').addEventListener('click', async () => {
      if (!confirm('Delete this task for everyone?')) return;
      await put('familyTasks', { ...t, deleted: true, updated: nowStamp(), updatedBy: whoAmI(), dirty: true });
      editingTaskId = null;
      renderFamilyTab();
    });
  }
}

// ---------- Settings tab ----------
function renderSettingsTab() {
  document.getElementById('vercelUrl').value = Settings.url;
  document.getElementById('appSecret').value = Settings.secret;
  renderSyncStatus();
  renderFamilySettings();
  renderPrivacySettings();
  renderCalendarSettings();
}

const Notify = {
  read() {
    try {
      return Object.assign(
        { newTasks: 'important', assignedToMe: true },
        JSON.parse(localStorage.getItem('bj_notify')) || {}
      );
    } catch (e) {
      return { newTasks: 'important', assignedToMe: true };
    }
  },
  write(p) { localStorage.setItem('bj_notify', JSON.stringify(p)); },
};

async function renderFamilySettings() {
  const slot = document.getElementById('familyPanel');
  const cfg = await getFamilyConfig();
  const me = whoAmI();
  const n = Notify.read();

  const listEditor = (kind, items) => `
    <div class="list-editor" data-kind="${kind}">
      ${items.map(x => `
        <div class="list-editor-row">
          <input type="text" value="${escapeHtml(x.name)}" data-rename="${escapeHtml(x.id)}" />
          <button class="cal-toggle" data-remove="${escapeHtml(x.id)}">Remove</button>
        </div>`).join('')}
      <div class="list-editor-row">
        <input type="text" placeholder="Add ${kind === 'assignees' ? 'a person' : 'a category'}…" data-new="${kind}" />
        <button class="cal-toggle" data-add="${kind}">Add</button>
      </div>
    </div>`;

  slot.innerHTML = `
    <label class="field"><span>I am</span>
      <select id="whoAmISelect">
        ${cfg.assignees.filter(a => a.id !== 'shared').map(a =>
          `<option value="${escapeHtml(a.id)}"${a.id === me ? ' selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
      </select></label>
    <p class="hint">Used to stamp who created and changed a task, and to work out what "Mine" means.</p>

    <h3 class="sub-head">People</h3>
    ${listEditor('assignees', cfg.assignees)}

    <h3 class="sub-head">Categories</h3>
    ${listEditor('categories', cfg.categories)}

    <h3 class="sub-head">Notifications</h3>
    <label class="field"><span>Tell me about new tasks</span>
      <select id="notifyNewTasks">
        <option value="none"${n.newTasks === 'none' ? ' selected' : ''}>Never</option>
        <option value="important"${n.newTasks === 'important' ? ' selected' : ''}>Only high importance</option>
        <option value="all"${n.newTasks === 'all' ? ' selected' : ''}>All new tasks</option>
      </select></label>
    <label class="check-row">
      <input type="checkbox" id="notifyAssigned"${n.assignedToMe ? ' checked' : ''} />
      <span>Always tell me when something is assigned to me</span>
    </label>
    <p class="hint">These currently drive the badge on the Family tab. Push notifications to a locked phone need Web Push set up separately — the preferences are here ready for it.</p>`;

  document.getElementById('whoAmISelect').addEventListener('change', (ev) => {
    localStorage.setItem('bj_person', ev.target.value);
    renderSettingsTab();
  });
  document.getElementById('notifyNewTasks').addEventListener('change', (ev) => {
    const p = Notify.read(); p.newTasks = ev.target.value; Notify.write(p);
  });
  document.getElementById('notifyAssigned').addEventListener('change', (ev) => {
    const p = Notify.read(); p.assignedToMe = ev.target.checked; Notify.write(p);
  });

  async function saveConfig(next) {
    await put('familyConfig', { ...cfg, ...next, updated: nowStamp(), dirty: true });
    renderSettingsTab();
  }

  slot.querySelectorAll('[data-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.add;
      const input = slot.querySelector(`[data-new="${kind}"]`);
      const name = input.value.trim();
      if (!name) return;
      // A slug keeps the stored id readable in the repo; a suffix keeps it
      // unique when two entries would otherwise collide.
      let id = slugify(name) || 'item';
      const taken = new Set(cfg[kind].map(x => x.id));
      while (taken.has(id)) id += '-2';
      saveConfig({ [kind]: cfg[kind].concat([{ id, name }]) });
    });
  });
  slot.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.closest('.list-editor').dataset.kind;
      const id = btn.dataset.remove;
      // Existing tasks keep the old id and will show it raw — better than
      // silently reassigning someone else's task to a different person.
      if (!confirm('Remove this option? Tasks still using it will show it as-is.')) return;
      saveConfig({ [kind]: cfg[kind].filter(x => x.id !== id) });
    });
  });
  slot.querySelectorAll('[data-rename]').forEach(input => {
    input.addEventListener('change', () => {
      const kind = input.closest('.list-editor').dataset.kind;
      const id = input.dataset.rename;
      const name = input.value.trim();
      if (!name) return;
      // Rename the label only — the id is what tasks point at.
      saveConfig({ [kind]: cfg[kind].map(x => x.id === id ? { ...x, name } : x) });
    });
  });
}

async function renderPrivacySettings() {
  const slot = document.getElementById('privacyPanel');
  const counts = await Promise.all([getAll('entries'), getAll('collectionItems'), getAll('collections')]);
  const privateCount = counts.reduce((n, s) => n + s.filter(r => r.private && !r.deleted).length, 0);
  const lockedCount = counts.reduce((n, s) => n + s.filter(r => r.locked && !r.deleted).length, 0);

  if (!Privacy.configured && !Privacy.unlocked) {
    slot.innerHTML = `
      <div class="sync-status">Private content isn't set up on this journal yet.</div>
      <p class="hint"><strong>Write your passphrase down somewhere physical before you continue.</strong>
      It's the only way back in. Nobody — not me, not GitHub — can recover private entries without it.</p>
      <label class="field"><span>Choose a passphrase</span>
        <input type="password" id="privacyNewPass" placeholder="a long phrase you won't forget" /></label>
      <label class="field"><span>Type it again</span>
        <input type="password" id="privacyNewPass2" placeholder="confirm" /></label>
      <button class="primary-btn" id="privacySetupBtn">Turn on private content</button>
      <div class="sync-status" id="privacyMsg" hidden></div>`;

    document.getElementById('privacySetupBtn').addEventListener('click', async () => {
      const a = document.getElementById('privacyNewPass').value;
      const b = document.getElementById('privacyNewPass2').value;
      const msg = document.getElementById('privacyMsg');
      msg.hidden = false;
      if (a.length < 8) { msg.textContent = 'Use at least 8 characters — longer is better than complicated.'; return; }
      if (a !== b) { msg.textContent = "The two passphrases don't match."; return; }
      await Privacy.initialise(a);
      await syncAll(); // gets the wrapped key into the repo straight away
      renderSettingsTab();
    });
    return;
  }

  if (!Privacy.unlocked) {
    slot.innerHTML = `
      <div class="sync-status">Private content is locked on this device.${
        lockedCount ? ` ${lockedCount} item(s) are waiting to be opened.` : ''}</div>
      <label class="field"><span>Passphrase</span>
        <input type="password" id="privacyPass" placeholder="your passphrase" /></label>
      <button class="primary-btn" id="privacyUnlockBtn">Unlock</button>
      <label class="field"><span>…or the recovery key, if the passphrase is gone</span>
        <input type="password" id="privacyRecovery" placeholder="paste recovery key" /></label>
      <button class="primary-btn" id="privacyRecoverBtn">Unlock with recovery key</button>
      <div class="sync-status" id="privacyMsg" hidden></div>`;

    const msg = document.getElementById('privacyMsg');
    document.getElementById('privacyUnlockBtn').addEventListener('click', async () => {
      msg.hidden = false;
      msg.textContent = 'Unlocking…';
      try {
        await Privacy.unlock(document.getElementById('privacyPass').value);
        const opened = await openLockedRecords();
        msg.textContent = `Unlocked. ${opened} item(s) opened.`;
        renderSettingsTab();
      } catch (e) {
        msg.textContent = "That passphrase doesn't open the key.";
      }
    });
    document.getElementById('privacyRecoverBtn').addEventListener('click', async () => {
      msg.hidden = false;
      try {
        await Privacy.unlockWithRecoveryKey(document.getElementById('privacyRecovery').value);
        const opened = await openLockedRecords();
        msg.textContent = `Unlocked with the recovery key. ${opened} item(s) opened.`;
        renderSettingsTab();
      } catch (e) {
        msg.textContent = "That recovery key isn't valid.";
      }
    });
    return;
  }

  slot.innerHTML = `
    <div class="sync-status">Unlocked on this device. ${privateCount} item(s) are encrypted before syncing.</div>
    <button class="primary-btn" id="privacyShowRecoveryBtn">Show recovery key</button>
    <div class="sync-status recovery-key" id="privacyRecoveryOut" hidden></div>
    <button class="primary-btn" id="privacyLockBtn">Forget the key on this device</button>`;

  document.getElementById('privacyShowRecoveryBtn').addEventListener('click', async () => {
    const out = document.getElementById('privacyRecoveryOut');
    out.hidden = false;
    out.textContent = await Privacy.recoveryKey();
  });
  document.getElementById('privacyLockBtn').addEventListener('click', () => {
    const ok = confirm('Forget the key here? Private content becomes unreadable on this device until you enter the passphrase again. Nothing is deleted.');
    if (!ok) return;
    Privacy.forget();
    renderSettingsTab();
  });
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
  collections: () => ['Collections', ''],
  family: () => ['Family', ''],
  settings: () => ['Settings', ''],
};
let activeTab = 'today';

function renderActiveTab() {
  document.querySelectorAll('.view').forEach(v => v.hidden = v.dataset.view !== activeTab);
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
  document.getElementById('settingsBtn').classList.toggle('active', activeTab === 'settings');
  const [title, sub] = TAB_TITLES[activeTab]();
  document.getElementById('topbarTitle').textContent = title;
  document.getElementById('topbarSub').textContent = sub;

  if (activeTab === 'today') renderTodayTab();
  if (activeTab === 'habits') renderHabitsTab();
  if (activeTab === 'month') renderMonthTab();
  if (activeTab === 'gratitude') renderGratitudeTab();
  if (activeTab === 'collections') renderCollectionsTab();
  if (activeTab === 'family') renderFamilyTab();
  if (activeTab === 'settings') renderSettingsTab();
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => { activeTab = btn.dataset.tab; renderActiveTab(); });
});

// Settings moved out of the tab bar into the header: it's a configure-once
// screen, and the sixth slot is worth more to something you open daily.
document.getElementById('settingsBtn').addEventListener('click', () => {
  activeTab = activeTab === 'settings' ? 'today' : 'settings';
  renderActiveTab();
});

// ---------- boot ----------
(async function init() {
  await openDB();
  await Privacy.restore(); // before the first pull, so encrypted records open on arrival

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
