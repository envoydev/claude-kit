# claude-kit

The Claude Code rules, skills and settings that envoydev's plugin repos share - [alfred-code](https://github.com/envoydev/alfred-code),
[alfred-mods](https://github.com/envoydev/alfred-mods) and [alfred-tools](https://github.com/envoydev/alfred-tools) -
kept once here and copied into each repo's `.claude/` by a sync script.

It is maintainer tooling: nothing here ships to the people who install the plugins. The plugin catalog itself lives in
[plugins-marketplaces](https://github.com/envoydev/plugins-marketplaces).

## What is shared

| Path | What it is |
|---|---|
| `shared/rules/` | `auto-run`, `commits`, `execution` (a template), `javascript`, `typescript`, `refining-plans`, `skill-authoring`, `superpowers-location` |
| `shared/skills/` | `auto-run`, `javascript`, `typescript`, `ts-js-testing`, `npm`, `markdown-style`, `code-comments`, `plugin-packaging`, `refining-plans`, `skill-authoring`, `solve-task` (a template), the eight `repo-audit-*` audits and the `repo-audit-flow` they run through |
| `shared/agents/` | templates, each one's model a kit default: `audit-planner` (reads, scores and writes an audit's edit plan), `audit-editor` (applies that plan and decides nothing), `plan-grader` (grades a spec or plan against the `refining-plans` rubric; that skill does not dispatch it yet - it still uses a general-purpose reviewer until the two are compared) |
| `shared/defaults.json` | the kit's own value for a template key - `plan_model` (opus), `review_model` (opus), `implement_model` (sonnet), the model each agent file is written with. A project changes a seat's model in its settings (below), not here |
| `shared/settings.base.json` | the secret-file deny list, the plugins every repo enables, `autoCompactWindow` and the status hook - merged into each repo's `.claude/settings.json`, the repo's own hooks kept |
| `shared/mcp.json` | the MCP servers every repo gets (`context7`) - merged into each repo's `.mcp.json` by name, the repo's own servers kept; the file is machine-local and git-ignored, so each machine runs the sync |
| `shared/retired.json` | the plugins and MCP servers the kit shared once and dropped - both merges only add, so each sync takes these out of every repo's settings and `.mcp.json`; to drop a shared plugin, delete it from `settings.base.json` and name it here |

A shared file ending in `.tmpl` is a template: it lands without the suffix, each `{{key}}` filled from the repo's own
`.claude/kit/repo.json` (a string, or an array of lines). That is how `solve-task` and `execution.md` stay one flow
while each repo names its own checks, commit rule and sibling scope. A key that neither the repo nor
`shared/defaults.json` defines stops its sync before anything is written. The lock holds the filled file's hash, so a local edit fails `kit:check` as any other does.

An audit is typed (`/repo-audit-skills`, `-rules`, ...) and runs through `repo-audit-flow`: the planner agent reads,
scores and writes an edit plan with the exact text of every change, `refining-plans` grades that plan unless plan grading
is off, the session asks before anything is edited, the editor agent applies the plan, and the planner verifies. So the
judgment runs on the stronger model and the edits on the cheaper one, whatever model the session is on.

The `repo-audit-*` skills are one generic copy each. What they audit in a repo comes from that repo's `repo.json`
`audit` map, one entry per kind (`skills`, `agents`, `rules`, `hooks`, `agent-md`, `plugins`, `system`, `usage`):
`roots` (the paths audited), `checks` (the commands that are its mechanical gate) and `notes` (its own registries,
graders and catalogs, one sentence each). A kind with no entry is reported as nothing to audit.

This repo takes the same files into its own `.claude/`, so a session here loads the rules and skills it shares. Those
copies are git-ignored - `shared/` is their one home - so a fresh clone runs `npm run sync` once to get them, and an
edit goes into `shared/`, never into the copy. Only `.claude/settings.json` and `.claude/kit/repo.json` (this repo's
own template values) are tracked.

Each repo keeps its own `AGENTS.md`, its `repo-*` rules and skills, `plugin-handling.md` and `repo.json`: they name
that repo's layout, commands and release path.

## Settings a project can change

The pass score, three models and two standing switches come from the `env` block of a Claude Code settings file.
The status hook (`.claude/kit/status-hook.mjs`, a `UserPromptSubmit` hook) shows them with every request - one line
for the user, the same values with their sources for Claude - so neither a new session nor a compacted one has to
remember them. `node .claude/kit/settings.mjs` prints them on demand.

```text
kit: auto-run off | scoring on (pass 90) | plan opus | review opus | implement sonnet
```

| Variable | What it sets | Without it |
|---|---|---|
| `KIT_PASS_SCORE` | the score `refining-plans` grades a spec or plan to, a whole number from 1 to 100 | 90 |
| `KIT_PLAN_MODEL` | the model that writes plans: the `audit-planner` agent, the plan step of `solve-task` | the `audit-planner` agent's own (opus) |
| `KIT_REVIEW_MODEL` | the model that reviews: the `refining-plans` reviewer, the review step of `solve-task` | the `plan-grader` agent's own (opus) |
| `KIT_IMPLEMENT_MODEL` | the model that implements: the `audit-editor` agent, the build step of `solve-task` | the `audit-editor` agent's own (sonnet) |
| `KIT_SCORING=off` | the grading of specs and plans is off in every session | on |
| `KIT_AUTO_RUN=on` | auto-run is on from a session's first ask | off |

```json
{ "env": { "KIT_PASS_SCORE": "95", "KIT_PLAN_MODEL": "fable", "KIT_IMPLEMENT_MODEL": "sonnet" } }
```

- The pass score and `KIT_SCORING` govern the grade of a spec or a plan, an audit's edit plan included. An audit's own
  score of each file, and its grade A bar, belong to the audit skill and are never switched off.
- A model is `sonnet`, `opus`, `haiku` or `fable`; a value the script cannot use falls back to the default, and
  its line says why.
- The three models are what a step is dispatched on, not what the chat session runs on: a session cannot change its
  own model. A step whose model is the session's own runs there; any other goes to an agent with that model, and the
  closing report names the model each step actually ran on.
- The first four go in a repo's committed `.claude/settings.json`, or in `~/.claude/settings.json` for every project
  on the machine. The sync leaves a repo's `env` block alone.
- `KIT_SCORING` and `KIT_AUTO_RUN` switch a safeguard off, so they count only from a file that is not committed -
  `.claude/settings.local.json` or `~/.claude/settings.json`. The script ignores one in `.claude/settings.json`.
- Claude Code applies a new or changed value to sessions that are already open, but a deleted variable stays set in
  them until they restart. To switch `KIT_AUTO_RUN` or `KIT_SCORING` back at once, set its other value (`off`, `on`)
  instead of deleting the line. A session already running under auto-run stops only on 'stop auto run' or a restart.
- A request that starts with 'stop auto run' or 'stop scoring' is recorded by the hook itself, and it never blocks a
  request: when it fails, it says so in the debug log and the request goes through.
- What the user says in a session - 'auto mode', 'stop scoring', 'grade it to 95', 'audit with fable' - outranks the
  settings for that session. A switch goes into `kit-session.md` in the session's own scratchpad folder, which no other
  session shares, and a run's values into its `run.md`, so a compaction keeps them.

## Use

The repos sit beside this one (`../alfred-code`, `../alfred-mods`, `../alfred-tools`).

```bash
npm run check   # what a sync would change here and in each repo, nothing written; exit 1 on a difference
npm run sync    # write the shared files, .claude/kit/lock.json and the kit's scripts here and into each repo
```

Then commit the change in each repo. In a repo, `npm run kit:check` fails when a managed file was edited there - the
fix is to change it here and sync again, so the repos never drift apart. It fails too when a `CLAUDE.md`,
`.claude/CLAUDE.md` or `CLAUDE.local.md` sits beside the repo's `AGENTS.md`: Claude Code reads `AGENTS.md` only while
none of the three exists, and says nothing when one switches it off.

`npm test` runs the tests of the scripts under `bin/` - the sync, the check, the settings and the status hook - against
throwaway kits and repos in temp folders. They use Node's own test runner, start no Claude session and cost nothing.

Requires Node 22.18 or newer (the sync script is TypeScript run by Node's type stripping); no dependencies.

## Changing a shared file

1. Edit it under `shared/`, commit here. A repo-specific line goes into a `{{key}}` and each repo's `repo.json`.
2. `npm run sync`, then commit in each repo (`chore(kit): sync claude-kit@<sha>`).

A file removed from `shared/` is removed from each repo on the next sync while it still matches its lock entry; one
edited in a repo is kept and named.
