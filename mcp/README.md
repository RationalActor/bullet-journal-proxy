# family-lists MCP server

Gives a self-hosted assistant — OpenClaw, Claude Desktop, anything that speaks
MCP — the ability to add to and read the family task and shopping lists.

It holds no data. Every call is a read or write against the same proxy the two
apps use, so anything added here appears in both apps on their next sync, and
anything done in an app is visible here immediately.

## What it can and cannot reach

The scope is enforced by the proxy, not by this server. `BOT_SECRET` resolves to
a role confined to:

| | |
|---|---|
| `family/tasks/` | read and write |
| `family/shopping-lists/` | read and write |
| `family/shopping-items/` | read and write |
| `family/config.md` | **read only**, so it uses real category and shop ids |
| `family/prefs/` | **refused** — how someone arranges their own screen is theirs |
| the journal, the wrapped key, habits, collections | **refused** |

Those rules live in `api/entries.js` and are covered by `test-access.mjs` in the
parent folder. Treat the tool list here as a convenience; the boundary is the
server's.

## Setup

### 1. Add the secret to Vercel

Project → Settings → Environment Variables:

- **`BOT_SECRET`** — a new value. It must differ from `APP_SECRET` and
  `FAMILY_SECRET`; roles are matched by exact string, and a duplicate would
  silently take the wider of the two.
- Tick **Production**.
- **Redeploy** — environment changes don't reach an existing deployment.

Revoking the assistant's access later is a matter of clearing this one variable
and redeploying. Nobody else's access changes.

### 2. Install

```sh
cd mcp
npm install
```

Node 20 or newer.

### 3. Point the assistant at it

Configure it as a stdio MCP server. For OpenClaw, add to your MCP config:

```json
{
  "mcpServers": {
    "family-lists": {
      "command": "node",
      "args": ["/absolute/path/to/bullet-journal-proxy/mcp/server.js"],
      "env": {
        "FAMILY_PROXY_URL": "https://your-project.vercel.app",
        "FAMILY_BOT_SECRET": "the BOT_SECRET value",
        "FAMILY_BOT_AUTHOR": "liz"
      }
    }
  }
}
```

`FAMILY_PROXY_URL` is the address on its own — no `/api/entries`, no page, no
trailing slash.

`FAMILY_BOT_AUTHOR` decides whose name lands on what the assistant creates. It
defaults to `liz` on the reasoning that a task she asked for is hers. Set it to
something else if you would rather these read as coming from a machine.

### 4. Check it

```sh
FAMILY_PROXY_URL=https://your-project.vercel.app \
FAMILY_BOT_SECRET=... \
node server.js
```

It should print `family-lists MCP server ready` and wait. If the secret or URL
is wrong you'll see it on the first tool call, with a message naming which.

## Tools

| Tool | Does |
|---|---|
| `get_family_config` | the real people, categories, shops and lists |
| `list_tasks` | open tasks, optionally for one person |
| `add_tasks` | add several at once |
| `complete_task` | tick one off |
| `list_shopping` | what's waiting, by list, with preferred shop |
| `add_shopping_items` | add several at once |
| `complete_shopping_item` | mark bought |

Both `add_` tools take arrays on purpose. "Milk, eggs, and remind me to call the
plumber Thursday" should be two calls, not four.

## Two things worth knowing

**An item is a need, not a row on a shop's list.** A shopping item belongs to
one list and carries a preferred shop as an attribute. Buying it anywhere ticks
it off everywhere. Never add the same thing twice to cover two shops — that
recreates exactly the problem the shopping design exists to avoid.

**Unknown categories are refused, not guessed.** Pass a name or an id, in any
case, and it resolves against the shared config; anything unrecognised comes
back as an error listing the real options. A task filed under a category that
doesn't exist is invisible to every filter in both apps, so failing loudly is
the kinder outcome.

## Conflicts

Edits send the sha they were based on, so if someone ticked the same task off in
an app in the meantime, the proxy answers 409 rather than flattening them. That
surfaces as an error on the tool call — re-read and try again. New tasks and
items can't collide: each is its own file under a fresh UUID.
