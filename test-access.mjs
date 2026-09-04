// Access-control tests for api/entries.js.
//
// These import resolveRole and pathAllowed from the real module rather than
// restating them, so the test cannot quietly drift from the code the way a
// hand-mirrored copy does. It is here because the rules are the one part of
// this project where a quiet mistake is a private journal handed to the wrong
// caller.
//
//     node test-access.mjs

// Set before the first call: resolveRole reads process.env each time it runs,
// so these stand in for the Vercel environment variables.
process.env.APP_SECRET = 'owner-secret';
process.env.FAMILY_SECRET = 'family-secret';
process.env.BOT_SECRET = 'bot-secret-value';

const { resolveRole, pathAllowed } = await import('./api/entries.js');

const BACKSLASH = String.fromCharCode(92);
const QUOTE = String.fromCharCode(34);

const ROLES = {
  owner: resolveRole('owner-secret'),
  family: resolveRole('family-secret'),
  bot: resolveRole('bot-secret-value'),
};

// [role, method, path, expected, why]
const CASES = [
  // --- the journal is the whole point of the boundary ---
  ['family', 'GET', 'entries', false, 'journal listing'],
  ['family', 'GET', 'entries/2026-08-21', false, 'a journal day'],
  ['family', 'PUT', 'entries/2026-08-21/09-00-00.md', false, 'writing a journal entry'],
  ['family', 'GET', 'crypto/keyinfo.md', false, 'the wrapped content key'],
  ['family', 'GET', 'habits', false, 'habits'],
  ['family', 'GET', 'collections', false, 'collections'],
  ['bot', 'GET', 'entries', false, 'journal listing'],
  ['bot', 'GET', 'crypto/keyinfo.md', false, 'the wrapped content key'],
  ['bot', 'PUT', 'entries/2026-08-21/09-00-00.md', false, 'writing a journal entry'],

  // --- the bot reaches the shared lists ---
  ['bot', 'GET', 'family/tasks', true, 'list tasks'],
  ['bot', 'PUT', 'family/tasks/abc.md', true, 'add a task'],
  ['bot', 'GET', 'family/shopping-lists', true, 'list shopping lists'],
  ['bot', 'PUT', 'family/shopping-lists/groceries.md', true, 'create a list'],
  ['bot', 'GET', 'family/shopping-items', true, 'list items'],
  ['bot', 'PUT', 'family/shopping-items/xyz.md', true, 'add an item'],

  // --- but not preferences, which is the point of the scoped role ---
  ['bot', 'GET', 'family/prefs', false, 'prefs listing'],
  ['bot', 'GET', 'family/prefs/liz.md', false, "someone else's settings"],
  ['bot', 'PUT', 'family/prefs/liz.md', false, 'rewriting settings'],

  // --- config: readable so ids are real, never writable ---
  ['bot', 'GET', 'family', true, 'listing family/ is how config.md is fetched'],
  ['bot', 'PUT', 'family', false, 'a read allowance must not grant writes'],
  ['bot', 'POST', 'family', false, 'same, via POST'],
  ['bot', 'PUT', 'family/config.md', false, 'the bot must not rewrite shared config'],

  // --- the family role keeps its whole subtree ---
  ['family', 'GET', 'family', true, 'root of its subtree'],
  ['family', 'GET', 'family/config.md', true, 'shared config'],
  ['family', 'PUT', 'family/config.md', true, 'a person may edit shared config'],
  ['family', 'PUT', 'family/prefs/liz.md', true, 'her own settings'],
  ['family', 'PUT', 'family/tasks/abc.md', true, 'a task'],

  // --- lookalikes must not slip past a prefix test ---
  ['family', 'GET', 'family-other/x', false, 'sibling with a similar name'],
  ['family', 'GET', 'familyother', false, 'no separator'],
  ['bot', 'GET', 'family/tasks-secret/x', false, 'lookalike under family/'],
  ['bot', 'GET', 'family/tasksomething', false, 'lookalike, no separator'],

  // --- traversal and encoding ---
  ['family', 'GET', 'family/../entries', false, 'traversal'],
  ['family', 'GET', 'family/%2e%2e/entries', false, 'encoded traversal'],
  ['family', 'GET', 'family%2Fprefs', false, 'encoded separator'],
  ['bot', 'GET', '/family/tasks', false, 'absolute path'],
  ['bot', 'GET', 'family' + BACKSLASH + 'tasks', false, 'backslash'],
  ['family', 'GET', '', false, 'empty'],

  // --- a path is a path, not a URL: no query, fragment, or quoting ---
  ['family', 'GET', 'family/tasks?ref=x', false, 'query string smuggled onto a path'],
  ['family', 'GET', 'family/tasks#x', false, 'fragment smuggled onto a path'],
  ['family', 'PUT', 'family/tasks/a' + QUOTE + 'b.md', false, 'a quote in a filename'],
  ['family', 'GET', 'family/./tasks', false, 'a single-dot segment'],
  ['family', 'PUT', 'family/tasks/my file.md', false, 'a space in a filename'],

  // --- the segment rule, at its edges ---
  ['family', 'GET', 'family//tasks', false, 'empty segment'],
  ['family', 'GET', 'family/tasks/', false, 'trailing slash leaves an empty segment'],
  ['family', 'GET', 'family/.git/config', false, 'a segment starting with a dot'],
  ['family', 'GET', 'family/-x/y', false, 'a segment starting with a dash'],
  ['family', 'PUT', 'family/tasks/a_b-c.1.md', true, 'dots, dashes and underscores are ordinary'],

  // --- owner still reaches everything ---
  ['owner', 'GET', 'entries', true, 'owner reads the journal'],
  ['owner', 'PUT', 'family/prefs/liz.md', true, 'owner is unrestricted'],
  ['owner', 'GET', 'crypto/keyinfo.md', true, 'owner reads the key'],
  ['owner', 'GET', 'family/../entries', false, 'traversal is refused for everyone'],
  ['owner', 'GET', 'family/tasks?ref=x', false, 'and so is a query string'],
];

