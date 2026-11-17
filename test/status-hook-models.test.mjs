// bin/status-hook.mjs: the model choices a request makes, saved in the kit's own settings file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { KIT_FILE, kitFileExists, makeHookRepo, promptInput, readKitFile, runHook } from './support.mjs';

const MODEL_VARIABLES = ['KIT_PLAN_MODEL', 'KIT_AUDIT_MODEL', 'KIT_REVIEW_MODEL', 'KIT_IMPLEMENT_MODEL', 'KIT_SEARCH_MODEL'];
const LABELS = { plan_model: 'plan', audit_model: 'audit', review_model: 'review', implement_model: 'implement', search_model: 'search' };
const otherModel = (model) => (model === 'sonnet' ? 'opus' : 'sonnet');
const contextOf = (output) => output.hookSpecificOutput.additionalContext;
const showable = (prompt) => prompt.replaceAll('\n', '\\n').replaceAll('\t', '\\t');

// Each request is sent against variables that name another model for every role, so the line shows the saved word won.
for (const [prompt, saved] of [
    ['plan model fable', { plan_model: 'fable' }],
    ['plan model and scoring models fable', { plan_model: 'fable', review_model: 'fable' }],
    ['Plan model: opus', { plan_model: 'opus' }],
    ['set the review model to sonnet', { review_model: 'sonnet' }],
    ['Please use the implement model haiku', { implement_model: 'haiku' }],
    ['Please, use the implement model haiku.', { implement_model: 'haiku' }],
    ['plan, review and implement models = opus', { plan_model: 'opus', review_model: 'opus', implement_model: 'opus' }],
    ['search model is sonnet.', { search_model: 'sonnet' }],
    ['grader model fable', { review_model: 'fable' }],
    ['editor model on haiku', { implement_model: 'haiku' }],
    ['scoring model fable', { review_model: 'fable' }],
    ['audit with fable', { audit_model: 'fable' }],
    ['plan with fable', { plan_model: 'fable' }],
    ['audit model opus', { audit_model: 'opus' }],
    ['set the audit model to opus', { audit_model: 'opus' }],
    ['plan and audit models fable', { plan_model: 'fable', audit_model: 'fable' }],
    ['edit with haiku, then report', { implement_model: 'haiku' }],
    ['Review with opus', { review_model: 'opus' }],
    ['plan model opus, review model sonnet', { plan_model: 'opus' }],
    ['PLAN   MODEL    FABLE', { plan_model: 'fable' }],
    ['plan\tmodel fable', { plan_model: 'fable' }],
    ['plan model fable\nand then fix the lint', { plan_model: 'fable' }],
    ['plan model fable please', { plan_model: 'fable' }],
    ['plan model fable. Then fix the lint', { plan_model: 'fable' }],
    ['  plan model fable   ', { plan_model: 'fable' }],
    ['plan model fable for good', { plan_model: 'fable' }],
    ['plan model fable for good.', { plan_model: 'fable' }],
    ['plan model and scoring models opus always', { plan_model: 'opus', review_model: 'opus' }],
    ['Plan model: fable, from now on', { plan_model: 'fable' }],
    ['edit with haiku by default', { implement_model: 'haiku' }],
    ['set the search model to sonnet permanently.', { search_model: 'sonnet' }],
    ['review model opus for every session', { review_model: 'opus' }],
    ['use the plan model haiku in all sessions', { plan_model: 'haiku' }],
    ['plan model fable for all sessions', { plan_model: 'fable' }],
])
{
    test(`a request that opens with '${showable(prompt)}' is saved in the kit's file and shown by the same request`, (t) =>
    {
        const repo = makeHookRepo(t);
        const model = Object.values(saved)[0];
        const variables = Object.fromEntries(MODEL_VARIABLES.map((variable) => [variable, otherModel(model)]));

        const { status, output } = runHook(repo, promptInput(prompt), variables);

        assert.equal(status, 0);
        assert.deepEqual(readKitFile(repo), saved);
        for (const [setting, value] of Object.entries(saved))
        {
            assert.ok(output.systemMessage.includes(`${LABELS[setting]} ${value}`), output.systemMessage);
            assert.ok(contextOf(output).includes(`${setting}=${value} (${KIT_FILE});`), contextOf(output));
        }
        const names = Object.entries(saved).map(([setting, value]) => `${setting}=${value}`).join(', ');
        assert.ok(contextOf(output).endsWith(` saved: ${names} in ${KIT_FILE};`), contextOf(output));
        assert.equal(output.systemMessage.includes('(this session)'), false);
    });
}

for (const prompt of [
    'plan the model migration',
    "review sonnet's diff",
    'plan model',
    'which plan model is fable?',
    'plan model gpt',
    'plan fable',
    'review model fabled story',
    "edit with sonnet's notes",
    'search with haiku-like brevity',
    'review model sonnet output for errors',
    'search model fable in the repo',
    'the plan model is opus, right?',
    'plan model fable and review model opus',
    'build with sonnet the new feature',
    'search on opus 4 pricing',
    'build on sonnet the new feature',
    'edit model haiku to sonnet in the config',
    'plan model fable foralways',
    'audit with fable?',
    'plan model fable for good measure',
    'plan model fable for goodness sake',
    'plan model opus for this one',
    'make the plan model sonnet for the next step only',
    'edit with haiku for now',
    'Please use the implement model haiku for this run',
    'search model opus for pricing data',
    'review model sonnet for errors',
    'plan model opus.5',
    'plan\tmodel\nfable',
    'plan model\nfable',
    'plan model fable always fails on big diffs',
    'review model opus by default is too slow, why?',
    'plan model fable, permanently broken?',
    'plan model fable for good?\nand then the rest',
    'enable scoring model fable',
    'start scoring model fable',
    'stop scoring models with opus',
])
{
    test(`'${showable(prompt)}' is no model choice: nothing is saved`, (t) =>
    {
        const repo = makeHookRepo(t);

        const { output } = runHook(repo, promptInput(prompt));

        assert.equal(kitFileExists(repo), false);
        assert.equal(contextOf(output).includes('saved'), false);
    });
}

test('several roles are saved together: one the hook can save is no partial write when the file cannot take them', (t) =>
{
    const repo = makeHookRepo(t, { [KIT_FILE]: '[1, 2]' });

    const { status, output } = runHook(repo, promptInput('plan model and scoring models fable'));

    assert.equal(status, 0);
    assert.equal(fs.readFileSync(path.join(repo, KIT_FILE), 'utf8'), '[1, 2]');
    assert.match(contextOf(output), / not saved - .*fix or delete it;$/);
});

test("a model choice keeps the file's other keys, and a later choice replaces the earlier one for its role", (t) =>
{
    const repo = makeHookRepo(t, { [KIT_FILE]: { auto_run: 'on', note: 'kept' } });

    runHook(repo, promptInput('plan model fable'));
    runHook(repo, promptInput('plan model opus'));

    assert.deepEqual(readKitFile(repo), { auto_run: 'on', note: 'kept', plan_model: 'opus' });
});

test('a saved model holds for the next request, which names no model', (t) =>
{
    const repo = makeHookRepo(t);
    runHook(repo, promptInput('plan model fable'));

    const { output } = runHook(repo, promptInput('fix the lint'), { KIT_PLAN_MODEL: 'haiku' });

    assert.match(output.systemMessage, /\| plan fable \|/);
    assert.ok(contextOf(output).includes(`plan_model=fable (${KIT_FILE});`));
    assert.equal(contextOf(output).includes('saved'), false);
});
