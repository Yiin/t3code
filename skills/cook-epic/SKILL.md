---
name: cook-epic
description: Execute a beads epic unattended with fresh-context workers on the shared epic core: a three-worker pool with per-worker worktrees and a merge queue by default, or one worker at a time on the base branch. Use when the user types /cook-epic followed by an epic id, or asks to run/execute a beads epic.
---

# cook-epic — epic executor

Run all ready children of a beads epic with fresh-context workers through the
`run.sh` beside this `SKILL.md` — a thin shim that validates the launch and
execs `t3 epic cook`, the shared orchestration core. Each worker is a new
headless session of the current harness (prime/kimi/claude/codex/opencode) with no
conversation context; all coordination flows through beads (claims, notes,
status) and git (commits, merges).

**This is the only skill for running an epic.** It handles a chain, a wide
frontier, and every mix of the two in one run — nobody has to predict the shape
up front. `run.sh` execs `t3 epic cook`, the same shared orchestration core the
T3 Code server runner drives.

**Launch server-hosted first. `run.sh` is the fallback, not the default.**
When a T3 Code server is running (check: `t3 epic list` answers), start the run
on it so it is owned by a root session and visible in t3code chat and the epic
dashboards:

```bash
t3 epic start --epic <EPIC> --cwd "$(pwd)"   # then: t3 epic watch / status / pause / cancel
```

A `bash run.sh <run-dir>` launch execs `t3 epic cook`, a foreground serverless
run detached from every session. Nothing shows in t3code chat and the run dies
with the launching shell. Use it only when no server is running (pure terminal
use, CI), and say so in your report. Agents inside a t3code-managed session must
never default to `run.sh`. The default shape is the parallel pool at three
workers: per-worker worktrees, an integration branch, and a serialized merge
queue, with claiming, retry budgets, a per-child gate, and verify-by-effects.
`COOKEPIC_SEQUENTIAL=1` or `COOKEPIC_WORKERS=1` escapes to one worker at a
time, directly in the main checkout on the base branch.

## When this fits

- The epic is decomposed into children with real `bd` dependencies, so
  `bd ready --parent <EPIC>` surfaces genuinely claimable work.
- You want the whole epic executed unattended, however it is shaped.
- The repo's quality gate (typecheck/build/test) is scriptable — required,
  since workers themselves only run cheap checks.

Not this skill: a single issue (use `/cook-it`), or a dirty/fragile tree
(commit or stash first — both modes mutate the base branch).

## Engines and configuration

The engine is the shared core. `run.sh` maps the supported
`COOKEPIC_*` environment onto the run config and execs `t3 epic cook`. The
committed `.t3code/epic-run.json` is the preferred configuration surface; the
environment layer is deprecated and loses to the file. The full mapping table
and the reason for every dropped knob live in `docs/epic-runs-rollout.md`.

Knobs the core engine maps: `COOKEPIC_GATE`, `COOKEPIC_NO_GATE`,
`COOKEPIC_NO_PUSH`, `COOKEPIC_WORKERS`, `COOKEPIC_SIBLINGS`,
`COOKEPIC_SEQUENTIAL`, `COOKEPIC_MAX_DISPATCHES`, `COOKEPIC_MAX_ATTEMPTS`,
`COOKEPIC_WORKER_TIMEOUT`, `COOKEPIC_STOP_GRACE`, `COOKEPIC_MODEL`,
`COOKEPIC_PERMISSION_MODE`, `COOKEPIC_ORIENTATION_FILE`, `COOKEPIC_HARNESS`,
`COOKEPIC_BIN`, and `COOKEPIC_WORKER_CMD` (test seam). Any other `COOKEPIC_*`
knob — inspector, budget, cgroup weights, retired Bash test seams — refuses to
start loudly, never silently.

## Tests

Run `bash skills/cook-epic/tests/all.sh` from the repository root.
Set `COOKEPIC_TESTS_FILTER=<name>` to select matching files.

`core-delegation.sh` covers the shim: entrypoint resolution, knob validation,
and a real-`bd` fixture run through the shared core. The 11 legacy-engine
suites retired with the legacy Bash coordinator (t3code-06s.42).

