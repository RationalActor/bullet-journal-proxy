// api/entries.js
//
// One endpoint:
//   GET  /api/entries?date=YYYY-MM-DD    -> list all files in entries/<date>
//   GET  /api/entries?folder=<path>      -> list all files (and subfolders) in an arbitrary repo folder
//   POST /api/entries                    -> create a new file (date+filename, OR an explicit path)
//   PUT  /api/entries                    -> write a file, creating it if absent
//
// Every request must include header:  x-app-secret: <a secret>
//
// Which secret decides what you may touch:
//   APP_SECRET     - the journal owner. Full access to every path.
//   FAMILY_SECRET  - a second person sharing only the family task list. Confined
//                    to family/**, enforced here rather than in the app, so a
//                    client bug (or curiosity) can't reach the journal.
//
// Set these in Vercel project settings -> Environment Variables:
//   GITHUB_TOKEN   - a GitHub personal access token with repo access
//   GITHUB_OWNER   - your GitHub username
//   GITHUB_REPO    - "bullet-journal"
//   APP_SECRET     - owner secret
//   FAMILY_SECRET  - optional; omit and the family role simply doesn't exist

// Roles are matched on the exact secret. A role with a prefix may only address
// paths inside it.
function resolveRole(secret) {
  if (typeof secret !== 'string' || !secret) return null;
  const owner = process.env.APP_SECRET;
  const family = process.env.FAMILY_SECRET;
  if (owner && secret === owner) return { name: 'owner', prefix: null };
  if (family && secret === family) return { name: 'family', prefix: 'family/' };
  return null;
}

// Reject anything that could climb out of the allowed subtree before it is ever
// concatenated into a GitHub URL. Belt and braces: a traversal segment, an
// absolute path, a backslash, or an encoded separator all fail outright rather
// than being cleaned up and let through.
function pathAllowed(role, path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.startsWith('/') || path.includes('\\')) return false;
  if (path.includes('..')) return false;
  if (path.includes('%2e') || path.includes('%2E') || path.includes('%2f') || path.includes('%2F')) return false;
  if (!role.prefix) return true;
  return path.startsWith(role.prefix);
}

