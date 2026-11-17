// bin/prove-plan.mjs, run as the command it is, in a throwaway git repository holding a plan in a folder of its own.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REAL_KIT, makeRepo, makeTempDir, runNode, writeFiles } from './support.mjs';

const PROVE = path.join(REAL_KIT, 'bin', 'prove-plan.mjs');
const RUN_FOLDER = 'docs/run';
const PLAN = `${RUN_FOLDER}/plan.md`;
const EXPECTED = `${RUN_FOLDER}/expected`;
const ALPHA = 'alpha\nbeta\ngamma\n';

function git(repo, ...args)
{
    const result = spawnSync('git', ['-c', 'user.name=tester', '-c', 'user.email=tester@example.com', '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function commitAll(repo, message)
{
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', message);
    return git(repo, 'rev-parse', '--short', 'HEAD');
}

// An outer fence one backtick longer than any run inside the text, as the plan format asks.
function fenced(text)
{
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}text\n${text}\n${fence}`;
}

function renderEdit({ n, path: file, kind = 'replace', needs, old, new: replacement })
{
    const lines = [`### E${n} - ${file}`, '', '- Item: demo', `- Kind: ${kind}`];
    if (needs) lines.push(`- Needs: ${needs}`);
    lines.push('');
    if (old !== undefined) lines.push('Old:', '', fenced(old), '');
    if (replacement !== undefined) lines.push('New:', '', fenced(replacement), '');
    return lines.join('\n');
}

function renderPlan({ baseline, edits })
{
    return [
        '# Audit plan - demo - 2026-11-17', '', `Baseline: ${baseline} - 2026-11-17 10:00`, '',
        '## Summary', '', '| Item | Baseline | Edits | Expected |', '|---|---|---|---|', '| demo | 80 | E1 | 90 |', '',
        '## Edits', '', ...edits.map(renderEdit), '## Open questions', '', '- none', '',
    ].join('\n');
}

// A repository with one commit holding `files`; `plan(edits)` writes plan.md at its Baseline, `run(...)` runs the prover in it.
function project(t, files)
{
    const repo = makeRepo(t, files);
    const baseline = commitAll(repo, 'baseline');
    const plan = (edits, { name = 'plan.md', rev = baseline } = {}) =>
    {
        const file = `${RUN_FOLDER}/${name}`;
        writeFiles(repo, { [file]: renderPlan({ baseline: rev, edits }) });
        return file;
    };
    const run = (...args) => runNode(PROVE, args, { cwd: repo });
    const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
    const exists = (rel) => fs.existsSync(path.join(repo, rel));
    const list = (rel) => fs.readdirSync(path.join(repo, rel), { recursive: true }).map((name) => name.split(path.sep).join('/')).sort();
    return { repo, baseline, plan, run, read, exists, list };
}

const replaceEdit = (n, file, old, replacement, more = {}) => ({ n, path: file, kind: 'replace', old, new: replacement, ...more });

test('a replace plan passes: exit 0, the Applies line, the exact expected bytes and the size lines', (t) =>
{
    const p = project(t, { 'a.txt': 'one\ntwo\nthree\n', 'dir/b.txt': 'x = 1\n' });
    const plan = p.plan([replaceEdit(1, 'a.txt', 'two', 'TWO!'), replaceEdit(2, 'dir/b.txt', 'x = 1', 'x = 22')]);

    const result = p.run(plan);

    assert.equal(result.stderr, '');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'Applies: 2 of 2 edits\n  a.txt (14 -> 15 characters)\n  dir/b.txt (6 -> 7 characters)\n');
    assert.equal(p.read(`${EXPECTED}/a.txt`), 'one\nTWO!\nthree\n');
    assert.equal(p.read(`${EXPECTED}/dir/b.txt`), 'x = 22\n');
    assert.equal(p.read('a.txt'), 'one\ntwo\nthree\n');
});

test('the files are read at the Baseline revision, neither at HEAD nor in a dirty working tree', (t) =>
{
    const p = project(t, { 'a.txt': ALPHA });
    const plan = p.plan([replaceEdit(1, 'a.txt', 'beta', 'BETA')]);
    fs.writeFileSync(path.join(p.repo, 'a.txt'), 'alpha\ndeux\ngamma\n');
    commitAll(p.repo, 'later');
    fs.writeFileSync(path.join(p.repo, 'a.txt'), 'rewritten in the working tree\n');

    const result = p.run(plan);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(p.read(`${EXPECTED}/a.txt`), 'alpha\nBETA\ngamma\n');
});

const FAILURES = [
    ['Old is missing', { 'a.txt': ALPHA }, [replaceEdit(1, 'a.txt', 'delta', 'DELTA')], 'E1 - a.txt: Old not found'],
    ['Old is found twice', { 'a.txt': 'x\nx\n' }, [replaceEdit(1, 'a.txt', 'x', 'y')], 'E1 - a.txt: Old found 2 times'],
    [
        'Old is before the end of the previous edit to the file',
        { 'a.txt': ALPHA },
        [replaceEdit(1, 'a.txt', 'beta', 'BETA'), replaceEdit(2, 'a.txt', 'alpha', 'ALPHA')],
        'E2 - a.txt: Old is before the end of E1 - out of file order or overlapping',
    ],
    ['New is the same as Old', { 'a.txt': ALPHA }, [replaceEdit(1, 'a.txt', 'beta', 'beta')], 'E1 - a.txt: New is the same as Old'],
    [
        'new-file names a path the Baseline has',
        { 'a.txt': ALPHA },
        [{ n: 1, path: 'a.txt', kind: 'new-file', new: 'again' }],
        (base) => `E1 - a.txt: already in the Baseline revision ${base}`,
    ],
    [
        'delete-file names a path the Baseline lacks',
        { 'a.txt': ALPHA },
        [{ n: 1, path: 'missing.txt', kind: 'delete-file' }],
        (base) => `E1 - missing.txt: not in the Baseline revision ${base}`,
    ],
    [
        'replace names a path the Baseline lacks',
        { 'a.txt': ALPHA },
        [replaceEdit(1, 'nope.txt', 'x', 'y')],
        (base) => `E1 - nope.txt: not in the Baseline revision ${base}`,
    ],
];

for (const [name, files, edits, line] of FAILURES)
{
    test(`${name}: exit 1 with the reason, and an expected folder already on disk is left alone`, (t) =>
    {
        const p = project(t, files);
        const plan = p.plan(edits);
        writeFiles(p.repo, { [`${EXPECTED}/keep.txt`]: 'stale but kept\n' });

        const result = p.run(plan);

        assert.equal(result.status, 1);
        assert.equal(result.stderr, `${typeof line === 'function' ? line(p.baseline) : line}\n`);
        assert.match(result.stdout, /^Applies: \d of \d edits\n$/);
        assert.deepEqual(p.list(EXPECTED), ['keep.txt']);
        assert.equal(p.read(`${EXPECTED}/keep.txt`), 'stale but kept\n');
    });
}

test('one failed edit does not hide another: two lines on stderr and Applies 1 of 3', (t) =>
{
    const p = project(t, { 'a.txt': ALPHA, 'b.txt': 'x\nx\n' });
    const plan = p.plan([replaceEdit(1, 'a.txt', 'alpha', 'ALPHA'), replaceEdit(2, 'a.txt', 'delta', 'DELTA'), replaceEdit(3, 'b.txt', 'x', 'y')]);

    const result = p.run(plan);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, 'Applies: 1 of 3 edits\n');
    assert.equal(result.stderr, 'E2 - a.txt: Old not found\nE3 - b.txt: Old found 2 times\n');
    assert.equal(p.exists(EXPECTED), false);
});

