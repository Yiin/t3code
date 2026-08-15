// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  EpicRunId,
  EventId,
  ProjectId,
  PROVIDER_SESSION_RESUME_SETTLED_ACTIVITY_KIND,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { layer as preflightLive } from "@t3tools/epic-core/EpicRunPreflight";
import * as EpicRunConfigSource from "@t3tools/epic-core/EpicRunConfigSource";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationDispatchError } from "../src/orchestration/Errors.ts";
import {
  EpicRunStore,
  type EpicRun,
  type EpicRunIteration,
} from "../src/persistence/Services/EpicRuns.ts";
import * as ProcessRunner from "@t3tools/epic-core/processRunner";
import { ServerConfig } from "../src/config.ts";
import { ProjectSetupScriptRunner } from "../src/project/ProjectSetupScriptRunner.ts";
import { WorktreeProvisioner } from "../src/vcs/WorktreeProvisioner.ts";
import * as GitVcsDriver from "../src/vcs/GitVcsDriver.ts";
import * as lockLive from "@t3tools/epic-core/adapters/NodeEpicRunLock";
import { makeEpicRunnerLive } from "../src/runner/Layers/EpicRunner.ts";
import { EpicRunner } from "../src/runner/Services/EpicRunner.ts";
import { makeProviderRegistryLayer } from "../src/provider/testUtils/providerRegistryMock.ts";
import { EpicSubagentRegistry } from "../src/provider/epicSubagents.ts";
import { EpicCommitterRegistry } from "../src/provider/epicCommitter.ts";
import { EpicWorkerScopeRegistry } from "../src/provider/workerScope.ts";
import { makeMemoryStore, makeThreadDetail } from "./EpicRunnerHarness.integration.ts";

const projectId = ProjectId.make("project-real-epic-runner");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;
const NOW = "2026-01-01T00:00:00.000Z";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();

interface Fixture {
  readonly root: string;
  readonly cwd: string;
  readonly bin: string;
  readonly state: string;
  readonly initialHead: string;
}

const makeFixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-epic-runner-live-"));
    const cwd = NodePath.join(root, "repo");
    const bin = NodePath.join(root, "bin");
    const state = NodePath.join(root, "state");
    await Promise.all([NodeFSP.mkdir(cwd), NodeFSP.mkdir(bin), NodeFSP.mkdir(state)]);
    git(cwd, ["init", "-q", "-b", "main"]);
    git(cwd, ["config", "user.name", "Epic integration"]);
    git(cwd, ["config", "user.email", "epic@example.invalid"]);
    await NodeFSP.writeFile(NodePath.join(cwd, "base.txt"), "base\n");
    git(cwd, ["add", "base.txt"]);
    git(cwd, ["commit", "-qm", "base"]);
    await NodeFSP.mkdir(NodePath.join(cwd, ".beads"));
    await NodeFSP.mkdir(NodePath.join(cwd, ".t3code"));
    await NodeFSP.writeFile(
      NodePath.join(cwd, ".t3code", "epic-run.json"),
      '{"execution":{"sequential":true}}\n',
    );
    git(cwd, ["add", ".t3code/epic-run.json"]);
    git(cwd, ["commit", "-qm", "configure sequential epic test"]);
    await NodeFSP.writeFile(NodePath.join(state, "status"), "open");
    await NodeFSP.writeFile(NodePath.join(state, "comments"), "0");
    await NodeFSP.writeFile(NodePath.join(state, "invocations"), "");
    const shim = `#!/usr/bin/env bash
set -euo pipefail
state=\${EPIC_TEST_STATE:?}; cmd=\${1:-}; shift || true
status=$(<"$state/status"); comments=$(<"$state/comments")
{
  printf '%q' "$cmd"
  for arg in "$@"; do printf ' %q' "$arg"; done
  printf '\\n'
} >> "$state/invocations"
case "$cmd" in
  show)
    [ "$#" -eq 2 ] && [ "$2" = --json ] || { echo "unsupported bd argv: show $*" >&2; exit 64; }
    if [ "$1" = epic-1 ]; then printf '[{"id":"epic-1","issue_type":"epic","description":"Integration epic"}]\\n'
    elif [ "$1" = child-1 ]; then printf '[{"id":"child-1","status":"%s","title":"Integration child","comment_count":%s}]\\n' "$status" "$comments"
    else echo "unsupported bd issue: $1" >&2; exit 64; fi ;;
  ready)
    [ "$#" -eq 3 ] && [ "$1" = --parent ] && [ "$2" = epic-1 ] && [ "$3" = --json ] || { echo "unsupported bd argv: ready $*" >&2; exit 64; }
    [ "$status" = open ] && printf '[{"id":"child-1","parent":"epic-1"}]\\n' || printf '[]\\n' ;;
  list)
    { [ "$#" -eq 3 ] && [ "$1" = --parent ] && [ "$2" = epic-1 ] && [ "$3" = --json ]; } ||
    { [ "$#" -eq 5 ] && [ "$1" = --parent ] && [ "$2" = epic-1 ] && [ "$3" = --all ] && [ "$4" = --flat ] && [ "$5" = --json ]; } ||
    { echo "unsupported bd argv: list $*" >&2; exit 64; }
    printf '[{"id":"child-1","status":"%s","parent":"epic-1"}]\\n' "$status" ;;
  label)
    [ "$#" -eq 2 ] && [ "$1" = list ] && [ "$2" = child-1 ] || { echo "unsupported bd argv: label $*" >&2; exit 64; } ;;
  merge-slot)
    [ "$#" -eq 2 ] && [ "$1" = check ] && [ "$2" = --json ] || { echo "unsupported bd argv: merge-slot $*" >&2; exit 64; }
    printf '{"available":true,"holder":null}\\n' ;;
  update)
    if [ "$#" -eq 5 ] && [ "$1" = child-1 ] && [ "$2" = --status ] && [ "$3" = open ] && [ "$4" = --assignee ] && [ -z "$5" ]; then
      printf open > "$state/status"
    elif [ "$#" -eq 3 ] && [ "$1" = child-1 ] && [ "$2" = --status ] && [ "$3" = in_progress ]; then
      printf in_progress > "$state/status"
    else echo "unsupported bd argv: update $*" >&2; exit 64; fi ;;
  *) echo "unsupported bd argv: $cmd $*" >&2; exit 64 ;;
esac
`;
    await NodeFSP.writeFile(NodePath.join(bin, "bd"), shim, { mode: 0o755 });
    return {
      root,
      cwd,
      bin,
      state,
      initialHead: git(cwd, ["rev-parse", "HEAD"]),
    } satisfies Fixture;
  }),
  ({ root }) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);

