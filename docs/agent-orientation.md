# Agent orientation

EpicRunner adds this card to worker prompts. `AGENTS.md` wins on conflicts.

## Check commands

Node is pinned by `mise.toml`. Use pnpm through `vp`.

- Focused tests: `vp test run <test-files>`
- Typecheck: `vp run --filter t3 typecheck`, `vp run --filter @t3tools/web typecheck`,
  `vp run --filter @t3tools/epic-core typecheck`, or
  `vp run --filter @t3tools/epic-run-conformance typecheck`
- Touched files: `vp fmt --check <files>` and `vp lint <files>`

Keep worker checks focused. Run a supplied gate command exactly.

`packages/epic-run-conformance` holds the shared epic-run scenarios. `scenario.ts`
defines them; each one lists `appliesTo` from `core`, `terminal`, and `server`, and
every driver runs only the scenarios that name it.

Three drivers run those scenarios: the server driver, plus
`coreDriver.test.ts` and `terminalDriver.test.ts` in
`packages/epic-run-conformance/src`. The terminal leg is skipped unless
`T3CODE_CONFORMANCE_TERMINAL` is set, and `T3CODE_CONFORMANCE_SCENARIO=<name>`
narrows it to one scenario. Editing one scenario means running all three.

`apps/server/vite.config.ts` sets `fileParallelism: false` and raises both
`hookTimeout` and `testTimeout` to 120 s. Server tests are load sensitive.

## Repo layout

- `apps/server` owns providers, persistence, orchestration, and runner ports.
- `apps/web` is the only client, and it serves phones too. `packages/contracts` has schemas only.
- `packages/epic-core` owns shared runner logic.
- `packages/shared` has explicit exports. `.repos` is read-only reference code.

## EpicRunner paths and facts

- `ParallelEpicLoop.ts` drives scheduling and `workerSupervision.ts`.
- `workerSupervision.ts` drives the pure `workerLiveness.ts` machine.
- `MergeQueue.ts` owns trial merges and gates.
- `apps/server/src/runner/Layers/EpicRunner.ts` owns lifecycle and restart recovery.
- `EpicRunnerLaunch.ts` owns preflight, the lease, and run creation.
  `EpicRunnerLifecycle.ts` owns pause, resume, cancel, and the worker cap.
- `EpicRunnerPoolPorts.ts` adapts server ports.
- Provisioning is per surface. Mirror every change between
  `EpicRunnerPoolPorts.ensureIntegrationWorkspace` and
  `TerminalPoolWorkspace.ensureIntegration`. The drain is shared instead: both
  surfaces call `drainMergeQueue` (`adapters/TerminalMergeDrain.ts:20`), so a drain
  change lands once.
- `apps/server/src/orchestration/ThreadSettleWatch.ts` watches owned turns and final messages.
- `packages/epic-core/src/EpicRunPreflight.ts` gates both launch and resume. Its
  `blockerPolicy` branches on `mode` and `intent`; it moved out of `apps/server/src/beads`.
- `packages/epic-core/src/adapters/NodeEpicRunLock.ts` owns the run lock. It shares
  its file format with `skills/ralph/run.sh`.
- `packages/epic-core/src/workerScope.ts` puts workers in `cook-epic.slice`, so they
  survive a service restart.
- Restart recovery continues each interrupted iteration in its own row. A row
  resumes when it names a child, its worktree survived, and its `resume_count` is
  under the cap; the rest are abandoned by index. A resume re-runs preflight in
  resume mode, which forgives only that run's own integration branch and
  worktrees, and stops only that run's own leftover worker scopes. A lost lease
  pauses the run, abandons its in-flight rows, and releases its claimed children.
  A refused resume hands the worktree and the claim to a fresh pinned iteration
  and scores an `infra:resume-*` reason.
- Client turn ingress does not block threads owned by an EpicRunner run.
- A run resolves one model selection at launch, most specific first: the launch
  input (`inheritOriginModelSelection`), then `provider.modelSelection` in
  `.t3code/epic-run.json`, then the project default. Inheriting never falls back
  to the default; it fails with `origin_thread_required`,
  `origin_thread_not_found`, or `origin_thread_project_mismatch`.