// E1, E2 and E3 each replace one file; `needs` is each edit's Needs line, `broken` makes E3's Old missing from its file.
const NEEDS_CASES = [
    ['a Needs naming a later edit is no failure', ['E2'], false, 0, 'Applies: 3 of 3 edits\n', ''],
    ['edits that need each other all apply', ['E2', 'E1'], false, 0, 'Applies: 3 of 3 edits\n', ''],
    ['an edit naming itself is ignored', [undefined, undefined, 'E3'], false, 0, 'Applies: 3 of 3 edits\n', ''],
    [
        'a chain whose last link fails fails every link',
        ['E2', 'E3'],
        true,
        1,
        'Applies: 0 of 3 edits\n',
        'E1 - a.txt: needs E2, which did not apply\nE2 - b.txt: needs E3, which did not apply\nE3 - c.txt: Old not found\n',
    ],
    ['a Needs naming an edit the plan lacks fails', ['E9'], false, 1, 'Applies: 2 of 3 edits\n', 'E1 - a.txt: needs E9, which the plan does not hold\n'],
];

for (const [name, needs, broken, status, applies, stderr] of NEEDS_CASES)
{
    test(name, (t) =>
    {
        const p = project(t, { 'a.txt': 'one\n', 'b.txt': 'two\n', 'c.txt': 'three\n' });
        const plan = p.plan([
            replaceEdit(1, 'a.txt', 'one', 'ONE', { needs: needs[0] }),
            replaceEdit(2, 'b.txt', 'two', 'TWO', { needs: needs[1] }),
            replaceEdit(3, 'c.txt', broken ? 'missing' : 'three', 'THREE', { needs: needs[2] }),
        ]);

        const result = p.run(plan);

        assert.equal(result.status, status);
        assert.equal(result.stdout, status === 0 ? `${applies}  a.txt (4 -> 4 characters)\n  b.txt (4 -> 4 characters)\n  c.txt (6 -> 6 characters)\n` : applies);
        assert.equal(result.stderr, stderr);
    });
}

