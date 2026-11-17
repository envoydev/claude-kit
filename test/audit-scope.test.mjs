// bin/audit-scope.mjs scope, run as the command it is, in a throwaway git repository of rules, skills and hooks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
    EARLIER,
    GRADES_A_AND_B,
    LATER,
    SCOPE_SKILL,
    TODAY,
    WITH_DEFAULTS,
    carriedLine,
    daysAgo,
    makeScopeProject,
    printedLines,
} from './support.mjs';

test('no state: every item is new and nothing is written', (t) =>
{
    const p = makeScopeProject(t);
    const before = p.tree();

    const result = p.scope('rules');

    assert.deepEqual(printedLines(result), ['no earlier audit on this machine', 'audit rules/a.md - new', 'audit rules/b.md - new', 'Scope: 2 of 2 items audited, 0 carried']);
    assert.deepEqual(p.tree(), before);
    assert.equal(fs.existsSync(path.join(p.repo, 'docs')), false);
});

test('record then scope carries everything', (t) =>
{
    const p = makeScopeProject(t);

    const recorded = p.record(GRADES_A_AND_B, 'rules');
    const result = p.scope('rules');

    assert.equal(recorded.stdout, 'Recorded: 2 graded, 0 kept, 0 dropped, 0 skipped - docs/superpowers/audits/state/rules.json\n');
    assert.deepEqual(printedLines(result), [carriedLine('rules/a.md', 'A / 9'), carriedLine('rules/b.md', 'A / 9.5'), 'Scope: 0 of 2 items audited, 2 carried']);
});

test('a changed file makes its item audited', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    p.write('rules/a.md', 'A2\n');

    assert.deepEqual(printedLines(p.scope('rules')), ['audit rules/a.md - changed', carriedLine('rules/b.md', 'A / 9.5'), 'Scope: 1 of 2 items audited, 1 carried']);
});

for (const [name, change] of [
    ['a file added to a folder item', (p) => { p.write('skills/one/references/y.md', 'y\n'); p.add('skills/one/references/y.md'); }],
    ['a file removed from a folder item', (p) => p.remove('skills/one/references/x.md')],
])
{
    test(`${name} makes the folder item changed`, (t) =>
    {
        const p = makeScopeProject(t);
        p.record('skills/one\tA\t9\tyes\nskills/two\tA\t9\tyes\n', 'skills', { kind: 'skills' });
        change(p);

        const printed = printedLines(p.scope('skills', { kind: 'skills' }));

        assert.deepEqual(printed.slice(0, 2), ['audit skills/one - changed', `carried skills/two - A / 9 from ${TODAY} - docs/superpowers/audits/2026-11-17-skills`]);
    });
}

test('a new tracked item is new and an untracked entry is no item', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    p.write('rules/c.md', 'C\n');
    p.add('rules/c.md');
    p.write('rules/draft.md', 'draft\n');

    const printed = printedLines(p.scope('rules'));

    assert.ok(printed.includes('audit rules/c.md - new'));
    assert.equal(printed.some((line) => line.includes('rules/draft.md')), false);
});

test('a file deleted and not committed leaves a gone item', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    p.remove('rules/b.md');

    assert.deepEqual(printedLines(p.scope('rules')), [carriedLine('rules/a.md', 'A / 9'), 'gone rules/b.md', 'Scope: 0 of 1 items audited, 1 carried']);
});

test('an item below the target stays audited', (t) =>
{
    const p = makeScopeProject(t);
    p.record('rules/a.md\tA\t9\tyes\nrules/b.md\tB\t7\tno\n', 'rules');

    assert.ok(printedLines(p.scope('rules')).includes('audit rules/b.md - below the target (B / 7)'));
});

test('--full audits every item, and a new one is still new', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    p.write('rules/c.md', 'C\n');
    p.add('rules/c.md');

    assert.deepEqual(printedLines(p.scope('--full', 'rules')), ['audit rules/a.md - full', 'audit rules/b.md - full', 'audit rules/c.md - new', 'Scope: 3 of 3 items audited, 0 carried']);
});

test('a root that is a file is its own item', (t) =>
{
    const p = makeScopeProject(t);

    assert.deepEqual(printedLines(p.scope('AGENTS.md', { kind: 'agent-md' })), ['no earlier audit on this machine', 'audit AGENTS.md - new', 'Scope: 1 of 1 items audited, 0 carried']);
});