// [secret, expected role name or null, why]
const ROLE_CASES = [
  ['owner-secret', 'owner', 'the owner secret'],
  ['family-secret', 'family', 'the family secret'],
  ['bot-secret-value', 'bot', 'the bot secret'],
  ['nope', null, 'an unknown secret'],
  ['owner-secrex', null, 'right length, wrong bytes'],
  ['owner-secret ', null, 'a trailing space is a different secret'],
  ['', null, 'the empty string'],
  [undefined, null, 'a missing header'],
  [null, null, 'a null header'],
  [42, null, 'a non-string header'],
];

let failures = 0;

console.log('\nresolveRole');
for (const [secret, expected, why] of ROLE_CASES) {
  const role = resolveRole(secret);
  const got = role ? role.name : null;
  const ok = got === expected;
  if (!ok) failures += 1;
  console.log(
    `  ${String(JSON.stringify(secret)).padEnd(18)} -> ${String(got).padEnd(7)} ` +
    `${ok ? 'ok   ' : 'WRONG'}  ${why}`
  );
}

// An unconfigured role must not exist at all — not even for the empty string,
// which is what an unset environment variable reads as.
delete process.env.FAMILY_SECRET;
{
  const ok = resolveRole('') === null && resolveRole('family-secret') === null;
  if (!ok) failures += 1;
  console.log(`  ${'(FAMILY unset)'.padEnd(18)} -> ${String(null).padEnd(7)} ` +
    `${ok ? 'ok   ' : 'WRONG'}  an unconfigured role matches nothing`);
}
process.env.FAMILY_SECRET = 'family-secret';

const width = Math.max(...CASES.map((c) => JSON.stringify(c[2]).length)) + 1;
let current = null;
for (const [roleName, method, path, expected, why] of CASES) {
  const got = pathAllowed(ROLES[roleName], path, method);
  const ok = got === expected;
  if (!ok) failures += 1;
  if (roleName !== current) {
    current = roleName;
    console.log('');
  }
  console.log(
    `  ${roleName.padEnd(6)} ${method.padEnd(4)} ${JSON.stringify(path).padEnd(width)} ` +
    `${String(got).padEnd(5)} ${ok ? 'ok   ' : 'WRONG'}  ${why}`
  );
}

console.log('');
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log(`all ${CASES.length + ROLE_CASES.length + 1} access rules hold`);
