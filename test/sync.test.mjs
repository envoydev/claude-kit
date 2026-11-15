// bin/sync.ts, run as the command it is, against a throwaway kit and a throwaway repo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REAL_KIT, makeKit, makeRepo, makeTempDir, readJson, runNode, syncScript } from './support.mjs';

const SHARED = {
    'rules/alpha.md': '# Alpha\n',
    'skills/demo/SKILL.md.tmpl': 'name: {{name}}\n{{checks}}\nmodel: {{review_model}}\n',
    'defaults.json': { review_model: 'opus' },
    'settings.base.json': {
        permissions: { deny: ['Read(.env)'] },
        enabledPlugins: { 'kept@market': true },
        autoCompactWindow: 400000,
    },
    'mcp.json': { mcpServers: { context7: { type: 'http', url: 'https://kit.example/mcp' } } },
    'retired.json': { plugins: ['old@market'], mcpServers: ['gone'] },
};
const REPO_VARS = { '.claude/kit/repo.json': { name: 'demo-repo', checks: ['- lint', '- test'] } };

const sync = (kit, ...args) => runNode(syncScript(kit), args);
const exists = (repo, rel) => fs.existsSync(path.join(repo, rel));
const read = (repo, rel) => fs.readFileSync(path.join(repo, rel), 'utf8');

test('copies a shared file to the same path under .claude and records it in the lock', (t) =>
{
    const kit = makeKit(t, SHARED);
    const repo = makeRepo(t, REPO_VARS);

    const result = sync(kit, repo);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(read(repo, '.claude/rules/alpha.md'), '# Alpha\n');
    const lock = readJson(path.join(repo, '.claude/kit/lock.json'));
    assert.deepEqual(Object.keys(lock.files).sort(), ['.claude/rules/alpha.md', '.claude/skills/demo/SKILL.md']);
    assert.match(lock.kit, /^claude-kit@/);
});

test('ships the check, settings and status-hook scripts and the readme into .claude/kit', (t) =>
{
    const kit = makeKit(t, SHARED);
    const repo = makeRepo(t, REPO_VARS);

    sync(kit, repo);

    const shippedFiles = [
        ['check.mjs', 'check.mjs'],
        ['settings.mjs', 'settings.mjs'],
        ['kit-settings.mjs', 'kit-settings.mjs'],
        ['constants.mjs', 'constants.mjs'],
        ['status-hook.mjs', 'status-hook.mjs'],
        ['README.md', 'kit-readme.md'],
    ];
    for (const [shipped, source] of shippedFiles)
        assert.equal(read(repo, `.claude/kit/${shipped}`), fs.readFileSync(path.join(kit, 'bin', source), 'utf8'), shipped);
});

test('fills a template from repo.json and the kit defaults, and drops the .tmpl suffix', (t) =>
{
    const kit = makeKit(t, SHARED);
    const repo = makeRepo(t, REPO_VARS);

    sync(kit, repo);

    assert.equal(read(repo, '.claude/skills/demo/SKILL.md'), 'name: demo-repo\n- lint\n- test\nmodel: opus\n');
    assert.equal(exists(repo, '.claude/skills/demo/SKILL.md.tmpl'), false);
});

test("a repo's own value for a key outranks the kit default", (t) =>
{
    const kit = makeKit(t, SHARED);
    const repo = makeRepo(t, { '.claude/kit/repo.json': { name: 'demo-repo', checks: [], review_model: 'fable' } });

    sync(kit, repo);

    assert.match(read(repo, '.claude/skills/demo/SKILL.md'), /^model: fable$/m);
});

test('a template key nobody defines fails the repo before anything is written', (t) =>
{
    const kit = makeKit(t, SHARED);
    const repo = makeRepo(t, { '.claude/kit/repo.json': { checks: [] } });

    const result = sync(kit, repo);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs name in \.claude\/kit\/repo\.json - nothing written/);
    assert.equal(exists(repo, '.claude/rules/alpha.md'), false);
    assert.equal(exists(repo, '.claude/kit/lock.json'), false);
    assert.equal(exists(repo, '.claude/settings.json'), false);
});

test('--check names what a sync would change, writes nothing and exits 1', (t) =>
{
    const kit = makeKit(t, SHARED);
    const repo = makeRepo(t, REPO_VARS);

    const result = sync(kit, '--check', repo);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /\(check only\)/);
    assert.match(result.stdout, /add \.claude\/rules\/alpha\.md/);
    assert.equal(exists(repo, '.claude/rules'), false);
    assert.equal(exists(repo, '.claude/kit/lock.json'), false);
});

