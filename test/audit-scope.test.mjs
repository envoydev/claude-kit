// bin/audit-scope.mjs, run as the command it is, in a throwaway git repository of rules, skills and hooks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REAL_KIT, cannotLockFolders, makeRepo, makeTempDir, runNode, writeFiles } from './support.mjs';

const AUDIT_SCOPE = path.join(REAL_KIT, 'bin', 'audit-scope.mjs');
const SKILL = '.claude/skills/repo-audit-rules';
const RUN = 'docs/superpowers/audits/2026-11-17-rules';
const STATE = 'docs/superpowers/audits/state/rules.json';
const GRADES = 'docs/grades.tsv';
const BOTH_A = 'rules/a.md\tA\t9\tyes\nrules/b.md\tA\t9.5\tyes\n';
const ONLY_A = 'rules/a.md\tA\t9\tyes\n';
const GRADED = /^Graded under: [0-9a-f]{40} [0-9a-f]{40}$/;
const SHARED_DEFAULTS = ['--with', 'cfg/defaults.json', 'rules'];
const FILES = {
    '.gitignore': '.claude/\ndocs/\n',
    'rules/a.md': 'A\n',
    'rules/b.md': 'B\n',
    'AGENTS.md': 'agents\n',
    'skills/one/SKILL.md': 'one\n',
    'skills/one/references/x.md': 'x\n',
    'skills/two/SKILL.md': 'two\n',
    'hooks/guard.mjs': 'guard\n',
    'hooks/helper.mjs': 'helper\n',
    'hooks/data/list.json': '[]\n',
    'cfg/defaults.json': '{}\n',
    [`${SKILL}/SKILL.md`]: 'audit\n',
    [`${SKILL}/references/rubric.md`]: 'rubric\n',
    [`${SKILL}/references/currency.md`]: 'currency\n',
};

const localDate = (now) => [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
const TODAY = localDate(new Date());
const EARLIER = daysAgo(20);
const LATER = daysAgo(10);

function daysAgo(count)
{
    const now = new Date();
    return localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - count));
}

