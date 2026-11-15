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
    for (const script of ['status-hook.mjs', 'kit-settings.mjs'])
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
    assert.equal(output.systemMessage, 'kit: auto-run off | scoring on (pass 90) | plan opus | review opus | implement sonnet');
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const context = output.hookSpecificOutput.additionalContext;
    for (const part of ['auto_run=off (default)', 'scoring=on (default)', 'pass_score=90 (default)', 'plan_model=opus', 'review_model=opus', 'implement_model=sonnet'])
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
    });

    assert.equal(
        output.systemMessage,
        'kit: auto-run on (KIT_AUTO_RUN) | scoring off (KIT_SCORING) | plan fable | review opus | implement haiku',
    );
    assert.ok(output.hookSpecificOutput.additionalContext.includes('pass_score=95 (KIT_PASS_SCORE)'));
});

test("a switch written in this session's file outranks the settings", (t) =>
{
    const scratchpad = makeTempDir(t, 'scratch');
    writeFiles(scratchpad, { 'kit-session.md': "Auto-run: on - 'auto mode, I am away'\nScoring: off - 2026-11-15\n" });

    const { output } = runHook(makeHookRepo(t), promptInput(scratchpad));

    assert.equal(output.systemMessage, 'kit: auto-run on (this session) | scoring off (this session) | plan opus | review opus | implement sonnet');
    assert.ok(output.hookSpecificOutput.additionalContext.includes('auto_run=on (this session)'));
});

test("the last line of a kind in the session file wins, so a standing default the user stopped stays off", (t) =>
{
    const scratchpad = makeTempDir(t, 'scratch');
    writeFiles(scratchpad, { 'kit-session.md': 'Auto-run: on - KIT_AUTO_RUN in the settings\nAuto-run: off - 2026-11-15\n' });

    const { output } = runHook(makeHookRepo(t), promptInput(scratchpad), { KIT_AUTO_RUN: 'on' });

    assert.match(output.systemMessage, /^kit: auto-run off \(this session\) \|/);
});

for (const [prompt, line, shown] of [
    ['stop auto run', /^Auto-run: off - \d{4}-\d{2}-\d{2}$/m, /auto-run off \(this session\)/],
    ['Stop scoring, just hand me the plan', /^Scoring: off - \d{4}-\d{2}-\d{2}$/m, /scoring off \(this session\)/],
])
{
    test(`a request starting with '${prompt.slice(0, 13).toLowerCase()}' is recorded in the session file and shown at once`, (t) =>
    {
        const scratchpad = makeTempDir(t, 'scratch');
        writeFiles(scratchpad, { 'kit-session.md': "Auto-run: on - 'auto mode'\n" });

        const { output } = runHook(makeHookRepo(t), promptInput(scratchpad, prompt));

        assert.match(fs.readFileSync(path.join(scratchpad, 'kit-session.md'), 'utf8'), line);
        assert.match(output.systemMessage, shown);
    });
}

test('a request that only mentions the words mid-sentence records nothing', (t) =>
{
    const scratchpad = makeTempDir(t, 'scratch');

    runHook(makeHookRepo(t), promptInput(scratchpad, 'why did you stop scoring the plan?'));

    assert.equal(fs.existsSync(path.join(scratchpad, 'kit-session.md')), false);
});

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
