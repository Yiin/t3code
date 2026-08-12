# Agent orientation

EpicRunner adds this card to worker prompts. `AGENTS.md` wins on conflicts.

## Check commands

Node is pinned by `mise.toml`. Use pnpm through `vp`.

- Focused tests: `vp test run <test-files>`
- Typecheck: `vp run --filter t3 typecheck`, `@t3tools/web`, or `@t3tools/mobile`
- Touched files: `vp fmt --check <files>` and `vp lint <files>`

Keep worker checks focused. Run a supplied gate command exactly.

## Repo layout

- `apps/server` owns providers, persistence, orchestration, and runner ports.
- `apps/web` and `apps/mobile` own clients. `packages/contracts` has schemas only.
- `packages/epic-core` owns shared runner logic.
- `packages/shared` has explicit exports. `.repos` is read-only reference code.

## EpicRunner paths and facts

- `ParallelEpicLoop.ts` drives scheduling and `workerSupervision.ts`.
- `workerSupervision.ts` drives the pure `workerLiveness.ts` machine.
- `MergeQueue.ts` owns trial merges and gates.
- `apps/server/src/runner/Layers/EpicRunner.ts` owns lifecycle and restart recovery.
- `EpicRunnerPoolPorts.ts` adapts server ports.
- `apps/server/src/orchestration/ThreadSettleWatch.ts` watches owned turns and final messages.
- `packages/epic-core/src/EpicRunPreflight.ts` gates both launch and resume.
- `packages/epic-core/src/adapters/NodeEpicRunLock.ts` owns the run lock. It shares
  its file format with `skills/ralph/run.sh`.
- `packages/epic-core/src/workerScope.ts` puts workers in `cook-epic.slice`, so they
  survive a service restart.
- Restart recovery abandons old running iteration rows, then resumes each running run.
  A resume re-runs preflight in resume mode, which forgives only that run's own
  integration branch and worktree, and stops only that run's own leftover worker
  scopes. A lost lease fails the run and releases its claimed child.
- Client turn ingress does not block threads owned by an EpicRunner run.

Never install dependencies or run `skills/install.sh` inside an epic worktree.
Its linked `node_modules` can damage the source checkout.

Do not infer file conflicts from issue prose. Beads must confirm no open child
before run completion. Provider fallback uses structured evidence only.

## Message delivery

- `packages/contracts/src/orchestration.ts` defines `origin`, `delivery`, and `deliveryState`.
- `origin` is `human` or `agent`. Old messages without it mean `human`.
- `delivery` is `immediate` or `turn-boundary`. Absence means `immediate`.
- `deliveryState: "queued"` means a message waits for the next turn boundary.
- `apps/server/src/orchestration/decider.ts` projects origin and parks messages.
- `Layers/QueuedTurnDeliveryReactor.ts` sends parked messages normally.
- `Layers/ProviderCommandReactor.ts` sends turns and adopts only genuine steers.
- Web child-chat sends write `origin: "human"` and choose delivery intent.
- MCP child prompts and EpicRunner prompts write `origin: "agent"`.
- EpicRunner origin-thread status updates also use `delivery: "turn-boundary"`.

## Provider seams

Codex, OpenCode, Prime, and Claude can steer a running turn. Their adapters set
`steeredIntoActiveTurn` only when the agent received a genuine steer.

Kimi, Grok, and Cursor use
`apps/server/src/provider/Layers/{Kimi,Grok,Cursor}Adapter.ts`.
Their calls queue behind the whole-turn, one-permit prompt semaphore in
`apps/server/src/provider/acp/AcpSessionRuntime.ts`. Each prompt gets a new turn.
They never report a fake steer.

`apps/server/scripts/acp-mock-agent.ts` supports
`T3_ACP_PROMPT_DELAY_MS`, `T3_ACP_REQUEST_LOG_PATH`, and
`T3_ACP_REJECT_OVERLAPPING_PROMPTS`. Live CLI probes use
`T3_KIMI_ACP_PROBE`, `T3_GROK_ACP_PROBE`, or `T3_CURSOR_ACP_PROBE`.
`apps/server/vite.config.ts` sets `fileParallelism: false`. All three adapter
tests use the ACP mid-turn conformance suite.

The Claude capability probe is in `apps/server/src/provider/Layers/ClaudeProvider.ts`.
`apps/server/src/provider/Drivers/ClaudeDriver.ts` caches it for five minutes.
The probe uses a never-yielding prompt, so it sends no user message.

Treat new SDK controls as optional. Check, catch, time out, and handle no result.

An instance's `homePath` becomes `CLAUDE_CONFIG_DIR`. A session only resumes
inside the config directory that created it.

## Settings

Deep merge cannot delete keys. Use `ATOMIC_SETTINGS_KEYS`; follow `providerInstances`.

## Local service

The service is `t3code.service`. Build before restart. Logs are in
`~/.t3/userdata/logs/boot-service.log`.

`systemctl --user restart t3code.service` does not stop live epic workers. They
run in `cook-epic.slice`, outside the service cgroup. The next boot resume stops
the scope units belonging to the runs it resumes.