## Steps

1. **Parse the request.** The first argument after `/cook-epic` is the epic id.
   Map optional knobs:

   | User says                                  | Environment variable                                        | Default                                                                                                 |
   | ------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
   | "5 workers", "more parallelism"            | `COOKEPIC_WORKERS` (positive integer)                       | unset — 3 workers, parallel                                                                             |
   | "sibling repos ../api ../web"              | `COOKEPIC_SIBLINGS` (space-separated paths)                 | unset                                                                                                   |
   | "sequential", "one at a time"              | `COOKEPIC_SEQUENTIAL=1` (or `COOKEPIC_WORKERS=1`)           | unset — parallel                                                                                        |
   | "gate: bun run build"                      | `COOKEPIC_GATE`                                             | **required** — see below                                                                                |
   | "no gate", "skip verification"             | `COOKEPIC_NO_GATE=1`                                        | unset                                                                                                   |
   | "2h absolute limit per worker"             | `COOKEPIC_WORKER_TIMEOUT` (positive seconds)                | unset; no absolute timeout                                                                              |
   | "give stopped workers 30s to exit"         | `COOKEPIC_STOP_GRACE` (positive seconds)                    | 15                                                                                                      |
   | "yolo", "skip permissions"                 | `COOKEPIC_PERMISSION_MODE=bypassPermissions`                | `auto`                                                                                                  |
   | "use \<model\>"                            | `COOKEPIC_MODEL`                                            | Primary stage only. Claude/ccx defaults to tiered models. Later fallback stages use their fixed models. |
   | "cap at 80 dispatches"                     | `COOKEPIC_MAX_DISPATCHES` (global spawn cap across the run) | 50                                                                                                      |
   | "5 attempts per child"                     | `COOKEPIC_MAX_ATTEMPTS`                                     | 3                                                                                                       |
   | "no push", "local-only", "push at the end" | `COOKEPIC_NO_PUSH=1`                                        | unset                                                                                                   |
   | "orientation card at docs/foo.md"          | `COOKEPIC_ORIENTATION_FILE` (path relative to repo root)    | `docs/agent-orientation.md`, then `AGENTS.md`, first match wins                                         |

   `COOKEPIC_NO_PUSH=1` disables every push: workers are prompt-instructed to
   commit only, and the core lands each child on the base branch without
   pushing it. Use it for repos that commit locally and push deliberately (e.g.
   a pre-push hook that refuses non-interactive pushes). Reports say **“gated,
   landed locally”**, never “pushed”. Push only on the user's say-so.

   `COOKEPIC_NO_PUSH` is strict: unset means push mode, while exactly
   `COOKEPIC_NO_PUSH=1` means local-only. Values such as `0`, `true`, or any
   other nonempty value fail preflight. Push mode requires `origin`; add it or
   explicitly set `COOKEPIC_NO_PUSH=1`.

   Every worker prompt gets the epic's Goal + Context & architecture and the
   orientation card injected verbatim at dispatch time — workers no longer
   need to `bd show` the epic themselves for orientation. The orientation
   card is read fresh per dispatch from `docs/agent-orientation.md`, falling
   back to `AGENTS.md`, or the single path in `COOKEPIC_ORIENTATION_FILE` when
   set; if none of those exist, workers get the literal line "(no orientation
   card in this repo)".

   `COOKEPIC_GATE` is required: workers only run cheap checks (typecheck,
   lint, targeted unit tests), so the gate is the only full scripted
   verification. If the user names no gate, derive it yourself from the
   project (CI config,
   `package.json` scripts, `AGENTS.md`) and state your choice in the launch
   report. Pass `COOKEPIC_NO_GATE=1` only when the user explicitly accepts
   unverified merges. Reports and every mailbox event expose `verified: false`
   and say **“landed unverified”** in that mode; they never describe it as
   gated. Workers have no absolute time limit
   by default. Set
   `COOKEPIC_WORKER_TIMEOUT` only when an operator needs a fixed positive
   limit. Zero and other invalid values fail preflight.

   The gate is a scripted command, run once per merge set in the integration
   worktree. It cannot drive a browser, so it never stands in for integrated
   QA of a user-visible change. That QA belongs to the worker, through
   cook-it's tester stage. `skills/cook-it/SKILL.md` routing decision 4 and
   step 4.5 own when QA runs and when the cleanup loop ends. A worker is the
   primary agent for its own child, so this repo's rule against
   subagents starting dev servers does not bar its tester dispatch: integrated
   verification is the delegated task. One limit comes with the parallel pool
   and is accepted. A worker QAs its own worktree before the merge, and a
   `Merge fix:` child is re-gated but never re-QA'd.

   A worker's QA pass depends on three measured facts (t3code-8rl.3). State
   isolates per worktree: `vp run dev --home-dir <worktree>/.t3` sets
   `T3CODE_HOME`, and every server path derives from it, so the pass never
   touches the main checkout's `~/.t3`. Ports do not isolate on their own. The
   dev runner probes a free offset and then binds it, so two workers starting
   at the same moment can pick one offset and the loser exits 1 with no retry;
   set `T3CODE_DEV_INSTANCE=<child-id>` before `vp run dev` to seed distinct
   offsets. And a headless worker may have no browser-automation host. A
   worker that cannot reach one says so and leaves the pass to an attended
   session. It never reports QA it did not run.

