import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionAutoSettleCandidate,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadAutoSettleSweeper } from "../Services/ThreadAutoSettleSweeper.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { makeThreadAutoSettleSweeperLive } from "./ThreadAutoSettleSweeper.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const SWEEP_INTERVAL_MS = 1_000;
/** Where the test clock starts, so every derived cutoff is a readable date. */
const CLOCK_START = "2026-08-03T00:00:00.000Z";

const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

/**
 * The sweep runs on a forked fiber and hands work to the engine's dispatch
 * queue, so every step here is scheduler-driven rather than clock-driven: yield
 * until the expectation holds. Only the interval between sweeps needs the
 * clock, and that is `nextSweep`.
 */
const yieldFibers = Effect.forEach(Array.from({ length: 40 }), () => Effect.yieldNow, {
  discard: true,
});

const waitUntil = <E, R>(label: string, predicate: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (yield* predicate) {
        return;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${label}`));
  });

const makeCandidate = (
  threadId: string,
  lastActivityAt: string,
): ProjectionAutoSettleCandidate => ({
  threadId: ThreadId.make(threadId),
  projectId: ProjectId.make("project-auto-settle"),
  lastActivityAt,
});

const isoAt = (epochMillis: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMillis));

const commandThreadId = (command: OrchestrationCommand): ThreadId | null =>
  "threadId" in command ? command.threadId : null;

interface Harness {
  /** Every candidate read the sweep issued, in order. */
  readonly candidateReads: ReadonlyArray<{ readonly idleBefore: string; readonly limit: number }>;
  /** Every command the sweep dispatched, in order. */
  readonly dispatched: ReadonlyArray<OrchestrationCommand>;
  /** Let the next scheduled sweep run to completion. */
  readonly nextSweep: Effect.Effect<void>;
}

function withHarness(
  options: {
    readonly autoSettleAfterDays: number | null;
    readonly candidates?: ReadonlyArray<ProjectionAutoSettleCandidate>;
    /** Fails the candidate read on the sweeps whose 1-based index is listed. */
    readonly failCandidateReadOnSweeps?: ReadonlyArray<number>;
    readonly dispatch?: (
      command: OrchestrationCommand,
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationCommandInvariantError>;
  },
  body: (harness: Harness) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const candidateReads: Array<{ idleBefore: string; limit: number }> = [];
    const dispatched: Array<OrchestrationCommand> = [];

    const snapshotQuery = {
      listAutoSettleCandidates: (request: { idleBefore: string; limit: number }) =>
        Effect.suspend(() => {
          candidateReads.push(request);
          if (options.failCandidateReadOnSweeps?.includes(candidateReads.length) === true) {
            return Effect.fail(
              new PersistenceSqlError({
                operation: "test.listAutoSettleCandidates",
                detail: "candidate read exploded",
              }),
            );
          }
          return Effect.succeed(options.candidates ?? []);
        }),
    } as unknown as ProjectionSnapshotQueryShape;

    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) => {
        dispatched.push(command);
        return options.dispatch === undefined
          ? Effect.succeed({ sequence: dispatched.length })
          : options.dispatch(command);
      },
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    } as unknown as OrchestrationEngineShape;

    yield* TestClock.setTime(Date.parse(CLOCK_START));

    yield* Effect.gen(function* () {
      const sweeper = yield* ThreadAutoSettleSweeper;
      yield* sweeper.start();
      // The repeat schedule runs the first sweep immediately.
      yield* yieldFibers;

      yield* body({
        candidateReads,
        dispatched,
        nextSweep: TestClock.adjust(Duration.millis(SWEEP_INTERVAL_MS)).pipe(
          Effect.andThen(yieldFibers),
        ),
      });
    }).pipe(
      Effect.provide(
        makeThreadAutoSettleSweeperLive({ sweepIntervalMs: SWEEP_INTERVAL_MS }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
              Layer.succeed(OrchestrationEngineService, engine),
              ServerSettings.layerTest({
                threadAutoSettleAfterDays: options.autoSettleAfterDays,
              }),
            ),
          ),
        ),
      ),
    );
  });
}

describe("ThreadAutoSettleSweeper", () => {
  it.effect("settles every idle candidate with a cutoff taken from the configured window", () =>
    withHarness(
      {
        autoSettleAfterDays: 3,
        candidates: [
          makeCandidate("thread-idle-a", "2026-07-01T00:00:00.000Z"),
          makeCandidate("thread-idle-b", "2026-07-02T00:00:00.000Z"),
        ],
      },
      ({ candidateReads, dispatched }) =>
        Effect.sync(() => {
          expect(candidateReads).toHaveLength(1);
          // Three days before the clock, so a thread must stay idle for the
          // whole window before it is read as a candidate at all.
          expect(candidateReads[0]?.idleBefore).toBe(isoAt(Date.parse(CLOCK_START) - 3 * DAY_MS));
          expect(candidateReads[0]?.limit).toBeGreaterThan(0);

          expect(dispatched).toHaveLength(2);
          expect(dispatched[0]).toMatchObject({
            type: "thread.settle",
            threadId: ThreadId.make("thread-idle-a"),
            commandId: CommandId.make(`thread-auto-settle:thread-idle-a:${CLOCK_START}`),
          });
          expect(dispatched[1]).toMatchObject({
            type: "thread.settle",
            threadId: ThreadId.make("thread-idle-b"),
          });
        }),
    ),
  );

  it.effect("widens the cutoff when the window setting is longer", () =>
    withHarness({ autoSettleAfterDays: 30 }, ({ candidateReads }) =>
      Effect.sync(() => {
        expect(candidateReads[0]?.idleBefore).toBe(isoAt(Date.parse(CLOCK_START) - 30 * DAY_MS));
      }),
    ),
  );

  it.effect("does not read or settle anything while the window is null", () =>
    withHarness(
      {
        autoSettleAfterDays: null,
        candidates: [makeCandidate("thread-idle-disabled", "2026-07-01T00:00:00.000Z")],
      },
      ({ candidateReads, dispatched, nextSweep }) =>
        Effect.gen(function* () {
          yield* nextSweep;
          yield* nextSweep;

          expect(candidateReads).toEqual([]);
          expect(dispatched).toEqual([]);
        }),
    ),
  );

  it.effect("finishes the batch and retries next sweep when the decider refuses a settle", () =>
    withHarness(
      {
        autoSettleAfterDays: 3,
        candidates: [
          makeCandidate("thread-refused", "2026-07-01T00:00:00.000Z"),
          makeCandidate("thread-accepted", "2026-07-02T00:00:00.000Z"),
        ],
        dispatch: (command) =>
          commandThreadId(command) === ThreadId.make("thread-refused")
            ? Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: "thread.settle",
                  detail: "thread thread-refused has an active session and cannot be settled",
                }),
              )
            : Effect.succeed({ sequence: 1 }),
      },
      ({ dispatched, nextSweep }) =>
        Effect.gen(function* () {
          // A refusal is ordinary traffic: it must not skip the rest of the
          // batch, and it must not kill the sweep fiber.
          expect(dispatched.map(commandThreadId)).toEqual([
            ThreadId.make("thread-refused"),
            ThreadId.make("thread-accepted"),
          ]);

          yield* nextSweep;

          expect(dispatched).toHaveLength(4);
          // A fresh command id per sweep, so the receipt of the rejected
          // command cannot make one refusal permanent.
          expect(new Set(dispatched.map((command) => command.commandId)).size).toBe(4);
        }),
    ),
  );

  it.effect("keeps sweeping after a candidate read fails", () =>
    withHarness(
      {
        autoSettleAfterDays: 3,
        failCandidateReadOnSweeps: [1],
        candidates: [makeCandidate("thread-after-failure", "2026-07-01T00:00:00.000Z")],
      },
      ({ candidateReads, dispatched, nextSweep }) =>
        Effect.gen(function* () {
          expect(candidateReads).toHaveLength(1);
          expect(dispatched).toEqual([]);

          yield* nextSweep;

          expect(candidateReads).toHaveLength(2);
          expect(dispatched.map(commandThreadId)).toEqual([ThreadId.make("thread-after-failure")]);
        }),
    ),
  );
});

/**
 * The real engine, the real decider, the real projection and the real sweeper
 * over an in-memory database. No client is connected, which is the point: the
 * settled state has to become real server-side, and the settle reactor only
 * sees it if a genuine `thread.settled` event is emitted.
 */
function withSystem(
  options: { readonly autoSettleAfterDays: number | null },
  body: (system: {
    readonly seedIdleThread: Effect.Effect<void>;
    readonly sendFreshTurn: Effect.Effect<void>;
    readonly readThread: Effect.Effect<{
      readonly settledOverride: "settled" | "active" | null;
      readonly settledAt: string | null;
    } | null>;
    readonly startSweeper: Effect.Effect<void, never, Scope.Scope>;
  }) => Effect.Effect<void, never, Scope.Scope>,
) {
  const threadId = ThreadId.make("thread-e2e-idle");
  const idleAt = "2026-07-01T00:00:00.000Z";

  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  );

  const layer = makeThreadAutoSettleSweeperLive({ sweepIntervalMs: SWEEP_INTERVAL_MS }).pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(
      ServerSettings.layerTest({ threadAutoSettleAfterDays: options.autoSettleAfterDays }),
    ),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-auto-settle-sweeper-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(CLOCK_START));

    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sweeper = yield* ThreadAutoSettleSweeper;

      const seedIdleThread = Effect.gen(function* () {
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-e2e-project"),
          projectId: ProjectId.make("project-e2e"),
          title: "Auto Settle E2E",
          workspaceRoot: "/tmp/project-e2e",
          defaultModelSelection,
          createdAt: idleAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-e2e-thread"),
          threadId,
          projectId: ProjectId.make("project-e2e"),
          title: "Idle Thread",
          modelSelection: defaultModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: idleAt,
        });
        // A thread nobody ever talked to has no last-activity timestamp and is
        // never auto-settled, so the idle thread needs one real turn.
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-e2e-turn"),
          threadId,
          message: {
            messageId: MessageId.make("message-e2e-1"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: idleAt,
        });
      }).pipe(Effect.orDie);

      const sendFreshTurn = Effect.gen(function* () {
        const now = yield* Effect.map(Clock.currentTimeMillis, isoAt);
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-e2e-turn-2"),
          threadId,
          message: {
            messageId: MessageId.make("message-e2e-2"),
            role: "user",
            text: "one more thing",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        });
      }).pipe(Effect.orDie);

      const readThread = snapshotQuery.getThreadShellById(threadId).pipe(
        Effect.map(Option.getOrNull),
        Effect.map((shell) =>
          shell === null
            ? null
            : { settledOverride: shell.settledOverride, settledAt: shell.settledAt },
        ),
        Effect.orDie,
      );

      yield* body({
        seedIdleThread,
        sendFreshTurn,
        readThread,
        startSweeper: sweeper.start().pipe(Effect.andThen(yieldFibers)),
      });
    }).pipe(Effect.provide(layer));
  });
}

describe("ThreadAutoSettleSweeper end to end", () => {
  it.effect("settles a thread idle past the window and stamps settledAt on the projection", () =>
    withSystem({ autoSettleAfterDays: 3 }, (system) =>
      Effect.gen(function* () {
        yield* system.seedIdleThread;
        expect((yield* system.readThread)?.settledOverride).toBe(null);

        yield* system.startSweeper;
        yield* waitUntil(
          "the thread to settle",
          system.readThread.pipe(Effect.map((thread) => thread?.settledOverride === "settled")),
        );

        const settled = yield* system.readThread;
        expect(settled?.settledAt).toBe(CLOCK_START);

        // Activity un-settles: auto-settle and the decider's activity rule must
        // not fight over a thread the user comes back to.
        yield* system.sendFreshTurn;
        const revived = yield* system.readThread;
        expect(revived?.settledOverride).toBe(null);
        expect(revived?.settledAt).toBe(null);
      }),
    ),
  );

  it.effect("leaves an idle thread alone while the window is null", () =>
    withSystem({ autoSettleAfterDays: null }, (system) =>
      Effect.gen(function* () {
        yield* system.seedIdleThread;
        yield* system.startSweeper;
        yield* TestClock.adjust(Duration.millis(SWEEP_INTERVAL_MS * 3));
        yield* yieldFibers;

        expect((yield* system.readThread)?.settledOverride).toBe(null);
      }),
    ),
  );
});
