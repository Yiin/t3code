import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  EpicRunPreflightError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type ProjectionThreadTurnStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { OrchestrationDispatchError } from "../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  EpicRunStore,
  type EpicRun,
  type EpicRunIteration,
  type EpicRunStoreShape,
} from "../../persistence/Services/EpicRuns.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { EpicRunPreflight } from "../../beads/EpicRunPreflight.ts";
import {
  EpicRunLock,
  EpicRunLockError,
  EpicRunLockHeldError,
  type EpicRunLockLease,
} from "../Services/EpicRunLock.ts";
import { EpicRunner } from "../Services/EpicRunner.ts";
import { makeEpicRunnerLive } from "./EpicRunner.ts";

const projectId = ProjectId.make("project-epic-runner");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;
const NOW = "2026-01-01T00:00:00.000Z";

/**
 * What a scripted iteration does when its turn is dispatched. `head` is what
 * the fake git reports *after* the iteration, so a value differing from the
 * previous one is how a test says "this iteration committed".
 */
interface ScriptedIteration {
  readonly text: string | null;
  readonly head: string;
  readonly turnState?: ProjectionThreadTurnStatus;
  readonly sessionStatus?: OrchestrationSessionStatus;
  readonly streaming?: boolean;
  /** Leave the turn hanging so the iteration has to be cancelled or time out. */
  readonly stall?: boolean;
}

const waitFor = (predicate: () => boolean) =>
  Effect.gen(function* () {
    while (!predicate()) {
      yield* Effect.sleep("5 millis");
    }
  }).pipe(Effect.timeout("4 seconds"));

/** Give already-scheduled fibers room to run, to assert that nothing else happens. */
const settle = Effect.sleep("60 millis");

