// The kit's file always holds all nine names (the owner's ruling, 2026-11-21): written complete by every save, by the status
// hook on a request, and by the sync.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { completeKitSettings, setKitSetting, unsetKitSetting } from '../bin/kit-settings.mjs';
import {
    AGENTS, KIT_FILE, makeHookRepo, makeKit, makeRepo, makeSettingsRepo, makeTempDir, promptInput, readKitFile, runHook, runNode, runSettings,
    syncScript,
} from './support.mjs';

const NAMES = ['plan_model', 'audit_model', 'review_model', 'implement_model', 'search_model', 'pass_score', 'scoring', 'auto_run', 'auto_approve'];
const DEFAULTS = {
    plan_model: 'opus', audit_model: 'opus', review_model: 'opus', implement_model: 'sonnet', search_model: 'haiku',
    pass_score: 90, scoring: 'on', auto_run: 'off', auto_approve: 'off',
};
const kitFilePath = (repo) => path.join(repo, KIT_FILE);
const readText = (repo) => fs.readFileSync(kitFilePath(repo), 'utf8');

test('a set on a repo with no file writes all nine names, the pass score as a number', (t) =>
{
    const repo = makeSettingsRepo(t);

    const result = runSettings(repo, ['set', 'auto_run', 'on']);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readKitFile(repo), { ...DEFAULTS, auto_run: 'on' });
    assert.deepEqual(Object.keys(readKitFile(repo)).sort(), [...NAMES].sort());
    assert.equal(typeof readKitFile(repo).pass_score, 'number');
});

test('a set fills each missing name with its default, never a KIT_* variable, and the audit model follows the plan model it just got', (t) =>
{
    const repo = makeSettingsRepo(t);

    runSettings(repo, ['set', 'plan_model', 'fable'], { KIT_SEARCH_MODEL: 'sonnet', KIT_PASS_SCORE: '75', KIT_SCORING: 'off', KIT_AUTO_APPROVE: 'on', KIT_REVIEW_MODEL: 'haiku' });

    assert.deepEqual(readKitFile(repo), { ...DEFAULTS, plan_model: 'fable', audit_model: 'fable' });
});

test('a set keeps the names, values and order the file has, and adds the missing names after them in the fixed order', (t) =>
{
    const repo = makeSettingsRepo(t, { ...AGENTS, [KIT_FILE]: { auto_run: 'on', plan_model: 'fable', note: 'kept', search_model: 'opus' } });

    setKitSetting(repo, 'scoring', 'off');

    assert.deepEqual(Object.keys(readKitFile(repo)), ['auto_run', 'plan_model', 'note', 'search_model', 'scoring', 'audit_model', 'review_model', 'implement_model', 'pass_score', 'auto_approve']);
    assert.deepEqual(readKitFile(repo), {
        auto_run: 'on', plan_model: 'fable', note: 'kept', search_model: 'opus', scoring: 'off',
        audit_model: 'fable', review_model: 'opus', implement_model: 'sonnet', pass_score: 90, auto_approve: 'off',
    });
});

test('an unset puts the name back in its own place with its default, never a KIT_* variable - the choice is dropped', (t) =>
{
    const repo = makeSettingsRepo(t, { ...AGENTS, [KIT_FILE]: { ...DEFAULTS, plan_model: 'fable', search_model: 'opus' } });

    const withVariable = runSettings(repo, ['unset', 'plan_model'], { KIT_PLAN_MODEL: 'haiku' });
    assert.equal(withVariable.status, 0, withVariable.stderr);
    assert.equal(withVariable.stdout.trim(), `plan_model: opus (${KIT_FILE})`);
    assert.deepEqual(readKitFile(repo), { ...DEFAULTS, search_model: 'opus' });

    runSettings(repo, ['set', 'plan_model', 'fable']);
    const withDefault = runSettings(repo, ['unset', 'plan_model']);
    assert.equal(withDefault.stdout.trim(), `plan_model: opus (${KIT_FILE})`);
    assert.deepEqual(Object.keys(readKitFile(repo)), NAMES);
    assert.deepEqual(readKitFile(repo), { ...DEFAULTS, search_model: 'opus' });
});

test('an unset on a partial file completes it, and an unset that changes nothing writes nothing', (t) =>
{
    const repo = makeSettingsRepo(t, { ...AGENTS, [KIT_FILE]: { auto_run: 'on', scoring: 'off' } });

    unsetKitSetting(repo, 'scoring');

    assert.deepEqual(readKitFile(repo), { auto_run: 'on', scoring: 'on', ...Object.fromEntries(NAMES.filter((name) => !['scoring', 'auto_run'].includes(name)).map((name) => [name, DEFAULTS[name]])) });
    const before = readText(repo);
    fs.utimesSync(kitFilePath(repo), 1_000, 1_000);

    unsetKitSetting(repo, 'scoring');

    assert.equal(readText(repo), before);
    assert.equal(fs.statSync(kitFilePath(repo)).mtimeMs, 1_000_000);
});

