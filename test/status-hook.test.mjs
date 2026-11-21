// bin/status-hook.mjs, run as Claude Code runs a UserPromptSubmit hook: one JSON object on stdin, one on stdout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_FILE, KIT_FILE, REAL_KIT, agentFile, assertSavedInFile, cannotLockFolders, kitFileExists, makeHookRepo, makeTempDir, promptInput, readKitFile, runHook, runHookScript } from './support.mjs';

const contextOf = (output) => output.hookSpecificOutput.additionalContext;

test('with nothing set it shows the user one line with the defaults and gives Claude the same values, with no source on the line', (t) =>
{
    const { status, output } = runHook(makeHookRepo(t), promptInput());

    assert.equal(status, 0);
    assert.equal(output.systemMessage, 'kit: auto-run off | scoring on (pass 90) | auto-approve off | plan opus | audit opus | review opus | implement sonnet | search haiku');
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(
        contextOf(output),
        `kit status (.claude/kit/status-hook.mjs): auto_run=off (${KIT_FILE}); scoring=on (${KIT_FILE}); pass_score=90 (${KIT_FILE}); auto_approve=off (${KIT_FILE}); plan_model=opus (${KIT_FILE}); audit_model=opus (${KIT_FILE}); review_model=opus (${KIT_FILE}); implement_model=sonnet (${KIT_FILE}); search_model=haiku (${KIT_FILE});`,
    );
});

test("the settings variables never fill a file that lacks the names: the hook writes the defaults, and the line shows them with the file as the source", (t) =>
{
    const repo = makeHookRepo(t);
    const { output } = runHook(repo, promptInput(), {
        KIT_AUTO_RUN: 'on',
        KIT_SCORING: 'off',
        KIT_AUTO_APPROVE: 'on',
        KIT_PASS_SCORE: '95',
        KIT_PLAN_MODEL: 'fable',
        KIT_IMPLEMENT_MODEL: 'haiku',
        KIT_SEARCH_MODEL: 'sonnet',
    });

    assert.equal(output.systemMessage, 'kit: auto-run off | scoring on (pass 90) | auto-approve off | plan opus | audit opus | review opus | implement sonnet | search haiku');
    for (const part of [`auto_run=off (${KIT_FILE})`, `scoring=on (${KIT_FILE})`, `auto_approve=off (${KIT_FILE})`, `pass_score=90 (${KIT_FILE})`])
        assert.ok(contextOf(output).includes(part), `${part} missing from: ${contextOf(output)}`);
    assert.equal(contextOf(output).includes('KIT_'), false);
    assert.deepEqual(readKitFile(repo), DEFAULT_FILE);
});

test("scoring that KIT_SCORING turns on shows its pass score on the user's line, never the variable's name", (t) =>
{
    const { output } = runHook(makeHookRepo(t), promptInput(), { KIT_SCORING: 'on' });

    assert.match(output.systemMessage, /\| scoring on \(pass 90\) \|/);
    assert.ok(contextOf(output).includes(`scoring=on (${KIT_FILE})`));
});

test("the kit's file outranks the variables, names itself in Claude's values and shows no source on the user's line", (t) =>
{
    const repo = makeHookRepo(t, { [KIT_FILE]: { auto_run: 'on', scoring: 'off', auto_approve: 'on', plan_model: 'fable', pass_score: 80 } });

    const { output } = runHook(repo, promptInput(), { KIT_AUTO_RUN: 'off', KIT_SCORING: 'on', KIT_AUTO_APPROVE: 'off', KIT_PLAN_MODEL: 'haiku', KIT_PASS_SCORE: '95' });

    assert.equal(output.systemMessage, 'kit: auto-run on | scoring off | auto-approve on | plan fable | audit fable | review opus | implement sonnet | search haiku');
    for (const part of [`auto_run=on (${KIT_FILE});`, `scoring=off (${KIT_FILE});`, `auto_approve=on (${KIT_FILE});`, `plan_model=fable (${KIT_FILE});`, `pass_score=80 (${KIT_FILE});`])
        assert.ok(contextOf(output).includes(part), `${part} missing from: ${contextOf(output)}`);
});