function git(repo, ...args)
{
    const result = spawnSync('git', ['-c', 'user.name=tester', '-c', 'user.email=tester@example.com', '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

const carried = (id, grade, date = TODAY) => `carried ${id} - ${grade} from ${date} - ${RUN}`;
const splitOptions = (args) => (typeof args.at(-1) === 'object' ? [args.slice(0, -1), args.at(-1)] : [args, {}]);

// The lines a successful run printed, less its last one, which always says what the grades were given under.
function lines(result)
{
    assert.equal(result.stderr, '');
    assert.equal(result.status, 0);
    const printed = result.stdout.split('\n');
    assert.equal(printed.pop(), '');
    assert.match(printed.pop(), GRADED);
    return printed;
}

function refused(result, message)
{
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    if (message === undefined) assert.match(result.stderr, /^audit-scope: [^\n]+\n$/);
    else assert.equal(result.stderr, `audit-scope: ${message}\n`);
}

// A repository holding FILES, all committed but what .gitignore leaves out. `scope` and `record` take the kind as an option last.
function project(t)
{
    const repo = makeRepo(t, FILES);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'baseline');
    const run = (args, { cwd = repo } = {}) => runNode(AUDIT_SCOPE, args, { cwd });
    const stateFile = (kind) => path.join(repo, `docs/superpowers/audits/state/${kind}.json`);
    return {
        repo,
        run,
        scope(...args)
        {
            const [rest, { kind = 'rules', cwd }] = splitOptions(args);
            return run(['scope', kind, ...rest], { cwd });
        },
        record(grades, ...args)
        {
            const [rest, { kind = 'rules' }] = splitOptions(args);
            writeFiles(repo, { [GRADES]: grades });
            return run(['record', kind, '--run', `docs/superpowers/audits/2026-11-17-${kind}`, '--grades', GRADES, ...rest]);
        },
        state: (kind = 'rules') => JSON.parse(fs.readFileSync(stateFile(kind), 'utf8')),
        setState(change, kind = 'rules')
        {
            const state = JSON.parse(fs.readFileSync(stateFile(kind), 'utf8'));
            change(state);
            fs.writeFileSync(stateFile(kind), `${JSON.stringify(state, null, 2)}\n`);
        },
        write: (rel, text) => writeFiles(repo, { [rel]: text }),
        remove: (rel) => fs.rmSync(path.join(repo, rel)),
        add: (...rels) => git(repo, 'add', ...rels),
        commit: () => git(repo, 'commit', '-q', '-m', 'more'),
        tree()
        {
            const entries = fs.readdirSync(repo, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
            const files = entries.map((entry) => path.relative(repo, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
            return new Map(files.filter((rel) => !rel.startsWith('.git/')).sort().map((rel) => [rel, fs.readFileSync(path.join(repo, rel), 'utf8')]));
        },
    };
}

// The grades file the helper writes is no change a run made.
const withoutGrades = (tree) => new Map([...tree].filter(([rel]) => rel !== GRADES));

test('no state: every item is new and nothing is written', (t) =>
{
    const p = project(t);
    const before = p.tree();

    const result = p.scope('rules');

    assert.deepEqual(lines(result), ['no earlier audit on this machine', 'audit rules/a.md - new', 'audit rules/b.md - new', 'Scope: 2 of 2 items audited, 0 carried']);
    assert.deepEqual(p.tree(), before);
    assert.equal(fs.existsSync(path.join(p.repo, 'docs')), false);
});

test('record then scope carries everything', (t) =>
{
    const p = project(t);

    const recorded = p.record(BOTH_A, 'rules');
    const result = p.scope('rules');

    assert.equal(recorded.stdout, 'Recorded: 2 graded, 0 kept, 0 dropped, 0 skipped - docs/superpowers/audits/state/rules.json\n');
    assert.deepEqual(lines(result), [carried('rules/a.md', 'A / 9'), carried('rules/b.md', 'A / 9.5'), 'Scope: 0 of 2 items audited, 2 carried']);
});

test('record writes only the state file, and leaves no temp file in its folder', (t) =>
{
    const p = project(t);
    const before = p.tree();

    const result = p.record(BOTH_A, 'rules');

    assert.equal(result.status, 0);
    const added = [...p.tree().keys()].filter((rel) => !before.has(rel));
    assert.deepEqual(added, [GRADES, STATE]);
    assert.deepEqual(withoutGrades(new Map([...p.tree()].filter(([rel]) => before.has(rel)))), withoutGrades(before));
    assert.deepEqual(fs.readdirSync(path.join(p.repo, path.dirname(STATE))), ['rules.json']);
    assert.match(fs.readFileSync(path.join(p.repo, STATE), 'utf8'), /\n$/);
});

test('a changed file makes its item audited', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    p.write('rules/a.md', 'A2\n');

    assert.deepEqual(lines(p.scope('rules')), ['audit rules/a.md - changed', carried('rules/b.md', 'A / 9.5'), 'Scope: 1 of 2 items audited, 1 carried']);
});

for (const [name, change] of [
    ['a file added to a folder item', (p) => { p.write('skills/one/references/y.md', 'y\n'); p.add('skills/one/references/y.md'); }],
    ['a file removed from a folder item', (p) => p.remove('skills/one/references/x.md')],
])
{
    test(`${name} makes the folder item changed`, (t) =>
    {
        const p = project(t);
        p.record('skills/one\tA\t9\tyes\nskills/two\tA\t9\tyes\n', 'skills', { kind: 'skills' });
        change(p);

        const printed = lines(p.scope('skills', { kind: 'skills' }));

        assert.deepEqual(printed.slice(0, 2), ['audit skills/one - changed', `carried skills/two - A / 9 from ${TODAY} - docs/superpowers/audits/2026-11-17-skills`]);
    });
}

test('a new tracked item is new and an untracked entry is no item', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    p.write('rules/c.md', 'C\n');
    p.add('rules/c.md');
    p.write('rules/draft.md', 'draft\n');

    const printed = lines(p.scope('rules'));

    assert.ok(printed.includes('audit rules/c.md - new'));
    assert.equal(printed.some((line) => line.includes('rules/draft.md')), false);
});

test('a file deleted and not committed leaves a gone item', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    p.remove('rules/b.md');

    assert.deepEqual(lines(p.scope('rules')), [carried('rules/a.md', 'A / 9'), 'gone rules/b.md', 'Scope: 0 of 1 items audited, 1 carried']);
});

test('an item below the target stays audited', (t) =>
{
    const p = project(t);
    p.record('rules/a.md\tA\t9\tyes\nrules/b.md\tB\t7\tno\n', 'rules');

    assert.ok(lines(p.scope('rules')).includes('audit rules/b.md - below the target (B / 7)'));
});

test('--full audits every item, and a new one is still new', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    p.write('rules/c.md', 'C\n');
    p.add('rules/c.md');

    assert.deepEqual(lines(p.scope('--full', 'rules')), ['audit rules/a.md - full', 'audit rules/b.md - full', 'audit rules/c.md - new', 'Scope: 3 of 3 items audited, 0 carried']);
});

test('a root that is a file is its own item', (t) =>
{
    const p = project(t);

    assert.deepEqual(lines(p.scope('AGENTS.md', { kind: 'agent-md' })), ['no earlier audit on this machine', 'audit AGENTS.md - new', 'Scope: 1 of 1 items audited, 0 carried']);
});

test('an item outside the roots is recorded and then scoped', (t) =>
{
    const p = project(t);

    const recorded = p.record(`${BOTH_A}AGENTS.md\tA\t9\tyes\n`, 'rules');
    const first = lines(p.scope('rules'));
    p.write('AGENTS.md', 'x\n');
    const second = lines(p.scope('rules'));

    assert.match(recorded.stdout, /^Recorded: 3 graded, /);
    assert.deepEqual(first, [carried('AGENTS.md', 'A / 9'), carried('rules/a.md', 'A / 9'), carried('rules/b.md', 'A / 9.5'), 'Scope: 0 of 3 items audited, 3 carried']);
    assert.equal(second[0], 'audit AGENTS.md - changed');
});

test('an item the grades file leaves out is kept while it is unchanged', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    p.setState((state) => { state.items['rules/b.md'].date = '2026-01-01'; });

    const result = p.record(ONLY_A, 'rules');

    assert.match(result.stdout, /^Recorded: 1 graded, 1 kept, 0 dropped, 0 skipped - /);
    assert.equal(p.state().items['rules/b.md'].date, '2026-01-01');
});

