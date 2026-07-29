---
name: plan-epic
description: Plan a large piece of work as a beads epic — investigate the subject in depth with a fan-out of agents, create the epic and its child issues, then write a self-contained handoff protocol into the epic itself so ralph/cook-it iterations run it end-to-end without a separate HANDOFF.md. Use when the user types /plan-epic, or asks to plan, scope, or break down an epic, feature, or large task into beads issues.
user-invocable: true
argument-hint: <subject to plan — a feature, refactor, migration, or prose goal>
---

# plan-epic

Turn a fuzzy goal into a **beads epic that runs itself**. The skill investigates the subject with parallel agents, decomposes it into ordered child issues, and — the point of it — embeds a **Handoff Protocol** in the epic bead so every fresh `ralph` iteration knows how to pick the next issue, `/cook-it` it, and update the epic's own state. The epic replaces the per-project `HANDOFF.md` file, so many epics can be in flight at once without a pile of handoff files to maintain.

## When this fits

- The work is bigger than one `/cook-it` task and wants breaking into several issues.
- You'll run it later, unattended, with `/ralph` looping `/cook-it` over the backlog.
- You want the plan, the state, and the "what next" instructions to live in one place that survives fresh-context iterations.

Not this skill: a single bounded task (use `/cook-it` directly), or open-ended "what should we even do here?" exploration (discuss first, then plan).

## Prerequisites

- Run from the **project root** of the repo the work lives in. The epic and children are created in that repo's `.beads/` database.
- If there's no `.beads/` here, run `bd init` first (ask the user if it's the right repo before initializing).
- Confirm `bd` and the target repo are the right ones before writing anything.

## The flow

### 0. Scope the subject

Read the request. If it's underspecified in a way that changes the decomposition (unstated platform, unclear boundary of what's in vs out, a decision only the user can make), ask 1–3 sharp questions with `AskUserQuestion`. Otherwise proceed — investigation resolves most gaps.

State back, in one or two sentences, the outcome the epic delivers and what's explicitly out of scope. This becomes the epic's Goal.

### 1. Create the epic shell

Create the epic first so investigators and children can reference its id:

```bash
bd create "<epic title>" --type epic -p 1 \
  -d "Goal: <one-paragraph outcome>. Out of scope: <...>. Plan in progress." \
  --json
```

Capture the returned id (e.g. `bd-1a2b3c`) — call it `$EPIC` below.

### 2. Investigate in depth (fan-out)

Decompose the subject into **3–6 investigation areas** — the facets that actually matter for *this* subject, not a fixed checklist. Typical facets: current-state/codebase recon, data model, external APIs/constraints, UI surface, testing strategy, migration/rollout, risks and unknowns.

#### Investigation ownership

Deep source reading in the main thread burns the context that synthesis needs —
that's why investigators exist. The main thread does only enough orientation to
define the areas: confirm the repo and Beads database, check worktree state,
read a small top-level file inventory or existing architecture index. The
investigators own deep source inspection.

After dispatching them, don't repeat their work — no broad searches, no
re-reading the files they're auditing, no independently validating every cited
finding. While they run, prepare the synthesis structure or handle unrelated
prerequisites. If a result lacks evidence or misses a facet, send a focused
follow-up to that investigator or dispatch a narrow gap investigator; don't
rebuild the answer in the main context. Read the returned findings once, then
synthesize — spot-check only a concrete conflict that affects decomposition.

Dispatch **one agent per area, in parallel**. Prefer the `Workflow` tool when available (the sketch below); otherwise send parallel `Agent` (`general-purpose` / `Explore`) calls in a single message. Each investigator gets a self-contained brief and returns:

- **Findings**: what exists today, the constraints, the risky unknowns — cited at `file:line` where it read code.
- **Proposed child issues**: for its area, a list of `{title, description, acceptance, depends_on}`. Descriptions must be self-contained — a fresh-context agent will implement them from the bead text alone. A proposal whose deliverable is knowledge rather than code should be titled `Research: …` (see step 3).

