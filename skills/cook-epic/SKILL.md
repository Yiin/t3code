---
name: cook-epic
description: Execute a beads epic unattended with fresh-context workers — parallel across git worktrees when the children are independent, sequential on the base branch when they entangle (same-file clusters, cross-repo children, tight dependency chains). Use when the user types /cook-epic followed by an epic id, or asks to run/execute a beads epic.
---

# cook-epic — epic executor (parallel or sequential)

Run all ready children of a beads epic with fresh-context workers through the
`run.sh` beside this `SKILL.md`. Each worker is a new headless session of
the current harness (kimi/claude/codex/opencode) with no conversation context; all
coordination flows through beads (claims, notes, status) and git (commits,
merges). Two execution shapes, picked per epic (step 2):

- **Parallel** (default for independent children): one worker per ready child,
  each in its own git worktree on an `epic/<child>` branch, with a serialized
  trial-merge queue landing branches on the base branch.
- **Sequential** (for entangled children): one worker at a time, directly in
  the main checkout on the base branch — like ralph, but with cook-epic's
  claiming, retry budgets, per-child gate, and verify-by-effects. No
  worktrees, no merge queue; the coordinator gates each child and pushes only
  when push is enabled.

## When this fits

- The epic is decomposed into children with real `bd` dependencies, so
  `bd ready --parent <EPIC>` surfaces genuinely claimable work.
- You want the whole epic executed unattended, however it is shaped.
- The repo's quality gate (typecheck/build/test) is scriptable — required,
  since workers themselves only run cheap checks.

Not this skill: a single issue (use `/cook-it`), or a dirty/fragile tree
(commit or stash first — both modes mutate the base branch).

## Steps

