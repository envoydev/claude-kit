#!/usr/bin/env node
// Copied into each repo as .claude/kit/audit-scope.mjs by claude-kit's sync - edit it in claude-kit, never here.
//
// Keeps what an audit graded beside the hashes of the files it graded, in a machine-local state file, so the next
// audit reads only what changed. An item is a file, or a folder named by its first path segment below a root; its
// grade is carried while its files, the --with files and the scoring files (the audit skill's rubric and currency
// text) hold the hashes they had when it was graded.
//
//   node .claude/kit/audit-scope.mjs scope <kind> [--full] [--with <path>]... <root>...    run at the repository root
//   node .claude/kit/audit-scope.mjs record <kind> --run <run folder> --grades <file> [--under <scoring hash> <folder hash>] [--with <path>]... <root>...
//
// scope prints `audit <id> - <why>` for each item to read and `carried <id> - ...` for each that keeps its grade, and
// writes nothing. record reads the grades file (one `<id> TAB <letter> TAB <numeric> TAB yes|no` per line) and writes
// only docs/superpowers/audits/state/<kind>.json, through a temp file in that folder. Every path is from the
// repository root. Exits 0 when done, 2 when the command line or the state file cannot be used.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const EXIT = Object.freeze({ done: 0, usage: 2 });
const COMMAND = Object.freeze({ scope: 'scope', record: 'record' });
const OPTION = Object.freeze({ full: '--full', with: '--with', run: '--run', grades: '--grades', under: '--under' });
const COMMAND_OPTIONS = Object.freeze({
    [COMMAND.scope]: [OPTION.full, OPTION.with],
    [COMMAND.record]: [OPTION.run, OPTION.grades, OPTION.under, OPTION.with],
});
const KIND_PATTERN = /^[a-z][a-z-]*$/;
const LETTER_PATTERN = /^[A-F][+-]?$/;
const NUMERIC_PATTERN = /^\d+(\.\d+)?$/;
const HASH_PATTERN = /^[0-9a-f]{40}$/;
const AT_TARGET = Object.freeze({ yes: 'yes', no: 'no' });
const GRADE_FIELDS = 4;
const STATE_FOLDER = 'docs/superpowers/audits/state';
const AUDIT_SKILL_PREFIX = '.claude/skills/repo-audit-';
const SCORING_FILES = Object.freeze(['references/rubric.md', 'references/currency.md']);
const STATE_TEXT_KEYS = Object.freeze(['letter', 'numeric', 'date', 'run', 'scoring', 'folder']);
const NOT_A_FOLDER_CODES = new Set(['ENOENT', 'ENOTDIR']);
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const HASH_BATCH_SIZE = 100;
const NO_COMMAND_USAGE = `usage: node audit-scope.mjs ${COMMAND.scope}|${COMMAND.record} <kind> [options] <root>...`;

class UsageError extends Error
{
}

function fail(message)
{
    throw new UsageError(message);
}

const git = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });

function gitOutput(root, args)
{
    const result = git(root, args);
    if (result.status !== 0) fail(`git ${args[0]} failed: ${result.error?.message ?? result.stderr.trim()}`);
    return result.stdout;
}

