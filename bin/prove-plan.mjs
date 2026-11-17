#!/usr/bin/env node
// Copied into each repo as .claude/kit/prove-plan.mjs by claude-kit's sync - edit it in claude-kit, never here.
//
// Proves an audit plan (shared/skills/repo-audit-plugin/references/plan-format.md): reads every edited file at the
// plan's Baseline revision, never from the working tree, and applies the edits in plan order - each Old found exactly
// once, at or after the end of the last edit to the same file, and replaced by its New. When every edit applied it
// writes the resulting files into a folder beside the plan (plan.md -> expected/) and prints one line per file.
//
//   node .claude/kit/prove-plan.mjs <plan> [--without E<n>[,E<m>]]...    run at the repository root
//
// --without, after a full pass, also writes expected-without-E<n>/: the plan with that edit and every edit that needs
// it left out. Prints `Applies: <applied> of <total> edits` always; a failed edit is named on stderr, one line each.
// Exits 0 when every edit applied, 1 when one did not, 2 when the plan or the command line cannot be used. Writes only
// beside the plan, and runs no git command that changes anything.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const EXIT = Object.freeze({ applied: 0, failed: 1, usage: 2 });
const KIND = Object.freeze({
    replace: 'replace',
    insertAfter: 'insert-after',
    delete: 'delete',
    newFile: 'new-file',
    moveFile: 'move-file',
    deleteFile: 'delete-file',
});
const BLOCKS_NEEDED = Object.freeze({
    [KIND.replace]: ['old', 'new'],
    [KIND.insertAfter]: ['old', 'new'],
    [KIND.delete]: ['old'],
    [KIND.newFile]: ['new'],
    [KIND.moveFile]: [],
    [KIND.deleteFile]: [],
});
const PATH_ONLY_KINDS = new Set([KIND.moveFile, KIND.deleteFile]);
const BASELINE_PREFIX = 'Baseline: ';
const EDITS_HEADING = '## Edits';
const SECTION_PREFIX = '## ';
const EDIT_HEADING = /^### E(\d+) - (.+)$/;
const KIND_LINE = /^- Kind: (.+)$/;
const NEEDS_PREFIX = '- Needs: ';
const EDIT_NUMBER = /E(\d+)/g;
const OPEN_FENCE = /^(`{3,})/;
const WITHOUT_WORD = 'without';
const WITHOUT_OPTION = `--${WITHOUT_WORD}`;
const WITHOUT_VALUE = /^E\d+(,E\d+)*$/;
const LABEL = Object.freeze({ old: 'Old:', new: 'New:' });
const PLAN_FILE_SUFFIX = '.md';
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

class PlanError extends Error
{
}

function fail(message)
{
    throw new PlanError(message);
}

const git = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });

// Which lines sit inside a fenced block, and where each block closes (-1 while it never does). A fence opens on three
// or more backticks and closes on the first later line that is exactly that run, so a shorter fence inside is text.
function scanFences(lines)
{
    const fenced = new Array(lines.length).fill(false);
    const closeOf = new Map();
    let openAt = -1;
    let run = '';
    lines.forEach((line, index) =>
    {
        if (openAt === -1)
        {
            const match = OPEN_FENCE.exec(line);
            if (match === null) return;
            openAt = index;
            run = match[1];
            fenced[index] = true;
            closeOf.set(index, -1);
            return;
        }
        fenced[index] = true;
        if (line === run)
        {
            closeOf.set(openAt, index);
            openAt = -1;
        }
    });
    return { fenced, closeOf };
}

// The content of the first fenced block after the label's line and before `limit`, or the problem that there is none.
function readBlock(lines, closeOf, labelAt, limit, label)
{
    const openAt = labelAt === -1 ? undefined : [...closeOf.keys()].find((index) => index > labelAt && index < limit);
    if (openAt === undefined || closeOf.get(openAt) === -1) return { problem: `no closed fence after '${label}'` };
    return { text: lines.slice(openAt + 1, closeOf.get(openAt)).join('\n') };
}

function parseEdit(lines, fenced, closeOf, [start, end], number, file)
{
    const outside = (predicate) => lines.findIndex((line, index) => index >= start && index < end && !fenced[index] && predicate(line));
    const labelAt = (label) =>
    {
        const at = lines.flatMap((line, index) => (index >= start && index < end && !fenced[index] && line.trimEnd() === label ? [index] : []));
        if (at.length > 1) fail(`E${number} has more than one '${label}'`);
        return at[0] ?? -1;
    };
    const kindAt = outside((line) => KIND_LINE.test(line));
    const needsAt = outside((line) => line.startsWith(NEEDS_PREFIX));
    const oldAt = labelAt(LABEL.old);
    const newAt = labelAt(LABEL.new);
    const oldLimit = newAt > oldAt ? newAt : end;
    return {
        number,
        path: file,
        kind: kindAt === -1 ? null : KIND_LINE.exec(lines[kindAt])[1].trim(),
        needs: needsAt === -1 ? [] : [...lines[needsAt].matchAll(EDIT_NUMBER)].map((match) => Number(match[1])),
        old: readBlock(lines, closeOf, oldAt, oldLimit, LABEL.old),
        new: readBlock(lines, closeOf, newAt, end, LABEL.new),
    };
}

function parsePlan(text)
{
    const lines = text.split(/\r?\n/);
    const { fenced, closeOf } = scanFences(lines);
    const outside = (from, predicate) => lines.findIndex((line, index) => index >= from && !fenced[index] && predicate(line));

    const baselineAt = outside(0, (line) => line.startsWith(BASELINE_PREFIX));
    const revision = baselineAt === -1 ? '' : lines[baselineAt].slice(BASELINE_PREFIX.length).trim().split(/\s+/)[0];
    if (revision === '') fail(`no '${BASELINE_PREFIX.trim()}' line with a revision outside a fence`);

    const editsAt = outside(0, (line) => line.trimEnd() === EDITS_HEADING);
    if (editsAt === -1) fail(`no '${EDITS_HEADING}' section`);
    const sectionEnd = outside(editsAt + 1, (line) => line.startsWith(SECTION_PREFIX));
    const end = sectionEnd === -1 ? lines.length : sectionEnd;

    const headings = [];
    for (let index = editsAt + 1; index < end; index++)
        if (!fenced[index] && EDIT_HEADING.test(lines[index])) headings.push(index);
    if (headings.length === 0) fail(`no edit under '${EDITS_HEADING}'`);
    const stray = outside(end, (line) => EDIT_HEADING.test(line));
    if (stray !== -1) fail(`E${EDIT_HEADING.exec(lines[stray])[1]} is outside the Edits section`);

    const edits = headings.map((at, position) =>
    {
        const [, number, heading] = EDIT_HEADING.exec(lines[at]);
        const file = heading.trim();
        if (path.win32.isAbsolute(file) || path.posix.isAbsolute(file) || file.split(/[\\/]/).includes('..')) fail(`E${number} names a path outside the repository: ${file}`);
        return parseEdit(lines, fenced, closeOf, [at + 1, headings[position + 1] ?? end], Number(number), file);
    });
    edits.forEach((edit, index) =>
    {
        if (index > 0 && edit.number <= edits[index - 1].number)
            fail(`edit numbers do not rise: E${edit.number} follows E${edits[index - 1].number}`);
    });
    return { revision, edits };
}

function findOld(edit, file)
{
    const { text } = file;
    const old = edit.old.text;
    let count = 0;
    let first = -1;
    for (let at = old === '' ? -1 : text.indexOf(old); at !== -1; at = text.indexOf(old, at + 1))
    {
        count++;
        if (first === -1) first = at;
    }
    if (count === 0) return { reason: 'Old not found' };
    if (count > 1) return { reason: `Old found ${count} times` };
    if (first < file.cursor) return { reason: `Old is before the end of E${file.lastEdit} - out of file order or overlapping` };
    return { at: first };
}

function splice(edit, file, at, removed, inserted)
{
    file.text = file.text.slice(0, at) + inserted + file.text.slice(at + removed);
    file.cursor = at + inserted.length;
    file.lastEdit = edit.number;
    file.edited = true;
}

// Where a text edit changes the file, relative to where Old was found: [offset, characters removed, text put in].
const TEXT_CHANGES = {
    [KIND.replace]: (edit) => [0, edit.old.text.length, edit.new.text],
    [KIND.insertAfter]: (edit) => [edit.old.text.length, 0, `\n${edit.new.text}`],
    [KIND.delete]: (edit) => [0, edit.old.text.length, ''],
};

function applyTextEdit(file, revision, edit)
{
    if (file.text === null) return `not in the Baseline revision ${revision}`;
    const found = findOld(edit, file);
    if (found.reason !== undefined) return found.reason;
    if (edit.kind === KIND.replace && edit.new.text === edit.old.text) return 'New is the same as Old';
    const [offset, removed, inserted] = TEXT_CHANGES[edit.kind](edit);
    splice(edit, file, found.at + offset, removed, inserted);
    return null;
}

// Each handler takes the file's state, the Baseline revision as written and the edit; it returns the reason the edit failed, or null once the file holds its result.
const HANDLERS = {
    [KIND.replace]: applyTextEdit,
    [KIND.insertAfter]: applyTextEdit,
    [KIND.delete]: applyTextEdit,
    [KIND.newFile]: (file, revision, edit) =>
    {
        if (file.text !== null) return `already in the Baseline revision ${revision}`;
        file.text = `${edit.new.text}\n`;
        file.lastEdit = edit.number;
        file.edited = true;
        return null;
    },
    [KIND.moveFile]: (file, revision) => file.baseline === null ? `not in the Baseline revision ${revision}` : null,
    [KIND.deleteFile]: (file, revision, edit) =>
    {
        if (file.baseline === null) return `not in the Baseline revision ${revision}`;
        file.deletedBy = edit.number;
        return null;
    },
};

function applyEdit(edit, file, revision)
{
    if (edit.kind === null) return 'no Kind line';
    if (!Object.hasOwn(HANDLERS, edit.kind)) return `kind '${edit.kind}' is not handled`;
    const broken = BLOCKS_NEEDED[edit.kind].map((name) => edit[name].problem).find((problem) => problem !== undefined);
    if (broken !== undefined) return broken;
    if (file.deletedBy !== null) return `deleted by E${file.deletedBy}`;
    return HANDLERS[edit.kind](file, revision, edit);
}

// A Needs line says the texts hold together, not what order they come in, so it is read after every edit has been tried:
// an edit that applied fails when an edit it names failed or is not in the plan, until nothing more changes. An edit
// naming itself is ignored.
function failNeedingEdits(edits, reasons)
{
    const held = new Set(edits.map((edit) => edit.number));
    for (let size = -1; size !== reasons.size;)
    {
        size = reasons.size;
        for (const edit of edits)
        {
            const unmet = reasons.has(edit.number) ? undefined : edit.needs.find((number) => number !== edit.number && (reasons.has(number) || !held.has(number)));
            if (unmet !== undefined) reasons.set(edit.number, `needs E${unmet}, which ${held.has(unmet) ? 'did not apply' : 'the plan does not hold'}`);
        }
    }
}

// Applies the edits in order on the Baseline text of each file. A failed edit leaves its file as it stood.
function replay(edits, readBaseline, revision)
{
    const files = new Map();
    const entry = (file) =>
    {
        if (!files.has(file))
        {
            const baseline = readBaseline(file);
            files.set(file, { baseline, text: baseline, cursor: 0, lastEdit: null, deletedBy: null, edited: false });
        }
        return files.get(file);
    };
    const reasons = new Map();
    for (const edit of edits)
    {
        const reason = applyEdit(edit, entry(edit.path), revision);
        if (reason !== null) reasons.set(edit.number, reason);
    }
    failNeedingEdits(edits, reasons);
    const failures = edits.filter((edit) => reasons.has(edit.number)).map((edit) => `E${edit.number} - ${edit.path}: ${reasons.get(edit.number)}`);
    const notes = edits.filter((edit) => !reasons.has(edit.number) && PATH_ONLY_KINDS.has(edit.kind))
        .map((edit) => `E${edit.number} - ${edit.path}: ${edit.kind} - path checked, nothing to replay`);
    return { applied: edits.length - reasons.size, failures, notes, files, entry };
}

const hasResultText = (file) => file.text !== null && file.deletedBy === null;

function expectedFolderName(planFile)
{
    const name = path.basename(planFile, PLAN_FILE_SUFFIX);
    if (name === 'plan') return 'expected';
    if (name.startsWith('plan-')) return `expected-${name.slice('plan-'.length)}`;
    if (name.endsWith('-plan')) return `${name.slice(0, -'-plan'.length)}-expected`;
    return `${name}-expected`;
}

// The edits left out by --without: the ones named and every edit whose Needs chain reaches one of them.
function leftOutWith(edits, named)
{
    const leftOut = new Set(named);
    for (let size = -1; size !== leftOut.size;)
    {
        size = leftOut.size;
        for (const edit of edits) if (edit.needs.some((number) => leftOut.has(number))) leftOut.add(edit.number);
    }
    return leftOut;
}

function proveVariant(edits, named, readBaseline, revision, folderName)
{
    const leftOut = leftOutWith(edits, named);
    const run = replay(edits.filter((edit) => !leftOut.has(edit.number)), readBaseline, revision);
    if (run.failures.length > 0) return { failures: run.failures.map((line) => `${folderName}: ${line}`) };
    const paths = [...new Set(edits.filter((edit) => leftOut.has(edit.number)).map((edit) => edit.path))];
    const kept = new Map(paths.map((file) => [file, run.entry(file)]).filter(([, file]) => hasResultText(file)).map(([file, state]) => [file, state.text]));
    const leftOutNames = edits.filter((edit) => leftOut.has(edit.number)).map((edit) => `E${edit.number}`).join(', ');
    return {
        failures: [],
        files: kept,
        line: `${folderName}: ${run.applied} of ${edits.length} edits, left out ${leftOutNames}; files: ${[...kept.keys()].join(', ')}`,
    };
}

function writeFolder(folder, files)
{
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    for (const [file, text] of files)
    {
        const target = path.join(folder, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, text);
    }
}

function parseArguments(args)
{
    let planPath = null;
    const variants = [];
    for (let index = 0; index < args.length; index++)
    {
        const argument = args[index];
        if (argument === WITHOUT_OPTION)
        {
            const value = args[++index];
            if (value === undefined || !WITHOUT_VALUE.test(value)) fail(`${WITHOUT_OPTION} takes edit numbers such as E2 or E2,E8`);
            variants.push([...new Set(value.split(',').map((name) => Number(name.slice(1))))]);
        }
        else if (argument.startsWith('-')) fail(`unknown option ${argument}`);
        else if (planPath !== null) fail(`more than one plan path: ${planPath} and ${argument}`);
        else planPath = argument;
    }
    if (planPath === null) fail(`no plan path - usage: node prove-plan.mjs <plan> [${WITHOUT_OPTION} E<n>[,E<m>]]...`);
    return { planPath, variants };
}

function repositoryRoot()
{
    const result = git(process.cwd(), ['rev-parse', '--show-toplevel']);
    if (result.status !== 0) fail('not inside a git repository');
    return result.stdout.trim();
}

function resolveRevision(root, revision)
{
    const result = revision.startsWith('-') ? { status: 1 } : git(root, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
    if (result.status !== 0) fail(`unknown revision '${revision}' after Baseline`);
    return result.stdout.trim();
}

function prove(args)
{
    const { planPath, variants } = parseArguments(args);
    const root = repositoryRoot();
    const { revision, edits } = parsePlan(readFileSync(path.resolve(planPath), 'utf8'));
    const commit = resolveRevision(root, revision);
    const unknown = variants.flat().find((number) => !edits.some((edit) => edit.number === number));
    if (unknown !== undefined) fail(`${WITHOUT_OPTION} names E${unknown}, which the plan does not hold`);
    const readBaseline = (file) =>
    {
        const result = git(root, ['cat-file', 'blob', `${commit}:${file}`]);
        return result.status === 0 ? result.stdout : null;
    };

    const full = replay(edits, readBaseline, revision);
    console.log(`Applies: ${full.applied} of ${edits.length} edits`);
    for (const note of full.notes) console.log(note);
    if (full.failures.length > 0)
    {
        for (const line of full.failures) console.error(line);
        return EXIT.failed;
    }

    const results = new Map([...full.files].filter(([, file]) => file.edited && hasResultText(file)));
    const planFolder = path.dirname(path.resolve(planPath));
    const folderName = expectedFolderName(planPath);
    writeFolder(path.join(planFolder, folderName), new Map([...results].map(([file, state]) => [file, state.text])));
    for (const [file, state] of results)
        console.log(`  ${file} (${state.baseline === null ? 'new,' : `${state.baseline.length} ->`} ${state.text.length} characters)`);

    let exitCode = EXIT.applied;
    for (const named of variants)
    {
        const variantName = `${folderName}-${WITHOUT_WORD}-${named.map((number) => `E${number}`).join('-')}`;
        const variant = proveVariant(edits, named, readBaseline, revision, variantName);
        for (const line of variant.failures) console.error(line);
        if (variant.failures.length > 0) exitCode = EXIT.failed;
        else
        {
            writeFolder(path.join(planFolder, variantName), variant.files);
            console.log(variant.line);
        }
    }
    return exitCode;
}

try
{
    process.exitCode = prove(process.argv.slice(2));
}
catch (error)
{
    // A file the plan names that cannot be read or written (an error with a string code) is as unusable as a bad plan.
    if (!(error instanceof PlanError) && typeof error.code !== 'string') throw error;
    console.error(`prove-plan: ${error.message}`);
    process.exitCode = EXIT.usage;
}
