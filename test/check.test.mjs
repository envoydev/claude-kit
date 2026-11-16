// bin/check.mjs, run where it lives in a synced repo: .claude/kit/check.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeKit, makeRepo, makeSibling, runNode, syncScript, writeFiles } from './support.mjs';

const skillFile = (description) => `---\nname: demo\ndescription: ${description}\n---\n\n# Demo\n`;

const SHARED = {
    'rules/alpha.md': '# Alpha\n',
    'skills/demo/SKILL.md': skillFile('A demo skill.'),
    'settings.base.json': {},
    'mcp.json': {},
    'retired.json': {},
};

function makeSyncedRepo(t, shared = SHARED)
{
    const repo = makeRepo(t);
    const synced = runNode(syncScript(makeKit(t, shared)), [repo]);
    if (synced.status !== 0) throw new Error(`the fixture sync failed: ${synced.stderr}`);
    return repo;
}

const check = (repo) => runNode(path.join(repo, '.claude/kit/check.mjs'));

test('passes on a repo exactly as the sync left it, and says how many files it compared', (t) =>
{
    const result = check(makeSyncedRepo(t));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^claude-kit: 2 managed files match claude-kit@/);
});

test("passes with the kit's own settings file in the repo, which is no managed file", (t) =>
{
    const repo = makeSyncedRepo(t);
    writeFiles(repo, { '.claude/kit/settings.json': { plan_model: 'fable' } });

    const result = check(repo);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^claude-kit: 2 managed files match claude-kit@/);
});

test('fails and names a managed file that was edited in the repo', (t) =>
{
    const repo = makeSyncedRepo(t);
    fs.appendFileSync(path.join(repo, '.claude/rules/alpha.md'), 'a local line\n');

    const result = check(repo);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /1 managed file\(s\) differ/);
    assert.match(result.stderr, /edited here: \.claude\/rules\/alpha\.md/);
});

test('fails and names a managed file that was removed from the repo', (t) =>
{
    const repo = makeSyncedRepo(t);
    fs.rmSync(path.join(repo, '.claude/skills/demo/SKILL.md'));

    const result = check(repo);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing: \.claude\/skills\/demo\/SKILL\.md/);
});

for (const hidingFile of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'])
{
    test(`fails when ${hidingFile} sits beside AGENTS.md, because Claude Code then stops reading AGENTS.md`, (t) =>
    {
        const repo = makeSyncedRepo(t);
        writeFiles(repo, { 'AGENTS.md': '# Agents\n', [hidingFile]: '# Claude\n' });

        const result = check(repo);

        assert.equal(result.status, 1);
        assert.ok(result.stderr.includes(`${hidingFile} hides AGENTS.md`), result.stderr);
    });
}

test('a CLAUDE.md in a repo that has no AGENTS.md is not its business', (t) =>
{
    const repo = makeSyncedRepo(t);
    writeFiles(repo, { 'CLAUDE.md': '# Claude\n' });

    assert.equal(check(repo).status, 0);
});

test('an edited file and a hiding CLAUDE.md are both reported in one run', (t) =>
{
    const repo = makeSyncedRepo(t);
    fs.appendFileSync(path.join(repo, '.claude/rules/alpha.md'), 'a local line\n');
    writeFiles(repo, { 'AGENTS.md': '# Agents\n', 'CLAUDE.md': '# Claude\n' });

    const result = check(repo);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /CLAUDE\.md hides AGENTS\.md/);
    assert.match(result.stderr, /edited here: \.claude\/rules\/alpha\.md/);
});

const REGISTRY_SUMMARY = /claude-kit: copies\.json - entries: 1, sites checked: 2, markers: 3/;

const registry = (...entries) => ({ copies: entries });
const entryOf = (owner, copies, id = 'the-line') => ({ id, why: 'kept in two files', owner, copies });

test('a repo without a copies.json skips the registry check without a word', (t) =>
{
    const result = check(makeSyncedRepo(t));

    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('copies.json'), result.stdout);
});