const waitFor = <A>(read: () => A, predicate: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const value = read();
      if (predicate(value)) return value;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die("timed out waiting for EpicRunner");
  });

const readBdInvocations = (fixture: Fixture): ReadonlyArray<string> =>
  NodeFS.readFileSync(NodePath.join(fixture.state, "invocations"), "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);

const makeHarness = (fixture: Fixture, mode: "commit" | "no-commit") => {
  const store = makeMemoryStore();
  const details = new Map<string, OrchestrationThread>();
  const shells = new Map<string, "running" | "completed">();
  const commands: OrchestrationCommand[] = [];
  let sequence = 0;

  const settleTurn = (threadId: ThreadId) =>
    Effect.gen(function* () {
      shells.set(threadId, "running");
      yield* Effect.sleep("10 millis");
      if (mode === "commit") {
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(fixture.cwd, "landed.txt"), "landed\n"),
        );
        git(fixture.cwd, ["add", "landed.txt"]);
        git(fixture.cwd, ["commit", "-qm", "land child"]);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(fixture.state, "comments"), "1"),
        );
      }
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(fixture.state, "status"), "closed"),
      );
      details.set(
        threadId,
        makeThreadDetail({
          threadId,
          turnId: TurnId.make(`${threadId}-turn`),
          turnState: "completed",
          text: 'RALPH_MSG: {"summary":"completed integration child","why":"the runner exercised real process boundaries"}',
          streaming: false,
          sessionStatus: "ready",
        }),
      );
      shells.set(threadId, "completed");
    });

  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    readEvents: () => Stream.empty,
    latestSequence: Effect.sync(() => sequence),
    streamDomainEvents: Stream.never,
    dispatch: (
      command: OrchestrationCommand,
    ): Effect.Effect<{ sequence: number }, OrchestrationDispatchError> =>
      Effect.gen(function* () {
        commands.push(command);
        // The real reactor answers a resume long after `dispatch` returns, by
        // appending a durable activity to the thread. Mirror that: the runner
        // polls the detail snapshot for it, so it has to be findable there.
        if (command.type === "thread.session.resume") {
          const base =
            details.get(command.threadId) ??
            makeThreadDetail({
              threadId: command.threadId,
              turnId: TurnId.make(`${command.threadId}-turn-interrupted`),
              turnState: "completed",
              text: null,
              streaming: false,
              latestTurnPointerNull: true,
              sessionStatus: "stopped",
            });
          details.set(command.threadId, {
            ...base,
            activities: [
              ...base.activities,
              {
                id: EventId.make(`${command.threadId}-resume-settled`),
                tone: "info",
                kind: PROVIDER_SESSION_RESUME_SETTLED_ACTIVITY_KIND,
                summary: "resume settled",
                payload: {
                  threadId: command.threadId,
                  requestCommandId: command.commandId,
                  outcome: { _tag: "resumed" as const },
                },
                turnId: null,
                createdAt: NOW,
              },
            ],
          });
        }
        if (command.type === "thread.turn.start")
          yield* Effect.forkDetach(settleTurn(command.threadId));
        sequence += 1;
        return { sequence };
      }),
  });

  const snapshotLayer = Layer.succeed(ProjectionSnapshotQuery, {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: sequence }),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: (id) =>
      Effect.succeed(
        Option.some({
          id,
          title: "Epic project",
          workspaceRoot: fixture.cwd,
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    listChildThreadIds: () => Effect.die("unused"),
    listRunningThreadBackedSubagents: () => Effect.die("unused"),
    listThreadIdsWithQueuedMessages: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    listSubagentTurnContributions: () => Effect.succeed([]),
    getThreadShellById: (threadId) =>
      Effect.sync(() => {
        const state = shells.get(threadId);
        if (state === undefined) return Option.none();
        return Option.some({
          id: threadId,
          projectId,
          title: "Epic iteration",
          modelSelection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: TurnId.make(`${threadId}-turn`),
            state,
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: state === "running" ? null : NOW,
            assistantMessageId: details.get(threadId)?.latestTurn?.assistantMessageId ?? null,
          },
          createdAt: NOW,
          updatedAt: NOW,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: {
            threadId,
            status: state === "running" ? ("running" as const) : ("ready" as const),
            providerName: "codex",
            runtimeMode: "full-access" as const,
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
          latestUserMessageAt: NOW,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          activeSubagentCount: 0,
          parentThreadId: null,
        });
      }),
    getThreadSessionById: () => Effect.succeed(Option.none()),
    getThreadSubagentLiveness: () =>
      Effect.succeed({ activeSubagentCount: 0, newestRunningUpdatedAt: null }),
    getSubagentActivities: () =>
      Effect.succeed({ activities: [], hasMore: false, nextBefore: null }),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: (threadId) =>
      Effect.sync(() => {
        const value = details.get(threadId);
        return value === undefined
          ? Option.none()
          : Option.some({ snapshotSequence: sequence, thread: value });
      }),
  });

  const processLayer = ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer));
  const preflightLayer = preflightLive.pipe(
    Layer.provide(processLayer),
    Layer.provide(lockLive.layer),
    Layer.provide(EpicRunConfigSource.layer.pipe(Layer.provide(NodeServices.layer))),
  );
  const layer = makeEpicRunnerLive({
    pollIntervalMs: 5,
    quietPeriodMs: 5,
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 10,
    iterationTimeoutMs: 2_000,
    maxNoCommitStreak: 1,
  }).pipe(
    Layer.provide(preflightLayer),
    Layer.provide(EpicRunConfigSource.layer.pipe(Layer.provide(NodeServices.layer))),
    Layer.provide(lockLive.layer),
    Layer.provide(EpicWorkerScopeRegistry.layer),
    Layer.provide(EpicSubagentRegistry.layer),
    Layer.provide(EpicCommitterRegistry.layer),
    Layer.provide(engineLayer),
    Layer.provide(snapshotLayer),
    Layer.provide(processLayer),
    Layer.provide(GitVcsDriver.layer.pipe(Layer.provide(NodeServices.layer))),
    Layer.provide(
      Layer.succeed(WorktreeProvisioner, {
        provision: () => Effect.die("sequential integration run must not provision"),
        release: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectSetupScriptRunner, {
        runForThread: () => Effect.die("sequential integration run must not run setup"),
      }),
    ),
    Layer.provide(
      Layer.succeed(ServerConfig, {
        worktreesDir: NodePath.join(fixture.root, "worktrees"),
      } as ServerConfig["Service"]),
    ),
    Layer.provide(makeProviderRegistryLayer()),
    Layer.provide(Layer.succeed(EpicRunStore, store.shape)),
    Layer.provide(NodeServices.layer),
  );
  return { store, layer, commands };
};

