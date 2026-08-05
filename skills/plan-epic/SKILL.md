---
name: plan-epic
description: Plan a large piece of work as a beads epic — investigate the subject in depth with a fan-out of agents, create the epic and its child issues, then write a self-contained handoff protocol into the epic itself so /cook-epic runs it end-to-end without a separate HANDOFF.md. Use when the user types /plan-epic, or asks to plan, scope, or break down an epic, feature, or large task into beads issues.
user-invocable: true
argument-hint: <subject to plan — a feature, refactor, migration, or prose goal>
---

# plan-epic

Turn a fuzzy goal into a **beads epic that runs itself**. The skill investigates the subject with parallel agents, decomposes it into ordered child issues, and — the point of it — embeds a **Handoff Protocol** in the epic bead so every fresh-context iteration knows how to pick the next issue, execute it, and update the epic's own state. The epic replaces the per-project `HANDOFF.md` file, so many epics can be in flight at once without a pile of handoff files to maintain.

`/cook-epic <EPIC>` is the only runner this skill hands off to. It decides
sequential versus parallel itself and re-reads the ready frontier every tick,
so an epic that is a chain at the start and wide in the middle needs no
decision from the user and no second command.

## When this fits

- The work is bigger than one `/cook-it` task and wants breaking into several issues.
- You'll run it later, unattended, with `/cook-epic` over the whole tree.
- You want the plan, the state, and the "what next" instructions to live in one place that survives fresh-context iterations.

Not this skill: a single bounded task (use `/cook-it` directly), or open-ended "what should we even do here?" exploration (discuss first, then plan).

## Prerequisites

- Run from the **project root** of the repo the work lives in. The epic and children are created in that repo's `.beads/` database.
- If there's no `.beads/` here, run `bd init` first (ask the user if it's the right repo before initializing).
- Confirm `bd` and the target repo are the right ones before writing anything.

## The flow

### 0. Scope the subject

Read the request. If it's underspecified in a way that changes the decomposition (unstated platform, unclear boundary of what's in vs out, a decision only the user can make), ask 1–3 sharp questions. Use `AskUserQuestion` when the harness provides it; otherwise ask in a plain reply and wait for the user's answer. Otherwise proceed — investigation resolves most gaps.

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

Decompose the subject into **3–6 investigation areas** — the facets that actually matter for _this_ subject, not a fixed checklist. Typical facets: current-state/codebase recon, data model, external APIs/constraints, UI surface, testing strategy, migration/rollout, risks and unknowns.

#### Investigation ownership

Deep source reading in the main thread burns the context that synthesis needs —
that's why investigators exist. The main thread does only enough orientation to
define the areas: confirm the repo and Beads database, check worktree state,
read a small top-level file inventory or existing architecture index. The
investigators own deep source inspection. The exception is a harness with no
subagent tool and no usable headless CLI: in that mode the main thread must do
the investigation sequentially, keeping one area's notes compact before moving
to the next.

After dispatching them, don't repeat their work — no broad searches, no
re-reading the files they're auditing, no independently validating every cited
finding. While they run, prepare the synthesis structure or handle unrelated
prerequisites. If a result lacks evidence or misses a facet, send a focused
follow-up to that investigator or dispatch a narrow gap investigator; don't
rebuild the answer in the main context. Read the returned findings once, then
synthesize — spot-check only a concrete conflict that affects decomposition.
These dispatch rules apply only when investigators are available; in
main-thread-only mode, fill a missing facet directly before synthesis.

Choose the strongest investigation mode the harness provides:

1. Prefer the `Workflow` tool when available (the sketch below).
2. Otherwise, if a subagent tool is available, dispatch one subagent per area in
   parallel (`Agent` with `general-purpose` / `Explore`, or the harness's
   equivalent).
3. With no subagent tool, investigate the areas sequentially in the main thread.
   To preserve fresh context when a supported headless CLI is installed, you may
   instead write each self-contained brief to a temporary file, invoke the same
   harness as a one-shot process (`claude -p`, `codex exec`, or `kimi -p`), and
   read its output before synthesis. Do not assume shelling out is available.

Always try harness-native agent dispatch first. If an investigator fails due
to a provider limit, usage or spend limit, authentication failure, or provider
unavailability, retry only that failed area with the next harness. Use this
one-way order:

1. The configured Claude model remains primary.
2. Codex uses `gpt-5.6-sol` with high reasoning.
3. Kimi uses `kimi-code/k3`.

Skip a stage when its binary is missing or it exits 126 or 127. Never move
backward. Change harnesses only when a structured harness error reports a
rate, usage, spend, authentication, authorization, overload, or availability
failure. An explicit `provider-error` message also qualifies. Bare words such
as `authentication`, `service unavailable`, `401`, `429`, or `503` in task
output do not qualify. Do not change harnesses for a generic nonzero exit,
timeout, malformed result, protocol error, or child failure.

Use self-contained prompts for cross-harness retries. These are the headless
command shapes:

```bash
claude -p --permission-mode plan --output-format json --model <primary-model> -- "<prompt>"
codex -a never -s danger-full-access -m gpt-5.6-sol -c 'model_reasoning_effort="high"' exec --json "<prompt>"
kimi -p "<prompt>" --output-format stream-json -m kimi-code/k3
```

Keep successful investigation results. Retry only missing areas. Each retry
gets the original area brief and output schema, without another area's result.

Whichever mode is used, each investigator gets a self-contained brief and returns:

- **Findings**: what exists today, the constraints, the risky unknowns — cited at `file:line` where it read code.
- **Proposed child issues**: for its area, a list of `{title, description, acceptance, depends_on}`. Descriptions must be self-contained — a fresh-context agent will implement them from the bead text alone. A proposal whose deliverable is knowledge rather than code should be titled `Research: …` (see step 3).
- **Orientation card status**: whether the code repo already has a usable orientation card (`docs/agent-orientation.md` or an existing AGENTS.md-style file) and, if so, what's stale or missing from it — feeds step 3b directly.

Use a structured `schema` so investigators return data, not prose, when using `Workflow`.

**Inline the area briefs in the script body — do not pass them through the `args` parameter.** The `args` channel has failed to bind in practice (`args` arrives `undefined` and the script dies on `args.map` before any agent runs). Inlining also makes the persisted script self-contained, so a resume or re-launch needs no side-channel data. If you do read `args` for anything, guard it: `if (!args) throw new Error('args did not bind — inline the data instead')`.

```js
export const meta = {
  name: "plan-epic-investigate",
  description: "Fan out investigators over facets of an epic and return child-issue specs",
  phases: [{ title: "Investigate" }],
};
// Inline the epic id and full area briefs here — no args dependency.
const EPIC = "bd-xxxxxx";
const AREAS = [
  { key: "area-1", brief: `...self-contained brief with the evidence and questions...` },
  // one entry per investigation area
];
const ISSUE = {
  type: "object",
  required: ["findings", "issues"],
  properties: {
    findings: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "description", "acceptance"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          acceptance: { type: "string" },
          depends_on: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};
const results = await parallel(
  AREAS.map(
    (a) => () =>
      agent(
        `Investigate for epic ${EPIC}. ${a.brief}\nReturn findings (cite file:line) and self-contained child-issue specs.`,
        { label: `investigate:${a.key}`, phase: "Investigate", schema: ISSUE },
      ),
  ),
);
return results.map((r, i) => ({
  area: AREAS[i].key,
  result: r ?? "FAILED — dispatch a gap investigator for this area",
}));
```

Read the results yourself in the main thread — you own synthesis, the user can't see agent output.

### 3. Synthesize and create the children

In the main thread:

- **Dedupe and merge** overlapping proposals across areas.
- **Order** them: pick a sensible sequence, and encode hard ordering as dependencies so `bd ready --parent $EPIC` only surfaces truly-claimable work. `bd link <later> <earlier>` means _earlier blocks later_.
- **Right-size**: each child is one `/cook-it`-able unit — concrete file-level changes, its own tests, a clear done state. Split anything too big.
- **Mark research children**: when a child's deliverable is knowledge, not code (recon, API exploration, a spike), title it `Research: …` or give it the `research` label, and write its acceptance as the questions it must answer. Runners expect its findings as a `bd comment` on the child and zero commits — an unmarked research child fails cook-epic's commits check and burns its retry budget.

