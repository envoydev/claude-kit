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
node .claude/kit/check.mjs   # copies match the lock, no CLAUDE.md here, copies.json markers hold, descriptions fit 160
npm test                     # the scripts under bin/, run against throwaway kits and repos in temp folders
```

Node 22.18 or newer, no dependencies and no CI: these four are the whole gate. The tests (`test/*.test.mjs`, Node's
own runner) cover `bin/` only - they start no Claude session and cost nothing - and a change under `bin/` adds or
changes a test with it. The skills and rules are prose and have none. `bin/sync.ts` runs through
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
- `bin/` - `bin/sync.ts` (the sync) and the scripts it copies into each repo's `.claude/kit/`, `bin/check.mjs` among
  them as that repo's `kit:check`.
- `.claude/` - this repo's own copy of the shared files, so a session here loads them. Only `settings.json`,
  `kit/repo.json` and `kit/settings.json` are tracked; the rest is git-ignored.

## Invariants

- **`shared/` is the one home.** A rule, skill or agent is edited under `shared/`, never in a `.claude/` copy here or
  in a plugin repo: `kit:check` fails on a local edit, and the next sync overwrites it.
- **Two shared hooks, and neither blocks.** `shared/settings.base.json` wires two on `UserPromptSubmit` in every repo:
  `status-hook.mjs` sends the kit's settings line (the user's request of 2026-11-15), and `agent-reminders.mjs` sends
  the reminder line of each rule in its list - communication, then cleanup - with a note on the communication line
  when the last reply went over (the user, 2026-11-22: one hook per job; 2026-11-25: the list). The sync tells a kit
  hook from a repo's own by the `.claude/kit/` path in its command, so a repo's hooks are kept and a hook deleted from
  the base is removed everywhere. Another hook waits for a rule that is seen to fail.
- **A merge only adds.** Deleting a plugin or an MCP server from the shared list leaves it switched on in every repo;
  it is taken out by naming it in `shared/retired.json`.
- **Enabling a plugin does not install it.** After a plugin joins `settings.base.json`, run
  `claude plugin install <id> --scope project` in each repo; after one is retired,
  `claude plugin uninstall <id> --scope project`.
- **A sync writes the working tree, not the last commit.** With unfinished work under `shared/`, commit first or sync
  from a clean clone of the commit, or the unfinished files land in all three repos.
- **A missing template key stops a repo's sync before anything is written.** A new `{{key}}` needs a value in all four
  `repo.json` files, this repo's included.
- **A new shared skill, rule or agent must be allowed in alfred-code's `.gitignore`**, which ignores `.claude/` except
  the paths it lists; the sync names such a file as 'ignored by git'.
- **Rules load at session start; a skill or an agent is picked up live.** After a sync that adds a rule, restart the
  session to see it here. A synced skill or agent needs no restart unless `.claude/skills/` or `.claude/agents/` did
  not exist when the session started; when one does not appear, restart (read 2026-11-17,
  https://code.claude.com/docs/en/skills and https://code.claude.com/docs/en/sub-agents).
- **`AGENTS.md` is the instruction file in all four repos, at the root.** Never add a `CLAUDE.md`, `.claude/CLAUDE.md`
  or `CLAUDE.local.md` beside it: Claude Code then stops reading `AGENTS.md` without a word (checked 2026-11-15,
  Claude Code 2.1.325, https://code.claude.com/docs/en/memory). `kit:check` fails when one appears.

## Working in this repo

- **The order of a shared change:** edit under `shared/`, `npm run check`, commit here, `npm run sync`,
  `npm run kit:check` in each plugin repo, then one commit in each (`chore(kit): sync to claude-kit <sha>`). A sync
  that renames or retires a kit hook breaks it in every session open in those repos until it restarts: say so.
- **Branches.** Work is committed on `develop`, pushed, then merged into `main` (the user, 2026-11-19). Commit or
  push only on the user's word. A `solve-task` run the user
  started - `/solve-task`, or asking for it in their words - has that word for its local commits, never for a push;
  a run the session loaded by itself does not.
- **Commits.** `type(scope): what is now true`, as the log has it, with no trace of the agent - no co-author trailer,
  session link or 'Generated with' line. The rule is `shared/rules/commits.md`, the same in all four repos.
- **Voice.** Direct and lean, single dashes, single quotes in prose; recommend one option with a reason. Replies to
  the user follow `shared/rules/communication.md`.

## Rules and skills

Ten rules load in every session of all four repos and govern how work runs - edited under `shared/rules/`, loaded
from `.claude/rules/`:

- `shared/rules/execution.md.tmpl` - one agent or several, the short plan, the check tiers and the close.
- `shared/rules/refining-plans.md` - a spec or plan is graded before the user is asked to review it.
- `shared/rules/plan-approval.md` - `auto_approve` decides who approves a draft: the run or the user.
- `shared/rules/auto-run.md` - when the `auto-run` skill loads: the user is away, or `auto_run=on`.
- `shared/rules/superpowers-location.md` - what the superpowers skills write goes under `docs/superpowers/`.
- `shared/rules/commits.md` - the Commits line above.
- `shared/rules/communication.md` - how replies read and how the user is asked.
- `shared/rules/cleanup.md` - when the work ends, the run removes or stops what it made or started that nothing needs any more.
- `shared/rules/windows-vm.md` - everything a run makes in the Windows VM lives under `C:\Claude-MacOs`, and the user can see the run - its window, a live log and chat updates.
- `shared/rules/update-command.md` - a fix or a feature that changes what an earlier version left on a user's machine ships its step in the plugin's update command.

The other four rules there attach by path, and each exists to load its skills when a matching file is touched.

Procedures live in skills, under `shared/skills/`: `solve-task` runs a change of more than a sentence end to end -
spec, plan, build, checks, review. The `repo-audit-*` audits are the user's to start (`README.md`); `ts-convert`
converts JavaScript to TypeScript batch by batch, alone or as the first step of `/repo-audit-code`.

## Related repos

- alfred-code, alfred-mods and alfred-tools (`../<name>` when checked out beside this one) take the shared files. A
  change to a file one of them owns - its `AGENTS.md`, its `repo-*` rules and skills, its `repo.json` - is made there.
- plugins-marketplaces (`../plugins-marketplaces`) is the `envoydev` catalog that lists the three plugins.
