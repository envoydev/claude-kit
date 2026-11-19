// bin/prove-plan.mjs --check, run as the command it is, in a throwaway git repository holding a plan in a folder of its own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
    ALPHA_TEXT,
    PLAN_EXPECTED_FOLDER,
    PLAN_RUN_FOLDER,
    makePlanProject,
    makeReplaceEdit,
    readRunFolder,
    renderPlan,
    writeFiles,
} from './support.mjs';

const CHECK_FILES = { 'a.txt': 'one\ntwo\nthree\n', 'dir/b.txt': 'x = 1\n' };
const checkEdits = () => [makeReplaceEdit(1, 'a.txt', 'two', 'TWO!'), makeReplaceEdit(2, 'dir/b.txt', 'x = 1', 'x = 22')];
const APPLIES_TWO = 'Applies: 2 of 2 edits';
const APPLIES_MISSING = 'the plan has no Applies line\n';
const PROVED_TWO = 'Proved: 2 of 2 edits; expected/ holds the 2 proved files\n';

// The fixture of the --check cases: a plan with a matching Applies line, the writing mode run once unless `prove` is false.
function checkProject(t, { files: baselineFiles = CHECK_FILES, edits = checkEdits(), applies = APPLIES_TWO, prove = true, ...options } = {})
{
    const p = makePlanProject(t, baselineFiles);
    const plan = p.plan(edits, { applies, ...options });
    if (prove) assert.equal(p.run(plan).status, 0);
    return { p, plan };
}

// Runs the prover and shows that it wrote, changed and removed nothing under the run folder.
function runWriteless(p, ...args)
{
    const before = readRunFolder(p);
    const result = p.run(...args);
    assert.deepEqual(readRunFolder(p), before);
    return result;
}

test('check passes on a proved plan: exit 0, one Proved line and nothing on stderr', (t) =>
{
    const { p, plan } = checkProject(t);

    const result = runWriteless(p, '--check', plan);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, PROVED_TWO);
});

test('check accepts the flag after the plan path', (t) =>
{
    const { p, plan } = checkProject(t);

    const result = runWriteless(p, plan, '--check');

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, PROVED_TWO);
});

test('check names a differing, a missing and an extra file', (t) =>
{
    const { p, plan } = checkProject(t);
    writeFiles(p.repo, { [`${PLAN_EXPECTED_FOLDER}/a.txt.expected`]: 'tampered\n', [`${PLAN_EXPECTED_FOLDER}/stray.txt.expected`]: 'extra\n' });
    fs.rmSync(path.join(p.repo, PLAN_EXPECTED_FOLDER, 'dir/b.txt.expected'));

    const result = runWriteless(p, '--check', plan);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'expected/a.txt: differs\nexpected/dir/b.txt: missing\nexpected/stray.txt: not a file of this plan\n');
});

test('check with no expected folder names every file missing and does not make the folder', (t) =>
{
    const { p, plan } = checkProject(t, { prove: false });

    const result = runWriteless(p, '--check', plan);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'expected/a.txt: missing\nexpected/dir/b.txt: missing\n');
    assert.equal(p.exists(PLAN_EXPECTED_FOLDER), false);
});

test('check ignores a .DS_Store in the expected folder', (t) =>
{
    const { p, plan } = checkProject(t);
    writeFiles(p.repo, { [`${PLAN_EXPECTED_FOLDER}/.DS_Store`]: 'junk', [`${PLAN_EXPECTED_FOLDER}/dir/.DS_Store`]: 'junk' });

    const result = runWriteless(p, '--check', plan);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, PROVED_TWO);
});

for (const line of ['Applies: 1 of 2 edits', 'Applies: 3 of 3 edits'])
{
    test(`a stale Applies line fails the check: '${line}'`, (t) =>
    {
        const { p, plan } = checkProject(t, { applies: line });

        const result = runWriteless(p, '--check', plan);

        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `the plan says '${line}'\n`);
    });
}

