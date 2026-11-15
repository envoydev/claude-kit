// bin/status-hook.mjs, run as Claude Code runs a UserPromptSubmit hook: one JSON object on stdin, one on stdout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REAL_KIT, makeTempDir, writeFiles } from './support.mjs';

const agentFile = (model) => `---\nname: seat\nmodel: ${model}\n---\n`;

function makeHookRepo(t, files = {})
{
    const repo = makeTempDir(t, 'hook');
    writeFiles(repo, {
        '.claude/agents/plan-grader.md': agentFile('opus'),
        '.claude/agents/audit-planner.md': agentFile('opus'),
        '.claude/agents/audit-editor.md': agentFile('sonnet'),
        ...files,
    });
    fs.mkdirSync(path.join(repo, '.claude/kit'), { recursive: true });
    for (const script of ['status-hook.mjs', 'kit-settings.mjs', 'constants.mjs'])
        fs.copyFileSync(path.join(REAL_KIT, 'bin', script), path.join(repo, '.claude/kit', script));
    return repo;
}

// Feeds the hook its stdin and returns what it printed, parsed. Only the named variables are in its environment.
function runHook(repo, hookInput, variables = {})
{
    const result = spawnSync(process.execPath, [path.join(repo, '.claude/kit/status-hook.mjs')], {
        input: typeof hookInput === 'string' ? hookInput : JSON.stringify(hookInput),
        env: { PATH: process.env.PATH, ...variables },
        encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout, output: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

const promptInput = (scratchpadDir, prompt = 'fix the lint') => ({
    session_id: 'session-1',
    hook_event_name: 'UserPromptSubmit',
    prompt,
    ...(scratchpadDir ? { scratchpad_dir: scratchpadDir } : {}),
});

test('with nothing set it shows the user one line with the defaults and gives Claude the same values', (t) =>
{
    const scratchpad = makeTempDir(t, 'scratch');

    const { status, output } = runHook(makeHookRepo(t), promptInput(scratchpad));

    assert.equal(status, 0);
    assert.equal(output.systemMessage, 'kit: auto-run off | scoring on (pass 90) | plan opus | review opus | implement sonnet | search haiku');
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const context = output.hookSpecificOutput.additionalContext;
    for (const part of ['auto_run=off (default)', 'scoring=on (default)', 'pass_score=90 (default)', 'plan_model=opus', 'review_model=opus', 'implement_model=sonnet', 'search_model=haiku (default)'])
        assert.ok(context.includes(part), `${part} missing from: ${context}`);
    assert.ok(context.includes(path.join(scratchpad, 'kit-session.md')), context);
});

test('the settings variables change the line and are named as the source', (t) =>
{
    const { output } = runHook(makeHookRepo(t), promptInput(makeTempDir(t, 'scratch')), {
        KIT_AUTO_RUN: 'on',
        KIT_SCORING: 'off',
        KIT_PASS_SCORE: '95',
        KIT_PLAN_MODEL: 'fable',
        KIT_IMPLEMENT_MODEL: 'haiku',
        KIT_SEARCH_MODEL: 'sonnet',
    });

    assert.equal(
        output.systemMessage,
        'kit: auto-run on (KIT_AUTO_RUN) | scoring off (KIT_SCORING) | plan fable | review opus | implement haiku | search sonnet',
    );
    assert.ok(output.hookSpecificOutput.additionalContext.includes('pass_score=95 (KIT_PASS_SCORE)'));
});

test("a switch written in this session's file outranks the settings", (t) =>
{
    const scratchpad = makeTempDir(t, 'scratch');
    writeFiles(scratchpad, { 'kit-session.md': "Auto-run: on - 'auto mode, I am away'\nScoring: off - 2026-11-15\n" });

    const { output } = runHook(makeHookRepo(t), promptInput(scratchpad));

    assert.equal(output.systemMessage, 'kit: auto-run on (this session) | scoring off (this session) | plan opus | review opus | implement sonnet | search haiku');
    assert.ok(output.hookSpecificOutput.additionalContext.includes('auto_run=on (this session)'));
});

test("the last line of a kind in the session file wins, so a standing default the user stopped stays off", (t) =>
{
    const scratchpad = makeTempDir(t, 'scratch');
    writeFiles(scratchpad, { 'kit-session.md': 'Auto-run: on - KIT_AUTO_RUN in the settings\nAuto-run: off - 2026-11-15\n' });

    const { output } = runHook(makeHookRepo(t), promptInput(scratchpad), { KIT_AUTO_RUN: 'on' });

    assert.match(output.systemMessage, /^kit: auto-run off \(this session\) \|/);
});

test('a switch this session turned on outranks settings that say off, and one it turned off outranks on', (t) =>
{
    const scratchpad = makeTempDir(t, 'scratch');
    writeFiles(scratchpad, { 'kit-session.md': 'Scoring: on - 2026-11-15\nAuto-run: off - 2026-11-15\n' });

    const { output } = runHook(makeHookRepo(t), promptInput(scratchpad), { KIT_SCORING: 'off', KIT_AUTO_RUN: 'on' });

    assert.match(output.systemMessage, /^kit: auto-run off \(this session\) \| scoring on \(this session\) \|/);
    assert.ok(output.hookSpecificOutput.additionalContext.includes('scoring=on (this session)'));
});

// Each request is sent against settings that say the opposite, so the line shows that the session's word won.
for (const [prompt, line, shown] of [
    ['stop auto run', 'Auto-run: off', 'auto-run off (this session)'],
    ['Stop scoring, just hand me the plan', 'Scoring: off', 'scoring off (this session)'],
    ['turn off auto-run please', 'Auto-run: off', 'auto-run off (this session)'],
    ['Disable the auto mode', 'Auto-run: off', 'auto-run off (this session)'],
    ['turn auto run off', 'Auto-run: off', 'auto-run off (this session)'],
    ['disable scoring', 'Scoring: off', 'scoring off (this session)'],
    ['Turn scoring off for this one', 'Scoring: off', 'scoring off (this session)'],
    ['scoring off', 'Scoring: off', 'scoring off (this session)'],
    ['turn on auto run', 'Auto-run: on', 'auto-run on (this session)'],
    ['Enable auto mode and fix the lint', 'Auto-run: on', 'auto-run on (this session)'],
    ['auto run on.', 'Auto-run: on', 'auto-run on (this session)'],
    ['turn on scoring', 'Scoring: on', 'scoring on (this session)'],
    ['Please enable scoring', 'Scoring: on', 'scoring on (this session)'],
    ['switch scoring on', 'Scoring: on', 'scoring on (this session)'],
])
{
    test(`a request that opens with '${prompt}' is recorded in the session file and outranks the settings at once`, (t) =>
    {
        const scratchpad = makeTempDir(t, 'scratch');
        const opposite = line.endsWith('on') ? 'off' : 'on';

        const { output } = runHook(makeHookRepo(t), promptInput(scratchpad, prompt), { KIT_AUTO_RUN: opposite, KIT_SCORING: opposite });

        const recorded = fs.readFileSync(path.join(scratchpad, 'kit-session.md'), 'utf8').trimEnd();
        assert.match(recorded, /^[A-Z][a-z-]+: (on|off) - \d{4}-\d{2}-\d{2}$/);
        assert.ok(recorded.startsWith(`${line} - `), recorded);
        assert.ok(output.systemMessage.includes(shown), output.systemMessage);
    });
}

for (const prompt of ['why did you stop scoring the plan?', 'scoring on the last plan looked low', 'auto run offline tests', 'the scoring is off, why?'])
{
    test(`'${prompt}' is no switch: nothing is recorded`, (t) =>
    {
        const scratchpad = makeTempDir(t, 'scratch');

        runHook(makeHookRepo(t), promptInput(scratchpad, prompt));

        assert.equal(fs.existsSync(path.join(scratchpad, 'kit-session.md')), false);
    });
}

test('with no scratchpad named it still reports the settings and tells Claude the session file is unknown', (t) =>
{
    const { status, output } = runHook(makeHookRepo(t), promptInput(null, 'stop scoring'));

    assert.equal(status, 0);
    assert.match(output.systemMessage, /scoring on \(pass 90\)/);
    assert.ok(output.hookSpecificOutput.additionalContext.includes('session file=unknown'));
});

test('a switch in the committed settings file is ignored here too', (t) =>
{
    const repo = makeHookRepo(t, { '.claude/settings.json': { env: { KIT_AUTO_RUN: 'on' } } });

    const { output } = runHook(repo, promptInput(makeTempDir(t, 'scratch')), { KIT_AUTO_RUN: 'on' });

    assert.match(output.systemMessage, /^kit: auto-run off \|/);
    assert.ok(output.hookSpecificOutput.additionalContext.includes('KIT_AUTO_RUN in .claude/settings.json is ignored'));
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