2. **Execution shape.** The parallel pool loop at three workers is the default:
   each child cooks in its own worktree on an `epic/<child>` branch, a
   serialized merge queue trial-merges finished branches into the run's
   integration branch, gates once per merge set, and fast-forwards the base
   branch. Conflicting or gate-failing branches park and spawn `Merge fix:`
   children. `COOKEPIC_WORKERS` sets another worker count. Two escapes select
   one worker at a time in the main checkout on the base branch:
   `COOKEPIC_SEQUENTIAL=1` and `COOKEPIC_WORKERS=1`. `COOKEPIC_SEQUENTIAL=1`
   contradicts `COOKEPIC_WORKERS` above 1 — the shim refuses that
   combination. `COOKEPIC_SIBLINGS` names sibling repositories;
   sequential mode works them as the real checkouts, parallel mode mirrors
   them into per-worker layouts so `../sibling` references resolve inside the
   worker sandbox. Inspectors and budget caps retired with the legacy Bash
   engine (t3code-06s.42).

3. **Preflight** (all must hold; fix and report instead of launching otherwise):
   - You are at the project root: `.beads/` exists and there are no uncommitted
     changes (`git status --porcelain` is empty). Uncommitted work is a hard
     stop — the core verifies each child by effects on the base branch, so it
     must start from a clean checkout.
   - `bd show <EPIC>` exists and has open children (`bd list --parent <EPIC>`).
   - `bd ready --parent <EPIC> --json` is non-empty, OR open children exist but
     are dependency-blocked — in that case report the blockage and do NOT
     launch; the loop would exit "stuck" immediately anyway.
   - Push-enabled runs require an `origin` remote in the main repository,
     because the core pushes `origin HEAD:<base-branch>` after each gated
     child. A repository with only another remote must set
     `COOKEPIC_NO_PUSH=1` or add `origin`; it never silently becomes local-only.
   - If `git status` shows another agent's work, warn: cook-epic assumes
     exclusive use of the repo, like ralph.

4. **Create the run directory** (never in the project tree):

   ```bash
   RUN_DIR=$(mktemp -d "/var/tmp/cook-epic.$(date +%Y%m%d-%H%M%S).XXXXXX")
   ```

