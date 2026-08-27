"""Access-control tests for api/entries.js.

There is no Node on the machine this was written on, so this mirrors
resolveRole/pathAllowed rather than importing them. That makes it a check on the
*rules*, not on the code - if you change entries.js, change this to match and
re-read both. It is here because the rules are the one part of this project
where a quiet mistake is a private journal handed to the wrong caller.

    python test-access.py
"""
import sys

BACKSLASH = chr(92)

ROLES = {
    'owner':  {'prefixes': None, 'readable': []},
    'family': {'prefixes': ['family/'], 'readable': []},
    'bot':    {'prefixes': ['family/tasks/', 'family/shopping-lists/', 'family/shopping-items/'],
               'readable': ['family']},
}


def path_allowed(role, path, method):
    if not isinstance(path, str) or len(path) == 0:
        return False
    if path.startswith('/') or BACKSLASH in path:
        return False
    if '..' in path:
        return False
    if any(x in path for x in ('%2e', '%2E', '%2f', '%2F')):
        return False
    if role['prefixes'] is None:
        return True
    if method == 'GET' and path in role.get('readable', []):
        return True
    for prefix in role['prefixes']:
        root = prefix[:-1] if prefix.endswith('/') else prefix
        if path == root or path.startswith(prefix):
            return True
    return False


# (role, method, path, expected, why)
CASES = [
    # --- the journal is the whole point of the boundary ---
    ('family', 'GET', 'entries', False, 'journal listing'),
    ('family', 'GET', 'entries/2026-08-21', False, 'a journal day'),
    ('family', 'PUT', 'entries/2026-08-21/09-00-00.md', False, 'writing a journal entry'),
    ('family', 'GET', 'crypto/keyinfo.md', False, 'the wrapped content key'),
    ('family', 'GET', 'habits', False, 'habits'),
    ('family', 'GET', 'collections', False, 'collections'),
    ('bot', 'GET', 'entries', False, 'journal listing'),
    ('bot', 'GET', 'crypto/keyinfo.md', False, 'the wrapped content key'),
    ('bot', 'PUT', 'entries/2026-08-21/09-00-00.md', False, 'writing a journal entry'),

    # --- the bot reaches the shared lists ---
    ('bot', 'GET', 'family/tasks', True, 'list tasks'),
    ('bot', 'PUT', 'family/tasks/abc.md', True, 'add a task'),
    ('bot', 'GET', 'family/shopping-lists', True, 'list shopping lists'),
    ('bot', 'PUT', 'family/shopping-lists/groceries.md', True, 'create a list'),
    ('bot', 'GET', 'family/shopping-items', True, 'list items'),
    ('bot', 'PUT', 'family/shopping-items/xyz.md', True, 'add an item'),

    # --- but not preferences, which is the point of the scoped role ---
    ('bot', 'GET', 'family/prefs', False, 'prefs listing'),
    ('bot', 'GET', 'family/prefs/liz.md', False, 'someone else\'s settings'),
    ('bot', 'PUT', 'family/prefs/liz.md', False, 'rewriting settings'),

    # --- config: readable so ids are real, never writable ---
    ('bot', 'GET', 'family', True, 'listing family/ is how config.md is fetched'),
    ('bot', 'PUT', 'family', False, 'a read allowance must not grant writes'),
    ('bot', 'POST', 'family', False, 'same, via POST'),
    ('bot', 'PUT', 'family/config.md', False, 'the bot must not rewrite shared config'),

    # --- the family role keeps its whole subtree ---
    ('family', 'GET', 'family', True, 'root of its subtree'),
    ('family', 'GET', 'family/config.md', True, 'shared config'),
    ('family', 'PUT', 'family/config.md', True, 'a person may edit shared config'),
    ('family', 'PUT', 'family/prefs/liz.md', True, 'her own settings'),
    ('family', 'PUT', 'family/tasks/abc.md', True, 'a task'),

    # --- lookalikes must not slip past a prefix test ---
    ('family', 'GET', 'family-other/x', False, 'sibling with a similar name'),
    ('family', 'GET', 'familyother', False, 'no separator'),
    ('bot', 'GET', 'family/tasks-secret/x', False, 'lookalike under family/'),
    ('bot', 'GET', 'family/tasksomething', False, 'lookalike, no separator'),

    # --- traversal and encoding ---
    ('family', 'GET', 'family/../entries', False, 'traversal'),
    ('family', 'GET', 'family/%2e%2e/entries', False, 'encoded traversal'),
    ('family', 'GET', 'family%2Fprefs', False, 'encoded separator'),
    ('bot', 'GET', '/family/tasks', False, 'absolute path'),
    ('bot', 'GET', 'family' + BACKSLASH + 'tasks', False, 'backslash'),
    ('family', 'GET', '', False, 'empty'),

    # --- owner still reaches everything ---
    ('owner', 'GET', 'entries', True, 'owner reads the journal'),
    ('owner', 'PUT', 'family/prefs/liz.md', True, 'owner is unrestricted'),
    ('owner', 'GET', 'crypto/keyinfo.md', True, 'owner reads the key'),
    ('owner', 'GET', 'family/../entries', False, 'traversal is refused for everyone'),
]


def main():
    failures = []
    width = max(len(c[2]) for c in CASES) + 2
    current = None
    for role_name, method, path, expected, why in CASES:
        got = path_allowed(ROLES[role_name], path, method)
        ok = got == expected
        if not ok:
            failures.append((role_name, method, path, expected, got, why))
        if role_name != current:
            current = role_name
            print()
        print('  %-6s %-4s %-*s %-5s %s  %s' % (
            role_name, method, width, repr(path), got,
            'ok   ' if ok else 'WRONG', why))

    print()
    if failures:
        print('%d FAILED:' % len(failures))
        for role_name, method, path, expected, got, why in failures:
            print('  %s %s %r: expected %s, got %s (%s)' % (
                role_name, method, path, expected, got, why))
        return 1
    print('all %d access rules hold' % len(CASES))
    return 0


if __name__ == '__main__':
    sys.exit(main())