Use a structured `schema` so investigators return data, not prose, when using `Workflow`.

**Inline the area briefs in the script body — do not pass them through the `args` parameter.** The `args` channel has failed to bind in practice (`args` arrives `undefined` and the script dies on `args.map` before any agent runs). Inlining also makes the persisted script self-contained, so a resume or re-launch needs no side-channel data. If you do read `args` for anything, guard it: `if (!args) throw new Error('args did not bind — inline the data instead')`.

```js
export const meta = {
  name: 'plan-epic-investigate',
  description: 'Fan out investigators over facets of an epic and return child-issue specs',
  phases: [{ title: 'Investigate' }],
}
// Inline the epic id and full area briefs here — no args dependency.
const EPIC = 'bd-xxxxxx'
const AREAS = [
  { key: 'area-1', brief: `...self-contained brief with the evidence and questions...` },
  // one entry per investigation area
]
const ISSUE = { type: 'object', required: ['findings', 'issues'], properties: {
  findings: { type: 'string' },
  issues: { type: 'array', items: { type: 'object',
    required: ['title', 'description', 'acceptance'],
    properties: { title: {type:'string'}, description: {type:'string'},
      acceptance: {type:'string'}, depends_on: {type:'array', items:{type:'string'}} } } } } }
const results = await parallel(AREAS.map(a => () =>
  agent(`Investigate for epic ${EPIC}. ${a.brief}\nReturn findings (cite file:line) and self-contained child-issue specs.`,
    { label: `investigate:${a.key}`, phase: 'Investigate', schema: ISSUE })))
return results.map((r, i) => ({ area: AREAS[i].key, result: r ?? 'FAILED — dispatch a gap investigator for this area' }))
```

Read the results yourself in the main thread — you own synthesis, the user can't see agent output.

### 3. Synthesize and create the children

In the main thread:

- **Dedupe and merge** overlapping proposals across areas.
- **Order** them: pick a sensible sequence, and encode hard ordering as dependencies so `bd ready --parent $EPIC` only surfaces truly-claimable work. `bd link <later> <earlier>` means *earlier blocks later*.
- **Right-size**: each child is one `/cook-it`-able unit — concrete file-level changes, its own tests, a clear done state. Split anything too big.
- **Mark research children**: when a child's deliverable is knowledge, not code (recon, API exploration, a spike), title it `Research: …` or give it the `research` label, and write its acceptance as the questions it must answer. Runners expect its findings as a `bd comment` on the child and zero commits — an unmarked research child fails cook-epic's commits check and burns its retry budget.

Assign each synthesized child a stable key and normalize it to `{key, title,
description, acceptance, priority, depends_on}` before any Beads writes.

#### Delegate child creation when there are more than two children

- For one or two children, the main thread may create and link them directly.
- For **more than two children**, the main thread must not run the child `bd
  create` or `bd link` commands. Fan out child creation to writer agents in
  parallel.
- Give each writer only the repo root, epic id, and the complete normalized spec
  for **one child**. A writer may receive two children only when they are tightly
  coupled and sharing that context is cheaper than another agent. Never give a
  writer the full plan merely so it can create one bead.
- Each writer creates exactly its assigned child under the epic, edits no source,
  and returns `{key, id}`. Run writers in waves when concurrency is limited.
  Assume Beads supports concurrent writers; retry or reduce concurrency only
  after an actual lock/transient failure.
- After all ids return, dispatch one lightweight linker agent with only the
  `{key: id}` map and dependency edge list. It runs the `bd link` commands and
  returns `bd list --parent $EPIC --pretty`. It does not need child descriptions
  or investigation findings.
- The main thread verifies the returned tree read-only. Send corrections back to
  the responsible writer/linker; do not take over the mutations locally.

Investigation agents remain read-only. Child writers are a separate phase after
the main thread has finished synthesis.

For direct creation of one or two children, or as the command template supplied
to a child writer:

```bash
bd create "<child title>" --type task --parent $EPIC -p <priority> \
  --body-file - \
  --acceptance "<how we know it's done>" <<'EOF'
<self-contained description: what to change, which files, the contract, tests to add, non-goals>
EOF
# then order it:
bd link <this-id> <blocker-id>   # blocker-id blocks this-id
```

Show the user the resulting tree: `bd list --parent $EPIC --pretty`.

### 4. Write the Handoff Protocol into the epic

This is the deliverable that replaces `HANDOFF.md`. Rewrite the epic's description to the durable run-doc below. Fill the `<...>` placeholders — the real epic id, Goal, Out of scope, Context — and keep the protocol text itself **verbatim**: fresh iterations depend on it reading the same way every time.

```bash
bd update $EPIC --body-file - <<'EOF'
## Goal
<one-paragraph outcome the epic delivers>

## Out of scope
<what this epic deliberately does not touch>

## Context & architecture
<what a fresh-context agent needs before touching code: repo layout, key files
(path:line), conventions, constraints, and decisions already made. This section
is the shared brain — edit it when a decision changes how the REMAINING children
should be built, so the next iteration inherits it.>

## Handoff Protocol  — you are ONE iteration of an unattended ralph loop
Do exactly one unit of work, update this epic, then stop.

1. Orient: `bd show <EPIC> --long` (this doc + the append-only progress log in
   notes) and `bd ready --parent <EPIC> --json` for claimable children.
2. Pick the top-priority ready child. If none are ready but open children remain,
   they are dependency-blocked — do NOT invent work; check `bd blocked` and stop
   if truly stuck.
3. Execute it: `/cook-it <child-id>`. That cooks the child end-to-end, scaling
   process to the child — plan and critique only when the spec leaves choices
   open, review matched to the change — then gate, commit, push, close. A
   `Research:` child delivers findings as a `bd comment` on itself (no commits,
   no gate). Never weaken tests. Never edit a child's scope — only its
   status/notes.
4. Before you stop, update THIS epic:
   - Append one line to the progress log:
     `bd note <EPIC> "<child-id> done — <what changed>; commit <hash>. Next: <the pointer the next iteration should act on>."`
     The LAST note is the live "what's next" — the next iteration reads it first.
     A last note without a `Next:` (e.g. from a parallel run) means fall back to
     `bd ready`.
   - Discovered new work? Create it as a child now:
     `bd create "<title>" --type task --parent <EPIC> --deps discovered-from:<child-id> ...`
     and link any ordering. Mention it in your note.
   - A decision or gotcha that changes remaining children? Edit "Context &
     architecture" above via `bd update <EPIC> --body-file -` so it carries forward.
5. When `bd ready --parent <EPIC>` is empty AND no open children remain, the epic
   is done: `bd close <EPIC>` with a one-paragraph summary, then output RALPH_DONE.

## Parallel mode — you are ONE worker of a concurrent cook-epic pool
When this epic runs under `/cook-epic` instead of sequential ralph:
- The coordinator assigns your child from `bd ready --parent <EPIC>` — work
  only it, never claim another. Notes are a pure append-only log: append your
  progress, never read the last note as a pointer.
- Run cheap checks only (typecheck, lint, unit tests on touched files); the
  coordinator runs the full gate once at merge time.
- Discovered new work? Create it as a child (`--deps discovered-from:<child-id>`)
  and mention it in your note — the coordinator schedules it; never start it.
- Never close another child, and never close THIS epic — the coordinator
  closes it.
- Commit and push only your own `epic/<child-id>` branch. The coordinator owns
  every merge into the base branch.
- Decisions that change how REMAINING children should be built still go into
  "Context & architecture" — your sibling workers read it before starting.
EOF
```

Append the first "Next up" pointer as the seed note so iteration 1 has a starting point:

```bash
bd note $EPIC "Epic planned. Next: pick the first ready child via bd ready --parent $EPIC and /cook-it it."
```

### 5. Report and hand off to the user

Report first, in every case:

- The epic id and the child tree (`bd list --parent $EPIC --pretty`).
- Any decisions you made or open questions worth their eyes.