5. **Select the harness yourself; never ask the user.** Running in Kimi Code:
   `COOKEPIC_HARNESS=kimi`. Prime Agent: `prime`. Claude Code: `claude`. ccx:
   `ccx`. Codex: `codex`. OpenCode: `opencode`.

   The selected harness is the primary stage. Structured harness errors for
   provider limits, spend, usage, authentication, and availability trigger
   one-way fallback. Explicit `provider-error` output also qualifies. Bare
   task text such as `authentication`, `401`, or `service unavailable` does
   not qualify. Prime moves to Claude, Claude and ccx move to Codex, and Codex
   moves to Kimi. Prime trusts failed `auto_retry_end` events and assistant
   messages with `stopReason: "error"`. It never trusts ordinary assistant
   text as fallback evidence. Prime reports no per-iteration cost, so a Prime
   run's records and reports carry no spend figure. Say it is unavailable when
   asked; never infer one.
   Missing binaries and exits 126 or 127 also mark a stage unavailable. The
   core skips an unavailable intermediate binary. It never moves
   backward.

   A fallback takes effect at the iteration boundary: the failed child
   returns to the ready frontier without using an attempt, and the next
   dispatch uses the fallback harness. Codex fallback
   uses `gpt-5.6-sol` with high reasoning. Kimi fallback uses
   `kimi-code/k3`. `COOKEPIC_MODEL` applies only to the primary stage. Generic
   nonzero exits keep the normal attempt and backoff rules.

   claude/ccx workers automatically launch with
   `--exclude-dynamic-system-prompt-sections`, keeping the prompt prefix
   stable across dispatches. No action needed —
   this is automatic for claude/ccx and a no-op for prime/kimi/codex/opencode.

6. **Resolve the runner from this skill, then launch from the project root.** Derive `SKILL_DIR` from the directory containing the `SKILL.md` you loaded. Use `${COOKEPIC_RUNNER:-"$SKILL_DIR/run.sh"}`; this lets callers pin a specific copy with `COOKEPIC_RUNNER`. Only when the loaded skill path is unavailable or ambiguous, fall back to `~/.agents/skills/cook-epic/run.sh`.

   In a server or remote harness, detach the coordinator by default so the OS
   owns it after the chat session closes:

   ```bash
   cd <project-root> && nohup setsid env COOKEPIC_EPIC=<epic> \
     COOKEPIC_HARNESS=<harness> \
     "${COOKEPIC_RUNNER:-"$SKILL_DIR/run.sh"}" "$RUN_DIR" >/dev/null 2>&1 &
   ```

   Add only the optional variables the user requested after `env`. In a plain
   interactive CLI, a non-detached launch is still fine
   when the user is watching it live.

   Inside t3code, prefer its server-owned EpicRunner. It persists run state,
   survives client disconnects, and supports reattachment through the Epics UI
   and `t3 epic` CLI. See **Running inside t3code** below for how to detect
   the server and hand the epic to it. When the `T3_*` env vars are present,
   the server path is the default — invoking `/cook-epic` is not a reason to
   bypass it. Use this terminal coordinator only when the server path is
   unavailable, or when the user explicitly asks for the terminal/local
   coordinator specifically (e.g. "run it locally, not through the server").

   **Exit 75 means another run already owns this epic** — a t3code server run or
   another terminal run holds the epic run lock. The runner prints one line of
   JSON, `{"event":"lock_held","owner":...,"runDir":...,"host":...,"lock":...}`,
   and stops before claiming any child. Report and observe: tell the user who
   holds it (`owner`, on `host`), point them at the reported `runDir` for that
   run's log and mailbox, and say they can stop it with `touch <runDir>/STOP`.
   Do NOT retry, relaunch with a fresh run directory, or delete the lock file.

7. **Report progress** by running `"$SKILL_DIR/watch.sh" "$RUN_DIR"` (falling back to `~/.agents/skills/cook-epic/watch.sh` only when the loaded skill path is unavailable or ambiguous)
   with the harness's long-running monitor mechanism. Relay each emitted event
   line to the user: dispatches, completions (including research completions),
   retries, provider fallbacks, and claim releases.
   Stay silent between event lines — no heartbeats. Exception: an actionable
   blocker (external base-branch movement, push rejection) or a direct user
   status request.

   The watcher is stateless: every invocation replays `mailbox.jsonl` from the
   first record and exits when the run reaches a terminal status (`done`,
   `failed`, or `cancelled`). Any later session can
   reattach by running `"$SKILL_DIR/watch.sh" <run-dir>` or reading
   `<run-dir>/mailbox.jsonl` with `jq`. When resuming after a chat was reaped,
   inspect `/var/tmp/cook-epic.*` directories whose `run.json` is not yet in a
   terminal status, then re-run the watcher for the matching
   directory.

