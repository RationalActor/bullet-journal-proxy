# Handoff: review-cleanup branch

_Status as of 2026-09-04. The review below was written against `main` at 98ce056; its line numbers are stale (app.js is ~4,660 lines now). Refresh them before reusing any agent prompt._

## Landed on `review-cleanup` (one commit per item)

| Item | Commit | Notes |
|---|---|---|
| I-18 auto-sync shared stores | cf15b0f | push 2.5 s after a write; pull on visibility, pageshow, online, visible-only interval (3 min journal, 10 min family) |
| I-19 shopping/config conflicts auto-resolve | 0cf0aad | |
| I-21 service worker stale-while-revalidate | d6d3c81 | cache v28 |
| I-22 proxy hardening + test-access.mjs | 7173eee, b42d19b | |
| I-23 create-only key upload, encrypted gratitude prompt, passphrase change | ede33ac, e08b128 | |
| I-24 sync indicator in topbar | 4e56991 | |
| I-25 narrower store reads | aadc552 | |
| I-26 shopping notes shown and editable | 69c5ff2 | |
| I-27 MCP keeps added/added_by | 6527c55 | |
| B-1 dead `tapped` class | cd7f1cc | |
| B-2 unread notify prefs | 9b4c2b4 | old prefs files still carry the keys; harmless |
| B-3 markDeleted for habits | 90e1e24 | |
| B-4 one family listing per pull | aff3a7f | |
| B-5 drop habitLogs, DB v8 | 0a62c72 | one-way upgrade |
| B-6 renderPersonPrefs finds its slot | 354afd1 | |
| B-7 stale comments | 1ab859a | |
| B-8 README rewrite | c773467 | |
| B-9 proxyFetch helper | 69b8fb9, 70844de | |
| B-10 SYNC_STORES push registry | 459cb4f | |
| B-11 pullFolder, batched writes | e73deda | |
| B-12 one habit form | 0f9bd42 | |
| B-13 shared row builders | d7109ac | |
| B-14 saveShared helper | f94a695 | |
| B-16 split big renderers | 248125e | |
| B-17 renderActiveTab + wireStaticControls | a9d40fc | state grouping skipped |

## Not yet dispatched

- **I-20** differential pull (`?head=`, `?tree=`, `?path=` on the proxy; sha-diff on the client). Makes a poll one request; lower the intervals in the automatic-sync section once it lands. Slot the client side into `pullFolder`.
- **B-15** `shared/format.js` for app.js and mcp/server.js (drift already exists: MCP parser does not unquote values).
- **I-28** tombstone compaction, after I-20.

## Manual checks owed before merging

1. Deploy the branch to a preview; open index.html and liz.html on two devices; add a shopping item on one and watch it arrive on the other without pressing Sync.
2. Tick the same item on both within a few seconds; confirm both settle at Pending 0.
3. Reload index.html on the real install; confirm the IndexedDB v8 upgrade renders existing data.
4. Load twice more after deploy to see the service worker pick up new code without a cache bump.

---

# Bullet Journal PWA review

_Reviewed 2026-09-03 against bullet-journal-proxy/ (app.js 3,935 lines, style.css 1,112, api/entries.js 273, mcp/server.js 540)._

## Architecture verdict

No rewrite is earned. The UI layer follows one pattern everywhere (a render function per view builds innerHTML, then re-wires handlers), and at ~3,900 lines that pattern is still workable on a phone. Nothing in Part 1 needs more than in-place deletion or consolidation.

There is one structural problem, and it is the source of most of the duplication: knowledge about each synced store lives in five places (the object-store creation in openDB, the toMarkdown/path pair, a loop in syncAll, a section in pullFromGitHub, and the store list in renderSyncStatus), plus a sixth for conflict behaviour. Every feature added since habits copied all of them, which is why family tasks, shopping lists, collections and prefs each have a near-identical push loop and pull section. The fix is a single store registry consumed by generic push and pull code (B-10 and B-11). That is incremental: same IndexedDB, same file formats, same proxy, no framework. It is also the prerequisite that makes auto-sync (I-18) a small change instead of a second copy of syncAll.

