// bin/audit-scope.mjs record and its usage errors, run as the command it is, in a throwaway git repository of rules, skills and hooks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
    EARLIER,
    GRADES_A_AND_B,
    GRADES_A_ONLY,
    GRADES_FILE,
    LATER,
    SCOPE_RUN,
    SCOPE_SCRIPT,
    SCOPE_SKILL,
    SCOPE_STATE,
    WITH_DEFAULTS,
    cannotLockFolders,
    carriedLine,
    expectRefused,
    makeScopeProject,
    makeTempDir,
    printedLines,
    runNode,
    withoutGradesFile,
} from './support.mjs';

test('record writes only the state file, and leaves no temp file in its folder', (t) =>
{
    const p = makeScopeProject(t);
    const before = p.tree();

    const result = p.record(GRADES_A_AND_B, 'rules');

    assert.equal(result.status, 0);
    const added = [...p.tree().keys()].filter((rel) => !before.has(rel));
    assert.deepEqual(added, [GRADES_FILE, SCOPE_STATE]);
    assert.deepEqual(withoutGradesFile(new Map([...p.tree()].filter(([rel]) => before.has(rel)))), withoutGradesFile(before));
    assert.deepEqual(fs.readdirSync(path.join(p.repo, path.dirname(SCOPE_STATE))), ['rules.json']);
    assert.match(fs.readFileSync(path.join(p.repo, SCOPE_STATE), 'utf8'), /\n$/);
});

test('an item the grades file leaves out is kept while it is unchanged', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    p.setState((state) => { state.items['rules/b.md'].date = '2026-01-01'; });

    const result = p.record(GRADES_A_ONLY, 'rules');

    assert.match(result.stdout, /^Recorded: 1 graded, 1 kept, 0 dropped, 0 skipped - /);
    assert.equal(p.state().items['rules/b.md'].date, '2026-01-01');
});

test('an item the grades file leaves out is dropped once it changed', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    p.write('rules/b.md', 'B2\n');

    const result = p.record(GRADES_A_ONLY, 'rules');

    assert.match(result.stdout, /^Recorded: 1 graded, 0 kept, 1 dropped, 0 skipped - /);
    assert.ok(printedLines(p.scope('rules')).includes('audit rules/b.md - new'));
});

test('an item the grades file leaves out is dropped once a --with file changed', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, ...WITH_DEFAULTS);
    p.write('cfg/defaults.json', '{"a":1}\n');

    const result = p.record(GRADES_A_ONLY, ...WITH_DEFAULTS);

    assert.match(result.stdout, /^Recorded: 1 graded, 0 kept, 1 dropped, 0 skipped - /);
});

test('a --with path with no tracked file is a usage error', (t) =>
{
    expectRefused(makeScopeProject(t).scope('--with', 'nope.txt', 'rules'), '--with nope.txt holds no tracked file');
});

test('a grades line for a path with no file is skipped and named', (t) =>
{
    const p = makeScopeProject(t);

    const result = p.record(`${GRADES_A_AND_B}rules/zzz.md\tA\t9\tyes\n`, 'rules');

    assert.equal(result.status, 0);
    assert.equal(result.stdout, `skipped rules/zzz.md - no tracked file\nRecorded: 2 graded, 0 kept, 0 dropped, 1 skipped - ${SCOPE_STATE}\n`);
});

for (const outside of ['/elsewhere/plugins/hooks/h.js', '../other/x.md'])
{
    test(`a grades line for ${outside}, outside the repository, is skipped and named, never refused`, (t) =>
    {
        const p = makeScopeProject(t);

        const result = p.record(`${GRADES_A_AND_B}${outside}\tA\t9\tyes\n`, 'rules');

        assert.equal(result.status, 0);
        assert.equal(result.stderr, '');
        assert.equal(result.stdout, `skipped ${outside} - no tracked file\nRecorded: 2 graded, 0 kept, 0 dropped, 1 skipped - ${SCOPE_STATE}\n`);
        assert.deepEqual(Object.keys(p.state().items), ['rules/a.md', 'rules/b.md']);
    });
}

