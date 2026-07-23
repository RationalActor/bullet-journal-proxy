// api/entries.js
//
// One endpoint, three uses:
//   GET  /api/entries?date=YYYY-MM-DD          -> list all entries for that day
//   POST /api/entries                          -> create a new entry
//   PUT  /api/entries                           -> update an existing entry (reclassify, fix text, mark reviewed)
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
    // ---------- GET: list a day's entries ----------
    if (req.method === 'GET') {
      const { date } = req.query;
      if (!date) {
        return res.status(400).json({ error: 'Missing "date" query param (YYYY-MM-DD)' });
      }

      const dirUrl = `${base}/entries/${date}`;
      const dirResp = await fetch(dirUrl, { headers: ghHeaders });

      if (dirResp.status === 404) {
        // No entries yet for that day - not an error, just empty
        return res.status(200).json({ date, entries: [] });
      }
      if (!dirResp.ok) {
        const err = await dirResp.text();
        return res.status(dirResp.status).json({ error: err });
      }

      const files = await dirResp.json();
      const mdFiles = files.filter((f) => f.name.endsWith('.md'));

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
      return res.status(200).json({ date, entries });
    }

    // ---------- POST: create a new entry ----------
    if (req.method === 'POST') {
      const { date, filename, content } = req.body;
      if (!date || !filename || !content) {
        return res.status(400).json({ error: 'Missing date, filename, or content in request body' });
      }
      const path = `entries/${date}/${filename}`;
      const putUrl = `${base}/${path}`;

      const putResp = await fetch(putUrl, {
        method: 'PUT',
        headers: ghHeaders,
        body: JSON.stringify({
          message: `Add entry ${path}`,
          content: Buffer.from(content, 'utf-8').toString('base64'),
        }),
      });

      const putData = await putResp.json();
      if (!putResp.ok) return res.status(putResp.status).json({ error: putData });
      return res.status(201).json({ path, sha: putData.content.sha });
    }

    // ---------- PUT: update an existing entry (reclassify / fix text / mark reviewed) ----------
    if (req.method === 'PUT') {
      const { path, content } = req.body;
      if (!path || !content) {
        return res.status(400).json({ error: 'Missing path or content in request body' });
      }

      // GitHub requires the current file's sha to accept an update
      const getUrl = `${base}/${path}`;
      const getResp = await fetch(getUrl, { headers: ghHeaders });
      if (!getResp.ok) {
        const err = await getResp.text();
        return res.status(getResp.status).json({ error: err });
      }
      const current = await getResp.json();

      const putResp = await fetch(getUrl, {
        method: 'PUT',
        headers: ghHeaders,
        body: JSON.stringify({
          message: `Update entry ${path}`,
          content: Buffer.from(content, 'utf-8').toString('base64'),
          sha: current.sha,
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