A second, smaller structural fact: mcp/server.js re-implements the file format by hand, and the two copies have already drifted (the MCP frontmatter parser does not unquote values; the app's does). B-15 covers it.

## Why the shared list drifts

Traced through app.js as it stands today. Each point is a separate cause; fixing only one leaves the others.

1. **Push is manual only.** Every write marks a record dirty and stops. The only calls to syncAll are the Sync Now button (app.js:3794) and the privacy setup step (app.js:3647). A shopping item added on one phone sits in that phone's IndexedDB until someone taps the button.
2. **Pull runs once, on cold start.** pullFromGitHub runs from init (app.js:3925-3930) and from syncAll. There is no visibilitychange, pageshow, online or interval hook anywhere in the file. An installed iOS PWA is resumed from memory, not restarted, so a phone can go days without init running; the comment at app.js:1183 saying pull runs "whenever the app opens" is true only for a reload.
3. **Manual sync has an order dependency.** syncAll pushes then pulls. If both of you tap Sync, whoever tapped first does not see the other's changes until they tap again. Two dutiful syncs are still not enough.
4. **Shopping and config conflicts wedge permanently.** syncOne parks a 409 on any store (app.js:976-986), but only familyTasks has reconciliation UI (app.js:2973, 3012). A shopping item or family config that hits 409 stays dirty forever, retries the same stale baseSha every sync, and because dirty records skip pull (app.js:1394, 1413, 1308) that device never receives updates for it again. The status message then points to a Family tab the family app does not have (app.js:1163). Both of you ticking the same item is enough to trigger this.
5. **Pull is expensive, which is why polling was never added.** Each proxy folder call costs 1 + N GitHub requests (api/entries.js:170-182 fetches every file individually). A family pull is 4 listings plus one request per task, item, list and prefs file, tombstones included. At ~150 files that is ~155 GitHub calls; polling every 3 minutes on two phones would be ~6,200 per hour against a 5,000 per hour token limit. The journal's cold-open pull walks every date folder sequentially (app.js:1503-1546), which is worse.
6. **The two phones may not even run the same code.** sw.js serves the shell cache-first and only refreshes when CACHE_NAME is bumped by hand (sw.js:6), so one phone can run an older app.js for weeks.

Recommended order: I-18 (auto push on write, pull on wake, poll while visible) with I-19 (unwedge shopping conflicts) in the same change; then I-20 (one-request change detection and differential pull), which is what makes polling cheap enough to leave on; then I-21 (service worker) and I-24 (a visible sync indicator). Do not block rendering on a pull: render local data first, pull in the background, and re-render only if something changed and no form is open.

## Index

| ID | Title | Severity | Effort |
|---|---|---|---|
| B-1 | Remove the dead "tapped" class and its CSS rule | Low | Low |
| B-2 | Delete the notification preferences nothing reads | Low | Low |
| B-3 | Replace the inline habit soft-delete with markDeleted | Low | Low |
| B-4 | Drop the second fetch of folder=family in pull | Low | Low |
| B-5 | Stop creating the legacy habitLogs object store | Low | Low |
| B-6 | Inline renderPersonPrefsPanel and drop its history comment | Low | Low |
| B-7 | Delete stale and changelog comments | Low | Low |
| B-8 | Rewrite the stale README | Low | Low |
| B-9 | One proxy-call helper instead of three hand-built fetch preambles | Low | Low |
| B-10 | Make the push side of syncAll table-driven | Med | Med |
| B-11 | Collapse the nine pull sections into one pullFolder helper and batch the IndexedDB writes | Med | Med-High |
| B-12 | Unify the habit add and edit forms the way taskFormHtml already does | Low | Med |
| B-13 | Shared builders for locked rows, appointment blocks and entry rows | Low | Low-Med |
| B-14 | One helper for stamped writes to the shared stores | Low | Low |
| B-15 | The MCP server re-implements the app's file format and has already drifted | Med | Med |
| B-16 | Split the four renderers that build HTML, hold state and wire handlers in one body | Med | Med |
| B-17 | Standardize re-render entry points and static wiring | Low | Med |
| I-18 | Auto-sync the shared stores: push on write, pull on wake, poll while visible | High | Med |
| I-19 | Shopping and config conflicts wedge forever because nothing can resolve them | High | Low-Med |
| I-20 | One-request change detection and a differential pull | High | Med-High |
| I-21 | Service worker serves stale app code until the cache name is bumped by hand | Med | Low |
| I-22 | Harden the proxy: path charset, timing-safe secrets, less error leakage, tests against the real code | Med | Low-Med |
| I-23 | Privacy: the first key upload can overwrite an existing key, and gratitude prompts are stored in plaintext on private entries | Med | Low |
| I-24 | Show sync state outside Settings | Med | Low |
| I-25 | Renderers read entire stores for views that need a slice | Low-Med | Low |
| I-26 | Shopping notes exist in the file format and the MCP tools but the app never shows or edits them | Low | Low |
| I-27 | MCP complete_shopping_item rewrites the item's added stamp and author | Low | Low |
| I-28 | Tombstones accumulate in the shared folders forever | Low | Med |

## Part 1: Bloat audit

### B-1 — Remove the dead "tapped" class and its CSS rule

- **Category:** Dead code
- **Location:** app.js:1862; style.css:245
- **Problem:** The task-symbol click handler adds class tapped and then awaits a put and calls renderActiveTab, which replaces the whole list. The element is discarded before the 0.15s transition can run, so the rule never has a visible effect.
- **Severity / Effort:** Low / Low

**Agent prompt:**

> In app.js remove the line el.classList.add('tapped') at app.js:1862 inside renderEntryList's .entry-symbol click handler. In style.css delete the rule .entry-symbol.tapped { transform: scale(1.3); } at style.css:245 and the transition declaration on .entry-symbol at style.css:243 (it exists only for that rule). Do not change the handler's toggling of entry.done, the put call, or the renderActiveTab call. Verify: open the Today tab, tick and untick a task; the symbol still flips between the box and the tick and the strike-through still applies.

### B-2 — Delete the notification preferences nothing reads

- **Category:** Dead code
- **Location:** app.js:890-891, 3572-3582, 3602-3603
- **Problem:** notifyNewTasks and notifyAssigned are defaulted, rendered, saved and synced to family/prefs/<person>.md, but no code reads them. The hint says "These drive the badge in the app"; there is no badge. It is scaffolding for Web Push that was never built.
- **Severity / Effort:** Low / Low

**Agent prompt:**

> In app.js remove notifyNewTasks and notifyAssigned from DEFAULT_PREFS (app.js:890-891), delete the Notifications block in renderPersonPrefs (the h3 "Notifications" through the hint paragraph, app.js:3572-3582), and delete the two on('notifyNewTasks'...) and on('notifyAssigned'...) handlers at app.js:3602-3603. Do not change getPrefs, savePrefs or prefsToMarkdown: they spread whatever keys exist, so prefs files already in the repo that still contain those keys keep parsing. Do not touch the sections, defaultSeg, defaultFilter, showDone, accent or displayName controls. Verify: open liz.html, Settings, the You panel renders without a Notifications heading; change the accent colour, tap Sync now, and confirm the pushed family/prefs/<person>.md no longer contains notify keys and the accent still applies after a reload.

### B-3 — Replace the inline habit soft-delete with markDeleted

- **Category:** Duplicated logic
- **Location:** app.js:2214-2222 (duplicates app.js:119-129)
- **Problem:** The habit delete handler re-implements markDeleted line for line (if remotePath, mark deleted+dirty, else delete locally). Two copies of the tombstone rule is one too many.
- **Severity / Effort:** Low / Low

**Agent prompt:**

> In app.js, inside renderHabitsTab's habitEditDelete click handler (app.js:2210-2225), replace the block from `if (habit) { if (habit.remotePath) { ... } else { await del('habits', habit.id); } }` with `if (habit) await markDeleted('habits', habit.id);`. Keep the confirm() prompt and its wording, and keep editingHabitId = null and renderActiveTab() after it. Do not change markDeleted. Verify: create a habit, delete it before syncing (it disappears and no file is created on the next sync); create another, sync, then delete it (after the next sync its habits/<id>.md carries deleted: true and it no longer appears in the Habits tab or the add row).

### B-4 — Drop the second fetch of folder=family in pull

- **Category:** Duplicated logic
- **Location:** app.js:1201 (probe) and app.js:1303 (config)
- **Problem:** pullFromGitHub fetches ?folder=family twice per pull: once as the auth probe and again to read config.md. Every pull, on both apps, pays for a listing it already has. Each proxy folder call is also 1 + N GitHub requests.
- **Severity / Effort:** Low / Low

**Agent prompt:**

> In app.js pullFromGitHub, keep the probe fetch at app.js:1201 exactly where it is (it must run before the owner-only block), but when probe.ok, parse its JSON once into a local `familyRoot` variable. Then delete the famCfgResp fetch at app.js:1303 and have the family config section read cfgFile from familyRoot.entries instead. Keep the 401/403/404 handling, pullProblem messages and the dirty-wins rule for familyConfig unchanged. Verify: in liz.html with the browser network panel open, tap Sync now and confirm exactly one request with folder=family per pull; the People, Categories and Shops lists in Settings still populate from the repo.

### B-5 — Stop creating the legacy habitLogs object store

- **Category:** Dead code
- **Location:** app.js:34-40
- **Problem:** The v1 habitLogs store is never read or written. The comment says it is kept so old installs do not error, but a store that is not touched cannot error; new installs simply get an empty store they will never use.
- **Severity / Effort:** Low / Low

**Agent prompt:**

> In app.js openDB, bump the indexedDB.open version from 7 to 8 (app.js:24). Inside onupgradeneeded remove the habitLogs creation block and its comment (app.js:34-40) and add, at the end of the handler, `if (d.objectStoreNames.contains('habitLogs')) d.deleteObjectStore('habitLogs');`. Do not modify any other store or index. Verify: reload index.html on an existing install; DevTools, Application, IndexedDB, bulletJournalDB shows version 8 with no habitLogs store, and existing entries, habits, occurrences, collections, family tasks and shopping items are all still present and render.

### B-6 — Inline renderPersonPrefsPanel and drop its history comment

- **Category:** Comment bloat
- **Location:** app.js:3531-3536, 3615-3618, 3440
- **Problem:** renderPersonPrefsPanel is a three-line wrapper that finds #prefsPanel and calls renderPersonPrefs, and the comment above renderPersonPrefs describes an earlier version that no longer exists. Both are leftovers of a removed feature.
- **Severity / Effort:** Low / Low

**Agent prompt:**

> In app.js change renderPersonPrefs (app.js:3537) to take no argument and look up `const slot = document.getElementById('prefsPanel'); if (!slot) return;` itself, matching how renderFamilySettings and renderPrivacySettings guard their slots. Delete renderPersonPrefsPanel (app.js:3615-3618) and call renderPersonPrefs() directly from renderSettingsTab (app.js:3440). Replace the comment block at app.js:3531-3536 with a single line: "Only ever your own; anything bigger than these switches is a repo edit to family/prefs/<person>.md." Verify: liz.html Settings still shows the You panel and index.html Settings (which has no prefsPanel) renders without a console error.

### B-7 — Delete stale and changelog comments

- **Category:** Comment bloat
- **Location:** app.js:1171-1173, 1182-1191, 1265-1267, 1486, 2033, 2127, 2161, 2170, 3797-3799, 3848-3849; style.css:1092; api/entries.js:80-84; mcp/server.js:249
- **Problem:** A handful of comments describe past bugs, past layouts ("now", "moved"), or are simply wrong: two different sections both claim to be fetched first, the Habits tab is called read-only though it has add/edit/delete, and the MCP tool description says the opposite of its sort order.
- **Severity / Effort:** Low / Low

**Agent prompt:**

> Make only these comment edits; do not rewrite any other comment. app.js:1171-1173: delete the sentence beginning "the family stores were missing from this tally". app.js:1182-1191: the header comment for pullFromGitHub runs straight into the comment for pullProblem; split them with a blank line so the "Why a pull failed" paragraph sits directly above `let pullProblem`, and delete the parenthetical "(no polling/timer)". app.js:1265-1267: delete "Fetched first: it's the most time-sensitive thing here, and" (keyinfo at 1242 is fetched first; that comment is correct). app.js:1486: delete the line "id -> habit lookup for matching occurrence files (used below)". app.js:2033: change the section header to "Habits tab". app.js:2127, 2161, 2170: delete the three "wire the ..." comments. app.js:3797-3799 and 3848-3849: delete both changelog comments ("The date lives in the day-nav now..." and "Settings moved out of the tab bar..."). style.css:1092: delete the inline comment "six tabs now ...". api/entries.js:80-84: delete the two sentences from "It looked like a rejected password" to "never reaches this line." mcp/server.js:249: change "newest deadline first" to "soonest deadline first, undated last" (matches the sort at mcp/server.js:359). Verify: node --check app.js and node --check mcp/server.js both pass; the apps load.

### B-8 — Rewrite the stale README

- **Category:** Comment bloat
- **Location:** README.md:3-4, 10-16, 24-27, 81-92, 152-160
- **Problem:** The README describes a single-user, three-method proxy for a "(future) web app", says there is no conflict handling, and never mentions the family and bot roles, FAMILY_SECRET, BOT_SECRET, baseSha/409, or the roles payload on 401. Anyone (including an agent) reading it will build against the wrong contract.
- **Severity / Effort:** Low / Low

**Agent prompt:**

> Rewrite README.md to match api/entries.js as it is now. Keep the setup steps (token, Vercel, env vars) but add FAMILY_SECRET and BOT_SECRET as optional env vars with one line each on what they unlock (family: family/** read and write; bot: family/tasks/, family/shopping-lists/, family/shopping-items/ plus read of the family/ listing). Document all four request shapes: GET ?date=, GET ?folder= (with dirs), POST (path or date+filename), PUT (path, content, optional baseSha) and the 409 response body {error:'conflict', path, currentSha, currentContent}. Document the 401 body {error, roles:{owner,family,bot}}. Replace the "Notes" section: delete "No conflict handling" and "(future) web app", keep the CORS and rate-limit notes but state that a folder listing costs 1 + N GitHub requests. Point to mcp/README.md for the assistant. Do not describe features that do not exist (no DELETE, no tree endpoint unless I-20 has landed). Verify: every claim in the file can be matched to a line in api/entries.js.

### B-9 — One proxy-call helper instead of three hand-built fetch preambles

- **Category:** Inconsistent patterns
- **Location:** app.js:958-959, 1064-1067, 1195-1196 (and the redundant .replace(/\/$/, '') at 959, 1064, 1196)
- **Problem:** syncOne, the keyinfo push and pullFromGitHub each rebuild the same headers and base URL, and each strips a trailing slash that Settings.url already strips on write (app.js:149). mcp/server.js already has the shape this should take (its api() function).
- **Severity / Effort:** Low / Low

**Agent prompt:**

> In app.js add one helper next to Settings: `function proxyFetch(query, init = {}) { return fetch(`${Settings.url}/api/entries${query}`, { ...init, headers: { 'x-app-secret': Settings.secret, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } }); }` and use it in syncOne (app.js:962, 992), the keyinfo push (app.js:1064), and every fetch inside pullFromGitHub (app.js:1201 through 1504). Remove the local `headers` and `base` variables and the three `.replace(/\/$/, '')` calls. Do not change any request body, method, status handling or the order of requests, and do not touch syncOne's 409 branch. Verify: both apps sync and pull as before; in the network panel every request URL still has the form <proxy>/api/entries?... and carries x-app-secret; a PUT still sends Content-Type: application/json.

### B-10 — Make the push side of syncAll table-driven

- **Category:** Duplicated logic
- **Location:** app.js:1019-1025, 1043-1049, 1080-1148
- **Problem:** Nine loops with the same shape (filter dirty, compute path, serialize, call syncOne, tally) differ only in store name, path function, serializer, detectConflicts and owner-only. Adding a store means adding a tenth copy plus a name in renderSyncStatus (app.js:1174-1175).
- **Severity / Effort:** Med / Med

**Agent prompt:**

> In app.js define, above syncAll, an ordered registry `const SYNC_STORES = [ {store:'habits', ownerOnly:true, path:habitDefPath, markdown:habitToMarkdown}, {store:'collections', ownerOnly:true, privateCapable:true, path:collectionPath, markdown:collectionToMarkdown}, {store:'collectionItems', ownerOnly:true, privateCapable:true, path:collectionItemPath, markdown:collectionItemToMarkdown}, {store:'entries', ownerOnly:true, privateCapable:true, path:entryPath, markdown:entryToMarkdown}, {store:'habitOccurrences', ownerOnly:true, needsHabit:true, path:habitOccPath, markdown:habitOccToMarkdown}, {store:'familyConfig', single:true, path:() => FAMILY_CONFIG_PATH, markdown:familyConfigToMarkdown, detectConflicts:true}, {store:'familyTasks', path:familyTaskPath, markdown:familyTaskToMarkdown, detectConflicts:true}, {store:'shoppingLists', path:shoppingListPath, markdown:shoppingListToMarkdown, detectConflicts:true}, {store:'shoppingItems', path:shoppingItemPath, markdown:shoppingItemToMarkdown, detectConflicts:true}, {store:'familyPrefs', path:(p) => prefsPath(p.id), markdown:prefsToMarkdown} ]` and replace the nine loops at app.js:1080-1148 with one loop over it that preserves exactly the current order and rules: skip ownerOnly stores when !isOwner(); apply sendable() only to privateCapable stores; for needsHabit, skip occurrences whose habit is missing and pass the habit to path/markdown; for single, load via getFamilyConfig() and push only if dirty; use record.remotePath || path(record) as today. Make renderSyncStatus (app.js:1174-1175) derive its store list from the same registry. Leave syncOne, the keyinfo block (app.js:1062-1078), tally and the status messages untouched. Verify: create one dirty record of every kind on index.html (entry, habit, occurrence, collection, item, task, list, shopping item, config change, prefs change), tap Sync now, and confirm each lands at its existing path in the repo; on liz.html confirm only family stores are pushed and Pending counts match.

### B-11 — Collapse the nine pull sections into one pullFolder helper and batch the IndexedDB writes

- **Category:** Duplicated logic
- **Location:** app.js:1241-1485 (nine sections), 1301 (unindented closing of the isOwner block), 1487-1546 (entries walk)
- **Problem:** Each section does the same thing: fetch a folder, for each file strip .md to get the id, parse frontmatter, skip if the local copy is dirty, put a record. They differ only in the field mapping. Each file also costs a separate getById and a separate put transaction, which is slow on a phone once there are hundreds of files. The isOwner block at 1241-1301 is not indented, which hides its extent.
- **Severity / Effort:** Med / Med-High

**Agent prompt:**

> In app.js write `async function pullFolder({ folder, store, toRecord })` that: fetches ?folder=<folder> (via the helper from B-9 if present); returns early on !resp.ok; reads the whole local store once into a Map by id with getAll; for each item computes id = filename minus .md, skips when the local record is dirty, calls `await toRecord({ id, fields, body, item, local })` (async so collections/items can use openPrivateField) and collects the results; then writes all of them in one readwrite transaction on the store; and returns the number written. Convert the habits, family config (single file, keep the JSON.parse guard and DEFAULT_FAMILY_CONFIG fallbacks), prefs, family tasks, shopping lists, shopping items, collections and collection-items sections (app.js:1279-1485) to calls of pullFolder with a toRecord that reproduces the exact field mapping each section has today, including remoteSha for the family stores and conflict: null where it is set now. Keep the probe, keyinfo and calendar sections and the entries/occurrences walk (app.js:1487-1546) as they are, but indent the isOwner block properly. Have pullFromGitHub return the total number of records written (I-18 needs it). Do not change the merge rule (local dirty wins) or any field name or default. Verify: on a device with existing data, Sync now on both apps produces the same records as before (compare a task, a shopping item, a private collection item while locked and while unlocked, and a prefs record in DevTools); measure the pull in the Performance panel before and after and confirm fewer transactions.

### B-12 — Unify the habit add and edit forms the way taskFormHtml already does

- **Category:** Duplicated logic
- **Location:** app.js:2037-2072 (two builders), 2128-2159 and 2171-2227 (two wiring blocks)
- **Problem:** habitFormHtml and habitEditFormHtml produce the same form with different ids, and the tracking-type toggle wiring is duplicated line for line. The family tasks code solved this with one taskFormHtml(cfg, t) and one wireTaskForm(cfg, t); habits predate that pattern.
- **Severity / Effort:** Low / Med

**Agent prompt:**

> In app.js replace habitFormHtml and habitEditFormHtml with a single `habitFormHtml(h)` where h is null for a new habit, using ids of the form habitName-${id} with id = h ? h.id : 'new' (the same convention as taskFormHtml at app.js:2871). Replace the two wiring blocks in renderHabitsTab (app.js:2128-2159 and 2171-2227) with one `wireHabitForm(h, habits)` that wires the track-btn toggle, save (create when h is null, otherwise spread h and mark dirty), cancel, and delete (only when h is given; use markDeleted per B-3). Keep the confirm() text, the target/unit show-hide behaviour, and the existing state variables habitFormOpen and editingHabitId. Do not change the habit record shape. Verify: add a check-off habit and a count habit with unit and goal; edit each (rename, switch type, change goal); delete one; the Habits tab, the add row chips and the streak dots all behave as before.

### B-13 — Shared builders for locked rows, appointment blocks and entry rows

- **Category:** Duplicated logic
- **Location:** app.js:1814-1823 and 2693-2701 (locked row); 1965-1967 and 2385-2387 (appointments block); 1827-1838, 2712-2719, 2725-2733 (entry row variants)
- **Problem:** The same markup is written out two or three times with small differences. A future styling change to how a private row or an appointment block looks has to be found in each copy.
- **Severity / Effort:** Low / Low-Med

**Agent prompt:**

> In app.js add three pure builders near escapeHtml: `lockedRowHtml(time)` returning the locked entry-row markup (time optional, used at app.js:1814-1823 and 2693-2701); `apptBlockHtml(appts)` returning the appt-day-block markup or '' when empty (used at app.js:1965-1967 and 2385-2387); and `entryRowHtml({ id, type, done, content, meta, symbolAttr, bodyAttr, delAttr, delTitle })` that produces the entry-row markup used at app.js:1827-1838, 2712-2719 and 2725-2733, where meta is the pre-built inner HTML of the entry-time div (time plus collection chip, or 'from <date>', or nothing) and the *Attr values are the data-attribute names each caller currently uses (data-id/data-editentry/data-del, data-toggleitem/data-edititem/data-delitem, data-toggleentry/none/data-unfile). Replace the three call sites. Do not change any data-attribute name, class name, or the handlers that query them. Verify: Today, Month day detail, and a collection detail all render identically (compare the DOM before and after for one entry, one habit row, one locked row and one migrated entry); tick, edit, delete and unfile still work in each place.

### B-14 — One helper for stamped writes to the shared stores

- **Category:** Duplicated logic
- **Location:** app.js:2003-2005, 3071-3073, 3131-3143, 3155 (family tasks); 3321-3331, 3346, 3354, 3376-3380 (shopping items); 3491 (config)
- **Problem:** Nine call sites spread a record, set updated: nowStamp(), updatedBy: whoAmI(), dirty: true and put it. One forgotten stamp is a silent inconsistency, and there is no single place to hook an auto-push (I-18 needs one).
- **Severity / Effort:** Low / Low

**Agent prompt:**

> In app.js add `async function saveShared(store, rec, patch = {}) { const next = { ...rec, ...patch, updated: nowStamp(), updatedBy: whoAmI(), dirty: true }; await put(store, next); return next; }` next to nowStamp/whoAmI (move those two from app.js:2868-2869 up beside the other shared helpers around app.js:1592 while you are there; they are used from app.js:793 and 922, long before their current position). Replace the family task writes at app.js:2003-2005, 3071-3073, 3155 and the shopping item writes at app.js:3346, 3354, 3376-3380 with saveShared calls carrying the same patch. Leave creation paths that set created/added fields (app.js:3131-3143, 3321-3331) and the config save (app.js:3491, which has no updatedBy) as they are, or route them through saveShared only if the resulting record is field-for-field identical. Verify: tick, untick, edit and delete a task and a shopping item; each pushed file carries updated and updated_by; the Today tab tick still marks the family task done.

### B-15 — The MCP server re-implements the app's file format and has already drifted

- **Category:** Duplicated logic
- **Location:** mcp/server.js:80-128, 132-137 vs app.js:390-403, 707-724, 805-849, 869
- **Problem:** parseFrontmatter, nowStamp, taskMarkdown, itemMarkdown, listMarkdown and DEFAULT_CONFIG are hand copies of app.js functions. The copies differ already: app.js:399 unquotes quoted values, mcp/server.js:87 does not. Any change to a field name has to be remembered twice.
- **Severity / Effort:** Med / Med

**Agent prompt:**

> Create shared/format.js as a classic script with no imports or exports that defines parseFrontmatter, nowStamp, familyTaskToMarkdown, shoppingItemToMarkdown, shoppingListToMarkdown, familyConfigToMarkdown and DEFAULT_FAMILY_CONFIG (copy the app.js versions verbatim: app.js:390-403, 707-724, 805-849, 869) and ends with `globalThis.BJFormat = { parseFrontmatter, nowStamp, familyTaskToMarkdown, shoppingItemToMarkdown, shoppingListToMarkdown, familyConfigToMarkdown, DEFAULT_FAMILY_CONFIG };`. In index.html and liz.html add `<script src="shared/format.js"></script>` immediately before the app.js script tag; in app.js delete the local definitions and add `const { parseFrontmatter, nowStamp, familyTaskToMarkdown, shoppingItemToMarkdown, shoppingListToMarkdown, familyConfigToMarkdown, DEFAULT_FAMILY_CONFIG } = BJFormat;` near the top. In mcp/server.js add `import '../shared/format.js';` and replace its own parseFrontmatter, nowStamp, taskMarkdown, itemMarkdown, listMarkdown and DEFAULT_CONFIG with the BJFormat equivalents (taskMarkdown takes the same record shape as familyTaskToMarkdown, so only the names change). Add './shared/format.js' to SHELL_FILES in sw.js and bump CACHE_NAME. Do not move any journal-only serializer (entries, habits, collections) and do not change any field name. Verify: node --check on all three files; both apps load offline after one online visit; add a task from the MCP server and confirm the file is byte-identical in layout to one the app writes; a task with a quoted value in frontmatter parses the same in both.

### B-16 — Split the four renderers that build HTML, hold state and wire handlers in one body

- **Category:** Oversized functions
- **Location:** app.js:3173-3394 renderShopping (220 lines); 2965-3117 renderFamilyTasks (150); 1785-1923 renderEntryList (140); 1612-1750 renderAddRow (140, closures three deep)
- **Problem:** Each of these computes derived data, builds a large template that includes its own inline edit form, then attaches eight to twelve handlers by querying the markup it just wrote. Changing one behaviour means reading the whole function. The tasks code already shows the better shape (taskFormHtml plus wireTaskForm as separate functions).
- **Severity / Effort:** Med / Med

**Agent prompt:**

> In app.js, for each of renderShopping (app.js:3173-3394), renderFamilyTasks (2965-3117), renderEntryList (1785-1923) and renderAddRow (1612-1750), extract pure HTML builders (for example shoppingSectionsHtml(sections), shoppingItemEditHtml(item, cfg), shoppingRowHtml(item), filterRowHtml(...)) and a matching wireX(root, data) function, so each render function becomes: load data, compute view model, set innerHTML from builders, call wireX. Keep every state variable, class name, id and data-attribute exactly as it is, keep the draft-preservation logic in renderAddRow (app.js:1621-1622, 1656-1658, 1725) and keep the edit-form wiring guarded by the same "is the form on screen" checks. Do B-13 and B-14 first if they have not landed, since they remove some of this code. No behaviour change is intended. Verify: exercise every control on Family Tasks and Shopping in both apps (add, edit, tick, filter chips, category chips, Done toggle, list switch, store filter, elsewhere toggle, clear bought, new list) and on Today (add note/event/task/habit with count prompt, edit, retime, file into collection, delete), confirming no handler is lost.

### B-17 — Standardize re-render entry points and static wiring

- **Category:** Inconsistent patterns
- **Location:** app.js: 36 self-calls of renderShopping/renderFamilyTab/renderCollectionsTab vs renderActiveTab elsewhere; top-level wiring at 2258, 2961, 3844 vs onEl at 1597; 31 top-level "let" UI-state variables
- **Problem:** After a write, entry and habit code calls renderActiveTab while family, shopping and collections code calls their own renderer, so the topbar title and tab highlighting can go stale in the family app. Static elements are wired with onEl in some places and bare querySelectorAll at others, despite the comment at app.js:1593-1596 explaining why onEl exists. UI state is thirty-one loose globals.
- **Severity / Effort:** Low / Med

**Agent prompt:**

> In app.js: (1) replace direct calls to renderShopping(), renderFamilyTab() and renderCollectionsTab() that follow a write or a state change with renderActiveTab() (it already routes the family app's tasks and shopping tabs to the right renderer at app.js:3839-3840); keep the direct calls only inside renderFamilyTab/renderCollectionsTab's own dispatch. (2) Move the three top-level querySelectorAll wiring blocks (app.js:2258, 2961, 3844) into a single wireStaticControls() called once from init, using onEl-style null guards. (3) Optionally group per-tab state into objects (todayState, familyState, shoppingState, collectionsState) with the same field names; skip this if B-16 has not landed. Do not split app.js into multiple files as part of this item. Verify: in liz.html, tick a task and switch to Shopping and back; the topbar title and active tab stay correct; in index.html every tab still opens and the gear toggles Settings.

## Part 2: Opportunities for improvement

### I-18 — Auto-sync the shared stores: push on write, pull on wake, poll while visible

- **Category:** Shared-list sync
- **Location:** app.js:3794 and 3647 (only syncAll callers), 3925-3930 (only automatic pull), 1011-1166 syncAll, 1193-1550 pullFromGitHub
- **Problem:** Sync is manual in both directions, so a change on one phone is invisible on the other until both people tap Sync in the right order. See the diagnosis above for the full chain. Auto-push after each write and auto-pull on wake close it without new infrastructure.
- **Severity / Effort:** High / Med

**Agent prompt:**

> In app.js implement automatic sync for the shared stores only (familyTasks, familyConfig, shoppingLists, shoppingItems, familyPrefs), leaving the journal stores on the Sync Now button. Steps: (1) Split syncAll into `pushDirty({ familyOnly })` (the push half, status messages included) and keep pullFromGitHub, adding a `{ familyOnly }` option that skips the crypto, calendar, habits, collections, collection-items and entries sections and runs only the family/ ones; syncAll becomes pushDirty({familyOnly:false}) then pullFromGitHub({familyOnly:false}) so the button behaves exactly as today. (2) Add a single-flight guard: `let syncRun = null, syncAgain = false;` so that if a sync is already in flight the request sets syncAgain and one more run happens afterwards; never two concurrently. (3) `scheduleAutoPush()`: clearTimeout/setTimeout 2500 ms, then `runAutoSync()` = pushDirty({familyOnly:true}) followed by pullFromGitHub({familyOnly:true}); call scheduleAutoPush from every write to the five shared stores (the saveShared helper from B-14 is the hook; otherwise after each put to those stores, including markDeleted for shoppingItems, the config saveConfig at app.js:3491 and savePrefs at app.js:918). (4) `autoPull()` = pullFromGitHub({familyOnly:true}) with a throttle (skip if the last pull started under 45 s ago) and a `navigator.onLine` check; call it from init (in place of the existing pull for the family app; the owner keeps its full pull), on document visibilitychange when visible, on window pageshow, on window online, and from a setInterval of 3 minutes that does nothing unless document.visibilityState === 'visible'. (5) Re-render only when it matters: have pullFromGitHub return the number of records it wrote (B-11 does this); after a pull, if that number is 0 do nothing; if a form is open (familyFormOpen, editingTaskId, editingShoppingItemId, shoppingListFormOpen, collectionFormOpen, editingCollectionId, editingItemId, editingEntryId, or document.activeElement is an input/textarea/select) set `renderPending = true` and consume that flag at the top of the next renderActiveTab; otherwise call renderActiveTab. (6) Run applyMyPrefs after a family pull as init does now. (7) In the family app, set the interval to 10 minutes until I-20 lands, because each family pull costs roughly 5 + N GitHub requests. Do not change syncOne, its 409 handling, detectConflicts per store, or the journal stores' manual push. Verify with index.html in one browser profile and liz.html in another, both configured against the real proxy: add a shopping item on one; within ~3 s the file appears in the repo; switch to the other browser tab (visibilitychange) and the item appears without pressing Sync; start typing in the task form on one side while the other side adds a task, and confirm the typed text survives and the new task appears after the form closes; put one browser offline, add an item, go back online, and confirm it pushes on the online event; watch the network panel for 5 minutes to confirm only one pull per interval and none while the tab is hidden.

### I-19 — Shopping and config conflicts wedge forever because nothing can resolve them

- **Category:** Shared-list sync
- **Location:** app.js:976-986 (syncOne parks a conflict on any store), 2973 and 3012 (UI only for familyTasks), 1163 (message), 1308/1394/1413 (dirty skips pull)
- **Problem:** If both of you tick the same shopping item, or both edit the shared config, one device receives 409 and the record stays dirty with a conflict it has no screen for. It retries the same stale baseSha every sync and, being dirty, skips every pull for that record: that item never converges again on that device, and the status says "see the Family tab" in an app that has no Family tab.
- **Severity / Effort:** High / Low-Med

**Agent prompt:**

> In app.js add `function autoResolveConflict(store, record)` and call it in the push loop (syncAll or pushDirty) for records that carry a conflict before syncOne is called, for the stores shoppingItems, shoppingLists and familyConfig only. For shoppingItems and shoppingLists: parse record.conflict.remoteContent with parseFrontmatter; compare fields.updated (remote) with record.updated (local) as strings (they are local-time stamps in the same format); if remote is newer, adopt theirs the same way the familyTasks "Use theirs" branch at app.js:3095-3116 does for its fields (name from body, store, note, done, updated, updatedBy) and set remoteSha = conflict.remoteSha, conflict = null, dirty = false, then skip the push for this record; otherwise keep mine: set remoteSha = conflict.remoteSha, conflict = null, keep dirty = true and let the push proceed. For familyConfig: parse the remote body as JSON, union-merge assignees, categories and stores by id (local names win for ids present in both), set remoteSha = conflict.remoteSha, conflict = null, dirty = true, and push. Leave familyTasks' human reconciliation exactly as it is. Change the message at app.js:1163 to "see the Tasks tab" when !isOwner() and "see the Family tab" otherwise. Verify: in the GitHub web UI edit family/shopping-items/<id>.md (flip done to true and bump updated to a later stamp), then on a device that has that item cached tick the same item and sync; it should settle on the remote version with Pending: 0 and no conflict; repeat with a local stamp that is newer and confirm the local version pushes; add a shop in Settings on both apps without syncing between, sync both, and confirm both shops end up in family/config.md.

### I-20 — One-request change detection and a differential pull

- **Category:** Shared-list sync
- **Location:** api/entries.js:139-187 (folder GET fetches every file); app.js:1193-1550 (pull), 1498-1546 (entries walk: one request per date folder plus one per file)
- **Problem:** A pull costs 1 + N GitHub requests per folder and, for the journal, one request per date folder walked sequentially. That makes background polling both slow and a real rate-limit risk (5,000 requests per hour per token), and it is why sync was left manual. Comparing a branch head sha costs one request; a recursive tree listing gives every path and blob sha in one more.
- **Severity / Effort:** High / Med-High

**Agent prompt:**

> Proxy (api/entries.js): add three GET forms, all subject to the existing pathAllowed(role, path, 'GET') check. `?head=1` calls GET /repos/{owner}/{repo}/branches/{GITHUB_BRANCH || 'main'} and returns { head: data.commit.sha }. `?tree=1` calls GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1 and returns { head, files: [{ path, sha }] } filtered to blobs ending in .md whose path passes pathAllowed for the role (so the family role sees only family/**, the bot only its folders); if the API reports truncated:true return 413 so the client falls back. `?path=<file>` returns one file in the same { path, filename, sha, raw } shape the folder listing uses. Client (app.js): store remoteSha on every pulled record (habits, entries, occurrences, collections and items currently do not; add it in their pull mappings) and keep `bj_lastHead` in Settings. In pullFromGitHub, before the folder sections: fetch ?head=1; if it equals bj_lastHead and the previous pull completed, return 0 immediately. Otherwise fetch ?tree=1; for each file whose path is inside a folder this app pulls (same list of folders as today, honouring familyOnly from I-18), compare its sha with the local record found by remotePath; fetch only new or changed files with ?path= (in parallel, at most 6 at a time), run them through the same per-store toRecord mapping (B-11) with the dirty-wins rule, and treat the calendar snapshot and crypto/keyinfo.md the same way. Save bj_lastHead only after everything succeeded. If ?tree=1 answers 400 or 413, fall back to the existing folder walk unchanged. Keep Sync Now doing a full pull with the head check bypassed. Add test cases to the access test for ?path= with traversal, absolute and encoded inputs. Do not change file formats, the merge rule, or syncOne. Verify: on the family app, a poll with nothing changed makes exactly one proxy request; after editing one task in the GitHub UI the next pull makes head + tree + one file request and the task updates; on the journal, a cold open with a year of entries completes in seconds instead of minutes, and a new entry created on another device arrives after one pull; force the fallback by pointing at an old proxy deployment and confirm pull still works.

### I-21 — Service worker serves stale app code until the cache name is bumped by hand

- **Category:** Shared-list sync
- **Location:** sw.js:6 (CACHE_NAME), 35-50 (cache-first fetch), 47 (returns undefined when nothing is cached), 7-17 (shell list lacks apple-touch-icon.png)
- **Problem:** Shell files are served from cache and never revalidated, so after a deploy each phone keeps the old app.js until you edit CACHE_NAME and it reinstalls. Two phones on different versions is one more way the shared list drifts. When a request is neither cached nor fetchable the handler resolves with undefined, which throws inside respondWith.
- **Severity / Effort:** Med / Low

**Agent prompt:**

> In sw.js change the fetch handler for shell requests to stale-while-revalidate: respond with the cached copy when present, and in parallel fetch from the network and cache.put the fresh response (only when response.ok); when nothing is cached, return the network response, and if that fails return Response.error() rather than undefined. Keep the early return for non-GET and /api/ requests so sync never touches the cache. Add './apple-touch-icon.png' to SHELL_FILES. Bump CACHE_NAME once for this change. Do not add navigation preload, push, or background sync. Verify: deploy, load the app twice; the second load runs the new app.js without a further CACHE_NAME change (check a console.log of a version string you add temporarily); turn on airplane mode and confirm both index.html and liz.html still open from cache; confirm sync requests appear in the network panel with no service worker involvement.

### I-22 — Harden the proxy: path charset, timing-safe secrets, less error leakage, tests against the real code

- **Category:** Security
- **Location:** api/entries.js:38-62 resolveRole, 68-92 pathAllowed, 162-163/212/265 error passthrough, 191/218 req.body destructuring; test-access.py:3-8
- **Problem:** pathAllowed blocks .., leading slash, backslash and %2e/%2f but nothing else: a path with ? or # reaches the GitHub URL, and a filename with a quote becomes a record id that app.js writes unescaped into id and data attributes (app.js:1828, 2714, 3244). Secrets are compared with ===, GitHub error text is relayed verbatim, a non-JSON body makes destructuring throw, and the access tests are a hand-maintained Python mirror of the rules rather than the code (its docstring says Node was unavailable; Node 24 is on this machine now).
- **Severity / Effort:** Med / Low-Med

**Agent prompt:**

> In api/entries.js: (1) Rewrite the start of pathAllowed so that after the type/empty check it splits path on '/' and returns false unless every segment matches /^[A-Za-z0-9][A-Za-z0-9._-]*$/ and is not '.' or '..'; this subsumes the current .., leading-slash, backslash and %-encoding checks, which you can then delete. Keep the readable and prefix logic below it unchanged. (2) In resolveRole compare secrets with crypto.timingSafeEqual on Buffers after an equal-length check (import { timingSafeEqual } from 'node:crypto'). (3) Replace `req.body` destructuring at lines 191 and 218 with `(req.body || {})`. (4) Where GitHub error text is relayed (lines 162-163, 212, 265), console.error the GitHub payload and return { error: 'GitHub request failed' } with the same status. (5) Add `export { resolveRole, pathAllowed };` alongside the default export. (6) Create test-access.mjs that imports those two functions, sets process.env secrets for the three roles, ports every case from test-access.py's CASES list, and adds cases for 'family/tasks?ref=x', 'family/tasks#x', 'family/tasks/a"b.md', 'family/./tasks' and a plain-space filename (all expected false), plus ?path= inputs if I-20 has landed; delete test-access.py and update the reference to it in mcp/README.md:24. Do not change CORS, the 401 roles payload (it is deliberate), the 409 semantics, or any response shape the apps read. Verify: node test-access.mjs passes; both apps and the MCP server still read and write; curl with a path containing ? returns 403.

### I-23 — Privacy: the first key upload can overwrite an existing key, and gratitude prompts are stored in plaintext on private entries

- **Category:** Security
- **Location:** app.js:1062-1078 (keyinfo pushed with PUT upsert and no baseSha), 337 (prompt written outside the encrypted body), 163-166 (design allows a passphrase change that has no UI)
- **Problem:** If privacy is set up on a device that never managed to pull (offline, or a wrong URL at the time) and later syncs, its keyinfo PUT replaces crypto/keyinfo.md unconditionally; entries encrypted under the other master key become unreadable on every device but the one that wrote them. Separately, a private gratitude entry keeps its prompt in plaintext frontmatter, which is metadata about the entry the encryption was meant to hide. The CryptoKey handling itself (PBKDF2 310k, AES-GCM with a random IV, wrapped master key, probe) is sound.
- **Severity / Effort:** Med / Low

**Agent prompt:**

> In app.js: (1) In the keyinfo block of syncAll (app.js:1062-1078), when Privacy.keyInfo.remotePath is null use POST (the proxy's create-only path; GitHub returns 422 if the file already exists) instead of PUT; on a non-ok response, fetch ?folder=crypto, and if a keyinfo.md exists whose wrapped value differs from ours, do not overwrite: keep keyInfo.dirty true, set pullProblem to "A different private-content key already exists in the repo. Enter that passphrase in Settings before syncing private items." and stop pushing private records for this run (they are already held back by sendable when locked; additionally treat this state as locked). Use PUT only when remotePath is set. (2) In entryToMarkdown (app.js:337) encrypt the prompt when e.private (`prompt: ${await Privacy.encrypt(e.prompt)}` without quotes) and in the pull mapping (app.js:1538) run fields.prompt through openPrivateField and keep it only when it opens; leave non-private prompts as they are. (3) Optional, if time allows: add `Privacy.changePassphrase(oldPass, newPass)` that verifies the old one via unlock, derives a new KEK with a fresh salt, re-wraps the existing master key, updates keyInfo (dirty: true) and saves it locally, with a small form in the unlocked state of renderPrivacySettings; no re-encryption of content is needed by design. Do not change ENC_PREFIX, the wrapped format, or the probe. Verify: on a fresh profile with a wrong proxy URL, set up privacy, fix the URL, sync; the repo's keyinfo.md is unchanged and the status explains why; write a private gratitude entry and confirm the pushed file's prompt line starts with enc:v1:, and that it reads back correctly after a pull on an unlocked device.

### I-24 — Show sync state outside Settings

- **Category:** Shared-list sync
- **Location:** app.js:1168-1180 renderSyncStatus; index.html:20-24 and liz.html:35-39 (.topbar)
- **Problem:** The only sign that something is unsent or that the last pull failed is a sentence on the Settings screen. Once I-18 makes sync automatic, a quiet indicator is what tells you the list you are looking at is current.
- **Severity / Effort:** Med / Low

**Agent prompt:**

> Add a small status element to the topbar in index.html and liz.html (a span with id syncDot placed before the gear button) and a `renderSyncIndicator({ pending, syncing, problem })` in app.js that sets a class of one of idle, pending, syncing or error on it and a title attribute with the same text renderSyncStatus produces; make it a button that switches activeTab to settings. Call it from pushDirty/pullFromGitHub start and end (I-18) and from renderSyncStatus. Style it in style.css with the existing tokens (var(--ink-soft) idle, var(--habit-accent) pending, var(--boost) syncing, var(--diminish) error), 8px round, absolutely positioned like .gear-btn. Compute pending cheaply: count dirty records once per push and cache the number rather than re-reading ten stores. Verify: add an item offline and the dot turns amber; go online and after the auto-push it returns to idle; break the secret and the dot turns red with the pullProblem text as its title.

### I-25 — Renderers read entire stores for views that need a slice

- **Category:** Performance
- **Location:** app.js:2330-2336 renderMonthTab (all entries and occurrences for one month's dots); 2083 renderHabitsTab (all occurrences ever for a 7-day strip); 421-429 CalendarPrefs.read (JSON.parse of localStorage on every colorFor/labelFor call, hundreds per month render); 1168-1180 renderSyncStatus (up to ten full getAll calls per Settings render)
- **Problem:** These are fine at a few hundred records and will be the first thing to lag on a phone once the journal has a year in it. The date index already exists on entries and habitOccurrences and is unused by these views.
- **Severity / Effort:** Low-Med / Low

**Agent prompt:**

> In app.js: (1) In renderMonthTab replace getAll('entries') and getAll('habitOccurrences') with getAllByIndex(store, 'date', IDBKeyRange.bound(`${monthPrefix}-01`, `${monthPrefix}-31`)) for the datesWithContent set. (2) In renderHabitsTab replace getAll('habitOccurrences') with the same index query bounded by last7[0] and last7[6]. (3) In CalendarPrefs add a module-level cache: read() returns the cached object when present, write() updates the cache and localStorage together. (4) In renderSyncStatus count dirty records with a cursor that stops reading values it does not need, or, if I-24 has landed, use its cached pending count. Do not change what any view displays. Verify: Month and Habits render the same dots and streaks as before across a month boundary and for a habit logged today; the Settings pending count still matches the number of unsynced items; in the Performance panel a Month render no longer shows repeated JSON.parse calls.

### I-26 — Shopping notes exist in the file format and the MCP tools but the app never shows or edits them

- **Category:** Performance
- **Location:** app.js:841 (written), 1420 (pulled), 3242-3246 (row markup, no note), 3225-3241 (edit form, no note field); mcp/server.js:317, 482
- **Problem:** An item added by the assistant with a note ("the lactose-free one") arrives in the app with the note preserved and invisible. The person standing in the shop is the one who needs it.
- **Severity / Effort:** Low / Low

**Agent prompt:**

> In app.js renderShopping: in the shop-row markup (app.js:3242-3246) render `<div class="shop-note">${escapeHtml(i.note)}</div>` under the name when i.note is non-empty, and add a text input id shopEditNote-${i.id} with placeholder "Note (optional)" to the edit form (app.js:3228-3240) whose value is saved as note in the shopEditSave handler (app.js:3372-3383). Add a .shop-note rule in style.css (font-size 12px, color var(--ink-soft)). Do not change shoppingItemToMarkdown or the pull mapping; they already carry note. Verify: add an item with a note through the MCP add_shopping_items tool, sync, and see the note under the item; edit an item in the app to add a note and confirm the pushed file has a note: line.

### I-27 — MCP complete_shopping_item rewrites the item's added stamp and author

- **Category:** Security
- **Location:** mcp/server.js:498-501 (vs the correct handling in toolCompleteTask at 417-418); getShopping at 191-204 does not carry added/added_by
- **Problem:** Marking an item bought through the assistant overwrites added and added_by with now and the bot author, so the record loses who put it on the list and when. complete_task preserves created/created_by; this one should match.
- **Severity / Effort:** Low / Low

**Agent prompt:**

> In mcp/server.js extend getShopping's item mapping (lines 191-204) to include added: fields.added || '' and addedBy: fields.added_by || '', and in toolCompleteShoppingItem (lines 497-501) pass added: item.added || stamp and addedBy: item.addedBy || AUTHOR instead of stamp/AUTHOR, keeping updated: stamp and updatedBy: AUTHOR. Do not change the sha-based write or any tool schema. Verify: add an item from the app, sync, complete it via the MCP tool, and confirm the file still has the original added and added_by lines with only done, updated and updated_by changed.

### I-28 — Tombstones accumulate in the shared folders forever

- **Category:** Performance
- **Location:** app.js:119-129 markDeleted, 3358-3362 "Clear bought items" (one tombstone per bought item); api/entries.js has no DELETE
- **Problem:** Every bought item ever cleared stays as a deleted: true file that each full pull lists and (before I-20) fetches. The folder grows without bound and so does the cost of the pull the family app runs most. Not urgent once I-20 makes unchanged files free, but worth a plan.
- **Severity / Effort:** Low / Med

**Agent prompt:**

> Defer until I-20 has landed. Then: in api/entries.js add DELETE /api/entries with body { path, sha } that calls GitHub's DELETE contents endpoint, guarded by pathAllowed(role, path, 'DELETE') with the same prefix rules as PUT (the readable allowance must not permit it); add access-test cases. In app.js add a compaction step at the end of a successful full pull that, for shoppingItems only, deletes remote files whose record is deleted, not dirty, and whose updated stamp is older than 30 days, then removes the local record; run it at most once a day (store the last run in Settings). Do not compact familyTasks, prefs, config, or any journal store, and never delete a file whose local record is dirty or in conflict. Verify: seed a few old tombstones by editing updated stamps in the repo, sync, and confirm they are removed remotely and locally while recent ones and all tasks remain.
