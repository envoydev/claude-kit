# Managed by claude-kit

The files listed in `lock.json` come from [envoydev/claude-kit](https://github.com/envoydev/claude-kit), the one
source of the Claude Code rules and skills these repos share. Do not edit them here: change them in claude-kit and
run its sync, which rewrites them in every repo.

- `npm run kit:check` (or `node .claude/kit/check.mjs`) fails when a managed file was edited or removed here, when a
  `CLAUDE.md` hides `AGENTS.md`, and when a managed skill's description is not one line of at most 160 characters.
- `node .claude/kit/settings.mjs` prints the values the kit's skills run on - the pass score, the plan, review,
  implement and search models, whether scoring, auto-run and auto-approve are on - read from `settings.json` beside it, then the
  `KIT_*` variables of a settings file's `env` block; the header of `kit-settings.mjs` lists them and
  `constants.mjs` holds their names and defaults. `settings.json` here is this repo's own and is never synced: it
  keeps what was set in chat - a model, the pass score, scoring, auto-run, auto-approve - until it is changed, written by the hook
  when a request's first line is only words to switch a mode or name a role's model, and by
  `node .claude/kit/settings.mjs set <name> <value>` for everything else. `status-hook.mjs` is the `UserPromptSubmit` hook this repo's `.claude/settings.json` runs: it shows the
  same values with every request.
- `node .claude/kit/prove-plan.mjs <plan>` proves an audit plan: it reads each edited file at the plan's `Baseline`
  revision, finds every `Old` exactly once and applies its `New`, writes the results into a folder beside the plan
  (`expected/` for `plan.md`) and prints `Applies: <n> of <n> edits`. It exits 1 and names each edit that did not
  apply, 2 when the plan cannot be read; `--without E<n>` also writes the files of the plan with that edit and the
  edits that need it left out, into `expected-without-E<n>/`.
- `repo.json` here is this repo's own: the values the kit's templates (`solve-task`, `execution.md`) are filled
  with - its name, its checks, its commit rule. Edit it here, then run claude-kit's sync to rewrite those files.
  Its `audit` map tells the `repo-audit-*` skills what this repo ships and how to check it; they read it at run time.
- Everything else is this repo's own: its `AGENTS.md` at the root, and under `.claude/` the `repo-*` rules and skills
  and `plugin-handling.md`.