test('the audit skill line still counts the kept items after a later record', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    p.setState((state) => { state.items['rules/a.md'].date = EARLIER; state.items['rules/b.md'].date = LATER; });
    p.write(`${SCOPE_SKILL}/SCOPE_SKILL.md`, 'audit 2\n');
    p.write('rules/c.md', 'C\n');
    p.add('rules/c.md');

    const recorded = p.record('rules/c.md\tA\t9\tyes\n', 'rules');
    const printed = printedLines(p.scope('rules'));

    assert.match(recorded.stdout, /^Recorded: 1 graded, 2 kept, 0 dropped, 0 skipped - /);
    assert.equal(printed.at(-1), `the audit skill changed since ${EARLIER}: 2 carried grades stand under the earlier text`);
});

test('--under stores the hashes given instead of the current ones', (t) =>
{
    const p = makeScopeProject(t);
    const [scoring, folder] = p.scope('rules').stdout.trimEnd().split('\n').at(-1).slice('Graded under: '.length).split(' ');
    p.write(`${SCOPE_SKILL}/references/rubric.md`, 'new text\n');

    p.record(GRADES_A_AND_B, '--under', scoring, folder, 'rules');

    assert.equal(p.state().items['rules/a.md'].scoring, scoring);
    assert.deepEqual(printedLines(p.scope('rules')).slice(0, 2), ['audit rules/a.md - changed (the rubric)', 'audit rules/b.md - changed (the rubric)']);
});

test('without --under the same record carries both items', (t) =>
{
    const p = makeScopeProject(t);
    p.write(`${SCOPE_SKILL}/references/rubric.md`, 'new text\n');

    p.record(GRADES_A_AND_B, 'rules');

    assert.deepEqual(printedLines(p.scope('rules')).slice(0, 2), [carriedLine('rules/a.md', 'A / 9'), carriedLine('rules/b.md', 'A / 9.5')]);
});

test('a malformed grades line is a usage error and writes nothing', (t) =>
{
    const bad = ['rules/a.md\tA\t9\n', 'rules/a.md\tZ\t9\tyes\n', 'rules/a.md\tA\tx\tyes\n', 'rules/a.md\tA\t9\tmaybe\n', '\tA\t9\tyes\n', 'rules/a.md\tA\t9\tyes\nrules/a.md\tB\t8\tno\n'];
    const fresh = makeScopeProject(t);
    for (const grades of bad)
    {
        const result = fresh.record(grades, 'rules');
        expectRefused(result);
        assert.match(result.stderr, /line \d/);
    }
    assert.equal(fs.existsSync(path.join(fresh.repo, SCOPE_STATE)), false);

    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    const before = fs.readFileSync(path.join(p.repo, SCOPE_STATE), 'utf8');
    for (const grades of bad) expectRefused(p.record(grades, 'rules'));
    assert.equal(fs.readFileSync(path.join(p.repo, SCOPE_STATE), 'utf8'), before);
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
    'record with no --run': (p) => p.run(['record', 'rules', '--grades', GRADES_FILE, 'rules']),
    'record with no --grades': (p) => p.run(['record', 'rules', '--run', SCOPE_RUN, 'rules']),
    'a --grades file that does not exist': (p) => p.run(['record', 'rules', '--run', SCOPE_RUN, '--grades', 'docs/none.tsv', 'rules']),
    '--under with one value': (p) => p.record('', 'rules', '--under', NO_HASH),
    '--under with two values that are no hashes': (p) => p.record('', '--under', 'xyz', 'xyz', 'rules'),
};

for (const [name, attempt] of Object.entries(USAGE_CASES))
{
    test(`usage error: ${name}`, (t) =>
    {
        const p = makeScopeProject(t);
        const before = withoutGradesFile(p.tree());

        expectRefused(attempt(p));

        assert.deepEqual(withoutGradesFile(p.tree()), before);
    });
}

test('usage error: a state file that is not JSON, for scope and for record', (t) =>
{
    const p = makeScopeProject(t);
    p.write(SCOPE_STATE, 'not json');
    const before = p.tree();

    const scoped = p.scope('rules');
    const recorded = p.record(GRADES_A_AND_B, 'rules');

    expectRefused(scoped);
    expectRefused(recorded);
    assert.match(scoped.stderr, /cannot read the state file docs\/superpowers\/audits\/state\/rules\.json: /);
    assert.deepEqual(withoutGradesFile(p.tree()), withoutGradesFile(before));
});

test('usage error: outside a git repository', (t) =>
{
    expectRefused(runNode(SCOPE_SCRIPT, ['scope', 'rules', 'rules'], { cwd: makeTempDir(t, 'plain') }), 'not inside a git repository');
});

test('a bad --max-age is a usage error and writes nothing', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    const before = p.tree();

    for (const value of ['0', '-1', 'x', '1.5'])
        expectRefused(p.scope('--max-age', value, 'rules'));
    expectRefused(p.scope('rules', '--max-age'));
    expectRefused(p.run(['record', 'rules', '--run', SCOPE_RUN, '--grades', GRADES_FILE, '--max-age', '7', 'rules']));

    assert.deepEqual(p.tree(), before);
});

