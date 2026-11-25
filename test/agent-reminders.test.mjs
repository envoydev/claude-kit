// bin/agent-reminders.mjs, run as Claude Code runs a UserPromptSubmit hook: one JSON object on stdin, one or none on stdout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REAL_KIT, makeHookRepo, makeTempDir, promptInput, runHook, runRemindersHook } from './support.mjs';

const RULE_FILE = '.claude/rules/communication.md';
const SHORT_RULE = { [RULE_FILE]: '- Each request carries this reminder: short.\n' };
const CLEANUP_RULE_FILE = '.claude/rules/cleanup.md';
const CLEANUP_RULE = { [CLEANUP_RULE_FILE]: '- Each request carries this reminder: clean up.\n' };
const CLEANUP_LINE = 'Cleanup (.claude/rules/cleanup.md): clean up.';
const SHORT_LINE = 'Reply limits (.claude/rules/communication.md): short.';
const contextOf = (output) => output.hookSpecificOutput.additionalContext;
const typedEntry = (text) => ({ type: 'user', origin: { kind: 'human' }, message: { content: text } });
const answerEntry = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const LONG_REPLY = 'word '.repeat(200);

function transcriptOf(t, entries)
{
    const transcriptFile = path.join(makeTempDir(t, 'transcript'), 'session.jsonl');
    fs.writeFileSync(transcriptFile, entries.map((entry) => JSON.stringify(entry)).join('\n'));
    return transcriptFile;
}

const contextFor = (t, entries) =>
    contextOf(runRemindersHook(makeHookRepo(t, SHORT_RULE), { ...promptInput(), transcript_path: transcriptOf(t, entries) }).output);

test("sends the communication rule's reminder, and a note when the last reply went over", (t) =>
{
    const repo = makeHookRepo(t, { [RULE_FILE]: '# Rule\n- Each request carries this reminder: at most 900 characters.\n' });

    const { status, output } = runRemindersHook(repo, { ...promptInput(), transcript_path: transcriptOf(t, [typedEntry('fix it'), answerEntry(LONG_REPLY)]) });

    assert.equal(status, 0);
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(contextOf(output), /^Reply limits \(\.claude\/rules\/communication\.md\): at most 900 characters\. Last reply: 999 characters/);
    assert.equal(output.systemMessage, undefined);
});

test('with both rules present the context is two lines, communication first, and only that line takes the note', (t) =>
{
    const repo = makeHookRepo(t, { ...SHORT_RULE, ...CLEANUP_RULE });

    const { status, output } = runRemindersHook(repo, { ...promptInput(), transcript_path: transcriptOf(t, [typedEntry('fix it'), answerEntry(LONG_REPLY)]) });

    assert.equal(status, 0);
    const lines = contextOf(output).split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Reply limits \(\.claude\/rules\/communication\.md\): short\. Last reply: 999 characters/);
    assert.equal(lines[1], CLEANUP_LINE);
});

test('with both rules present and no long reply the two lines carry no note', (t) =>
{
    const repo = makeHookRepo(t, { ...SHORT_RULE, ...CLEANUP_RULE });

    assert.equal(contextOf(runRemindersHook(repo, promptInput()).output), `${SHORT_LINE}\n${CLEANUP_LINE}`);
});

test('with only the cleanup rule present the context is one Cleanup line, and no note after a long reply', (t) =>
{
    const repo = makeHookRepo(t, CLEANUP_RULE);

    const { status, stderr, output } = runRemindersHook(repo, { ...promptInput(), transcript_path: transcriptOf(t, [typedEntry('fix it'), answerEntry(LONG_REPLY)]) });

    assert.equal(status, 0);
    assert.equal(stderr, '');
    assert.equal(contextOf(output), CLEANUP_LINE);
    assert.ok(contextOf(output).startsWith('Cleanup ('));
});

test('rule files with no reminder line print nothing and exit 0', (t) =>
{
    const repo = makeHookRepo(t, { [RULE_FILE]: '# Rule\n', [CLEANUP_RULE_FILE]: '# Rule\n- Each request carries this reminder:   \n' });

    const { status, stdout, stderr } = runRemindersHook(repo, promptInput());

    assert.equal(status, 0);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
});