test('an unset or a set on a file that is not JSON leaves it as it is and fails', (t) =>
{
    const repo = makeSettingsRepo(t, { ...AGENTS, [KIT_FILE]: '{ not json' });

    const result = runSettings(repo, ['unset', 'plan_model']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /fix or delete it/);
    assert.equal(readText(repo), '{ not json');
});

test('the hook writes the full file for a request when the file is absent, from defaults and never from a KIT_* variable', (t) =>
{
    const repo = makeHookRepo(t);

    const { status, output } = runHook(repo, promptInput(), { KIT_SEARCH_MODEL: 'sonnet', KIT_AUTO_APPROVE: 'on', KIT_AUTO_RUN: 'on', KIT_SCORING: 'off', KIT_PASS_SCORE: '70', KIT_PLAN_MODEL: 'fable' });

    assert.equal(status, 0);
    assert.deepEqual(readKitFile(repo), DEFAULTS);
    assert.deepEqual(Object.keys(readKitFile(repo)), NAMES);
    const context = output.hookSpecificOutput.additionalContext;
    for (const name of NAMES) assert.ok(context.includes(`${name}=`), name);
    assert.equal(context.match(new RegExp(`\\(${KIT_FILE.replaceAll('.', '\\.')}\\);`, 'g')).length, 9);
    assert.ok(context.includes(`search_model=haiku (${KIT_FILE});`));
});

test('the hook completes a partial file from defaults, never from a KIT_* variable', (t) =>
{
    const repo = makeHookRepo(t, { [KIT_FILE]: { plan_model: 'fable' } });

    runHook(repo, promptInput(), { KIT_REVIEW_MODEL: 'haiku', KIT_AUTO_APPROVE: 'on', KIT_SCORING: 'off' });

    assert.deepEqual(readKitFile(repo), { ...DEFAULTS, plan_model: 'fable', audit_model: 'fable' });
});

test('a chat save on a partial file completes it from defaults, never from a KIT_* variable', (t) =>
{
    const repo = makeHookRepo(t, { [KIT_FILE]: { plan_model: 'fable' } });

    const { output } = runHook(repo, promptInput('auto run on'), { KIT_REVIEW_MODEL: 'haiku', KIT_AUTO_APPROVE: 'on', KIT_SCORING: 'off' });

    assert.deepEqual(readKitFile(repo), { ...DEFAULTS, plan_model: 'fable', audit_model: 'fable', auto_run: 'on' });
    assert.ok(output.hookSpecificOutput.additionalContext.includes('auto_approve=off'));
});

test('a variable has no effect on the status line once the file is complete', (t) =>
{
    const repo = makeHookRepo(t, { [KIT_FILE]: DEFAULTS });

    const { output } = runHook(repo, promptInput(), { KIT_AUTO_APPROVE: 'on', KIT_REVIEW_MODEL: 'haiku' });

    const context = output.hookSpecificOutput.additionalContext;
    assert.ok(context.includes(`auto_approve=off (${KIT_FILE});`));
    assert.ok(context.includes(`review_model=opus (${KIT_FILE});`));
});

test('the hook completes a partial file in place: names, values and order kept, the missing names after them', (t) =>
{
    const repo = makeHookRepo(t, { [KIT_FILE]: { auto_run: 'on', plan_model: 'fable', note: 'kept' } });

    const { output } = runHook(repo, promptInput());

    assert.deepEqual(Object.keys(readKitFile(repo)), ['auto_run', 'plan_model', 'note', 'audit_model', 'review_model', 'implement_model', 'search_model', 'pass_score', 'scoring', 'auto_approve']);
    assert.deepEqual(readKitFile(repo), {
        auto_run: 'on', plan_model: 'fable', note: 'kept', audit_model: 'fable', review_model: 'opus', implement_model: 'sonnet',
        search_model: 'haiku', pass_score: 90, scoring: 'on', auto_approve: 'off',
    });
    assert.ok(output.hookSpecificOutput.additionalContext.includes(`audit_model=fable (${KIT_FILE});`));
});

test('the hook never rewrites a complete file: its bytes and its modification time stay', (t) =>
{
    const compact = `${JSON.stringify({ ...DEFAULTS, auto_run: 'on' })}`;
    const repo = makeHookRepo(t, { [KIT_FILE]: compact });
    fs.utimesSync(kitFilePath(repo), 1_000, 1_000);

    runHook(repo, promptInput());
    runHook(repo, promptInput(), { KIT_AUTO_RUN: 'off' });

    assert.equal(readText(repo), compact);
    assert.equal(fs.statSync(kitFilePath(repo)).mtimeMs, 1_000_000);
});