for (const [name, edit, expected] of [
    ['insert-after keeps the anchor and adds New after a newline', { kind: 'insert-after', old: 'alpha', new: 'inserted' }, 'alpha\ninserted\nbeta\ngamma\n'],
    ['delete removes Old and nothing else', { kind: 'delete', old: 'beta' }, 'alpha\n\ngamma\n'],
])
{
    test(name, (t) =>
    {
        const p = project(t, { 'a.txt': ALPHA });
        const plan = p.plan([{ n: 1, path: 'a.txt', ...edit }]);

        const result = p.run(plan);

        assert.equal(result.status, 0, result.stderr);
        assert.equal(p.read(`${EXPECTED}/a.txt`), expected);
    });
}

test('new-file writes New plus a final newline and prints (new, <n> characters)', (t) =>
{
    const p = project(t, { 'a.txt': ALPHA });
    const plan = p.plan([{ n: 1, path: 'docs/fresh.md', kind: 'new-file', new: 'hello\nworld' }]);

    const result = p.run(plan);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(p.read(`${EXPECTED}/docs/fresh.md`), 'hello\nworld\n');
    assert.equal(result.stdout, 'Applies: 1 of 1 edits\n  docs/fresh.md (new, 12 characters)\n');
});

test('delete-file and move-file count as applied and write no file', (t) =>
{
    const p = project(t, { 'a.txt': ALPHA, 'b.txt': 'b\n', 'c.txt': 'one\n' });
    const plan = p.plan([
        { n: 1, path: 'a.txt', kind: 'delete-file' },
        { n: 2, path: 'b.txt', kind: 'move-file' },
        replaceEdit(3, 'c.txt', 'one', 'ONE'),
    ]);

    const result = p.run(plan);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Applies: 3 of 3 edits$/m);
    assert.match(result.stdout, /^E1 - a\.txt: delete-file - path checked, nothing to replay$/m);
    assert.match(result.stdout, /^E2 - b\.txt: move-file - path checked, nothing to replay$/m);
    assert.deepEqual(p.list(EXPECTED), ['c.txt']);
});