test('the real shared rules each yield a line, and neither holds a semicolon', (t) =>
{
    const communication = fs.readFileSync(path.join(REAL_KIT, 'shared/rules/communication.md'), 'utf8');
    const cleanup = fs.readFileSync(path.join(REAL_KIT, 'shared/rules/cleanup.md'), 'utf8');

    const withBoth = contextOf(runRemindersHook(makeHookRepo(t, { [RULE_FILE]: communication, [CLEANUP_RULE_FILE]: cleanup }), promptInput()).output);
    const onlyCommunication = contextOf(runRemindersHook(makeHookRepo(t, { [RULE_FILE]: communication }), promptInput()).output);
    const onlyCleanup = contextOf(runRemindersHook(makeHookRepo(t, { [CLEANUP_RULE_FILE]: cleanup }), promptInput()).output);

    assert.match(onlyCommunication, /^Reply limits \(\.claude\/rules\/communication\.md\): \S/);
    assert.match(onlyCleanup, /^Cleanup \(\.claude\/rules\/cleanup\.md\): \S/);
    assert.equal(withBoth, `${onlyCommunication}\n${onlyCleanup}`);
    assert.equal(withBoth.includes(';'), false, withBoth);
});

test("the status hook no longer carries the reminder: its context is the kit status alone", (t) =>
{
    const { output } = runHook(makeHookRepo(t, SHORT_RULE), { ...promptInput(), transcript_path: transcriptOf(t, [typedEntry('fix it'), answerEntry(LONG_REPLY)]) });

    assert.match(contextOf(output), /^kit status \(/);
    assert.equal(contextOf(output).includes('Reply limits'), false);
});

test('a missing transcript still sends the reminder, with no note and nothing on stderr', (t) =>
{
    const repo = makeHookRepo(t, SHORT_RULE);

    const { status, stderr, output } = runRemindersHook(repo, { ...promptInput(), transcript_path: path.join(repo, 'missing.jsonl') });

    assert.equal(status, 0);
    assert.equal(stderr, '');
    assert.equal(contextOf(output), SHORT_LINE);
});

test('no rule file prints nothing and exits 0', (t) =>
{
    const { status, stdout, stderr } = runRemindersHook(makeHookRepo(t), promptInput());

    assert.equal(status, 0);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
});

test('a lift in a typed request further back than the first 512 KB of the transcript still lifts the cap', (t) =>
{
    const filler = Array.from({ length: 700 }, () => answerEntry('x'.repeat(1000)));

    assert.equal(contextFor(t, [typedEntry('explain it in detail'), ...filler, answerEntry(LONG_REPLY)]), SHORT_LINE);
});

test('a transcript with no typed request in it gives no note, even for a long reply', (t) =>
{
    assert.equal(contextFor(t, [answerEntry(LONG_REPLY)]), SHORT_LINE);
});

test('a prompt typed while a turn runs gets no note for the interim text before a tool call', (t) =>
{
    const toolCall = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } };

    assert.equal(contextFor(t, [typedEntry('fix it'), answerEntry(LONG_REPLY), toolCall]), SHORT_LINE);
});

test('a transcript path that cannot be read is reported on stderr, and the request still goes through', (t) =>
{
    const repo = makeHookRepo(t, SHORT_RULE);

    const { status, stderr, output } = runRemindersHook(repo, { ...promptInput(), transcript_path: repo });

    assert.equal(status, 0);
    assert.match(stderr, /^claude-kit agent-reminders hook: /);
    assert.equal(contextOf(output), SHORT_LINE);
});

test('a rule file that cannot be read is reported on stderr and prints nothing', (t) =>
{
    const repo = makeHookRepo(t);
    fs.mkdirSync(path.join(repo, RULE_FILE), { recursive: true });

    const { status, stdout, stderr } = runRemindersHook(repo, promptInput());

    assert.equal(status, 0);
    assert.match(stderr, /^claude-kit agent-reminders hook: /);
    assert.equal(stdout, '');
});

test('a reminder line of 20,000 characters is cut, so the context stays under the 10,000 a hook may return', (t) =>
{
    const repo = makeHookRepo(t, { [RULE_FILE]: `- Each request carries this reminder: ${'x'.repeat(20000)}\n` });

    const { output } = runRemindersHook(repo, promptInput());

    assert.ok(contextOf(output).length < 10000, `${contextOf(output).length}`);
    assert.ok(contextOf(output).endsWith(`${'x'.repeat(400)}...`), contextOf(output).slice(-40));
});

test('a missing sibling module never blocks: the hook exits 0 and says so on stderr', (t) =>
{
    const repo = makeHookRepo(t, SHORT_RULE);
    fs.rmSync(path.join(repo, '.claude/kit/reply-budget.mjs'));

    const { status, stdout, stderr } = runRemindersHook(repo, promptInput());

    assert.equal(status, 0);
    assert.equal(stdout, '');
    assert.match(stderr, /^claude-kit agent-reminders hook: /);
});

test('empty or broken stdin still sends the reminder, with no note, and exits 0', (t) =>
{
    const repo = makeHookRepo(t, SHORT_RULE);

    for (const input of ['', 'not json', '[]', 'null'])
    {
        const { status, output } = runRemindersHook(repo, input);

        assert.equal(status, 0, input);
        assert.equal(contextOf(output), SHORT_LINE, input);
    }
});