8. **Tell the user once, up front:** include the run directory, say that the
   detached loop survives the chat closing, and explain that a later session
   can reattach with `watch.sh <run-dir>`. Say that events will appear in chat
   and that `touch $RUN_DIR/STOP` takes effect at the next iteration boundary:
   the in-flight worker finishes its turn, then the run exits `cancelled`. A
   failed run, such as a rejected push or an exhausted attempt budget, exits
   nonzero, preserves local commits, and does not close the epic.

9. **When the loop finishes**, report: stop reason (completion, STOP file,
   stuck frontier, an exhausted per-child attempt budget, or the global
   dispatch cap — see `COOKEPIC_MAX_DISPATCHES`), children landed
   (`$RUN_DIR/summary.md`), and anything blocked (needs a human). In no-push
   mode, say “gated, landed locally.” Every iteration keeps its record in
   `$RUN_DIR/iter-<N>.json`; point the user there when anything was blocked.
   A run that ended with exit 75 dispatched nothing: report the holding run
   instead (see step 6) and stop there. The loop does not close the epic
   bead — close it yourself once the summary checks out.

## Running inside t3code

When the skill executes inside a t3code agent session, the server injects
`T3_SERVER_URL`, `T3_ENVIRONMENT_ID`, `T3_PROJECT_ID`, `T3_WORKSPACE_ROOT`,
`T3_THREAD_ID`, and `T3_SERVER_TOKEN` into the environment. Hand the epic to
the server-owned EpicRunner instead of launching the terminal coordinator.

**Detection.** `T3_SERVER_URL` unset → terminal `run.sh` coordinator. Set →
probe `GET $T3_SERVER_URL/.well-known/t3/environment` (unauthenticated).
Unreachable → terminal fallback, and the launch report must say why (the probe
failed, not just that you fell back).

**Launch.** When the probe answers:

```bash
curl -sS -X POST "$T3_SERVER_URL/api/epic-runs/launch" \
  -H "Authorization: Bearer $T3_SERVER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"epicId\": \"<beads epic id>\", \"projectId\": \"$T3_PROJECT_ID\", \"cwd\": \"$T3_WORKSPACE_ROOT\", \"originThreadId\": \"$T3_THREAD_ID\", \"inheritOriginModelSelection\": true}"
```

`originThreadId` is your own thread. The server groups the run's iteration
threads under it in the sidebar. Drop the field when `T3_THREAD_ID` is unset —
send it only when you have a real value, never an empty string.

`inheritOriginModelSelection` runs the epic on your own provider instance,
model, and options, so an epic launched from a Prime Agent session cooks with
Prime Agent. Send it only together with a real `originThreadId`: the server
validates the pair and rejects the launch when the origin thread is missing,
unknown, or belongs to another project. Drop both fields when `T3_THREAD_ID` is
unset — the run then resolves its model the older way, so an older client that
never sends either field keeps working unchanged.

**Model selection, most specific first.** The launch input wins, then the
committed `.t3code/epic-run.json` `provider.modelSelection`, then the project
default. Inheriting is the launch input, so it never quietly falls back to the
project default: an origin thread that cannot be validated fails the launch
with `origin_thread_required`, `origin_thread_not_found`, or
`origin_thread_project_mismatch`. Report that error; do not retry without the
field to force a launch on some other model.

**Fallback still applies.** The run's provider is a starting point, not a
guarantee. The server's forward chain is Prime → Claude → Codex → Kimi, driven
by structured provider evidence only, and it never moves backward. A run that
starts on Prime Agent can finish its later iterations on Claude.

**Response handling.**

- `200` → server-owned run. Launch is idempotent: when a run is already
  active for the epic, the server returns the existing run. Note that in the
  report and start nothing else.
- `400`/`401`/`403`/`404`/`409` → HARD STOP. Report the server's error. You
  reached the server, so never fall back to the terminal coordinator — a
  fallback would fork run ownership.
- `500` or any other `5xx` → HARD STOP, same rule: the server was reached, so
  never fall back. Report the error.
- Network failure (connect refused, timeout, DNS) → terminal fallback,
  reported with the reason.

**Launch report template.** Always name the engine:

