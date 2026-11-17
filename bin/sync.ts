#!/usr/bin/env node
// Copies the shared Claude Code files into each repo and records what it wrote.
//
//   node bin/sync.ts <repo dir>...           write the files, the lock and the check script
//   node bin/sync.ts --check <repo dir>...   write nothing; exit 1 when a repo differs from the kit
//
// What lands in a repo:
//   - every file in a folder under shared/ (rules/, skills/, agents/) at the same path under <repo>/.claude/, overwritten;
//   - <repo>/.claude/kit/lock.json (the kit commit and a sha256 per managed file) and check.mjs, which the
//     repo runs (npm run kit:check) to fail on a local edit of a managed file;
//   - <repo>/.claude/kit/settings.mjs, kit-settings.mjs, constants.mjs and status-hook.mjs: the pass score, the four role
//     models and the two switches the repo's .claude/kit/settings.json and the KIT_* variables carry, printed and saved
//     for the skills that read them and added to every request by the UserPromptSubmit hook;
//   - shared/settings.base.json merged into <repo>/.claude/settings.json: the deny list joined, the base
//     plugins switched on beside the repo's own, the kit's hooks added after the repo's own for each event, every
//     other key the base carries taken from it and the rest the repo's;
//   - shared/mcp.json merged into <repo>/.mcp.json: each kit server replaces the one of its name, the repo's own
//     servers and keys are kept. The file is machine-local and git-ignored in every repo, so each machine syncs.
//   - shared/retired.json names the plugins and MCP servers the kit shared once and dropped: both merges only add,
//     so each sync takes those out of the project's settings and .mcp.json. An install record is left to the CLI.
// The kit's own dir (.) takes the same files, so a session in it loads the rules and skills it shares. They are
// copies of shared/ and git-ignored there; only its settings, its .claude/kit/repo.json and its .claude/kit/settings.json
// are tracked.
// A file an older sync wrote that the kit no longer has is removed while it still hashes to its lock entry;
// one edited since is kept and named. A managed file the repo's .gitignore hides is named too.
//
// A shared file ending in .tmpl is written without that suffix, each {{key}} filled from the repo's own
// .claude/kit/repo.json (a string, or an array of lines). The repo owns that file; the lock holds the filled
// file's hash, so a local edit fails kit:check like any other. shared/defaults.json holds the kit's own value for a
// key (the model the plan grader runs on); a key neither file defines fails the sync.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Lock = { kit: string; files: Record<string, string> };
type RepoVars = Readonly<Record<string, string | readonly string[]>>;
type McpConfig = Record<string, unknown> & { mcpServers?: Record<string, unknown> };
type Retired = { plugins?: readonly string[]; mcpServers?: readonly string[] };
type HookGroup = Record<string, unknown> & { hooks?: readonly { command?: unknown }[] };
type HookMap = Record<string, readonly HookGroup[]>;
type Settings = Record<string, unknown> & {
    permissions?: { deny?: string[] } & Record<string, unknown>;
    enabledPlugins?: Record<string, boolean>;
    hooks?: HookMap;
};

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = path.join(KIT, 'shared');
const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

