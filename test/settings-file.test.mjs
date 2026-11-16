// The kit's own settings file, .claude/kit/settings.json, read by bin/kit-settings.mjs and written by bin/settings.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setKitSetting, setKitSettings, unsetKitSetting } from '../bin/kit-settings.mjs';
import { AGENTS, KIT_FILE, REAL_KIT, cannotLockFolders, makeSettingsRepo, makeTempDir, printSettings, runNode, runSettings, writeFiles } from './support.mjs';

const kitFilePath = (repo) => path.join(repo, KIT_FILE);
const MODEL_REASON = 'is not one of sonnet, opus, haiku, fable';
const SCORE_REASON = 'is not a whole number from 1 to 100';
const SWITCH_REASON = "is neither 'on' nor 'off'";
const COMMITTED_IGNORED = 'is ignored: set it in .claude/settings.local.json';

test('a value in the kit file outranks its variable and names the file as its origin', (t) =>
{
    const repo = makeSettingsRepo(t, { ...AGENTS, [KIT_FILE]: { plan_model: 'fable', pass_score: 95, search_model: 'opus' } });

    const { lines } = printSettings(repo, { KIT_PLAN_MODEL: 'haiku', KIT_PASS_SCORE: '80', KIT_SEARCH_MODEL: 'sonnet' });

    assert.equal(lines.plan_model, `fable (${KIT_FILE})`);
    assert.equal(lines.pass_score, `95 (${KIT_FILE})`);
    assert.equal(lines.search_model, `opus (${KIT_FILE})`);
});

test('a pass score written as a string of digits in the kit file counts', (t) =>
{
    const { lines } = printSettings(makeSettingsRepo(t, { ...AGENTS, [KIT_FILE]: { pass_score: '96' } }));

    assert.equal(lines.pass_score, `96 (${KIT_FILE})`);
});

test('a variable still counts for a name the kit file does not hold', (t) =>
{
    const repo = makeSettingsRepo(t, { ...AGENTS, [KIT_FILE]: { plan_model: 'fable' } });

    const { lines } = printSettings(repo, { KIT_REVIEW_MODEL: 'haiku' });

    assert.equal(lines.review_model, 'haiku (KIT_REVIEW_MODEL)');
    assert.equal(lines.implement_model, "sonnet (the audit-editor agent's own)");
});

test('the kit file may switch scoring and auto-run, and outranks their variables', (t) =>
{
    const repo = makeSettingsRepo(t, { ...AGENTS, [KIT_FILE]: { scoring: 'off', auto_run: 'on' } });

    const { lines } = printSettings(repo, { KIT_SCORING: 'on', KIT_AUTO_RUN: 'off' });

    assert.equal(lines.scoring, `off (${KIT_FILE})`);
    assert.equal(lines.auto_run, `on (${KIT_FILE})`);
});

test('the kit file outranks a variable the committed settings file names, which is otherwise ignored', (t) =>
{
    const repo = makeSettingsRepo(t, {
        ...AGENTS,
        '.claude/settings.json': { env: { KIT_SCORING: 'off', KIT_AUTO_RUN: 'on' } },
        [KIT_FILE]: { scoring: 'off' },
    });

    const { lines } = printSettings(repo, { KIT_SCORING: 'off', KIT_AUTO_RUN: 'on' });

    assert.equal(lines.scoring, `off (${KIT_FILE})`);
    assert.equal(lines.auto_run, `off (default - KIT_AUTO_RUN in .claude/settings.json ${COMMITTED_IGNORED})`);
});