test('a switch in the kit file that cannot be used falls through, and Claude is told why', (t) =>
{
    const repo = makeHookRepo(t, { [KIT_FILE]: { scoring: 'maybe' } });

    const { output } = runHook(repo, promptInput());

    assert.match(output.systemMessage, /\| scoring on \(pass 90\) \|/);
    assert.ok(contextOf(output).includes(`scoring=on (default - scoring="maybe" in ${KIT_FILE} is neither 'on' nor 'off');`), contextOf(output));
});

test("a value too long to show is cut, so the user's line and Claude's values stay under the 10,000 characters Claude Code allows a hook", (t) =>
{
    const outputLimit = 10000;
    const junk = 'x'.repeat(20000);
    const repo = makeHookRepo(t, { [KIT_FILE]: { scoring: junk }, '.claude/agents/audit-planner.md': agentFile(junk) });

    const { status, output } = runHook(repo, promptInput('auto run on'), { KIT_REVIEW_MODEL: junk });

    assert.equal(status, 0);
    assert.ok(output.systemMessage.length < outputLimit, `the user's line is ${output.systemMessage.length} characters`);
    assert.ok(contextOf(output).length < outputLimit, `Claude's values are ${contextOf(output).length} characters`);
    assert.ok(output.systemMessage.includes(`| plan ${'x'.repeat(400)}... |`), output.systemMessage.slice(0, 200));
    assert.ok(contextOf(output).endsWith(` saved: auto_run=on in ${KIT_FILE};`), contextOf(output).slice(-200));
});

test('a switch in the committed settings file is ignored here too, unless the kit file holds one', (t) =>
{
    const committed = { '.claude/settings.json': { env: { KIT_AUTO_RUN: 'on', KIT_SCORING: 'off' } } };

    const ignoredRepo = makeHookRepo(t, committed);
    const ignored = runHook(ignoredRepo, promptInput(), { KIT_AUTO_RUN: 'on' }).output;
    const kept = runHook(makeHookRepo(t, { ...committed, [KIT_FILE]: { auto_run: 'on' } }), promptInput(), { KIT_AUTO_RUN: 'on' }).output;

    assert.match(ignored.systemMessage, /^kit: auto-run off \|/);
    assert.equal(readKitFile(ignoredRepo).auto_run, 'off');
    assert.match(kept.systemMessage, /^kit: auto-run on \|/);
    assert.ok(contextOf(kept).includes(`auto_run=on (${KIT_FILE});`));
});

