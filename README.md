# claude-kit

The Claude Code rules, skills and settings that envoydev's plugin repos share - [alfred-code](https://github.com/envoydev/alfred-code),
[alfred-mods](https://github.com/envoydev/alfred-mods) and [alfred-tools](https://github.com/envoydev/alfred-tools) -
kept once here and copied into each repo's `.claude/` by a sync script.

It is maintainer tooling: nothing here ships to the people who install the plugins. The plugin catalog itself lives in
[plugins-marketplaces](https://github.com/envoydev/plugins-marketplaces).

## What is shared

| Path | What it is |
|---|---|
| `shared/rules/` | `auto-run`, `execution` (a template), `javascript`, `typescript`, `refining-plans`, `skill-authoring`, `superpowers-location` |
| `shared/skills/` | `auto-run`, `javascript`, `typescript`, `ts-js-testing`, `npm`, `markdown-style`, `code-comments`, `plugin-packaging`, `refining-plans`, `skill-authoring`, `solve-task` (a template), the eight `repo-audit-*` audits |
| `shared/settings.base.json` | the secret-file deny list, the plugins every repo enables, `autoCompactWindow` - merged into each repo's `.claude/settings.json` |
| `shared/mcp.json` | the MCP servers every repo gets (`context7`) - merged into each repo's `.mcp.json` by name, the repo's own servers kept; the file is machine-local and git-ignored, so each machine runs the sync |
| `shared/retired.json` | the plugins and MCP servers the kit shared once and dropped - both merges only add, so each sync takes these out of every repo's settings and `.mcp.json`; to drop a shared plugin, delete it from `settings.base.json` and name it here |

A shared file ending in `.tmpl` is a template: it lands without the suffix, each `{{key}}` filled from the repo's own
`.claude/kit/repo.json` (a string, or an array of lines). That is how `solve-task` and `execution.md` stay one flow
while each repo names its own checks, commit rule and sibling scope. A key a repo does not define stops its sync before
anything is written. The lock holds the filled file's hash, so a local edit fails `kit:check` as any other does.

The `repo-audit-*` skills are one generic copy each. What they audit in a repo comes from that repo's `repo.json`
`audit` map, one entry per kind (`skills`, `agents`, `rules`, `hooks`, `claude-md`, `plugins`, `system`, `usage`):
`roots` (the paths audited), `checks` (the commands that are its mechanical gate) and `notes` (its own registries,
graders and catalogs, one sentence each). A kind with no entry is reported as nothing to audit.

This repo takes the same files into its own `.claude/`, so a session here loads the rules and skills it shares. Those
copies are git-ignored - `shared/` is their one home - so a fresh clone runs `npm run sync` once to get them, and an
edit goes into `shared/`, never into the copy. Only `.claude/settings.json` and `.claude/kit/repo.json` (this repo's
own template values) are tracked.

Each repo keeps its own `AGENTS.md`, its `repo-*` rules and skills, `plugin-handling.md` and `repo.json`: they name
that repo's layout, commands and release path.

## Use

The repos sit beside this one (`../alfred-code`, `../alfred-mods`, `../alfred-tools`).

```bash
npm run check   # what a sync would change here and in each repo, nothing written; exit 1 on a difference
npm run sync    # write the shared files, .claude/kit/lock.json and .claude/kit/check.mjs here and into each repo
```

Then commit the change in each repo. In a repo, `npm run kit:check` fails when a managed file was edited there - the
fix is to change it here and sync again, so the repos never drift apart. It fails too when a `CLAUDE.md`,
`.claude/CLAUDE.md` or `CLAUDE.local.md` sits beside the repo's `AGENTS.md`: Claude Code reads `AGENTS.md` only while
none of the three exists, and says nothing when one switches it off.

Requires Node 22.18 or newer (the sync script is TypeScript run by Node's type stripping); no dependencies.

## Changing a shared file

1. Edit it under `shared/`, commit here. A repo-specific line goes into a `{{key}}` and each repo's `repo.json`.
2. `npm run sync`, then commit in each repo (`chore(kit): sync claude-kit@<sha>`).

A file removed from `shared/` is removed from each repo on the next sync while it still matches its lock entry; one
edited in a repo is kept and named.