test('a second sync, and a --check after it, find the repo current', (t) =>
{
    const kit = makeKit(t, SHARED);
    const repo = makeRepo(t, REPO_VARS);
    sync(kit, repo);

    const again = sync(kit, repo);
    const check = sync(kit, '--check', repo);

    assert.match(again.stdout, /: current$/m);
    assert.equal(check.status, 0, check.stdout);
    assert.match(check.stdout, /: current \(check only\)$/m);
});

test("the settings merge keeps the repo's own keys, joins the deny list and drops a retired plugin", (t) =>
{
    const kit = makeKit(t, SHARED);
    const repo = makeRepo(t, {
        ...REPO_VARS,
        '.claude/settings.json': {
            env: { KIT_PASS_SCORE: '95' },
            model: 'opus',
            autoCompactWindow: 1,
            permissions: { deny: ['Read(secret.txt)', 'Read(.env)'], allow: ['Bash(npm test)'] },
            enabledPlugins: { 'own@market': true, 'old@market': true },
        },
    });

    sync(kit, repo);

    const settings = readJson(path.join(repo, '.claude/settings.json'));
    assert.deepEqual(settings.env, { KIT_PASS_SCORE: '95' });
    assert.equal(settings.model, 'opus');
    assert.equal(settings.autoCompactWindow, 400000, 'a key the base carries takes the base value');
    assert.deepEqual(settings.permissions.deny, ['Read(.env)', 'Read(secret.txt)']);
    assert.deepEqual(settings.permissions.allow, ['Bash(npm test)']);
    assert.deepEqual(settings.enabledPlugins, { 'own@market': true, 'kept@market': true });
});

test("the MCP merge keeps the repo's own servers, replaces a kit server and drops a retired one", (t) =>
{
    const kit = makeKit(t, SHARED);
    const repo = makeRepo(t, {
        ...REPO_VARS,
        '.mcp.json': {
            note: 'kept',
            mcpServers: {
                mine: { command: 'mine' },
                context7: { type: 'http', url: 'https://stale.example/mcp' },
                gone: { command: 'gone' },
            },
        },
    });

    sync(kit, repo);

    const mcp = readJson(path.join(repo, '.mcp.json'));
    assert.equal(mcp.note, 'kept');
    assert.deepEqual(mcp.mcpServers, {
        mine: { command: 'mine' },
        context7: { type: 'http', url: 'https://kit.example/mcp' },
    });
});

test('a file the kit dropped is removed, and the folder it leaves empty goes with it', (t) =>
{
    const kit = makeKit(t, { ...SHARED, 'skills/old-name/SKILL.md': '# Old\n' });
    const repo = makeRepo(t, REPO_VARS);
    sync(kit, repo);
    fs.rmSync(path.join(kit, 'shared/skills/old-name'), { recursive: true });

    const result = sync(kit, repo);

    assert.match(result.stdout, /remove \.claude\/skills\/old-name\/SKILL\.md/);
    assert.equal(exists(repo, '.claude/skills/old-name'), false);
    assert.equal(exists(repo, '.claude/skills/demo/SKILL.md'), true);
    assert.equal('.claude/skills/old-name/SKILL.md' in readJson(path.join(repo, '.claude/kit/lock.json')).files, false);
});

test('a dropped file that was edited in the repo is kept and named', (t) =>
{
    const kit = makeKit(t, { ...SHARED, 'rules/beta.md': '# Beta\n' });
    const repo = makeRepo(t, REPO_VARS);
    sync(kit, repo);
    fs.rmSync(path.join(kit, 'shared/rules/beta.md'));
    fs.appendFileSync(path.join(repo, '.claude/rules/beta.md'), 'a local line\n');

    const result = sync(kit, repo);

    assert.match(result.stdout, /kept \.claude\/rules\/beta\.md: the kit dropped it, but it was edited here/);
    assert.equal(read(repo, '.claude/rules/beta.md'), '# Beta\na local line\n');
});

test("a managed file the repo's .gitignore hides is named", (t) =>
{
    const kit = makeKit(t, SHARED);
    const repo = makeRepo(t, { ...REPO_VARS, '.gitignore': '.claude/rules/\n' });

    const result = sync(kit, repo);

    assert.match(result.stdout, /ignored by git: \.claude\/rules\/alpha\.md/);
    assert.doesNotMatch(result.stdout, /ignored by git: \.claude\/skills\/demo\/SKILL\.md/);
});