function kitRevision(): string
{
    try
    {
        const head = execFileSync('git', ['-C', KIT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
        const dirty = execFileSync('git', ['-C', KIT, 'status', '--porcelain', '--', 'shared', 'bin'], { encoding: 'utf8' }).trim();
        return `claude-kit@${head}${dirty ? '-dirty' : ''}`;
    }
    catch { return 'claude-kit@uncommitted'; }
}

function listFiles(dir: string, base = dir): string[]
{
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    {
        const full = path.join(dir, entry.name);
        if (entry.name === '.DS_Store') return [];
        return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')];
    });
}

function mergeSettings(current: Settings, base: Settings): Settings
{
    const out: Settings = { ...current };
    const deny = [...(base.permissions?.deny ?? [])];
    for (const rule of current.permissions?.deny ?? []) if (!deny.includes(rule)) deny.push(rule);
    out.permissions = { ...current.permissions, deny };
    out.enabledPlugins = { ...current.enabledPlugins, ...base.enabledPlugins };
    for (const [key, value] of Object.entries(base))
        if (key !== 'permissions' && key !== 'enabledPlugins' && key !== 'hooks') out[key] = value;
    const hooks = mergeHooks(current.hooks ?? {}, base.hooks ?? {});
    if (Object.keys(hooks).length) out.hooks = hooks;
    else delete out.hooks;
    return out;
}

// A hook the kit shares runs a script under .claude/kit/, and that path is how one is told from a repo's own.
const KIT_HOOK_PATH = '.claude/kit/';

function isKitHookGroup(group: HookGroup): boolean
{
    return (group.hooks ?? []).some((hook) => typeof hook.command === 'string' && hook.command.includes(KIT_HOOK_PATH));
}

// Per event: the repo's own hook groups, then the kit's. A kit hook the base no longer carries is dropped, so a
// shared hook is retired by deleting it from settings.base.json.
function mergeHooks(current: HookMap, base: HookMap): HookMap
{
    const merged: HookMap = {};
    for (const event of new Set([...Object.keys(current), ...Object.keys(base)]))
    {
        const own = Array.isArray(current[event]) ? current[event].filter((group) => !isKitHookGroup(group)) : [];
        const groups = [...own, ...(base[event] ?? [])];
        if (groups.length) merged[event] = groups;
    }
    return merged;
}

function readJson<T>(file: string, fallback: T): T
{
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
    catch (err) { if ((err as { code?: string }).code === 'ENOENT') return fallback; throw err; }
}

// What lands in <repo>/.claude/kit beside the lock: the name there, and the file under bin/ it is copied from.
const KIT_FILES: readonly (readonly [shipped: string, source: string])[] = [
    ['check.mjs', 'check.mjs'],
    ['settings.mjs', 'settings.mjs'],
    ['kit-settings.mjs', 'kit-settings.mjs'],
    ['constants.mjs', 'constants.mjs'],
    ['status-hook.mjs', 'status-hook.mjs'],
    ['prove-plan.mjs', 'prove-plan.mjs'],
    ['audit-scope.mjs', 'audit-scope.mjs'],
    ['README.md', 'kit-readme.md'],
];

const TEMPLATE = '.tmpl';
const SLOT = /\{\{([a-z_]+)\}\}/g;

function render(source: string, text: string, vars: RepoVars, varsFile: string): string
{
    const missing = new Set<string>();
    const out = text.replace(SLOT, (_slot, key: string) =>
    {
        const value = Object.hasOwn(vars, key) ? vars[key] : undefined;
        if (value === undefined) { missing.add(key); return ''; }
        return typeof value === 'string' ? value : value.join('\n');
    });
    if (missing.size) throw new Error(`${source} needs ${[...missing].join(', ')} in ${varsFile}`);
    return out;
}

type Write = (rel: string, data: Buffer | string) => void;

// Writes a file only when its bytes change, naming each change; under --check it names and writes nothing.
function writer(repo: string, check: boolean, notes: string[]): Write
{
    return (rel, data) =>
    {
        const target = path.join(repo, rel);
        let have: Buffer | null = null;
        try { have = fs.readFileSync(target); } catch { /* absent */ }
        if (have && sha(have) === sha(data)) return;
        notes.push(`${have ? 'update' : 'add'} ${rel}`);
        if (check) return;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
    };
}

// The plugins and the MCP servers every project gets: settings.base.json into .claude/settings.json, mcp.json into
// .mcp.json, each merged over what the project already has.
// A merge only adds, so what the kit once shared and dropped is named in retired.json and taken out of every project.
function syncSettings(repo: string, write: Write): void
{
    const retired = readJson<Retired>(path.join(SHARED, 'retired.json'), {});
    const settingsFile = path.join(repo, '.claude', 'settings.json');
    const base = readJson<Settings>(path.join(SHARED, 'settings.base.json'), {});
    const settings = mergeSettings(readJson<Settings>(settingsFile, {}), base);
    settings.enabledPlugins = without(settings.enabledPlugins ?? {}, retired.plugins ?? []);
    write('.claude/settings.json', `${JSON.stringify(settings, null, 2)}\n`);

    const mcp = readJson<McpConfig>(path.join(repo, '.mcp.json'), {});
    const kitMcp = readJson<McpConfig>(path.join(SHARED, 'mcp.json'), {});
    const servers = without({ ...mcp.mcpServers, ...kitMcp.mcpServers }, retired.mcpServers ?? []);
    write('.mcp.json', `${JSON.stringify({ ...mcp, mcpServers: servers }, null, 2)}\n`);
}

function without<T>(record: Readonly<Record<string, T>>, names: readonly string[]): Record<string, T>
{
    return Object.fromEntries(Object.entries(record).filter(([name]) => !names.includes(name)));
}

function syncRepo(repo: string, check: boolean, kit: string): string[]
{
    const notes: string[] = [];
    // Every folder under shared/ is copied into <repo>/.claude/; the files beside them are merged, never copied.
    const sources = listFiles(SHARED).filter((rel) => rel.includes('/'));
    const varsFile = path.join(repo, '.claude', 'kit', 'repo.json');
    // The kit's own value for a key, where it has one, stands until the repo sets that key itself.
    const vars: RepoVars = { ...readJson<RepoVars>(path.join(SHARED, 'defaults.json'), {}), ...readJson<RepoVars>(varsFile, {}) };
    const varsName = path.relative(repo, varsFile).split(path.sep).join('/');
    const lockFile = path.join(repo, '.claude', 'kit', 'lock.json');
    const old = readJson<Lock>(lockFile, { kit: '', files: {} });
    const lock: Lock = { kit, files: {} };

    const write = writer(repo, check, notes);

    // Render every file before writing any, so a missing key leaves the repo untouched.
    const files = sources.map((source) =>
    {
        const rel = `.claude/${source}`;
        if (!source.endsWith(TEMPLATE)) return { rel, data: fs.readFileSync(path.join(SHARED, source)) };
        const text = fs.readFileSync(path.join(SHARED, source), 'utf8');
        return { rel: rel.slice(0, -TEMPLATE.length), data: render(`shared/${source}`, text, vars, varsName) };
    });
    for (const { rel, data } of files)
    {
        lock.files[rel] = sha(data);
        write(rel, data);
    }

    for (const [rel, hash] of Object.entries(old.files))
    {
        if (rel in lock.files) continue;
        const target = path.join(repo, rel);
        if (!fs.existsSync(target)) continue;
        if (sha(fs.readFileSync(target)) !== hash) { notes.push(`kept ${rel}: the kit dropped it, but it was edited here`); continue; }
        notes.push(`remove ${rel}`);
        if (check) continue;
        fs.rmSync(target);
        pruneEmptyDirs(path.dirname(target), path.join(repo, '.claude'));
    }

    for (const [shipped, source] of KIT_FILES) write(`.claude/kit/${shipped}`, fs.readFileSync(path.join(KIT, 'bin', source)));

    syncSettings(repo, write);

    // The lock changes with the kit revision alone, so it is not a difference worth reporting under --check.
    const lockText = `${JSON.stringify(lock, null, 2)}\n`;
    if (!check)
    {
        fs.mkdirSync(path.dirname(lockFile), { recursive: true });
        fs.writeFileSync(lockFile, lockText);
    }
    // The kit ignores its own copies on purpose: shared/ is what it commits.
    if (repo === KIT) return notes;
    for (const rel of ignoredByGit(repo, [...Object.keys(lock.files), '.claude/kit/lock.json']))
        notes.push(`ignored by git: ${rel} - a commit leaves it out and kit:check fails on a fresh clone; allow it in .gitignore`);
    return notes;
}

// A folder its last removed file leaves empty goes too - a renamed skill would otherwise leave its old folder behind.
function pruneEmptyDirs(dir: string, stop: string): void
{
    while (dir.startsWith(stop + path.sep) && fs.readdirSync(dir).length === 0)
    {
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
    }
}

// The managed paths the repo's .gitignore hides and the index does not track (git check-ignore skips tracked files).
function ignoredByGit(repo: string, rels: readonly string[]): string[]
{
    try
    {
        const out = execFileSync('git', ['-C', repo, 'check-ignore', '--stdin'], { input: rels.join('\n'), encoding: 'utf8' });
        return out.split('\n').filter((line) => line !== '');
    }
    catch (err)
    {
        if ((err as { status?: number }).status === 1) return [];
        throw err;
    }
}

function main(argv: string[]): number
{
    const check = argv.includes('--check');
    const repos = argv.filter((a) => a !== '--check').map((a) => path.resolve(a));
    if (!repos.length)
    {
        console.error('usage: node bin/sync.ts [--check] <repo dir>...');
        return 2;
    }
    const kit = kitRevision();
    let differs = false;
    let failed = false;
    for (const repo of repos)
    {
        if (!fs.existsSync(path.join(repo, '.git')))
        {
            console.error(`${repo}: not a git checkout - skipped`);
            differs = true;
            failed = true;
            continue;
        }
        let notes: string[];
        try { notes = syncRepo(repo, check, kit); }
        catch (err)
        {
            console.error(`${path.basename(repo)}: ${(err as Error).message} - nothing written`);
            differs = true;
            failed = true;
            continue;
        }
        console.log(`${path.basename(repo)}: ${notes.length ? `${notes.length} change(s)` : 'current'}${check ? ' (check only)' : ''}`);
        for (const n of notes) console.log(`  ${n}`);
        if (notes.length) differs = true;
    }
    return failed || (check && differs) ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