Assign each synthesized child a stable key and normalize it to `{key, title,
description, acceptance, priority, depends_on}` before any Beads writes.

#### Create children without overloading the main context

- For one or two children, the main thread may create and link them directly.
- For **more than two children**, fan out child creation to writer subagents in
  parallel when the harness provides a subagent tool. Without one, create and
  link the normalized children sequentially in the main thread.
- Give each writer only the repo root, epic id, and the complete normalized spec
  for **one child**. A writer may receive two children only when they are tightly
  coupled and sharing that context is cheaper than another agent. Never give a
  writer the full plan merely so it can create one bead.
- Each writer creates exactly its assigned child under the epic, edits no source,
  and returns `{key, id}`. Run writers in waves when concurrency is limited.
  Assume Beads supports concurrent writers; retry or reduce concurrency only
  after an actual lock/transient failure.
- After all ids return, dispatch one lightweight linker subagent, when available, with only the
  `{key: id}` map and dependency edge list. It runs the `bd link` commands and
  returns `bd list --parent $EPIC --pretty`. It does not need child descriptions
  or investigation findings. Without a subagent tool, run those links directly.
- The main thread verifies the returned tree read-only. When writers/linkers were
  used, send corrections back to the responsible one rather than taking over its
  mutations locally.

Apply the same Claude to Codex to Kimi fallback to failed child writers and the
linker. Retry only failed jobs. Mutation results can be ambiguous when a
provider fails after the command runs. Before retrying a writer, check whether
its child already exists under `$EPIC`. Before retrying the linker, inspect the
current dependency graph. Continue from the observed Beads state so retries do
not create duplicate children or links.

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

### 3b. Create or refresh the orientation card

For each CODE repo the epic touches:

1. **Location**: the card lives in the CODE repo (the repo the children edit), not the beads repo — for multi-repo epics like health (beads at `/home/yiin/Projects/health`) -> dashboard-health (code at `/home/yiin/Projects/dashboard-health`) these differ. Default location: `docs/agent-orientation.md` in the code repo. If the repo already keeps operational agent docs elsewhere (e.g. an AGENTS.md with literal commands — dashboard-health has an 8.3KB one), extend that file instead of creating a duplicate.
2. **Content**: mirror the epic Context template — path map with one-line responsibilities, literal check commands, conventions/vocabulary pointers, gotchas. Hard budget ~4KB. Operational facts only; no narrative architecture prose. Write it FROM the investigator findings of step 2 (self-contained file:line path maps) — that's exactly the material workers otherwise re-derive.
3. **Refresh, don't rewrite**: if a card already exists, verify each mandated section is present and current; update only stale or missing parts. If it's current, skip the write.
4. **Commit before handoff**: commit the card to the code repo before finishing this step. cook-epic's preflight hard-stops on uncommitted tracked changes, so an uncommitted card blocks the run.
5. **Reference it from the epic**: the Context's `### Orientation card` bullet (step 4 below) must hold the card's ABSOLUTE path, one bullet per code repo the epic touches — workers run `bd` from the beads repo, so relative paths don't resolve.

### 4. Write the Handoff Protocol into the epic

This is the deliverable that replaces `HANDOFF.md`. Rewrite the epic's description to the durable run-doc below. Fill the `<...>` placeholders — the real epic id, Goal, Out of scope, Context — and keep the protocol text itself **verbatim**: fresh iterations depend on it reading the same way every time.