1. **Parse the request.** The first argument after `/cook-epic` is the epic id.
   Map optional knobs:

   | User says                                       | Environment variable                                                  | Default                                                                                                                  |
   | ----------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
   | "sequential", "one at a time"                   | `COOKEPIC_SEQUENTIAL=1`                                               | decided by shape (step 2)                                                                                                |
   | sibling repos, e.g. "also touches ../proga-api" | `COOKEPIC_SIBLINGS="../proga-api"` (space-separated)                  | detected in step 2                                                                                                       |
   | "4 workers", "parallel 5"                       | `COOKEPIC_WORKERS`                                                    | 3 (forces parallel)                                                                                                      |
   | "gate: bun run build"                           | `COOKEPIC_GATE`                                                       | **required** — see below                                                                                                 |
   | "no gate", "skip verification"                  | `COOKEPIC_NO_GATE=1`                                                  | unset                                                                                                                    |
   | "budget $40"                                    | `COOKEPIC_BUDGET_USD`                                                 | none; claude/ccx only (not enforceable on kimi/codex/opencode)                                                           |
   | "2h absolute limit per worker"                  | `COOKEPIC_WORKER_TIMEOUT` (positive seconds)                          | unset; no absolute timeout                                                                                               |
   | "inspect after 45m idle"                        | `COOKEPIC_IDLE_THRESHOLD` (positive seconds)                          | 1800                                                                                                                     |
   | "inspector limit 90s"                           | `COOKEPIC_INSPECTOR_TIMEOUT` (positive seconds)                       | 120                                                                                                                      |
   | "retry failed inspections after 10m"            | `COOKEPIC_INSPECT_RETRY_DELAY` (positive seconds)                     | 300                                                                                                                      |
   | "bound inspector delays to 2m through 1h"       | `COOKEPIC_INSPECT_MIN_DELAY` / `COOKEPIC_INSPECT_MAX_DELAY`           | 60 / 7200                                                                                                                |
   | "give stopped workers 30s to exit"              | `COOKEPIC_STOP_GRACE` (positive seconds)                              | 15                                                                                                                       |
   | "yolo", "skip permissions"                      | `COOKEPIC_PERMISSION_MODE=bypassPermissions`                          | `auto`                                                                                                                   |
   | "use \<model\>"                                 | `COOKEPIC_MODEL`                                                      | claude/ccx: tiered (sonnet workers, opus plans, fable reviews); explicit value pins every stage; others: harness default |
   | "fleet memory 12G", "half the CPU"              | `COOKEPIC_MEMORY_HIGH` / `COOKEPIC_CPU_WEIGHT` / `COOKEPIC_IO_WEIGHT` | 60% / 50 / 50                                                                                                            |
   | "cap at 80 dispatches"                          | `COOKEPIC_MAX_DISPATCHES` (global spawn cap across the run)           | 50                                                                                                                       |
   | "5 attempts per child"                          | `COOKEPIC_MAX_ATTEMPTS`                                               | 3                                                                                                                        |
   | "no push", "local-only", "push at the end"      | `COOKEPIC_NO_PUSH=1`                                                  | unset                                                                                                                    |

   `COOKEPIC_NO_PUSH=1` disables every push: the coordinator fast-forwards the
   base branch locally after each gated merge but never pushes it, workers are
   prompt-instructed to commit only, and remote branch cleanup is skipped. Use
   it for repos that commit locally and push deliberately (e.g. a pre-push
   hook that refuses non-interactive pushes). Reports say **“gated, landed
   locally”**, never “pushed”; every mailbox event has `pushed: false`. At the
   end, the summary lists every repository that gained commits, its count, and
   its ending hash. Push only on the user's say-so.

   `COOKEPIC_NO_PUSH` is strict: unset means push mode, while exactly
   `COOKEPIC_NO_PUSH=1` means local-only. Values such as `0`, `true`, or any
   other nonempty value fail preflight. Push mode requires `origin`; add it or
   explicitly set `COOKEPIC_NO_PUSH=1`.

   `COOKEPIC_GATE` is required: workers only run cheap checks (typecheck,
   lint, targeted unit tests), so the gate is the only full verification. If
   the user names no gate, derive it yourself from the project (CI config,
   `package.json` scripts, `AGENTS.md`) and state your choice in the launch
   report. Pass `COOKEPIC_NO_GATE=1` only when the user explicitly accepts
   unverified merges. Reports and every mailbox event expose `verified: false`
   and say **“landed unverified”** in that mode; they never describe it as
   gated. Claude and ccx workers receive
   `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` only when the caller has not set
   it, so a finished headless worker is not held for background waits. This
   does not add an absolute worker limit. Workers have no absolute time limit
   by default. Set
   `COOKEPIC_WORKER_TIMEOUT` only when an operator needs a fixed positive
   limit. Zero and other invalid values fail preflight.

   The coordinator samples cumulative output bytes and worker-scope CPU and
   I/O on each tick. It runs a bounded repository probe only after these
   signals stay quiet. The repository probe defaults to a 60-second interval,
   has a hard timeout, and does not enumerate untracked files. Any changed
   signal refreshes liveness. Process existence alone does not count. After
   `COOKEPIC_IDLE_THRESHOLD` seconds with no changed signal, one bounded
   read-only inspector reviews the evidence while the worker keeps running.
   Only a valid high-confidence `stop` result can stop the worker. All failed,
   malformed, timed out, low-confidence, and uncertain results keep it alive.
   Codex cannot enforce a no-tool inspector session. Codex inspections return
   `uncertain` without launching Codex.

2. **Choose the execution shape.** Read the children
   (`bd list --parent <EPIC> --all --flat --json`, plus `bd show` on a few)
   and decide sequential vs parallel. An explicit user instruction
   ("sequential", "parallel 4") always wins. Otherwise:

   **Choose sequential when any of these hold:**
   - Any child references paths OUTSIDE the repo (sibling repos like
     `../proga-api`) — worktree isolation breaks relative sibling paths, and
     shared siblings can't be isolated. Collect them into
     `COOKEPIC_SIBLINGS`.
   - Most children cluster on the same one or two files — parallel workers
     would just feed the trial-merge queue conflicts.
   - The dependency graph is a near-chain (the ready frontier rarely exceeds
     1–2 children) — parallelism never engages anyway.
   - The children are small (one-file fixes) — worktree + merge overhead
     exceeds the work.

   **Choose parallel when** children touch disjoint modules and the ready
   frontier is wide (3+ genuinely independent children).

   State your choice and the reason in the launch report. Sequential sets
   `COOKEPIC_SEQUENTIAL=1` (and `COOKEPIC_SIBLINGS` when cross-repo);
   parallel sets `COOKEPIC_WORKERS` (default 3).