test('an edit to a path a delete-file named fails with deleted by E<m>', (t) =>
{
    const p = project(t, { 'a.txt': ALPHA });
    const plan = p.plan([{ n: 1, path: 'a.txt', kind: 'delete-file' }, replaceEdit(2, 'a.txt', 'beta', 'BETA')]);

    const result = p.run(plan);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'E2 - a.txt: deleted by E1\n');
});

test('a kind the prover does not handle fails and a missing Kind line fails', (t) =>
{
    const p = project(t, { 'a.txt': ALPHA });
    const plan = p.plan([{ n: 1, path: 'a.txt', kind: 'rename', old: 'alpha', new: 'ALPHA' }, replaceEdit(2, 'a.txt', 'beta', 'BETA')]);
    fs.writeFileSync(path.join(p.repo, plan), fs.readFileSync(path.join(p.repo, plan), 'utf8').replace('- Kind: replace\n', ''));

    const result = p.run(plan);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, "E1 - a.txt: kind 'rename' is not handled\nE2 - a.txt: no Kind line\n");
});

test("a missing fence after 'Old:' or 'New:' fails that edit", (t) =>
{
    const p = project(t, { 'a.txt': ALPHA });
    const plan = p.plan([replaceEdit(1, 'a.txt', 'alpha', 'ALPHA'), replaceEdit(2, 'a.txt', 'beta', 'BETA')]);
    const text = fs.readFileSync(path.join(p.repo, plan), 'utf8');
    const broken = text.replace(/Old:\n\n```text\nalpha\n```\n/, 'Old:\n').replace(/(New:\n\n```text\nBETA\n)```\n/, '$1');
    fs.writeFileSync(path.join(p.repo, plan), broken);

    const result = p.run(plan);

    assert.equal(result.status, 1);
    assert.equal(result.stderr, "E1 - a.txt: no closed fence after 'Old:'\nE2 - a.txt: no closed fence after 'New:'\n");
});

test('a three-backtick fence inside New and a ## Checks line inside New end neither the edit nor the section', (t) =>
{
    const p = project(t, { 'a.txt': 'marker\n', 'b.txt': 'second\n' });
    const inner = 'before\n```js\ncode();\n```\n## Checks\n### E9 - fake.txt\nBaseline: bogus\nafter';
    const plan = p.plan([replaceEdit(1, 'a.txt', 'marker', inner), replaceEdit(2, 'b.txt', 'second', 'SECOND')]);

    const result = p.run(plan);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Applies: 2 of 2 edits$/m);
    assert.equal(p.read(`${EXPECTED}/a.txt`), `${inner}\n`);
    assert.equal(p.read(`${EXPECTED}/b.txt`), 'SECOND\n');
});

for (const [name, folder] of [['plan.md', 'expected'], ['plan-2.md', 'expected-2'], ['retro-plan.md', 'retro-expected'], ['other.md', 'other-expected']])
{
    test(`${name} writes its files into ${folder}`, (t) =>
    {
        const p = project(t, { 'a.txt': ALPHA });
        const plan = p.plan([replaceEdit(1, 'a.txt', 'beta', 'BETA')], { name });

        const result = p.run(plan);

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(p.list(RUN_FOLDER).filter((entry) => !entry.includes('/')), [folder, name].sort());
        assert.equal(p.read(`${RUN_FOLDER}/${folder}/a.txt`), 'alpha\nBETA\ngamma\n');
    });
}

