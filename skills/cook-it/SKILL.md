---
name: cook-it
description: Cook a task end-to-end — plan when the instructions leave choices open → critique the plan when it warrants it → implement → review the implementation at a depth matched to its size and nature → quality gate → commit & push. Use when the user types `/cook-it <task>` (e.g. `/cook-it vangrd-uqi2`, `/cook-it fix the cascade in foo.ts`). Suitable for well-scoped engineering tasks where the path is clear enough to commit to but worth double-checking via independent agents. Given a beads epic id, it instead runs one iteration of that epic's Handoff Protocol — cook the top ready child, then update the epic.
user-invocable: true
argument-hint: <issue id, epic id, or short task description>
---

# Cook It

End-to-end execution of a well-scoped engineering task. You own the **result**, not a checklist. The fixed spine is plan → implement → verify → gate → commit; the variable part is how much independent scrutiny each stage gets, and you decide that from the task itself. A one-line fix and a multi-subsystem feature deserve different amounts of review — spending three agents on the former is waste, spending one on the latter is negligence. **The justification burden runs both ways**: name the criterion that let you scale a step down, and name the one that made you escalate past the baseline. Unjustified ceremony is as much a defect as unjustified confidence, and most tasks that reach this skill are small — the cheap path is the default, not the exception.

**Model tiers (Claude-family harness only).** When you dispatch subagents, match the model to the stage: plan-composition and plan-critique agents get model `opus`, implementer agents get model `sonnet`, reviewer agents get model `fable`. Work done in your own session stays on the session model. If the user named a model explicitly, that pins every stage instead.

If a `fable` dispatch fails because the model is unavailable or its usage limit is exhausted, re-dispatch that same agent on model `opus` and carry on. Say in one clause that reviews ran on `opus`. Never drop the review stage over a model limit, and never downgrade it to the session thread while a fallback model is available.