3. **Preflight** (all must hold; fix and report instead of launching otherwise):
   - You are at the project root: `.beads/` exists and there are no uncommitted
     TRACKED changes (`git diff-index --quiet HEAD --`). Uncommitted work is a
     hard stop — the coordinator merges into the base branch. Untracked files
     (scratch dirs, local artifacts) only earn a warning.
   - `bd show <EPIC>` exists and has open children (`bd list --parent <EPIC>`).
   - `bd ready --parent <EPIC> --json` is non-empty, OR open children exist but
     are dependency-blocked — in that case report the blockage and do NOT
     launch; the loop would exit "stuck" immediately anyway.
   - The beads data dir is not git-tracked (`git ls-files .beads` shows no
     dolt/db files) — run.sh exits fatally otherwise, since worktrees would
     fork the database.
   - Sequential mode with `COOKEPIC_SIBLINGS`: each sibling is a git repo, on
     a branch, with no uncommitted changes. The coordinator resolves every
     configured sibling to a canonical absolute path before comparing worktrees
     or recording effects. When pushes are enabled, every sibling must also
     have an `origin` remote (run.sh hard-stops otherwise).
   - Push-enabled runs require an `origin` remote in the main repository and
     every sequential sibling, because the coordinator always pushes to
     `origin <branch>`. A repository with only another remote must set
     `COOKEPIC_NO_PUSH=1` or add `origin`; it never silently becomes local-only.
   - If `git status` shows another agent's work, warn: cook-epic assumes
     exclusive use of the repo, like ralph.

4. **Create the run directory** (never in the project tree):

   ```bash
   RUN_DIR=$(mktemp -d "/var/tmp/cook-epic.$(date +%Y%m%d-%H%M%S).XXXXXX")
   ```

5. **Select the harness yourself; never ask the user.** Running in Kimi Code:
   `COOKEPIC_HARNESS=kimi`. Claude Code: `claude`. ccx: `ccx`. Codex: `codex`.
   OpenCode: `opencode`.

6. **Resolve the runner from this skill, then launch from the project root.** Derive `SKILL_DIR` from the directory containing the `SKILL.md` you loaded. Use `${COOKEPIC_RUNNER:-"$SKILL_DIR/run.sh"}`; this lets callers pin a specific copy with `COOKEPIC_RUNNER`. Only when the loaded skill path is unavailable or ambiguous, fall back to `~/.agents/skills/cook-epic/run.sh`.

   In a server or remote harness, detach the coordinator by default so the OS
   owns it after the chat session closes:

   ```bash
   cd <project-root> && nohup setsid env COOKEPIC_EPIC=<epic> \
     COOKEPIC_HARNESS=<harness> \
     "${COOKEPIC_RUNNER:-"$SKILL_DIR/run.sh"}" "$RUN_DIR" >/dev/null 2>&1 &
   ```

   Add only the optional variables the user requested (plus
   `COOKEPIC_SEQUENTIAL` / `COOKEPIC_SIBLINGS` when step 2 chose sequential)
   after `env`. In a plain interactive CLI, a non-detached launch is still fine
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
   merges, parks, retries, blocks, idle detections, and inspection decisions.
   Stay silent between event lines — no heartbeats. Exception: an actionable
   blocker (external base-branch movement, push rejection) or a direct user
   status request.

   The watcher is stateless: every invocation replays `mailbox.jsonl` from the
   first record and exits after the `finished` record. Any later session can
   reattach by running `"$SKILL_DIR/watch.sh" <run-dir>` or reading
   `<run-dir>/mailbox.jsonl` with `jq`. When resuming after a chat was reaped,
   inspect `/var/tmp/cook-epic.*` directories that do not yet contain a
   `finished` mailbox record, then re-run the watcher for the matching
   directory.