test('an item outside the roots is recorded and then scoped', (t) =>
{
    const p = makeScopeProject(t);

    const recorded = p.record(`${GRADES_A_AND_B}AGENTS.md\tA\t9\tyes\n`, 'rules');
    const first = printedLines(p.scope('rules'));
    p.write('AGENTS.md', 'x\n');
    const second = printedLines(p.scope('rules'));

    assert.match(recorded.stdout, /^Recorded: 3 graded, /);
    assert.deepEqual(first, [carriedLine('AGENTS.md', 'A / 9'), carriedLine('rules/a.md', 'A / 9'), carriedLine('rules/b.md', 'A / 9.5'), 'Scope: 0 of 3 items audited, 3 carried']);
    assert.equal(second[0], 'audit AGENTS.md - changed');
});

test('a --with file that changed makes every item changed', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, ...WITH_DEFAULTS);

    assert.deepEqual(printedLines(p.scope(...WITH_DEFAULTS)).slice(0, 2), [carriedLine('rules/a.md', 'A / 9'), carriedLine('rules/b.md', 'A / 9.5')]);
    p.write('cfg/defaults.json', '{"a":1}\n');
    assert.deepEqual(printedLines(p.scope(...WITH_DEFAULTS)).slice(0, 2), ['audit rules/a.md - changed (cfg/defaults.json)', 'audit rules/b.md - changed (cfg/defaults.json)']);
});

test('a --with list that differs from the recorded one makes every item changed', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, ...WITH_DEFAULTS);

    const removed = printedLines(p.scope('rules'));
    const added = printedLines(p.scope('--with', 'cfg/defaults.json', '--with', 'AGENTS.md', 'rules'));

    assert.deepEqual(removed.slice(0, 2), ['audit rules/a.md - changed (cfg/defaults.json)', 'audit rules/b.md - changed (cfg/defaults.json)']);
    assert.deepEqual(added.slice(0, 2), ['audit rules/a.md - changed (AGENTS.md)', 'audit rules/b.md - changed (AGENTS.md)']);
});

test('a --with folder is its files, and a file added under it changes every item', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, ...WITH_DEFAULTS);

    assert.deepEqual(printedLines(p.scope('--with', 'cfg', 'rules')).slice(0, 2), [carriedLine('rules/a.md', 'A / 9'), carriedLine('rules/b.md', 'A / 9.5')]);
    p.write('cfg/extra.json', '{}\n');
    p.add('cfg/extra.json');
    assert.deepEqual(printedLines(p.scope('--with', 'cfg', 'rules')).slice(0, 2), ['audit rules/a.md - changed (cfg/extra.json)', 'audit rules/b.md - changed (cfg/extra.json)']);
});

test('an entry a --with path names, or lies under, is no item', (t) =>
{
    const p = makeScopeProject(t);

    const printed = printedLines(p.scope('--with', 'hooks/helper.mjs', '--with', 'hooks/data', 'hooks', { kind: 'hooks' }));

    assert.deepEqual(printed, ['no earlier audit on this machine', 'audit hooks/guard.mjs - new', 'Scope: 1 of 1 items audited, 0 carried']);
});

test('a Finder file anywhere in the audit skill folder does not change its hash', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    p.write(`${SCOPE_SKILL}/.DS_Store`, 'finder\n');
    p.write(`${SCOPE_SKILL}/references/.DS_Store`, 'finder\n');

    assert.deepEqual(printedLines(p.scope('rules')), [carriedLine('rules/a.md', 'A / 9'), carriedLine('rules/b.md', 'A / 9.5'), 'Scope: 0 of 2 items audited, 2 carried']);
});

for (const scoringFile of ['rubric.md', 'currency.md'])
{
    test(`a changed ${scoringFile} makes every item changed`, (t) =>
    {
        const p = makeScopeProject(t);
        p.record(GRADES_A_AND_B, 'rules');
        p.write(`${SCOPE_SKILL}/references/${scoringFile}`, 'new text\n');

        assert.deepEqual(printedLines(p.scope('rules')).slice(0, 2), ['audit rules/a.md - changed (the rubric)', 'audit rules/b.md - changed (the rubric)']);
    });
}