```bash
bd update $EPIC --body-file - <<'EOF'
## Goal
<one-paragraph outcome the epic delivers>

## Out of scope
<what this epic deliberately does not touch>

## Context & architecture
<!-- HARD BUDGET: this section stays under 4096 bytes. Operational facts only:
paths, literal commands, exact terms, dated rules. NO narrative architecture
prose — if a sentence explains how the system works instead of what to do,
cut it. No 'Order' prose: ordering lives in the dependency graph only. -->

### Repos & where things live
- BEADS: <absolute path> — run every bd command from here.
- CODE: <absolute path> — child-issue file paths are relative to this repo.
- <path> — <one-line responsibility>
(max 12 path entries; key files and dirs only)

### Check commands
- Typecheck: `<literal command>` (from <dir>)
- Focused tests: `<literal command>`
- Lint: `<literal command>`

### Vocabulary & contracts
- Use these terms exactly: <terms, or pointer to the glossary file>.
- <contract doc path> binds <what it binds>. (one line per contract)

### Do not
- <imperative gotcha: don't X, do Y instead> (<YYYY-MM-DD> <child-id>)

### Decisions
- <YYYY-MM-DD> <child-id>: <decision stated as the new rule, one line>

### Orientation card
- Read <absolute path to the card in the CODE repo> before touching code.
  If it contradicts this section, this section wins for this epic.

## Handoff Protocol  — you are ONE iteration picking its own next child
This applies when something runs the epic id itself (`/cook-it <EPIC>`) rather
than assigning you a child. Do exactly one unit of work, update this epic, then
stop. If a coordinator assigned you a specific child, skip to "Worker mode".

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
   - Append one note (max 400 characters) to the progress log:
     `bd note <EPIC> "<child-id> done — <what changed>; commit <hash>. Next: <the pointer the next iteration should act on>."`
     The LAST note is the live "what's next" — the next iteration reads it first.
     A last note without a `Next:` (e.g. from a parallel run) means fall back to
     `bd ready`. Any decision that changes how remaining children should be built
     goes inside the note as `DECISION: <one line>`; any trap the next iteration
     must avoid goes in as `GOTCHA: <one line>`.
   - Discovered new work? Create it as a child now:
     `bd create "<title>" --type task --parent <EPIC> --deps discovered-from:<child-id> ...`
     and link any ordering. Mention it in your note.
   - Fold this same note's `DECISION:`/`GOTCHA:` markers into "Context &
     architecture" now, in this same iteration:
     `bd show <EPIC> --json | jq -r '(if type=="array" then .[0] else . end).description' > /tmp/epic-body.md`,
     move each `DECISION:`/`GOTCHA:` payload into `### Decisions` / `### Do not`
     as a dated entry, delete any bullet the new decision supersedes, then write
     back with `bd update <EPIC> --body-file /tmp/epic-body.md`. Pruning rule:
     when the section exceeds 4096 bytes, delete entries that only applied to
     now-closed children, then the oldest Do-not entries. Never delete Repos,
     Check commands, or Vocabulary & contracts.
5. When `bd ready --parent <EPIC>` is empty AND no open children remain, the epic
   is done: `bd close <EPIC>` with a one-paragraph summary, then output RALPH_DONE.

## Worker mode — you are ONE worker dispatched by cook-epic
When this epic runs under `/cook-epic`, the coordinator may be running you alone
or alongside siblings; it decides that per tick and you never need to know which.
Your worker prompt is the authority on WHERE you commit (your own
`epic/<child-id>` branch in a worktree, or the base branch in the main checkout
in sequential mode) — follow it over the branch wording below. Either way:
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
- Never edit this epic's body. Put decisions and gotchas in your single
  close-out note as `DECISION: …` / `GOTCHA: …` lines — the coordinator folds
  them into Context & architecture after your branch lands.