8. **Tell the user once, up front:** include the run directory, say that the
   detached loop survives the chat closing, and explain that a later session
   can reattach with `watch.sh <run-dir>`. Say that events will appear in chat
   and that `touch $RUN_DIR/STOP` stops new dispatches immediately (including
   unused slots in the current dispatch pass) and drains in-flight workers
   before exiting. A reconciliation stop, such as a rejected push or externally
   moved base branch, exits nonzero, preserves local commits, and does not close
   the epic.

9. **When the loop finishes**, report: stop reason (completion, STOP file,
   budget cap, stuck frontier, or the global dispatch cap — see
   `COOKEPIC_MAX_DISPATCHES`), children landed (`$RUN_DIR/summary.md`), every
   repository that gained commits (count and ending hash), and anything
   parked/blocked (needs a human). In no-push mode, say “gated, landed
   locally.” Failed children keep their branch plus a bounded worker output
   tail in `$RUN_DIR/worker-<child>.log`. Point the user there when anything
   was blocked. A run that ended with exit 75 dispatched nothing: report the
   holding run instead (see step 6) and stop there.

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
  -d "{\"epicId\": \"<beads epic id>\", \"projectId\": \"$T3_PROJECT_ID\", \"cwd\": \"$T3_WORKSPACE_ROOT\", \"originThreadId\": \"$T3_THREAD_ID\"}"