Then either **launch the loop** or **hand over the command**, decided by what the user asked
for. Nothing else about the plan changes between the two.

**Launch it** when the request said to act on the plan, not just produce it — "/plan-epic X
and run it", "…then start cooking", "plan and execute", "kick it off". Treat that as the
authorization; don't ask again. Invoke the `ralph` skill with the loop prompt:

```
skill: ralph
args: /cook-it <EPIC>
```

No `-` separator here: skill stacking is a *typed-message parser* behavior, so an argument
passed through the Skill tool never trips it. Then follow ralph's own reporting contract —
relay each finished iteration, stay quiet in between.

If the request asked for **parallel** execution ("in parallel", "swarm it", "several workers"),
invoke the `cook-epic` skill with the epic id instead of ralph — it runs a pool of
fresh-context workers over the ready frontier with isolated worktrees and
coordinator-owned merges. Sequential ralph remains the default: it is the safer
choice when children overlap heavily or the tree isn't clean.

Two things still stop you, even under an explicit "run it":

- **A dirty working tree with someone else's changes.** Ralph assumes exclusive use of the
  repo. Surface it and ask before launching.
- **No ready children** (`bd ready --parent $EPIC` is empty while open children remain). The
  dependency graph is over-constrained — fix the ordering, don't start a loop that immediately
  gutters.

**Hand it over** when the user only asked to plan. Print the command for the harness you're running in (both forms below) and copy it:

```
/ralph - /cook-it <EPIC>

codex:
$ralph $cook-it <EPIC>
```

Offer the parallel alternative alongside when the children are largely independent:

```
/cook-epic <EPIC>
```

No prose needed in it: `/cook-it <epic-id>` detects `issue_type: epic` and runs one iteration
of the Handoff Protocol above, and ralph's runner already appends the one-unit-of-work /
commit / `RALPH_DONE` rules to every iteration's prompt.

**Keep the `-`.** Claude Code *stacks* skills typed back to back: `/ralph /cook-it <EPIC>`
expands both, handing the trailing `<EPIC>` to each as `$ARGUMENTS`. Ralph would get a bare
epic id as its loop prompt (not `/cook-it <EPIC>`), and cook-it would fire in the foreground
at the same time. Expansion stops at the first token that isn't an inline skill, so the `-`
keeps `/cook-it <EPIC>` intact as ralph's literal argument, and the leading dash is inert in
the child's prompt. Codex's `$` form doesn't stack, so it needs no separator.

Put it on the clipboard too, picking the form that matches the harness you're running in
(Claude Code → the `/` form, Codex → the `$` form). Best-effort: if there's no clipboard tool
or display — a remote or headless session — say so in one clause and move on. Never let this
fail the handoff.

```bash
for c in "wl-copy" "xclip -selection clipboard" "pbcopy"; do
  command -v ${c%% *} >/dev/null 2>&1 &&
    printf '/ralph - /cook-it %s' "$EPIC" | $c && echo "copied to clipboard" && break
done
```

## Why the handoff lives on the epic

- **One source of truth per epic.** Goal, architecture, live state, and "what next" sit on the bead, not in a file that collides when several epics are active.
- **Append-only log, no clobbering.** Progress goes to `bd note` (append-only, first-class in beads), so sequential ralph iterations never race a read-modify-write. The description holds the *stable* doc; only the shared-brain Context section is edited, and only on a real decision change.
- **The last note is the pointer.** Instead of maintaining a mutable "Next up" block, each iteration ends its note with `Next: …`. The freshest instruction is always the last line of the log.

## Cautions

- Keep the Handoff Protocol text stable across epics. If you improve it, improve it here in the skill so every future epic gets the better version, rather than hand-editing one epic.
- Don't over-decompose. Children that are too fine create loop overhead; children that are too coarse choke `/cook-it`. One reviewable commit's worth of work each is the target.
- Order with dependencies, not priorities alone — `ralph` claims by readiness, so a child that must come first has to *block* the others, or it can be picked early; priorities only break ties within the ready frontier.
