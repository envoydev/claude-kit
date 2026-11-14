# claude-kit

The Claude Code rules, skills and settings that envoydev's plugin repos share - [alfred-code](https://github.com/envoydev/alfred-code),
[alfred-mods](https://github.com/envoydev/alfred-mods) and [alfred-tools](https://github.com/envoydev/alfred-tools) -
kept once here and copied into each repo's `.claude/` by a sync script.

It is maintainer tooling: nothing here ships to the people who install the plugins. The plugin catalog itself lives in
[plugins-marketplaces](https://github.com/envoydev/plugins-marketplaces).

## What is shared

| Path | What it is |
|---|---|
| `shared/.claude/rules/` | `auto-run`, `execution` (a template), `refining-plans`, `skill-authoring`, `superpowers-location` |
| `shared/.claude/skills/` | `auto-run`, `javascript`, `typescript`, `markdown-style`, `plugin-packaging`, `refining-plans`, `skill-authoring`, `solve-task` (a template) |
| `shared/settings.base.json` | the secret-file deny list, the plugins every repo enables, `autoCompactWindow` - merged into each repo's `.claude/settings.json` |
| `shared/mcp.json` | the `.mcp.json` a repo gets when it has none (machine-local and git-ignored in every repo) |

A shared file ending in `.tmpl` is a template: it lands without the suffix, each `{{key}}` filled from the repo's own
`.claude/kit/repo.json` (a string, or an array of lines). That is how `solve-task` and `execution.md` stay one flow
while each repo names its own checks, commit rule and sibling scope. A key a repo does not define stops its sync before
anything is written. The lock holds the filled file's hash, so a local edit fails `kit:check` as any other does.

Each repo keeps its own `CLAUDE.md`, its `repo-*` rules and skills, `plugin-handling.md` and `repo.json`: they name
that repo's layout, commands and release path.

## Use

The repos sit beside this one (`../alfred-code`, `../alfred-mods`, `../preferred-tools` - alfred-tools's checkout, under its old name).

```bash
npm run check   # what a sync would change in each repo, nothing written; exit 1 on a difference
npm run sync    # write the shared files, .claude/kit/lock.json and .claude/kit/check.mjs into each repo
```

Then commit the change in each repo. In a repo, `npm run kit:check` fails when a managed file was edited there - the
fix is to change it here and sync again, so the repos never drift apart.

Requires Node 22.18 or newer (the sync script is TypeScript run by Node's type stripping); no dependencies.

## Changing a shared file

1. Edit it under `shared/`, commit here. A repo-specific line goes into a `{{key}}` and each repo's `repo.json`.
2. `npm run sync`, then commit in each repo (`chore(kit): sync claude-kit@<sha>`).

A file removed from `shared/` is removed from each repo on the next sync while it still matches its lock entry; one
edited in a repo is kept and named.