test('passes when every marker is in its site, and prints the counts', (t) =>
{
    const repo = makeSyncedRepo(t);
    writeFiles(repo, {
        'owner.md': 'The line, word for word.\nA second marker.\n',
        'copy.md': 'Here: the line, word for word.\n',
        'copies.json': registry(entryOf(
            { site: 'owner.md', markers: ['The line, word for word.', 'A second marker.'] },
            [{ site: 'copy.md', markers: ['the line, word for word.'] }],
        )),
    });

    const result = check(repo);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, REGISTRY_SUMMARY);
});

test('a marker split by a line wrap and the next line indentation still counts', (t) =>
{
    const repo = makeSyncedRepo(t);
    writeFiles(repo, {
        'owner.md': 'no trace of\n    the agent in a\t\n  commit\n',
        'copy.md': 'one line: no trace of the agent in a commit\n',
        'copies.json': registry(entryOf(
            { site: 'owner.md', markers: ['no trace of the agent in a commit'] },
            [{ site: 'copy.md', markers: ['no trace of  the agent'] }],
        )),
    });

    const result = check(repo);

    assert.equal(result.status, 0, result.stderr);
});

test('fails and names the id, the site and the marker when a marker is not in its site', (t) =>
{
    const repo = makeSyncedRepo(t);
    writeFiles(repo, {
        'owner.md': 'The line.\n',
        'copy.md': 'A drifted line.\n',
        'copies.json': registry(entryOf(
            { site: 'owner.md', markers: ['The line.'] },
            [{ site: 'copy.md', markers: ['The line.'] }],
            'drifting-line',
        )),
    });

    const result = check(repo);

    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("copies.json drifting-line: copy.md lacks 'The line.'"), result.stderr);
});

test('fails when the file of a site is missing', (t) =>
{
    const repo = makeSyncedRepo(t);
    writeFiles(repo, {
        'owner.md': 'The line.\n',
        'copies.json': registry(entryOf(
            { site: 'owner.md', markers: ['The line.'] },
            [{ site: 'gone.md', markers: ['The line.'] }],
        )),
    });

    const result = check(repo);

    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('copies.json the-line: gone.md is missing'), result.stderr);
});

test('reads a sibling site from the sibling repo beside this one', (t) =>
{
    const repo = makeSyncedRepo(t);
    const sibling = makeSibling(t, repo, { 'AGENTS.md': '# Agents\nThe line.\n' });
    writeFiles(repo, {
        'owner.md': 'The line.\n',
        'copies.json': registry(entryOf(
            { site: 'owner.md', markers: ['The line.'] },
            [{ site: `${sibling}:AGENTS.md`, markers: ['The line.', 'Absent.'] }],
        )),
    });

    const result = check(repo);

    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`copies.json the-line: ${sibling}:AGENTS.md lacks 'Absent.'`), result.stderr);
    assert.ok(!result.stderr.includes("lacks 'The line.'"), result.stderr);
});

test('a sibling that is not checked out is reported as not checked and is no failure', (t) =>
{
    const repo = makeSyncedRepo(t);
    const sibling = `absent-${path.basename(repo)}`;
    writeFiles(repo, {
        'owner.md': 'The line.\n',
        'copies.json': registry(entryOf(
            { site: 'owner.md', markers: ['The line.'] },
            [{ site: `${sibling}:AGENTS.md`, markers: ['The line.'] }, { site: `${sibling}:README.md`, markers: ['The line.'] }],
        )),
    });

    const result = check(repo);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
        result.stdout.includes(`claude-kit: copies.json - ${sibling} is not checked out beside this repo, 2 site(s) not checked`),
        result.stdout,
    );
});

for (const [label, content] of [
    ['is not JSON', '{ "copies": ['],
    ['has no copies array', '{ "about": "nothing" }\n'],
    ['has an entry without an owner', JSON.stringify({ copies: [{ id: 'x', copies: [] }] })],
    ['has a site whose markers are not strings', JSON.stringify(registry(entryOf({ site: 'a.md', markers: [1] }, [])))],
])
{
    test(`a copies.json that ${label} fails and says it cannot be read, with no stack trace`, (t) =>
    {
        const repo = makeSyncedRepo(t);
        writeFiles(repo, { 'copies.json': content });

        const result = check(repo);

        assert.equal(result.status, 1);
        assert.match(result.stderr, /^copies\.json cannot be read: .+/m);
        assert.ok(!result.stderr.includes('    at '), result.stderr);
    });
}

