# Run an epic from a terminal or T3 Code

You can start an epic in a plain terminal and continue it from T3 Code, or do
the reverse. Beads and Git are the shared source of truth. T3 Code observes that
state and launches work; it does not keep a second copy of issue status.

## Shared state

| State                                         | Location                                                                                                               | Owner                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Issue status, claims, dependencies, and notes | The repository's `.beads` database                                                                                     | Workers using `bd`                    |
| Commits and branches                          | Git; the sequential terminal core commits on the base branch, server runs use `epic/<child-id>` branches and worktrees | Workers and cook-epic                 |
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

## Integration gate and host load

The merge queue runs the integration gate once per merge set. The gate is the
heaviest thing an epic run does, and its result depends on the machine it runs
on, not only on the code it tests.

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
- A server restart ends the server process and every provider subprocess the
  server owns directly. No provider session reattaches. T3 Code therefore saves
  server-owned epic runs in SQLite and resumes them at startup
  ([`serverRuntimeStartup.ts`](../apps/server/src/serverRuntimeStartup.ts) calls
  `EpicRunner.start`).
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
server re-runs the preflight with a resume intent, takes the run lock, abandons
the run's own running iteration rows, reclaims a merge slot the dead process
leaked, stops the worker scope units that carry its run identity, and forks the
loop again.

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

Parallel workers get one worktree each at
`<baseDir>/worktrees/epic-<runId>/<issueId>`, and the merge queue gets
`<baseDir>/worktrees/epic-<runId>/integration`. `baseDir` is the server base
directory and defaults to `~/.t3`. Sequential mode uses no worktrees; it works in
the real checkout.

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
