// bin/settings.mjs, run where it lives in a synced repo: .claude/kit/settings.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REAL_KIT, makeTempDir, runNode, writeFiles } from './support.mjs';

const agentFile = (model) => `---\nname: seat\nmodel: ${model}\n---\n\nBody.\n`;
const AGENTS = {
    '.claude/agents/plan-grader.md': agentFile('opus'),
    '.claude/agents/audit-planner.md': agentFile('opus'),
    '.claude/agents/audit-editor.md': agentFile('sonnet'),
};

function makeSettingsRepo(t, files = AGENTS)
{
    const repo = makeTempDir(t, 'settings');
    writeFiles(repo, files);
    fs.mkdirSync(path.join(repo, '.claude/kit'), { recursive: true });
    for (const script of ['settings.mjs', 'kit-settings.mjs', 'constants.mjs'])
        fs.copyFileSync(path.join(REAL_KIT, 'bin', script), path.join(repo, '.claude/kit', script));
    return repo;
}

// Runs with only the variables the test names, so a KIT_* value of the session running the suite cannot leak in.
function printSettings(repo, variables = {})
{
    const result = runNode(path.join(repo, '.claude/kit/settings.mjs'), [], { env: { PATH: process.env.PATH, ...variables } });
    const lines = Object.fromEntries(result.stdout.trimEnd().split('\n').map((line) =>
    {
        const separator = line.indexOf(': ');
        return [line.slice(0, separator), line.slice(separator + 2)];
    }));
    return { status: result.status, lines };
}

test('with no variable set it prints the defaults and the model each agent file names', (t) =>
{
    const { status, lines } = printSettings(makeSettingsRepo(t));

    assert.equal(status, 0);
    assert.deepEqual(lines, {
        pass_score: '90 (default)',
        plan_model: "opus (the audit-planner agent's own)",
        review_model: "opus (the plan-grader agent's own)",
        implement_model: "sonnet (the audit-editor agent's own)",
        search_model: 'haiku (default)',
        scoring: 'on (default)',
        auto_run: 'off (default)',
    });
});

test('each variable replaces its default and is named as the source', (t) =>
{
    const { lines } = printSettings(makeSettingsRepo(t), {
        KIT_PASS_SCORE: '95',
        KIT_PLAN_MODEL: 'fable',
        KIT_REVIEW_MODEL: 'opus',
        KIT_IMPLEMENT_MODEL: 'haiku',
        KIT_SEARCH_MODEL: 'sonnet',
        KIT_SCORING: 'off',
        KIT_AUTO_RUN: 'on',
    });

    assert.deepEqual(lines, {
        pass_score: '95 (KIT_PASS_SCORE)',
        plan_model: 'fable (KIT_PLAN_MODEL)',
        review_model: 'opus (KIT_REVIEW_MODEL)',
        implement_model: 'haiku (KIT_IMPLEMENT_MODEL)',
        search_model: 'sonnet (KIT_SEARCH_MODEL)',
        scoring: 'off (KIT_SCORING)',
        auto_run: 'on (KIT_AUTO_RUN)',
    });
});

for (const passScore of ['1', '100'])
{
    test(`a pass score of ${passScore} is inside the range and is used`, (t) =>
    {
        const { lines } = printSettings(makeSettingsRepo(t), { KIT_PASS_SCORE: passScore });

        assert.equal(lines.pass_score, `${passScore} (KIT_PASS_SCORE)`);
    });
}

for (const passScore of ['0', '101', '9.5', '-5', 'ninety'])
{
    test(`a pass score of '${passScore}' falls back to 90 and the line says why`, (t) =>
    {
        const { status, lines } = printSettings(makeSettingsRepo(t), { KIT_PASS_SCORE: passScore });

        assert.equal(status, 0);
        assert.equal(lines.pass_score, `90 (default - KIT_PASS_SCORE='${passScore}' is not a whole number from 1 to 100)`);
    });
}

