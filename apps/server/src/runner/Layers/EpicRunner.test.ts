import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  EpicRunId,
  EpicRunPreflightError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type ProjectionThreadTurnStatus,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  OrchestrationCommandInvariantError,
  type OrchestrationDispatchError,
} from "../../orchestration/Errors.ts";
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
import { AgentAwarenessRelay } from "../../relay/AgentAwarenessRelay.ts";
import { runningSubagentSettleRefusalDetail } from "../../orchestration/subagentLiveness.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import {
  EpicRunLock,
  EpicRunLockError,
  EpicRunLockHeldError,
  type EpicRunLockLease,
} from "../Services/EpicRunLock.ts";
import { EpicRunner } from "../Services/EpicRunner.ts";
import {
  EPIC_RUN_CONTINUATION_PROMPT,
  EPIC_RUN_ITERATION_PROMPT,
  makeEpicRunnerLive,
} from "./EpicRunner.ts";

const projectId = ProjectId.make("project-epic-runner");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;
const NOW = "2026-01-01T00:00:00.000Z";

const provider = (instanceId: string, driver: string, model: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  availability: "available",
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

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
  /** The projected session's `lastError` once the turn settles. */
  readonly sessionLastError?: string;
  readonly streaming?: boolean;
  /** Leave the turn hanging so the iteration has to be cancelled or time out. */
  readonly stall?: boolean;
  /**
   * Number of `getThreadDetailSnapshot` reads, for this iteration's thread,
   * that report no assistant message before the scripted one appears —
   * models the real race where the turn-end signal projects before the
   * assistant message is finalized (`ProviderRuntimeIngestion.ts:1666`
   * dispatches the session-set first). Requires `text` to be non-null: it delays the message, it
   * doesn't fabricate one.
   */
  readonly messageSettleDelayReads?: number;
  /**
   * Report `latestTurn: null` on the thread detail even though the turn has
   * settled, modelling the window in which the settling transaction has nulled
   * `threads.latest_turn_id` (`ProjectionPipeline.ts:757-771`) and the
   * checkpoint reactor has not yet restored it. The shell still reports the
   * settled turn, because `awaitTurnEnd` reads the shell and must still finish.
   * Classification then has only the session status to go on.
   */
  readonly detailTurnPointerNull?: boolean;
  /**
   * Number of `getThreadDetailSnapshot` reads, for this iteration's thread,
   * that report one FRESH `running` subagent before it flips to `completed` —
   * models the incident where the turn ended while a Task subagent was still
   * working. `Number.POSITIVE_INFINITY` keeps it running forever, for the
   * grace-timeout path. The row's `updatedAt` is stamped from the real clock
   * at read time, because the runner's freshness window is real-clock too.
   */
  readonly subagentDrainReads?: number;
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
  /**
   * Report `latestTurn: null` while still reporting the session, modelling the
   * real window in which `threads.latest_turn_id` has been nulled by the
   * settling transaction and not yet restored by the checkpoint reactor.
   */
  readonly latestTurnPointerNull?: boolean;
  readonly sessionStatus?: OrchestrationSessionStatus;
  readonly sessionLastError?: string | undefined;
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
    latestTurn: input.latestTurnPointerNull
      ? null
      : {
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
    subagents: [],
    activities: [],
    checkpoints: [],
    session:
      input.sessionStatus === undefined
        ? null
        : {
            threadId: input.threadId,
            status: input.sessionStatus,
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: input.sessionLastError ?? null,
            updatedAt: NOW,
          },
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
  /** Counted so a test can prove a listing does not fan out per run. */
  const iterationReadCounts = { perRun: 0, batched: 0 };

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
    listRuns: ({ status, limit, orderBy }) =>
      Effect.sync(() => {
        const matching = [...runs.values()]
          .filter((run) => status === undefined || run.status === status)
          .sort((left, right) =>
            orderBy === "updatedAt-desc"
              ? right.updatedAt.localeCompare(left.updatedAt) ||
                right.runId.localeCompare(left.runId)
              : left.createdAt.localeCompare(right.createdAt) ||
                left.runId.localeCompare(right.runId),
          );
        return limit === undefined ? matching : matching.slice(0, limit);
      }),
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
          failureReason: input.failureReason,
          finishedAt: input.finishedAt,
        };
      }),
    listIterations: ({ runId }) =>
      Effect.sync(() => {
        iterationReadCounts.perRun += 1;
        return iterations.filter((iteration) => iteration.runId === runId);
      }),
    listRecentIterationsForRuns: ({ runIds, limitPerRun }) =>
      Effect.sync(() => {
        iterationReadCounts.batched += 1;
        const wanted = new Set<string>(runIds);
        return [...wanted]
          .sort((left, right) => left.localeCompare(right))
          .flatMap((runId) =>
            iterations
              .filter((iteration) => iteration.runId === runId)
              .sort((left, right) => left.iterationIndex - right.iterationIndex)
              .slice(-limitPerRun),
          );
      }),
    getLatestIteration: ({ runId }) =>
      Effect.sync(() => {
        const forRun = iterations.filter((iteration) => iteration.runId === runId);
        return forRun.length === 0 ? Option.none() : Option.some(forRun[forRun.length - 1]!);
      }),
  };

  return { shape, runs, iterations, iterationReadCounts };
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
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly readyOutput?: string;
  readonly onEpicRunPublish?: (run: import("@t3tools/contracts").EpicRun) => Effect.Effect<void>;
  /**
   * Seeds `bd show <id> --json`'s status for specific issue ids, and lets
   * `releaseClaimedChild`'s `bd update <id> --status open` calls be observed
   * flipping it. Ids not listed here fall through to the generic `bd`
   * response below (which `decodeIssueStatus` cannot parse as a status, so
   * `releaseClaimedChild` treats them as unknown and leaves them alone).
   */
  readonly childStatuses?: Record<string, string>;
  /**
   * Command types the stub engine refuses, the way the real decider refuses a
   * `thread.settle` for a thread whose session is still `starting`/`running`.
   * The command is still recorded, so a test can assert it was attempted.
   */
  readonly refuseCommandTypes?: ReadonlyArray<OrchestrationCommand["type"]>;
  /**
   * Details for successive `thread.settle` refusals, consumed one per settle;
   * once exhausted, settles succeed. Lets a test hand the runner the decider's
   * running-subagent refusal and observe the drain-and-retry branch.
   */
  readonly settleRefusalDetails?: ReadonlyArray<string>;
}) {
  const store = makeMemoryStore(input.upsertDelayMs);
  for (const run of input.seedRuns ?? []) {
    store.runs.set(run.runId, run);
  }
  store.iterations.push(...(input.seedIterations ?? []));
  const childStatuses = new Map(Object.entries(input.childStatuses ?? {}));

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
  // Remaining `getThreadDetailSnapshot` reads, per thread, that must report no
  // assistant message before the real one is revealed — see
  // `ScriptedIteration.messageSettleDelayReads`.
  const messageSettleDelayReads = new Map<string, number>();
  // Remaining detail reads, per thread, that report a fresh running subagent —
  // see `ScriptedIteration.subagentDrainReads`.
  const subagentDrainReads = new Map<string, number>();
  const settleRefusalDetails = [...(input.settleRefusalDetails ?? [])];

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
          // Unique per dispatched turn: a continuation turn on the same thread
          // must project a NEW turn id, exactly as provider adoption would,
          // or `awaitTurnEnd`'s prior-turn mask could never see it end.
          turnId: TurnId.make(`${threadId}-turn-${turnsStarted}`),
          turnState: scripted.turnState ?? "completed",
          text: scripted.text,
          streaming: scripted.streaming ?? false,
          latestTurnPointerNull: scripted.detailTurnPointerNull ?? false,
          sessionStatus: scripted.sessionStatus ?? "ready",
          sessionLastError: scripted.sessionLastError,
        }),
      );
      if (scripted.messageSettleDelayReads !== undefined) {
        messageSettleDelayReads.set(threadId, scripted.messageSettleDelayReads);
      }
      if (scripted.subagentDrainReads !== undefined) {
        subagentDrainReads.set(threadId, scripted.subagentDrainReads);
      }
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
        if (command.type === "thread.settle" && settleRefusalDetails.length > 0) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: settleRefusalDetails.shift()!,
          });
        }
        if (input.refuseCommandTypes?.includes(command.type) === true) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "refused by test harness",
          });
        }
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
                  turnId:
                    details.get(threadId)?.latestTurn?.turnId ?? TurnId.make(`${threadId}-turn`),
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
          activeSubagentCount: 0,
        });
      }),
    getThreadSessionById: (threadId) =>
      Effect.sync(() => {
        const shell = shells.get(threadId);
        if (shell === undefined) {
          return Option.none();
        }
        return Option.some({
          threadId,
          status: shell.session,
          providerName: "codex",
          runtimeMode: "full-access" as const,
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        });
      }),
    getThreadSubagentLiveness: () =>
      Effect.succeed({ activeSubagentCount: 0, newestRunningUpdatedAt: null }),
    getSubagentActivities: () =>
      Effect.succeed({ activities: [], hasMore: false, nextBefore: null }),
    listAutoSettleCandidates: () => Effect.succeed([]),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: (threadId) =>
      Effect.gen(function* () {
        const detail = details.get(threadId);
        if (detail === undefined) {
          return Option.none();
        }
        let thread = detail;
        const remainingSubagentReads = subagentDrainReads.get(threadId);
        if (remainingSubagentReads !== undefined) {
          const running = remainingSubagentReads > 0;
          if (running && Number.isFinite(remainingSubagentReads)) {
            subagentDrainReads.set(threadId, remainingSubagentReads - 1);
          }
          // Use the same Effect clock as the runner's freshness check.
          const stampedAt = DateTime.formatIso(yield* DateTime.now);
          thread = {
            ...thread,
            subagents: [
              {
                subagentId: `task-${threadId}`,
                turnId: TurnId.make(`${threadId}-turn`),
                status: running ? "running" : "completed",
                startedAt: stampedAt,
                updatedAt: stampedAt,
                completedAt: running ? null : stampedAt,
              },
            ],
          };
        }
        const remainingDelay = messageSettleDelayReads.get(threadId) ?? 0;
        if (remainingDelay > 0) {
          messageSettleDelayReads.set(threadId, remainingDelay - 1);
          // Report the turn as message-less on this read, exactly like the
          // real projector before the assistant row has finalized.
          return Option.some({
            snapshotSequence: sequence,
            thread: {
              ...thread,
              messages: [],
              latestTurn:
                thread.latestTurn === null
                  ? null
                  : { ...thread.latestTurn, assistantMessageId: null },
            },
          });
        }
        return Option.some({ snapshotSequence: sequence, thread });
      }),
  });

  const processRunnerLayer = Layer.succeed(ProcessRunner.ProcessRunner, {
    run: (request: ProcessRunner.ProcessRunInput) =>
      Effect.sync(() => {
        processRequests.push(request);
        const subcommand = request.args[0];
        const issueId = request.args[1];
        if (
          request.command === "bd" &&
          subcommand === "show" &&
          issueId !== undefined &&
          childStatuses.has(issueId)
        ) {
          return {
            stdout: `[{"status":"${childStatuses.get(issueId)}"}]`,
            stderr: "",
            code: 0 as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        if (
          request.command === "bd" &&
          subcommand === "update" &&
          issueId !== undefined &&
          childStatuses.has(issueId) &&
          request.args.includes("--status")
        ) {
          const statusIndex = request.args.indexOf("--status");
          const newStatus = request.args[statusIndex + 1];
          if (newStatus !== undefined) {
            childStatuses.set(issueId, newStatus);
          }
        }
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
    Layer.provide(makeProviderRegistryLayer(input.providers ?? [])),
    Layer.provide(Layer.succeed(EpicRunStore, store.shape)),
    Layer.provide(
      Layer.succeed(AgentAwarenessRelay, {
        publishThread: () => Effect.void,
        publishEpicRun: input.onEpicRunPublish ?? (() => Effect.void),
        start: () => Effect.void,
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

  return {
    layer,
    store,
    turnsStarted: () => turnsStarted,
    activeLockCount: () => heldLocks.size,
    processRequests,
    childStatus: (issueId: string) => childStatuses.get(issueId),
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
  // The runner settles the thread as soon as the turn ends — no notification
  // ever re-invokes the agent. Agents that backgrounded work and yielded
  // ("waiting for the workflow to notify me") lost that work when the session
  // was killed, so the prompt must state the contract explicitly.
  it("iteration prompt states the no-re-invocation and no-background-yield contract", () => {
    assert.include(EPIC_RUN_ITERATION_PROMPT, "nothing re-invokes you after your turn ends");
    assert.include(EPIC_RUN_ITERATION_PROMPT, "Run all work in the foreground");
    assert.include(
      EPIC_RUN_ITERATION_PROMPT,
      "Never end your turn while a background task, workflow, or watchdog is still running",
    );
    // The RALPH protocol markers the runner parses must stay intact.
    assert.include(EPIC_RUN_ITERATION_PROMPT, "RALPH_DONE");
    assert.include(EPIC_RUN_ITERATION_PROMPT, 'RALPH_MSG: {"summary":');
  });

  it.live("publishes each persisted run transition", () => {
    const publishedStatuses: string[] = [];
    const harness = createHarness({
      script: [],
      readyOutput: "[]",
      onEpicRunPublish: (run) =>
        Effect.sync(() => {
          publishedStatuses.push(run.status);
        }),
    });
    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      yield* waitFor(() => publishedStatuses.includes("done"));
      assert.deepStrictEqual(publishedStatuses, ["running", "done"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps running when epic activity publication fails", () => {
    const harness = createHarness({
      script: [],
      readyOutput: "[]",
      onEpicRunPublish: () => Effect.die("relay unavailable"),
    });
    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.store.runs.get(run.runId)?.status, "done");
    }).pipe(Effect.provide(harness.layer));
  });

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
      const readyRequest = harness.processRequests.find(
        (request) => request.command === "bd" && request.args[0] === "ready",
      )!;
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
          failureReason: null,
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

  it.live("enriches a whole listing with one iteration read, ordered and bounded", () => {
    // Terminal so nothing here is resumed; the listing is what is under test.
    const seedRun = (runId: string, createdAt: string, updatedAt: string): EpicRun => ({
      runId: EpicRunId.make(runId),
      epicId: "epic-list",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      modelSelection,
      runtimeMode: "full-access",
      originThreadId: null,
      status: "done",
      maxIterations: 10,
      iterationsCompleted: 2,
      currentThreadId: null,
      currentTurnStartedAt: null,
      consecutiveFailures: 0,
      lastError: null,
      createdAt,
      updatedAt,
    });
    const seedRuns = [
      seedRun("run-list-old", "2026-07-27T00:00:01.000Z", "2026-07-27T01:00:00.000Z"),
      seedRun("run-list-new", "2026-07-27T00:00:02.000Z", "2026-07-27T03:00:00.000Z"),
      seedRun("run-list-mid", "2026-07-27T00:00:03.000Z", "2026-07-27T02:00:00.000Z"),
    ];
    const harness = createHarness({
      script: [],
      readyOutput: "[]",
      seedRuns,
      seedIterations: seedRuns.flatMap((run, runOffset) =>
        Array.from({ length: 2 }, (_unused, iterationIndex) => ({
          runId: run.runId,
          iterationIndex,
          threadId: ThreadId.make(`thread-${run.runId}-${iterationIndex}`),
          issueId: `child-${runOffset}-${iterationIndex}`,
          turnStatus: "completed" as const,
          summary: null,
          why: null,
          failureReason: null,
          startedAt: NOW,
          finishedAt: NOW,
        })),
      ),
    });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;

      const listed = yield* runner.listRuns();
      assert.deepStrictEqual(
        listed.map((run) => run.runId),
        ["run-list-old", "run-list-new", "run-list-mid"],
      );
      // Three runs, one iteration read: the whole point of the batch.
      assert.deepStrictEqual(harness.store.iterationReadCounts, { perRun: 0, batched: 1 });
      assert.deepStrictEqual(
        listed.map((run) => run.recentIterations.length),
        [2, 2, 2],
      );
      assert.deepStrictEqual(
        listed[0]?.threadRefs.map((reference) => reference.threadId),
        ["thread-run-list-old-0", "thread-run-list-old-1"],
      );

      const recent = yield* runner.listRuns({ orderBy: "updatedAt-desc", limit: 2 });
      assert.deepStrictEqual(
        recent.map((run) => run.runId),
        ["run-list-new", "run-list-mid"],
      );
      assert.deepStrictEqual(harness.store.iterationReadCounts, { perRun: 0, batched: 2 });
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("records the launching thread, and null when there is none", () => {
    const harness = createHarness({ script: [], readyOutput: "[]" });
    return Effect.gen(function* () {
      const runner = yield* EpicRunner;

      const fromThread = yield* runner.launchRun({
        epicId: "epic-from-thread",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        originThreadId: ThreadId.make("thread-launcher"),
      });
      assert.strictEqual(fromThread.originThreadId, "thread-launcher");

      // The Epics page launches without a thread; nothing may infer one from
      // the run's own iteration threads, which are children of the run.
      const fromEpicsPage = yield* runner.launchRun({
        epicId: "epic-from-page",
        projectId,
        cwd: "/tmp/epic-runner-repo",
      });
      assert.strictEqual(fromEpicsPage.originThreadId, null);

      assert.strictEqual(
        harness.store.runs.get(fromThread.runId)?.originThreadId,
        "thread-launcher",
      );
      assert.strictEqual(harness.store.runs.get(fromEpicsPage.runId)?.originThreadId, null);
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
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.failureReason),
        [null, null, null],
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

  it.live(
    "classifies an iteration done when the assistant message settles after the turn ends",
    () => {
      // The turn is reported `completed` before the assistant message has
      // projected — the exact race `readSettledFinalMessage` must survive
      // rather than mistaking the absent message for a settled, empty one.
      const harness = createHarness({
        script: [
          {
            text: 'did the work\nRALPH_MSG: {"summary":"settled late","why":"race"}',
            head: "head-1",
            messageSettleDelayReads: 2,
          },
        ],
        options: { iterationTimeoutMs: 60_000 },
      });

      return Effect.gen(function* () {
        const runner = yield* EpicRunner;
        const run = yield* startRun();
        yield* waitFor(() => harness.store.iterations[0]?.turnStatus === "completed");

        assert.strictEqual(harness.store.iterations[0]?.summary, "settled late");
        assert.strictEqual(harness.store.iterations[0]?.why, "race");
        assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 0);

        yield* runner.cancelRun({ runId: run.runId });
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.live("classifies a genuinely message-less completed turn as a protocol error", () => {
    // "No message ever". The turn completed, the settle wait ran out, and the
    // iteration left no commit behind — nothing to judge it by, so it fails.
    const harness = createHarness({
      script: [{ text: null, head: "head-0", turnState: "completed" }],
      options: { infraFailureBudget: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      const failed = harness.store.runs.get(run.runId)!;
      assert.include(failed.lastError ?? "", "turn completed without an assistant message");
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "infra:protocol-error");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live(
    "keeps a committed iteration whose message never projected out of the failure count",
    () => {
      // Regression for t3code-9vf. "No message *yet*" and "no message ever" look
      // identical in projections — under the default buffered delivery mode a
      // pending final message has no assistant row at all, not a streaming one —
      // so once the settle wait is exhausted the verdict falls to the other
      // observation: the commit. Without it this iteration reads as a protocol
      // error and three in a row kill the run.
      const harness = createHarness({
        script: [{ text: null, head: "head-1", turnState: "completed" }],
        options: { iterationTimeoutMs: 60_000, maxConsecutiveFailures: 1 },
      });

      return Effect.gen(function* () {
        const runner = yield* EpicRunner;
        const run = yield* startRun();
        yield* waitFor(() => harness.store.iterations[0]?.turnStatus === "completed");

        assert.strictEqual(
          harness.store.iterations[0]?.summary,
          "assistant message never projected; accepted on the iteration's commit",
        );
        assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 0);
        assert.strictEqual(harness.store.runs.get(run.runId)?.lastError, null);
        assert.notStrictEqual(harness.store.runs.get(run.runId)?.status, "failed");

        yield* runner.cancelRun({ runId: run.runId });
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.live(
    "classifies a settled iteration done when the turn pointer has not been restored yet",
    () => {
      // Regression for t3code-pxv. The settling transaction nulls
      // `threads.latest_turn_id`, and only the checkpoint reactor restores it —
      // after git work that can be slow or fail outright. Every read in between
      // sees `latestTurn: null`, which is indistinguishable from "never ran"
      // unless classification falls back to the session status the projector
      // settled the turn from.
      const harness = createHarness({
        script: [
          {
            text: 'did the work\nRALPH_MSG: {"summary":"landed","why":"pointer lagged"}',
            head: "head-1",
            detailTurnPointerNull: true,
          },
        ],
        options: { iterationTimeoutMs: 60_000 },
      });

      return Effect.gen(function* () {
        const runner = yield* EpicRunner;
        const run = yield* startRun();
        yield* waitFor(() => harness.store.iterations[0]?.turnStatus === "completed");

        assert.strictEqual(harness.store.iterations[0]?.summary, "landed");
        assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 0);
        assert.strictEqual(harness.store.runs.get(run.runId)?.lastError, null);

        yield* runner.cancelRun({ runId: run.runId });
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.live("still reports an interrupted turn as an error when the turn pointer is missing", () => {
    // The session-status fallback must not launder every missing pointer into
    // "completed": a session that stopped mid-turn still has to fail.
    const harness = createHarness({
      script: [
        {
          text: 'partial\nRALPH_MSG: {"summary":"nope","why":"nope"}',
          head: "head-1",
          detailTurnPointerNull: true,
          sessionStatus: "stopped",
        },
      ],
      options: { infraFailureBudget: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      assert.include(harness.store.runs.get(run.runId)?.lastError ?? "", "turn was interrupted");
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
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

  it.live("settles each finished iteration thread instead of leaving it to the reaper", () => {
    const harness = createHarness({
      script: [
        { text: "work", head: "head-1" },
        { text: "RALPH_DONE", head: "head-1" },
      ],
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const settles = harness.commandsOfType("thread.settle");
      assert.strictEqual(settles.length, 2);
      assert.deepStrictEqual(
        settles.map((command) => command.threadId),
        harness.commandsOfType("thread.create").map((command) => command.threadId),
      );
      // Teardown is the settle reactor's job now, so a healthy run never
      // reaches for the provider itself.
      assert.strictEqual(harness.commandsOfType("thread.session.stop").length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("falls back to stopping the session when the settle is refused", () => {
    const harness = createHarness({
      script: [
        { text: "work", head: "head-1" },
        { text: "RALPH_DONE", head: "head-1" },
      ],
      refuseCommandTypes: ["thread.settle"],
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const settles = harness.commandsOfType("thread.settle");
      const stops = harness.commandsOfType("thread.session.stop");
      assert.strictEqual(settles.length, 2);
      // One stop per refused settle, for the same thread: the refusal must not
      // leave the iteration's provider subprocess resident.
      assert.deepStrictEqual(
        stops.map((command) => command.threadId),
        settles.map((command) => command.threadId),
      );
      for (const settle of settles) {
        const settleIndex = harness.commands.indexOf(settle);
        const stopIndex = harness.commands.findIndex(
          (command) =>
            command.type === "thread.session.stop" && command.threadId === settle.threadId,
        );
        assert.isAbove(stopIndex, settleIndex);
      }
      // A refused settle is ordinary traffic, not a run failure.
      assert.strictEqual(harness.store.runs.get(run.runId)?.status, "done");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("waits out running subagents after a no-commit turn and sends a continuation", () => {
    // The 2026-08-04 incident shape: the agent backgrounded its work and
    // ended the turn with no commit while a Task subagent was still running.
    // Settling here would tear the session down and kill the subagent, so
    // the runner must wait for the drain and grant one continuation turn.
    const harness = createHarness({
      script: [
        {
          text: "Watchdog running. Waiting for the workflow to complete...",
          head: "head-0",
          subagentDrainReads: 3,
        },
        // The continuation, dispatched only after the subagent drained.
        {
          text: 'folded it in\nRALPH_MSG: {"summary":"landed after grace","why":"subagent finished"}',
          head: "head-1",
        },
        // A plain iteration with zero subagents settles exactly as today.
        { text: "RALPH_DONE", head: "head-1" },
      ],
      options: { iterationTimeoutMs: 60_000 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const created = harness.commandsOfType("thread.create");
      assert.strictEqual(created.length, 2);
      const iterationThreadId = created[0]!.threadId;
      const turnStarts = harness
        .commandsOfType("thread.turn.start")
        .filter((command) => command.threadId === iterationThreadId);
      // The original turn plus exactly ONE continuation, never more.
      assert.strictEqual(turnStarts.length, 2);
      const continuation = turnStarts[1]!;
      assert.strictEqual(continuation.message.text, EPIC_RUN_CONTINUATION_PROMPT);
      assert.strictEqual(continuation.message.messageId, `${iterationThreadId}-continue`);

      // The thread was NOT settled on the original turn's end: its settle
      // came only after the continuation turn was dispatched and finished.
      const settles = harness.commandsOfType("thread.settle");
      const settle = settles.find((command) => command.threadId === iterationThreadId)!;
      assert.isAbove(harness.commands.indexOf(settle), harness.commands.indexOf(continuation));

      // The continuation's commit and report classified the iteration.
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "completed");
      assert.strictEqual(harness.store.iterations[0]?.summary, "landed after grace");
      assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 0);

      // The zero-subagent iteration got one turn and one settle — no
      // continuation, no session stop anywhere.
      assert.strictEqual(harness.commandsOfType("thread.turn.start").length, 3);
      assert.strictEqual(settles.length, 2);
      assert.strictEqual(harness.commandsOfType("thread.session.stop").length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("resumes through reviewer and implementer subagents before the parent commits", () => {
    // A cook-it parent can delegate a review, resume to delegate implementation,
    // then need another resume to integrate and commit. Every delegation ends
    // the parent turn while its new subagent is still running.
    const harness = createHarness({
      script: [
        {
          text: "The reviewer is checking the plan.",
          head: "head-0",
          subagentDrainReads: 2,
        },
        {
          text: "The implementer is applying the reviewed plan.",
          head: "head-0",
          subagentDrainReads: 2,
        },
        {
          text: 'Integrated the implementation.\nRALPH_MSG: {"summary":"nested chain landed","why":"review and implementation finished"}',
          head: "head-1",
        },
        { text: "RALPH_DONE", head: "head-1" },
      ],
      options: { iterationTimeoutMs: 60_000 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      const iterationThreadId = harness.commandsOfType("thread.create")[0]!.threadId;
      const turnStarts = harness
        .commandsOfType("thread.turn.start")
        .filter((command) => command.threadId === iterationThreadId);
      assert.strictEqual(turnStarts.length, 3);
      assert.deepStrictEqual(
        turnStarts.map((command) => command.message.messageId),
        [
          `${iterationThreadId}-prompt`,
          `${iterationThreadId}-continue`,
          `${iterationThreadId}-continue-2`,
        ],
      );
      assert.deepStrictEqual(
        turnStarts.slice(1).map((command) => command.message.text),
        [EPIC_RUN_CONTINUATION_PROMPT, EPIC_RUN_CONTINUATION_PROMPT],
      );

      const settle = harness
        .commandsOfType("thread.settle")
        .find((command) => command.threadId === iterationThreadId)!;
      assert.isAbove(harness.commands.indexOf(settle), harness.commands.indexOf(turnStarts[2]!));
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "completed");
      assert.strictEqual(harness.store.iterations[0]?.summary, "nested chain landed");
      assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("gives up the subagent grace wait at its bound and classifies as today", () => {
    // A subagent that never drains must not wedge the iteration: the grace
    // wait is bounded, and past the bound the no-commit turn is classified
    // exactly as it would have been without the grace path.
    const harness = createHarness({
      script: [
        {
          text: "still waiting on my background task",
          head: "head-0",
          subagentDrainReads: Number.POSITIVE_INFINITY,
        },
      ],
      options: { subagentGraceTimeoutMs: 40, maxNoCommitStreak: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      // No continuation was ever dispatched.
      assert.strictEqual(harness.commandsOfType("thread.turn.start").length, 1);
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "child:no-commit-child-open");
      assert.strictEqual(harness.commandsOfType("thread.settle").length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live(
    "retries a subagent-refused settle after the drain instead of stopping the session",
    () => {
      // The decider refuses a settle naming running subagents (e.g. the
      // continuation turn spawned new ones). That refusal is real in-flight
      // work, not a dead session: the runner must wait it out and settle again
      // rather than falling straight through to the session stop that would
      // kill the subagent.
      const harness = createHarness({
        script: [
          { text: 'work\nRALPH_MSG: {"summary":"landed","why":"progress"}', head: "head-1" },
          { text: "RALPH_DONE", head: "head-1" },
        ],
        settleRefusalDetails: [runningSubagentSettleRefusalDetail(ThreadId.make("thread-any"), 1)],
      });

      return Effect.gen(function* () {
        const run = yield* startRun();
        yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

        const settles = harness.commandsOfType("thread.settle");
        // Iteration 1: the refused settle plus its retry; iteration 2: one.
        assert.strictEqual(settles.length, 3);
        assert.strictEqual(settles[0]!.threadId, settles[1]!.threadId);
        // Receipts remember the refused commandId, so the retry needs its own.
        assert.notStrictEqual(settles[0]!.commandId, settles[1]!.commandId);
        assert.strictEqual(harness.commandsOfType("thread.session.stop").length, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.live("retries infra failures with backoff and fails only at the infra budget", () => {
    const failing = {
      text: null,
      head: "head-0",
      turnState: "error",
      sessionStatus: "error",
    } as const;
    const harness = createHarness({
      script: [failing, failing, failing, { text: "should never run", head: "head-9" }],
      // Below the failure count so exhaustion is observable; the default
      // budget (5) would have kept retrying past all three.
      options: { infraFailureBudget: 3, maxConsecutiveFailures: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      const failed = harness.store.runs.get(run.runId)!;
      // Errored turns are infra failures: they never consume the
      // maxConsecutiveFailures budget (set to 1 above to prove it), and the
      // run survives until the dedicated infra budget runs out.
      assert.strictEqual(failed.consecutiveFailures, 0);
      assert.include(failed.lastError ?? "", "turn ended in an error state");
      assert.include(failed.lastError ?? "", "3 consecutive infrastructure failures");
      // The fourth scripted iteration must not have been reached.
      assert.strictEqual(harness.turnsStarted(), 3);
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.turnStatus),
        ["failed", "failed", "failed"],
      );
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.failureReason),
        ["infra:turn-error", "infra:turn-error", "infra:turn-error"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps consecutive infra failures out of the gutter and retries through them", () => {
    // The 2026-08-04 incident shape: two provider deaths in a row must not
    // read as "2 iterations without a commit". With the default gutter
    // threshold of 2, an infra failure that incremented the no-commit streak
    // would fail this run at the second provider error; instead the run backs
    // off, retries, and still has the full gutter budget for the genuine
    // no-commit that follows.
    const spendLimit = "You've hit your org's monthly spend limit; it resets on the 1st";
    const providerDeath = {
      text: null,
      head: "head-0",
      turnState: "error",
      sessionStatus: "error",
      sessionLastError: spendLimit,
    } as const;
    const harness = createHarness({
      script: [
        providerDeath,
        providerDeath,
        { text: "thinking about it", head: "head-0" },
        { text: "RALPH_DONE", head: "head-0" },
      ],
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      assert.strictEqual(harness.turnsStarted(), 4);
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.failureReason),
        [
          "infra:provider-error:spend-limit",
          "infra:provider-error:spend-limit",
          "child:no-commit-child-open",
          null,
        ],
      );
      // Infra failures never touched the persisted child-failure budget.
      assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("resets the infra streak when an iteration succeeds", () => {
    const failing = {
      text: null,
      head: "head-0",
      turnState: "error",
      sessionStatus: "error",
    } as const;
    const harness = createHarness({
      script: [
        failing,
        { text: 'work\nRALPH_MSG: {"summary":"landed","why":"progress"}', head: "head-1" },
        { ...failing, head: "head-1" },
        { ...failing, head: "head-1" },
        { text: "should never run", head: "head-9" },
      ],
      options: { infraFailureBudget: 2 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      // Without the reset the budget of 2 would have failed the run at the
      // third iteration; the successful commit bought a fresh budget.
      assert.strictEqual(harness.turnsStarted(), 4);
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.turnStatus),
        ["failed", "completed", "failed", "failed"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("charges a RALPH_BLOCKED report to the child failure budget, not the infra one", () => {
    const harness = createHarness({
      script: [{ text: "cannot proceed\nRALPH_BLOCKED", head: "head-0" }],
      options: { maxConsecutiveFailures: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      const failed = harness.store.runs.get(run.runId)!;
      assert.strictEqual(failed.consecutiveFailures, 1);
      assert.strictEqual(failed.lastError, "agent reported RALPH_BLOCKED");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "child:blocked");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("surfaces the session's provider error into the iteration row and run.lastError", () => {
    // The 2026-08-04 incident: a 429 spend limit killed both runs, but the
    // only recorded reason was "gutter: 2 iterations without a commit". The
    // real error text is in the projected session's lastError and must reach
    // the iteration summary and, when the run fails, epic_runs.last_error.
    const spendLimit = "You've hit your org's monthly spend limit; it resets on the 1st";
    const harness = createHarness({
      script: [
        {
          text: null,
          head: "head-0",
          turnState: "error",
          sessionStatus: "error",
          sessionLastError: spendLimit,
        },
      ],
      options: { infraFailureBudget: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      assert.include(
        harness.store.runs.get(run.runId)!.lastError ?? "",
        `provider error: ${spendLimit}`,
      );
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
      assert.strictEqual(harness.store.iterations[0]?.summary, `provider error: ${spendLimit}`);
      assert.strictEqual(
        harness.store.iterations[0]?.failureReason,
        "infra:provider-error:spend-limit",
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("persists a provider fallback and dispatches the next iteration on Codex", () => {
    const claudeSelection = {
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-sonnet-5",
    } as const;
    const codexSelection = {
      instanceId: ProviderInstanceId.make("codex-personal"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    } as const;
    const harness = createHarness({
      script: [
        {
          text: null,
          head: "head-0",
          turnState: "error",
          sessionStatus: "error",
          sessionLastError: "You've hit your org's monthly spend limit",
        },
        { text: "RALPH_DONE", head: "head-0" },
      ],
      options: { infraFailureBudget: 1 },
      providers: [
        provider("claude-work", "claudeAgent", "claude-sonnet-5"),
        provider("codex-personal", "codex", "gpt-5.6-sol"),
      ],
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.startRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "do one unit of work",
        modelSelection: claudeSelection,
        maxIterations: 10,
      });
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      assert.deepStrictEqual(harness.store.runs.get(run.runId)?.modelSelection, codexSelection);
      assert.strictEqual(harness.turnsStarted(), 2);
      assert.deepStrictEqual(
        harness.commandsOfType("thread.turn.start").map((command) => command.modelSelection),
        [claudeSelection, codexSelection],
      );
      assert.strictEqual(
        harness.store.iterations[0]?.failureReason,
        "infra:provider-error:spend-limit",
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("persists a provider fallback at a paused iteration boundary", () => {
    const claudeSelection = {
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "claude-sonnet-5",
    } as const;
    const codexSelection = {
      instanceId: ProviderInstanceId.make("codex-personal"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    } as const;
    const harness = createHarness({
      script: [
        {
          text: null,
          head: "head-0",
          turnState: "error",
          sessionStatus: "error",
          sessionLastError: "You've hit your org's monthly spend limit",
        },
        { text: "should never run", head: "head-1" },
      ],
      options: { infraFailureBudget: 1, quietPeriodMs: 150 },
      providers: [
        provider("claude-work", "claudeAgent", "claude-sonnet-5"),
        provider("codex-personal", "codex", "gpt-5.6-sol"),
      ],
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* runner.startRun({
        epicId: "epic-1",
        projectId,
        cwd: "/tmp/epic-runner-repo",
        prompt: "do one unit of work",
        modelSelection: claudeSelection,
        maxIterations: 10,
      });
      yield* waitFor(() => harness.store.iterations.length === 1);
      yield* runner.pauseRun({ runId: run.runId });
      yield* waitFor(() => harness.store.iterations[0]?.turnStatus === "failed");
      yield* settle;

      assert.strictEqual(harness.store.runs.get(run.runId)?.status, "paused");
      assert.deepStrictEqual(harness.store.runs.get(run.runId)?.modelSelection, codexSelection);
      assert.strictEqual(harness.turnsStarted(), 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live(
    "fails an iteration whose final message is a provider error and releases its child",
    () => {
      // Failure mode B rendered the spend-limit error as an ordinary assistant
      // message on a cleanly-completed turn. Without the text scan this scored
      // "no-commit" and the true cause never left the provider logs.
      const harness = createHarness({
        script: [
          {
            text: "You've hit your org's monthly spend limit — upgrade to continue.",
            head: "head-0",
          },
          { text: "RALPH_DONE", head: "head-0" },
        ],
        readyOutput: '[{"id":"child-1","parent":"epic-1"}]',
        childStatuses: { "child-1": "in_progress" },
      });

      return Effect.gen(function* () {
        const run = yield* startRun();
        yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
        yield* settle;

        assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
        assert.strictEqual(
          harness.store.iterations[0]?.failureReason,
          "infra:provider-error:spend-limit",
        );
        assert.strictEqual(
          harness.store.iterations[0]?.summary,
          "provider error: You've hit your org's monthly spend limit — upgrade to continue.",
        );

        // The provider error charged the infra budget — neither the gutter
        // nor consecutiveFailures — and the failed iteration's claimed child
        // was reopened before the next iteration selected work, which
        // re-picked it and finished the run.
        assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 0);
        const updates = harness.processRequests.filter(
          (request) => request.command === "bd" && request.args[0] === "update",
        );
        assert.strictEqual(updates.length, 1);
        assert.deepStrictEqual(updates[0]!.args, [
          "update",
          "child-1",
          "--status",
          "open",
          "--assignee",
          "",
        ]);
        const readyIndexes = harness.processRequests.flatMap((request, index) =>
          request.command === "bd" && request.args[0] === "ready" ? [index] : [],
        );
        assert.strictEqual(readyIndexes.length, 2);
        assert.isBelow(harness.processRequests.indexOf(updates[0]!), readyIndexes[1]!);
        assert.strictEqual(harness.store.iterations[1]?.turnStatus, "completed");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.live("scores an iteration whose turn could not be dispatched with its own reason", () => {
    const harness = createHarness({
      script: [{ text: "never reached", head: "head-0" }],
      refuseCommandTypes: ["thread.turn.start"],
      options: { infraFailureBudget: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "infra:dispatch-failed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("releases the stranded child left in_progress when a run exhausts its retries", () => {
    const failing = {
      text: null,
      head: "head-0",
      turnState: "error",
      sessionStatus: "error",
    } as const;
    const harness = createHarness({
      script: [failing, failing, failing],
      options: { infraFailureBudget: 3 },
      childStatuses: { "child-3": "in_progress" },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
      yield* waitFor(() =>
        harness.processRequests.some(
          (request) =>
            request.command === "bd" &&
            request.args[0] === "update" &&
            request.args[1] === "child-3",
        ),
      );

      const updateRequest = harness.processRequests.find(
        (request) => request.command === "bd" && request.args[0] === "update",
      )!;
      assert.deepStrictEqual(updateRequest.args, [
        "update",
        "child-3",
        "--status",
        "open",
        "--assignee",
        "",
      ]);
      assert.strictEqual(harness.childStatus("child-3"), "open");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("releases stranded children from earlier iterations, not just the latest", () => {
    const failing = {
      text: null,
      head: "head-0",
      turnState: "error",
      sessionStatus: "error",
    } as const;
    const harness = createHarness({
      script: [failing, failing, failing],
      options: { infraFailureBudget: 3 },
      // `child-1` belongs to the FIRST iteration and `child-3` to the last.
      // Before t3code-1bk only the latest iteration was swept, so `child-1`
      // stayed claimed forever and `bd ready` could never resurface it.
      childStatuses: { "child-1": "in_progress", "child-3": "in_progress" },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
      yield* waitFor(
        () =>
          harness.childStatus("child-1") === "open" && harness.childStatus("child-3") === "open",
      );

      assert.strictEqual(harness.childStatus("child-1"), "open");
      assert.strictEqual(harness.childStatus("child-3"), "open");
      const released = harness.processRequests
        .filter((request) => request.command === "bd" && request.args[0] === "update")
        .map((request) => request.args[1]);
      assert.deepStrictEqual(released, ["child-1", "child-3"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("does not touch a child that was already closed when the run failed", () => {
    const failing = {
      text: null,
      head: "head-0",
      turnState: "error",
      sessionStatus: "error",
    } as const;
    const harness = createHarness({
      script: [failing, failing, failing],
      options: { infraFailureBudget: 3 },
      childStatuses: { "child-3": "closed" },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");
      // Nothing to wait *for* — the assertion is that the release is a no-op —
      // so give the finalizer a beat to run and confirm it stayed quiet.
      yield* settle;

      assert.isFalse(
        harness.processRequests.some(
          (request) => request.command === "bd" && request.args[0] === "update",
        ),
      );
      assert.strictEqual(harness.childStatus("child-3"), "closed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("reopens a claimed child mid-run so the retry re-selects the same child", () => {
    const harness = createHarness({
      script: [
        { text: null, head: "head-0", turnState: "error", sessionStatus: "error" },
        { text: "RALPH_DONE", head: "head-0" },
      ],
      // A fixed frontier: every selection returns `child-1`, which is what a
      // real retry sees once the claim is released — `bd ready` hides an
      // `in_progress` child, so re-selection only works if the failed
      // iteration reopened it before the next one asked.
      readyOutput: '[{"id":"child-1","parent":"epic-1"}]',
      childStatuses: { "child-1": "in_progress" },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      yield* settle;

      // The failed iteration reopened the claim itself; the terminal sweep
      // then found it already open and stayed quiet, so exactly one update.
      const updates = harness.processRequests.filter(
        (request) => request.command === "bd" && request.args[0] === "update",
      );
      assert.strictEqual(updates.length, 1);
      assert.deepStrictEqual(updates[0]!.args, [
        "update",
        "child-1",
        "--status",
        "open",
        "--assignee",
        "",
      ]);
      assert.strictEqual(harness.childStatus("child-1"), "open");

      // The release landed before the next iteration selected its child, and
      // that iteration picked the same child again.
      const readyIndexes = harness.processRequests.flatMap((request, index) =>
        request.command === "bd" && request.args[0] === "ready" ? [index] : [],
      );
      assert.strictEqual(readyIndexes.length, 2);
      assert.isBelow(harness.processRequests.indexOf(updates[0]!), readyIndexes[1]!);
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => iteration.issueId),
        ["child-1", "child-1"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("leaves a child its agent already closed alone when the iteration fails mid-run", () => {
    const harness = createHarness({
      script: [
        { text: null, head: "head-0", turnState: "error", sessionStatus: "error" },
        { text: "RALPH_DONE", head: "head-0" },
      ],
      readyOutput: '[{"id":"child-1","parent":"epic-1"}]',
      childStatuses: { "child-1": "closed" },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      yield* settle;

      assert.isFalse(
        harness.processRequests.some(
          (request) => request.command === "bd" && request.args[0] === "update",
        ),
      );
      assert.strictEqual(harness.childStatus("child-1"), "closed");
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
      // The rows themselves are failed too: the children's statuses could not
      // be read here (unknown counts as open), so nothing vouched for either
      // iteration. Before this scoring the incident's dead sessions read as
      // rows of "completed" under a failed run.
      assert.deepStrictEqual(
        harness.store.iterations.map((iteration) => [
          iteration.turnStatus,
          iteration.failureReason,
        ]),
        [
          ["failed", "child:no-commit-child-open"],
          ["failed", "child:no-commit-child-open"],
        ],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("fails a no-commit iteration whose child is still open, without burning the run", () => {
    const harness = createHarness({
      script: [
        { text: "spun without landing anything", head: "head-0" },
        { text: "RALPH_DONE", head: "head-0" },
      ],
      readyOutput: '[{"id":"child-1","parent":"epic-1"}]',
      childStatuses: { "child-1": "in_progress" },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");

      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "child:no-commit-child-open");
      // The human summary stays what classification said.
      assert.strictEqual(harness.store.iterations[0]?.summary, "iteration produced no commit");
      // Run-level policy is untouched: one no-commit charges the gutter
      // streak, not consecutiveFailures, and the run carried on to RALPH_DONE.
      assert.strictEqual(harness.store.runs.get(run.runId)?.consecutiveFailures, 0);
      assert.strictEqual(harness.store.iterations[1]?.turnStatus, "completed");
      assert.strictEqual(harness.store.iterations[1]?.failureReason, null);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("keeps a no-commit iteration completed when its child was closed in the turn", () => {
    // A knowledge-only child ("Research: ...") legitimately produces no
    // commit; the agent closing it is what vouches for the iteration.
    const harness = createHarness({
      script: [
        {
          text: 'researched it\nRALPH_MSG: {"summary":"wrote findings","why":"knowledge child"}',
          head: "head-0",
        },
        { text: "RALPH_DONE", head: "head-0" },
      ],
      readyOutput: '[{"id":"child-1","parent":"epic-1"}]',
      childStatuses: { "child-1": "closed" },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      yield* settle;

      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "completed");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, null);
      assert.strictEqual(harness.store.iterations[0]?.summary, "wrote findings");
      // The closed child is left alone, mid-run and at the terminal sweep.
      assert.isFalse(
        harness.processRequests.some(
          (request) => request.command === "bd" && request.args[0] === "update",
        ),
      );
      assert.strictEqual(harness.childStatus("child-1"), "closed");
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
      // A cancelled thread is abandoned mid-turn, not finished, so it keeps the
      // interrupt + session.stop pair. Settling it would claim the iteration
      // ran to completion.
      const stops = harness.commandsOfType("thread.session.stop");
      assert.strictEqual(stops.length, 1);
      assert.strictEqual(stops[0]?.threadId, harness.store.iterations[0]?.threadId);
      assert.isAbove(harness.commands.indexOf(stops[0]!), harness.commands.indexOf(interrupts[0]!));
      assert.strictEqual(harness.commandsOfType("thread.settle").length, 0);
      // The abandoned iteration is closed out rather than left `running` forever.
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "abandoned");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "cancelled");

      // The loop is gone: nothing else starts after the cancel.
      yield* settle;
      assert.strictEqual(harness.turnsStarted(), 1);
      assert.strictEqual(harness.store.runs.get(run.runId)!.status, "cancelled");
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("interrupts and fails an iteration that outlives its timeout", () => {
    const harness = createHarness({
      script: [{ text: null, head: "head-0", stall: true }],
      options: { iterationTimeoutMs: 40, infraFailureBudget: 1 },
    });

    return Effect.gen(function* () {
      const run = yield* startRun();
      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "failed");

      assert.include(
        harness.store.runs.get(run.runId)!.lastError ?? "",
        "iteration exceeded its timeout",
      );
      assert.strictEqual(harness.commandsOfType("thread.turn.interrupt").length, 1);
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "failed");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "infra:timeout");
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
      originThreadId: null,
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
          failureReason: null,
          startedAt: NOW,
          finishedAt: null,
        },
      ],
      // The provider subprocess died with the server, so the child it had
      // claimed is still `in_progress` — reconciling the abandoned iteration
      // must release it, or `bd ready` can never resurface it.
      childStatuses: { "child-0": "in_progress" },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "done");

      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "abandoned");
      assert.strictEqual(harness.store.iterations[0]?.summary, "abandoned by server restart");
      assert.strictEqual(harness.store.iterations[0]?.failureReason, "server-restart");
      assert.strictEqual(harness.childStatus("child-0"), "open");
      const releaseRequest = harness.processRequests.find(
        (request) =>
          request.command === "bd" && request.args[0] === "update" && request.args[1] === "child-0",
      )!;
      assert.deepStrictEqual(releaseRequest.args, [
        "update",
        "child-0",
        "--status",
        "open",
        "--assignee",
        "",
      ]);
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
      // Same reasoning as the cancel path: the thread the dead server left
      // behind is abandoned, so it is stopped rather than settled.
      assert.isTrue(
        harness
          .commandsOfType("thread.settle")
          .every((command) => command.threadId !== staleThreadId),
      );
      // The resumed loop picks up at the next index, not the abandoned one.
      assert.strictEqual(harness.store.iterations[1]?.iterationIndex, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.live("releases a stranded child when a restart cannot reacquire the run's lease", () => {
    // This run's loop never gets a chance to fork — the lease acquisition
    // itself fails — so its finalizer never runs. The lease-failure branch in
    // `start` has to release the run's last claimed child on its own.
    const runId = "run-lease-failure";
    const staleRun: EpicRun = {
      runId: runId as EpicRun["runId"],
      epicId: "epic-1",
      projectId,
      cwd: "/tmp/epic-runner-repo",
      prompt: "do one unit of work",
      modelSelection,
      runtimeMode: "full-access",
      originThreadId: null,
      status: "running",
      maxIterations: 10,
      iterationsCompleted: 1,
      currentThreadId: null,
      currentTurnStartedAt: null,
      consecutiveFailures: 0,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const harness = createHarness({
      script: [],
      seedRuns: [staleRun],
      seedIterations: [
        {
          runId: staleRun.runId,
          iterationIndex: 0,
          threadId: ThreadId.make(`epic-run-${runId}-0`),
          issueId: "child-0",
          turnStatus: "completed",
          summary: "done",
          why: null,
          failureReason: null,
          startedAt: NOW,
          finishedAt: NOW,
        },
      ],
      childStatuses: { "child-0": "in_progress" },
      lockAcquireError: new EpicRunLockError("lease store unavailable"),
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      yield* runner.start();
      yield* waitFor(() => harness.store.runs.get(runId)?.status === "failed");
      yield* waitFor(() => harness.childStatus("child-0") === "open");

      const releaseRequest = harness.processRequests.find(
        (request) =>
          request.command === "bd" && request.args[0] === "update" && request.args[1] === "child-0",
      )!;
      assert.deepStrictEqual(releaseRequest.args, [
        "update",
        "child-0",
        "--status",
        "open",
        "--assignee",
        "",
      ]);
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

  it.live("resumes a paused run while its iteration is still in flight", () => {
    // The window the resume used to be refused in. `pauseRun` does not
    // interrupt the turn, so the run keeps its own lock for the rest of that
    // iteration — as long as an agent turn lasts — and a resume that relaunched
    // there ran launch preflight against that lock and failed with
    // `run_in_progress`. The live loop has to be handed the run instead.
    let acquired = 0;
    const harness = createHarness({
      script: [
        { text: "work", head: "head-1" },
        // No new head: `RALPH_DONE` after a commit is a protocol violation.
        { text: "RALPH_DONE", head: "head-1" },
      ],
      // Wide enough that the pause and the resume both land inside the first
      // iteration's settle window.
      options: { quietPeriodMs: 300 },
      onLockAcquire: () => {
        acquired += 1;
      },
    });

    return Effect.gen(function* () {
      const runner = yield* EpicRunner;
      const run = yield* startRun();
      yield* waitFor(() => harness.store.iterations.length === 1);
      yield* runner.pauseRun({ runId: run.runId });
      // Pinned: the iteration this resume has to survive really is still going.
      assert.strictEqual(harness.store.iterations[0]?.turnStatus, "running");

      const resumed = yield* runner.resumeRun({ runId: run.runId });
      assert.strictEqual(resumed.status, "running");

      yield* waitFor(() => harness.store.runs.get(run.runId)?.status === "done");
      assert.strictEqual(harness.store.iterations.length, 2);
      assert.strictEqual(harness.store.iterations[1]?.iterationIndex, 1);
      // One lease and one loop for the whole run: the resume was handed to the
      // draining loop, not relaunched under a second lock.
      assert.strictEqual(acquired, 1);
      assert.strictEqual(harness.turnsStarted(), 2);
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
