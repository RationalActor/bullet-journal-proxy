# bullet-journal-proxy

A single serverless function that sits between your web app / iPad / computer
and your private `bullet-journal` GitHub repo. It holds your GitHub token so the
browser never sees it, and it's the one place that knows how to talk to GitHub's
API.

## What it does

One file, `api/entries.js`, handling four request shapes via one URL:

| Request | Purpose | Example |
|---|---|---|
| `GET ?date=` | List a day's entries | `GET /api/entries?date=2026-07-22` |
| `GET ?folder=` | List any repo folder (files + subfolders) | `GET /api/entries?folder=entries` |
| `POST` | Create a file | `POST /api/entries` |
| `PUT` | Write a file, creating it if absent | `PUT /api/entries` |

There is no `DELETE`, and no endpoint for fetching a single file — a file is
read by listing the folder that contains it.

Every request must include a header:

```
x-app-secret: <a password you make up>
```

This is not a real user-auth system — it's just enough to stop a stranger who
stumbles on your function's URL from reading or writing your journal.

### Who the secret makes you

The presented secret is compared against each configured one (in constant time)
and resolves to a role, which decides what paths you may touch:

| Secret | May reach |
|---|---|
| `APP_SECRET` | everything — the journal owner |
| `FAMILY_SECRET` | `family/` and everything under it, read and write |
| `BOT_SECRET` | `family/tasks/`, `family/shopping-lists/`, `family/shopping-items/` read and write, plus a read of the `family/` listing itself |

`FAMILY_SECRET` and `BOT_SECRET` are optional: leave one unset and that role
simply doesn't exist. The bot's read of `family/` is how it reaches `config.md`
for the real category and shop ids; it is read-only and does not reach one level
down, so `family/prefs/` stays out of its hands.

Whatever the role, every segment of a path must look like a plain name —
starting with a letter or digit, then letters, digits, dots, dashes and
underscores. That single rule is what rejects `..`, leading slashes, empty
segments, backslashes, percent-encoded separators and a query string smuggled
onto the end.

## One-time setup

### 1. Get a GitHub token

GitHub → Settings → Developer settings → Personal access tokens →
Fine-grained tokens → **Generate new token**.

- Repository access: only `bullet-journal`
- Permissions: **Contents: Read and write**
- Copy the token somewhere safe — you won't see it again.

(This is a *different* token than the one currently in your Shortcut — you
can reuse the same one if you like, or make a fresh one. Either works.)

### 2. Deploy to Vercel

1. Push this folder to a **new GitHub repo** (e.g. `bullet-journal-proxy`).
   This can be public — it contains no secrets, only code. The secrets go
   into Vercel's dashboard in the next step, never into the repo.
2. Go to [vercel.com](https://vercel.com), sign in with GitHub.
3. **Add New Project** → pick the `bullet-journal-proxy` repo → Deploy.
   Vercel auto-detects the `/api` folder — no configuration needed.
4. Once deployed, go to the project → **Settings → Environment Variables**
   and add:

   | Name | Value |
   |---|---|
   | `GITHUB_TOKEN` | the token from step 1 |
   | `GITHUB_OWNER` | your GitHub username |
   | `GITHUB_REPO` | `bullet-journal` |
   | `APP_SECRET` | any password you make up — the owner secret, full access |
   | `FAMILY_SECRET` | *optional* — a second person's secret, confined to `family/**` for reading and writing |
   | `BOT_SECRET` | *optional* — an automation's secret: read and write under `family/tasks/`, `family/shopping-lists/` and `family/shopping-items/`, plus read of the `family/` listing |

   The three GitHub variables are required; without them every request answers
   `500 {"error": "Server misconfigured: missing GitHub env vars"}`.

5. Redeploy (Settings → Deployments → ⋯ → Redeploy) so the env vars take
   effect.

You'll end up with a URL like:

```
https://bullet-journal-proxy.vercel.app/api/entries
```

That's the one URL your viewer app, your Shortcut, and the MCP server call.

## API reference

### List a day's entries

```
GET /api/entries?date=2026-07-22
Header: x-app-secret: <your secret>
```

`date` must be `YYYY-MM-DD`; anything else is `400 {"error": "Malformed \"date\""}`.
It is expanded to the folder `entries/<date>`.

### List an arbitrary folder

```
GET /api/entries?folder=habits
GET /api/entries?folder=entries
Header: x-app-secret: <your secret>
```

With neither `date` nor `folder` the answer is
`400 {"error": "Missing \"date\" or \"folder\" query param"}`.

Both forms return the same shape: the folder's `.md` files (other file types are
skipped) plus a `dirs` array naming its subfolders — so `folder=entries` returns
the date-folders (`2026-07-22`, `2026-07-23`, ...) and the app can enumerate
everything ever synced, not just one day.