test('an item the grades file leaves out is dropped once it changed', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    p.write('rules/b.md', 'B2\n');

    const result = p.record(ONLY_A, 'rules');

    assert.match(result.stdout, /^Recorded: 1 graded, 0 kept, 1 dropped, 0 skipped - /);
    assert.ok(lines(p.scope('rules')).includes('audit rules/b.md - new'));
});

test('a --with file that changed makes every item changed', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, ...SHARED_DEFAULTS);

    assert.deepEqual(lines(p.scope(...SHARED_DEFAULTS)).slice(0, 2), [carried('rules/a.md', 'A / 9'), carried('rules/b.md', 'A / 9.5')]);
    p.write('cfg/defaults.json', '{"a":1}\n');
    assert.deepEqual(lines(p.scope(...SHARED_DEFAULTS)).slice(0, 2), ['audit rules/a.md - changed (cfg/defaults.json)', 'audit rules/b.md - changed (cfg/defaults.json)']);
});

test('a --with list that differs from the recorded one makes every item changed', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, ...SHARED_DEFAULTS);

    const removed = lines(p.scope('rules'));
    const added = lines(p.scope('--with', 'cfg/defaults.json', '--with', 'AGENTS.md', 'rules'));

    assert.deepEqual(removed.slice(0, 2), ['audit rules/a.md - changed (cfg/defaults.json)', 'audit rules/b.md - changed (cfg/defaults.json)']);
    assert.deepEqual(added.slice(0, 2), ['audit rules/a.md - changed (AGENTS.md)', 'audit rules/b.md - changed (AGENTS.md)']);
});

test('a --with folder is its files, and a file added under it changes every item', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, ...SHARED_DEFAULTS);

    assert.deepEqual(lines(p.scope('--with', 'cfg', 'rules')).slice(0, 2), [carried('rules/a.md', 'A / 9'), carried('rules/b.md', 'A / 9.5')]);
    p.write('cfg/extra.json', '{}\n');
    p.add('cfg/extra.json');
    assert.deepEqual(lines(p.scope('--with', 'cfg', 'rules')).slice(0, 2), ['audit rules/a.md - changed (cfg/extra.json)', 'audit rules/b.md - changed (cfg/extra.json)']);
});