test('the hook never rewrites a file that does not parse, and the request still goes through', (t) =>
{
    const repo = makeHookRepo(t, { [KIT_FILE]: '{ not json' });
    fs.utimesSync(kitFilePath(repo), 1_000, 1_000);

    const { status, output, stderr } = runHook(repo, promptInput());

    assert.equal(status, 0);
    assert.equal(stderr, '');
    assert.ok(output.hookSpecificOutput.additionalContext.includes('auto_run=off (default);'));
    assert.equal(readText(repo), '{ not json');
    assert.equal(fs.statSync(kitFilePath(repo)).mtimeMs, 1_000_000);
});

test('a saved choice on a request also completes the file', (t) =>
{
    const repo = makeHookRepo(t);

    runHook(repo, promptInput('plan model fable'));

    assert.deepEqual(readKitFile(repo), { ...DEFAULTS, plan_model: 'fable', audit_model: 'fable' });
});

test('a name with no storable value is left out, and the next run does not rewrite the file for it', (t) =>
{
    const root = makeTempDir(t, 'no-agents');

    const first = completeKitSettings(root);
    const afterFirst = readText(root);
    fs.utimesSync(kitFilePath(root), 1_000, 1_000);
    const second = completeKitSettings(root);

    assert.deepEqual(first, { ok: true, changed: true });
    assert.deepEqual(readKitFile(root), { search_model: 'haiku', pass_score: 90, scoring: 'on', auto_run: 'off', auto_approve: 'off' });
    assert.deepEqual(second, { ok: true, changed: false });
    assert.equal(readText(root), afterFirst);
    assert.equal(fs.statSync(kitFilePath(root)).mtimeMs, 1_000_000);
});

test('a check completion says what it would do and writes nothing', (t) =>
{
    const repo = makeSettingsRepo(t);

    const result = completeKitSettings(repo, { check: true });

    assert.deepEqual(result, { ok: true, changed: true });
    assert.equal(fs.existsSync(kitFilePath(repo)), false);
});

const SHARED = { 'rules/alpha.md': '# Alpha\n' };
const REPO_FILES = { ...AGENTS, '.claude/kit/repo.json': { name: 'demo' } };
const cleanEnv = (variables = {}) => ({ PATH: process.env.PATH, ...variables });

test("a sync completes a repo's file with an empty environment: the sync's own KIT_* variables never reach it", (t) =>
{
    const kit = makeKit(t, SHARED);
    const repo = makeRepo(t, { ...REPO_FILES, [KIT_FILE]: { auto_run: 'on' } });

    const result = runNode(syncScript(kit), [repo], { env: cleanEnv({ KIT_PLAN_MODEL: 'fable', KIT_PASS_SCORE: '70', KIT_SCORING: 'off', KIT_AUTO_APPROVE: 'on' }) });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readKitFile(repo), { ...DEFAULTS, auto_run: 'on' });
    assert.deepEqual(Object.keys(readKitFile(repo)), ['auto_run', 'plan_model', 'audit_model', 'review_model', 'implement_model', 'search_model', 'pass_score', 'scoring', 'auto_approve']);
    assert.match(result.stdout, /update \.claude\/kit\/settings\.json/);
});

test('a sync writes the full file where a repo has none, leaves a complete one alone and reports nothing for it', (t) =>
{
    const kit = makeKit(t, SHARED);
    const repo = makeRepo(t, REPO_FILES);

    const first = runNode(syncScript(kit), [repo], { env: cleanEnv() });
    assert.match(first.stdout, /add \.claude\/kit\/settings\.json/);
    assert.deepEqual(readKitFile(repo), DEFAULTS);
    fs.utimesSync(kitFilePath(repo), 1_000, 1_000);

    const second = runNode(syncScript(kit), [repo], { env: cleanEnv() });

    assert.doesNotMatch(second.stdout, /settings\.json/);
    assert.equal(fs.statSync(kitFilePath(repo)).mtimeMs, 1_000_000);
});

test('a sync check names the completion and writes nothing; a file that does not parse is kept and named', (t) =>
{
    const kit = makeKit(t, SHARED);
    const repo = makeRepo(t, REPO_FILES);
    const broken = makeRepo(t, { ...REPO_FILES, [KIT_FILE]: '{ not json' });

    const checked = runNode(syncScript(kit), ['--check', repo], { env: cleanEnv() });
    const kept = runNode(syncScript(kit), [broken], { env: cleanEnv() });

    assert.equal(checked.status, 1);
    assert.match(checked.stdout, /add \.claude\/kit\/settings\.json/);
    assert.equal(fs.existsSync(kitFilePath(repo)), false);
    assert.match(kept.stdout, /kept \.claude\/kit\/settings\.json is not a JSON object - fix or delete it/);
    assert.equal(readText(broken), '{ not json');
});
