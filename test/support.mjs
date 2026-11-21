// Shared by the suites: throwaway kits and repos on disk, and a way to run one of the kit's scripts against them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REAL_KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function makeTempDir(t, label)
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `claude-kit-${label}-`));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// `files` maps a path under `root` to its text, or to a value written as JSON.
export function writeFiles(root, files)
{
    for (const [rel, content] of Object.entries(files))
    {
        const target = path.join(root, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
    }
}

// A kit with the real scripts and a shared/ folder the test controls, so a test decides what a sync has to copy.
export function makeKit(t, sharedFiles)
{
    const kit = makeTempDir(t, 'kit');
    fs.cpSync(path.join(REAL_KIT, 'bin'), path.join(kit, 'bin'), { recursive: true });
    writeFiles(path.join(kit, 'shared'), sharedFiles);
    return kit;
}

export function makeRepo(t, files = {})
{
    const repo = makeTempDir(t, 'repo');
    const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
    writeFiles(repo, files);
    return repo;
}

export function runNode(script, args = [], options = {})
{
    const result = spawnSync(process.execPath, [...(options.nodeArgs ?? []), script, ...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export const syncScript = (kit) => path.join(kit, 'bin', 'sync.ts');

export function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export const agentFile = (model) => `---\nname: seat\nmodel: ${model}\n---\n\nBody.\n`;
export const AGENTS = {
    '.claude/agents/plan-grader.md': agentFile('opus'),
    '.claude/agents/audit-planner.md': agentFile('opus'),
    '.claude/agents/audit-editor.md': agentFile('sonnet'),
};

function copyScripts(repo, scripts)
{
    fs.mkdirSync(path.join(repo, '.claude/kit'), { recursive: true });
    for (const script of scripts)
        fs.copyFileSync(path.join(REAL_KIT, 'bin', script), path.join(repo, '.claude/kit', script));
}

// A repo with the three agent files and settings.mjs's scripts copied into .claude/kit, as a sync leaves them.
export function makeSettingsRepo(t, files = AGENTS)
{
    const repo = makeTempDir(t, 'settings');
    writeFiles(repo, files);
    copyScripts(repo, ['settings.mjs', 'kit-settings.mjs', 'constants.mjs']);
    return repo;
}

export function runSettings(repo, args, variables = {})
{
    return runNode(path.join(repo, '.claude/kit/settings.mjs'), args, { env: { PATH: process.env.PATH, ...variables } });
}

// Runs with only the variables the test names, so a KIT_* value of the session running the suite cannot leak in.
export function printSettings(repo, variables = {})
{
    const result = runSettings(repo, [], variables);
    const lines = Object.fromEntries(result.stdout.trimEnd().split('\n').map((line) =>
    {
        const separator = line.indexOf(': ');
        return [line.slice(0, separator), line.slice(separator + 2)];
    }));
    return { status: result.status, lines };
}

// A repo with the three agent files and the status hook's scripts copied into .claude/kit, as a sync leaves them.
export function makeHookRepo(t, files = {})
{
    const repo = makeTempDir(t, 'hook');
    writeFiles(repo, { ...AGENTS, ...files });
    copyScripts(repo, ['status-hook.mjs', 'kit-settings.mjs', 'constants.mjs', 'reply-budget.mjs']);
    return repo;
}

// Feeds the hook script its stdin and returns what it printed, parsed. Only the named variables are in its environment.
export function runHookScript(script, hookInput, variables = {})
{
    const result = spawnSync(process.execPath, [script], {
        input: typeof hookInput === 'string' ? hookInput : JSON.stringify(hookInput),
        env: { PATH: process.env.PATH, ...variables },
        encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

export const runHook = (repo, hookInput, variables = {}) => runHookScript(path.join(repo, '.claude/kit/status-hook.mjs'), hookInput, variables);

// A folder cannot be made read-only on Windows, and root writes into one anyway.
export const cannotLockFolders = () => process.platform === 'win32' || process.getuid?.() === 0;

export const promptInput = (prompt = 'fix the lint') => ({
    session_id: 'session-1',
    hook_event_name: 'UserPromptSubmit',
    prompt,
});

export const KIT_FILE = '.claude/kit/settings.json';
export const readKitFile = (repo) => JSON.parse(fs.readFileSync(path.join(repo, KIT_FILE), 'utf8'));
// What a completed file holds with nothing set and the three agent files of AGENTS: every name, the default for each.
export const DEFAULT_FILE = Object.freeze({
    plan_model: 'opus', audit_model: 'opus', review_model: 'opus', implement_model: 'sonnet', search_model: 'haiku',
    pass_score: 90, scoring: 'on', auto_run: 'off', auto_approve: 'off',
});
// The file holds all nine names, and the names `saved` names hold the values `saved` gives; the rest came from variables or defaults.
export function assertSavedInFile(repo, saved)
{
    const file = readKitFile(repo);
    assert.deepEqual(Object.fromEntries(Object.keys(saved).map((name) => [name, file[name]])), saved);
    assert.deepEqual(Object.keys(DEFAULT_FILE).filter((name) => !Object.hasOwn(file, name)), []);
}
export const kitFileExists = (repo) => fs.existsSync(path.join(repo, KIT_FILE));

// A sibling repo of `repo`, the folder `<repo>/../<name>`, with the files the test names. The name is unique to the repo.
export function makeSibling(t, repo, files)
{
    const name = `sibling-${path.basename(repo)}`;
    const folder = path.join(path.dirname(repo), name);
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    writeFiles(folder, files);
    return name;
}

// bin/prove-plan.mjs, run in a throwaway git repository holding a plan in a folder of its own.
export const PROVE_SCRIPT = path.join(REAL_KIT, 'bin', 'prove-plan.mjs');
export const PLAN_RUN_FOLDER = 'docs/run';
export const PLAN_EXPECTED_FOLDER = `${PLAN_RUN_FOLDER}/expected`;
export const ALPHA_TEXT = 'alpha\nbeta\ngamma\n';

export function runGit(repo, ...args)
{
    const result = spawnSync('git', ['-c', 'user.name=tester', '-c', 'user.email=tester@example.com', '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

export function commitAllFiles(repo, message)
{
    runGit(repo, 'add', '-A');
    runGit(repo, 'commit', '-q', '-m', message);
    return runGit(repo, 'rev-parse', '--short', 'HEAD');
}

// An outer fence one backtick longer than any run inside the text, as the plan format asks.
function fenced(text)
{
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}text\n${text}\n${fence}`;
}

function renderEdit({ n, path: file, kind = 'replace', needs, old, new: replacement })
{
    const lines = [`### E${n} - ${file}`, '', '- Item: demo', `- Kind: ${kind}`];
    if (needs) lines.push(`- Needs: ${needs}`);
    lines.push('');
    if (old !== undefined) lines.push('Old:', '', fenced(old), '');
    if (replacement !== undefined) lines.push('New:', '', fenced(replacement), '');
    return lines.join('\n');
}

// `applies` (a line or lines) sits between the Baseline line and ## Summary; `tail` (lines) follows the last section.
export function renderPlan({ baseline, edits, applies, tail = [] })
{
    const appliesLines = applies === undefined || applies === null ? [] : [applies].flat();
    return [
        '# Audit plan - demo - 2026-11-17', '', `Baseline: ${baseline} - 2026-11-17 10:00`, '',
        ...(appliesLines.length > 0 ? [...appliesLines, ''] : []),
        '## Summary', '', '| Item | Baseline | Edits | Expected |', '|---|---|---|---|', '| demo | 80 | E1 | 90 |', '',
        '## Edits', '', ...edits.map(renderEdit), '## Open questions', '', '- none', '', ...tail,
    ].join('\n');
}

// Every regular file under the run folder, path to text, so a test can show that a run wrote nothing.
export function readRunFolder(p)
{
    const entries = fs.readdirSync(path.join(p.repo, PLAN_RUN_FOLDER), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    return new Map(entries.map((entry) =>
    {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(p.repo, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')];
    }));
}

// A repository with one commit holding `files`; `plan(edits)` writes plan.md at its Baseline, `run(...)` runs the prover in it.
export function makePlanProject(t, files)
{
    const repo = makeRepo(t, files);
    const baseline = commitAllFiles(repo, 'baseline');
    const plan = (edits, { name = 'plan.md', rev = baseline, applies, tail } = {}) =>
    {
        const file = `${PLAN_RUN_FOLDER}/${name}`;
        writeFiles(repo, { [file]: renderPlan({ baseline: rev, edits, applies, tail }) });
        return file;
    };
    const run = (...args) => runNode(PROVE_SCRIPT, args, { cwd: repo });
    const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
    const exists = (rel) => fs.existsSync(path.join(repo, rel));
    const list = (rel) => fs.readdirSync(path.join(repo, rel), { recursive: true }).map((name) => name.split(path.sep).join('/')).sort();
    return { repo, baseline, plan, run, read, exists, list };
}

export const makeReplaceEdit = (n, file, old, replacement, more = {}) => ({ n, path: file, kind: 'replace', old, new: replacement, ...more });

// bin/audit-scope.mjs, run in a throwaway git repository of rules, skills and hooks.
export const SCOPE_SCRIPT = path.join(REAL_KIT, 'bin', 'audit-scope.mjs');
export const SCOPE_SKILL = '.claude/skills/repo-audit-rules';
export const SCOPE_RUN = 'docs/superpowers/audits/2026-11-17-rules';
export const SCOPE_STATE = 'docs/superpowers/audits/state/rules.json';
export const GRADES_FILE = 'docs/grades.tsv';
export const GRADES_A_AND_B = 'rules/a.md\tA\t9\tyes\nrules/b.md\tA\t9.5\tyes\n';
export const GRADES_A_ONLY = 'rules/a.md\tA\t9\tyes\n';
const GRADED = /^Graded under: [0-9a-f]{40} [0-9a-f]{40}$/;
export const WITH_DEFAULTS = ['--with', 'cfg/defaults.json', 'rules'];
const FILES = {
    '.gitignore': '.claude/\ndocs/\n',
    'rules/a.md': 'A\n',
    'rules/b.md': 'B\n',
    'AGENTS.md': 'agents\n',
    'skills/one/SKILL.md': 'one\n',
    'skills/one/references/x.md': 'x\n',
    'skills/two/SKILL.md': 'two\n',
    'hooks/guard.mjs': 'guard\n',
    'hooks/helper.mjs': 'helper\n',
    'hooks/data/list.json': '[]\n',
    'cfg/defaults.json': '{}\n',
    [`${SCOPE_SKILL}/SKILL.md`]: 'audit\n',
    [`${SCOPE_SKILL}/references/rubric.md`]: 'rubric\n',
    [`${SCOPE_SKILL}/references/currency.md`]: 'currency\n',
};

const localDate = (now) => [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
export const TODAY = localDate(new Date());
export const EARLIER = daysAgo(20);
export const LATER = daysAgo(10);

export function daysAgo(count)
{
    const now = new Date();
    return localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - count));
}

export const carriedLine = (id, grade, date = TODAY) => `carried ${id} - ${grade} from ${date} - ${SCOPE_RUN}`;
const splitOptions = (args) => (typeof args.at(-1) === 'object' ? [args.slice(0, -1), args.at(-1)] : [args, {}]);

// The lines a successful run printed, less its last one, which always says what the grades were given under.
export function printedLines(result)
{
    assert.equal(result.stderr, '');
    assert.equal(result.status, 0);
    const printed = result.stdout.split('\n');
    assert.equal(printed.pop(), '');
    assert.match(printed.pop(), GRADED);
    return printed;
}

export function expectRefused(result, message)
{
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    if (message === undefined) assert.match(result.stderr, /^audit-scope: [^\n]+\n$/);
    else assert.equal(result.stderr, `audit-scope: ${message}\n`);
}

// A repository holding FILES, all committed but what .gitignore leaves out. `scope` and `record` take the kind as an option last.
export function makeScopeProject(t)
{
    const repo = makeRepo(t, FILES);
    runGit(repo, 'add', '-A');
    runGit(repo, 'commit', '-q', '-m', 'baseline');
    const run = (args, { cwd = repo } = {}) => runNode(SCOPE_SCRIPT, args, { cwd });
    const stateFile = (kind) => path.join(repo, `docs/superpowers/audits/state/${kind}.json`);
    return {
        repo,
        run,
        scope(...args)
        {
            const [rest, { kind = 'rules', cwd }] = splitOptions(args);
            return run(['scope', kind, ...rest], { cwd });
        },
        record(grades, ...args)
        {
            const [rest, { kind = 'rules' }] = splitOptions(args);
            writeFiles(repo, { [GRADES_FILE]: grades });
            return run(['record', kind, '--run', `docs/superpowers/audits/2026-11-17-${kind}`, '--grades', GRADES_FILE, ...rest]);
        },
        state: (kind = 'rules') => JSON.parse(fs.readFileSync(stateFile(kind), 'utf8')),
        setState(change, kind = 'rules')
        {
            const state = JSON.parse(fs.readFileSync(stateFile(kind), 'utf8'));
            change(state);
            fs.writeFileSync(stateFile(kind), `${JSON.stringify(state, null, 2)}\n`);
        },
        write: (rel, text) => writeFiles(repo, { [rel]: text }),
        remove: (rel) => fs.rmSync(path.join(repo, rel)),
        add: (...rels) => runGit(repo, 'add', ...rels),
        commit: () => runGit(repo, 'commit', '-q', '-m', 'more'),
        tree()
        {
            const entries = fs.readdirSync(repo, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
            const files = entries.map((entry) => path.relative(repo, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
            return new Map(files.filter((rel) => !rel.startsWith('.git/')).sort().map((rel) => [rel, fs.readFileSync(path.join(repo, rel), 'utf8')]));
        },
    };
}

// The grades file the helper writes is no change a run made.
export const withoutGradesFile = (tree) => new Map([...tree].filter(([rel]) => rel !== GRADES_FILE));
