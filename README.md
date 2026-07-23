# bullet-journal-proxy

A single serverless function that sits between your (future) web app / iPad /
computer and your private `bullet-journal` GitHub repo. It holds your GitHub
token so the browser never sees it, and it's the one place that knows how to
talk to GitHub's API.

## What it does

One file, `api/entries.js`, handling three things via one URL:

| Method | Purpose | Example |
|---|---|---|
| `GET` | List all entries for a given day | `GET /api/entries?date=2026-07-22` |
| `POST` | Create a new entry | `POST /api/entries` |
| `PUT` | Update an existing entry (reclassify, mark reviewed, fix transcription) | `PUT /api/entries` |

Every request must include a header:

```
x-app-secret: <a password you make up>
```

This is not a real user-auth system — it's just enough to stop a stranger
who stumbles on your function's URL from reading or writing your journal.
Since this is a single-user personal project, a shared secret is enough;
you don't need real login/signup.

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
   | `APP_SECRET` | any password you make up |

5. Redeploy (Settings → Deployments → ⋯ → Redeploy) so the env vars take
   effect.

You'll end up with a URL like:

```
https://bullet-journal-proxy.vercel.app/api/entries
```

That's the one URL your viewer app, and eventually your Shortcut, will call.

## API reference

### List a day's entries

```
GET /api/entries?date=2026-07-22
Header: x-app-secret: <your secret>
```

Response:
```json
{
  "date": "2026-07-22",
  "entries": [
    {
      "path": "entries/2026-07-22/10-39-02.md",
      "filename": "10-39-02.md",
      "sha": "abc123...",
      "raw": "---\ntype: unclassified\ntimestamp: 2026-07-22T10:39:02\nreviewed: false\n---\nRaw dictated text goes here."
    }
  ]
}
```

The proxy returns the raw file content as-is (frontmatter + body). Parsing
the frontmatter into fields is left to the frontend — keeps the proxy dumb
and easy to reason about.

### Create a new entry

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

This is what your iPad/computer entry form will call instead of the
Shortcut. The frontend is responsible for building the filename
(`HH-mm-ss.md`) and the full frontmatter block, matching the same format the
Shortcut already produces — so entries from any source look identical in
the repo.

### Update an existing entry (reclassify / review / fix text)

```
PUT /api/entries
Header: x-app-secret: <your secret>
Content-Type: application/json

{
  "path": "entries/2026-07-22/10-39-02.md",
  "content": "---\ntype: task\ntimestamp: 2026-07-22T10:39:02\nreviewed: true\n---\nCorrected text goes here."
}
```

Use the `path` returned from the `GET` call. The proxy fetches the file's
current version behind the scenes to get GitHub's required `sha`, then
writes your new content over it — so your viewer app never needs to track
`sha` itself, just re-send the full corrected content (frontmatter + body)
each time.

## Notes / things to keep in mind

- **Every entry is a full file rewrite.** GitHub's API doesn't support
  partial edits — the `PUT` above replaces the whole file. So your review
  screen should always send back the complete markdown (frontmatter +
  body), not just the changed field.
- **No conflict handling.** If two edits to the same file happened at the
  literal same moment, the second write would win. For a single-user
  journal this is very unlikely to matter, but worth knowing.
- **CORS is wide open** (`Access-Control-Allow-Origin: *`) so any web app
  you build, wherever it's hosted, can call this. The `x-app-secret` check
  is what actually protects the data, not CORS.
- **Rate limits**: GitHub's API allows 5,000 requests/hour with a token —
  nowhere near what a personal journal will hit.
