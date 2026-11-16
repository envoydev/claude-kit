---
name: repo-audit-plugin
description: "Use when the user asks to run this repo's audits together - '/repo-audit-plugin', 'run all audits', 'audit the skills and hooks'. Runs the kinds named, or all."
argument-hint: "[kind, kind ... | exclude kind, kind ...] [commit]"
---

# Plugin audit - every audit in one run

One run for the nine audits (`repo-audit-<kind>`): all of them, all but the kinds the request excludes, or only the
kinds it names. Each audit keeps its own
method, rubric and run folder and goes through the steps of `repo-audit-flow`; this file says which kinds run, which
of those steps run side by side across kinds, and what happens between them.

## When to use

- The user types `/repo-audit-plugin` for every kind this repo has targets for, `/repo-audit-plugin exclude tools,
  usage` for every kind but those, or `/repo-audit-plugin skills, hooks` for those kinds alone - or asks for the same
  in chat: 'run all the audits', 'audit everything except usage', 'audit the rules and the hooks'.
- Only on the user's ask. An audit mentioned in passing, or a question about one, starts nothing: a run spends
  planner seats on the strongest model before it shows anything.
- One kind typed as its own command (`/repo-audit-skills`) is that skill's run, not this one.

## The kinds, in two waves

- **Wave 1 - the parts:** `skills`, `commands`, `agents`, `rules`, `agent-md`, `hooks`, `tools`.
- **Wave 2 - the whole:** `system`, `usage`. They judge everything wave 1 may have changed, so they start only
  after wave 1's edits are applied.

That is also the run order: wherever one kind goes before another - applying edits, the rows of a table - it is
this order, whatever order the request names them in.

## The run

1. **Kinds.** Read the words after the command (`$ARGUMENTS`) or what the request says in chat. Kinds are
   separated by commas, colons or spaces, with or without the `repo-audit-` prefix.
   - None named: every kind.
   - After `exclude` (or 'except', 'without', 'but not'): every kind but the ones that follow it -
     `exclude tools, usage, system` runs the six others.
   - Otherwise: the kinds named, and only those.

   A word that is no kind is named back with the list above, and the run goes on with the rest. Say in one line
   which kinds run and which were left out, before anything else. Then read `.claude/kit/repo.json` ->
   `audit`: a kind with no entry there is listed as `no targets` and not run.
2. **The queue file.** Write `docs/superpowers/audits/<date>-all/queue.md`: one line per kind with its wave, its
   status - `pending`, `planning`, `graded <score>`, `waiting for approval`, `applying`, `verifying`,
   `done <baseline> -> <final>`, `no targets`, `NOT RUN - <why>` - its run folder and its commit. Update a line
   whenever its status changes. After a compaction, Read it before the next step: it is how the run outlives the
   summary.
3. **Each audit's skill.** For every kind that will run, Read `.claude/skills/repo-audit-<kind>/SKILL.md` with the
   Read tool - the audits are typed-only, so the Skill tool cannot load them, and the user's ask for this run is
   their word for each audit in it - and load `repo-audit-flow` once. This session coordinates only: it reads no
   audited file and scores nothing.
4. **Size and models, once for the run.** Do the flow's steps 1 to 3 for each kind, then state `Size:` with one
   entry per kind (files, characters, batches) and the total planner seats, and `Models:` as the flow gives them.
   With more than one kind to run, ask once before the first planner starts:

   ```ask
   This run audits <K> kinds - <kind: characters, ...> - <total> characters: <N> planner seats on <model>, four at a time<, each plan graded>. Start?
   - 'All <K> kinds (Recommended)' - every kind listed runs, wave 1 side by side
   - 'Pick kinds' - name the kinds to run or to leave out; the rest stay pending
   - 'Cancel' - nothing is started
   ```

   Under `auto-run` the ask is not put: the recommended option is taken and ledgered. It replaces each kind's own
   size ask (the flow's step 4) for this run.
5. **Plan side by side.** Dispatch the planners of every wave 1 kind in one message (the flow's step 5), at most
   four planner seats running at a time across all kinds and batches; a seat that frees takes the next waiting
   batch. Each kind's open questions (step 6) are gathered and put together, at most four per ask.
6. **Grade side by side.** Run each plan's freshness check and grade (step 7): with `Plan grade: on`, the first
   reviewer of every plan is dispatched in one message, and each plan's own `refining-plans` loop goes on from its
   scorecard. A plan's revision is its own planner's.
7. **Approval** follows the `plan-approval` rule, per plan, and replaces the flow's step 8 ask for this run:
   - `auto_approve=on`: every plan that passed is approved by the run and ledgered.
   - `auto_approve=off`: hand all the plans over in one message - one row per kind with its baseline grades, plan
     path, score path and edit count - and notify the user. Never park on one kind's plan while another kind is
     still unplanned.
8. **Apply one plan at a time, in run order** (step 9). Editors never run side by side: each runs the repo's checks,
   and a check must not see another plan half applied. An audit leaves its edits uncommitted, and the flow applies
   no plan to targets that hold uncommitted changes, so:
   - where the request said to commit - the word `commit` after the command, 'commit each audit' in chat - commit
     each kind's edited files by pathspec, under the repo's own commit rule, one commit per kind, before the next
     plan is applied. Never push. A plan whose targets that commit changed goes back to its planner first, as the
     flow's freshness check says;
   - where it did not, commit nothing: a kind whose targets an earlier kind edited is
     `NOT RUN - targets edited by <kind>, uncommitted`, and the close names the commit that unblocks it.
9. **Verify side by side** (step 10): send every applied kind's planners their verify message in one turn.
10. **Wave 2.** Run steps 5 to 9 again for whichever of `system` and `usage` the run includes, on the tree as wave 1
    left it. Where wave 1 edited
    their targets and nothing was committed, they are `NOT RUN` as step 8 says.
11. **A kind that stops does not stop the run.** Targets with uncommitted changes, a plan whose grade ended under the
    pass score, a question only the user can answer, a seat that failed twice: write the reason on its queue line and
    go on with the others. It is not retried in this run.
12. **Close.** Each kind's scorecard as the flow's step 11 prints it, then the run's own:

    ```text
    Scorecard: <K> kinds, <n> items
    | kind | items | at A before -> after | mean before -> after | plan grade | status | commit |
    Overall: at A <before> -> <after> of <n>; mean <before> -> <after>
    ```

    Then the path of each kind's `final.md` for its full report and owed checks, one line per seat with the model it
    ran on, and under `Left for you` every kind not run with its reason, every plan still waiting and every commit
    not made.
13. **Self-review, once for the run** (the flow's step 12). Send every kind's planners the `retro` message in one
    turn, add this run's own findings - a kind that was `NOT RUN`, a seat left idle, a plan that went back after
    another kind's edits - and merge everything into `docs/superpowers/audits/<date>-all/retro.md`: one ranked
    list, a finding several kinds hit counted once and ranked higher, the top seven kept. Where this repo is the
    audit skills' home, one `retro-plan.md` there goes through the flow's steps 7 to 9; anywhere else, nothing is
    applied. It replaces each kind's own step 12.

## Signs it was skipped

- A run started on a mention of an audit, with no ask for one.
- An audit run from memory of its skill, its `SKILL.md` never Read in this run.
- Wave 1 kinds planned, graded or verified one after another while seats were free - or more than four planner
  seats running at once.
- Two editors running at the same time, or a plan applied on top of another kind's uncommitted edits to the same
  targets.
- A commit made without the user's word for it, or a push.
- No `queue.md`, no overall scorecard, no `retro.md`, or a close that leaves out a kind the request named.
