# Agent orientation

Operational facts for agents in this repo. EpicRunner injects this card into
worker prompts. `AGENTS.md` is authoritative when the two files differ.

## Check commands

Node is pinned by `mise.toml`. Use pnpm through `vp`.

| Purpose             | Command                                     |
| ------------------- | ------------------------------------------- |
| Focused tests       | `vp test run <test-files>`                  |
| Package tests       | `vp run test` from the affected package     |
| Server typecheck    | `vp run --filter t3 typecheck`              |
| Web typecheck       | `vp run --filter @t3tools/web typecheck`    |
| Mobile typecheck    | `vp run --filter @t3tools/mobile typecheck` |
| Touched-file format | `vp fmt --check <changed-files>`            |
| Touched-file lint   | `vp lint <changed-files>`                   |

Keep your own checks focused on what you changed; the integration gate is what
proves the whole repo still works, and CI runs the full suite on pull requests
and pushes to `main` or `mine`.

When a task hands you a specific gate command — an epic merge-fix child does —
run that one as given, even though it is repo-wide. Substituting a focused
check there reports a pass the gate never gave.

## Repo layout

- `apps/server` owns provider drivers, sessions, persistence, and runner ports.
- `apps/web` owns the React web client.
- `apps/mobile` owns the Expo client.
- `packages/contracts` contains schemas only. Put no runtime logic there.
- `packages/epic-core` owns shared loop policy, scheduling, gates, and ports.
- `packages/shared` uses explicit subpath exports. Do not add a barrel index.
- `skills/cook-epic` owns the canonical terminal coordinator and worker contract.
- `.repos` contains read-only reference checkouts. Do not import from it.

## EpicRunner path map

- `packages/epic-core/src/ParallelEpicLoop.ts` owns the parallel scheduling loop.
- `packages/epic-core/src/policy.ts` classifies iteration boundaries.
- `packages/epic-core/src/MergeQueue.ts` owns trial merges and integration gates.
- `packages/epic-core/src/workerLiveness.ts` is a pure state machine. No production loop drives it as of 2026-08-08.
- `packages/epic-core/src/ports/AgentDispatch.ts` defines worker handle capabilities.
- `packages/contracts/src/epicRunConfig.ts` defines run defaults and supervision settings.
- `apps/server/src/runner/Layers/EpicRunner.ts` owns server lifecycle and restart reconciliation.
- `apps/server/src/runner/Layers/EpicRunnerPoolPorts.ts` adapts dispatch, journal, backlog, merge, and VCS ports.
- `apps/server/src/provider/Services/ProviderAdapter.ts` defines provider capabilities and session start.
- `apps/server/src/persistence/Layers/EpicRuns.ts` implements the durable run store.
- `apps/server/integration/epicRunnerConformance.integration.test.ts` runs server conformance scenarios.
- `docs/epic-runs.md` describes run behavior. Treat old line citations as stale.

## Runner contracts and traps

- Both terminal and server runners use `packages/epic-core`.
- `skills/cook-epic/run.sh` is a shim. Edit it here, then run `./skills/install.sh`.
- Provider fallback uses structured provider evidence only.
- `primeAgent` work belongs to `t3code-b93.13`. Do not duplicate it.
- Do not parse issue prose to infer file conflicts.
- Do not mark a run done until Beads confirms no open child remains.
- Keep worker checks focused. The merge gate provides integration proof.
- `workerLiveness.ts` is not active supervision until a production driver calls it.
- Client turn ingress has no epic-thread ownership gate as of 2026-08-08.
- Restart reconciliation abandons running iterations as of 2026-08-08. It does not resume the same row.
- Read `.repos/effect-smol/LLMS.md` before writing Effect code.

## Local service

The service is `t3code.service`. Build before `systemctl --user restart t3code.service`.
Logs are in `~/.t3/userdata/logs/boot-service.log`.
