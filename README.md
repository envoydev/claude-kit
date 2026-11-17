# claude-kit

The Claude Code rules, skills and settings that envoydev's plugin repos share - [alfred-code](https://github.com/envoydev/alfred-code),
[alfred-mods](https://github.com/envoydev/alfred-mods) and [alfred-tools](https://github.com/envoydev/alfred-tools) -
kept once here and copied into each repo's `.claude/` by a sync script.

It is maintainer tooling: nothing here ships to the people who install the plugins. The plugin catalog itself lives in
[plugins-marketplaces](https://github.com/envoydev/plugins-marketplaces).

## What is shared

| Path | What it is |
|---|---|
| `shared/rules/` | `auto-run`, `commits`, `execution` (a template), `javascript`, `typescript`, `plan-approval`, `project-structure` (a template), `refining-plans`, `skill-authoring`, `superpowers-location` |
| `shared/skills/` | `auto-run`, `javascript`, `typescript`, `ts-js-testing`, `npm`, `markdown-style`, `code-comments`, `plugin-packaging`, `project-structure` (a template), `refining-plans`, `skill-authoring`, `solve-task` (a template), the nine `repo-audit-<kind>` audits and `repo-audit-plugin`, which holds the flow they run through and runs them together |
| `shared/agents/` | templates, each one's model a kit default: `audit-planner` (reads, scores and writes an audit's edit plan), `audit-editor` (applies that plan and decides nothing), `plan-grader` (grades a spec or plan against the `refining-plans` rubric; that skill does not dispatch it yet - it still uses a general-purpose reviewer until the two are compared) |
| `shared/defaults.json` | the kit's own value for a template key - `plan_model` (opus), `review_model` (opus), `implement_model` (sonnet), the model each agent file is written with. A project changes a seat's model in its settings (below), not here |
| `shared/settings.base.json` | the secret-file deny list, the plugins every repo enables, `autoCompactWindow`, the `attribution` block that keeps Claude Code's own trailer, PR line and session link out of commits and PRs, and the status hook - merged into each repo's `.claude/settings.json`, the repo's own hooks kept |
| `shared/mcp.json` | the MCP servers every repo gets (`context7`) - merged into each repo's `.mcp.json` by name, the repo's own servers kept; the file is machine-local and git-ignored, so each machine runs the sync |
| `shared/retired.json` | the plugins and MCP servers the kit shared once and dropped - both merges only add, so each sync takes these out of every repo's settings and `.mcp.json`; to drop a shared plugin, delete it from `settings.base.json` and name it here |

A shared file ending in `.tmpl` is a template: it lands without the suffix, each `{{key}}` filled from the repo's own
`.claude/kit/repo.json` (a string, or an array of lines). That is how `solve-task` and `execution.md` stay one flow
while each repo names its own checks, commit rule and sibling scope, and how `project-structure` keeps one code shape
- an entry that only wires, a folder per feature, pure logic, one effects file, constants and types in files of their
own - while each repo's `structure_map` says where that shape lands in its folders and `structure_paths` which files
attach the rule that loads it. A key that neither the repo nor
`shared/defaults.json` defines stops its sync before anything is written. The lock holds the filled file's hash, so a local edit fails `kit:check` as any other does.

An audit is typed (`/repo-audit-skills`, `-rules`, ...) and runs through the flow in `repo-audit-plugin`. `/repo-audit-plugin` runs every
kind the repo has targets for, `/repo-audit-plugin exclude tools, usage` every kind but those, and
`/repo-audit-plugin skills, hooks` only those - one kind at a time, `hooks` last in its wave, or side by side where the request says `parallel` - and, unlike the nine, it can also be started by asking in chat
('run all the audits'). In each audit the planner agent reads,
scores and writes an edit plan with the exact text of every change, `refining-plans` grades that plan unless plan grading
is off, the plan is approved before anything is edited - by the user, or by the run where `auto_approve` is on - the
editor agent applies the plan, and the planner verifies. Every run opens on its size and its models and closes on
a scorecard - the grades before the edits against the grades after them - and then on a self-review: what the
audit's own instructions got wrong in this run, ranked by what it cost, each with the edit that would have prevented
it. The self-review runs only in this repo, the audit skills' home, where those edits become a plan of their own;
a plugin repo's run skips it. An audit plan is graded twice at most: under the pass score after its second
grade, it waits for the user. So the
judgment runs on the stronger model and the edits on the cheaper one, whatever model the session is on.

The `repo-audit-*` skills are one generic copy each. What they audit in a repo comes from that repo's `repo.json`
`audit` map, one entry per kind (`skills`, `commands`, `agents`, `rules`, `agent-md`, `hooks`, `tools`, `system`,
`usage`):
`roots` (the paths audited), `checks` (the commands that are its mechanical gate) and `notes` (its own registries,
graders and catalogs, one sentence each). A kind with no entry is reported as nothing to audit.

An audit of `skills`, `commands`, `agents` or `rules` reads only the items that are new, changed since they were
last graded on this machine, were graded below the target, or were graded more than 30 days ago (`max_age_days` in
the entry changes the number); the rest are carried with their grade, and `full`
after the command audits every item again. An entry may add `scope_with`: paths every item's grade rests on besides
its own files - a change to one of them audits every item, and an entry under a root that the list names is no item.
`hooks` is scoped only where its entry has the list. A change to an audit skill's `references/rubric.md` or
`references/currency.md` audits every item of its kind again; a change to its other text carries the grades and
says so. The first audit of a kind on a machine is always a full one.

`copies.json` at the root is this repo's registry of text kept on purpose in more than one file - a rule and its skill,
a rule and each repo's `AGENTS.md`: each entry names the owner, every copy and the marker phrases each keeps, so an
audit reads a registered copy as deliberate and a reworded one shows. `node .claude/kit/check.mjs` reads it here and
fails when a site lacks one of its markers; a line wrap inside a marker counts as a space.

This repo takes the same files into its own `.claude/`, so a session here loads the rules and skills it shares. Those
copies are git-ignored - `shared/` is their one home - so a fresh clone runs `npm run sync` once to get them, and an
edit goes into `shared/`, never into the copy. Only `.claude/settings.json`, `.claude/kit/repo.json` (this repo's
own template values) and `.claude/kit/settings.json` (its saved kit settings, once one is set) are tracked.

Each repo keeps its own `AGENTS.md`, its `repo-*` rules and skills, `plugin-handling.md` and `repo.json`: they name
that repo's layout, commands and release path.

## Settings a project can change

Nine values - the pass score, five models and three switches - live in the kit's own file, `.claude/kit/settings.json`,
which the chat writes: say 'plan model fable' or 'stop scoring' and it is saved there until it is changed. The status
hook (`.claude/kit/status-hook.mjs`, a `UserPromptSubmit` hook) shows them with every request - one line for the
user, the same values with their sources for Claude - so neither a new session nor a compacted one has to remember
them. `node .claude/kit/settings.mjs` prints them on demand.

```text
kit: auto-run off | scoring on (pass 90) | auto-approve off | plan opus | audit opus | review opus | implement sonnet | search haiku
```

| Name | Variable | What it sets | Without it |
|---|---|---|---|
| `pass_score` | `KIT_PASS_SCORE` | the score `refining-plans` grades a spec or plan to, a whole number from 1 to 100 | 90 |
| `plan_model` | `KIT_PLAN_MODEL` | the model that writes plans: the plan step of `solve-task`, and the `audit-planner` agent where no `audit_model` is set | the `audit-planner` agent's own (opus) |
| `audit_model` | `KIT_AUDIT_MODEL` | the model of the `audit-planner` agent alone, so an audit can plan on another model than everyday plans | the `plan_model` |
| `review_model` | `KIT_REVIEW_MODEL` | the model that reviews: the `refining-plans` reviewer, the review step of `solve-task` | the `plan-grader` agent's own (opus) |
| `implement_model` | `KIT_IMPLEMENT_MODEL` | the model that implements: the `audit-editor` agent, the build step of `solve-task` | the `audit-editor` agent's own (sonnet) |
| `search_model` | `KIT_SEARCH_MODEL` | the model that searches the code for the other three in `solve-task` - where a thing is, what calls it - and reports paths and lines | haiku |
| `scoring` | `KIT_SCORING` | whether specs and plans are graded, `on` or `off` | on |
| `auto_run` | `KIT_AUTO_RUN` | whether a session runs in auto-run from its first ask, `on` or `off` | off |
| `auto_approve` | `KIT_AUTO_APPROVE` | who approves a spec, a design or a plan: `on`, the run does once it is at the pass score; `off`, it waits for the user, who is notified | off |

```json
{ "plan_model": "fable", "review_model": "fable", "pass_score": 95, "auto_run": "on" }
```

- `.claude/kit/settings.json` is committed with the repo, so a value never has to go into a Claude Code settings file
  that may hold a key or a token. `node .claude/kit/settings.mjs set plan_model fable` writes one name and `unset
  plan_model` removes it; the sync never touches the file.
- What the user sets in chat is saved there and holds in every session until it is changed (the user's ruling,
  2026-11-16, which replaced the per-session switches of 2026-11-15). A request whose first line is only
  words to switch a mode - 'stop scoring', 'turn on scoring', 'enable auto run', 'turn auto run off', 'auto approve
  on' - or to name a
  role's model - 'plan model fable', 'plan model and scoring models fable', 'edit with haiku' - is saved by the hook
  itself, and Claude's values for that request say `saved: plan_model=fable in .claude/kit/settings.json`, or why it
  was not saved. Said any other way - inside a longer sentence, as a question - the hook saves nothing and Claude
  runs the `set` command. The hook never blocks a request: when it fails, it says
  so in the debug log and the request goes through.
- A value is the kit's file, else the `KIT_*` variable from the `env` block of a Claude Code settings file, else the
  default. A value the script cannot use falls back to the next source, and its line says why.
- The file is read with every request, so a change counts at once in every open session of the repo.
- Because the file is committed, everyone who works in a clone runs with its values, `auto_run`, `auto_approve` and
  `scoring` included (the user's choice, 2026-11-16). The variables keep the older rule: `KIT_SCORING`, `KIT_AUTO_RUN`
  and `KIT_AUTO_APPROVE` count only from a file that is not committed - `.claude/settings.local.json` or `~/.claude/settings.json` - and the
  script ignores one in `.claude/settings.json`. The other six variables may go in any settings file; the sync
  leaves a repo's `env` block alone.
- The pass score and scoring govern the grade of a spec or a plan, an audit's edit plan included. An audit's own
  score of each file, and its grade A bar, belong to the audit skill and are never switched off.
- A model is `sonnet`, `opus`, `haiku` or `fable`. The five models are what a step is dispatched on, not what the
  chat session runs on: a session cannot change its own model. A step whose model is the session's own runs there;
  any other goes to an agent with that model, and the closing report names the model each step actually ran on.
- Claude Code applies a new or changed variable to sessions that are already open, but a deleted one stays set in
  them until they restart: to switch `KIT_AUTO_RUN` or `KIT_SCORING` back at once, set its other value instead of
  deleting the line - or save the value in the kit's file, which outranks it.
- A value meant for one run only - 'grade this one to 95' - goes into that run's `run.md`, not into the file, so a
  compaction keeps it and the next run does not inherit it.

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

The kit's scripts also include `.claude/kit/prove-plan.mjs`: `node .claude/kit/prove-plan.mjs <plan>` replays an audit
plan's edits from its `Baseline` revision, writes the expected files beside the plan and exits 1 unless every edit
applied; with `--check` it writes nothing and compares the replay with the files already there.
`.claude/kit/audit-scope.mjs` keeps, under `docs/superpowers/audits/state/`, each audited item's grade beside the
hashes of its files: `scope` tells an audit which items to read, and `record` saves the grades once they are final.

`npm test` runs the tests of the scripts under `bin/` - the sync, the check, the settings, the status hook, the plan
prover and the audit scope - against throwaway kits and repos in temp folders. They use Node's own test runner, start no Claude session and
cost nothing.

Requires Node 22.18 or newer (the sync script is TypeScript run by Node's type stripping); no dependencies.

## Changing a shared file

1. Edit it under `shared/`, commit here. A repo-specific line goes into a `{{key}}` and each repo's `repo.json`.
2. `npm run sync`, then commit in each repo (`chore(kit): sync claude-kit@<sha>`).

A file removed from `shared/` is removed from each repo on the next sync while it still matches its lock entry; one
edited in a repo is kept and named.