// Each request is sent against variables that say the opposite, so the line shows that the saved word won.
for (const [prompt, setting, value, shown] of [
    ['stop auto run', 'auto_run', 'off', 'auto-run off'],
    ['Stop scoring, just hand me the plan', 'scoring', 'off', 'scoring off'],
    ['turn off auto-run please', 'auto_run', 'off', 'auto-run off'],
    ['Disable the auto mode', 'auto_run', 'off', 'auto-run off'],
    ['turn auto run off', 'auto_run', 'off', 'auto-run off'],
    ['disable scoring', 'scoring', 'off', 'scoring off'],
    ['Please, enable scoring', 'scoring', 'on', 'scoring on (pass 90)'],
    ['scoring off', 'scoring', 'off', 'scoring off'],
    ['turn on auto run', 'auto_run', 'on', 'auto-run on'],
    ['Enable auto mode, then fix the lint', 'auto_run', 'on', 'auto-run on'],
    ['auto run on.', 'auto_run', 'on', 'auto-run on'],
    ['turn on scoring', 'scoring', 'on', 'scoring on (pass 90)'],
    ['Please enable scoring', 'scoring', 'on', 'scoring on (pass 90)'],
    ['switch scoring on', 'scoring', 'on', 'scoring on (pass 90)'],
    ['scoring off for good', 'scoring', 'off', 'scoring off'],
    ['turn off scoring for good', 'scoring', 'off', 'scoring off'],
    ['auto run on always', 'auto_run', 'on', 'auto-run on'],
    ['Scoring off, from now on.', 'scoring', 'off', 'scoring off'],
    ['STOP   SCORING', 'scoring', 'off', 'scoring off'],
    ['stop scoring\nthen hand me the plan', 'scoring', 'off', 'scoring off'],
    ['scoring off please', 'scoring', 'off', 'scoring off'],
    ['turn off scoring: no time', 'scoring', 'off', 'scoring off'],
    ['auto approve on', 'auto_approve', 'on', 'auto-approve on'],
    ['Enable auto-approve', 'auto_approve', 'on', 'auto-approve on'],
    ['turn on auto approval, then write the plan', 'auto_approve', 'on', 'auto-approve on'],
    ['turn auto approve on for good', 'auto_approve', 'on', 'auto-approve on'],
    ['stop auto approve', 'auto_approve', 'off', 'auto-approve off'],
    ['Please, disable the auto-approval.', 'auto_approve', 'off', 'auto-approve off'],
    ['autoapprove off', 'auto_approve', 'off', 'auto-approve off'],
])
{
    test(`a request that opens with '${prompt}' is saved in the kit's file and shown by the same request`, (t) =>
    {
        const repo = makeHookRepo(t);
        const opposite = value === 'on' ? 'off' : 'on';

        const { status, output } = runHook(repo, promptInput(prompt), { KIT_AUTO_RUN: opposite, KIT_SCORING: opposite, KIT_AUTO_APPROVE: opposite });

        assert.equal(status, 0);
        assertSavedInFile(repo, { [setting]: value });
        assert.ok(output.systemMessage.includes(shown), output.systemMessage);
        assert.ok(contextOf(output).includes(`${setting}=${value} (${KIT_FILE});`), contextOf(output));
        assert.ok(contextOf(output).endsWith(` saved: ${setting}=${value} in ${KIT_FILE};`), contextOf(output));
    });
}

for (const prompt of [
    'why did you stop scoring the plan?',
    'scoring on the last plan looked low',
    'auto run offline tests',
    'the scoring is off, why?',
    'scoring off for goodness sake',
    'start auto run tests',
    'enable auto-run logging in bin/sync.ts',
    'start autorun.sh in the background',
    'turn on auto mode in the camera settings docs',
    'disable scoring tests in test/status-hook.test.mjs',
    'disable the scoring rubric section',
    'stop scoring with haiku, use opus',
    'stop scoring.test.mjs failing',
    'stop scoring-model',
    'Enable auto mode and fix the lint',
    'Turn scoring off for this one',
    'enable auto run for this task only',
    'enable auto run?',
    'turn auto run on?',
    'auto run on: what does that do?',
    'auto run on, right?',
    'stop scoring?',
    'scoring off, why?',
    'scoring off.md',
    'stop\nscoring',
    'enable scoring model fable',
    'stop scoring?\nplease do',
    'auto approve the dependabot pull requests',
    'enable auto approve for this plan only',
    'auto approve on?',
    'why is auto approve off?',
    'disable plan approval',
    'plan approval on',
    'stop auto approve.yml from running',
])
{
    test(`'${prompt.replaceAll('\n', '\\n')}' is no switch: nothing is saved`, (t) =>
    {
        const repo = makeHookRepo(t);

        const { output } = runHook(repo, promptInput(prompt));

        assert.deepEqual(readKitFile(repo), DEFAULT_FILE);
        assert.equal(contextOf(output).includes('saved'), false);
    });
}

test('a hook that sits outside a repo\'s .claude/kit saves nothing, says so and still prints the line', (t) =>
{
    const outer = makeTempDir(t, 'outer');
    const scripts = path.join(outer, 'inner', 'bin');
    fs.mkdirSync(scripts, { recursive: true });
    for (const script of ['status-hook.mjs', 'kit-settings.mjs', 'constants.mjs', 'reply-budget.mjs'])
        fs.copyFileSync(path.join(REAL_KIT, 'bin', script), path.join(scripts, script));

    const { status, output } = runHookScript(path.join(scripts, 'status-hook.mjs'), promptInput('stop scoring'));

    assert.equal(status, 0);
    assert.equal(fs.existsSync(path.join(outer, '.claude')), false);
    assert.match(output.systemMessage, /^kit: auto-run off \| scoring on \(pass 90\)/);
    assert.match(contextOf(output), / not saved - .*\.claude\/kit\/settings\.mjs.*;$/);
});