test('an item the grades file leaves out is dropped once a --with file changed', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, ...SHARED_DEFAULTS);
    p.write('cfg/defaults.json', '{"a":1}\n');

    const result = p.record(ONLY_A, ...SHARED_DEFAULTS);

    assert.match(result.stdout, /^Recorded: 1 graded, 0 kept, 1 dropped, 0 skipped - /);
});

test('an entry a --with path names, or lies under, is no item', (t) =>
{
    const p = project(t);

    const printed = lines(p.scope('--with', 'hooks/helper.mjs', '--with', 'hooks/data', 'hooks', { kind: 'hooks' }));

    assert.deepEqual(printed, ['no earlier audit on this machine', 'audit hooks/guard.mjs - new', 'Scope: 1 of 1 items audited, 0 carried']);
});

test('a --with path with no tracked file is a usage error', (t) =>
{
    refused(project(t).scope('--with', 'nope.txt', 'rules'), '--with nope.txt holds no tracked file');
});

test('a grades line for a path with no file is skipped and named', (t) =>
{
    const p = project(t);

    const result = p.record(`${BOTH_A}rules/zzz.md\tA\t9\tyes\n`, 'rules');

    assert.equal(result.status, 0);
    assert.equal(result.stdout, `skipped rules/zzz.md - no tracked file\nRecorded: 2 graded, 0 kept, 0 dropped, 1 skipped - ${STATE}\n`);
});

for (const outside of ['/elsewhere/plugins/hooks/h.js', '../other/x.md'])
{
    test(`a grades line for ${outside}, outside the repository, is skipped and named, never refused`, (t) =>
    {
        const p = project(t);

        const result = p.record(`${BOTH_A}${outside}\tA\t9\tyes\n`, 'rules');

        assert.equal(result.status, 0);
        assert.equal(result.stderr, '');
        assert.equal(result.stdout, `skipped ${outside} - no tracked file\nRecorded: 2 graded, 0 kept, 0 dropped, 1 skipped - ${STATE}\n`);
        assert.deepEqual(Object.keys(p.state().items), ['rules/a.md', 'rules/b.md']);
    });
}

test('a Finder file anywhere in the audit skill folder does not change its hash', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    p.write(`${SKILL}/.DS_Store`, 'finder\n');
    p.write(`${SKILL}/references/.DS_Store`, 'finder\n');

    assert.deepEqual(lines(p.scope('rules')), [carried('rules/a.md', 'A / 9'), carried('rules/b.md', 'A / 9.5'), 'Scope: 0 of 2 items audited, 2 carried']);
});

for (const scoringFile of ['rubric.md', 'currency.md'])
{
    test(`a changed ${scoringFile} makes every item changed`, (t) =>
    {
        const p = project(t);
        p.record(BOTH_A, 'rules');
        p.write(`${SKILL}/references/${scoringFile}`, 'new text\n');

        assert.deepEqual(lines(p.scope('rules')).slice(0, 2), ['audit rules/a.md - changed (the rubric)', 'audit rules/b.md - changed (the rubric)']);
    });
}

test('a change elsewhere in the audit skill carries the grades and says so', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    p.setState((state) => { state.items['rules/a.md'].date = EARLIER; state.items['rules/b.md'].date = LATER; });
    p.write(`${SKILL}/SKILL.md`, 'audit 2\n');

    assert.deepEqual(lines(p.scope('rules')), [
        carried('rules/a.md', 'A / 9', EARLIER),
        carried('rules/b.md', 'A / 9.5', LATER),
        'Scope: 0 of 2 items audited, 2 carried',
        `the audit skill changed since ${EARLIER}: 2 carried grades stand under the earlier text`,
    ]);
});