const withPath = <A, E, R>(fixture: Fixture, effect: Effect.Effect<A, E, R>) => {
  const oldPath = process.env.PATH;
  const oldState = process.env.EPIC_TEST_STATE;
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      process.env.PATH = `${fixture.bin}:${oldPath ?? ""}`;
      process.env.EPIC_TEST_STATE = fixture.state;
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        process.env.PATH = oldPath;
        if (oldState === undefined) delete process.env.EPIC_TEST_STATE;
        else process.env.EPIC_TEST_STATE = oldState;
      }),
  );
};

const start = (cwd: string) =>
  Effect.flatMap(EpicRunner, (runner) =>
    runner.startRun({
      epicId: "epic-1",
      projectId,
      cwd,
      prompt: "cook one child",
      orientationFile: null,
      modelSelection,
      maxIterations: 2,
    }),
  );

const preflightBdInvocations = [
  "show epic-1 --json",
  "ready --parent epic-1 --json",
  "list --parent epic-1 --json",
] as const;

/**
 * A resumed iteration's own reads. It differs from a fresh one twice: the
 * claim is re-taken (`--status in_progress`) because the interrupted run's
 * finalizer may have reopened the child, and no `bd ready` precedes it — the
 * boot path hands the worker in, so the frontier is never consulted for it.
 */