EOF
```

Append the first "Next up" pointer as the seed note so iteration 1 has a starting point:

```bash
bd note $EPIC "Epic planned. Next: pick the first ready child via bd ready --parent $EPIC and /cook-it it."
```

### 5. Report and hand off to the user

Every successful planning response must emit this exact single-line terminal
marker:

```text
T3_EPIC_PLAN: {"v":1,"epicId":"<EPIC>"}
```

The grammar is strict: the prefix is `T3_EPIC_PLAN: `, the JSON object contains
exactly `v` (the number `1`) and non-empty string `epicId`. Do not place
marker-like prose elsewhere.

- For a plan-only handoff, finish all handoff and clipboard prose first, then
  emit the marker as the absolute final line of the response.
- When launching a loop, emit the marker after all planning/handoff prose and
  immediately before the launched loop begins producing output. The loop's own
  reporting may follow it.

Report first, in every case:

- The epic id and the child tree (`bd list --parent $EPIC --pretty`).
- Any decisions you made or open questions worth their eyes.

Then either **launch the run** or **hand over the command**, decided by what the user asked
for. Nothing else about the plan changes between the two.

**`/cook-epic <EPIC>` is the one and only way to run an epic.** Never offer
`/ralph - /cook-it <EPIC>` as an alternative, and never editorialize about
sequential versus parallel — that is cook-epic's decision, not the user's.
cook-epic dispatches from the live `bd ready` frontier every tick, so it runs
one worker while the graph is a chain and fills the pool the moment it fans
out. An epic that is sequential at the start and parallel in the middle needs
no choice from anyone. Do not describe an epic as "largely independent" or
"better run sequentially" in the handoff; hand over the command and stop.

**Launch it** when the request said to act on the plan, not just produce it — "/plan-epic X
and run it", "…then start cooking", "plan and execute", "kick it off". Treat that as the
authorization; don't ask again. Invoke the `cook-epic` skill with the epic id, using the
harness's native skill invocation when it provides one; otherwise read the `cook-epic` skill
body and follow it. Then follow cook-epic's own reporting contract — relay each mailbox event
line, stay quiet in between.

Two things still stop you, even under an explicit "run it":

- **A dirty working tree with someone else's changes.** cook-epic assumes exclusive use of the
  repo, and its preflight hard-stops on uncommitted tracked changes. Surface it and ask before
  launching.
- **No ready children** (`bd ready --parent $EPIC` is empty while open children remain). The
  dependency graph is over-constrained — fix the ordering, don't start a run that immediately
  gutters.

**Hand it over** when the user only asked to plan. Print exactly one command, in
the form the harness you're running in expands:

| Harness capability        | Command                                        |
| ------------------------- | ---------------------------------------------- |
| Claude Code typed skills  | `/cook-epic <EPIC>`                            |
| Codex native skills       | `$cook-epic <EPIC>`                            |
| No native skill expansion | Paste the `cook-epic` skill body with `<EPIC>` |

No prose belongs in it and no second option belongs beside it. cook-epic reads
the epic, picks its own execution shape, and re-picks its concurrency every
tick from the ready frontier.

Put it on the clipboard too, picking the form that matches the harness you're running in
(Claude Code → the `/` form, Codex → the `$` form). Best-effort: if there's no clipboard tool
or display — a remote or headless session — say so in one clause and move on. Never let this
fail the handoff. Set `HANDOFF_COMMAND` to the exact Claude or Codex command you printed before
running the snippet. The no-expansion fallback includes a skill body and cannot be represented
by this short command, so skip clipboard copying for that mode and say so.

```bash
HANDOFF_COMMAND="/cook-epic $EPIC" # Claude Code
# HANDOFF_COMMAND="\$cook-epic $EPIC" # Codex
for c in "wl-copy" "xclip -selection clipboard" "pbcopy"; do
  command -v ${c%% *} >/dev/null 2>&1 &&
    printf '%s' "$HANDOFF_COMMAND" | $c && echo "copied to clipboard" && break
done
```

## Why the handoff lives on the epic

- **One source of truth per epic.** Goal, architecture, live state, and "what next" sit on the bead, not in a file that collides when several epics are active.
- **Append-only log, no clobbering.** Progress goes to `bd note` (append-only, first-class in beads), so concurrent workers never race a read-modify-write. `bd update --body-file` replaces the whole description with no compare-and-swap, so concurrent writers clobber each other — that's why exactly one writer per mode ever edits the body: in iteration mode the same agent folds its own note in the same turn; under `/cook-epic` only the coordinator writes the body, folding workers' `DECISION:`/`GOTCHA:` markers in after each child lands.
- **The last note is the pointer.** Instead of maintaining a mutable "Next up" block, each iteration ends its note with `Next: …`. The freshest instruction is always the last line of the log.

## Cautions

- Keep the Handoff Protocol text stable across epics. If you improve it, improve it here in the skill so every future epic gets the better version, rather than hand-editing one epic.
- Don't over-decompose. Children that are too fine create loop overhead; children that are too coarse choke `/cook-it`. One reviewable commit's worth of work each is the target.
- Order with dependencies, not priorities alone — cook-epic dispatches by readiness, so a child that must come first has to _block_ the others, or it can be picked early (and picked up in parallel with work it should have followed); priorities only break ties within the ready frontier. The dependency graph is the ONLY thing that makes cook-epic run children in order, and it is also what lets cook-epic widen automatically the moment order stops mattering. Encode real ordering, and nothing more — a spurious dependency serializes work that could have run concurrently.
