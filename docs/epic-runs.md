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
child. `NodeEpicRunLock` in `packages/epic-core` is the shared implementation
for the terminal core and the hosted runner; ralph keeps its own Bash holder on
the same file format. The `NodeEpicRunLock` interop test covers the shared file
format and exclusive-create behavior across the TypeScript and Bash
implementations.

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
- A server restart ends the old process and its provider subprocesses; no
  provider session reattaches. T3 Code therefore saves server-owned epic runs
  in SQLite and reconciles them at startup
  ([`serverRuntimeStartup.ts:344-353`](../apps/server/src/serverRuntimeStartup.ts#L344-L353)).

## Switch between modes

Before switching, let the current runner finish or stop it cleanly so it
releases the epic lock. Commit any work in the checkout. Then start the same
epic from the other mode. The new runner reads `bd ready --parent <epic-id>
--json`, so closed children stay closed and newly unblocked children become the
next work.