- "server EpicRunner (shared core)" — include the run link
  `$T3_SERVER_URL/epics/$T3_ENVIRONMENT_ID/<epicId>`, and say when the server
  attached to an already-active run instead of starting a new one.
- "terminal run.sh (shared core)" — say why the server path was not used
  (no `T3_SERVER_URL`, probe unreachable, or network failure).

**Control commands** (all with `Authorization: Bearer $T3_SERVER_TOKEN`):

- `GET $T3_SERVER_URL/api/epic-runs?status=running` — list active runs.
- `GET $T3_SERVER_URL/api/epic-runs/<runId>` — run detail.
- `POST $T3_SERVER_URL/api/epic-runs/<runId>/pause`
- `POST $T3_SERVER_URL/api/epic-runs/<runId>/resume`
- `POST $T3_SERVER_URL/api/epic-runs/<runId>/cancel`

A `409` from a control command means an invalid state transition (for example,
pausing a finished run). Report it; do not retry.

## How it works (what to tell the user when asked)

The parallel shape is the default, at three workers. It runs a
pool: each iteration cooks in its own worktree on an `epic/<child>` branch, and
a serialized merge queue lands finished branches on the base branch through the
run's integration branch — trial merge, one gate per merge set, fast-forward,
push. A branch that conflicts or fails the gate parks, and the queue creates a
`Merge fix:` child that resumes the parked branch. With `COOKEPIC_SIBLINGS`,
each worker also gets mirrored worktrees of the sibling repositories in a
run-scoped layout, so cross-repo relative paths resolve; merges land in every
repository's base branch together.

The sequential shape (`COOKEPIC_SEQUENTIAL=1` or `COOKEPIC_WORKERS=1`) runs one
worker at a time, in the main checkout on the base branch, like ralph.

The bullets below describe the sequential mechanics; the pool loop applies the
same claiming, attempt budgets, provider fallback, and evidence rules per
worker, with two shape differences called out where they matter.

- **Dispatch**: each iteration, `bd ready --parent <EPIC>` yields the
  dependency frontier and the loop takes the top ready child after an atomic
  `bd update --claim`. A failed child backs off (doubling from
  `server.retryBaseDelayMs` up to `server.retryMaxDelayMs`) and retries within
  its attempt budget (`COOKEPIC_MAX_ATTEMPTS`, default 3). Exhausting the
  budget releases the claim, reopens the child with a `child-claim-released`
  mailbox event, and fails the run. Provider failures move the whole run to
  the next installed harness (claude → codex → kimi) without consuming an
  attempt.
- **Commits**: the worker commits on the base branch as it goes (fix-forward,
  never rewrites history, never pushes). In the parallel shape the worker
  commits on its `epic/<child>` branch in its own worktree instead, and the
  merge queue lands the branch.
- **Verification is by effects**: a child counts as done when `bd` shows it
  closed AND the base branch gained commits — worker self-reports are ignored.
  **Research children are the exception**: a child whose title starts with
  `Research:` or that carries the `research` label delivers findings into
  beads, not code. It counts as done only when it is closed AND its bead
  gained a comment since dispatch; closing one with no new comment blocks it
  as "closed without findings". **Non-research children may also finish with
  zero new commits** when the work already exists (operator pre-commit,
  external effects): accepted only when the bead gained a comment since
  dispatch — the comment is the evidence. A bare close with no commits and no
  comment fails.
- **Gate**: after a verified child, the loop runs the integration gate once on
  the real checkout — in the parallel shape, once per merge set inside the
  integration worktree — (`COOKEPIC_GATE`; skipped only with
  `COOKEPIC_NO_GATE=1`, which lands children **unverified**). A red gate or a
  dirty tree blocks the child and retries it within its budget; in the parallel
  shape a red gate parks the branch for a `Merge fix:` child instead. Workers
  run only cheap checks (typecheck, lint, unit tests for touched files); the
  gate is the only full scripted verification.
- **Integrated QA**: the gate is scripted and cannot drive a browser, so it
  never covers a user-visible change. That QA runs inside the worker, through
  cook-it's tester stage, pre-merge in the worker's own worktree. A merge-fix
  child is re-gated but not re-QA'd. See the gate paragraphs in step 1 for the
  state-isolation, port-seed, and headless-browser caveats.