test('a plan with no Applies line fails the check', (t) =>
{
    const { p, plan } = checkProject(t, { applies: null });

    const result = runWriteless(p, '--check', plan);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, APPLIES_MISSING);
});

test('text after the count of the Applies line is allowed', (t) =>
{
    const { p, plan } = checkProject(t, { applies: 'Applies: 2 of 2 edits - proved on a copy' });

    const result = runWriteless(p, '--check', plan);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, PROVED_TWO);
});

test('an Applies line inside a fence is ignored', (t) =>
{
    const { p, plan } = checkProject(t, { applies: ['```text', 'Applies: 9 of 9 edits', '```', APPLIES_TWO] });

    const result = runWriteless(p, '--check', plan);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, PROVED_TWO);
});

for (const [name, options] of [
    ['only inside a fence', { applies: ['```text', APPLIES_TWO, '```'] }],
    ['only below ## Summary', { applies: null, tail: [APPLIES_TWO] }],
])
{
    test(`an Applies line ${name} is no Applies line`, (t) =>
    {
        const { p, plan } = checkProject(t, options);

        const result = runWriteless(p, '--check', plan);

        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, APPLIES_MISSING);
    });
}

for (const [name, folder] of [['plan-2.md', 'expected-2'], ['retro-plan.md', 'retro-expected']])
{
    test(`${name} names its folder ${folder}/ in the Proved line`, (t) =>
    {
        const { p, plan } = checkProject(t, { files: { 'a.txt': ALPHA_TEXT }, edits: [makeReplaceEdit(1, 'a.txt', 'beta', 'BETA')], name, applies: 'Applies: 1 of 1 edits' });

        const result = runWriteless(p, '--check', plan);

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `Proved: 1 of 1 edits; ${folder}/ holds the 1 proved files\n`);
    });
}

test('a plan that writes no file passes with no expected folder', (t) =>
{
    const { p, plan } = checkProject(t, { files: { 'a.txt': ALPHA_TEXT }, edits: [{ n: 1, path: 'a.txt', kind: 'delete-file' }], applies: 'Applies: 1 of 1 edits', prove: false });

    const result = runWriteless(p, '--check', plan);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'Proved: 1 of 1 edits; expected/ holds the 0 proved files\n');
    assert.equal(p.exists(PLAN_EXPECTED_FOLDER), false);
});

const VARIANT_PROJECT = { files: { 'a.txt': ALPHA_TEXT }, edits: [makeReplaceEdit(1, 'a.txt', 'alpha', 'ALPHA'), makeReplaceEdit(2, 'a.txt', 'beta', 'BETA')] };

function variantProject(t)
{
    const { p, plan } = checkProject(t, { ...VARIANT_PROJECT, prove: false });
    assert.equal(p.run(plan, '--without', 'E2').status, 0);
    return { p, plan };
}

test('check with --without compares the variant folder too', (t) =>
{
    const { p, plan } = variantProject(t);

    const result = runWriteless(p, '--check', plan, '--without', 'E2');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'Proved: 2 of 2 edits; expected/ holds the 1 proved files\nProved: expected-without-E2/ holds the 1 proved files\n');
});

test('a variant folder that differs or is missing fails the check', (t) =>
{
    const { p, plan } = variantProject(t);
    writeFiles(p.repo, { [`${PLAN_EXPECTED_FOLDER}-without-E2/a.txt.expected`]: 'x\n' });

    const differs = runWriteless(p, '--check', plan, '--without', 'E2');

    assert.equal(differs.status, 1);
    assert.equal(differs.stdout, '');
    assert.equal(differs.stderr, 'expected-without-E2/a.txt: differs\n');

    fs.rmSync(path.join(p.repo, `${PLAN_EXPECTED_FOLDER}-without-E2`), { recursive: true });
    const missing = runWriteless(p, '--check', plan, '--without', 'E2');

    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, '');
    assert.equal(missing.stderr, 'expected-without-E2/a.txt: missing\n');
});