test('the expected folder is replaced whole: a stale file in it is gone after a pass', (t) =>
{
    const p = project(t, { 'a.txt': ALPHA });
    const plan = p.plan([replaceEdit(1, 'a.txt', 'beta', 'BETA')]);
    writeFiles(p.repo, { [`${EXPECTED}/stale.txt`]: 'old\n', [`${EXPECTED}/a.txt`]: 'old\n' });

    const result = p.run(plan);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(p.list(EXPECTED), ['a.txt']);
    assert.equal(p.read(`${EXPECTED}/a.txt`), 'alpha\nBETA\ngamma\n');
});

const WITHOUT_FILES = { 'a.txt': 'one\nfour\n', 'b.txt': 'two\n', 'c.txt': 'three\n' };
const withoutEdits = () => [
    replaceEdit(1, 'a.txt', 'one', 'ONE'),
    replaceEdit(2, 'b.txt', 'two', 'TWO', { needs: 'E1' }),
    replaceEdit(3, 'c.txt', 'three', 'THREE'),
    replaceEdit(4, 'a.txt', 'four', 'FOUR'),
];

test('--without writes the variant folder, leaving out the edit and the edits that need it', (t) =>
{
    const p = project(t, WITHOUT_FILES);
    const plan = p.plan(withoutEdits());

    const result = p.run(plan, '--without', 'E1');

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^expected-without-E1: 2 of 4 edits, left out E1, E2; files: a\.txt, b\.txt$/m);
    assert.deepEqual(p.list(`${EXPECTED}-without-E1`), ['a.txt', 'b.txt']);
    assert.equal(p.read(`${EXPECTED}-without-E1/a.txt`), 'one\nFOUR\n');
    assert.equal(p.read(`${EXPECTED}-without-E1/b.txt`), 'two\n');
    assert.equal(p.read(`${EXPECTED}/a.txt`), 'ONE\nFOUR\n');
});

test('--without E2,E8 leaves both out in one variant named expected-without-E2-E8, and is repeatable', (t) =>
{
    const p = project(t, { 'a.txt': 'one\n', 'b.txt': 'two\n', 'c.txt': 'three\n' });
    const plan = p.plan([replaceEdit(1, 'a.txt', 'one', 'ONE'), replaceEdit(2, 'b.txt', 'two', 'TWO'), replaceEdit(8, 'c.txt', 'three', 'THREE')]);

    const result = p.run(plan, '--without', 'E2,E8', '--without', 'E8');

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^expected-without-E2-E8: 1 of 3 edits, left out E2, E8; files: b\.txt, c\.txt$/m);
    assert.equal(p.read(`${EXPECTED}-without-E2-E8/b.txt`), 'two\n');
    assert.equal(p.read(`${EXPECTED}-without-E2-E8/c.txt`), 'three\n');
    assert.equal(p.read(`${EXPECTED}-without-E8/c.txt`), 'three\n');
});

test('--without leaves no file for a left-out new-file edit', (t) =>
{
    const p = project(t, { 'a.txt': ALPHA });
    const plan = p.plan([{ n: 1, path: 'fresh.txt', kind: 'new-file', new: 'hi' }, replaceEdit(2, 'a.txt', 'beta', 'BETA')]);

    const result = p.run(plan, '--without', 'E1');

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^expected-without-E1: 1 of 2 edits, left out E1; files: $/m);
    assert.equal(p.exists(`${EXPECTED}-without-E1/fresh.txt`), false);
});

test('--without an edit number the plan does not hold is a usage error and writes nothing', (t) =>
{
    const p = project(t, { 'a.txt': ALPHA });
    const plan = p.plan([replaceEdit(1, 'a.txt', 'beta', 'BETA')]);

    const result = p.run(plan, '--without', 'E5');

    assert.equal(result.status, 2);
    assert.match(result.stderr, /^prove-plan: .*E5/);
    assert.equal(result.stdout, '');
    assert.equal(p.exists(EXPECTED), false);
});