test('the audit skill line still counts the kept items after a later record', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    p.setState((state) => { state.items['rules/a.md'].date = EARLIER; state.items['rules/b.md'].date = LATER; });
    p.write(`${SKILL}/SKILL.md`, 'audit 2\n');
    p.write('rules/c.md', 'C\n');
    p.add('rules/c.md');

    const recorded = p.record('rules/c.md\tA\t9\tyes\n', 'rules');
    const printed = lines(p.scope('rules'));

    assert.match(recorded.stdout, /^Recorded: 1 graded, 2 kept, 0 dropped, 0 skipped - /);
    assert.equal(printed.at(-1), `the audit skill changed since ${EARLIER}: 2 carried grades stand under the earlier text`);
});

test('--under stores the hashes given instead of the current ones', (t) =>
{
    const p = project(t);
    const [scoring, folder] = p.scope('rules').stdout.trimEnd().split('\n').at(-1).slice('Graded under: '.length).split(' ');
    p.write(`${SKILL}/references/rubric.md`, 'new text\n');

    p.record(BOTH_A, '--under', scoring, folder, 'rules');

    assert.equal(p.state().items['rules/a.md'].scoring, scoring);
    assert.deepEqual(lines(p.scope('rules')).slice(0, 2), ['audit rules/a.md - changed (the rubric)', 'audit rules/b.md - changed (the rubric)']);
});

test('without --under the same record carries both items', (t) =>
{
    const p = project(t);
    p.write(`${SKILL}/references/rubric.md`, 'new text\n');

    p.record(BOTH_A, 'rules');

    assert.deepEqual(lines(p.scope('rules')).slice(0, 2), [carried('rules/a.md', 'A / 9'), carried('rules/b.md', 'A / 9.5')]);
});

test('a malformed grades line is a usage error and writes nothing', (t) =>
{
    const bad = ['rules/a.md\tA\t9\n', 'rules/a.md\tZ\t9\tyes\n', 'rules/a.md\tA\tx\tyes\n', 'rules/a.md\tA\t9\tmaybe\n', '\tA\t9\tyes\n', 'rules/a.md\tA\t9\tyes\nrules/a.md\tB\t8\tno\n'];
    const fresh = project(t);
    for (const grades of bad)
    {
        const result = fresh.record(grades, 'rules');
        refused(result);
        assert.match(result.stderr, /line \d/);
    }
    assert.equal(fs.existsSync(path.join(fresh.repo, STATE)), false);

    const p = project(t);
    p.record(BOTH_A, 'rules');
    const before = fs.readFileSync(path.join(p.repo, STATE), 'utf8');
    for (const grades of bad) refused(p.record(grades, 'rules'));
    assert.equal(fs.readFileSync(path.join(p.repo, STATE), 'utf8'), before);
});

const NO_HASH = 'a'.repeat(40);
const USAGE_CASES = {
    'no command': (p) => p.run([]),
    'a command that is neither scope nor record': (p) => p.run(['frob']),
    'no kind': (p) => p.run(['scope']),
    'a kind that does not match': (p) => p.scope('rules', { kind: '../x' }),
    'no root': (p) => p.scope(),
    'a root that is not in the working tree': (p) => p.scope('nope'),
    'a root outside the repository': (p) => p.scope('../outside'),
    'an absolute root': (p) => p.scope(p.repo),
    'an unknown option': (p) => p.scope('--frob', 'rules'),
    'an option with no value': (p) => p.scope('rules', '--with'),
    'record with no --run': (p) => p.run(['record', 'rules', '--grades', GRADES, 'rules']),
    'record with no --grades': (p) => p.run(['record', 'rules', '--run', RUN, 'rules']),
    'a --grades file that does not exist': (p) => p.run(['record', 'rules', '--run', RUN, '--grades', 'docs/none.tsv', 'rules']),
    '--under with one value': (p) => p.record('', 'rules', '--under', NO_HASH),
    '--under with two values that are no hashes': (p) => p.record('', '--under', 'xyz', 'xyz', 'rules'),
};

for (const [name, attempt] of Object.entries(USAGE_CASES))
{
    test(`usage error: ${name}`, (t) =>
    {
        const p = project(t);
        const before = withoutGrades(p.tree());

        refused(attempt(p));

        assert.deepEqual(withoutGrades(p.tree()), before);
    });
}