const resumedIterationBdInvocations = [
  "show child-1 --json",
  "show child-1 --json",
  "update child-1 --status in_progress",
  "show epic-1 --json",
  "label list child-1",
  "show child-1 --json",
] as const;

const iterationBdInvocations = [
  "ready --parent epic-1 --json",
  "show child-1 --json",
  "show epic-1 --json",
  "label list child-1",
  "show child-1 --json",
] as const;

/** The run a `systemctl --user restart` interrupted, read back at boot. */
const RESUMED_RUN_ID = EpicRunId.make("run-integration-restart");
const RESUMED_THREAD_ID = ThreadId.make(`epic-run-${RESUMED_RUN_ID}-0`);

const interruptedRun = (cwd: string): EpicRun => ({
  runId: RESUMED_RUN_ID,
  epicId: "epic-1",
  projectId,
  cwd,
  prompt: "cook one child",
  orientationFile: null,
  modelSelection,
  runtimeMode: "full-access",
  config: {
    ...DEFAULT_EPIC_RUN_CONFIG,
    execution: { sequential: true },
    parallel: { ...DEFAULT_EPIC_RUN_CONFIG.parallel, workers: 1 },
  },
  configProvenance: { ...DEFAULT_EPIC_RUN_CONFIG_PROVENANCE, "execution.sequential": "file" },
  originThreadId: null,
  status: "running",
  maxIterations: 2,
  workers: 1,
  iterationsDispatched: 1,
  iterationsCompleted: 0,
  currentThreadId: RESUMED_THREAD_ID,
  currentTurnStartedAt: NOW,
  consecutiveFailures: 0,
  noCommitStreak: 0,
  infraStreak: 0,
  lastError: null,
  createdAt: NOW,
  updatedAt: NOW,
});

/** The write-ahead row the dead worker left behind: still `running`, no verdict. */
const interruptedRow = (): EpicRunIteration => ({
  runId: RESUMED_RUN_ID,
  iterationIndex: 0,
  threadId: RESUMED_THREAD_ID,
  issueId: "child-1",
  workerId: RESUMED_THREAD_ID,
  branch: null,
  worktreePath: null,
  turnStatus: "running",
  summary: null,
  why: null,
  failureReason: null,
  resumeCount: 0,
  startedAt: NOW,
  finishedAt: null,
});

