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
import { VcsStatusBroadcaster, type VcsStatusPeek } from "../../vcs/VcsStatusBroadcaster.ts";
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
import { RUNNING_SUBAGENT_FRESHNESS_MS } from "../subagentLiveness.ts";
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

const WORKSPACE_ROOT = "/tmp/project-auto-settle";
/** The end-to-end project's workspace root, and the worktree one thread owns. */
const E2E_WORKSPACE_ROOT = "/tmp/project-e2e";
const E2E_WORKTREE_PATH = "/tmp/project-e2e-worktree";

const makeCandidate = (
  threadId: string,
  lastActivityAt: string,
  overrides?: {
    readonly branch?: string | null;
    readonly worktreePath?: string | null;
  },
): ProjectionAutoSettleCandidate => ({
  threadId: ThreadId.make(threadId),
  projectId: ProjectId.make("project-auto-settle"),
  lastActivityAt,
  branch: overrides?.branch ?? null,
  worktreePath: overrides?.worktreePath ?? null,
  workspaceRoot: WORKSPACE_ROOT,
});

const localOnRef = (refName: string | null): VcsStatusPeek["local"] => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
});

const remoteWithPr = (state: "open" | "merged" | "closed" | null): VcsStatusPeek["remote"] => ({
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr:
    state === null
      ? null
      : {
          number: 13,
          title: "Settle a thread when the server already sees its PR merged",
          url: "https://github.com/pingdotgg/t3code/pull/13",
          baseRef: "main",
          headRef: "feature/pr-settle",
          state,
        },
});

const isoAt = (epochMillis: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMillis));

const commandThreadId = (command: OrchestrationCommand): ThreadId | null =>
  "threadId" in command ? command.threadId : null;

interface Harness {
  /** Every idle-pass candidate read the sweep issued, in order. */
  readonly candidateReads: ReadonlyArray<{
    readonly idleBefore: string;
    readonly limit: number;
    readonly runningSubagentFreshAfter: string;
  }>;
  /** Every merged-PR-pass candidate read the sweep issued, in order. */
  readonly prCandidateReads: ReadonlyArray<{
    readonly limit: number;
    readonly runningSubagentFreshAfter: string;
  }>;
  /** Every cwd the merged-PR pass peeked at, in order. */
  readonly peekedCwds: ReadonlyArray<string>;
  /** Every command the sweep dispatched, in order. */
  readonly dispatched: ReadonlyArray<OrchestrationCommand>;
  /** Let the next scheduled sweep run to completion. */
  readonly nextSweep: Effect.Effect<void>;
}

