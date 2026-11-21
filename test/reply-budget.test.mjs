// bin/reply-budget.mjs: the communication rule's reminder line and the size of Claude's last reply, from plain text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reminderContextOf, reminderOf, replyCheckOf } from '../bin/reply-budget.mjs';

const RULE = '# Rule\n\n- Length: something.\n- Each request carries this reminder: at most 900 characters. Lead with 3 sentences.\n- Other.\n';
const transcript = (...entries) => entries.map((entry) => JSON.stringify(entry)).join('\n');
const typed = (text) => ({ type: 'user', origin: { kind: 'human' }, message: { content: text } });
const notification = (text) => ({ type: 'user', origin: { kind: 'task-notification' }, message: { content: text } });
const answer = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const toolCall = () => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
const toolResult = () => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
const queued = (prompt, origin) => ({ type: 'attachment', attachment: { type: 'queued_command', prompt, ...(origin === undefined ? {} : { origin: { kind: origin } }) } });
const noteOf = (text) => replyCheckOf(text).note;
const LONG_PROSE = 'word '.repeat(200).trim();
const FOUR_SENTENCES = 'One two three. Four five six. Seven eight nine. Ten eleven twelve.';

test('takes the reminder from the line that opens with the marker, without the marker', () =>
{
    assert.equal(reminderOf(RULE), 'at most 900 characters. Lead with 3 sentences.');
});

test('a rule with no reminder line, or an empty one, gives no reminder', () =>
{
    assert.equal(reminderOf('# Rule\n- Length: something.\n'), null);
    assert.equal(reminderOf('- Each request carries this reminder:   \n'), null);
});

test("turns a ';' in the reminder into a ',' so alfred-mods' note parser keeps its end", () =>
{
    assert.equal(reminderOf('- Each request carries this reminder: short; clear\n'), 'short, clear');
});

test('a short last reply gets no note', () =>
{
    assert.equal(noteOf(transcript(typed('fix it'), answer('(high confidence) Done.'))), null);
});

test('a last reply over 900 characters of prose gets a note with its size', () =>
{
    const note = noteOf(transcript(typed('fix it'), answer(LONG_PROSE)));

    assert.match(note, /^Last reply: 999 characters of prose, lead sentences: 1 - over the limit\. Make this one fit\./);
});

test('a short last reply with a fourth prose sentence gets a note', () =>
{
    assert.match(noteOf(transcript(typed('fix it'), answer(FOUR_SENTENCES))), /characters of prose, lead sentences: 4 - over the limit/);
});

test('bullets, code blocks, tables and inline code do not count as lead prose', () =>
{
    const reply = `Done here now.\n\n\`\`\`text\n${LONG_PROSE}\n\`\`\`\n| a | ${LONG_PROSE} |\n- One two three. Four five six.\n- Seven eight nine. Ten eleven twelve.`;

    assert.equal(noteOf(transcript(typed('fix it'), answer(reply))), null);
});

test('a close with a Checks: line is outside the limit', () =>
{
    assert.equal(noteOf(transcript(typed('fix it'), answer(`${LONG_PROSE}\nChecks: npm test - pass`))), null);
});

test("a reply to a request that said 'in detail' is lifted, even after a notification nobody typed", () =>
{
    assert.equal(noteOf(transcript(typed('explain it in detail'), notification('<task-notification> done'), answer(LONG_PROSE))), null);
});

test('only the last reply counts, and a cut first line from the tail read is skipped', () =>
{
    const text = `{"type":"assist${transcript(typed('a'), answer(LONG_PROSE), typed('b'), answer('(high confidence) Short.'))}`;

    assert.equal(noteOf(text), null);
});

test('the context joins the head, the reminder and the note, and holds no ;', () =>
{
    const context = reminderContextOf(RULE, 'Last reply: 999 characters of prose, lead sentences: 1 - over the limit. Make this one fit.');

    assert.match(context, /^Reply limits \(\.claude\/rules\/communication\.md\): at most 900 characters\. Lead with 3 sentences\. Last reply: 999/);
    assert.ok(!context.includes(';'), context);
});

test('no reminder line means no context, even with a note', () =>
{
    assert.equal(reminderContextOf('# Rule\n', 'a note'), null);
});

test('a context with no note is the head and the reminder alone', () =>
{
    assert.equal(reminderContextOf(RULE, null), 'Reply limits (.claude/rules/communication.md): at most 900 characters. Lead with 3 sentences.');
});