test('usage error: a state file that is not JSON, for scope and for record', (t) =>
{
    const p = project(t);
    p.write(STATE, 'not json');
    const before = p.tree();

    const scoped = p.scope('rules');
    const recorded = p.record(BOTH_A, 'rules');

    refused(scoped);
    refused(recorded);
    assert.match(scoped.stderr, /cannot read the state file docs\/superpowers\/audits\/state\/rules\.json: /);
    assert.deepEqual(withoutGrades(p.tree()), withoutGrades(before));
});

test('usage error: outside a git repository', (t) =>
{
    refused(runNode(AUDIT_SCOPE, ['scope', 'rules', 'rules'], { cwd: makeTempDir(t, 'plain') }), 'not inside a git repository');
});

test('a path with a space and a non-ASCII letter is one item', (t) =>
{
    const p = project(t);
    p.write('rules/my rule é.md', 'odd\n');
    p.add('rules/my rule é.md');
    p.commit();

    p.record(`${BOTH_A}rules/my rule é.md\tA\t9\tyes\n`, 'rules');

    assert.ok(lines(p.scope('rules')).includes(carried('rules/my rule é.md', 'A / 9')));
});

test('a trailing slash and a working directory below the root change nothing', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    const expected = p.scope('rules').stdout;

    assert.equal(p.scope('rules/').stdout, expected);
    assert.equal(p.scope('rules', { cwd: path.join(p.repo, 'rules') }).stdout, expected);
});

const AGE_LINE = (count, limit) => `age: ${count} items graded more than ${limit} days ago are audited again`;

test('a grade older than the limit is audited again', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    const old = daysAgo(31);
    p.setState((state) => { state.items['rules/a.md'].date = old; });

    assert.deepEqual(lines(p.scope('rules')), [
        `audit rules/a.md - older than 30 days (A / 9 from ${old})`,
        carried('rules/b.md', 'A / 9.5'),
        'Scope: 1 of 2 items audited, 1 carried',
        AGE_LINE(1, 30),
    ]);
});

test('a grade exactly at the limit is carried', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    const edge = daysAgo(30);
    p.setState((state) => { state.items['rules/a.md'].date = edge; });

    assert.deepEqual(lines(p.scope('rules')), [carried('rules/a.md', 'A / 9', edge), carried('rules/b.md', 'A / 9.5'), 'Scope: 0 of 2 items audited, 2 carried']);
});

test('a grade dated in the future is carried', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    const later = daysAgo(-5);
    p.setState((state) => { state.items['rules/a.md'].date = later; });

    assert.deepEqual(lines(p.scope('rules')), [carried('rules/a.md', 'A / 9', later), carried('rules/b.md', 'A / 9.5'), 'Scope: 0 of 2 items audited, 2 carried']);
});

test('--max-age changes the limit', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    const old = daysAgo(8);
    p.setState((state) => { state.items['rules/a.md'].date = old; });

    const printed = lines(p.scope('--max-age', '7', 'rules'));

    assert.ok(printed.includes(`audit rules/a.md - older than 7 days (A / 9 from ${old})`));
    assert.ok(printed.includes(AGE_LINE(1, 7)));
});

test('below the target outranks age', (t) =>
{
    const p = project(t);
    p.record('rules/a.md\tA\t9\tyes\nrules/b.md\tB\t7\tno\n', 'rules');
    p.setState((state) => { state.items['rules/b.md'].date = daysAgo(40); });

    const printed = lines(p.scope('rules'));

    assert.ok(printed.includes('audit rules/b.md - below the target (B / 7)'));
    assert.equal(printed.some((line) => line.startsWith('age:')), false);
});

test('the age line sits between the Scope line and the audit skill line', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    const old = daysAgo(40);
    p.setState((state) => { state.items['rules/a.md'].date = old; });
    p.write(`${SKILL}/SKILL.md`, 'audit 2\n');

    const printed = lines(p.scope('rules'));

    assert.deepEqual(printed.slice(-3), [
        'Scope: 1 of 2 items audited, 1 carried',
        AGE_LINE(1, 30),
        `the audit skill changed since ${TODAY}: 1 carried grades stand under the earlier text`,
    ]);
});

test('--full reads full, not older', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    p.setState((state) =>
    {
        state.items['rules/a.md'].date = daysAgo(40);
        state.items['rules/b.md'].date = daysAgo(40);
    });

    assert.deepEqual(lines(p.scope('--full', 'rules')), ['audit rules/a.md - full', 'audit rules/b.md - full', 'Scope: 2 of 2 items audited, 0 carried']);
});