test('a folder that is not a git checkout is skipped, and the run fails', (t) =>
{
    const kit = makeKit(t, SHARED);
    const plainDir = makeTempDir(t, 'plain');

    const result = sync(kit, plainDir);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a git checkout - skipped/);
    assert.equal(exists(plainDir, '.claude'), false);
});

test('one failing repo does not stop the next one from being synced', (t) =>
{
    const kit = makeKit(t, SHARED);
    const brokenRepo = makeRepo(t, { '.claude/kit/repo.json': {} });
    const goodRepo = makeRepo(t, REPO_VARS);

    const result = sync(kit, brokenRepo, goodRepo);

    assert.equal(result.status, 1);
    assert.equal(exists(brokenRepo, '.claude/rules/alpha.md'), false);
    assert.equal(exists(goodRepo, '.claude/rules/alpha.md'), true);
});

test('with no repo named it prints the usage and exits 2', (t) =>
{
    const kit = makeKit(t, SHARED);

    const result = sync(kit);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: node bin\/sync\.ts/);
});

// The one test on the real shared/ folder: what ships today syncs into a fresh repo and passes its own check.
test("the real kit syncs into a fresh repo with the kit's own repo.json, fills every template and passes kit:check", (t) =>
{
    const repo = makeRepo(t);
    fs.mkdirSync(path.join(repo, '.claude/kit'), { recursive: true });
    fs.copyFileSync(path.join(REAL_KIT, '.claude/kit/repo.json'), path.join(repo, '.claude/kit/repo.json'));

    const result = sync(REAL_KIT, repo);

    assert.equal(result.status, 0, result.stderr);
    const templates = fs.readdirSync(path.join(REAL_KIT, 'shared'), { recursive: true })
        .map((rel) => rel.split(path.sep).join('/'))
        .filter((rel) => rel.endsWith('.tmpl'));
    assert.notEqual(templates.length, 0);
    for (const template of templates)
        assert.doesNotMatch(read(repo, `.claude/${template.slice(0, -'.tmpl'.length)}`), /\{\{[a-z_]+\}\}/, template);
    const check = runNode(path.join(repo, '.claude/kit/check.mjs'));
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /managed files match claude-kit@/);
});

const KIT_HOOK = { hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/kit/status-hook.mjs"', timeout: 10 }] };
const OWN_HOOK = { hooks: [{ type: 'command', command: 'node scripts/own-hook.js' }] };
const sharedWithHook = (hooks) => ({ ...SHARED, 'settings.base.json': { ...SHARED['settings.base.json'], hooks } });
const settingsOf = (repo) => readJson(path.join(repo, '.claude/settings.json'));

test("the kit's hook is added to a repo's settings beside the repo's own hooks", (t) =>
{
    const kit = makeKit(t, sharedWithHook({ UserPromptSubmit: [KIT_HOOK] }));
    const repo = makeRepo(t, {
        ...REPO_VARS,
        '.claude/settings.json': { hooks: { UserPromptSubmit: [OWN_HOOK], Stop: [OWN_HOOK] } },
    });

    sync(kit, repo);

    assert.deepEqual(settingsOf(repo).hooks, { UserPromptSubmit: [OWN_HOOK, KIT_HOOK], Stop: [OWN_HOOK] });
});

test("a kit hook already in the settings is replaced, never doubled, and a second sync finds the repo current", (t) =>
{
    const kit = makeKit(t, sharedWithHook({ UserPromptSubmit: [KIT_HOOK] }));
    const staleKitHook = { hooks: [{ type: 'command', command: 'node .claude/kit/old-hook.mjs' }] };
    const repo = makeRepo(t, { ...REPO_VARS, '.claude/settings.json': { hooks: { UserPromptSubmit: [staleKitHook] } } });

    sync(kit, repo);
    const again = sync(kit, repo);

    assert.deepEqual(settingsOf(repo).hooks, { UserPromptSubmit: [KIT_HOOK] });
    assert.match(again.stdout, /: current$/m);
});

test('a hook the kit no longer shares is taken out of the settings, and an emptied hooks block goes with it', (t) =>
{
    const kit = makeKit(t, SHARED);
    const repo = makeRepo(t, { ...REPO_VARS, '.claude/settings.json': { hooks: { UserPromptSubmit: [KIT_HOOK] } } });

    sync(kit, repo);

    assert.equal('hooks' in settingsOf(repo), false);
});

test('a repo with no hooks and a kit with none gets no hooks key', (t) =>
{
    const kit = makeKit(t, SHARED);
    const repo = makeRepo(t, REPO_VARS);

    sync(kit, repo);

    assert.equal('hooks' in settingsOf(repo), false);
});