test('a failed replay prints the writing mode lines and compares nothing', (t) =>
{
    const { p, plan } = checkProject(t, { edits: [makeReplaceEdit(1, 'a.txt', 'absent', 'ABSENT'), makeReplaceEdit(2, 'dir/b.txt', 'x = 1', 'x = 22')], prove: false });
    const writing = p.run(plan);

    const result = runWriteless(p, '--check', plan);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, writing.stdout);
    assert.equal(result.stderr, writing.stderr);
    assert.doesNotMatch(result.stderr, /missing/);
});

test('plan-level and usage errors stay exit 2 with one prove-plan line and no stdout', (t) =>
{
    const { p, plan } = checkProject(t);
    const noEdit = `${PLAN_RUN_FOLDER}/no-edit.md`;
    writeFiles(p.repo, { [noEdit]: renderPlan({ baseline: p.baseline, edits: [], applies: APPLIES_TWO }) });
    const unknownRevision = p.plan(checkEdits(), { name: 'unknown-revision.md', rev: 'nosuchrev', applies: APPLIES_TWO });

    const cases = {
        'a plan with no edit': ['--check', noEdit],
        'an unknown revision': ['--check', unknownRevision],
        '--without an edit the plan lacks': ['--check', plan, '--without', 'E9'],
        'no plan path': ['--check'],
    };
    for (const [name, args] of Object.entries(cases))
    {
        const result = runWriteless(p, ...args);

        assert.equal(result.status, 2, name);
        assert.match(result.stderr, /^prove-plan: [^\n]+\n$/, name);
        assert.equal(result.stdout, '', name);
    }
    assert.equal(p.run('--check').stderr, 'prove-plan: no plan path - usage: node prove-plan.mjs [--check] <plan> [--without E<n>[,E<m>]]...\n');
});

test('check names combined differences in the fixed order: folder, extras, the Applies line, then the variant', (t) =>
{
    const { p, plan } = checkProject(t, { ...VARIANT_PROJECT, applies: 'Applies: 1 of 2 edits', prove: false });
    assert.equal(p.run(plan, '--without', 'E2').status, 0);
    writeFiles(p.repo, {
        [`${PLAN_EXPECTED_FOLDER}/a.txt.expected`]: 'x\n',
        [`${PLAN_EXPECTED_FOLDER}/stray.txt.expected`]: 'extra\n',
        [`${PLAN_EXPECTED_FOLDER}-without-E2/a.txt.expected`]: 'y\n',
        [`${PLAN_EXPECTED_FOLDER}-without-E2/extra.txt.expected`]: 'extra\n',
    });

    const result = runWriteless(p, '--check', plan, '--without', 'E2');

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, [
        'expected/a.txt: differs',
        'expected/stray.txt: not a file of this plan',
        "the plan says 'Applies: 1 of 2 edits'",
        'expected-without-E2/a.txt: differs',
        'expected-without-E2/extra.txt: not a file of this plan',
        '',
    ].join('\n'));
});

test('check counts a variant whose replay fails as a difference, with the writing mode failure line', (t) =>
{
    const { p, plan } = checkProject(t, {
        files: { 'a.txt': 'dup A\ndup B\n' },
        edits: [makeReplaceEdit(1, 'a.txt', 'dup A', 'first'), makeReplaceEdit(2, 'a.txt', 'dup', 'second')],
    });
    const writing = p.run(plan, '--without', 'E1');
    assert.equal(writing.status, 1);

    const result = runWriteless(p, '--check', plan, '--without', 'E1');

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, writing.stderr);
    assert.equal(result.stderr, 'expected-without-E1: E2 - a.txt: Old found 2 times\n');
});

test('check still reads an expected folder written before the .expected suffix', (t) =>
{
    const { p, plan } = checkProject(t);
    const folder = path.join(p.repo, PLAN_EXPECTED_FOLDER);
    for (const file of ['a.txt', 'dir/b.txt']) fs.renameSync(path.join(folder, `${file}.expected`), path.join(folder, file));

    const result = runWriteless(p, '--check', plan);

    assert.equal(result.stderr, '');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, PROVED_TWO);
});
