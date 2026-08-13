# Run an epic from a terminal or T3 Code

You can start an epic in a plain terminal and continue it from T3 Code, or do
the reverse. Beads and Git are the shared source of truth. T3 Code observes that
state and launches work; it does not keep a second copy of issue status.

## Shared state

| State                                         | Location                                                                                                               | Owner                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Issue status, claims, dependencies, and notes | The repository's `.beads` database                                                                                     | Workers using `bd`                    |
| Commits and branches                          | Git; parallel runs use `epic/<child-id>` branches and worktrees, a sequential terminal cook commits on the base branch | Workers and cook-epic                 |
| Loop prompt and reports                       | A Ralph `RUN_DIR` under `/var/tmp`, including `prompt.md`, `mailbox.jsonl`, `summary.md`, and `iter-N.json`            | Ralph                                 |
| Epic run lock                                 | `<repo>/.beads/run-lock.<epic-id>.json`                                                                                | The active terminal or T3 Code runner |
| T3 Code run recovery state                    | `epic_runs` rows in `~/.t3/userdata/state.sqlite`                                                                      | T3 Code server                        |

The branch and worktree rules live in
[`skills/cook-epic/SKILL.md`](../skills/cook-epic/SKILL.md) under **How it
works**; they describe the shared core that both the terminal and the server
runner drive.
Ralph's run artifacts are listed in
[`skills/ralph/SKILL.md:17-21`](../skills/ralph/SKILL.md#L17-L21).
The server derives `state.sqlite` in
[`apps/server/src/config.ts:101-106`](../apps/server/src/config.ts#L101-L106).

A resumed iteration reuses its existing `epic_run_iterations` row: same index,
same thread id, same branch, same worktree, same bead claim. It records the fact
in `resume_count` and `last_resumed_at`, and it charges no new dispatch. A
parallel run can have several iterations in flight at once, so one restart
resumes N of them, each decided on its own.

## Ownership rules

T3 Code reads Beads through `BeadsStatusBroadcaster`. A terminal `bd update`,
`bd close`, or dependency change appears in subscribed clients without a T3
Code refresh. The server-owned runner may launch a worker that runs `bd` and may
add run notes, but T3 Code does not change issue status as part of its read
model.

Terminal mode must work with no T3 Code process running. Use `cook-epic` or an
epic-targeted `ralph` run to own and advance an epic. Later, open the same
repository in T3 Code; it reads the current ready frontier from Beads.

`cook-it` handles one child. It may claim and close that child, but it does not
own the epic run lock and is not an epic mode to switch into or out of.

### The runner owns a live iteration thread

While an iteration row is `running`, the runner owns that thread's turn. The
server refuses these client commands on it, over WebSocket and over HTTP:
`thread.turn.start`, `thread.turn.interrupt`, `thread.session.stop`,
`thread.checkpoint.revert`, `thread.delete`, `thread.archive`, and
`thread.settle`. Sending one back gets an error, not a queued turn.

You can still answer an approval or a user-input request on a live iteration,
steer or stop one of its subagents, and edit its metadata. The refusal also
lifts as soon as the iteration reaches a terminal status, so you can open a
finished worker's thread and carry on with it as an ordinary chat.

The check reads the durable `epic_run_iterations` row, so it covers the gap
between turn end and the runner's evidence read. The runner's own commands go
straight to the orchestration engine and are never gated. Forced cleanup —
cancel, timeout, boot reconciliation, and the session reaper — is unchanged.

## Engine selection

The engine is `core`. The terminal `run.sh` is a shim that validates
the launch and execs `t3 epic cook`; the hosted runner drives the same shared
core. The legacy Bash coordinator retired on 2026-08-07 (t3code-06s.42).

Set `engine` in `.t3code/epic-run.json` or in a run input. The default is
`core`. Config layers apply in this order, with the last value winning:

1. Built-in defaults.
2. `.t3code/epic-run.json` from the base checkout.
3. Deprecated environment settings.
4. The run input from the API, UI, or terminal adapter.

`T3CODE_EPIC_RUN_ENGINE` and `COOKEPIC_ENGINE` are migration settings. The
terminal adapter logs a warning when either variable is present. If both are
present, `T3CODE_EPIC_RUN_ENGINE` wins within the environment layer. Replace
both variables with the `engine` config key.

The config reader accepts these values:

- `core` runs the shared orchestration core.
- `shadow` is a reserved rollout selector kept for config compatibility. No
  adapter branches on it; the shadow comparator it served retired with the
  legacy engine (t3code-06s.42).

The selector is persisted on the run for provenance. Entry points choose the
adapter themselves: `run.sh` and `t3 epic cook` run the shared core, and the
hosted runner runs the same core.

Config is strict. An unknown engine value rejects the launch like any other
invalid config value. It does not silently select a different engine.

## Which provider a run uses

A run resolves one model selection at launch and dispatches every iteration
thread with it. The order is most specific first: the launch input, then
`provider.modelSelection` in `.t3code/epic-run.json`, then the project default.

Cooking an epic from inside a conversation sends
`inheritOriginModelSelection: true`, so the run keeps that thread's exact
provider instance, model, and options. The origin thread must be live and in the
same project; otherwise the launch fails with `origin_thread_required`,
`origin_thread_not_found`, or `origin_thread_project_mismatch`. It never falls
back to the project default, because the caller picked that provider on purpose.
A launch from the Epics page sends no such flag and keeps the project default.

The resolved selection is persisted on the run row, so a boot resume replays the
same provider. After that, only a provider-attributed failure moves the run
forward through the fallback chain in
[`providerFallback.ts`](../packages/epic-core/src/providerFallback.ts). The chain
is Prime → Claude → Codex → Kimi. Prime is a source only: nothing falls back
**to** Prime. Evidence must be a structured provider failure record. Assistant
prose never triggers a fallback.

In a terminal, the harness is the CLI you launched from.
[`skills/cook-epic/run.sh`](../skills/cook-epic/run.sh) detects `prime`, `kimi`,
`claude`, `ccx`, `codex`, or `opencode` from the binary name, and
`COOKEPIC_HARNESS` overrides that. A Prime worker takes its prompt as an argument
after `--`, and reports no per-iteration cost, so a Prime run shows no spend.
Provider-specific setup lives in the [Prime Agent guide](./providers/prime.md).

## Run lock

Only one runner may own an epic. Epic-targeted `ralph`, `cook-epic`, and the T3
Code server runner use the same run-lock file. If the lock is live, the second
runner reports that the run is already in progress instead of claiming another
child.
[`NodeEpicRunLock.ts`](../packages/epic-core/src/adapters/NodeEpicRunLock.ts) is
the shared implementation for the terminal core and the hosted runner;
[`skills/ralph/run.sh`](../skills/ralph/run.sh) is the Bash twin and writes the
same file format.
[`NodeEpicRunLock.interop.test.ts`](../packages/epic-core/src/adapters/NodeEpicRunLock.interop.test.ts)
pins that format. It asserts the exclusive-create behavior in both directions,
and the exact payload key set: `bootId`, `heartbeatAt`, `host`, `owner`, `pgid`,
`pid`, `runDir`, `startTicks`, `startedAt`.

A graceful stop releases the lease and unlinks the lock file. A SIGKILL leaves
the file behind. A leftover file does not wedge the epic.

The holder heartbeats every 30 seconds, and it counts as live for 300 seconds
after its last heartbeat. Two things reclaim the lock before that window runs
out. A recorded boot id that is not the current boot id means the host rebooted,
so nothing the file names can still be running. A holder that is provably dead on
this host is also reclaimable: its PID is absent, or the PID now belongs to a
process that started at a different time, and its recorded process group is gone
too. `NodeEpicRunLock` applies the death check before the 300-second window, so a
hard-killed server can resume its own run at once. `run.sh` waits out the window
first. Neither one reclaims a lock recorded on another host.

## How a child counts as done

Verification is by effects, never by what the worker says. The rule is the same
in the terminal and on the server, and the same for every provider:

- A normal child is done when Beads shows it closed **and** the base branch
  gained commits.
- A `Research:` child, or one carrying the `research` label, is done when it is
  closed **and** its bead gained a comment since dispatch. A close with no new
  comment blocks it as "closed without findings".
- A normal child that produced no commits is accepted only when its bead gained
  a comment since dispatch. That comment is the evidence. A bare close with no
  commits and no comment fails.

A worker's final message is never evidence. This is why a Prime worker, which
reports no per-iteration cost, needs no special case: the loop reads Beads and
Git, not the transcript. The full rule set lives in
[`skills/cook-epic/SKILL.md`](../skills/cook-epic/SKILL.md) under **How it
works**.

## How a run counts as done

A run writes `done` only when Beads shows the epic has no open child. Every
terminal write goes through one proof (`proveEpicCompletion` in
`packages/epic-core/src/policy.ts`), so no path can shortcut it:

- A worker's `RALPH_DONE` is a claim, not proof. The loop re-reads the open
  children and the ready frontier. An open child that is still ready sends the
  run back for another dispatch pass. An open child that nothing can pick up
  fails the run with `infra:ready-frontier-stuck`.
- The dispatch cap ends the run either way. With no open child it writes `done`
  and `max iterations (N) reached`. With open children it writes `failed` and
  `limit:max-iterations`, naming up to five of them.
- Nothing is decided while a worker is still running. A sibling can still close
  the last child, so the proof waits for the pool to empty.

The proof reads Beads only. A run can still report `done` with entries the merge
queue never landed; that gap is tracked in t3code-xig.

## Integration gate and host load

The merge queue runs the integration gate once per batch. A drain reads what
each queued branch changes (`git diff --name-only <base>...<branch>`, across
every repository the branch set touches) and groups the queue into runs of
consecutive branches that share no file. Each group is trial-merged into one
integration state, and one gate verifies the lot. Three children that merge
cleanly together and touch different files cost one gate, not three. The gate is
the heaviest thing an epic run does, and its result depends on the machine it
runs on, not only on the code it tests.

Two branches that change the same file get a gate each. They can break each
other in ways neither breaks alone, so one verdict cannot answer for both, and
batching them only buys the isolation pass that follows a red batch. Grouping
never reorders the queue: queue order is landing order. A branch whose file list
git could not report goes through on its own.

A red batch is halved and each half re-verified, until a single branch fails on
its own and is parked with a merge-fix child. Nothing lands from a red batch:
the base branch only ever fast-forwards to a tree a gate passed. A branch that
conflicts while the batch is being stacked is parked on its own and the rest of
the batch carries on; a set spanning sibling repositories is rolled back out of
the batch whole, so a parked branch never leaves commits in the tree the gate
tests. The blameless control gate — the same command on the base with nothing
merged — runs once per batch, and the halves inherit its answer because nothing
landed in between.

Run d7580b6c ran one gate command at one commit twice. The main checkout took
421s and exited 0. The integration worktree took 23m01s and exited 1. The
difference was the host: load average 29.92 on 16 cores, with 17 vitest
processes from other projects on the same machine. Timing-sensitive tests fail
when starved of CPU, so a gate started on a loaded host reports a red gate that
says nothing about the child under test. The worktree and its mirrored
`node_modules` were correct; they were not the cause (t3code-z7x).

The heavy gate lock at `$XDG_RUNTIME_DIR/t3code/cook-epic-heavy.lock` only
serialises t3code gates against each other. It cannot see another project's
test run, so the gate reads the host load itself
([`packages/epic-core/src/hostContention.ts`](../packages/epic-core/src/hostContention.ts)):

- Before taking the lock, the gate samples the 1-minute load average. Above 1.5
  runnable processes per core it logs `epic.gate.host-busy` and resamples every
  30 seconds until the load clears, for at most 10 minutes.
- It waits without holding the lock, so a busy host never stalls another epic
  run on this machine.
- When the bound expires it runs the gate anyway and logs
  `epic.gate.host-contended`. The wait never fails a run.
- `epic.gate.start` and `epic.gate.finished` carry `loadPerCpu`, `cpuCount`, and
  `hostWaitedMs`. `durationMs` excludes the wait, so it stays comparable with
  earlier runs. A red gate logged next to a high `loadPerCpu` is the host.

A gate that fails while the host is contended is still reported as a gate
failure. Read the load in the surrounding log lines before blaming the child.

## Lifecycle

- Closing a browser or mobile client does not stop work. WebSocket cleanup only
  marks the session disconnected
  ([`apps/server/src/ws.ts:2257-2261`](../apps/server/src/ws.ts#L2257-L2261)).
- The server reaps a provider session after 30 minutes of inactivity, but skips
  any session with an active turn
  ([`ProviderSessionReaper.ts:16-17`](../apps/server/src/provider/Layers/ProviderSessionReaper.ts#L16-L17),
  [`ProviderSessionReaper.ts:56-70`](../apps/server/src/provider/Layers/ProviderSessionReaper.ts#L56-L70)).
- A server restart ends the server process. The persisted provider binding keeps
  the resume cursor, the working directory, the model selection, and the project
  context, so the runner continues the interrupted child's own session instead of
  starting a fresh iteration
  ([`serverRuntimeStartup.ts`](../apps/server/src/serverRuntimeStartup.ts) calls
  `EpicRunner.start`). An adapter that declares no resume capability still cannot
  reattach; that iteration is scored with an `infra:resume-*` reason and its work
  is handed to a fresh iteration.
- A restart does not end epic worker agents. The runner puts each worker CLI in
  its own `systemd-run --user --scope` unit under `cook-epic.slice`
  ([`workerScope.ts`](../packages/epic-core/src/workerScope.ts),
  [`provider/workerScope.ts`](../apps/server/src/provider/workerScope.ts)). That
  slice sits outside the `t3code.service` cgroup, so the unit's
  `KillMode=control-group` never signals the workers. Each unit is named
  `cook-epic-<scopeId>-<worker>.scope`. Two of them outlived their server this
  way on 2026-08-08. The boot resume stops the units carrying its own run
  identity before it forks the loop again.
- A graceful stop releases the run lock. The `EpicRunner` layer finalizer
  releases every lease it holds as the layer tears down. A hard kill skips the
  finalizer and leaves the lock file, which the boot resume then reclaims under
  the rules in **Run lock**.

## What a boot resume checks

At startup the server walks its `epic_runs` rows. A row that is not `running`
only has its leftover iteration rows abandoned. A `running` row is resumed. The
server re-runs the preflight with a resume intent, takes the run lock, sorts its
in-flight iteration rows into resumable and abandoned, reclaims a merge slot the
dead process leaked, stops the worker scope units that carry its run identity,
and forks the loop again with the resumable rows.

A row resumes when it names a child, its worktree still exists (or is null, in
sequential mode), and its `resume_count` is under the cap of one per row. A row
written before the resume columns existed falls back to counting the restarts
its child already survived. Everything else is abandoned, by index, so
abandoning one row never stops a session another row is about to continue. The
counts, the resumed workers, and the per-row refusal reason are logged once as
`epic.runner.restart-resume`.

A resumed worker gets a turn that says the process died mid-command, with
`git status --porcelain=v1` and `git diff --stat` from its worktree as evidence.
It does not repeat the epic context; the thread it continues still holds it. The
run's failure streaks carry across the restart, so a run cannot restart its way
out of the gutter.

When the session cannot be resumed, the worktree and the claim are handed to a
fresh iteration in the same worktree rather than thrown away, and the old row is
scored `infra:resume-unsupported`, `infra:resume-blocked`, or
`infra:resume-failed`. Only a missing worktree or a child that is already closed
releases the claim.

The resume names what the run already owns: its run id and the
`worktree_path` of every row still marked `running`. Preflight forgives exactly
those and nothing else. What it forgave, and which named worktree it could not
find, is logged at boot as `epic.runner.resume-preflight-warnings` with the run
id.

If the preflight or the lock fails, the run parks as `paused`, with the blocker
text in `last_error` and its thread pointers cleared. Every row still marked
`running` is reconciled to `abandoned` / `server-restart`, and every child the
run claimed is released back to Beads. Nothing drives those threads: without a
lock the runner has no right to, and the session reaper already stopped their
sessions. An operator clears the blocker and calls resume on the run.

These still block a resume:

- The epic is not in Beads.
- The workspace directory is gone, or a git command in it fails.
- The lock is held by a holder that is still live.
- HEAD is detached.
- The base checkout is dirty, in parallel mode. It counts tracked changes,
  unless the run owns its base branch, and always counts a dirty registered
  nested worktree that the resume does not own. It counts nothing under
  `.beads/`.
- `.t3code/epic-run.json` does not parse, or its `gate.command` is invalid.
- An integration branch or worktree from a **different** run is present.
- A configured sibling repository does not validate.
- The run-owned base branch is the branch checked out in the main checkout.
  Landing fetches into that ref, and git refuses to fetch into a checked-out
  branch.

These do not block a resume:

- The run's own integration branch and worktree. The resume passes its run id,
  so its own leftovers read as where it left off, not as residue to reconcile.
  This one is silent, not a warning.
- The run's own per-worker worktrees, named by the resume. A dirty one is the
  interrupted agent's unfinished work, which is the point of the resume.
- A dirty base checkout in sequential mode. That work is the run's own, so it is
  accepted and reported as a `dirty_tree_accepted` warning with the paths. A
  parallel run still blocks: a dirty base tree there is the operator's.
- A named worktree git no longer lists, or that is gone from disk. Reported as a
  `resume_worktree_missing` warning with the paths.
- Untracked files in the base checkout, in parallel mode. Reported as a warning
  with the paths.
- Tracked changes the run ignores because it owns its base branch. Reported as a
  warning with the paths, so nobody assumes uncommitted work is in the run.
- A child still claimed by a PID that no longer exists.
- Unknown keys in `.t3code/epic-run.json`, and config violations other than
  `gate.command`.
- A run-owned base branch that is behind the current branch.
- No child is ready.

To prove all of this on a real machine, follow
[`docs/operations/epic-run-restart-resume.md`](operations/epic-run-restart-resume.md).
It holds a detached verification script and the risk register.

## What a terminal cook restart checks

A terminal pool cook restarts the same way, from the same shared loop. A run
directory is one run's journal, so `t3 epic cook --run-dir <dir>` — and
`skills/cook-epic/run.sh <dir>` through it — continues the run that directory
holds whenever that run is still `running`. A directory holding a finished run
is still refused, and so is one holding a run of a different epic.

The cook reads the run record before preflight, so the worktrees of every row
still marked `running` are named in the resume and forgiven. It hands the loop
every such row whose child is named and whose `resume_count` is under the same
cap of one, writes the rest off as `server-restart`, and lets the loop decide the
rest. The terminal harness declares `lifecycle.resume: "unsupported"`, so in
practice the loop hands the worktree and the claim to a fresh iteration and
scores the old row `infra:resume-unsupported`.

`branch` and `worktree_path` live in the iteration record for this one reader:
without them a restarted cook cannot find the tree the dead worker was
committing into.

Parallel workers get one worktree each at
`<baseDir>/worktrees/epic-<runId>/<issueId>`, and the merge queue gets
`<baseDir>/worktrees/epic-<runId>/integration`. `baseDir` is the server base
directory and defaults to `~/.t3`. Sequential mode uses no worktrees; it works in
the real checkout.

## Restart a terminal cook

A terminal cook mints a new run id per invocation, so it starts a new run each
time. Pass `--run-id <id>` to continue an earlier one instead. The default run
directory is a pure function of the run id, so the flag alone lands the restart
on the journal the earlier process wrote; pass the same `--run-dir` too if the
first call used one.

The restart continues the run rather than replaying it. It reads the run record
back, keeps its iteration count, its completed count, its failure streaks and
its per-child attempt budgets, and appends its first row past the highest row
already on disk. A row an interrupted process left `running` settles as
`abandoned` / `process-restart`: the sequential core has no resume dispatch, so
that child gets a fresh iteration rather than its old session back. Nothing
already on disk is rewritten.

A run that already reached `done` is finished. Restarting it fails with a
`resume` error and its record is left alone.

This is the sequential engine only, so a restart needs the same one-worker
escape the first call used (`COOKEPIC_SEQUENTIAL=1` or `COOKEPIC_WORKERS=1`). A
parallel terminal cook still refuses a run id it has already created.

## Recover a run that failed at boot

Servers before this change wrote `failed` on a blocked boot and left the
in-flight rows at `running`. `failed` is a dead end: resume only accepts
`paused`. Fix such a run by hand.

Stop the server first. Then, against `~/.t3/userdata/state.sqlite`:

```sql
UPDATE epic_runs
SET status = 'paused',
    current_thread_id = NULL,
    current_turn_started_at = NULL
WHERE run_id = '<run-id>' AND status = 'failed';

UPDATE epic_run_iterations
SET turn_status = 'abandoned',
    summary = 'abandoned by server restart',
    failure_reason = 'server-restart',
    finished_at = '<iso-timestamp>'
WHERE run_id = '<run-id>' AND turn_status = 'running';
```

Clear the blocker in `last_error`, start the server, and resume the run. Check
the run's children in Beads too: a claim the old process never released still
reads `in_progress`.

## Switch between modes

Before switching, let the current runner finish or stop it cleanly so it
releases the epic lock. Commit any work in the checkout. Then start the same
epic from the other mode. The new runner reads `bd ready --parent <epic-id>
--json`, so closed children stay closed and newly unblocked children become the
next work.
