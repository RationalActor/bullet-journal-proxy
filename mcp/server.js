#!/usr/bin/env node
//
// An MCP server exposing the family task and shopping lists.
//
// It runs wherever the assistant runs (a Mac mini, in this case) and talks to
// the same proxy the apps use, with its own secret. It holds no data of its
// own: every tool call is a read or a write against the repo, so anything it
// adds shows up in both apps on their next sync, and anything a person does in
// an app is visible here immediately.
//
// What it can reach is decided by the proxy, not by this file. BOT_SECRET
// resolves to a role scoped to family/tasks/ and family/shopping-*/, plus read
// access to family/config.md. The journal and both people's preferences are
// refused at the server regardless of what this code asks for. Treat the scope
// here as a convenience, never as the boundary.
//
// Environment:
//   FAMILY_PROXY_URL   https://<your-project>.vercel.app   (no trailing path)
//   FAMILY_BOT_SECRET  the value of BOT_SECRET in the Vercel project
//   FAMILY_BOT_AUTHOR  optional; whose name lands on what it creates.
//                      Defaults to "liz" - it is her assistant, and a task she
//                      asked for is hers. Set it to something else if you would
//                      rather these read as coming from a machine.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';

const PROXY = (process.env.FAMILY_PROXY_URL || '').trim().replace(/\/+$/, '');
const SECRET = (process.env.FAMILY_BOT_SECRET || '').trim();
const AUTHOR = (process.env.FAMILY_BOT_AUTHOR || 'liz').trim();

if (!PROXY || !SECRET) {
  console.error('FAMILY_PROXY_URL and FAMILY_BOT_SECRET must both be set.');
  process.exit(1);
}

const TASKS_DIR = 'family/tasks';
const LISTS_DIR = 'family/shopping-lists';
const ITEMS_DIR = 'family/shopping-items';
const IMPORTANCE = ['low', 'normal', 'high'];

// ---------- talking to the proxy ----------