- The `EpicRunLaunchError` reason list is duplicated in
  `packages/epic-core/src/Errors.ts` and `packages/contracts/src/epicRuns.ts`.
  Adding a reason to one only makes `apps/server/src/ws.ts` fail typecheck.
- Forward provider fallback is Prime → Claude → Codex → Kimi
  (`packages/epic-core/src/providerFallback.ts`). Prime is a source only.
- Verification is by effects: Beads status plus commits, or a new bead comment
  for a `Research:` child. A worker's final message is never evidence.

Never install dependencies or run `skills/install.sh` inside an epic worktree.
Its linked `node_modules` can damage the source checkout.

Do not infer file conflicts from issue prose. Beads must confirm no open child
before run completion. Provider fallback uses structured evidence only.

### Test harnesses

- `packages/epic-core/src/MergeQueue.test.ts` builds ports with `makeHarness` and
  asserts one exact ordered `calls` array per test. A new drain-time git call breaks
  many tests at once. Extend the fake and the expected array. Never delete entries to
  make a test pass.
- `packages/epic-core/src/ParallelEpicLoop.test.ts` builds a run with `fixture()`,
  stubs `continueTurn` and `nudge` on each iteration handle, and moves time with
  `TestClock.adjust`. A new required `IterationHandle` or `MergeDrainShape` member
  means every stub in this file needs it.
- `apps/server/src/runner/Layers/EpicRunner.test.ts` builds the server with
  `createHarness` and asserts on the recorded `processRequests` argv, so a changed
  git or `bd` command line shows up as a failing argv assertion.

### Merge conflicts

- The conflict radar finds a conflict before the merge queue does.
  `runParallelEpicLoop` forks a probe fiber on `PoolPolicy.conflictProbeIntervalMs`
  (`DEFAULT_CONFLICT_PROBE_INTERVAL_MS` is 3 min in `runPolicy.ts`; `0` disables it,
  and sequential runs never arm it). `runIteration` reports each started turn through
  the `onTurnBegan` hook, and the loop arms it: an in-place or integration-fix
  iteration is never armed, and a handle whose continuation is not `same-thread` is
  armed but ineligible. The tick resolves the base through the never-failing
  `MergeDrainShape.integrationTarget`, probes once per `<baseHead>:<branchHead>`, and
  speaks through the never-failing `IterationHandle.nudge`. It sends at most two
  nudges per iteration.
- `IterationHandle.nudge` answers `sent`, `skipped`, or `unsupported`. The terminal
  adapter always answers `unsupported`. Never nudge with raw `continueTurn`: the
  terminal adapter refuses it mid-turn, and the server opens a stray turn on Kimi,
  Grok, and Cursor. Never send a nudge with `delivery: "turn-boundary"`, which parks
  it until turn end and returns it as an unsupervised stray turn.
- The probe itself is `PoolVcsShape.mergeTreeConflicts` in `ProcessPoolVcs.ts`. It
  runs `git merge-tree --write-tree <base> <branch>`, so it reads objects only, with
  no worktree, no index, and no trial commit. `[]` is a clean merge, exit 1 yields the
  conflicted paths, and every other exit is `null`.
- The drain batches. It measures each entry's file footprint with
  `MergeGitShape.changedFiles`, groups consecutive entries with pairwise disjoint
  footprints, and runs one gate per group. A red batch halves instead of falling back
  to single entries. An unmeasurable footprint (`null`) goes through alone. A queue
  below two entries is never measured, which is what keeps the `MergeQueue.test.ts`
  ordered `calls` arrays unchanged.
- A parked entry carries evidence. The drain reads `MergeGitShape.conflictDetail`
  BEFORE `abortMerge`, and `policy.conflictFailureDetail` composes the repo path,
  merge output, unmerged files, and bounded hunks. `mergeFixDescription` heads it
  "What the conflict looked like:" and indents it, so the gate-failed one-liner stays
  byte-identical.
