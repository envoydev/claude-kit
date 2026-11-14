#!/usr/bin/env node
// Copies the shared Claude Code files into each repo and records what it wrote.
//
//   node bin/sync.ts <repo dir>...           write the files, the lock and the check script
//   node bin/sync.ts --check <repo dir>...   write nothing; exit 1 when a repo differs from the kit
//
// What lands in a repo:
//   - every file under shared/.claude/ at the same path under <repo>/.claude/, overwritten;
//   - <repo>/.claude/kit/lock.json (the kit commit and a sha256 per managed file) and check.mjs, which the
//     repo runs (npm run kit:check) to fail on a local edit of a managed file;
//   - shared/settings.base.json merged into <repo>/.claude/settings.json: the deny list joined, the base
//     plugins switched on beside the repo's own, every other key the repo's;
//   - shared/mcp.json as <repo>/.mcp.json only when the repo has none - it is machine-local in every repo.
// A file an older sync wrote that the kit no longer has is removed while it still hashes to its lock entry;
// one edited since is kept and named.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Lock = { kit: string; files: Record<string, string> };
type Settings = Record<string, unknown> & {
    permissions?: { deny?: string[] } & Record<string, unknown>;
    enabledPlugins?: Record<string, boolean>;
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
        if (key !== 'permissions' && key !== 'enabledPlugins') out[key] = value;
    return out;
}

function readJson<T>(file: string, fallback: T): T
{
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
    catch (err) { if ((err as { code?: string }).code === 'ENOENT') return fallback; throw err; }
}

function syncRepo(repo: string, check: boolean, kit: string): string[]
{
    const notes: string[] = [];
    const managed = listFiles(path.join(SHARED, '.claude')).map((rel) => `.claude/${rel}`);
    const lockFile = path.join(repo, '.claude', 'kit', 'lock.json');
    const old = readJson<Lock>(lockFile, { kit: '', files: {} });
    const lock: Lock = { kit, files: {} };

    const write = (rel: string, data: Buffer | string): void =>
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

    for (const rel of managed)
    {
        const data = fs.readFileSync(path.join(SHARED, rel));
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
        if (!check) fs.rmSync(target);
    }

    write('.claude/kit/check.mjs', fs.readFileSync(path.join(KIT, 'bin', 'check.mjs')));
    write('.claude/kit/README.md', fs.readFileSync(path.join(KIT, 'bin', 'kit-readme.md')));

    const settingsFile = path.join(repo, '.claude', 'settings.json');
    const base = readJson<Settings>(path.join(SHARED, 'settings.base.json'), {});
    write('.claude/settings.json', `${JSON.stringify(mergeSettings(readJson<Settings>(settingsFile, {}), base), null, 2)}\n`);

    if (!fs.existsSync(path.join(repo, '.mcp.json'))) write('.mcp.json', fs.readFileSync(path.join(SHARED, 'mcp.json')));

    // The lock changes with the kit revision alone, so it is not a difference worth reporting under --check.
    const lockText = `${JSON.stringify(lock, null, 2)}\n`;
    if (!check)
    {
        fs.mkdirSync(path.dirname(lockFile), { recursive: true });
        fs.writeFileSync(lockFile, lockText);
    }
    return notes;
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
    for (const repo of repos)
    {
        if (!fs.existsSync(path.join(repo, '.git')))
        {
            console.error(`${repo}: not a git checkout - skipped`);
            differs = true;
            continue;
        }
        const notes = syncRepo(repo, check, kit);
        console.log(`${path.basename(repo)}: ${notes.length ? `${notes.length} change(s)` : 'current'}${check ? ' (check only)' : ''}`);
        for (const n of notes) console.log(`  ${n}`);
        if (notes.length) differs = true;
    }
    return check && differs ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
