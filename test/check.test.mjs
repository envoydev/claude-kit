// bin/check.mjs, run where it lives in a synced repo: .claude/kit/check.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeKit, makeRepo, runNode, syncScript, writeFiles } from './support.mjs';

const SHARED = {
    'rules/alpha.md': '# Alpha\n',
    'skills/demo/SKILL.md': '# Demo\n',
    'settings.base.json': {},
    'mcp.json': {},
    'retired.json': {},
};

function makeSyncedRepo(t)
{
    const repo = makeRepo(t);
    const synced = runNode(syncScript(makeKit(t, SHARED)), [repo]);
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