Response:
```json
{
  "path": "entries/2026-07-22",
  "entries": [
    {
      "path": "entries/2026-07-22/10-39-02.md",
      "filename": "10-39-02.md",
      "sha": "abc123...",
      "raw": "---\ntype: unclassified\ntimestamp: 2026-07-22T10:39:02\nreviewed: false\n---\nRaw dictated text goes here."
    }
  ],
  "dirs": []
}
```

Entries come back sorted by filename. A folder that doesn't exist yet is not an
error — it answers `200` with empty `entries` and `dirs`.

The proxy returns the raw file content as-is (frontmatter + body). Parsing the
frontmatter into fields is left to the frontend — keeps the proxy dumb and easy
to reason about.

### Create a new file

```
POST /api/entries
Header: x-app-secret: <your secret>
Content-Type: application/json

{
  "date": "2026-07-22",
  "filename": "14-05-00.md",
  "content": "---\ntype: unclassified\ntimestamp: 2026-07-22T14:05:00\nreviewed: false\n---\nTyped from the computer."
}
```

`date` + `filename` is shorthand for the path `entries/<date>/<filename>`; an
explicit `path` may be sent instead and takes precedence:

```json
{ "path": "family/tasks/2026-07-22-groceries.md", "content": "..." }
```

`content` is required (`400 Missing content in request body`), and so is one of
the two ways of naming the file (`400 Provide either "path", or both "date" and
"filename"`). On success: `201 {"path": "...", "sha": "..."}`.

The frontend is responsible for building the filename (`HH-mm-ss.md`) and the
full frontmatter block, matching the same format the Shortcut already produces —
so entries from any source look identical in the repo.

### Write a file (update, or create if absent)

```
PUT /api/entries
Header: x-app-secret: <your secret>
Content-Type: application/json

{
  "path": "entries/2026-07-22/10-39-02.md",
  "content": "---\ntype: task\ntimestamp: 2026-07-22T10:39:02\nreviewed: true\n---\nCorrected text goes here.",
  "baseSha": "abc123..."
}
```

`path` and `content` are required. Use the `path` returned from the `GET` call.
The proxy looks the file up behind the scenes to get GitHub's required `sha`,
then writes your content over it — and sends no `sha` when the file isn't there
yet, which makes `PUT` an upsert. A repeating writer such as the iPhone Calendar
shortcut doesn't have to know whether it's the first run or the hundredth. On
success: `200 {"path": "...", "sha": "..."}`.

`baseSha` is optional. Sending it means "I edited the version with this sha": if
the file has moved on since, the write is refused rather than flattening someone
else's work, and you get the current version back to put the choice to a human:

```
409 Conflict
```
```json
{
  "error": "conflict",
  "path": "family/tasks/shared.md",
  "currentSha": "def456...",
  "currentContent": "---\n...\n---\nWhatever is in the repo right now."
}
```

Omit `baseSha` and the old last-write-wins behaviour applies — which is what the
Shortcut's single-writer snapshot file wants.

### Errors

| Status | Body | When |
|---|---|---|
| `400` | `{"error": "..."}` | malformed `date`, missing query param, missing `content`, missing `path` |
| `401` | `{"error":"Unauthorized","roles":{"owner":true,"family":true,"bot":false}}` | the secret matched no role. The `roles` object says only which of the three environment variables are filled in — no secret and no data — so someone setting up a second phone can tell "wrong password" from "there is no family password on this server" |
| `403` | `{"error": "Role \"bot\" may not access \"family/prefs/liz.md\""}` | the role exists but the path is outside it, or a segment isn't a plain name |
| `405` | `{"error": "Method not allowed"}` | anything but `GET`, `POST`, `PUT`, `OPTIONS` |
| `409` | the conflict body above | `baseSha` no longer matches |
| `500` | `{"error": "Server misconfigured: missing GitHub env vars"}` | a `GITHUB_*` variable is unset |

When GitHub itself refuses, its status is passed through with a flat
`{"error": "GitHub request failed"}`. GitHub's own wording goes to the function
log instead: it can name the private repo, the token's scopes, or a rate-limit
state the caller has no business learning.

## The assistant

`mcp/README.md` covers the MCP server that lets a self-hosted assistant work the
family task and shopping lists through this proxy with `BOT_SECRET`.

## Notes / things to keep in mind

- **Every write is a full file rewrite.** GitHub's API doesn't support partial
  edits — `POST` and `PUT` both replace the whole file. So your review screen
  should always send back the complete markdown (frontmatter + body), not just
  the changed field.
- **A folder listing costs 1 + N GitHub requests**: one for the directory, then
  one per `.md` file in it to fetch its content. A folder with fifty notes is
  fifty-one calls, so listing a big folder on every page load adds up.
- **CORS is wide open** (`Access-Control-Allow-Origin: *`) so any web app you
  build, wherever it's hosted, can call this. The `x-app-secret` check is what
  actually protects the data, not CORS.
- **Rate limits**: GitHub's API allows 5,000 requests/hour with a token — with
  the 1 + N cost above, still nowhere near what a personal journal will hit.