for (const [name, fileValue, variables, expected] of [
    ['plan_model', 'gpt', {}, `opus (the audit-planner agent's own - plan_model="gpt" in ${KIT_FILE} ${MODEL_REASON})`],
    ['review_model', 7, {}, `opus (the plan-grader agent's own - review_model=7 in ${KIT_FILE} ${MODEL_REASON})`],
    ['implement_model', 'Opus', { KIT_IMPLEMENT_MODEL: 'haiku' }, `haiku (KIT_IMPLEMENT_MODEL - implement_model="Opus" in ${KIT_FILE} ${MODEL_REASON})`],
    ['search_model', 'gpt', {}, `haiku (default - search_model="gpt" in ${KIT_FILE} ${MODEL_REASON})`],
    ['search_model', 'gpt', { KIT_SEARCH_MODEL: 'sonnet' }, `sonnet (KIT_SEARCH_MODEL - search_model="gpt" in ${KIT_FILE} ${MODEL_REASON})`],
    ['pass_score', 0, {}, `90 (default - pass_score=0 in ${KIT_FILE} ${SCORE_REASON})`],
    ['pass_score', 101, {}, `90 (default - pass_score=101 in ${KIT_FILE} ${SCORE_REASON})`],
    ['pass_score', 9.5, {}, `90 (default - pass_score=9.5 in ${KIT_FILE} ${SCORE_REASON})`],
    ['pass_score', [95], {}, `90 (default - pass_score=[95] in ${KIT_FILE} ${SCORE_REASON})`],
    ['pass_score', true, {}, `90 (default - pass_score=true in ${KIT_FILE} ${SCORE_REASON})`],
    ['pass_score', 'ninety', { KIT_PASS_SCORE: '85' }, `85 (KIT_PASS_SCORE - pass_score="ninety" in ${KIT_FILE} ${SCORE_REASON})`],
    ['scoring', 'maybe', {}, `on (default - scoring="maybe" in ${KIT_FILE} ${SWITCH_REASON})`],
    ['scoring', true, { KIT_SCORING: 'off' }, `off (KIT_SCORING - scoring=true in ${KIT_FILE} ${SWITCH_REASON})`],
    ['auto_run', 'yes', {}, `off (default - auto_run="yes" in ${KIT_FILE} ${SWITCH_REASON})`],
])
{
    test(`${name}='${fileValue}' in the kit file is unusable: the result falls through and the line says why`, (t) =>
    {
        const { status, lines } = printSettings(makeSettingsRepo(t, { ...AGENTS, [KIT_FILE]: { [name]: fileValue } }), variables);

        assert.equal(status, 0);
        assert.equal(lines[name], expected);
    });
}

test('an unusable switch in the kit file falls through to the ignored committed variable and says both', (t) =>
{
    const repo = makeSettingsRepo(t, { ...AGENTS, '.claude/settings.json': { env: { KIT_SCORING: 'off' } }, [KIT_FILE]: { scoring: 'maybe' } });

    const { lines } = printSettings(repo);

    assert.equal(lines.scoring, `on (default - KIT_SCORING in .claude/settings.json ${COMMITTED_IGNORED} - scoring="maybe" in ${KIT_FILE} ${SWITCH_REASON})`);
});

for (const [label, content] of [['not JSON', '{ not json'], ['a JSON array', '[1, 2]'], ['a JSON string', '"fable"'], ['empty', '']])
{
    test(`a kit file that is ${label} counts as empty and is not reported`, (t) =>
    {
        const { status, lines } = printSettings(makeSettingsRepo(t, { ...AGENTS, [KIT_FILE]: content }), { KIT_PLAN_MODEL: 'haiku' });

        assert.equal(status, 0);
        assert.equal(lines.plan_model, 'haiku (KIT_PLAN_MODEL)');
        assert.equal(lines.pass_score, '90 (default)');
    });
}

test('set writes the value, prints where it went and outranks the variable at once', (t) =>
{
    const repo = makeSettingsRepo(t);

    const result = runSettings(repo, ['set', 'plan_model', 'fable'], { KIT_PLAN_MODEL: 'haiku' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `plan_model: fable (${KIT_FILE})\n`);
    assert.equal(fs.readFileSync(kitFilePath(repo), 'utf8'), `${JSON.stringify({ plan_model: 'fable' }, null, 2)}\n`);
    assert.equal(printSettings(repo, { KIT_PLAN_MODEL: 'haiku' }).lines.plan_model, `fable (${KIT_FILE})`);
});

for (const [name, value, variables] of [['auto_run', 'on', {}], ['scoring', 'off', {}], ['auto_run', 'off', { KIT_AUTO_RUN: 'on' }]])
{
    test(`set ${name} ${value} writes the switch and prints it, whatever the variable says`, (t) =>
    {
        const repo = makeSettingsRepo(t);

        const result = runSettings(repo, ['set', name, value], variables);

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `${name}: ${value} (${KIT_FILE})\n`);
        assert.deepEqual(JSON.parse(fs.readFileSync(kitFilePath(repo), 'utf8')), { [name]: value });
    });
}

test('set keeps every other key already in the file, unknown ones too, and stores the score as a number', (t) =>
{
    const repo = makeSettingsRepo(t, { ...AGENTS, [KIT_FILE]: { search_model: 'sonnet', note: { kept: true } } });

    const result = runSettings(repo, ['set', 'pass_score', '95']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `pass_score: 95 (${KIT_FILE})\n`);
    assert.deepEqual(JSON.parse(fs.readFileSync(kitFilePath(repo), 'utf8')), { search_model: 'sonnet', note: { kept: true }, pass_score: 95 });
});

