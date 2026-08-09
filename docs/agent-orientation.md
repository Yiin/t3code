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
- Never run `vp install`, `pnpm install`, or any dependency install inside an
  epic worktree. Its root `node_modules` is a link into the source checkout, so
  an install writes through it and repoints the real checkout's dependency
  links at your temporary worktree. When the worktree is pruned, every other
  worker and the integration gate fail with `ERR_MODULE_NOT_FOUND`. This
  already happened once and cost a whole run. Your worktree is provisioned
  with the dependencies already mirrored — if something is genuinely missing,
  say so on the issue instead of installing. Tracked as `t3code-b93.22`.
- `skills/cook-epic/run.sh` is a shim. Edit it here; committing the edit is
  enough. Do not run `./skills/install.sh` from a worktree — it rewrites the
  machine's global skill links, and they break when the worktree is pruned.
  It now refuses, but only the canonical checkout should install.
- Provider fallback uses structured provider evidence only.
- `primeAgent` work belongs to `t3code-b93.13`. Do not duplicate it.
- Do not parse issue prose to infer file conflicts.
- Do not mark a run done until Beads confirms no open child remains.
- Keep worker checks focused. The merge gate provides integration proof.
- Client turn ingress has no epic-thread ownership gate as of 2026-08-08.
- Restart reconciliation abandons running iterations as of 2026-08-08. It does not resume the same row.
- Read `.repos/effect-smol/LLMS.md` before writing Effect code.

## Settings and persistence traps

- Settings flow through `packages/contracts/src/settings.ts` (schema plus a
  hand-written `*Patch` mirror), `packages/shared/src/serverSettings.ts` (apply),
  `apps/server/src/serverSettings.ts` (persist), `apps/web/src/hooks/useSettings.ts` (patch).
- A patch is applied by deep merge, so a nested record cannot delete a key.
  Give a record-shaped setting a whole-value replacement branch and list it in
  `ATOMIC_SETTINGS_KEYS`. `providerInstances` is the precedent for both.
- A new settings page needs an entry in
  `apps/web/src/components/settings/SettingsSidebarNav.tsx`, a route file at
  `apps/web/src/routes/settings.<name>.tsx`, and the regenerated
  `apps/web/src/routeTree.gen.ts` committed with them.
- Migrations are `apps/server/src/persistence/Migrations/NNN_Name.ts`, numbered
  in sequence. A new table also needs a `Services/` shape and a `Layers/` SQL
  implementation. Follow `EpicRuns.ts`.

## Provider seams

- A Claude query can be opened with a never-yielding prompt, so control requests
  cost no inference tokens. `ClaudeProvider.ts` does this to probe capabilities
  and `ClaudeDriver.ts` caches it per instance for 5 minutes. Extend that probe
  instead of spawning new processes.
- Treat any new SDK control method as optional. Guard it the way
  `getContextUsage` is guarded in `ClaudeAdapter.ts`: presence check, `try`/`catch`,
  timeout, falsy check.
- An instance's `homePath` becomes `CLAUDE_CONFIG_DIR`, so instances are separate
  accounts. A session id belongs to the config dir that made it, so `--resume`
  never crosses instances.
- In `packages/epic-core/src/adapters/TerminalAgentDispatch.ts`, `runAuxiliary`
  returns `succeeded: false` with empty output for every harness except prime and
  logs nothing, so the idle inspector and note fold do nothing elsewhere. The
  claude and ccx branch also always passes `--model`, ignoring
  `useHarnessDefaultModel`, unlike the kimi, codex and opencode branches.

## Local service

The service is `t3code.service`. Build before `systemctl --user restart t3code.service`.
Logs are in `~/.t3/userdata/logs/boot-service.log`.