test('a bad --max-age is a usage error and writes nothing', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    const before = p.tree();

    for (const value of ['0', '-1', 'x', '1.5'])
        refused(p.scope('--max-age', value, 'rules'));
    refused(p.scope('rules', '--max-age'));
    refused(p.run(['record', 'rules', '--run', RUN, '--grades', GRADES, '--max-age', '7', 'rules']));

    assert.deepEqual(p.tree(), before);
});

test('a stored date that is no date is an unreadable state file', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    p.setState((state) => { state.items['rules/a.md'].date = 'yesterday'; });

    const result = p.scope('rules');

    refused(result);
    assert.match(result.stderr, /^audit-scope: cannot read the state file/);
});

test('a state folder that cannot be written is one audit-scope line and leaves no temp file', { skip: cannotLockFolders() }, (t) =>
{
    const p = project(t);
    const stateFolder = path.join(p.repo, path.dirname(STATE));
    fs.mkdirSync(stateFolder, { recursive: true });
    fs.chmodSync(stateFolder, 0o555);

    const result = p.record(BOTH_A, 'rules');

    refused(result);
    assert.deepEqual(fs.readdirSync(stateFolder), []);
});

for (const outside of ['..\\outside', 'a\\..\\b', 'C:\\x', '\\\\server\\x'])
{
    test(`a root of ${outside} is outside the repository`, (t) =>
    {
        refused(project(t).scope(outside), `root ${outside} is outside the repository`);
    });
}

const SAME_REPOSITORY = 'names the repository itself';
const REPOSITORY_ROOT_CASES = {
    'a root of .': [(p) => p.scope('.'), `root . ${SAME_REPOSITORY}`],
    'a --with of .': [(p) => p.scope('--with', '.', 'rules'), `--with path . ${SAME_REPOSITORY}`],
    'a --run of .': [(p) => p.run(['record', 'rules', '--run', '.', '--grades', GRADES, 'rules']), `--run folder . ${SAME_REPOSITORY}`],
    'a --with of ../x': [(p) => p.scope('--with', '../x', 'rules'), '--with path ../x is outside the repository'],
    'a --run of ../x': [(p) => p.run(['record', 'rules', '--run', '../x', '--grades', GRADES, 'rules']), '--run folder ../x is outside the repository'],
    'an option whose value is the next option': [(p) => p.run(['record', 'rules', '--run', '--grades', GRADES, 'rules']), '--run needs a value'],
};

for (const [name, [attempt, message]] of Object.entries(REPOSITORY_ROOT_CASES))
{
    test(`usage error: ${name}`, (t) =>
    {
        const p = project(t);
        p.write(GRADES, BOTH_A);

        refused(attempt(p), message);
    });
}

test('usage error: a state file of another kind', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    p.setState((state) => { state.kind = 'hooks'; });

    refused(p.scope('rules'), `cannot read the state file ${STATE}: not the state of an audit of kind rules`);
});

test('a grades line for a stored item that has no file now is skipped and its entry is gone', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    p.remove('rules/b.md');

    const result = p.record(`${ONLY_A}rules/b.md\tA\t9.5\tyes\n`, 'rules');

    assert.equal(result.stdout, `skipped rules/b.md - no tracked file\nRecorded: 1 graded, 0 kept, 0 dropped, 1 skipped - ${STATE}\n`);
    assert.deepEqual(Object.keys(p.state().items), ['rules/a.md']);
});

test('record run from a folder below the root writes the same state as from the root', (t) =>
{
    const p = project(t);
    p.record(BOTH_A, 'rules');
    const fromRoot = fs.readFileSync(path.join(p.repo, STATE), 'utf8');
    fs.rmSync(path.join(p.repo, STATE));

    const result = p.run(['record', 'rules', '--run', RUN, '--grades', 'grades.tsv', 'rules'], { cwd: path.join(p.repo, 'docs') });

    assert.equal(result.status, 0);
    assert.equal(fs.readFileSync(path.join(p.repo, STATE), 'utf8'), fromRoot);
});