for (const [label, args, existing] of [
    ['a name the file may not hold', ['set', 'plan_modle', 'fable'], '{"search_model":"opus"}'],
    ['a model the dispatch cannot take', ['set', 'plan_model', 'gpt'], '{"search_model":"opus"}'],
    ['a switch that is neither on nor off', ['set', 'scoring', 'maybe'], '{"search_model":"opus"}'],
    ['an auto-run that is not on or off', ['set', 'auto_run', 'true'], '{"search_model":"opus"}'],
    ['a score above 100', ['set', 'pass_score', '101'], '{"search_model":"opus"}'],
    ['a score that is not a number', ['set', 'pass_score', 'ninety'], '{"search_model":"opus"}'],
    ['a file that is a JSON array', ['set', 'plan_model', 'fable'], '[1, 2]'],
    ['a file that is not JSON', ['set', 'auto_run', 'on'], '{ not json'],
    ['a name to unset the file may not hold', ['unset', 'plan_modle'], '{"search_model":"opus"}'],
    ['an unset onto a file that is a JSON array', ['unset', 'plan_model'], '[1, 2]'],
])
{
    test(`${label} exits 1 with the reason on stderr and leaves the file as it was`, (t) =>
    {
        const repo = makeSettingsRepo(t, { ...AGENTS, [KIT_FILE]: existing });

        const result = runSettings(repo, args);

        assert.equal(result.status, 1);
        assert.notEqual(result.stderr.trim(), '');
        assert.equal(result.stdout, '');
        assert.equal(fs.readFileSync(kitFilePath(repo), 'utf8'), existing);
    });
}

test('a set onto a file that is not an object says to fix or delete it', (t) =>
{
    const repo = makeSettingsRepo(t, { ...AGENTS, [KIT_FILE]: '[1, 2]' });

    const result = runSettings(repo, ['set', 'plan_model', 'fable']);

    assert.match(result.stderr, /fix or delete/);
});

test('a failed set with no file creates none', (t) =>
{
    const repo = makeSettingsRepo(t);

    const result = runSettings(repo, ['set', 'scoring', 'maybe']);

    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(kitFilePath(repo)), false);
});

test('unset removes the name and prints the line it falls back to', (t) =>
{
    const repo = makeSettingsRepo(t, { ...AGENTS, [KIT_FILE]: { plan_model: 'fable', search_model: 'sonnet' } });

    const result = runSettings(repo, ['unset', 'plan_model']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "plan_model: opus (the audit-planner agent's own)\n");
    assert.deepEqual(JSON.parse(fs.readFileSync(kitFilePath(repo), 'utf8')), { search_model: 'sonnet' });
});

test('unset auto_run removes the switch and prints what it falls back to', (t) =>
{
    const repo = makeSettingsRepo(t, { ...AGENTS, [KIT_FILE]: { auto_run: 'on', scoring: 'off' } });

    const result = runSettings(repo, ['unset', 'auto_run'], { KIT_AUTO_RUN: 'on' });

    assert.equal(result.stdout, 'auto_run: on (KIT_AUTO_RUN)\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(kitFilePath(repo), 'utf8')), { scoring: 'off' });
});

test('unset leaves {} when it removes the last name', (t) =>
{
    const repo = makeSettingsRepo(t, { ...AGENTS, [KIT_FILE]: { plan_model: 'fable' } });

    const result = runSettings(repo, ['unset', 'plan_model'], { KIT_PLAN_MODEL: 'haiku' });

    assert.equal(result.stdout, 'plan_model: haiku (KIT_PLAN_MODEL)\n');
    assert.equal(fs.readFileSync(kitFilePath(repo), 'utf8'), '{}\n');
});

test('unset of a name that is not in the file succeeds and writes nothing', (t) =>
{
    const repo = makeSettingsRepo(t);

    const result = runSettings(repo, ['unset', 'pass_score']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'pass_score: 90 (default)\n');
    assert.equal(fs.existsSync(kitFilePath(repo)), false);
});

for (const args of [['frobnicate'], ['set'], ['set', 'plan_model'], ['set', 'plan_model', 'fable', 'now'], ['unset'], ['unset', 'plan_model', 'search_model']])
{
    test(`'${args.join(' ')}' exits 1 with the usage on stderr`, (t) =>
    {
        const result = runSettings(makeSettingsRepo(t), args);

        assert.equal(result.status, 1);
        assert.match(result.stderr, /^usage: /);
        assert.equal(result.stdout, '');
    });
}

test('setKitSetting creates the folder the file lives in when it is missing', (t) =>
{
    const root = makeTempDir(t, 'bare');

    const result = setKitSetting(root, 'search_model', 'opus');

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(kitFilePath(root), 'utf8')), { search_model: 'opus' });
});