- **Push**: after a green gate the loop pushes `origin HEAD:<base-branch>`
  unless `COOKEPIC_NO_PUSH=1`. A rejected push fails the run for operator
  reconciliation; local commits are preserved.
- **Resource governance**: each worker spawn is optionally wrapped in a
  systemd user scope under `cook-epic.slice` (CPUWeight and MemoryHigh only),
  so the interactive session wins contention. A scope name that clashes with
  the run identity is fatal; every other scope degradation spawns unwrapped
  with a warning.
- **Liveness**: workers have no default absolute timeout. After each turn the
  loop records the subagent-liveness evidence the harness exposes
  (`subagent-liveness-degraded` / `subagent-liveness-unavailable` mailbox
  events). Harnesses with no subagent evidence report `unavailable`; there is
  no inspector.
- **Recovery**: run state lives in `$RUN_DIR/run.json`, one
  `$RUN_DIR/iter-<N>.json` per iteration, `mailbox.jsonl`, `loop.log`, and
  `summary.md`. On exit the loop releases any child claim it still holds and
  releases the epic run lock. A dead run's lock goes stale on its own; the
  next run takes it over once the heartbeat lapses.
- **Completion**: when no open children remain, the run reports `done`. An
  empty ready frontier with open children is `failed` (stuck), never `done`.
  The loop does not close the epic bead — review `summary.md` and close it
  yourself.

## When the coordinator looks dead

The core engine runs one worker as a direct child process, optionally inside a
systemd scope named `cook-epic-<run-id>-<worker>.scope`. A coordinator that
dies mid-iteration can leave that worker alive in its scope, still writing to
the checkout. **Never infer the worker's state from the coordinator's.**

Before you touch anything:

```bash
# Is a worker still alive? Check the WORKER, not run.sh.
systemctl --user list-units --all 'cook-epic-*.scope'
ps -eo pid,etimes,args | grep -E '[c]laude -p|[c]odex exec|[k]imi -p|[o]pencode run'
```

Until that comes back empty, the checkout belongs to that worker. Do not clean
stray files, do not release its bd claim, do not commit, do not relaunch —
tidying around a live worker corrupts the very state it is about to commit, and
the run may still complete on its own. Wait for it (`tail --pid=<pid> -f
/dev/null`), then reconcile from what it actually left behind.

Only once nothing is alive: inspect `git status`, decide whether to keep or
discard partial work, release any `IN_PROGRESS` child still assigned to the dead
worker (`bd update <child> --status open --assignee ""`), and relaunch. The
loop picks up the remaining frontier; children that already landed stay
landed. The dead run's epic lock goes stale on its own — the relaunched run
takes it over once the heartbeat lapses.

## Cautions

- The sequential shape works on the base branch in your checkout for the whole
  run (like ralph): exclusive use is assumed, retries fix forward, and the gate
  runs per child on the real checkout. The loop cannot tell your edits from
  the worker's — do not write to the checkout while a run is active. The
  parallel shape keeps the base checkout read-only for workers (they live in
  worktrees under the run directory), but the merge queue still moves the base
  branch — the same exclusivity rule applies.
- In a server or remote harness, launch the run detached (`setsid`) by default.
  A plain background job dies with its parent session, and with it the
  supervision of any worker that survives in its own cgroup.
- `bypassPermissions` is only appropriate for trusted, reversible work.
- The coordinator owns the base branch for the whole run. If the user (or
  another agent) commits to or moves it mid-run, the affected child fails its
  effects check rather than the loop guessing.
- Workers share one checkout and one `node_modules`. If a child adds a
  dependency, expect the next child's gate to need an install — this is the
  known sharp edge.
- Spec research children so the findings land in beads — a `bd comment` on the
  child plus, when it changes remaining work, the epic's "Context & architecture"
  — and title them `Research: …` (or label them `research`) so the coordinator
  verifies them by bead comment instead of commits. Do NOT ask them for a
  notes/report file; the repo is not the knowledge store.
- Every iteration keeps its full record in `$RUN_DIR/iter-<N>.json` and the
  run mailbox; nothing is deleted between attempts.
