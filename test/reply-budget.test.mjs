// bin/reply-budget.mjs: the communication rule's reminder line and the size of Claude's last reply, from plain text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reminderContextOf, reminderOf, replyNoteOf } from '../bin/reply-budget.mjs';

const RULE = '# Rule\n\n- Length: something.\n- Each request carries this reminder: at most 900 characters. Lead with 3 sentences.\n- Other.\n';
const transcript = (...entries) => entries.map((entry) => JSON.stringify(entry)).join('\n');
const typed = (text) => ({ type: 'user', origin: { kind: 'human' }, message: { content: text } });
const notification = (text) => ({ type: 'user', origin: { kind: 'task-notification' }, message: { content: text } });
const answer = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
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
    assert.equal(replyNoteOf(transcript(typed('fix it'), answer('(high confidence) Done.'))), null);
});

test('a last reply over 900 characters of prose gets a note with its size', () =>
{
    const note = replyNoteOf(transcript(typed('fix it'), answer(LONG_PROSE)));

    assert.match(note, /^Last reply: 999 characters of prose and 1 lead sentences - over the limit\./);
});

test('a short last reply with a fourth prose sentence gets a note', () =>
{
    assert.match(replyNoteOf(transcript(typed('fix it'), answer(FOUR_SENTENCES))), /and 4 lead sentences - over/);
});

test('bullets, code blocks, tables and inline code do not count as lead prose', () =>
{
    const reply = `Done here now.\n\n\`\`\`text\n${LONG_PROSE}\n\`\`\`\n| a | ${LONG_PROSE} |\n- One two three. Four five six.\n- Seven eight nine. Ten eleven twelve.`;

    assert.equal(replyNoteOf(transcript(typed('fix it'), answer(reply))), null);
});

test('a close with a Checks: line is outside the limit', () =>
{
    assert.equal(replyNoteOf(transcript(typed('fix it'), answer(`${LONG_PROSE}\nChecks: npm test - pass`))), null);
});

test("a reply to a request that said 'in detail' is lifted, even after a notification nobody typed", () =>
{
    assert.equal(replyNoteOf(transcript(typed('explain it in detail'), notification('<task-notification> done'), answer(LONG_PROSE))), null);
});

test('only the last reply counts, and a cut first line from the tail read is skipped', () =>
{
    const text = `{"type":"assist${transcript(typed('a'), answer(LONG_PROSE), typed('b'), answer('(high confidence) Short.'))}`;

    assert.equal(replyNoteOf(text), null);
});

test('the context joins the head, the reminder and the note, and holds no ;', () =>
{
    const context = reminderContextOf(RULE, transcript(typed('fix it'), answer(LONG_PROSE)));

    assert.match(context, /^Reply limits \(\.claude\/rules\/communication\.md\): at most 900 characters\. Lead with 3 sentences\. Last reply: 999/);
    assert.ok(!context.includes(';'), context);
});

test('no reminder line means no context, even after a long reply', () =>
{
    assert.equal(reminderContextOf('# Rule\n', transcript(typed('fix it'), answer(LONG_PROSE))), null);
});