test('a reminder line longer than the shown limit is cut with the cut mark, so the context stays small', () =>
{
    const context = reminderContextOf(`- Each request carries this reminder: ${'x'.repeat(20000)}\n`, null);

    assert.ok(context.endsWith(`${'x'.repeat(400)}...`), context.slice(-40));
    assert.ok(context.length < 1000, `${context.length}`);
});

test('the check reports that it found the typed request, and gives no note without one', () =>
{
    assert.deepEqual(replyCheckOf(transcript(typed('fix it'), answer(LONG_PROSE))).requestFound, true);
    assert.deepEqual(replyCheckOf(transcript(answer(LONG_PROSE))), { requestFound: false, note: null });
});

test('a typed request that sits after the last reply is no request for it', () =>
{
    assert.deepEqual(replyCheckOf(transcript(answer(LONG_PROSE), typed('next'))), { requestFound: false, note: null });
});

test("'plugin details' is no lift: the word boundaries keep 'in detail' to the phrase", () =>
{
    assert.match(noteOf(transcript(typed('show the plugin details'), answer(LONG_PROSE))), /^Last reply: 999/);
    assert.equal(noteOf(transcript(typed('explain it in detail'), answer(LONG_PROSE))), null);
});

test('prose length counts code points, so emoji do not count twice', () =>
{
    const emoji = '\u{1F600} '.repeat(400).trim();

    assert.equal(noteOf(transcript(typed('fix it'), answer(emoji))), null);
});

test('an indented line that wraps a bullet is part of the bullet, not lead prose', () =>
{
    const reply = 'One two three.\n- A bullet that wraps\n  Four five six.\n  Seven eight nine.\n  Ten eleven twelve.';

    assert.equal(noteOf(transcript(typed('fix it'), answer(reply))), null);
});

test('a blank line ends the bullet, so the indented prose after it counts as lead prose', () =>
{
    const reply = 'One two three.\n- A bullet\n\n  Four five six. Seven eight nine. Ten eleven twelve.';

    assert.match(noteOf(transcript(typed('fix it'), answer(reply))), /lead sentences: 4 - over/);
});

test("'1)' numbered items are bullets", () =>
{
    const reply = 'One two three.\n1) Four five six. Seven eight nine.\n2) Ten eleven twelve. Ten eleven twelve.';

    assert.equal(noteOf(transcript(typed('fix it'), answer(reply))), null);
});

test('a text before a tool call is interim: the turn is running and the text gets no note', () =>
{
    assert.deepEqual(replyCheckOf(transcript(typed('fix it'), answer(LONG_PROSE), toolCall())), { requestFound: true, note: null });
    assert.deepEqual(replyCheckOf(transcript(typed('fix it'), answer(LONG_PROSE), toolCall(), toolResult())), { requestFound: true, note: null });
});

test('a text and a tool call in one entry is interim too', () =>
{
    const both = { type: 'assistant', message: { content: [{ type: 'text', text: LONG_PROSE }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } };

    assert.equal(noteOf(transcript(typed('fix it'), both)), null);
});

test('the final text after the tool calls is the reply that gets the note', () =>
{
    assert.match(noteOf(transcript(typed('fix it'), answer('Looking now.'), toolCall(), toolResult(), answer(LONG_PROSE))), /^Last reply: 999/);
});

test("a queued_command from a human is the typed request, with its origin inside 'attachment'", () =>
{
    assert.equal(noteOf(transcript(typed('fix it'), queued('explain it in detail', 'human'), answer(LONG_PROSE))), null);
    assert.match(noteOf(transcript(typed('explain it in detail'), queued('and now?', 'human'), answer(LONG_PROSE))), /^Last reply: 999/);
});

test("a queued_command of kind 'task-notification' is not typed, so the earlier lift holds", () =>
{
    assert.equal(noteOf(transcript(typed('explain it in detail'), queued('ok', 'task-notification'), answer(LONG_PROSE))), null);
});

test('a queued_command with no origin is read like a user turn with none', () =>
{
    assert.match(noteOf(transcript(typed('explain it in detail'), queued('and now?'), answer(LONG_PROSE))), /^Last reply: 999/);
    assert.equal(noteOf(transcript(typed('explain it in detail'), queued('<task-notification> done'), answer(LONG_PROSE))), null);
});