function isRegularFile(file)
{
    try
    {
        return lstatSync(file).isFile();
    }
    catch
    {
        return false;
    }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isHashRecord = (value) => isRecord(value) && Object.values(value).every((hash) => typeof hash === 'string');
const isUnder = (file, base) => file === base || file.startsWith(`${base}/`);
const filesUnder = (files, base) => files.filter((file) => isUnder(file, base));
const stateFilePath = (kind) => `${STATE_FOLDER}/${kind}.json`;
const sortedKeys = (map) => [...map.keys()].sort();
const sortedRecord = (map) => Object.fromEntries(sortedKeys(map).map((key) => [key, map.get(key)]));

function localDate(now)
{
    const pad = (part) => String(part).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// A path as the command line gives it, from the repository root with '/' and no trailing '/', or the problem with it.
function checkedPath(text)
{
    if (text === '') return { problem: 'is empty' };
    if (path.posix.isAbsolute(text) || path.win32.isAbsolute(text)) return { problem: 'is outside the repository' };
    const segments = text.split('/');
    if (segments.includes('..')) return { problem: 'is outside the repository' };
    const clean = segments.filter((segment) => segment !== '' && segment !== '.').join('/');
    return clean === '' ? { problem: 'names the repository itself' } : { path: clean };
}

function requirePath(text, label)
{
    const checked = checkedPath(text);
    if (checked.problem !== undefined) fail(`${label} ${text} ${checked.problem}`);
    return checked.path;
}

// What one option takes: the next argument, or two for --under. An argument that is itself an option is no value.
function takeValues(args, index, count, option)
{
    const values = args.slice(index + 1, index + 1 + count);
    if (values.length < count || values.some((value) => value.startsWith('-'))) fail(`${option} needs ${count === 1 ? 'a value' : 'a scoring hash and a folder hash'}`);
    return values;
}

function parseArguments(args)
{
    const [command, kind, ...rest] = args;
    if (command === undefined || !Object.hasOwn(COMMAND_OPTIONS, command)) fail(`${command === undefined ? 'no command' : `unknown command ${command}`} - ${NO_COMMAND_USAGE}`);
    if (kind === undefined || kind.startsWith('-')) fail(`no kind - ${NO_COMMAND_USAGE}`);
    if (!KIND_PATTERN.test(kind)) fail(`kind ${kind} does not match ${KIND_PATTERN}`);
    const options = { command, kind, roots: new Set(), withPaths: new Set(), full: false, run: null, grades: null, under: null };
    for (let index = 0; index < rest.length; index++)
    {
        const argument = rest[index];
        if (!argument.startsWith('-')) options.roots.add(requirePath(argument, 'root'));
        else if (!COMMAND_OPTIONS[command].includes(argument)) fail(`unknown option ${argument}`);
        else if (argument === OPTION.full) options.full = true;
        else if (argument === OPTION.under)
        {
            options.under = takeValues(rest, index, 2, argument);
            index += 2;
            if (!options.under.every((hash) => HASH_PATTERN.test(hash))) fail(`${OPTION.under} takes two 40-character hashes`);
        }
        else
        {
            const [value] = takeValues(rest, index++, 1, argument);
            if (argument === OPTION.with) options.withPaths.add(requirePath(value, `${argument} path`));
            else if (argument === OPTION.run) options.run = requirePath(value, `${argument} folder`);
            else options.grades = value;
        }
    }
    if (options.roots.size === 0) fail(`no root - ${NO_COMMAND_USAGE}`);
    if (command === COMMAND.record && (options.run === null || options.grades === null)) fail(`${COMMAND.record} needs ${OPTION.run} and ${OPTION.grades}`);
    return options;
}

function repositoryRoot()
{
    const result = git(process.cwd(), ['rev-parse', '--show-toplevel']);
    if (result.status !== 0) fail('not inside a git repository');
    return result.stdout.trim();
}

// The tracked files that are regular files in the working tree: a file deleted and not committed is not one.
function presentFiles(root)
{
    const listed = (flags) => gitOutput(root, ['ls-files', '-z', ...flags]).split('\0').filter((file) => file !== '');
    const deleted = new Set(listed(['--deleted']));
    return [...new Set(listed([]))].filter((file) => !deleted.has(file) && isRegularFile(path.join(root, file))).sort();
}

// The hash of each file's working-tree text, with the paths passed as arguments in batches.
function hashFiles(root, files)
{
    const hashes = new Map();
    for (let start = 0; start < files.length; start += HASH_BATCH_SIZE)
    {
        const batch = files.slice(start, start + HASH_BATCH_SIZE);
        const printed = gitOutput(root, ['hash-object', '--', ...batch]).split('\n');
        batch.forEach((file, index) => hashes.set(file, printed[index]));
    }
    return hashes;
}

function listingHash(files, hashes)
{
    const text = [...files].sort().map((file) => `${file} ${hashes.get(file)}\n`).join('');
    return createHash('sha1').update(text).digest('hex');
}

function regularFilesUnder(root, folder)
{
    try
    {
        const entries = readdirSync(path.join(root, folder), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
        return entries.map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
    }
    catch (error)
    {
        if (NOT_A_FOLDER_CODES.has(error.code)) return [];
        throw error;
    }
}

// The scoring hash (the rubric and the currency text) and the folder hash (the whole audit skill, tracked or not).
function auditSkillHashes(root, kind)
{
    const skill = `${AUDIT_SKILL_PREFIX}${kind}`;
    const scoring = SCORING_FILES.map((file) => `${skill}/${file}`).filter((file) => isRegularFile(path.join(root, file)));
    const folder = regularFilesUnder(root, skill);
    const hashes = hashFiles(root, [...new Set([...scoring, ...folder])]);
    return { scoring: listingHash(scoring, hashes), folder: listingHash(folder, hashes) };
}

// The state file as data, or { problem } when it is not an audit state file of this kind.
function parseState(text, kind)
{
    let data;
    try
    {
        data = JSON.parse(text);
    }
    catch (error)
    {
        return { problem: error.message };
    }
    if (!isRecord(data) || data.kind !== kind || !isHashRecord(data.with) || !isRecord(data.items)) return { problem: `not the state of an audit of kind ${kind}` };
    const items = new Map();
    for (const [id, entry] of Object.entries(data.items))
    {
        const sound = isRecord(entry) && STATE_TEXT_KEYS.every((key) => typeof entry[key] === 'string') && typeof entry.atTarget === 'boolean' && isHashRecord(entry.files);
        if (!sound) return { problem: `item ${id} is not an audit entry` };
        items.set(id, { ...entry, files: new Map(Object.entries(entry.files)) });
    }
    return { state: { with: new Map(Object.entries(data.with)), items } };
}

function serializeState(kind, state)
{
    const items = Object.fromEntries(sortedKeys(state.items).map((id) =>
    {
        const { letter, numeric, atTarget, date, run, files, scoring, folder } = state.items.get(id);
        return [id, { letter, numeric, atTarget, date, run, files: sortedRecord(files), scoring, folder }];
    }));
    return `${JSON.stringify({ kind, with: sortedRecord(state.with), items }, null, 2)}\n`;
}

function readState(root, kind)
{
    const relative = stateFilePath(kind);
    let text;
    try
    {
        text = readFileSync(path.join(root, relative), 'utf8');
    }
    catch (error)
    {
        if (error.code === 'ENOENT') return null;
        return fail(`cannot read the state file ${relative}: ${error.code ?? error.message}`);
    }
    const parsed = parseState(text, kind);
    if (parsed.problem !== undefined) fail(`cannot read the state file ${relative}: ${parsed.problem}`);
    return parsed.state;
}

// The state goes to a temp name in its own folder and is renamed over the state file, so a reader never sees half of it.
function writeState(root, kind, state)
{
    const target = path.join(root, stateFilePath(kind));
    const temp = `${target}.${process.pid}.tmp`;
    mkdirSync(path.dirname(target), { recursive: true });
    try
    {
        writeFileSync(temp, serializeState(kind, state));
        renameSync(temp, target);
    }
    catch (error)
    {
        rmSync(temp, { force: true });
        throw error;
    }
}

// The items of an audit: one per root that is a file, else one per first segment below the root that holds a present file,
// less every entry a --with path names or lies under; plus each state id outside the roots. A state id with no present file
// is gone, not an item.
function itemsOf(roots, withPaths, present, stateIds)
{
    const presentSet = new Set(present);
    const entries = new Set();
    for (const root of roots)
    {
        if (presentSet.has(root)) entries.add(root);
        else for (const file of filesUnder(present, root)) entries.add(`${root}/${file.slice(root.length + 1).split('/')[0]}`);
    }
    const audited = [...entries].filter((entry) => ![...withPaths].some((withPath) => isUnder(entry, withPath)));
    const outside = stateIds.filter((id) => ![...roots].some((root) => isUnder(id, root)));
    const items = [...new Set([...audited, ...outside])].sort().map((id) => ({ id, files: filesUnder(present, id) })).filter((item) => item.files.length > 0);
    const gone = stateIds.filter((id) => filesUnder(present, id).length === 0).sort();
    return { items, gone };
}

function sameHashes(first, second)
{
    return first.size === second.size && [...first].every(([file, hash]) => second.get(file) === hash);
}

// The first path, sorted, that is in one map and not the other or has another hash in each; undefined when they agree.
function firstDifference(now, before)
{
    return [...new Set([...now.keys(), ...before.keys()])].sort().find((file) => now.get(file) !== before.get(file));
}

// Why an item is audited, as the text after `audit <id> - `, or null when it keeps its grade. The first rule that holds wins.
function reasonToAudit(item, entry, context)
{
    if (entry === undefined) return 'new';
    if (context.full) return 'full';
    if (!sameHashes(item.hashes, entry.files)) return 'changed';
    const moved = firstDifference(context.withHashes, context.state.with);
    if (moved !== undefined) return `changed (${moved})`;
    if (context.scoring !== entry.scoring) return 'changed (the rubric)';
    if (!entry.atTarget) return `below the target (${entry.letter} / ${entry.numeric})`;
    return null;
}

// Every line `scope` prints. Each item is { id, hashes }; `state` is null where there is no state file.
function scopeLines({ items, gone, state, full, withHashes, scoring, folder })
{
    const context = { full, withHashes, state, scoring };
    const lines = state === null ? ['no earlier audit on this machine'] : [];
    const kept = [];
    let audited = 0;
    for (const item of items)
    {
        const entry = state?.items.get(item.id);
        const reason = reasonToAudit(item, entry, context);
        if (reason !== null)
        {
            audited++;
            lines.push(`audit ${item.id} - ${reason}`);
            continue;
        }
        kept.push(entry);
        lines.push(`carried ${item.id} - ${entry.letter} / ${entry.numeric} from ${entry.date} - ${entry.run}`);
    }
    lines.push(...gone.map((id) => `gone ${id}`), `Scope: ${audited} of ${items.length} items audited, ${kept.length} carried`);
    const earlier = kept.filter((entry) => entry.folder !== folder);
    if (earlier.length > 0)
    {
        const since = earlier.map((entry) => entry.date).sort()[0];
        lines.push(`the audit skill changed since ${since}: ${earlier.length} carried grades stand under the earlier text`);
    }
    lines.push(`Graded under: ${scoring} ${folder}`);
    return lines;
}

// One grades line as { grade }, or { problem }.
function gradeOf(line)
{
    const fields = line.split('\t');
    if (fields.length !== GRADE_FIELDS) return { problem: `expected ${GRADE_FIELDS} tab-separated fields, found ${fields.length}` };
    const [rawId, letter, numeric, flag] = fields;
    const id = checkedPath(rawId);
    if (id.problem !== undefined) return { problem: `the id ${id.problem}` };
    if (!LETTER_PATTERN.test(letter)) return { problem: `letter ${letter} is not A to F with an optional + or -` };
    if (!NUMERIC_PATTERN.test(numeric)) return { problem: `numeric ${numeric} is not a number` };
    if (!Object.hasOwn(AT_TARGET, flag)) return { problem: `${flag} is not ${AT_TARGET.yes} or ${AT_TARGET.no}` };
    return { grade: { id: id.path, letter, numeric, atTarget: flag === AT_TARGET.yes } };
}

function parseGrades(text)
{
    const grades = [];
    const seen = new Set();
    const lines = text.split('\n');
    for (const [index, line] of lines.entries())
    {
        if (line === '') continue;
        const parsed = gradeOf(line);
        const problem = parsed.problem ?? (seen.has(parsed.grade.id) ? `${parsed.grade.id} is named twice` : undefined);
        if (problem !== undefined) return { problem: `line ${index + 1}: ${problem}` };
        seen.add(parsed.grade.id);
        grades.push(parsed.grade);
    }
    return { grades };
}

// The state after a record: each graded id with files stored fresh; each id left out kept while its files and the --with
// files are as stored, else dropped. `filesOf(id)` is a map from the id's present files to their hashes.
function recordState({ previous, grades, filesOf, withHashes, today, run, scoring, folder })
{
    const items = new Map();
    const skipped = [];
    for (const { id, letter, numeric, atTarget } of grades)
    {
        const files = filesOf(id);
        if (files.size === 0) skipped.push(id);
        else items.set(id, { letter, numeric, atTarget, date: today, run, files, scoring, folder });
    }
    const graded = items.size;
    const named = new Set(grades.map((grade) => grade.id));
    const withHeld = previous !== null && sameHashes(withHashes, previous.with);
    let kept = 0;
    let dropped = 0;
    for (const [id, entry] of previous?.items ?? [])
    {
        if (named.has(id)) continue;
        if (withHeld && sameHashes(filesOf(id), entry.files))
        {
            items.set(id, entry);
            kept++;
        }
        else dropped++;
    }
    return { state: { with: withHashes, items }, skipped, counts: { graded, kept, dropped, skipped: skipped.length } };
}

// Everything the two commands read: the roots checked, the present files, the --with files and the state file.
function load(options, root)
{
    for (const rootPath of options.roots)
        if (!existsSync(path.join(root, rootPath))) fail(`root ${rootPath} is not a file or folder in the working tree`);
    const present = presentFiles(root);
    const withFiles = [...options.withPaths].flatMap((withPath) =>
    {
        const files = filesUnder(present, withPath);
        if (files.length === 0) fail(`${OPTION.with} ${withPath} holds no tracked file`);
        return files;
    });
    return { present, withFiles: [...new Set(withFiles)], state: readState(root, options.kind) };
}

const hashMap = (files, hashes) => new Map(files.map((file) => [file, hashes.get(file)]));

function scope(options, root)
{
    const { present, withFiles, state } = load(options, root);
    const { items, gone } = itemsOf(options.roots, options.withPaths, present, state === null ? [] : [...state.items.keys()]);
    const { scoring, folder } = auditSkillHashes(root, options.kind);
    const hashes = hashFiles(root, [...new Set([...items.flatMap((item) => item.files), ...withFiles])]);
    const hashed = items.map((item) => ({ id: item.id, hashes: hashMap(item.files, hashes) }));
    return scopeLines({ items: hashed, gone, state, full: options.full, withHashes: hashMap(withFiles, hashes), scoring, folder });
}

function record(options, root)
{
    let text;
    try
    {
        text = readFileSync(path.resolve(options.grades), 'utf8');
    }
    catch (error)
    {
        fail(`cannot read the grades file ${options.grades}: ${error.code ?? error.message}`);
    }
    const parsed = parseGrades(text);
    if (parsed.problem !== undefined) fail(`${options.grades} ${parsed.problem}`);
    const { present, withFiles, state: previous } = load(options, root);
    const [scoring, folder] = options.under ?? Object.values(auditSkillHashes(root, options.kind));
    const ids = [...parsed.grades.map((grade) => grade.id), ...(previous?.items.keys() ?? [])];
    const hashes = hashFiles(root, [...new Set([...ids.flatMap((id) => filesUnder(present, id)), ...withFiles])]);
    const result = recordState({
        previous,
        grades: parsed.grades,
        filesOf: (id) => hashMap(filesUnder(present, id), hashes),
        withHashes: hashMap(withFiles, hashes),
        today: localDate(new Date()),
        run: options.run,
        scoring,
        folder,
    });
    writeState(root, options.kind, result.state);
    const { graded, kept, dropped, skipped } = result.counts;
    return [
        ...result.skipped.map((id) => `skipped ${id} - no tracked file`),
        `Recorded: ${graded} graded, ${kept} kept, ${dropped} dropped, ${skipped} skipped - ${stateFilePath(options.kind)}`,
    ];
}

function main(args)
{
    const options = parseArguments(args);
    const root = repositoryRoot();
    const lines = options.command === COMMAND.scope ? scope(options, root) : record(options, root);
    process.stdout.write(`${lines.join('\n')}\n`);
    return EXIT.done;
}

try
{
    process.exitCode = main(process.argv.slice(2));
}
catch (error)
{
    // A file the command cannot read or write (an error with a string code) is as unusable as a bad command line.
    if (!(error instanceof UsageError) && typeof error.code !== 'string') throw error;
    console.error(`audit-scope: ${error.message}`);
    process.exitCode = EXIT.usage;
}