test('a change elsewhere in the audit skill carries the grades and says so', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    p.setState((state) => { state.items['rules/a.md'].date = EARLIER; state.items['rules/b.md'].date = LATER; });
    p.write(`${SCOPE_SKILL}/SCOPE_SKILL.md`, 'audit 2\n');

    assert.deepEqual(printedLines(p.scope('rules')), [
        carriedLine('rules/a.md', 'A / 9', EARLIER),
        carriedLine('rules/b.md', 'A / 9.5', LATER),
        'Scope: 0 of 2 items audited, 2 carried',
        `the audit skill changed since ${EARLIER}: 2 carried grades stand under the earlier text`,
    ]);
});

test('a path with a space and a non-ASCII letter is one item', (t) =>
{
    const p = makeScopeProject(t);
    p.write('rules/my rule é.md', 'odd\n');
    p.add('rules/my rule é.md');
    p.commit();

    p.record(`${GRADES_A_AND_B}rules/my rule é.md\tA\t9\tyes\n`, 'rules');

    assert.ok(printedLines(p.scope('rules')).includes(carriedLine('rules/my rule é.md', 'A / 9')));
});

test('a trailing slash and a working directory below the root change nothing', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    const expected = p.scope('rules').stdout;

    assert.equal(p.scope('rules/').stdout, expected);
    assert.equal(p.scope('rules', { cwd: path.join(p.repo, 'rules') }).stdout, expected);
});

const AGE_LINE = (count, limit) => `age: ${count} items graded more than ${limit} days ago are audited again`;

test('a grade older than the limit is audited again', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    const old = daysAgo(31);
    p.setState((state) => { state.items['rules/a.md'].date = old; });

    assert.deepEqual(printedLines(p.scope('rules')), [
        `audit rules/a.md - older than 30 days (A / 9 from ${old})`,
        carriedLine('rules/b.md', 'A / 9.5'),
        'Scope: 1 of 2 items audited, 1 carried',
        AGE_LINE(1, 30),
    ]);
});

test('a grade exactly at the limit is carried', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    const edge = daysAgo(30);
    p.setState((state) => { state.items['rules/a.md'].date = edge; });

    assert.deepEqual(printedLines(p.scope('rules')), [carriedLine('rules/a.md', 'A / 9', edge), carriedLine('rules/b.md', 'A / 9.5'), 'Scope: 0 of 2 items audited, 2 carried']);
});

test('a grade dated in the future is carried', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    const later = daysAgo(-5);
    p.setState((state) => { state.items['rules/a.md'].date = later; });

    assert.deepEqual(printedLines(p.scope('rules')), [carriedLine('rules/a.md', 'A / 9', later), carriedLine('rules/b.md', 'A / 9.5'), 'Scope: 0 of 2 items audited, 2 carried']);
});

test('--max-age changes the limit', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    const old = daysAgo(8);
    p.setState((state) => { state.items['rules/a.md'].date = old; });

    const printed = printedLines(p.scope('--max-age', '7', 'rules'));

    assert.ok(printed.includes(`audit rules/a.md - older than 7 days (A / 9 from ${old})`));
    assert.ok(printed.includes(AGE_LINE(1, 7)));
});

test('below the target outranks age', (t) =>
{
    const p = makeScopeProject(t);
    p.record('rules/a.md\tA\t9\tyes\nrules/b.md\tB\t7\tno\n', 'rules');
    p.setState((state) => { state.items['rules/b.md'].date = daysAgo(40); });

    const printed = printedLines(p.scope('rules'));

    assert.ok(printed.includes('audit rules/b.md - below the target (B / 7)'));
    assert.equal(printed.some((line) => line.startsWith('age:')), false);
});

test('the age line sits between the Scope line and the audit skill line', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    const old = daysAgo(40);
    p.setState((state) => { state.items['rules/a.md'].date = old; });
    p.write(`${SCOPE_SKILL}/SCOPE_SKILL.md`, 'audit 2\n');

    const printed = printedLines(p.scope('rules'));

    assert.deepEqual(printed.slice(-3), [
        'Scope: 1 of 2 items audited, 1 carried',
        AGE_LINE(1, 30),
        `the audit skill changed since ${TODAY}: 1 carried grades stand under the earlier text`,
    ]);
});

test('--full reads full, not older', (t) =>
{
    const p = makeScopeProject(t);
    p.record(GRADES_A_AND_B, 'rules');
    p.setState((state) =>
    {
        state.items['rules/a.md'].date = daysAgo(40);
        state.items['rules/b.md'].date = daysAgo(40);
    });

    assert.deepEqual(printedLines(p.scope('--full', 'rules')), ['audit rules/a.md - full', 'audit rules/b.md - full', 'Scope: 2 of 2 items audited, 0 carried']);
});