const makeThreadDetail = (input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly turnState: ProjectionThreadTurnStatus;
  readonly text: string | null;
  readonly streaming: boolean;
}): OrchestrationThread => {
  const messageId = MessageId.make(`${input.threadId}-assistant`);
  return {
    id: input.threadId,
    projectId,
    title: "Epic iteration",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: input.turnId,
      state: input.turnState,
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: input.text === null ? null : messageId,
    },
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages:
      input.text === null
        ? []
        : [
            {
              id: messageId,
              role: "assistant",
              text: input.text,
              turnId: input.turnId,
              streaming: input.streaming,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
};

/**
 * In-memory `EpicRunStore`, which this issue explicitly permits: the SQLite
 * implementation has its own suite, and what matters here is the order the
 * runner writes in, not how the rows are stored.
 */
const makeMemoryStore = (upsertDelayMs = 0) => {
  const runs = new Map<string, EpicRun>();
  const iterations: EpicRunIteration[] = [];

  const shape: EpicRunStoreShape = {
    upsertRun: (run) => {
      const save = Effect.sync(() => {
        runs.set(run.runId, run);
      });
      return upsertDelayMs === 0
        ? save
        : Effect.sleep(`${upsertDelayMs} millis`).pipe(Effect.flatMap(() => save));
    },
    getRun: ({ runId }) =>
      Effect.sync(() => {
        const run = runs.get(runId);
        return run === undefined ? Option.none() : Option.some(run);
      }),
    listRuns: ({ status }) =>
      Effect.sync(() =>
        [...runs.values()].filter((run) => status === undefined || run.status === status),
      ),
    appendIteration: (iteration) =>
      Effect.sync(() => {
        iterations.push(iteration);
      }),
    updateIteration: (input) =>
      Effect.sync(() => {
        const index = iterations.findIndex(
          (iteration) =>
            iteration.runId === input.runId && iteration.iterationIndex === input.iterationIndex,
        );
        if (index === -1) {
          return;
        }
        const existing = iterations[index]!;
        iterations[index] = {
          ...existing,
          turnStatus: input.turnStatus,
          summary: input.summary,
          why: input.why,
          finishedAt: input.finishedAt,
        };
      }),
    listIterations: ({ runId }) =>
      Effect.sync(() => iterations.filter((iteration) => iteration.runId === runId)),
    getLatestIteration: ({ runId }) =>
      Effect.sync(() => {
        const forRun = iterations.filter((iteration) => iteration.runId === runId);
        return forRun.length === 0 ? Option.none() : Option.some(forRun[forRun.length - 1]!);
      }),
  };

  return { shape, runs, iterations };
};

function createHarness(input: {
  readonly script: ReadonlyArray<ScriptedIteration>;
  readonly initialHead?: string;
  readonly options?: Parameters<typeof makeEpicRunnerLive>[0];
  readonly seedRuns?: ReadonlyArray<EpicRun>;
  readonly seedIterations?: ReadonlyArray<EpicRunIteration>;
  readonly workspaceRoot?: string;
  readonly preflightResult?: {
    readonly ok: boolean;
    readonly blockers: ReadonlyArray<{ readonly _tag: "detached_head" }>;
    readonly warnings: ReadonlyArray<never>;
  };
  readonly onLockAcquire?: () => void;
  readonly onLockRelease?: () => void;
  readonly lockAcquireError?: EpicRunLockError;
  readonly preflightError?: EpicRunPreflightError;
  readonly upsertDelayMs?: number;
  readonly readyOutput?: string;
}) {
  const store = makeMemoryStore(input.upsertDelayMs);
  for (const run of input.seedRuns ?? []) {
    store.runs.set(run.runId, run);
  }
  store.iterations.push(...(input.seedIterations ?? []));

  const dispatched: OrchestrationCommand[] = [];
  const details = new Map<string, OrchestrationThread>();
  const shells = new Map<
    string,
    {
      readonly latestTurn: ProjectionThreadTurnStatus | null;
      readonly session: OrchestrationSessionStatus;
    }
  >();
  let head = input.initialHead ?? "head-0";
  let turnsStarted = 0;
  let sequence = 0;
  const processRequests: ProcessRunner.ProcessRunInput[] = [];
  const heldLocks = new Set<string>();

  /**
   * Project one scripted iteration's outcome. The thread is seen `running`
   * first and only then settles, exactly as the real projector would do it, so
   * the runner's poll cannot mistake a starting session for a finished turn.
   */
  const simulateTurn = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const scripted = input.script[turnsStarted];
      turnsStarted += 1;
      if (scripted === undefined) {
        return;
      }

      shells.set(threadId, { latestTurn: "running", session: "running" });
      if (scripted.stall === true) {
        return;
      }

      // A beat of "the turn is live" before it settles.
      yield* Effect.sleep("2 millis");

      head = scripted.head;
      details.set(
        threadId,
        makeThreadDetail({
          threadId,
          turnId: TurnId.make(`${threadId}-turn`),
          turnState: scripted.turnState ?? "completed",
          text: scripted.text,
          streaming: scripted.streaming ?? false,
        }),
      );
      shells.set(threadId, {
        latestTurn: scripted.turnState ?? "completed",
        session: scripted.sessionStatus ?? "ready",
      });
    });

  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    readEvents: () => Stream.empty,
    latestSequence: Effect.sync(() => sequence),
    streamDomainEvents: Stream.never,
    dispatch: (
      command: OrchestrationCommand,
    ): Effect.Effect<{ sequence: number }, OrchestrationDispatchError> =>
      Effect.gen(function* () {
        dispatched.push(command);
        if (command.type === "thread.turn.start") {
          // Forked so `dispatch` returns before the turn resolves, the way the
          // real engine behaves.
          yield* Effect.forkDetach(simulateTurn(command.threadId));
        }
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
          workspaceRoot: input.workspaceRoot ?? "/tmp/epic-runner-repo",
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: (threadId) =>
      Effect.sync(() => {
        const shell = shells.get(threadId);
        if (shell === undefined) {
          return Option.none();
        }
        return Option.some({
          id: threadId,
          projectId,
          title: "Epic iteration",
          modelSelection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
          worktreePath: null,
          latestTurn:
            shell.latestTurn === null
              ? null
              : {
                  turnId: TurnId.make(`${threadId}-turn`),
                  state: shell.latestTurn,
                  requestedAt: NOW,
                  startedAt: NOW,
                  completedAt: shell.latestTurn === "running" ? null : NOW,
                  assistantMessageId: details.get(threadId)?.latestTurn?.assistantMessageId ?? null,
                },
          createdAt: NOW,
          updatedAt: NOW,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: {
            threadId,
            status: shell.session,
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
        });
      }),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: (threadId) =>
      Effect.sync(() => {
        const thread = details.get(threadId);
        return thread === undefined
          ? Option.none()
          : Option.some({ snapshotSequence: sequence, thread });
      }),
  });

  const processRunnerLayer = Layer.succeed(ProcessRunner.ProcessRunner, {
    run: (request: ProcessRunner.ProcessRunInput) =>
      Effect.sync(() => {
        processRequests.push(request);
        return {
          stdout:
            request.command === "bd"
              ? (input.readyOutput ?? `[{"id":"child-${turnsStarted + 1}","parent":"epic-1"}]`)
              : `${head}\n`,
          stderr: "",
          code: 0 as never,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
    runStreaming: () => Effect.die("unused"),
  } as never);

  const layer = makeEpicRunnerLive({
    pollIntervalMs: 5,
    quietPeriodMs: 5,
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 10,
    iterationTimeoutMs: 500,
    ...input.options,
  }).pipe(
    Layer.provide(
      Layer.succeed(EpicRunPreflight, {
        check: () =>
          input.preflightError === undefined
            ? Effect.succeed(input.preflightResult ?? { ok: true, blockers: [], warnings: [] })
            : Effect.fail(input.preflightError),
      }),
    ),
    Layer.provide(
      Layer.succeed(EpicRunLock, {
        // @effect-diagnostics-next-line effectSucceedWithVoid:off
        inspect: () => Effect.succeed(undefined),
        acquire: (
          lockInput,
        ): Effect.Effect<EpicRunLockLease, EpicRunLockError | EpicRunLockHeldError> =>
          Effect.suspend<EpicRunLockLease, EpicRunLockError | EpicRunLockHeldError, never>(() => {
            if (input.lockAcquireError !== undefined) {
              return Effect.fail(input.lockAcquireError);
            }
            const path = `/tmp/${lockInput.epicId}`;
            if (heldLocks.has(path)) {
              return Effect.fail(new EpicRunLockHeldError(path, undefined));
            }
            heldLocks.add(path);
            input.onLockAcquire?.();
            return Effect.succeed({
              path,
              owner: {
                owner: "t3code",
                host: "test",
                pid: process.pid,
                pgid: process.pid,
                runDir: lockInput.runDir,
                startedAt: NOW,
                heartbeatAt: 0,
              },
              heartbeat: Effect.succeed(true),
              release: Effect.sync(() => {
                heldLocks.delete(path);
                input.onLockRelease?.();
                return true;
              }),
            });
          }),
      }),
    ),
    Layer.provide(engineLayer),
    Layer.provide(snapshotLayer),
    Layer.provide(processRunnerLayer),
    Layer.provide(Layer.succeed(EpicRunStore, store.shape)),
    Layer.provide(NodeServices.layer),
  );

  return {
    layer,
    store,
    turnsStarted: () => turnsStarted,
    activeLockCount: () => heldLocks.size,
    processRequests,
    commands: dispatched,
    commandsOfType: <T extends OrchestrationCommand["type"]>(type: T) =>
      dispatched.filter(
        (command): command is Extract<OrchestrationCommand, { readonly type: T }> =>
          command.type === type,
      ),
  };
}

const startRun = (maxIterations = 10) =>
  Effect.flatMap(EpicRunner, (runner) =>
    runner.startRun({
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      modelSelection,
      maxIterations,
    }),
  );

// `it.live`, not `it.effect`: the runner polls the projection and sleeps
// between attempts, so it needs the real clock rather than a virtual one that
// only advances when a test tells it to.
describe("EpicRunner", () => {
  it.live("chooses the first direct-ready child and ignores an earlier grandchild", () => {
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      readyOutput:
        '[{"id":"grandchild","parent":"child-a"},{"id":"direct-a","parent":"epic-1"},{"id":"direct-b","parent":"epic-1"}]',
    });
    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.store.iterations[0]?.issueId, "direct-a");
      assert.match(
        harness.commandsOfType("thread.turn.start")[0]!.message.text,
        /Cook exactly `direct-a` this iteration\.$/,
      );
      const readyRequest = harness.processRequests.find((request) => request.command === "bd")!;
      assert.deepStrictEqual(readyRequest.args, ["ready", "--parent", "epic-1", "--json"]);
      assert.strictEqual(readyRequest.cwd, "/tmp/epic-runner-repo");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("treats descendants without a direct child as an empty backlog", () => {
    const harness = createHarness({
      script: [],
      readyOutput: '[{"id":"grandchild","parent":"child-a"}]',
    });
    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.store.iterations.length, 0);
      assert.strictEqual(harness.commandsOfType("thread.create").length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("finishes without dispatch when no direct child is ready", () => {
    const harness = createHarness({ script: [], readyOutput: "[]" });
    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.store.iterations.length, 0);
      assert.strictEqual(harness.commandsOfType("thread.create").length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("launches from the persisted project defaults and rejects a cwd mismatch", () => {
    const harness = createHarness({ script: [], readyOutput: "[]" });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const mismatch = yield* Effect.flip(
        runner.launchRun({ epicId: "epic-1", projectId, cwd: "/tmp/wrong" }),
      );
      assert.strictEqual(mismatch._tag, "EpicRunLaunchError");
      if (mismatch._tag === "EpicRunLaunchError") {
        assert.strictEqual(mismatch.reason, "cwd_mismatch");
      }

      const launched = yield* runner.launchRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
      });
      assert.deepStrictEqual(launched.modelSelection, modelSelection);
      assert.strictEqual(launched.runtimeMode, "full-access");
      assert.match(launched.prompt, /RALPH_MSG:/);

      for (let iterationIndex = 0; iterationIndex < 30; iterationIndex += 1) {
        harness.store.iterations.push({
          runId: launched.runId,
          iterationIndex,
          threadId: ThreadId.make(`tail-${iterationIndex}`),
          issueId: `child-${iterationIndex}`,
          turnStatus: "completed",
          summary: `summary-${iterationIndex}`,
          why: `why-${iterationIndex}`,
          startedAt: NOW,
          finishedAt: NOW,
        });
      }
      const listed = (yield* runner.listRuns()).find((run) => run.runId === launched.runId)!;
      assert.deepStrictEqual(
        listed.recentIterations.map((iteration) => iteration.iterationIndex),
        Array.from({ length: 25 }, (_, offset) => offset + 5),
      );
      assert.deepStrictEqual(
        listed.threadRefs.map((reference) => reference.iterationIndex),
        Array.from({ length: 25 }, (_, offset) => offset + 5),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("reaches completion without consuming streamRuns, stopping on RALPH_DONE", () => {
    const harness = createHarness({
      script: [
        { text: 'work\nRALPH_MSG: {"summary":"first","why":"needed"}', head: "head-1" },
        { text: "more work", head: "head-2" },
        { text: "backlog is empty\n\nRALPH_DONE", head: "head-2" },
      ],
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const finished = harness.store.runs.get(run.runId)!;
      assert.strictEqual(finished.status, "done");
      assert.strictEqual(finished.iterationsCompleted, 3);
      assert.strictEqual(finished.consecutiveFailures, 0);
      assert.strictEqual(finished.currentThreadId, null);

      // Every iteration got its own fresh thread, and the loop stopped at
      // RALPH_DONE rather than running on to maxIterations.
      const created = harness.commandsOfType("thread.create");
      assert.strictEqual(created.length, 3);
      assert.strictEqual(new Set(created.map((command) => command.threadId)).size, 3);
      assert.strictEqual(harness.turnsStarted(), 3);

      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.turnStatus),
        ["completed", "completed", "completed"],
      );
      assert.strictEqual(harness.store.iterations[0]?.summary, "first");
      assert.strictEqual(harness.store.iterations[0]?.why, "needed");
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.issueId),
        ["child-1", "child-2", "child-3"],
      );
      assert.match(
        harness.commandsOfType("thread.turn.start")[0]!.message.text,
        /Cook exactly `child-1` this iteration\.$/,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("returns the same active run for sequential duplicate starts", () => {
    const harness = createHarness({
      script: [{ text: null, head: "head-0", stall: true }],
      options: { iterationTimeoutMs: 60_000 },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const first = yield* startRun();
      yield* waitFor(() => harness.turnsStarted() === 1);
      const duplicate = yield* runner.startRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "different settings must not replace the active run",
        modelSelection: { ...modelSelection, model: "different-model" },
        maxIterations: 99,
      });

      assert.strictEqual(duplicate.runId, first.runId);
      assert.strictEqual(duplicate.prompt, first.prompt);
      assert.strictEqual(harness.store.runs.size, 1);
      assert.strictEqual(harness.commandsOfType("thread.turn.start").length, 1);
      assert.strictEqual(harness.store.iterations.length, 1);
      yield* runner.cancelRun({ runId: first.runId });
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("returns the winning run for concurrent duplicate starts", () => {
    const harness = createHarness({
      script: [{ text: null, head: "head-0", stall: true }],
      options: { iterationTimeoutMs: 60_000 },
      // The loser sees the held lock well before the winning row is visible.
      upsertDelayMs: 25,
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const [first, duplicate] = yield* Effect.all([startRun(), startRun()], {
        concurrency: "unbounded",
      });
      yield* waitFor(() => harness.turnsStarted() === 1);

      assert.strictEqual(duplicate.runId, first.runId);
      assert.strictEqual(harness.store.runs.size, 1);
      assert.strictEqual(harness.commandsOfType("thread.turn.start").length, 1);
      assert.strictEqual(harness.store.iterations.length, 1);
      yield* runner.cancelRun({ runId: first.runId });
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("preserves generic lock acquisition failures", () => {
    const harness = createHarness({
      script: [],
      lockAcquireError: new EpicRunLockError("test-generic-lock-failure"),
    });

    return Effect.gen(function* () {
      const error = yield* Effect.flip(startRun());
      assert.strictEqual(error._tag, "EpicRunPreflightBlockedError");
      if (error._tag === "EpicRunPreflightBlockedError") {
        assert.deepStrictEqual(error.blockers, [
          "Epic run lock operation failed: test-generic-lock-failure",
        ]);
      }
      assert.strictEqual(harness.store.runs.size, 0);
      assert.strictEqual(harness.turnsStarted(), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("preserves preflight check failures", () => {
    const harness = createHarness({
      script: [],
      preflightError: new EpicRunPreflightError({ message: "preflight exploded" }),
    });

    return Effect.gen(function* () {
      const error = yield* Effect.flip(startRun());
      assert.strictEqual(error._tag, "EpicRunPreflightBlockedError");
      if (error._tag === "EpicRunPreflightBlockedError") {
        assert.deepStrictEqual(error.blockers, ["preflight exploded"]);
      }
      assert.strictEqual(harness.store.runs.size, 0);
      assert.strictEqual(harness.turnsStarted(), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("returns an active duplicate launch before validating project defaults", () => {
    const harness = createHarness({
      script: [{ text: null, head: "head-0", stall: true }],
      options: { iterationTimeoutMs: 60_000 },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const active = yield* startRun();
      yield* waitFor(() => harness.turnsStarted() === 1);

      const duplicate = yield* runner.launchRun({
        epicId: active.epicId,
        projectId: ProjectId.make("project-that-does-not-own-the-cwd"),
        cwd: active.cwd,
      });
      assert.strictEqual(duplicate.runId, active.runId);
      assert.strictEqual(harness.store.runs.size, 1);
      assert.strictEqual(harness.commandsOfType("thread.turn.start").length, 1);
      yield* runner.cancelRun({ runId: active.runId });
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("stops each iteration's session instead of leaving it to the reaper", () => {
    const harness = createHarness({
      script: [
        { text: "work", head: "head-1" },
        { text: "RALPH_DONE", head: "head-1" },
      ],
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const stops = harness.commandsOfType("thread.session.stop");
      assert.strictEqual(stops.length, 2);
      assert.deepStrictEqual(
        stops.map((command) => command.threadId),
        harness.commandsOfType("thread.create").map((command) => command.threadId),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("retries a failing iteration with backoff and fails the run after three", () => {
    const failing = {
      text: null,
      head: "head-0",
      turnState: "error",
      sessionStatus: "error",
    } as const;
    const harness = createHarness({
      script: [failing, failing, failing, { text: "should never run", head: "head-9" }],
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      const failed = harness.store.runs.get(run.runId)!;
      assert.strictEqual(failed.consecutiveFailures, 3);
      assert.strictEqual(failed.lastError, "turn ended in an error state");
      // The fourth scripted iteration must not have been reached.
      assert.strictEqual(harness.turnsStarted(), 3);
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.turnStatus),
        ["failed", "failed", "failed"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("stops a run that keeps producing no commits", () => {
    const harness = createHarness({
      script: [
        { text: "thinking about it", head: "head-0" },
        { text: "still thinking", head: "head-0" },
        { text: "should never run", head: "head-9" },
      ],
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      assert.strictEqual(
        harness.store.runs.get(run.runId)!.lastError,
        "gutter: 2 iterations without a commit",
      );
      assert.strictEqual(harness.turnsStarted(), 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("interrupts the turn in flight when a run is cancelled", () => {
    const harness = createHarness({
      script: [{ text: null, head: "head-0", stall: true }],
      options: { iterationTimeoutMs: 60_000 },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRun();
      yield* waitFor(() => harness.turnsStarted() === 1);

      const cancelled = yield* runner.cancelRun({ runId: run.runId });
      assert.strictEqual(cancelled.status, "cancelled");
      assert.strictEqual(cancelled.currentThreadId, null);

      const interrupts = harness.commandsOfType("thread.turn.interrupt");
      assert.strictEqual(interrupts.length, 1);
      assert.strictEqual(interrupts[0]?.threadId, harness.store.iterations[0]?.threadId);
      // The abandoned iteration is closed out rather than left `running` forever.
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "abandoned");

      // The loop is gone: nothing else starts after the cancel.
      yield* settle;
      assert.strictEqual(harness.turnsStarted(), 1);
      assert.strictEqual(harness.store.runs.get(run.runId)!.status, "cancelled");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("interrupts and fails an iteration that outlives its timeout", () => {
    const harness = createHarness({
      script: [{ text: null, head: "head-0", stall: true }],
      options: { iterationTimeoutMs: 40, maxConsecutiveFailures: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      assert.strictEqual(
        harness.store.runs.get(run.runId)!.lastError,
        "iteration exceeded its timeout",
      );
      assert.strictEqual(harness.commandsOfType("thread.turn.interrupt").length, 1);
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("marks an iteration left running by a restart as abandoned and resumes", () => {
    const runId = "run-restart";
    const staleRun: EpicRun = {
      runId: runId as EpicRun["runId"],
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      modelSelection,
      runtimeMode: "full-access",
      status: "running",
      maxIterations: 10,
      iterationsCompleted: 1,
      currentThreadId: ThreadId.make(`epic-run-${runId}-0`),
      currentTurnStartedAt: NOW,
      consecutiveFailures: 0,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      seedRuns: [staleRun],
      seedIterations: [
        {
          runId: staleRun.runId,
          iterationIndex: 0,
          threadId: ThreadId.make(`epic-run-${runId}-0`),
          issueId: "child-0",
          turnStatus: "running",
          summary: null,
          why: null,
          startedAt: NOW,
          finishedAt: null,
        },
      ],
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "done");

      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "abandoned");
      assert.strictEqual(harness.store.iterations[0]?.summary, "abandoned by server restart");
      const staleThreadId = harness.store.iterations[0]!.threadId;
      const interruptIndex = harness.commands.findIndex(
        (command) => command.type === "thread.turn.interrupt" && command.threadId === staleThreadId,
      );
      const stopIndex = harness.commands.findIndex(
        (command) => command.type === "thread.session.stop" && command.threadId === staleThreadId,
      );
      const nextCreateIndex = harness.commands.findIndex(
        (command) => command.type === "thread.create",
      );
      assert.isAtLeast(interruptIndex, 0);
      assert.isAbove(stopIndex, interruptIndex);
      assert.isAbove(nextCreateIndex, stopIndex);
      // The resumed loop picks up at the next index, not the abandoned one.
      assert.strictEqual(harness.store.iterations[1]?.iterationIndex, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("lets a paused run finish its iteration and then stops", () => {
    // A slow settle so the pause lands while the first iteration is in flight,
    // which is the case worth pinning: the turn must not be cut short, and the
    // loop's own write must not resurrect the run as `running`.
    const harness = createHarness({
      script: [
        { text: "work", head: "head-1" },
        { text: "should never run", head: "head-2" },
      ],
      options: { quietPeriodMs: 150 },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRun();
      yield* waitFor(() => harness.store.iterations.length === 1);

      const paused = yield* runner.pauseRun({ runId: run.runId });
      assert.strictEqual(paused.status, "paused");

      // The first iteration still completes; the loop exits at the boundary.
      yield* waitFor(() => harness.store.iterations[0]?.turnStatus === "completed");
      yield* settle;
      assert.strictEqual(harness.turnsStarted(), 1);
      assert.strictEqual(harness.store.runs.get(run.runId)!.status, "paused");
      assert.strictEqual(harness.store.runs.get(run.runId)!.iterationsCompleted, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("resumes a paused run from the next iteration index", () => {
    const harness = createHarness({
      script: [
        { text: "work", head: "head-1" },
        { text: "RALPH_DONE", head: "head-1" },
      ],
      options: { quietPeriodMs: 150 },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRun();
      yield* waitFor(() => harness.store.iterations.length === 1);
      yield* runner.pauseRun({ runId: run.runId });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "paused");
      yield* waitFor(
        () =>
          harness.store.iterations[0]?.turnStatus === "completed" &&
          harness.activeLockCount() === 0,
      );

      yield* runner.resumeRun({ runId: run.runId });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      assert.strictEqual(harness.store.iterations.length, 2);
      assert.strictEqual(harness.store.iterations[1]?.iterationIndex, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("publishes every run-state change on the hot stream", () => {
    const harness = createHarness({ script: [{ text: "RALPH_DONE", head: "head-0" }] });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const seen: string[] = [];
      yield* Effect.forkScoped(
        Stream.runForEach(runner.streamRuns, (run) =>
          Effect.sync(() => {
            seen.push(run.status);
          }),
        ),
      );
      // Subscribing is asynchronous; nothing can be observed before it lands.
      yield* Effect.sleep("50 millis");

      yield* startRun();
      yield* waitFor(() => seen.includes("done"));

      assert.strictEqual(seen[0], "running");
      assert.strictEqual(seen[seen.length - 1], "done");
      assert.strictEqual(harness.store.iterations.length, 1);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.live("leaves worktreePath null when the run's cwd is the project root", () => {
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      workspaceRoot: "/tmp/epic-runner-repo",
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.commandsOfType("thread.create")[0]?.worktreePath, null);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("runs the iteration in the run's cwd when it differs from the project root", () => {
    // Otherwise the agent would work in the project root while the commit
    // cross-check watched the run's cwd, and every iteration would read as
    // "no commit".
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      workspaceRoot: "/tmp/some-other-checkout",
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(
        harness.commandsOfType("thread.create")[0]?.worktreePath,
        "/tmp/epic-runner-repo",
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("refuses transitions that do not apply to the run's status", () => {
    const harness = createHarness({ script: [{ text: "RALPH_DONE", head: "head-0" }] });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRun();
      const exit = yield* Effect.exit(runner.resumeRun({ runId: run.runId }));
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("refuses to persist or fork a run when preflight is blocked", () => {
    let acquired = 0;
    const harness = createHarness({
      script: [],
      preflightResult: {
        ok: false,
        blockers: [{ _tag: "detached_head" }],
        warnings: [],
      },
      onLockAcquire: () => {
        acquired += 1;
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(startRun());
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(harness.store.runs.size, 0);
      assert.strictEqual(acquired, 0);
      assert.strictEqual(harness.turnsStarted(), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("releases its lock when a run reaches a terminal state", () => {
    let acquired = 0;
    let released = 0;
    const harness = createHarness({
      script: [{ text: "RALPH_DONE", head: "head-0" }],
      onLockAcquire: () => {
        acquired += 1;
      },
      onLockRelease: () => {
        released += 1;
      },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      yield* waitFor(() => released === 1);
      assert.strictEqual(acquired, 1);
      assert.strictEqual(released, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("drains active leases when the runner layer scope closes", () => {
    let released = 0;
    const harness = createHarness({
      script: [{ text: "still working", head: "head-1" }],
      onLockRelease: () => {
        released += 1;
      },
    });

    return Effect.gen(function* () {
      yield* startRun().pipe(Effect.provide(harness.layer));
      assert.strictEqual(released, 1);
    });
  });
});