async function api(path, init) {
  const resp = await fetch(`${PROXY}/api/entries${path}`, {
    ...init,
    headers: { 'x-app-secret': SECRET, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (resp.status === 401) {
    throw new Error('The proxy rejected FAMILY_BOT_SECRET. Check it matches BOT_SECRET in the Vercel project, and that the project has been redeployed since it was set.');
  }
  if (resp.status === 403) {
    throw new Error('The proxy refused this path. The bot role reaches tasks and shopping only - not preferences, and not the journal.');
  }
  if (resp.status === 404) {
    throw new Error(`No proxy found at ${PROXY}. FAMILY_PROXY_URL should be just the address, with nothing after it.`);
  }
  if (!resp.ok) {
    throw new Error(`The proxy answered ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  return resp.json();
}

const listFolder = (folder) => api(`?folder=${encodeURIComponent(folder)}`);

// baseSha is what makes an edit safe: it says "I changed the version I read".
// If someone ticked the same thing off in an app since, the proxy answers 409
// rather than quietly flattening them.
async function writeFile(path, content, baseSha) {
  return api('', {
    method: 'PUT',
    body: JSON.stringify({ path, content, ...(baseSha ? { baseSha } : {}) }),
  });
}

// ---------- the file format, mirroring the app exactly ----------

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { fields: {}, body: raw.trim() };
  const fields = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { fields, body: match[2].replace(/\n$/, '') };
}

const pad = (n) => String(n).padStart(2, '0');

// Local time with no zone suffix, because that is what the apps write and the
// two have to sort against each other.
function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// A single line of frontmatter can't carry a newline, and the app's parser
// splits on them - so a colon is fine, a line break is not.
const oneLine = (s) => String(s == null ? '' : s).replace(/\s*\n+\s*/g, ' ').trim();

function taskMarkdown(t) {
  let fm = '---\ntype: family-task\n';
  fm += `assignee: ${t.assignee}\ncategory: ${t.category}\nimportance: ${t.importance}\n`;
  if (t.deadline) fm += `deadline: ${t.deadline}\n`;
  fm += `done: ${!!t.done}\n`;
  fm += `created: ${t.created}\ncreated_by: ${t.createdBy}\n`;
  fm += `updated: ${t.updated}\nupdated_by: ${t.updatedBy}\n`;
  if (t.deleted) fm += 'deleted: true\n';
  return `${fm}---\n${t.content}\n`;
}

function itemMarkdown(it) {
  let fm = `---\ntype: shopping-item\nlist: ${it.listId}\n`;
  if (it.store) fm += `store: ${it.store}\n`;
  if (it.note) fm += `note: ${it.note}\n`;
  fm += `done: ${!!it.done}\n`;
  fm += `added: ${it.added}\nadded_by: ${it.addedBy}\n`;
  fm += `updated: ${it.updated}\nupdated_by: ${it.updatedBy}\n`;
  if (it.deleted) fm += 'deleted: true\n';
  return `${fm}---\n${it.name}\n`;
}

const listMarkdown = (l) =>
  `---\ntype: shopping-list\nname: ${l.name}\ndeleted: ${!!l.deleted}\n---\n${l.name}\n`;

// ---------- reading what's there ----------

const DEFAULT_CONFIG = {
  assignees: [{ id: 'michael', name: 'Michael' }, { id: 'liz', name: 'Liz' }, { id: 'shared', name: 'Shared' }],
  categories: [{ id: 'desk', name: 'Desk' }, { id: 'house', name: 'House' },
               { id: 'charlotte', name: 'Charlotte' }, { id: 'other', name: 'Other' }],
  stores: [{ id: 'costco', name: 'Costco' }],
};

// The shared config names the real categories, people and shops. Fetching it is
// the difference between filing something under "house" and inventing a
// "kitchen" that no filter in either app will ever match.
async function getConfig() {
  const data = await listFolder('family');
  const file = (data.entries || []).find((f) => f.filename === 'config.md');
  if (!file) return DEFAULT_CONFIG;
  try {
    const parsed = JSON.parse(parseFrontmatter(file.raw).body);
    return {
      assignees: parsed.assignees || DEFAULT_CONFIG.assignees,
      categories: parsed.categories || DEFAULT_CONFIG.categories,
      stores: parsed.stores || DEFAULT_CONFIG.stores,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function getTasks() {
  const data = await listFolder(TASKS_DIR);
  return (data.entries || []).map((f) => {
    const { fields, body } = parseFrontmatter(f.raw);
    return {
      id: f.filename.replace(/\.md$/, ''),
      title: body,
      assignee: fields.assignee || 'shared',
      category: fields.category || 'other',
      importance: fields.importance || 'normal',
      deadline: fields.deadline || null,
      done: fields.done === 'true',
      deleted: fields.deleted === 'true',
      path: f.path,
      sha: f.sha,
      raw: f.raw,
    };
  }).filter((t) => !t.deleted);
}

async function getShopping() {
  const [listsData, itemsData] = await Promise.all([listFolder(LISTS_DIR), listFolder(ITEMS_DIR)]);
  const lists = (listsData.entries || []).map((f) => {
    const { fields } = parseFrontmatter(f.raw);
    return {
      id: f.filename.replace(/\.md$/, ''),
      name: fields.name || '(untitled)',
      deleted: fields.deleted === 'true',
      path: f.path,
      sha: f.sha,
    };
  }).filter((l) => !l.deleted);

  const items = (itemsData.entries || []).map((f) => {
    const { fields, body } = parseFrontmatter(f.raw);
    return {
      id: f.filename.replace(/\.md$/, ''),
      name: body,
      listId: fields.list || '',
      store: fields.store || '',
      note: fields.note || '',
      done: fields.done === 'true',
      deleted: fields.deleted === 'true',
      added: fields.added || '',
      addedBy: fields.added_by || '',
      path: f.path,
      sha: f.sha,
    };
  }).filter((i) => !i.deleted);

  return { lists, items };
}

// ---------- resolving what a person said to what the app stores ----------

// Accepts an id or a display name, case-insensitively, because an assistant is
// being handed words a human said. Anything it can't place is refused with the
// real options rather than guessed at - a task filed under a category that
// doesn't exist is invisible to every filter in both apps.
function resolveId(value, options, { label, fallback }) {
  const raw = (value == null ? '' : String(value)).trim();
  if (!raw) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing ${label}.`);
  }
  const needle = raw.toLowerCase();
  const hit = options.find((o) => o.id.toLowerCase() === needle)
    || options.find((o) => o.name.toLowerCase() === needle);
  if (hit) return hit.id;
  throw new Error(
    `Unknown ${label} "${raw}". Available: ${options.map((o) => `${o.name} (${o.id})`).join(', ')}.`
  );
}

function validDeadline(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Deadline must be a date as YYYY-MM-DD, got "${s}". Resolve relative dates like "Thursday" before calling.`);
  }
  return s;
}

// ---------- tools ----------

const TOOLS = [
  {
    name: 'get_family_config',
    description: 'The people, task categories and shops the family lists actually use, plus the shopping lists that exist. Call this first when you are unsure what values are valid.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tasks',
    description: 'The family task list. Returns open tasks by default, soonest deadline first, undated last.',
    inputSchema: {
      type: 'object',
      properties: {
        assignee: { type: 'string', description: 'Optional. Limit to one person, or "shared".' },
        include_done: { type: 'boolean', description: 'Include completed tasks. Default false.' },
      },
    },
  },
  {
    name: 'add_tasks',
    description: 'Add one or more tasks to the family list. Pass every task in a single call rather than calling repeatedly.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'What needs doing.' },
              assignee: { type: 'string', description: 'Person or "shared". Defaults to shared.' },
              category: { type: 'string', description: 'Defaults to other.' },
              importance: { type: 'string', enum: IMPORTANCE, description: 'Defaults to normal.' },
              deadline: { type: 'string', description: 'YYYY-MM-DD. Resolve "Thursday" to a date first.' },
            },
            required: ['title'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'complete_task',
    description: 'Tick a task off. Takes the id from list_tasks.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'list_shopping',
    description: 'What is waiting to be bought, grouped by list, with each item\'s preferred shop.',
    inputSchema: {
      type: 'object',
      properties: {
        list: { type: 'string', description: 'Optional list name to limit to.' },
        include_bought: { type: 'boolean', description: 'Include items already bought. Default false.' },
      },
    },
  },
  {
    name: 'add_shopping_items',
    description: 'Add one or more items to a shopping list. An item is a single need with a preferred shop, not a row on that shop\'s list - buying it anywhere ticks it off everywhere, so never add the same thing twice for two shops.',
    inputSchema: {
      type: 'object',
      properties: {
        list: { type: 'string', description: 'List name, e.g. "Groceries". Uses the only list if there is just one.' },
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              store: { type: 'string', description: 'Where it is usually bought. Optional - omit for "anywhere".' },
              note: { type: 'string' },
            },
            required: ['name'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'complete_shopping_item',
    description: 'Mark an item as bought. Takes the id from list_shopping.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
];

// ---------- tool implementations ----------

async function toolGetConfig() {
  const [config, shopping] = await Promise.all([getConfig(), getShopping()]);
  return {
    people: config.assignees,
    categories: config.categories,
    shops: config.stores,
    importance_levels: IMPORTANCE,
    shopping_lists: shopping.lists.map((l) => ({ id: l.id, name: l.name })),
  };
}

async function toolListTasks({ assignee, include_done }) {
  const [config, tasks] = await Promise.all([getConfig(), getTasks()]);
  let out = include_done ? tasks : tasks.filter((t) => !t.done);
  if (assignee) {
    const id = resolveId(assignee, config.assignees, { label: 'person' });
    out = out.filter((t) => t.assignee === id);
  }
  const name = (list, id) => (list.find((x) => x.id === id) || {}).name || id;
  out.sort((a, b) => String(a.deadline || '9999').localeCompare(String(b.deadline || '9999')));
  return {
    count: out.length,
    tasks: out.map((t) => ({
      id: t.id,
      title: t.title,
      assignee: name(config.assignees, t.assignee),
      category: name(config.categories, t.category),
      importance: t.importance,
      deadline: t.deadline,
      done: t.done,
    })),
  };
}

async function toolAddTasks({ tasks }) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('Provide at least one task.');
  const config = await getConfig();
  const stamp = nowStamp();
  const added = [];

  for (const input of tasks) {
    const title = oneLine(input.title);
    if (!title) throw new Error('A task needs a title.');
    const record = {
      content: title,
      assignee: resolveId(input.assignee, config.assignees, { label: 'person', fallback: 'shared' }),
      category: resolveId(input.category, config.categories, { label: 'category', fallback: 'other' }),
      importance: IMPORTANCE.includes(String(input.importance || '').toLowerCase())
        ? String(input.importance).toLowerCase() : 'normal',
      deadline: validDeadline(input.deadline),
      done: false,
      created: stamp, createdBy: AUTHOR,
      updated: stamp, updatedBy: AUTHOR,
    };
    const id = randomUUID();
    await writeFile(`${TASKS_DIR}/${id}.md`, taskMarkdown(record));
    added.push({ id, title, assignee: record.assignee, category: record.category, deadline: record.deadline });
  }

  return { added: added.length, tasks: added, note: 'Both apps will show these on their next sync.' };
}

async function toolCompleteTask({ id }) {
  const tasks = await getTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`No task with id "${id}". Call list_tasks for current ids.`);
  if (task.done) return { id, title: task.title, already_done: true };

  const { fields, body } = parseFrontmatter(task.raw);
  const stamp = nowStamp();
  const markdown = taskMarkdown({
    content: body,
    assignee: fields.assignee || 'shared',
    category: fields.category || 'other',
    importance: fields.importance || 'normal',
    deadline: fields.deadline || null,
    done: true,
    created: fields.created || stamp,
    createdBy: fields.created_by || AUTHOR,
    updated: stamp,
    updatedBy: AUTHOR,
  });
  await writeFile(task.path, markdown, task.sha);
  return { id, title: task.title, done: true };
}

async function toolListShopping({ list, include_bought }) {
  const [config, { lists, items }] = await Promise.all([getConfig(), getShopping()]);
  let wanted = lists;
  if (list) {
    const hit = lists.find((l) => l.name.toLowerCase() === String(list).trim().toLowerCase());
    if (!hit) throw new Error(`No shopping list called "${list}". Existing: ${lists.map((l) => l.name).join(', ') || 'none yet'}.`);
    wanted = [hit];
  }
  const shopName = (id) => (config.stores.find((s) => s.id === id) || {}).name || id || 'anywhere';
  return {
    lists: wanted.map((l) => {
      const mine = items.filter((i) => i.listId === l.id && (include_bought || !i.done));
      return {
        list: l.name,
        count: mine.length,
        items: mine.map((i) => ({
          id: i.id, name: i.name, shop: shopName(i.store), note: i.note || undefined, bought: i.done,
        })),
      };
    }),
  };
}

async function toolAddShoppingItems({ list, items }) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Provide at least one item.');
  const [config, shopping] = await Promise.all([getConfig(), getShopping()]);

  let target;
  if (list) {
    target = shopping.lists.find((l) => l.name.toLowerCase() === String(list).trim().toLowerCase());
    if (!target) {
      // Creating one is reasonable when asked for by name; silently inventing
      // one because the argument was omitted would not be.
      const id = randomUUID();
      const name = oneLine(list);
      await writeFile(`${LISTS_DIR}/${id}.md`, listMarkdown({ name }));
      target = { id, name };
    }
  } else if (shopping.lists.length === 1) {
    target = shopping.lists[0];
  } else if (shopping.lists.length === 0) {
    throw new Error('There are no shopping lists yet. Pass `list` with a name to create one.');
  } else {
    throw new Error(`Which list? ${shopping.lists.map((l) => l.name).join(', ')}.`);
  }

  const stamp = nowStamp();
  const added = [];
  for (const input of items) {
    const name = oneLine(input.name);
    if (!name) throw new Error('An item needs a name.');
    const store = input.store
      ? resolveId(input.store, config.stores, { label: 'shop' })
      : '';
    const id = randomUUID();
    await writeFile(`${ITEMS_DIR}/${id}.md`, itemMarkdown({
      listId: target.id, name, store, note: oneLine(input.note),
      done: false, added: stamp, addedBy: AUTHOR, updated: stamp, updatedBy: AUTHOR,
    }));
    added.push({ id, name, shop: store || 'anywhere' });
  }

  return { list: target.name, added: added.length, items: added };
}

async function toolCompleteShoppingItem({ id }) {
  const { items } = await getShopping();
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`No shopping item with id "${id}". Call list_shopping for current ids.`);
  if (item.done) return { id, name: item.name, already_bought: true };

  const stamp = nowStamp();
  await writeFile(item.path, itemMarkdown({
    listId: item.listId, name: item.name, store: item.store, note: item.note,
    done: true,
    added: item.added || stamp, addedBy: item.addedBy || AUTHOR,
    updated: stamp, updatedBy: AUTHOR,
  }), item.sha);
  return { id, name: item.name, bought: true };
}

const HANDLERS = {
  get_family_config: toolGetConfig,
  list_tasks: toolListTasks,
  add_tasks: toolAddTasks,
  complete_task: toolCompleteTask,
  list_shopping: toolListShopping,
  add_shopping_items: toolAddShoppingItems,
  complete_shopping_item: toolCompleteShoppingItem,
};

// ---------- wiring ----------

const server = new Server(
  { name: 'family-lists', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const handler = HANDLERS[request.params.name];
  if (!handler) {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }] };
  }
  try {
    const result = await handler(request.params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    // Back to the model as an error it can act on - a wrong category should
    // prompt another attempt with a real one, not a crashed server.
    return { isError: true, content: [{ type: 'text', text: err.message }] };
  }
});

await server.connect(new StdioServerTransport());
console.error('family-lists MCP server ready');