test('a variant in which a remaining edit fails prints its failure under the folder name and exits 1', (t) =>
{
    const p = project(t, { 'a.txt': 'dup A\ndup B\n' });
    const plan = p.plan([replaceEdit(1, 'a.txt', 'dup A', 'first'), replaceEdit(2, 'a.txt', 'dup', 'second')]);

    const result = p.run(plan, '--without', 'E1');

    assert.equal(result.status, 1);
    assert.equal(result.stdout, 'Applies: 2 of 2 edits\n  a.txt (12 -> 15 characters)\n');
    assert.equal(result.stderr, 'expected-without-E1: E2 - a.txt: Old found 2 times\n');
    assert.equal(p.exists(EXPECTED), true);
    assert.equal(p.exists(`${EXPECTED}-without-E1`), false);
});

test('plan-level errors exit 2 with one prove-plan line and write nothing', async (t) =>
{
    const p = project(t, { 'a.txt': ALPHA });
    const good = renderPlan({ baseline: p.baseline, edits: [replaceEdit(1, 'a.txt', 'beta', 'BETA')] });
    const plan = (edits) => renderPlan({ baseline: p.baseline, edits });
    const cases = {
        'no Baseline line': [good.replace(/^Baseline: .*\n/m, ''), /Baseline/],
        'an unknown revision': [good.replace(`Baseline: ${p.baseline}`, 'Baseline: nosuchrev00'), /nosuchrev00/],
        'no Edits section': [good.replace('## Edits', '## Changes'), /Edits/],
        'no edit in the Edits section': [good.replace(/### E1[\s\S]*?(?=## Open questions)/, ''), /no edit/],
        'numbers that do not rise': [plan([replaceEdit(2, 'a.txt', 'alpha', 'ALPHA'), replaceEdit(2, 'a.txt', 'beta', 'BETA')]), /rise/],
        'a path that leaves the repository': [plan([replaceEdit(1, '../outside.txt', 'x', 'y')]), /outside the repository/],
        'a padded path that leaves the repository': [plan([{ n: 1, path: ' ../plan.md', kind: 'new-file', new: 'x' }]), /outside the repository/],
        'an edit heading after the Edits section ended': [good.replace('## Open questions', '## Open questions\n\n### E2 - b.txt'), /E2 is outside the Edits section/],
        "a second 'Old:' label in one edit": [good.replace('\nNew:\n', '\nOld:\n\nNew:\n'), /E1 has more than one 'Old:'/],
        "a second 'New:' label in one edit": [good.replace('\n## Open questions', '\nNew:\n\n## Open questions'), /E1 has more than one 'New:'/],
    };
    for (const [name, [text, message]] of Object.entries(cases))
        await t.test(name, () =>
        {
            writeFiles(p.repo, { [PLAN]: text });
            const result = p.run(PLAN);

            assert.equal(result.status, 2);
            assert.match(result.stderr, /^prove-plan: [^\n]+\n$/);
            assert.match(result.stderr, message);
            assert.equal(result.stdout, '');
            assert.equal(p.exists(EXPECTED), false);
        });
});

test('no argument, an unknown option and an unreadable plan exit 2 with a prove-plan line', (t) =>
{
    const p = project(t, { 'a.txt': ALPHA });
    const plan = p.plan([replaceEdit(1, 'a.txt', 'beta', 'BETA')]);

    for (const args of [[], [plan, '--bogus'], ['docs/run/missing.md']])
    {
        const result = p.run(...args);
        assert.equal(result.status, 2, args.join(' '));
        assert.match(result.stderr, /^prove-plan: [^\n]+\n$/, args.join(' '));
    }
});

test('outside a git repository it exits 2', (t) =>
{
    const folder = makeTempDir(t, 'no-git');
    writeFiles(folder, { 'plan.md': renderPlan({ baseline: 'abc1234', edits: [replaceEdit(1, 'a.txt', 'x', 'y')] }) });

    const result = runNode(PROVE, ['plan.md'], { cwd: folder });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /^prove-plan: [^\n]+\n$/);
});