describe("EpicRunner real process boundaries", () => {
  it.live("completes one full happy iteration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const harness = makeHarness(fixture, "commit");
        yield* withPath(
          fixture,
          Effect.gen(function* () {
            const run = yield* start(fixture.cwd);
            yield* waitFor(
              () => harness.store.runs.get(run.runId)?.status,
              (status) => status === "done",
            );
            yield* waitFor(
              () => NodeFS.existsSync(NodePath.join(fixture.cwd, ".beads/run-lock.epic-1.json")),
              (exists) => !exists,
            );
            yield* waitFor(
              () => readBdInvocations(fixture).length,
              (count) => count >= preflightBdInvocations.length + iterationBdInvocations.length + 3,
            );
          }).pipe(Effect.provide(harness.layer)),
        );
        assert.notEqual(git(fixture.cwd, ["rev-parse", "HEAD"]), fixture.initialHead);
        assert.equal(harness.store.iterations[0]?.turnStatus, "completed");
        assert.deepEqual(readBdInvocations(fixture), [
          ...preflightBdInvocations,
          ...iterationBdInvocations,
          "ready --parent epic-1 --json",
          "list --parent epic-1 --all --flat --json",
          "show child-1 --json",
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("blocks a genuinely dirty tree during preflight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(fixture.cwd, "base.txt"), "dirty\n"),
        );
        const harness = makeHarness(fixture, "commit");
        const exit = yield* withPath(
          fixture,
          Effect.exit(start(fixture.cwd).pipe(Effect.provide(harness.layer))),
        );
        assert.isTrue(exit._tag === "Failure");
        assert.equal(harness.store.runs.size, 0);
        assert.deepEqual(readBdInvocations(fixture), preflightBdInvocations);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  // The launch path above proves real dirt blocks. This proves the boot path
  // resumes THROUGH it: same repo, same preflight, same lock, but the dirt is
  // the run's own dead worker's, so a resume continues rather than parks.
  it.live("resumes a running run at boot through a real dirty tree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        // What the killed worker left uncommitted in the checkout it owned.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(fixture.cwd, "scratch.txt"), "half-done\n"),
        );
        const harness = makeHarness(fixture, "commit");
        harness.store.runs.set(RESUMED_RUN_ID, interruptedRun(fixture.cwd));
        harness.store.iterations.push(interruptedRow());
        const observedStatuses = new Set<string>();
        yield* withPath(
          fixture,
          Effect.gen(function* () {
            const runner = yield* EpicRunner;
            yield* runner.start();
            yield* waitFor(
              () => {
                const status = harness.store.runs.get(RESUMED_RUN_ID)?.status;
                if (status !== undefined) observedStatuses.add(status);
                return status;
              },
              (status) => status === "done",
            );
            yield* waitFor(
              () => NodeFS.existsSync(NodePath.join(fixture.cwd, ".beads/run-lock.epic-1.json")),
              (exists) => !exists,
            );
          }).pipe(Effect.provide(harness.layer)),
        );

        const run = harness.store.runs.get(RESUMED_RUN_ID)!;
        assert.isFalse(observedStatuses.has("failed"));
        assert.isFalse(observedStatuses.has("paused"));
        assert.isNull(run.lastError);
        // The resumed agent committed, so the real HEAD moved.
        assert.notEqual(git(fixture.cwd, ["rev-parse", "HEAD"]), fixture.initialHead);
        // One row across two process lifetimes, reused rather than appended to.
        assert.lengthOf(harness.store.iterations, 1);
        assert.equal(harness.store.iterations[0]?.turnStatus, "completed");
        assert.equal(harness.store.iterations[0]?.resumeCount, 1);
        assert.equal(run.iterationsDispatched, 1);
        // The thread the dead worker owned is the one that carried on.
        assert.deepEqual(
          harness.commands
            .filter((command) => command.type === "thread.session.resume")
            .map((command) => command.threadId),
          [RESUMED_THREAD_ID],
        );
        assert.lengthOf(
          harness.commands.filter((command) => command.type === "thread.create"),
          0,
        );
        const invocations = readBdInvocations(fixture);
        // The precise signal that the resume kept its claim: it re-took the
        // child and never handed it back to the pool.
        assert.include(invocations, "update child-1 --status in_progress");
        assert.deepEqual(
          invocations.filter((line) => line.startsWith("update child-1 --status open")),
          [],
        );
        assert.deepEqual(invocations, [
          ...preflightBdInvocations,
          // Boot only: a slot the dead run leaked would defer every drain.
          "merge-slot check --json",
          ...resumedIterationBdInvocations,
          "ready --parent epic-1 --json",
          "list --parent epic-1 --all --flat --json",
          "show child-1 --json",
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("classifies no-commit work against the unchanged real HEAD", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const harness = makeHarness(fixture, "no-commit");
        yield* withPath(
          fixture,
          Effect.gen(function* () {
            const run = yield* start(fixture.cwd);
            yield* waitFor(
              () => harness.store.runs.get(run.runId)?.status,
              (status) => status === "failed",
            );
            yield* waitFor(
              () => NodeFS.existsSync(NodePath.join(fixture.cwd, ".beads/run-lock.epic-1.json")),
              (exists) => !exists,
            );
            yield* waitFor(
              () => readBdInvocations(fixture).length,
              (count) => count >= preflightBdInvocations.length + iterationBdInvocations.length + 2,
            );
          }).pipe(Effect.provide(harness.layer)),
        );
        assert.equal(git(fixture.cwd, ["rev-parse", "HEAD"]), fixture.initialHead);
        assert.match(harness.store.iterations[0]?.failureReason ?? "", /no-commit/);
        assert.deepEqual(readBdInvocations(fixture), [
          ...preflightBdInvocations,
          ...iterationBdInvocations,
          "show child-1 --json",
          "show child-1 --json",
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
