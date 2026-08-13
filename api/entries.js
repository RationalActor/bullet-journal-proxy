// api/entries.js
//
// One endpoint:
//   GET  /api/entries?date=YYYY-MM-DD    -> list all files in entries/<date>
//   GET  /api/entries?folder=<path>      -> list all files (and subfolders) in an arbitrary repo folder
//   POST /api/entries                    -> create a new file (date+filename, OR an explicit path)
//   PUT  /api/entries                    -> update an existing file at a given path
//
// Every request must include header:  x-app-secret: <your secret>
// Set these in Vercel project settings -> Environment Variables:
//   GITHUB_TOKEN   - a GitHub personal access token with repo access
//   GITHUB_OWNER   - your GitHub username
//   GITHUB_REPO    - "bullet-journal"
//   APP_SECRET     - a password you make up, shared only between this
//                    function and your web app / iPad shortcuts

export default async function handler(req, res) {
  // Allow the web app (hosted elsewhere) to call this function
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-app-secret');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // --- Auth: reject anyone without the shared secret ---
  const secret = req.headers['x-app-secret'];
  if (!secret || secret !== process.env.APP_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
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

  try {
    // ---------- GET: list a folder (a day's entries, or any arbitrary repo folder) ----------
    if (req.method === 'GET') {
      const { date, folder } = req.query;
      let dirPath;
      if (date) dirPath = `entries/${date}`;
      else if (folder) dirPath = folder;
      else return res.status(400).json({ error: 'Missing "date" or "folder" query param' });

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
            sha: fileData.sha,  // handy for the frontend, not required for update calls
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
      const { path, content } = req.body;
      if (!path || !content) {
        return res.status(400).json({ error: 'Missing path or content in request body' });
      }

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
