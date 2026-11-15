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