function withHarness(
  options: {
    readonly autoSettleAfterDays: number | null;
    readonly candidates?: ReadonlyArray<ProjectionAutoSettleCandidate>;
    /**
     * Rows the merged-PR pass reads. Defaults to `candidates`, matching the
     * server: both passes read the same settleable partition, the merged-PR
     * one just without the age filter.
     */
    readonly prCandidates?: ReadonlyArray<ProjectionAutoSettleCandidate>;
    /** What the VCS status cache already holds, keyed by cwd. */
    readonly cachedStatusByCwd?: Record<string, VcsStatusPeek>;
    /** Fails the idle candidate read on the sweeps whose 1-based index is listed. */
    readonly failCandidateReadOnSweeps?: ReadonlyArray<number>;
    readonly dispatch?: (
      command: OrchestrationCommand,
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationCommandInvariantError>;
  },
  body: (harness: Harness) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const candidateReads: Array<{
      idleBefore: string;
      limit: number;
      runningSubagentFreshAfter: string;
    }> = [];
    const prCandidateReads: Array<{ limit: number; runningSubagentFreshAfter: string }> = [];
    const peekedCwds: Array<string> = [];
    const dispatched: Array<OrchestrationCommand> = [];

    const snapshotQuery = {
      listAutoSettleCandidates: (request: {
        idleBefore: string | null;
        limit: number;
        runningSubagentFreshAfter: string;
      }) =>
        Effect.suspend(() => {
          // A null cutoff is the merged-PR pass: no idle window at all.
          if (request.idleBefore === null) {
            prCandidateReads.push({
              limit: request.limit,
              runningSubagentFreshAfter: request.runningSubagentFreshAfter,
            });
            return Effect.succeed(options.prCandidates ?? options.candidates ?? []);
          }
          candidateReads.push({
            idleBefore: request.idleBefore,
            limit: request.limit,
            runningSubagentFreshAfter: request.runningSubagentFreshAfter,
          });
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

    // `Layer.mock` dies on every method this sweeper must never call, which is
    // the point of `peekStatus`: a sweep that reached `getStatus` would do real
    // network work behind a user's back.
    const vcsStatusBroadcaster = Layer.mock(VcsStatusBroadcaster)({
      peekStatus: (cwd: string) =>
        Effect.sync(() => {
          peekedCwds.push(cwd);
          return options.cachedStatusByCwd?.[cwd] ?? null;
        }),
    });

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
        prCandidateReads,
        peekedCwds,
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
              vcsStatusBroadcaster,
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
          // Both passes exclude threads with a fresh running subagent; the
          // cutoff is the shared freshness window, measured from the sweep's
          // clock.
          expect(candidateReads[0]?.runningSubagentFreshAfter).toBe(
            isoAt(Date.parse(CLOCK_START) - RUNNING_SUBAGENT_FRESHNESS_MS),
          );

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

  it.effect("stops reading idle candidates while the window is null", () =>
    withHarness(
      {
        autoSettleAfterDays: null,
        candidates: [makeCandidate("thread-idle-disabled", "2026-07-01T00:00:00.000Z")],
      },
      ({ candidateReads, prCandidateReads, dispatched, nextSweep }) =>
        Effect.gen(function* () {
          yield* nextSweep;
          yield* nextSweep;

          expect(candidateReads).toEqual([]);
          expect(dispatched).toEqual([]);
          // The merged-PR rule is not the idle rule and this setting does not
          // govern it, so that pass keeps running — it just finds no cached
          // merge here. The client's merge rule ignores the setting too.
          expect(prCandidateReads.length).toBeGreaterThan(0);
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
 * The merged-PR pass. It exists because the client shows a thread with a
 * merged change request as settled with no server event behind it, which left
 * the provider session alive under a row that reads "settled". These cases
 * pin the rule that closes that gap — and the four ways it must decline.
 */
describe("ThreadAutoSettleSweeper merged-PR pass", () => {
  const WORKTREE_PATH = "/tmp/worktree-pr-merged";

  it.effect("settles a worktree thread whose cached PR is already merged", () =>
    withHarness(
      {
        // Disabled idle window, so nothing but the merged PR can settle this.
        autoSettleAfterDays: null,
        prCandidates: [
          makeCandidate("thread-pr-merged", "2026-08-02T23:59:00.000Z", {
            branch: "feature/pr-settle",
            worktreePath: WORKTREE_PATH,
          }),
        ],
        cachedStatusByCwd: {
          // A dedicated worktree owns the cwd's PR whatever ref is checked out
          // — the same call the client's `resolveThreadPr` makes.
          [WORKTREE_PATH]: { local: localOnRef("main"), remote: remoteWithPr("merged") },
        },
      },
      ({ peekedCwds, prCandidateReads, dispatched }) =>
        Effect.sync(() => {
          expect(peekedCwds).toEqual([WORKTREE_PATH]);
          // The no-idle-window pass excludes fresh running subagents too — the
          // same cutoff as the idle pass, from the same sweep clock.
          expect(prCandidateReads[0]?.runningSubagentFreshAfter).toBe(
            isoAt(Date.parse(CLOCK_START) - RUNNING_SUBAGENT_FRESHNESS_MS),
          );
          expect(dispatched).toHaveLength(1);
          expect(dispatched[0]).toMatchObject({
            type: "thread.settle",
            threadId: ThreadId.make("thread-pr-merged"),
            commandId: CommandId.make(`thread-pr-settle:thread-pr-merged:${CLOCK_START}`),
          });
        }),
    ),
  );

  it.effect("settles a shared workspace root only while its branch is checked out", () =>
    withHarness(
      {
        autoSettleAfterDays: null,
        prCandidates: [
          makeCandidate("thread-branch-match", "2026-08-01T00:00:00.000Z", {
            branch: "feature/checked-out",
          }),
          makeCandidate("thread-branch-mismatch", "2026-08-01T00:00:00.000Z", {
            branch: "feature/somewhere-else",
          }),
          makeCandidate("thread-branch-unknown", "2026-08-01T00:00:00.000Z", { branch: null }),
        ],
        cachedStatusByCwd: {
          [WORKSPACE_ROOT]: {
            local: localOnRef("feature/checked-out"),
            remote: remoteWithPr("merged"),
          },
        },
      },
      ({ dispatched }) =>
        Effect.sync(() => {
          // Threads sharing a root also share the cwd's PR, so only the one
          // still on that branch may claim it.
          expect(dispatched.map(commandThreadId)).toEqual([ThreadId.make("thread-branch-match")]);
        }),
    ),
  );

  it.effect("leaves a change request that is open or closed alone", () =>
    withHarness(
      {
        autoSettleAfterDays: null,
        prCandidates: [
          makeCandidate("thread-pr-closed", "2026-08-01T00:00:00.000Z", {
            worktreePath: "/tmp/worktree-closed",
          }),
          makeCandidate("thread-pr-open", "2026-08-01T00:00:00.000Z", {
            worktreePath: "/tmp/worktree-open",
          }),
        ],
        cachedStatusByCwd: {
          // A closed change request can be reopened and the cache never
          // expires, so a stale "closed" must never settle anything.
          "/tmp/worktree-closed": { local: localOnRef("main"), remote: remoteWithPr("closed") },
          "/tmp/worktree-open": { local: localOnRef("main"), remote: remoteWithPr("open") },
        },
      },
      ({ peekedCwds, dispatched }) =>
        Effect.sync(() => {
          expect(peekedCwds).toEqual(["/tmp/worktree-closed", "/tmp/worktree-open"]);
          expect(dispatched).toEqual([]);
        }),
    ),
  );

  it.effect("settles nothing when the cache holds no answer for the cwd", () =>
    withHarness(
      {
        autoSettleAfterDays: null,
        prCandidates: [
          makeCandidate("thread-uncached", "2026-08-01T00:00:00.000Z", {
            worktreePath: "/tmp/worktree-uncached",
          }),
          makeCandidate("thread-local-only", "2026-08-01T00:00:00.000Z", {
            worktreePath: "/tmp/worktree-local-only",
          }),
          makeCandidate("thread-no-pr", "2026-08-01T00:00:00.000Z", {
            worktreePath: "/tmp/worktree-no-pr",
          }),
        ],
        cachedStatusByCwd: {
          // Local status loaded, remote never did: still nothing to act on,
          // and the pass must not go and fetch it.
          "/tmp/worktree-local-only": { local: localOnRef("main"), remote: null },
          "/tmp/worktree-no-pr": { local: localOnRef("main"), remote: remoteWithPr(null) },
        },
      },
      ({ peekedCwds, dispatched, nextSweep }) =>
        Effect.gen(function* () {
          expect(peekedCwds).toHaveLength(3);
          expect(dispatched).toEqual([]);

          // A cold cache is the normal case — nobody is watching most cwds —
          // so it must stay a no-op sweep after sweep.
          yield* nextSweep;
          expect(dispatched).toEqual([]);
        }),
    ),
  );

  it.effect("does not settle a thread the idle pass already settled this sweep", () =>
    withHarness(
      {
        autoSettleAfterDays: 3,
        candidates: [
          makeCandidate("thread-idle-and-merged", "2026-07-01T00:00:00.000Z", {
            worktreePath: WORKTREE_PATH,
          }),
        ],
        cachedStatusByCwd: {
          [WORKTREE_PATH]: { local: localOnRef("main"), remote: remoteWithPr("merged") },
        },
      },
      ({ dispatched }) =>
        Effect.sync(() => {
          // The projection has not caught up mid-sweep, so the row still reads
          // as a candidate. One settle is enough.
          expect(dispatched).toHaveLength(1);
          expect(dispatched[0]).toMatchObject({
            commandId: CommandId.make(`thread-auto-settle:thread-idle-and-merged:${CLOCK_START}`),
          });
        }),
    ),
  );

  it.effect("logs a refused merged-PR settle and keeps sweeping", () =>
    withHarness(
      {
        autoSettleAfterDays: null,
        prCandidates: [
          makeCandidate("thread-pr-refused", "2026-08-01T00:00:00.000Z", {
            worktreePath: WORKTREE_PATH,
          }),
          makeCandidate("thread-pr-accepted", "2026-08-01T00:00:00.000Z", {
            worktreePath: WORKTREE_PATH,
          }),
        ],
        cachedStatusByCwd: {
          [WORKTREE_PATH]: { local: localOnRef("main"), remote: remoteWithPr("merged") },
        },
        dispatch: (command) =>
          commandThreadId(command) === ThreadId.make("thread-pr-refused")
            ? Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: "thread.settle",
                  detail: "thread thread-pr-refused has an active session and cannot be settled",
                }),
              )
            : Effect.succeed({ sequence: 1 }),
      },
      ({ dispatched, nextSweep }) =>
        Effect.gen(function* () {
          // `thread.settle` refuses loudly. The refusal is ordinary traffic:
          // it must not skip the rest of the batch or kill the sweep fiber.
          expect(dispatched.map(commandThreadId)).toEqual([
            ThreadId.make("thread-pr-refused"),
            ThreadId.make("thread-pr-accepted"),
          ]);

          yield* nextSweep;

          expect(dispatched).toHaveLength(4);
          expect(new Set(dispatched.map((command) => command.commandId)).size).toBe(4);
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
  options: {
    readonly autoSettleAfterDays: number | null;
    readonly cachedStatusByCwd?: Record<string, VcsStatusPeek>;
  },
  body: (system: {
    readonly seedProject: Effect.Effect<void>;
    readonly seedIdleThread: Effect.Effect<void>;
    readonly seedWorktreeThread: Effect.Effect<void>;
    readonly sendFreshTurn: Effect.Effect<void>;
    readonly readThread: Effect.Effect<{
      readonly settledOverride: "settled" | "active" | null;
      readonly settledAt: string | null;
    } | null>;
    readonly readWorktreeThread: Effect.Effect<{
      readonly settledOverride: "settled" | "active" | null;
      readonly settledAt: string | null;
    } | null>;
    readonly startSweeper: Effect.Effect<void, never, Scope.Scope>;
  }) => Effect.Effect<void, never, Scope.Scope>,
) {
  const threadId = ThreadId.make("thread-e2e-idle");
  const worktreeThreadId = ThreadId.make("thread-e2e-worktree");
  const idleAt = "2026-07-01T00:00:00.000Z";

  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  );

  const layer = makeThreadAutoSettleSweeperLive({ sweepIntervalMs: SWEEP_INTERVAL_MS }).pipe(
    Layer.provide(
      Layer.mock(VcsStatusBroadcaster)({
        peekStatus: (cwd: string) => Effect.succeed(options.cachedStatusByCwd?.[cwd] ?? null),
      }),
    ),
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

      const seedProject = Effect.gen(function* () {
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-e2e-project"),
          projectId: ProjectId.make("project-e2e"),
          title: "Auto Settle E2E",
          workspaceRoot: E2E_WORKSPACE_ROOT,
          defaultModelSelection,
          createdAt: idleAt,
        });
      }).pipe(Effect.orDie);

      const seedIdleThread = Effect.gen(function* () {
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

      // A second thread in the same project, with its own worktree and branch:
      // the shape the merged-PR rule is written for.
      const seedWorktreeThread = Effect.gen(function* () {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-e2e-worktree-thread"),
          threadId: worktreeThreadId,
          projectId: ProjectId.make("project-e2e"),
          title: "Worktree Thread",
          modelSelection: defaultModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/e2e-pr",
          worktreePath: E2E_WORKTREE_PATH,
          createdAt: idleAt,
        });
        // Same reason as the idle thread: no activity, no candidate.
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-e2e-worktree-turn"),
          threadId: worktreeThreadId,
          message: {
            messageId: MessageId.make("message-e2e-worktree-1"),
            role: "user",
            text: "ship it",
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

      const readSettled = (id: ThreadId) =>
        snapshotQuery.getThreadShellById(id).pipe(
          Effect.map(Option.getOrNull),
          Effect.map((shell) =>
            shell === null
              ? null
              : { settledOverride: shell.settledOverride, settledAt: shell.settledAt },
          ),
          Effect.orDie,
        );

      yield* body({
        seedProject,
        seedIdleThread,
        seedWorktreeThread,
        sendFreshTurn,
        readThread: readSettled(threadId),
        readWorktreeThread: readSettled(worktreeThreadId),
        startSweeper: sweeper.start().pipe(Effect.andThen(yieldFibers)),
      });
    }).pipe(Effect.provide(layer));
  });
}

describe("ThreadAutoSettleSweeper end to end", () => {
  it.effect("settles a thread idle past the window and stamps settledAt on the projection", () =>
    withSystem({ autoSettleAfterDays: 3 }, (system) =>
      Effect.gen(function* () {
        yield* system.seedProject;
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
        yield* system.seedProject;
        yield* system.seedIdleThread;
        yield* system.startSweeper;
        yield* TestClock.adjust(Duration.millis(SWEEP_INTERVAL_MS * 3));
        yield* yieldFibers;

        expect((yield* system.readThread)?.settledOverride).toBe(null);
      }),
    ),
  );

  it.effect("settles a worktree thread on a cached merged PR with the idle window off", () =>
    withSystem(
      {
        autoSettleAfterDays: null,
        cachedStatusByCwd: {
          [E2E_WORKTREE_PATH]: { local: localOnRef("main"), remote: remoteWithPr("merged") },
        },
      },
      (system) =>
        Effect.gen(function* () {
          yield* system.seedProject;
          yield* system.seedIdleThread;
          yield* system.seedWorktreeThread;

          yield* system.startSweeper;
          yield* waitUntil(
            "the worktree thread to settle",
            system.readWorktreeThread.pipe(
              Effect.map((thread) => thread?.settledOverride === "settled"),
            ),
          );

          // A real server event, not a display trick: the projection carries
          // the settle, which is what the settle reactor needs to see before it
          // can tear the provider session down.
          expect((yield* system.readWorktreeThread)?.settledAt).toBe(CLOCK_START);
          // The idle thread shares the project but not the cwd, and the idle
          // rule is off, so it stays active.
          expect((yield* system.readThread)?.settledOverride).toBe(null);
        }),
    ),
  );

  it.effect("leaves the worktree thread active while its cached PR is only open", () =>
    withSystem(
      {
        autoSettleAfterDays: null,
        cachedStatusByCwd: {
          [E2E_WORKTREE_PATH]: { local: localOnRef("main"), remote: remoteWithPr("open") },
        },
      },
      (system) =>
        Effect.gen(function* () {
          yield* system.seedProject;
          yield* system.seedWorktreeThread;
          yield* system.startSweeper;
          yield* TestClock.adjust(Duration.millis(SWEEP_INTERVAL_MS * 3));
          yield* yieldFibers;

          expect((yield* system.readWorktreeThread)?.settledOverride).toBe(null);
        }),
    ),
  );
});