test("a model a dispatch cannot take falls back to the agent's own and the line says why", (t) =>
{
    const { lines } = printSettings(makeSettingsRepo(t), { KIT_IMPLEMENT_MODEL: 'claude-sonnet-5-5' });

    assert.equal(
        lines.implement_model,
        "sonnet (the audit-editor agent's own - KIT_IMPLEMENT_MODEL='claude-sonnet-5-5' is not one of sonnet, opus, haiku, fable)",
    );
});

test('a search model a dispatch cannot take falls back to haiku, the one role with no agent file', (t) =>
{
    const { lines } = printSettings(makeSettingsRepo(t), { KIT_SEARCH_MODEL: 'claude-haiku-5-5' });

    assert.equal(lines.search_model, "haiku (default - KIT_SEARCH_MODEL='claude-haiku-5-5' is not one of sonnet, opus, haiku, fable)");
});

test('a blank value counts as not set, so blanking a variable returns an open session to the default', (t) =>
{
    const { lines } = printSettings(makeSettingsRepo(t), { KIT_PASS_SCORE: '', KIT_REVIEW_MODEL: '  ', KIT_AUTO_RUN: '' });

    assert.equal(lines.pass_score, '90 (default)');
    assert.equal(lines.review_model, "opus (the plan-grader agent's own)");
    assert.equal(lines.auto_run, 'off (default)');
});

test('a seat whose agent file is missing prints none, so the dispatch passes no model', (t) =>
{
    const { lines } = printSettings(makeSettingsRepo(t, { '.claude/agents/audit-planner.md': agentFile('opus') }));

    assert.equal(lines.implement_model, 'none (.claude/agents/audit-editor.md names no model - pass no model)');
    assert.equal(lines.plan_model, "opus (the audit-planner agent's own)");
});

test('a switch set back to its own default is accepted, so it can be turned off without deleting the line', (t) =>
{
    const { lines } = printSettings(makeSettingsRepo(t), { KIT_AUTO_RUN: 'off', KIT_SCORING: 'on' });

    assert.equal(lines.auto_run, 'off (KIT_AUTO_RUN)');
    assert.equal(lines.scoring, 'on (KIT_SCORING)');
});

test("a switch value that is neither on nor off keeps the safeguard and the line says why", (t) =>
{
    const { lines } = printSettings(makeSettingsRepo(t), { KIT_AUTO_RUN: 'true', KIT_SCORING: 'no' });

    assert.equal(lines.auto_run, "off (default - KIT_AUTO_RUN='true' is neither 'on' nor 'off')");
    assert.equal(lines.scoring, "on (default - KIT_SCORING='no' is neither 'on' nor 'off')");
});

test('a switch found in the committed settings file is ignored, while a pass score there is used', (t) =>
{
    const repo = makeSettingsRepo(t, {
        ...AGENTS,
        '.claude/settings.json': { env: { KIT_AUTO_RUN: 'on', KIT_SCORING: 'off', KIT_PASS_SCORE: '97' } },
    });

    const { lines } = printSettings(repo, { KIT_AUTO_RUN: 'on', KIT_SCORING: 'off', KIT_PASS_SCORE: '97' });

    assert.equal(lines.auto_run, 'off (default - KIT_AUTO_RUN in .claude/settings.json is ignored: set it in .claude/settings.local.json)');
    assert.equal(lines.scoring, 'on (default - KIT_SCORING in .claude/settings.json is ignored: set it in .claude/settings.local.json)');
    assert.equal(lines.pass_score, '97 (KIT_PASS_SCORE)');
});

test('a committed settings file that is not valid JSON does not stop the script', (t) =>
{
    const repo = makeSettingsRepo(t, { ...AGENTS, '.claude/settings.json': '{ not json' });

    const { status, lines } = printSettings(repo, { KIT_AUTO_RUN: 'on' });

    assert.equal(status, 0);
    assert.equal(lines.auto_run, 'on (KIT_AUTO_RUN)');
});
