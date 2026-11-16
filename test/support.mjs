// Shared by the suites: throwaway kits and repos on disk, and a way to run one of the kit's scripts against them.
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
    const result = spawnSync(process.execPath, [script, ...args], {
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
    copyScripts(repo, ['status-hook.mjs', 'kit-settings.mjs', 'constants.mjs']);
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