const sharedWith = (skill) => ({ ...SHARED, 'skills/demo/SKILL.md': skill });
const descriptionFailure = (result, line) =>
{
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(line), result.stderr);
};

test('a skill with a description of 160 characters passes, and the count of skills is printed', (t) =>
{
    const result = check(makeSyncedRepo(t, sharedWith(skillFile('x'.repeat(160)))));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /claude-kit: 1 skill description\(s\) are one line of 160 characters or fewer/);
});

test('a description of 161 characters fails with its count', (t) =>
{
    const result = check(makeSyncedRepo(t, sharedWith(skillFile('x'.repeat(161)))));

    descriptionFailure(result, '.claude/skills/demo/SKILL.md: description is 161 characters, over 160');
});

for (const quote of ["'", '"'])
{
    test(`a description in ${quote} quotes is measured without them`, (t) =>
    {
        const atLimit = check(makeSyncedRepo(t, sharedWith(skillFile(`${quote}${'x'.repeat(160)}${quote}`))));
        const over = check(makeSyncedRepo(t, sharedWith(skillFile(`${quote}${'x'.repeat(161)}${quote}`))));

        assert.equal(atLimit.status, 0, atLimit.stderr);
        descriptionFailure(over, 'description is 161 characters, over 160');
    });
}

for (const [label, skill] of [
    ['a folded block scalar', '---\nname: demo\ndescription: >\n  Folded text.\n---\n'],
    ['a literal block scalar that strips', '---\nname: demo\ndescription: |-\n  Literal text.\n---\n'],
    ['an indented continuation', '---\nname: demo\ndescription: Starts here\n  and goes on.\n---\n'],
    ['an empty value', '---\nname: demo\ndescription:\n---\n'],
])
{
    test(`${label} fails as a description that is not on one line`, (t) =>
    {
        const result = check(makeSyncedRepo(t, sharedWith(skill)));

        descriptionFailure(result, '.claude/skills/demo/SKILL.md: description is not on one line');
    });
}

for (const [label, skill] of [
    ['no frontmatter', '# Demo\n'],
    ['no description key', '---\nname: demo\n---\n\n# Demo\n'],
    ['a frontmatter that is never closed', '---\nname: demo\ndescription: A demo.\n'],
])
{
    test(`a skill with ${label} fails as having no description in the frontmatter`, (t) =>
    {
        const result = check(makeSyncedRepo(t, sharedWith(skill)));

        descriptionFailure(result, '.claude/skills/demo/SKILL.md: no description in the frontmatter');
    });
}

test('a skill the lock lists but the repo lost is reported once, as missing, and not as a description', (t) =>
{
    const repo = makeSyncedRepo(t);
    fs.rmSync(path.join(repo, '.claude/skills/demo/SKILL.md'));

    const result = check(repo);

    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('missing: .claude/skills/demo/SKILL.md'), result.stderr);
    assert.ok(!result.stderr.includes('description'), result.stderr);
});

test('a SKILL.md.tmpl and a SKILL.md under shared/skills are checked where the repo has that folder', (t) =>
{
    const repo = makeSyncedRepo(t);
    writeFiles(repo, {
        'shared/skills/templated/SKILL.md.tmpl': skillFile('x'.repeat(161)),
        'shared/skills/plain/SKILL.md': '---\nname: plain\n---\n',
        'shared/skills/fine/SKILL.md': skillFile('A fine skill.'),
    });

    const result = check(repo);

    descriptionFailure(result, 'shared/skills/templated/SKILL.md.tmpl: description is 161 characters, over 160');
    assert.ok(result.stderr.includes('shared/skills/plain/SKILL.md: no description in the frontmatter'), result.stderr);
    assert.ok(!result.stderr.includes('shared/skills/fine'), result.stderr);
});

test('a repo with no shared/skills checks only the skills in its lock', (t) =>
{
    const repo = makeSyncedRepo(t);
    writeFiles(repo, { '.claude/skills/own/SKILL.md': '# Not in the lock, no frontmatter\n' });

    const result = check(repo);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /claude-kit: 1 skill description\(s\)/);
});