test('setKitSetting returns the failure when the file cannot be written, and unsetKitSetting does too', (t) =>
{
    if (cannotLockFolders()) return t.skip('a read-only folder does not stop root, and cannot be made on Windows');
    const emptyFolderRoot = makeTempDir(t, 'bare');
    const emptyFolder = path.join(emptyFolderRoot, '.claude/kit');
    fs.mkdirSync(emptyFolder, { recursive: true });
    fs.chmodSync(emptyFolder, 0o555);
    const filledFolderRoot = makeTempDir(t, 'bare');
    writeFiles(filledFolderRoot, { [KIT_FILE]: { plan_model: 'fable' } });
    const filledFolder = path.join(filledFolderRoot, '.claude/kit');
    fs.chmodSync(filledFolder, 0o555);
    try
    {
        const failedSet = setKitSetting(emptyFolderRoot, 'search_model', 'opus');
        const failedUnset = unsetKitSetting(filledFolderRoot, 'plan_model');

        assert.equal(failedSet.ok, false);
        assert.match(failedSet.error, /cannot be written/);
        assert.equal(failedUnset.ok, false);
        assert.match(failedUnset.error, /cannot be written/);
        assert.deepEqual(fs.readdirSync(emptyFolder), []);
        assert.deepEqual(fs.readdirSync(filledFolder), ['settings.json']);
    }
    finally
    {
        fs.chmodSync(emptyFolder, 0o755);
        fs.chmodSync(filledFolder, 0o755);
    }
});

test('a write leaves no temporary file beside the settings file', (t) =>
{
    const root = makeTempDir(t, 'bare');

    setKitSetting(root, 'plan_model', 'fable');
    setKitSetting(root, 'scoring', 'off');

    assert.deepEqual(fs.readdirSync(path.join(root, '.claude/kit')), ['settings.json']);
});

test('setKitSettings writes every pair at once, or none when one of them is unusable', (t) =>
{
    const root = makeTempDir(t, 'bare');
    const written = setKitSettings(root, [{ setting: 'plan_model', value: 'fable' }, { setting: 'review_model', value: 'opus' }]);
    const before = fs.readFileSync(kitFilePath(root), 'utf8');

    const refused = setKitSettings(root, [{ setting: 'plan_model', value: 'haiku' }, { setting: 'review_model', value: 'gpt' }]);

    assert.deepEqual(written, { ok: true });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /review_model="gpt"/);
    assert.equal(fs.readFileSync(kitFilePath(root), 'utf8'), before);
    assert.deepEqual(JSON.parse(before), { plan_model: 'fable', review_model: 'opus' });
});

test('setKitSettings writes nothing, and creates no file, when the first pair is the unusable one', (t) =>
{
    const root = makeTempDir(t, 'bare');

    const refused = setKitSettings(root, [{ setting: 'plan_model', value: 'gpt' }, { setting: 'review_model', value: 'opus' }]);

    assert.equal(refused.ok, false);
    assert.equal(fs.existsSync(kitFilePath(root)), false);
});

test('a kit file that cannot be read is reported by a set, and treated as empty by a print', (t) =>
{
    const repo = makeSettingsRepo(t, AGENTS);
    fs.mkdirSync(kitFilePath(repo), { recursive: true });

    const set = runSettings(repo, ['set', 'plan_model', 'fable']);
    const printed = printSettings(repo);

    assert.equal(set.status, 1);
    assert.match(set.stderr, /cannot be read/);
    assert.equal(printed.status, 0);
    assert.equal(printed.lines.plan_model, "opus (the audit-planner agent's own)");
});

test('set and unset are refused where the script does not sit in .claude/kit, so no file lands outside a repo', (t) =>
{
    const outer = makeTempDir(t, 'outer');
    const scripts = path.join(outer, 'inner', 'bin');
    fs.mkdirSync(scripts, { recursive: true });
    for (const script of ['settings.mjs', 'kit-settings.mjs', 'constants.mjs'])
        fs.copyFileSync(path.join(REAL_KIT, 'bin', script), path.join(scripts, script));
    const run = (args) => runNode(path.join(scripts, 'settings.mjs'), args, { env: { PATH: process.env.PATH } });

    const refusedSet = run(['set', 'plan_model', 'fable']);
    const refusedUnset = run(['unset', 'plan_model']);
    const printed = run([]);

    for (const refused of [refusedSet, refusedUnset])
    {
        assert.equal(refused.status, 1);
        assert.match(refused.stderr, /\.claude\/kit\/settings\.mjs/);
        assert.equal(refused.stdout, '');
    }
    assert.equal(fs.existsSync(path.join(outer, '.claude')), false);
    assert.equal(printed.status, 0, printed.stderr);
    assert.match(printed.stdout, /^pass_score: 90 \(default\)/);
});
