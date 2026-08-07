# cook-epic rollout: from the Bash coordinator to the shared core

This is the exit checklist for retiring the legacy terminal coordinator
(`skills/cook-epic/run-legacy.sh`) and, one release later, the `run.sh`
compatibility shim. Every item names its evidence. Removal is tracked by
t3code-06s.42; conformance gaps are tracked by t3code-06s.41.

## Exit checklist

- [x] **Every conformance scenario's `appliesTo` covers both `core` and
      `terminal`, or the narrowed scenario names the bead that covers the gap.**
      Evidence: 11 of 20 scenarios in `packages/epic-run-conformance/scenarios/`
      apply to `["core","terminal","server"]`. The 9 narrowed scenarios name
      t3code-06s.41 in their `description`:
  - terminal-only (the core's terminal cook loop is sequential):
    `parallel-worktrees`, `park-merge-conflict`,
    `permission-denial-fast-park`, `serialized-trial-merge`,
    `sibling-repo-layout`;
  - core+server, terminal leg missing: `child-failure-budget`,
    `no-commit-gutter`, `stranded-child-reopened`;
  - server-only: `ready-unrecognised`.
- [x] **The shadow comparator reports zero structural divergences on at least
      three real epics of increasing size.** Evidence: on 2026-08-07,
      `node scripts/epic-shadow-compare.ts --epic <id> --cwd <repo> --adapters
terminal,core --mode run` ran against three real Beads epics of 1, 2, and 3
      children in a throwaway repository with an embedded Beads database
      (`EPIC_SHADOW_WORKER_CMD` supplied the deterministic worker). All three
      exited 0 with `structural divergences: 0`; the only content divergences were
      worker `summary`/`why` wording, which the comparator reports but does not
      fail on. A same-adapter live-Codex probe (t3code-06s.13, 2026-08-07) and the
      live-agent shim run below cover the real-agent dispatch path.
- [x] **The engine flag default has flipped from `legacy` to `core` and stays
      there with no rollback.** Evidence: the default flipped in the change that
      closed t3code-06s.28 on 2026-08-07
      (`packages/contracts/src/epicRunConfig.ts` `engine` default, and the
      `run.sh` shim's default engine). The observation period runs until
      t3code-06s.42 removes the legacy engine — one documented release. No
      rollback has occurred since the flip; a rollback shows up as a revert of
      either default.
- [x] **Every `COOKEPIC_*` knob documented in the old `run.sh` header has a
      documented equivalent or is declared dropped with a reason.** Evidence: the
      mapping table below.
- [x] **One real epic ran end to end through the shim.** Evidence: on
      2026-08-07, `skills/cook-epic/run.sh` (default engine) ran epic `ev-1ew` in
      a throwaway repository with a live Codex worker. The shim resolved
      `apps/server/dist/bin.mjs`, exec'd `t3 epic cook`, and the worker created
      and committed `hello.txt` and closed child `ev-1ew.2`; the run journal
      recorded `status: "done"`.
- [x] **The bash suite passes against the shim with zero deletions.**
      Evidence: `skills/cook-epic/tests/all.sh` passes all 12 files.
      `core-delegation.sh` covers the shim; the other 11 drive `run-legacy.sh`
      and retire with it (t3code-06s.42).

## Knob mapping

The shim maps these onto the shared run config (the deprecated environment
layer of `.t3code/epic-run.json` resolution) or passes them to `t3 epic cook`:

| Knob                        | Lands as                                                      |
| --------------------------- | ------------------------------------------------------------- |
| `COOKEPIC_EPIC`             | `--epic` (required)                                           |
| `COOKEPIC_HARNESS`          | harness selection at dispatch                                 |
| `COOKEPIC_GATE`             | `gate.command`                                                |
| `COOKEPIC_NO_GATE`          | `gate.disabled`                                               |
| `COOKEPIC_NO_PUSH`          | `vcs.noPush`                                                  |
| `COOKEPIC_MAX_DISPATCHES`   | `limits.maxIterations`                                        |
| `COOKEPIC_MAX_ATTEMPTS`     | `limits.maxAttemptsPerChild`                                  |
| `COOKEPIC_WORKER_TIMEOUT`   | `supervision.workerTimeoutSeconds`                            |
| `COOKEPIC_STOP_GRACE`       | `supervision.stopGraceSeconds`                                |
| `COOKEPIC_MODEL`            | `provider.modelSelection`                                     |
| `COOKEPIC_PERMISSION_MODE`  | `runtime.mode`                                                |
| `COOKEPIC_ORIENTATION_FILE` | `orientation.file`                                            |
| `COOKEPIC_BIN`              | harness binary override at dispatch                           |
| `COOKEPIC_WORKER_CMD`       | `worker-cmd` harness (test seam)                              |
| `COOKEPIC_T3_BIN`           | shim entrypoint resolution (shim-only)                        |
| `COOKEPIC_CORE`             | engine selection (shim-only)                                  |
| `COOKEPIC_SEQUENTIAL`       | must be `1` or unset; the core cook loop is always sequential |

Every other knob refuses to start. The dropped knobs and their reasons:

| Dropped knob                                                                                                                                                                                                                                              | Reason                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COOKEPIC_WORKERS`, `COOKEPIC_SIBLINGS`                                                                                                                                                                                                                   | The core's terminal cook loop is sequential. Parallel terminal execution retires with the legacy engine (t3code-06s.42); the conformance gap is t3code-06s.41.                                                                                                                      |
| `COOKEPIC_BUDGET_USD`                                                                                                                                                                                                                                     | `budget.usd` exists in the schema but nothing enforces it; the Bash enforcer only ever worked on claude/ccx, and codex/kimi/opencode do not report spend.                                                                                                                           |
| `COOKEPIC_IDLE_THRESHOLD`, `COOKEPIC_INSPECTOR_TIMEOUT`, `COOKEPIC_INSPECT_RETRY_DELAY`, `COOKEPIC_INSPECT_MIN_DELAY`, `COOKEPIC_INSPECT_MAX_DELAY`, `COOKEPIC_INSPECTOR_CMD`                                                                             | The inspector agent is dropped for the terminal: the liveness state machine is ported (`packages/epic-core/src/workerLiveness.ts`) but no loop drives it, and the sequential core relies on the worker timeout. The `supervision.inspect*` config keys remain for when it is wired. |
| `COOKEPIC_CLOCK_CMD`, `COOKEPIC_RESOURCE_SAMPLER_CMD`, `COOKEPIC_WORKER_ACTIVE_CMD`, `COOKEPIC_WORKER_STOP_CMD`, `COOKEPIC_PROCESS_START_TICKS_CMD`, `COOKEPIC_PUSH_CMD`, `COOKEPIC_DISABLE_SYSTEMD`, `COOKEPIC_SPAWN_DELAY`, `COOKEPIC_SUPERVISION_TICK` | Bash implementation test seams. The core has typed ports with vitest fakes instead of environment seams.                                                                                                                                                                            |
| `COOKEPIC_FOLD_CMD`, `COOKEPIC_FOLD_TIMEOUT`                                                                                                                                                                                                              | Epic-notes folding is dropped: the core's `FoldShape` port has only a stub implementation, and workers already fold their own `DECISION:`/`GOTCHA:` markers into their close-out note.                                                                                              |
| `COOKEPIC_CPU_WEIGHT`, `COOKEPIC_MEMORY_HIGH`                                                                                                                                                                                                             | Landed with fixed values: `workerScope.ts` hardcodes the old defaults (CPUWeight 50, MemoryHigh 60%). No longer knobs.                                                                                                                                                              |
| `COOKEPIC_IO_WEIGHT`                                                                                                                                                                                                                                      | Dropped per t3code-06s.8: io is not delegated to user slices, so the knob was inert.                                                                                                                                                                                                |
| `COOKEPIC_WORKER_ARTIFACT_BYTES`, `COOKEPIC_INSPECTOR_RESULT_BYTES`, `COOKEPIC_INSPECTOR_LOG_BYTES`, `COOKEPIC_REPO_EVIDENCE_BYTES`                                                                                                                       | Bounded-capture limits are internal constants in the core adapters.                                                                                                                                                                                                                 |
| `COOKEPIC_REPO_PROBE_INTERVAL`, `COOKEPIC_REPO_PROBE_TIMEOUT`                                                                                                                                                                                             | The repository probe is part of the unwired liveness machine; dropped with the inspector.                                                                                                                                                                                           |
| `COOKEPIC_RATE_LIMIT_BACKOFF`                                                                                                                                                                                                                             | `retry.rateLimitBackoffSeconds` exists in the schema with the old default (120s); the env override is dropped.                                                                                                                                                                      |
| `RUNLOCK_HEARTBEAT_SECS`, `RUNLOCK_STALE_SECS`                                                                                                                                                                                                            | `NodeEpicRunLock` hardcodes the old defaults (30s heartbeat, 300s stale).                                                                                                                                                                                                           |
| `OPENCODE_BIN`                                                                                                                                                                                                                                            | `COOKEPIC_BIN` is the single binary-override knob for every harness.                                                                                                                                                                                                                |

## Bash-only features: landed or dropped

- **systemd cgroup governance — landed.** `packages/epic-core/src/workerScope.ts`
  wraps worker spawns in named scopes under `cook-epic.slice` with the old
  defaults; `t3 epic cook` prepares one scope per run. Fail-soft except for a
  run-identity collision. `IOWeight` was deliberately not ported.
- **Inspector agent — dropped.** The pure state machine is ported but no loop
  drives it. Recorded here as the deliberate drop: the sequential core loop's
  worker timeout covers the runaway case the inspector guarded, and wiring the
  machine is new feature work, not parity work.
- **Epic-notes folding — dropped.** The `FoldShape` port exists with a stub
  implementation. Workers already carry `DECISION:`/`GOTCHA:` markers in their
  close-out notes, and the fold agent was cosmetic compaction.
- **Soft spend cap — dropped.** `budget.usd` is schema-only; no loop reads it.
  The Bash enforcer was claude/ccx-only because the other harnesses do not
  report spend.
- **bd swarm registration — dropped.** `ProcessBacklog` implements
  `swarm`/`ensureSwarm`, but no loop calls them and nothing consumes the swarm
  record outside the legacy coordinator's own logging.

## Release plan

1. This change: `run.sh` becomes the shim, default engine `core`, legacy one
   release behind `COOKEPIC_CORE=legacy`.
2. t3code-06s.41 closes the conformance `appliesTo` gaps.
3. ~~After one release with no rollback, t3code-06s.42 deletes `run-legacy.sh`,
   retires or ports the 11 legacy bash suites, and removes the
   `COOKEPIC_CORE` escape hatch.~~ Done 2026-08-07 (t3code-06s.42); see
   **Retirement** below.

## Retirement

Completed 2026-08-07 under t3code-06s.42, after one release with no rollback:

- `skills/cook-epic/run-legacy.sh` and its 11 Bash suites under
  `skills/cook-epic/tests/` are deleted. `core-delegation.sh` keeps covering
  the shim (entrypoint resolution, knob validation, one real-`bd` fixture run
  through the core engine).
- The 5 legacy-only prompt templates (`worker-prompt.md`,
  `worker-prompt-sequential.md`, `inspector-prompt.md`, `inspector-agent.md`,
  `fold-prompt.md`) are deleted with it.
- The `COOKEPIC_CORE` escape hatch is gone: `run.sh` always execs
  `t3 epic cook`, and the `engine` config literal no longer accepts `legacy`.
- Parallel terminal execution retires with the legacy engine. Its 5
  terminal-only conformance scenarios (`parallel-worktrees`,
  `park-merge-conflict`, `permission-denial-fast-park`,
  `serialized-trial-merge`, `sibling-repo-layout`) are deleted; the coverage
  gap stays tracked by t3code-06s.41.
- The shadow comparator (`scripts/epic-shadow-compare.ts` and its library and
  tests) is deleted. It served its evidence purpose — the zero-divergence runs
  recorded above — and compared two engines, one of which no longer exists.
  Its core-mailbox normalizer lives on as
  `packages/epic-run-conformance/src/coreMailbox.ts`.
- The conformance terminal leg now drives the shared core through `run.sh`
  with a hermetic `t3` wrapper; `mailboxTranscript.ts` (the legacy mailbox
  parser) is deleted.
- `skills/cook-epic/watch.sh` remains the operator monitor.