- A merge-fix child gets its author's context. `reconcileParkedEntry` builds
  `originalContext` and `landedContext` for `mergeFixDescription` on the create path
  only, from `MergeQueuePorts.iterations` and the never-failing
  `MergeGitShape.landedSubjects`. Every failure collapses to no section, and a reused
  fix child spends no reads. `landedSubjects` reads the MAIN repo's
  `<branch>..<baseBranch>` only, so a sibling-only branch gets no landed list.
- git rerere replays a resolution the run already recorded. Integration provisioning
  turns it on in the run repository and each sibling canonical path, on both surfaces
  and never-failing (`rerere.ts:RERERE_CONFIG_ARGS`), and `trialMerge` carries the
  same settings as `-c` flags. `git merge` still exits non-zero on a conflict rerere
  fully staged, so both merge-git adapters COMPLETE such a merge with
  `RERERE_COMMIT_ARGS` (`git commit --no-verify --no-edit --cleanup=strip`) and report
  it clean. `--cleanup=strip` is load bearing: without it git leaves its `# Conflicts:`
  block in the subject, the merge stops matching `trialMergeMessage`, and
  `landedSubjects` stops parsing.

## Durable state and boot order

- The live database is `~/.t3/userdata/state.sqlite`. Read-only `sqlite3` selects
  against `epic_runs`, `epic_run_iterations`, `epic_run_merge_state`,
  `epic_run_merge_entries`, `epic_run_gate_receipts`, and
  `provider_session_runtime` are the fastest way to check a real run.
- `epic_run_gate_receipts` holds one append-only row per gate run: input heads,
  command digest, outcome, exit code, lock wait, execution time, and bounded
  output. Nothing updates a row, and `outcome = 'passed'` requires exit code 0.
  `epic_run_iterations.phase_timings` separates the provider turn from the
  runner's own time; the pool loop's gate time lives in the receipts, not there.
- Migrations are statically imported into `migrationEntries` in
  `apps/server/src/persistence/Migrations.ts` and run at boot. Tests step the
  schema with `runMigrations({ toMigrationInclusive: N })`.
- `startBootReactors` in `apps/server/src/serverRuntimeStartup.ts` runs the
  orchestration reactors, then the reaper's synchronous boot pass, then
  `EpicRunner.start()`. That order is load bearing.

## Epic run gotchas

- The run PubSub fans out only from `publishRunChange` in
  `EpicRunnerPoolPorts.ts`, so a journal-only iteration write stays invisible to
  clients until the next run-row save.
- `EpicWorkerScopeRegistry` in `apps/server/src/provider/workerScope.ts` is
  in-memory, so a session resumed after a restart spawns outside its systemd scope.
- The epic-run UI lives in `apps/web/src/routes/_chat.epics.$environmentId.$epicId.tsx`,
  `apps/web/src/epicRun.logic.ts`, and `apps/web/src/epicRunPreflightPresentation.ts`.
  `groupEpicRunIterationThreads` in `apps/web/src/components/Sidebar.logic.ts`
  folds a run's iteration threads by parsing the thread id.

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

`apps/server/src/provider/builtInDrivers.ts` is the whole shipped driver set:
`codex`, `claudeAgent`, `cursor`, `grok`, `kimi`, `opencode`, `primeAgent`.
An instance id is the routing identity; a driver kind is not.

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
All three adapter tests use the ACP mid-turn conformance suite.

The Claude capability probe is in `apps/server/src/provider/Layers/ClaudeProvider.ts`.
`apps/server/src/provider/Drivers/ClaudeDriver.ts` caches it for five minutes.
The probe uses a never-yielding prompt, so it sends no user message.

Treat new SDK controls as optional. Check, catch, time out, and handle no result.

An instance's `homePath` becomes `CLAUDE_CONFIG_DIR`. A session only resumes
inside the config directory that created it.

### Prime

- Prime uses its own RPC mode, not shared ACP. Transport, events, launch-arg
  guard, and permission extension live in `apps/server/src/provider/prime/`.
  `Layers/PrimeAdapter.ts`, `Layers/PrimeProvider.ts`, and
  `Drivers/PrimeDriver.ts` hold the session, probe, and driver seams.