**Harness fallback (applies to every dispatch below).** When the harness provides subagents, use them. Otherwise invoke a fresh one-shot process of the same headless harness with a self-contained brief in a temporary file (following `ralph/run.sh`'s invocation pattern) — except for repository writes, which stay in the main thread. If the same harness cannot be invoked headlessly at all, do the step in the main thread and say plainly that independent review was unavailable.

## When this skill fits

- The task is concrete and bounded (a bug fix, a small refactor, one-feature implementation).
- The codebase is in a clean working state — no uncommitted unrelated changes.
- You can read the issue or task description and form a defensible plan from project context alone, without further user clarification.

## When to bail out and ask instead

- The task is exploratory ("what could we do about X?") — go discuss it first.
- The plan requires architectural decisions the user hasn't weighed in on.
- The working tree has unrelated uncommitted changes that would get mixed into the commit.
- The quality gate is already red on the current branch for reasons unrelated to the task.

If any of these apply, stop and surface it to the user before cooking.

**Unattended runs.** You are unattended whenever nobody can answer mid-run: a headless one-shot invocation, a `ralph` loop, a `cook-epic` worker. There, "stop and ask the user" is not a real option — it stalls the loop or burns the iteration. So decide, and decide well.

Everywhere the skill says to ask, resolve it yourself instead: work out what the task is plainly trying to achieve, assume the author meant the sensible thing, and take the option that best serves that goal. Issue text, bead wording, and plan prose are guidance, not spec — when they are ambiguous, underspecified, or lightly wrong about the code, follow their intent rather than their letter, and say in your report where you departed and why. A defensible call the user can veto afterwards beats a stalled run every time. Record the call in the commit message or the issue so it is reviewable. Step 5 spells out the gate case.

Two things this does not license. Never silently bypass a check — scaling verification still goes through the routing criteria, and skipping it because nobody is watching is not one of them. And do not guess at a decision that is genuinely the user's: an irreversible or outward-facing action, or a product, security, or policy call with real consequences either way and no clearly better option. Those you park — do the work that does not depend on the answer, leave the rest, file the issue naming the exact decision needed, and say so in your report. The test is not "is this ambiguous?" but "would a reasonable person reading the goal land somewhere obvious?" If yes, land there.

## Three routing decisions

Make all three explicitly, before dispatching anything, and state them to the user alongside the plan (or the adopted instructions).

**1. Does the task need a composed plan?** Skip planning when the instructions already tell you what to do:

- The bead or task description carries a concrete, followable plan — file-level steps, enumerated tests, pinned behavior.
- The work is inherently plan-free: translations, mechanical renames, config tweaks, "run tests / check the build" verification, research where the findings are the deliverable.

In those cases adopt the written instructions as the plan — verify they still match the code (files exist, commands are current), then say so: _"Bead spec is already a followable plan — skipping plan composition."_ Compose a plan only when the instructions leave real choices open: vague scope, unstated approach, several plausible implementations.

**2. Does the plan warrant critique?** Review the governing plan — composed or adopted — in step 2 if any of these hold:

- It makes an architectural or data-shape choice that has plausible alternatives.
- It adds or modifies a path parallel to an existing one (a new trigger alongside a click path, a new write path, a new handler beside a sibling) — omission bugs live here.
- It spans more than ~3 files, crosses subsystem boundaries, or changes a public contract, schema, or migration.
- Any step of your own safety argument takes more than a sentence to defend.

If none hold — single-file fix, mechanical change, behavior fully pinned down by the issue — skip the plan critique and implement. Say so: _"Plan is simple (single file, no sibling paths, no contract change) — skipping plan review."_

**3. What shape of implementation review does the change need?** The review always runs for code changes; its shape scales (step 4):

- **Evidence-only** — for plan-free mechanical work whose outcome direct evidence already proves (a translation diff, a green test run, research findings posted to the bead): no reviewer agent; cite the evidence in your report instead. Never for logic changes.
- **Self-review** — for a logic change that meets all three: it is small (one file, one concern), it has **no sibling path** it parallels, and it is fully covered by a test the same change adds, which you watched fail before the fix and pass after. You run step 4's checklist yourself over `git diff HEAD`; no reviewer agent. State the three conditions in your report. The moment a parallel path exists, this tier is off.
- **Baseline** — one reviewer agent over the diff. Right for small, single-concern changes that miss any self-review condition.
- **+ Design review** — the diff touches UI (components, styles, layout, user-facing pages): add a reviewer that loads the `ui-ux-pro-max` skill first and audits the implementation against it — visual hierarchy, spacing, interaction states, accessibility, responsiveness, consistency with the product's existing style.
- **Fan-out** — the implementation is big (many files, several distinct concerns, new subsystem): partition it by its actual structure — core logic, error/edge paths, data layer, tests, UI — and dispatch one skeptical reviewer per part, in parallel. Each owns its part fully; at least one must run the omission/parity pass described in step 4.

## The flow

### 0. Resolve the argument — an epic means "run one iteration of it"

If the argument is a bd issue id, check what kind it is before planning anything:

```bash
bd show <id> --json | jq -r 'if type=="array" then .[0] else . end | .issue_type'
```

If that says **`epic`**, do NOT cook the epic itself — an epic is a backlog, not a unit of work, and cooking it directly would try to implement the whole thing in one pass. Instead, follow the **Handoff Protocol embedded in the epic's own description** (`bd show <epic> --long`), which is authoritative and overrides this section wherever they differ. The protocol governs iteration mechanics — which child, how to update the epic; process depth _inside_ the child still follows this skill's routing decisions, even when an older epic's protocol describes cook-it as always planning and critiquing. In the absence of anything more specific, it means:

1. `bd ready --parent <epic> --json` — pick the top-priority ready child.
2. If no children are ready but open ones remain, they're dependency-blocked. Check `bd blocked`, don't invent work, and stop.
3. Cook **that child** through steps 1–7 below. The epic is context, not the task. Routing decisions apply to the child as written: mechanical or research children (translations, "run tests / check build", findings-as-deliverable) typically skip planning and critique, and their review may shrink to citing direct evidence — see routing decision 3. For a `Research:` child the deliverable is findings posted as a `bd comment` on the child (plus a Context edit when they change remaining work) — no diff, no gate, no commit; close it with the headline findings.
4. Before finishing, update the epic per its protocol — append to its progress log, and edit its Context section when a decision you made changes how the _remaining_ children should be built. Fresh-context iterations inherit only what's written there.

One child per invocation. Stop after it, even if more are ready — the caller (usually a `ralph` loop) decides whether to run again.

Anything else — a non-epic issue id, or a prose task — proceeds straight to step 1.

### 1. Investigate and compose a plan (when the instructions warrant one)

If routing decision 1 said the instructions are already the plan, don't re-derive them: read just enough to confirm they still match the code, then share them (the text itself, or a one-line summary plus a pointer to the bead) together with the routing decisions, and move on.

Otherwise, read enough context to write a self-contained plan:

- What changes to make (file:line specifics, not "improve X").
- What tests to add and which scenarios they cover.
- Non-goals — what you're explicitly NOT touching, and why.
- Risks and the safety argument that justifies the approach.

Investigate until the plan is defensible, then stop — don't keep gathering context to re-derive what project context already establishes.

Share the plan with the user as a short markdown block before dispatching agents, ending with the three routing decisions and their one-line justifications. Don't ask for approval — the act of `/cook-it` is the approval. The plan and routing are shown so the user can interrupt if they spot something off.

### 2. Critique the plan (when it warrants it)

Use a fresh `general-purpose` reviewer to review the plan **without implementing**. The reviewer must:

- Have full self-contained context (issue summary, file paths to read, what the plan proposes, the safety claims you're making).
- Be asked to verify correctness, surface blind spots, check whether the safety reasoning holds, evaluate test coverage, and note any safer alternatives worth considering.
- **Apply a path-parity lens** when the change adds or modifies an entry point that parallels an existing one. Instruct the agent: _"Find the analogous existing path. Enumerate everything it does on each invocation — every call, every invariant it maintains, every cleanup. Verify the new path does each, or the plan states a reason not to."_ The most damaging bugs are omissions — the new path silently skips something its sibling does (nonce rotation, cache invalidation, cleanup, event emission). These are invisible in a diff and only surface by reading the two paths side by side.
- Report back under ~500 words, citing file:line.

Fold any reasonable feedback into a refined plan. If the agent flags blockers you can't dismiss with confidence, stop and surface them to the user.

**Point the reviewer at sibling paths even when they're non-goals.** A non-goal means _don't modify X_, not _don't read X_. If you fence off the very code that defines the invariant the new path must honor, the reviewer looks away from the answer. List sibling/reference paths explicitly and say "read these for parity; don't change them." When a sibling carries an issue-tagged comment explaining a non-obvious invariant (e.g. `// ... (PRO-294)`), hand that context to the reviewer as "this invariant must survive."

### 3. Implement

Implement the governing plan — refined by critique when it ran, otherwise as composed or adopted. Spawn a `general-purpose` implementer, or work in the main thread when the harness has no subagents, or when the work is plan-free and small enough to do directly (a translation edit, running a verification command). A spawned implementer must:

- Receive the full plan text (not "implement based on the review"), including exact file paths, the behavior contract the change must honor, and the test cases to cover.
- Be told what NOT to change (non-goals from the plan) to prevent scope creep.
- Be instructed to invoke the project's `dev-commands` skill (or read its `SKILL.md`) before running typecheck/lint/test — never guess `npm test` vs `bun run test` etc.
- Run, in order: any new or changed tests alone (sanity), then typecheck, then lint on changed files — using the commands `dev-commands` gives, never guessed.
- Report files changed and any unexpected output. Not commit — that's a later step.

If the implementation turned out substantially bigger or different in kind than the plan predicted (e.g. it grew a UI surface, or spilled into a subsystem the plan didn't name), revisit routing decision 3 now — the review shape follows what was actually built, not what was planned.

### 4. Review the implementation

Always runs, in the shape chosen (and possibly revised) above. Two shapes are agent-free: **evidence-only** collapses this step to stating the evidence (the diff or output that proves the outcome) in your report, and **self-review** means you apply the checklist below to `git diff HEAD` yourself. Otherwise, dispatch the chosen shape — one baseline reviewer, plus a design reviewer, or one per fan-out part — and have them hunt for **improvements, not just defects**. A working implementation that's needlessly complex, inconsistent with the codebase, or missing an obvious simplification should come back with that feedback.

Every reviewer must:

- Read the diff via `git diff HEAD` and any new test files directly.
- Verify the code matches the contract (state machine correctness, error paths, comment quality, style).
- Verify the tests actually exercise the behavior they claim to (e.g. for a coalescing test, prove dropped items were dropped, not just that the function was called) — and that they would catch a parity regression (the test fails if the sibling's invariant is dropped).
- Confirm the diff scope is limited to what the plan said.
- Report under ~400 words with a verdict: APPROVE / APPROVE-WITH-NITS / BLOCK.

**The omission/parity pass is mandatory whenever the change adds or modifies a path parallel to an existing one** — no shape and no criterion excuses it, and its presence is what rules out the self-review tier. At least one reviewer (the only one, in baseline shape) applies the same parity lens as step 2, now to the diff. Diff review catches bad lines; it misses missing ones. The agent must open the sibling path (even if it's untouched and out of the diff), check the new path replicates every per-invocation step, and cite the sibling at file:line.

Shape-specific briefs:

- **Design reviewer** (UI changes): first invoke the `ui-ux-pro-max` skill (or read its SKILL.md), then audit the implemented UI against it — hierarchy, spacing, typography, interaction states, accessibility, responsive behavior, and consistency with the surrounding product. Verdict on the same APPROVE/BLOCK scale; a UI that works but reads as templated or inconsistent is APPROVE-WITH-NITS at best.
- **Fan-out reviewers** (big implementations): each gets one named part of the change and explicit instructions to be skeptical about _that part specifically_ — assume the implementer got it subtly wrong and try to prove it. Tell each reviewer what the other parts are so it flags cross-part gaps ("the error path in my part assumes the data layer validated X — did it?") instead of assuming someone else covers them. Dispatch them in parallel; they're independent reads.

Merge the verdicts: dedupe overlapping findings, drop nits you can defend ignoring (say why), and treat any single BLOCK as a BLOCK.

If BLOCK, describe exactly what to fix and send that brief back to the implementer (`SendMessage` or the harness's equivalent). Re-run only the reviewer(s) whose scope the fix touched, always with fresh context — never reuse the first reviewer's. Cap at two BLOCK rounds; if the second produces conflicting feedback, surface it to the user, or file it and stop when unattended.

### 5. Run the quality gate

If the task changed no code (research findings, a verification run), skip the gate and commit steps — the deliverable is the step-4 evidence and the issue closure in step 7.

Invoke the project's `dev-commands` skill to learn the exact gate commands — never guess them. The full gate in vangrd, for example, is `bun run typecheck:server && bun run typecheck:web && bun run lint && npm test`.

**Scale the gate to the change.** When the change stays inside one area, run the proportional gate: the typecheck for that area, lint on the changed files, and the tests that cover the change. Say which commands you ran. Run the full gate when the change crosses areas, touches shared types, config, or generated output, or when nothing downstream will run it. A downstream integration gate counts — cook-epic's `COOKEPIC_GATE`, a CI pipeline, a batching loop that gates once before pushing — so when one exists, the proportional gate is enough here.

**Pre-existing red.** First prove the red is pre-existing and unrelated: the failing files sit outside your diff, and the failure reproduces without your change (re-run that one target at the base commit in a scratch worktree — never `git stash`, the tree may hold another agent's work). If you can't prove it, treat the failure as yours and fix it. Once proven:

- **Attended:** stop and ask. Default offer: "fix auto-fixable lint as a drive-by in a separate commit, file a bug for any unrelated test failures, then commit the task work."
- **Unattended:** commit the task work, file a bd issue recording the exact failing command and its output, and name that issue in your final report.

Do not silently bypass the gate in either mode.

### 6. Commit and push

Follow `commit-conventions` (Conventional Commits, scoped). Two commits if you fixed pre-existing lint as drive-by:

1. `chore: <format/cleanup description>` — the drive-by.
2. `<type>(<scope>): <task summary>` — the task work.

The task commit body should reference the issue id (if any), summarize the change, state the safety argument, and note any considered-but-rejected alternative. Match recent commit style by reading `git log --format="%s%n%n%b" -3` first.

Push to remote. If on `main` or a protected branch, push directly. If on a feature branch with no upstream, `git push -u origin <branch>`.

### 7. Close the issue (if applicable)

If the task is tied to a bd issue, close it with a one-paragraph summary citing the commit hash and the verification evidence.

## Run it as a workflow when possible (Claude Code only)

Claude Code may provide the `Workflow` tool. When it is available, drive steps
2–5 through it instead of dispatching agents one call at a time. Other harnesses
must use their subagent tools or the fallback above; they must not assume the
Workflow API exists. Make the routing decisions in the main thread first,
then encode the chosen shape in the script: include a plan-critique stage only if
routing said so, and build the review stage as a single agent, agent + design
reviewer, or a `parallel()` fan-out to match the review shape. A workflow is
itself an escalation — for an evidence-only or self-review change, skip it and
work directly. Use a bounded `while` loop for the BLOCK→fix→re-review cycle
(cap at two rounds, then surface to the user), `phase()` calls that mirror the
numbered steps so the user can follow progress in `/workflows`, and `schema` on
the critique agents to get back a structured verdict (`APPROVE` /
`APPROVE-WITH-NITS` / `BLOCK` plus findings) rather than parsing prose.

Two parts stay in the main thread, outside the workflow:

- **Investigating and composing the plan (step 1).** The plan is passed into the workflow as `args`, so investigation — including any read-only recon subagents (e.g. Explore) — necessarily runs in the main thread before the workflow exists. The user can't see agent output, and the plan must be visible so they can interrupt. Compose it directly, then pass it into the workflow as `args`.
- **Commit and push (step 6).** These are outward-facing; run them yourself after the workflow returns its verdict and the gate is green, so you stay in control of what gets committed and pushed.

If the implementation comes back bigger than planned (step 3's revisit rule), let the workflow finish, then dispatch the missing reviewers yourself — the review shape follows the diff, not the script.

**Passing the plan as `args` — do this exactly.** The harness sometimes delivers `args` as a JSON-encoded string rather than a parsed object, so `args.plan` can silently be `undefined` and the critique agent receives the literal text "undefined" as its plan. Pass the governing plan text — the composed plan, or the adopted instructions when planning was skipped — as a **plain string** (`args: "<the full plan markdown>"`, not `args: {plan: ...}`), and start every script body with this guard so a malformed delivery fails loudly instead of wasting a run:

```js
const parsedArgs =
  typeof args === "string" && args.trim().startsWith("{") ? JSON.parse(args) : args;
const plan = typeof parsedArgs === "string" ? parsedArgs : parsedArgs && parsedArgs.plan;
if (!plan || typeof plan !== "string" || plan === "undefined" || plan.length < 80)
  throw new Error("plan args missing or truncated — refusing to run without the plan text");
```

## What not to do

- Don't skip or shrink verification out of confidence, and don't inflate it out of caution. Both directions need a named criterion, and neither confidence nor caution is one. The implementation review always runs for code changes; the evidence-only and self-review shapes replace the reviewer _agent_, not the review.
- Don't stall an unattended run waiting for an answer nobody will give. Take the documented unattended path, file what you would have asked, and report it.
- Don't run the _stages_ in parallel — each depends on the previous. Reviewers _within_ step 4's fan-out are the exception: they're independent reads and should run concurrently.
- Don't compose the plan inside an agent — the user can't see agent output, so the plan needs to be in your direct response.
- Don't amend commits to absorb late fixes. Stack additional commits.
- Don't force-push, ever, on this skill.

## Brief the agents like colleagues

Each agent prompt must be self-contained: it doesn't see the prior conversation. Include the goal, the relevant background, the exact plan or diff to evaluate, and what shape of response you want. Cite file:line wherever possible. Cap response length to keep the main thread tight.

## Example invocations

```
/cook-it vangrd-uqi2
```

→ Read the issue; the instructions leave choices open → compose a plan. It spans a schema change and a new write path → critique it, then implement, then fan-out review (data layer / write path / tests, with the write-path reviewer running the parity pass). Full gate, commit, push, close bd issue.

```
/cook-it maximo-app-3ci        # ← an epic
```

→ `issue_type` is `epic`, so don't cook it. Read its Handoff Protocol, take the top ready child from `bd ready --parent maximo-app-3ci`, and cook **that** through the full flow. Then append to the epic's progress log and refresh its Context if a decision changed how the remaining children should be built. Stop — one child per invocation.

```
/cook-it fix the off-by-one in scanner.ts pagination
```

→ Behavior pinned by the report → the report is the plan: skip composing one, skip critique, state why. Implement with a regression test, self-review (one file, no sibling path, test fails before and passes after), proportional gate (scanner typecheck + that test file), commit, push.

```
/cook-it add the export button to the reports page
```

→ Plan is simple → skip plan critique. Diff touches UI → baseline reviewer plus a design reviewer briefed on `ui-ux-pro-max`. Gate, commit, push.