test('a stored date that is no date is an unreadable state file', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    p.setState((state) => { state.items['rules/a.md'].date = 'yesterday'; });

    const result = p.scope('rules');

    expectRefused(result);
    assert.match(result.stderr, /^audit-scope: cannot read the state file/);
});

test('a state folder that cannot be written is one audit-scope line and leaves no temp file', { skip: cannotLockFolders() }, (t) =>
{
    const p = makeScopeProject(t);
    const stateFolder = path.join(p.repo, path.dirname(SCOPE_STATE));
    fs.mkdirSync(stateFolder, { recursive: true });
    fs.chmodSync(stateFolder, 0o555);

    const result = p.record(GRADES_A_AND_B, 'rules');

    expectRefused(result);
    assert.deepEqual(fs.readdirSync(stateFolder), []);
});

for (const outside of ['..\\outside', 'a\\..\\b', 'C:\\x', '\\\\server\\x'])
{
    test(`a root of ${outside} is outside the repository`, (t) =>
    {
        expectRefused(makeScopeProject(t).scope(outside), `root ${outside} is outside the repository`);
    });
}

const SAME_REPOSITORY = 'names the repository itself';
const REPOSITORY_ROOT_CASES = {
    'a root of .': [(p) => p.scope('.'), `root . ${SAME_REPOSITORY}`],
    'a --with of .': [(p) => p.scope('--with', '.', 'rules'), `--with path . ${SAME_REPOSITORY}`],
    'a --run of .': [(p) => p.run(['record', 'rules', '--run', '.', '--grades', GRADES_FILE, 'rules']), `--run folder . ${SAME_REPOSITORY}`],
    'a --with of ../x': [(p) => p.scope('--with', '../x', 'rules'), '--with path ../x is outside the repository'],
    'a --run of ../x': [(p) => p.run(['record', 'rules', '--run', '../x', '--grades', GRADES_FILE, 'rules']), '--run folder ../x is outside the repository'],
    'an option whose value is the next option': [(p) => p.run(['record', 'rules', '--run', '--grades', GRADES_FILE, 'rules']), '--run needs a value'],
};

for (const [name, [attempt, message]] of Object.entries(REPOSITORY_ROOT_CASES))
{
    test(`usage error: ${name}`, (t) =>
    {
        const p = makeScopeProject(t);
        p.write(GRADES_FILE, GRADES_A_AND_B);

        expectRefused(attempt(p), message);
    });
}

test('usage error: a state file of another kind', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    p.setState((state) => { state.kind = 'hooks'; });

    expectRefused(p.scope('rules'), `cannot read the state file ${SCOPE_STATE}: not the state of an audit of kind rules`);
});

test('a grades line for a stored item that has no file now is skipped and its entry is gone', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    p.remove('rules/b.md');

    const result = p.record(`${GRADES_A_ONLY}rules/b.md\tA\t9.5\tyes\n`, 'rules');

    assert.equal(result.stdout, `skipped rules/b.md - no tracked file\nRecorded: 1 graded, 0 kept, 0 dropped, 1 skipped - ${SCOPE_STATE}\n`);
    assert.deepEqual(Object.keys(p.state().items), ['rules/a.md']);
});

test('record run from a folder below the root writes the same state as from the root', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    const fromRoot = fs.readFileSync(path.join(p.repo, SCOPE_STATE), 'utf8');
    fs.rmSync(path.join(p.repo, SCOPE_STATE));

    const result = p.run(['record', 'rules', '--run', SCOPE_RUN, '--grades', 'grades.tsv', 'rules'], { cwd: path.join(p.repo, 'docs') });

    assert.equal(result.status, 0);
    assert.equal(fs.readFileSync(path.join(p.repo, SCOPE_STATE), 'utf8'), fromRoot);
});
