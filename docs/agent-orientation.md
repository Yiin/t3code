# Agent orientation

Operational facts for agents working in this repo. `cook-epic` splices this file
into every worker prompt (`skills/cook-epic/run.sh:2011-2024` prefers it over
`AGENTS.md`). Keep it short and literal.

## Check commands

Node is pinned to 24.18.0 via `mise.toml`. Package manager is pnpm.

| Purpose                 | Command                                    |
| ----------------------- | ------------------------------------------ |
| Focused tests           | `vp test run <test-files>`                 |
| One package's tests     | `vp run test` (from that package)          |
| One package's typecheck | `tsgo --noEmit` (from that package)        |
| Repo typecheck          | `bun run typecheck`                        |
| Repo lint               | `bun run lint`                             |
| Repo tests              | `bun run test`                             |
| Repo build              | `bun run build`                            |
| Format                  | `bun run fmt` (check: `bun run fmt:check`) |
| Dev                     | `bun run dev`, or `bun run dev:server`     |

**CI does not gate this work.** `.github/workflows/ci.yml` triggers only on
`pull_request` and on push to `main`. Day-to-day work happens on branch `mine`.
Run focused checks while you work, and run the repo-wide gate yourself before you
call a change done. Do not assume CI will catch anything.

## Repo layout

- `apps/server` — the t3code server: runner, orchestration, persistence, beads.
- `apps/web` — the UI.
- `packages/contracts` — schemas only. No runtime logic belongs here.
- `packages/shared` — no barrel index; import the exact module path.
- `packages/client-runtime` — client state.
- `skills/` — the agent skills this repo ships. Canonical source.
- `.repos/` — vendored reference checkouts, synced by `bun run sync:repos`.

## Epic runner

The server runner is a thin adapter over the shared loop in `packages/epic-core`;
the terminal's `t3 epic local` entry uses the same core. `run.sh` remains the
canonical terminal coordinator until it is reduced to a shim.

- `skills/cook-epic/run.sh` (3238 lines) — the terminal coordinator. This copy is
  canonical; `skills/install.sh` symlinks it into `~/.agents/skills`. Edit it
  here, then run `./skills/install.sh`. Never edit the installed symlink target.
- `skills/cook-epic/SKILL.md` — the terminal coordinator's contract.
- `packages/epic-core` — the shared loop, policy, ports, and conformance core.
- `apps/server/src/runner/Layers/EpicRunner.ts` — the server adapter: lifecycle
  and loop supervision only. The loop is `runParallelEpicLoop` from epic-core.
- `apps/server/src/runner/Layers/EpicRunnerPoolPorts.ts` — the server port
  adapters (dispatch, journal, events, backlog, workspace, merge drain, VCS).
- `apps/server/src/runner/Services/EpicRunner.ts` — the service shape.
- `packages/epic-core/src/ralphProtocol.ts` — `RALPH_MSG`/`RALPH_DONE` parsing and
  the outcome kinds.
- `packages/epic-core/src/providerFallback.ts` — claude to codex to kimi.
- `packages/epic-core/src/ports/EpicRunLock.ts` — the run lock port, shared with
  `run.sh`. Both owners take the same file.
- `packages/epic-core/src/EpicRunPreflight.ts` — blockers and warnings. The lock
  is observed before all other checks; parallel mode warns on untracked files,
  exempts clean registered nested worktrees, and blocks integration leftovers.
- `packages/epic-core/src/workerLiveness.ts` — the pure per-worker liveness
  state machine (progress signals, repo probe, inspector stop gating), fed by
  `ports/WorkerEvidence.ts`. Ported from `run.sh` `supervise_workers`.
- `packages/epic-core/src/workerScope.ts` — optional systemd scope governance
  for worker spawns (named scopes under `cook-epic.slice`, CPUWeight and
  MemoryHigh only). Fail-soft except for a run-identity collision.
- `apps/server/integration/epicRunnerConformance.integration.test.ts` — runs
  every conformance scenario whose `appliesTo` includes "server" through the
  server adapter.
- `packages/contracts/src/epicRuns.ts` — `EpicRunInput`, `LaunchEpicRunInput`, the
  iteration report and its `failureReason` vocabulary.
- `apps/server/src/persistence/Layers/EpicRuns.ts` — the run store.
- `docs/epic-runs.md` — describes the sequential server runner only. Treat its
  line-range citations as stale.

## Do not

- Do not write runtime logic into `packages/contracts`. Schemas only.
- Do not add a barrel index to `packages/shared`. Import the module path.
- Do not write Effect code before reading `.repos/effect-smol/LLMS.md`.
- Do not edit the installed skill symlinks. Edit `skills/` here and reinstall.
- Do not trust `AGENTS.md` on verification. It says CI runs the full suite; on
  branch `mine` it does not.

## Local service

The running server is a systemd user unit built from this checkout:
`systemctl --user restart t3code.service` after `bun run build`. Logs go to
`~/.t3/userdata/logs/boot-service.log`.