- T3 Code owns these Prime flags: `--mode`, `--session`, `--session-id`,
  `--session-dir`, `--fork`, `--continue`, `--resume`, `--no-session`,
  `--provider`, `--model`, `--thinking`, `--extension` / `-e`,
  `--no-extensions`. A user launch arg matching one turns the card red.
- The resume cursor is `{ schemaVersion: 1, sessionId, ownerThreadId }`. The
  owning thread reopens with `--session`; any other thread forks with
  `--fork <id> --session-id <new>`.
- Sessions live in `<stateDir>/prime/<instanceId>` at mode `0700`, unless the
  instance sets `sessionRoot`.
- `prime/extensions/t3-permission-extension.mjs` is fail-closed and only guards
  `ipython`, `python`, and `python_cell`. The runtime mode reaches it as
  `T3_PRIME_RUNTIME_MODE`.
- `apps/server/scripts/prime-rpc-mock.ts` is the fake CLI. Select behavior with
  `T3_PRIME_RPC_SCENARIO` (`health-ready`, `health-unauthenticated`,
  `health-no-models`, `version-timeout`, `malformed`, `eof`, `exit`, `adapter*`,
  `text*`). Never require a real Prime binary, credentials, or network in tests.
- Prime is not installed on the dev host. Verify Prime UI by pointing an
  instance's `binaryPath` at a shell wrapper that execs the mock.
- `ProviderCommandReactor.ts` rewrites `/name` and `$name` to `/skill:<name>`
  for Prime, but only when the provider reports that skill. Otherwise the
  workspace skill body expands inline. `skills/install.sh` links the canonical
  skills into `${PRIME_SKILLS_DIR:-~/.prime/skills}`.
- Prime reports no skills over RPC, so `prime/PrimeSkills.ts` reads that same
  directory and `PrimeProvider.ts` puts the result in the snapshot. Its
  resolution mirrors `skills/install.sh`: `PRIME_SKILLS_DIR`, then
  `$PRIME_HOME/skills`, then `~/.prime/skills`.
- User-facing setup, diagnostics, and troubleshooting: `docs/providers/prime.md`.

## Provider session lifecycle

- `apps/server/src/provider/Services/ProviderAdapter.ts` declares
  `sessionLifecycle.resume`. All seven adapters declare `"cursor"`.
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` starts and
  restarts sessions.
- `apps/server/src/provider/Layers/ProviderService.ts` falls back to the
  persisted resume cursor, but inherits it only when the provider instance id
  matches. `describeSessionResume` reports the verdict without starting anything.
- `apps/server/src/provider/Services/ProviderSessionDirectory.ts` and
  `apps/server/src/persistence/ProviderSessionRuntime.ts` hold the persisted
  binding and the cursor. The payload merges, so an absent key keeps the old value.
- `apps/server/src/provider/Layers/ProviderSessionReaper.ts` reconciles dead
  bindings at boot, before the runner. Its stop keeps the cursor.
- `apps/server/src/provider/ProviderDriver.ts` defines
  `ProviderContinuationIdentity`, now persisted with the binding.
- The `provider.session.recovered` analytics event goes to PostHog only. It
  writes nothing under `~/.t3/userdata/logs`. Use `epic.runner.restart-resume`
  and `epic.runner.resume-outcome` in `boot-service.log` instead.

## Settings

Deep merge cannot delete keys. Use `ATOMIC_SETTINGS_KEYS`; follow `providerInstances`.

## Local service

The service is `t3code.service`. Build before restart. Check with
`stat -c %y apps/server/dist/bin.mjs` against `git log -1 --format=%cI`; the
deployed binary has been hours behind HEAD twice. Logs are in
`~/.t3/userdata/logs/boot-service.log`.

`systemctl --user restart t3code.service` does not stop live epic workers. They
run in `cook-epic.slice`, outside the service cgroup. The next boot resume stops
the scope units belonging to the runs it resumes.