```

`originThreadId` is your own thread. The server groups the run's iteration
threads under it in the sidebar. Drop the field when `T3_THREAD_ID` is unset —
send it only when you have a real value, never an empty string.

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

- "server EpicRunner (ralph loop)" — include the run link
  `$T3_SERVER_URL/epics/$T3_ENVIRONMENT_ID/<epicId>`, and say when the server
  attached to an already-active run instead of starting a new one.
- "terminal run.sh coordinator" — say why the server path was not used
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

- **Dispatch**: each tick, `bd ready --parent <EPIC>` yields the dependency
  frontier; free worker slots are filled after an atomic `bd update --claim`.
  Retried children back off `10s·2^(n-1)` (cap 300s); rate-limited ones wait
  120s without consuming an attempt. `COOKEPIC_MAX_ATTEMPTS` (default 3)
  failed attempts → child is `blocked`.
- **Sequential mode** (`COOKEPIC_SEQUENTIAL=1`): one worker at a time, in the
  main checkout on the base branch — no worktrees, no branches, no merge
  queue. The worker commits on the base branch as it goes (fix-forward, never
  rewrites history, never pushes). On completion the coordinator verifies by
  effects (child closed + tree clean + commits landed in the repo or a
  registered sibling — a crash-before-close retry is recognized by the tree
  signature having moved since the child's first dispatch), then runs the
  integration gate on the checkout. If a worker leaves the main checkout or a
  sibling dirty, or makes a clean commit without closing, that state remains
  assigned to that child: no other child can dispatch until the same child
  retries after backoff and cleans/closes it, or becomes blocked. Existing
  untracked paths at first dispatch remain allowed, matching the preflight
  warning; new untracked paths still fail. If it blocks while still owning
  state, the run stops for operator reconciliation; no later child inherits
  that state. This prevents a later child from inheriting another child's
  partial state. Clean tool-created worktrees registered beneath a
  sibling's `.claude/worktrees` are ignored during these checks; unknown
  untracked paths and dirty worktrees still fail. Sibling paths are
  canonicalized before these comparisons, so documented relative paths such as
  `../proga-api` match Git's absolute registered-worktree paths. The coordinator captures
  first-dispatch HEAD baselines for the main repo and every sibling, so the
  final report lists all repositories changed by the run — including
  API-only work and cleanup-only retries — with commit counts and ending
  hash. With `COOKEPIC_NO_GATE=1`, successful children are **landed
  unverified** (and mailbox events carry `verified: false`); otherwise
  successful children are **gated, landed locally**.
  changed since that child's first dispatch, including commits made by an
  earlier retry attempt that a later retry only closes. Siblings are pushed as
  `origin <current-branch>` rather than through an upstream setting. A child
  that closes while leaving dirt still owns that state; after every gate the
  coordinator checks the main repository and each sibling again before it can
  push or report success. Parallel mode does not
  support siblings — cross-repo children are a reason to choose sequential.
- **Isolation**: every worker gets a run-scoped
  `.worktrees/cook-epic-<run-id>/<child>` path on branch `epic/<child>`
  (created from the base branch, or the existing branch on retry). The
  coordinator refuses an existing path instead of removing a possibly unowned
  worktree. Each worktree gets a `.beads/redirect` pointing at the main
  checkout's `.beads` (plus `BEADS_DIR` in the worker env), so all workers
  share one issue database; `node_modules` is symlinked and dev env files
  copied (`.env`, `.env.local`, `.env.development[.local]`, `.env.test` —
  production/staging env files are not). Workers are prompt-bound to
  their worktree and branch, with per-worker port/DB/browser offsets.
- **Landing**: completed branches queue for a serialized trial merge in an
  integration worktree → optional `COOKEPIC_GATE` → fast-forward the base
  branch → push. Before every trial merge, the coordinator resets and cleans
  only its run-scoped integration worktree, so artifacts from an earlier trial
  cannot affect the next one. Merges run under the bd 1.x **merge slot**
  (`bd merge-slot acquire` by the coordinator's holder id). Startup never
  releases a holder based only on its name, so a second coordinator cannot
  steal a live run's slot. A fatal reconciliation stop freezes the merge queue
  rather than retrying queued merges during drain. Conflicts or red gates never
  touch the user's checkout: the branch is parked and a `Merge fix:` child is
  created under the epic, which the worker pool repairs like any other task;
  its completion re-enqueues the merge.
- **Discovery**: the coordinator registers the epic as a bd 1.x **swarm**
  (`bd swarm create`), so `bd swarm status <EPIC>` shows live
  completed/active/ready state while a run is in flight.
- **Gate tiering**: workers run only cheap checks (typecheck, lint, unit
  tests for touched files); full builds and e2e/browser suites are forbidden
  in workers. The expensive verification runs once, serially, as the
  integration gate at merge time — failures come back to the pool as
  `Merge fix:` children with the failure context. A `Merge fix:` worker that
  must rerun the gate serializes it through `$RUN_DIR/heavy.lock`, so at most
  one heavy command runs on the machine at a time.
- **Resource governance**: every worker (and the integration gate) runs in
  the `cook-epic.slice` cgroup — CPUWeight/IOWeight 50, MemoryHigh 60% by
  default — so the interactive session wins contention and the fleet cannot
  swap-thrash the machine. A systemd user session is required for terminal
  runs. The cgroup is the ownership seam for workers and their descendants.
  Without it, a child can leave a shell process group and escape safe cleanup.
- **Liveness supervision**: workers have no default absolute timeout. Every
  coordinator tick compares cumulative output bytes and cumulative CPU and I/O
  for the worker scope. A quiet worker gets a slower bounded Git probe. The
  probe omits untracked files and has a hard timeout. Changed evidence resets
  the idle clock and increments a progress generation. After 1800 idle seconds
  by default, the coordinator starts one inspector in a separate scope. The
  inspector gets only structural evidence. This
  includes byte counts, tool names, process counts, elapsed times, resource
  deltas, exit state, and bounded repository status counts. It never gets raw
  worker output, command arguments, child text, environment values, URLs,
  headers, cookies, or file contents. Its strict JSON result is `continue`,
  `stop`, or `uncertain`. Only a high-confidence `stop` from the current
  progress generation ends the worker. The coordinator sends `TERM`, waits
  `COOKEPIC_STOP_GRACE`, then sends `KILL` if needed. All other outcomes
  schedule another bounded check and keep the worker alive. The coordinator
  does not launch a Codex inspector because Codex cannot disable tools
  completely. It records a fail-safe `uncertain` result instead.
- **Bounded output**: each worker keeps a rolling output tail and a separate
  cumulative byte count. Inspector prompts, results, raw logs, and repository
  evidence also have fixed limits. Rate-limit detection survives worker log
  rotation. Claude cost extraction and final result tails remain available.
- **Verification is by effects**: a child counts as done when `bd` shows it
  closed AND its branch has commits — worker self-reports are ignored.
  **Research children are the exception**: a child whose title starts with
  `Research:` or that carries the `research` label delivers findings into beads,
  not code. It counts as done only when it is closed AND its bead gained a
  comment since dispatch (counted via `comment_count`), even if it also commits
  code. A research child with commits passes normal gate and landing after that
  findings check; without commits, its empty branch is dropped. Closing one
  with no new comment fails as "closed without findings".
  **Non-research children may also finish with zero new commits** when the
  work already exists (operator pre-commit, external/infra effects): that is
  accepted only when the bead gained a comment since dispatch — the comment is
  the evidence. A bare close with no commits and no comment still fails.
- **Permission denials park fast**: a failed attempt whose worker log records
  permission denials is retried once (denials can be stochastic); a second
  denial-bearing failure blocks the child for a human immediately instead of
  burning the remaining attempts.
- **Dirt verdicts are evidence-backed**: untracked-path drift counts only
  paths ADDED since the child's first dispatch (paths that vanish from the
  baseline are ignored), and every dirty verdict logs the repo and offending
  paths as `dirty:` lines in the run log.
- **Completion**: when no open children remain and queues are drained, the
  coordinator closes the epic and exits.

## When the coordinator looks dead

**Workers can outlive the coordinator. Never infer a worker's state from the
coordinator's.** Each worker runs in its own systemd scope under
`cook-epic.slice`, so a signal aimed at the coordinator's process group — a
session ending, a Ctrl-C, an agent harness tearing down its shell — kills the
coordinator and its bookkeeping subshell while the worker keeps running and
keeps writing to the checkout.

`run.sh` handles normal exits itself. Worker scopes are named
`cook-epic-<run-id>-<worker>.scope`. Inspector scopes are named
`cook-epic-<run-id>-inspect-<worker>.scope`. `reap_finished` refuses to judge a
child whose worker scope is still active. An EXIT trap stops surviving worker
and inspector scopes. A hard kill, OOM, or reboot cannot run that trap. Manual
recovery is still required after those failures. Before you touch anything:

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
coordinator picks up the remaining frontier; children that already landed stay
landed.

## Cautions

- Sequential mode works on the base branch in your checkout for the whole run
  (like ralph): exclusive use is assumed, retries fix forward, and the gate
  runs per child on the real checkout. The coordinator detects base movement
  only while no worker owns that checkout; movement during a worker cannot be
  distinguished from that worker's own commits, so do not write there then.
- In a server or remote harness, launch the run detached (`setsid`) by default.
  A plain background job dies with its parent session, and with it the
  supervision of any worker that survives in its own cgroup.
- `bypassPermissions` is only appropriate for trusted, reversible work.
- The coordinator owns all merges into the base branch. If the user (or
  another agent) pushes to the base branch mid-run, the loop stops with a
  reconciliation error rather than guessing.
- Budgets are soft: the cap stops NEW dispatches; in-flight workers finish.
  Cost is only tracked on claude/ccx; kimi, codex, and opencode workers report no spend.
- Workers share one beads database and one `node_modules`. If a child adds a
  dependency, expect the integration gate to need an install — this is the
  known sharp edge; watch for it in parked merges.
- Spec research children so the findings land in beads — a `bd comment` on the
  child plus, when it changes remaining work, the epic's "Context & architecture"
  — and title them `Research: …` (or label them `research`) so the coordinator
  verifies them by bead comment instead of commits. Do NOT ask them for a
  notes/report file; the repo is not the knowledge store.
- Failed attempts keep their branch and a bounded rolling harness output tail
  in `$RUN_DIR/worker-<child>.log`. The adjacent `.bytes` file records total
  output bytes. Worktrees themselves are recycled.