for (const [label, breakIt] of [
    ['missing', (folder) => fs.rmSync(path.join(folder, 'kit-settings.mjs'))],
    ['broken', (folder) => fs.writeFileSync(path.join(folder, 'constants.mjs'), 'export const = ;')],
    ['loaded without what the hook calls', (folder) => fs.writeFileSync(path.join(folder, 'kit-settings.mjs'), 'export {};\n')],
])
{
    test(`a sibling module that is ${label} never blocks: the hook exits 0 and says so on stderr`, (t) =>
    {
        const repo = makeHookRepo(t);
        breakIt(path.join(repo, '.claude/kit'));

        const { status, stderr, stdout } = runHook(repo, promptInput('stop scoring'));

        assert.equal(status, 0);
        assert.notEqual(stderr.trim(), '');
        assert.equal(stdout, '');
    });
}

test("a save keeps the file's other keys", (t) =>
{
    const repo = makeHookRepo(t, { [KIT_FILE]: { search_model: 'sonnet', note: 'kept' } });

    runHook(repo, promptInput('stop scoring'));

    assert.deepEqual(readKitFile(repo), { ...DEFAULT_FILE, search_model: 'sonnet', note: 'kept', scoring: 'off' });
});

for (const prompt of ['auto run on', 'plan model fable'])
{
    test(`a file that is not a JSON object is left alone for '${prompt}': the line is still printed and Claude is told it was not saved`, (t) =>
    {
        const repo = makeHookRepo(t, { [KIT_FILE]: '{ not json' });

        const { status, stderr, output } = runHook(repo, promptInput(prompt));

        assert.equal(status, 0);
        assert.equal(fs.readFileSync(path.join(repo, KIT_FILE), 'utf8'), '{ not json');
        assert.match(contextOf(output), / not saved - .*fix or delete it;$/);
        assert.match(stderr, /fix or delete it/);
        assert.match(output.systemMessage, /^kit: auto-run off \| scoring on \(pass 90\)/);
    });

    test(`a file that cannot be written never blocks '${prompt}': exit 0, the line printed and Claude told`, (t) =>
    {
        if (cannotLockFolders()) return t.skip('a read-only folder does not stop root, and cannot be made on Windows');
        const repo = makeHookRepo(t);
        const kitFolder = path.join(repo, '.claude/kit');
        fs.chmodSync(kitFolder, 0o555);
        try
        {
            const { status, stderr, output } = runHook(repo, promptInput(prompt));

            assert.equal(status, 0);
            assert.equal(kitFileExists(repo), false);
            assert.match(contextOf(output), / not saved - .*cannot be written.*;$/);
            assert.match(stderr, /cannot be written/);
            assert.match(output.systemMessage, /^kit: auto-run off \| scoring on \(pass 90\)/);
        }
        finally { fs.chmodSync(kitFolder, 0o755); }
    });
}

test('the hook takes nothing from a scratchpad and creates nothing in one', (t) =>
{
    const scratchpad = makeTempDir(t, 'scratch');
    const repo = makeHookRepo(t);

    const { status, output } = runHook(repo, { ...promptInput('stop scoring'), scratchpad_dir: scratchpad });

    assert.equal(status, 0);
    assert.deepEqual(fs.readdirSync(scratchpad), []);
    assert.deepEqual(readKitFile(repo), { ...DEFAULT_FILE, scoring: 'off' });
    assert.equal(contextOf(output).includes('session'), false);
});

for (const [label, stdin] of [['not JSON', 'not json at all'], ['empty', ''], ['a JSON array', '[1, 2]']])
{
    test(`stdin that is ${label} never blocks the request, and the status line is still shown`, (t) =>
    {
        const { status, output } = runHook(makeHookRepo(t), stdin);

        assert.equal(status, 0);
        assert.match(output.systemMessage, /^kit: auto-run off \| scoring on \(pass 90\)/);
    });
}
