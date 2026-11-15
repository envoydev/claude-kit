# AGENTS.md - claude-kit

## What this repo is

The Claude Code rules, skills and settings that envoydev's plugin repos share - alfred-code, alfred-mods and
alfred-tools - kept once under `shared/` and copied into each repo's `.claude/` by `bin/sync.ts`. It is maintainer
tooling: nothing here ships to the people who install the plugins. `README.md` describes every shared path, the
templates and the `audit` map.

**Public repo.** No private project names, no absolute local paths, no tokens.

## Commands

```bash
npm run check                # what a sync would change here and in the three repos; writes nothing, exit 1 on a difference
npm run sync                 # write the shared files here and into ../alfred-code, ../alfred-mods, ../alfred-tools
node .claude/kit/check.mjs   # this repo's own copies still match the lock, and no CLAUDE.md hides this file
```

Node 22.18 or newer, no dependencies, no tests and no CI: these three are the whole gate. `bin/sync.ts` runs through
Node's type stripping, and no TypeScript is installed here, so it is type-checked with a sibling's compiler:

```bash
../alfred-tools/node_modules/.bin/tsc --noEmit --strict --target es2023 --module nodenext \
  --moduleResolution nodenext --allowImportingTsExtensions \
  --typeRoots ../alfred-tools/node_modules/@types --types node bin/sync.ts
```

## Layout

- `shared/rules/`, `shared/skills/`, `shared/agents/` - every file in a folder under `shared/` is copied to the same
  path under a repo's `.claude/`. A file ending in `.tmpl` lands without the suffix, each `{{key}}` filled from that
  repo's `.claude/kit/repo.json`, or from `shared/defaults.json` where the repo sets none.
- `shared/settings.base.json`, `shared/mcp.json`, `shared/retired.json` - the files beside those folders are merged
  into a repo's `.claude/settings.json` and `.mcp.json`, never copied.
- `bin/sync.ts` (the sync), `bin/check.mjs` (copied into each repo as its `kit:check`), `bin/kit-readme.md` (copied as
  `.claude/kit/README.md`).
- `.claude/` - this repo's own copy of the shared files, so a session here loads them. Only `settings.json` and
  `kit/repo.json` are tracked; `rules/`, `skills/`, `agents/` and the rest of `kit/` are git-ignored copies.

## Invariants

- **`shared/` is the one home.** A rule or skill is edited under `shared/`, never in a `.claude/` copy here or in a
  plugin repo: `kit:check` fails on a local edit, and the next sync overwrites it.
- **A merge only adds.** Deleting a plugin or an MCP server from the shared list leaves it switched on in every repo;
  it is taken out by naming it in `shared/retired.json`.
- **Enabling a plugin does not install it.** After a plugin joins `settings.base.json`, run
  `claude plugin install <id> --scope project` in each repo; after one is retired, `claude plugin uninstall`.
- **A sync writes the working tree, not the last commit.** With unfinished work under `shared/`, commit first or sync
  from a clean clone of the commit, or the unfinished files land in all three repos.
- **A missing template key stops a repo's sync before anything is written.** A new `{{key}}` needs a value in all four
  `repo.json` files, this repo's included.
- **A new shared skill or rule must be allowed in alfred-code's `.gitignore`**, which ignores `.claude/` except the
  paths it lists; the sync names such a file as 'ignored by git'.
- **Skills, rules and agents load at session start.** After a sync that adds one, restart the session to see it here.
- **`AGENTS.md` is the instruction file in all four repos, at the root.** Never add a `CLAUDE.md`, `.claude/CLAUDE.md`
  or `CLAUDE.local.md` beside it: Claude Code then stops reading `AGENTS.md` without a word (checked 2026-11-15,
  Claude Code 2.1.325, https://code.claude.com/docs/en/memory). `kit:check` fails when one appears.

## Working in this repo

- **The order of a shared change:** edit under `shared/`, `npm run check`, commit here, `npm run sync`,
  `npm run kit:check` in each plugin repo, then one commit in each (`chore(kit): sync to claude-kit <sha>`).
- **Branches.** `main` is the only branch. Commit or push only on the user's word.
- **Commits.** `type(scope): what is now true`, as the log has it, with no trace of the agent - no co-author trailer,
  session link or 'Generated with' line. The rule is `shared/rules/commits.md`, the same in all four repos.
- **Voice.** Direct and lean, single dashes, single quotes in prose; recommend one option with a reason.

## Related repos

- alfred-code, alfred-mods and alfred-tools (`../<name>` when checked out beside this one) take the shared files. A
  change to a file one of them owns - its `AGENTS.md`, its `repo-*` rules and skills, its `repo.json` - is made there.
- plugins-marketplaces (`../plugins-marketplaces`) is the `envoydev` catalog that lists the three plugins.