export default async function handler(req, res) {
  // Allow the web app (hosted elsewhere) to call this function
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-app-secret');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // --- Auth: which role is asking? ---
  const role = resolveRole(req.headers['x-app-secret']);
  if (!role) {
    // "Wrong password" and "there is no family password on this server" are the
    // same 401 from outside, and the person setting up a second phone can't tell
    // them apart — they'd be retyping a secret that was never going to match.
    // Saying which role exists reveals no secret and no data; it only says which
    // environment variables were filled in.
    return res.status(401).json({
      error: 'Unauthorized',
      roles: { owner: !!process.env.APP_SECRET, family: !!process.env.FAMILY_SECRET },
    });
  }

  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    return res.status(500).json({ error: 'Server misconfigured: missing GitHub env vars' });
  }

  const ghHeaders = {
    Authorization: `token ${GITHUB_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
  };
  const base = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents`;

  const forbidden = (path) =>
    res.status(403).json({ error: `Role "${role.name}" may not access "${path}"` });

  try {
    // ---------- GET: list a folder (a day's entries, or any arbitrary repo folder) ----------
    if (req.method === 'GET') {
      const { date, folder } = req.query;
      let dirPath;
      if (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return res.status(400).json({ error: 'Malformed "date"' });
        }
        dirPath = `entries/${date}`;
      } else if (folder) {
        dirPath = folder;
      } else {
        return res.status(400).json({ error: 'Missing "date" or "folder" query param' });
      }
      if (!pathAllowed(role, dirPath)) return forbidden(dirPath);

      const dirUrl = `${base}/${dirPath}`;
      const dirResp = await fetch(dirUrl, { headers: ghHeaders });

      if (dirResp.status === 404) {
        // Folder doesn't exist yet - not an error, just empty
        return res.status(200).json({ path: dirPath, entries: [], dirs: [] });
      }
      if (!dirResp.ok) {
        const err = await dirResp.text();
        return res.status(dirResp.status).json({ error: err });
      }

      const items = await dirResp.json();
      const mdFiles = items.filter((f) => f.type === 'file' && f.name.endsWith('.md'));
      const dirs = items.filter((f) => f.type === 'dir').map((f) => f.name);

      const entries = await Promise.all(
        mdFiles.map(async (f) => {
          const fileResp = await fetch(f.url, { headers: ghHeaders });
          const fileData = await fileResp.json();
          const raw = Buffer.from(fileData.content, 'base64').toString('utf-8');
          return {
            path: f.path,       // needed later for PUT (update)
            filename: f.name,
            sha: fileData.sha,  // the client sends this back as baseSha to detect conflicts
            raw,                // full file content including frontmatter - frontend parses it
          };
        })
      );

      entries.sort((a, b) => a.filename.localeCompare(b.filename));
      // dirs lets the client discover, e.g., which date-folders exist under entries/
      return res.status(200).json({ path: dirPath, entries, dirs });
    }

    // ---------- POST: create a new file ----------
    if (req.method === 'POST') {
      const { date, filename, path: explicitPath, content } = req.body;
      if (!content) {
        return res.status(400).json({ error: 'Missing content in request body' });
      }
      const path = explicitPath || (date && filename ? `entries/${date}/${filename}` : null);
      if (!path) {
        return res.status(400).json({ error: 'Provide either "path", or both "date" and "filename"' });
      }
      if (!pathAllowed(role, path)) return forbidden(path);
      const putUrl = `${base}/${path}`;

      const putResp = await fetch(putUrl, {
        method: 'PUT',
        headers: ghHeaders,
        body: JSON.stringify({
          message: `Add ${path}`,
          content: Buffer.from(content, 'utf-8').toString('base64'),
        }),
      });

      const putData = await putResp.json();
      if (!putResp.ok) return res.status(putResp.status).json({ error: putData });
      return res.status(201).json({ path, sha: putData.content.sha });
    }

    // ---------- PUT: write a file, creating it if it isn't there yet ----------
    if (req.method === 'PUT') {
      const { path, content, baseSha } = req.body;
      if (!path || !content) {
        return res.status(400).json({ error: 'Missing path or content in request body' });
      }
      if (!pathAllowed(role, path)) return forbidden(path);

      // GitHub requires the current file's sha to overwrite it, and rejects a
      // sha for a file that doesn't exist yet — so look first and send it only
      // when there's something to replace. This makes PUT an upsert, which is
      // what a repeating writer (the iPhone Calendar shortcut) needs: it
      // shouldn't have to know whether it's the first run or the hundredth.
      const getUrl = `${base}/${path}`;
      const getResp = await fetch(getUrl, { headers: ghHeaders });
      if (!getResp.ok && getResp.status !== 404) {
        const err = await getResp.text();
        return res.status(getResp.status).json({ error: err });
      }
      const current = getResp.ok ? await getResp.json() : null;

      // Optimistic concurrency. A caller that sends baseSha is saying "I edited
      // the version with this sha" — if the file has moved on since, someone
      // else got there first and we must not silently flatten their work. Send
      // their version back so the client can put the choice to a human.
      //
      // baseSha is optional on purpose: the iPhone shortcut has no way to track
      // shas, and its snapshot file has exactly one writer, so it keeps the old
      // last-write-wins behaviour.
      if (current && baseSha && current.sha !== baseSha) {
        return res.status(409).json({
          error: 'conflict',
          path,
          currentSha: current.sha,
          currentContent: Buffer.from(current.content, 'base64').toString('utf-8'),
        });
      }

      const putResp = await fetch(getUrl, {
        method: 'PUT',
        headers: ghHeaders,
        body: JSON.stringify({
          message: `${current ? 'Update' : 'Add'} ${path}`,
          content: Buffer.from(content, 'utf-8').toString('base64'),
          ...(current ? { sha: current.sha } : {}),
        }),
      });

      const putData = await putResp.json();
      if (!putResp.ok) return res.status(putResp.status).json({ error: putData });
      return res.status(200).json({ path, sha: putData.content.sha });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
