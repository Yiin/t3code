import { EnvironmentId, EpicRun, EpicRunnerStoreError, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  activeEpicRunForThread,
  createEpicsEnvironmentAtoms,
  epicRunChanges,
  latestEpicRun,
  mergeEpicRuns,
} from "./epics.ts";

const decodeRun = Schema.decodeUnknownSync(EpicRun);
const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const TARGET = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function run(
  runId: string,
  epicId: string,
  updatedAt: string,
  iterationsCompleted = 0,
  identity: { readonly projectId?: string; readonly cwd?: string } = {},
): EpicRun {
  return decodeRun({
    runId,
    epicId,
    projectId: identity.projectId ?? "project-1",
    cwd: identity.cwd ?? "/repo",
    prompt: "Cook one child.",
    modelSelection: {
      provider: "codex",
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    status: "running",
    maxIterations: 10,
    iterationsCompleted,
    currentThreadId: null,
    currentTurnStartedAt: null,
    consecutiveFailures: 0,
    lastError: null,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt,
  });
}

function fold(epicId: string, batches: ReadonlyArray<ReadonlyArray<EpicRun>>) {
  const identity = { epicId, projectId: "project-1", cwd: "/repo" };
  return batches.reduce<EpicRun | null>(
    (current, batch) => latestEpicRun(current, batch, identity),
    null,
  );
}

function session<E>(
  seed: Effect.Effect<ReadonlyArray<EpicRun>, E>,
  events: Queue.Dequeue<{
    readonly version: 1;
    readonly type: "run-state-changed";
    readonly run: EpicRun;
  }>,
  listCalls: Ref.Ref<number>,
  subscriptionCalls: Ref.Ref<number>,
): RpcSession {
  const client = {
    [WS_METHODS.epicRunList]: () =>
      Ref.update(listCalls, (count) => count + 1).pipe(Effect.andThen(seed)),
    [WS_METHODS.subscribeEpicRuns]: () =>
      Stream.unwrap(
        Ref.update(subscriptionCalls, (count) => count + 1).pipe(
          Effect.as(Stream.fromQueue(events)),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function waitFor(ref: Ref.Ref<number>, expected: number) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100 && (yield* Ref.get(ref)) < expected; attempt += 1) {
      yield* Effect.yieldNow;
    }
    expect(yield* Ref.get(ref)).toBe(expected);
  });
}

describe("epic run folding", () => {
  it("monotonically merges seeds and live changes without dropping known runs", () => {
    const first = run("run-1", "epic-1", "2026-07-29T00:01:00.000Z", 1);
    const second = run("run-2", "epic-2", "2026-07-29T00:02:00.000Z", 1);
    const updated = run("run-1", "epic-1", "2026-07-29T00:03:00.000Z", 2);
    const seeded = mergeEpicRuns([], [first, second]);

    expect(mergeEpicRuns(seeded, [first])).toBe(seeded);
    expect(mergeEpicRuns(seeded, [updated])).toEqual([updated, second]);
    expect(mergeEpicRuns(mergeEpicRuns(seeded, [updated]), [first])).toEqual([updated, second]);
  });

  it("does not arbitrarily replace equal-timestamp values", () => {
    const lower = run("run-1", "epic-1", "2026-07-29T00:01:00.000Z", 1);
    const higher = run("run-1", "epic-1", "2026-07-29T00:01:00.000Z", 2);

    expect(mergeEpicRuns(mergeEpicRuns([], [lower]), [higher])).toEqual([lower]);
    expect(mergeEpicRuns(mergeEpicRuns([], [higher]), [lower])).toEqual([higher]);
  });

  it.effect("prefers equal-time live cancellation when the seed arrives first", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const timestamp = "2026-07-29T00:01:00.000Z";
        const seeded = run("run-1", "epic-1", timestamp, 1);
        const cancelled = decodeRun({ ...seeded, status: "cancelled" });
        const events = yield* Queue.unbounded<{
          readonly version: 1;
          readonly type: "run-state-changed";
          readonly run: EpicRun;
        }>();
        const listCalls = yield* Ref.make(0);
        const subscriptionCalls = yield* Ref.make(0);
        const sessionRef = yield* SubscriptionRef.make(
          Option.some(session(Effect.succeed([seeded]), events, listCalls, subscriptionCalls)),
        );
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: sessionRef,
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const observed = yield* Ref.make<ReadonlyArray<EpicRun | null>>([]);
        yield* epicRunChanges({ epicId: "epic-1", projectId: "project-1", cwd: "/repo" }).pipe(
          Stream.runForEach((value) => Ref.update(observed, (values) => [...values, value])),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* waitFor(listCalls, 1);
        yield* Queue.offer(events, { version: 1, type: "run-state-changed", run: cancelled });
        for (
          let attempt = 0;
          attempt < 100 && (yield* Ref.get(observed)).at(-1)?.status !== "cancelled";
          attempt += 1
        ) {
          yield* Effect.yieldNow;
        }
        expect((yield* Ref.get(observed)).at(-1)?.status).toBe("cancelled");
      }),
    ),
  );

  it.effect("does not let an equal-time reconnect seed revive a live cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const timestamp = "2026-07-29T00:01:00.000Z";
        const seeded = run("run-1", "epic-1", timestamp, 1);
        const cancelled = decodeRun({ ...seeded, status: "cancelled" });
        const seedReady = yield* Deferred.make<void>();
        const seedCompleted = yield* Deferred.make<void>();
        const events = yield* Queue.unbounded<{
          readonly version: 1;
          readonly type: "run-state-changed";
          readonly run: EpicRun;
        }>();
        const listCalls = yield* Ref.make(0);
        const subscriptionCalls = yield* Ref.make(0);
        const sessionRef = yield* SubscriptionRef.make(
          Option.some(
            session(
              Deferred.await(seedReady).pipe(
                Effect.as([seeded]),
                Effect.tap(() => Deferred.succeed(seedCompleted, undefined)),
              ),
              events,
              listCalls,
              subscriptionCalls,
            ),
          ),
        );
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: sessionRef,
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const observed = yield* Ref.make<ReadonlyArray<EpicRun | null>>([]);
        yield* epicRunChanges({ epicId: "epic-1", projectId: "project-1", cwd: "/repo" }).pipe(
          Stream.runForEach((value) => Ref.update(observed, (values) => [...values, value])),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* waitFor(subscriptionCalls, 1);
        yield* Queue.offer(events, { version: 1, type: "run-state-changed", run: cancelled });
        yield* Deferred.succeed(seedReady, undefined);
        yield* Deferred.await(seedCompleted);
        for (
          let attempt = 0;
          attempt < 100 && (yield* Ref.get(observed)).at(-1)?.status !== "cancelled";
          attempt += 1
        ) {
          yield* Effect.yieldNow;
        }
        expect((yield* Ref.get(observed)).at(-1)?.status).toBe("cancelled");
      }),
    ),
  );

  it("resolves active cooking threads from currentThreadId or bounded references", () => {
    const current = decodeRun({
      ...run("run-1", "epic-1", "2026-07-29T00:01:00.000Z"),
      currentThreadId: "thread-current",
    });
    const referenced = decodeRun({
      ...run("run-2", "epic-2", "2026-07-29T00:02:00.000Z"),
      threadRefs: [{ issueId: "issue-1", threadId: "thread-ref", iterationIndex: 0 }],
    });
    const finished = decodeRun({
      ...run("run-3", "epic-3", "2026-07-29T00:03:00.000Z"),
      status: "done",
      currentThreadId: "thread-finished",
    });

    expect(activeEpicRunForThread([current, referenced, finished], "thread-current")).toBe(current);
    expect(activeEpicRunForThread([current, referenced, finished], "thread-ref")).toBe(referenced);
    expect(activeEpicRunForThread([current, referenced, finished], "thread-finished")).toBeNull();
  });

  it("selects the latest run for the requested epic", () => {
    const older = run("run-1", "epic-1", "2026-07-29T00:01:00.000Z", 1);
    const newer = run("run-1", "epic-1", "2026-07-29T00:02:00.000Z", 2);
    const otherEpic = run("run-2", "epic-2", "2026-07-29T00:03:00.000Z", 3);

    const identity = { epicId: "epic-1", projectId: "project-1", cwd: "/repo" };
    expect(latestEpicRun(null, [older, otherEpic, newer], identity)).toEqual(newer);
    expect(latestEpicRun(newer, [older], identity)).toBe(newer);
    expect(latestEpicRun(null, [otherEpic], identity)).toBeNull();
  });

  it("does not carry a run across project or workspace identity", () => {
    const current = run("run-1", "epic-1", "2026-07-29T00:02:00.000Z");
    expect(
      latestEpicRun(current, [], { epicId: "epic-1", projectId: "project-2", cwd: "/repo" }),
    ).toBeNull();
    expect(
      latestEpicRun(current, [], { epicId: "epic-1", projectId: "project-1", cwd: "/other" }),
    ).toBeNull();
  });

  it("is independent of list-seed and live-event ordering", () => {
    const seed = run("run-1", "epic-1", "2026-07-29T00:01:00.000Z", 1);
    const live = run("run-1", "epic-1", "2026-07-29T00:02:00.000Z", 2);

    expect(fold("epic-1", [[seed], [live]])).toEqual(live);
    expect(fold("epic-1", [[live], [seed]])).toEqual(live);
  });

  it("rebuilds the same latest state when a reconnect seed covers a missed event", () => {
    const initial = run("run-1", "epic-1", "2026-07-29T00:01:00.000Z", 1);
    const missed = run("run-1", "epic-1", "2026-07-29T00:02:00.000Z", 2);
    const afterReconnect = run("run-1", "epic-1", "2026-07-29T00:03:00.000Z", 3);

    const uninterrupted = fold("epic-1", [[initial], [missed], [afterReconnect]]);
    const replayedAfterGap = fold("epic-1", [[initial], [missed, afterReconnect]]);

    expect(replayedAfterGap).toEqual(uninterrupted);
    expect(replayedAfterGap).toEqual(afterReconnect);
  });

  it.effect("seeds and subscribes exactly once per session across reconnects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initial = run("run-1", "epic-1", "2026-07-29T00:01:00.000Z", 1);
        const live = run("run-1", "epic-1", "2026-07-29T00:02:00.000Z", 2);
        const missed = run("run-1", "epic-1", "2026-07-29T00:03:00.000Z", 3);
        const afterReconnect = run("run-1", "epic-1", "2026-07-29T00:04:00.000Z", 4);
        const listCalls = yield* Ref.make(0);
        const subscriptionCalls = yield* Ref.make(0);
        const firstEvents = yield* Queue.unbounded<{
          readonly version: 1;
          readonly type: "run-state-changed";
          readonly run: EpicRun;
        }>();
        const secondEvents = yield* Queue.unbounded<{
          readonly version: 1;
          readonly type: "run-state-changed";
          readonly run: EpicRun;
        }>();
        const firstSession = session(
          Effect.succeed([initial]),
          firstEvents,
          listCalls,
          subscriptionCalls,
        );
        const secondSession = session(
          Effect.succeed([missed]),
          secondEvents,
          listCalls,
          subscriptionCalls,
        );
        const sessionRef = yield* SubscriptionRef.make(Option.some(firstSession));
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: sessionRef,
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const observed = yield* Ref.make<ReadonlyArray<EpicRun | null>>([]);
        yield* epicRunChanges({ epicId: "epic-1", projectId: "project-1", cwd: "/repo" }).pipe(
          Stream.runForEach((value) => Ref.update(observed, (values) => [...values, value])),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );

        yield* waitFor(listCalls, 1);
        yield* waitFor(subscriptionCalls, 1);
        yield* Queue.offer(firstEvents, { version: 1, type: "run-state-changed", run: live });
        for (
          let attempt = 0;
          attempt < 100 && (yield* Ref.get(observed)).at(-1)?.updatedAt !== live.updatedAt;
          attempt += 1
        ) {
          yield* Effect.yieldNow;
        }
        expect((yield* Ref.get(observed)).at(-1)).toEqual(live);

        yield* SubscriptionRef.set(sessionRef, Option.some(secondSession));
        yield* waitFor(listCalls, 2);
        yield* waitFor(subscriptionCalls, 2);
        yield* Queue.offer(secondEvents, {
          version: 1,
          type: "run-state-changed",
          run: afterReconnect,
        });
        for (
          let attempt = 0;
          attempt < 100 &&
          (yield* Ref.get(observed)).at(-1)?.updatedAt !== afterReconnect.updatedAt;
          attempt += 1
        ) {
          yield* Effect.yieldNow;
        }

        expect((yield* Ref.get(observed)).at(-1)).toEqual(afterReconnect);
        expect(yield* Ref.get(listCalls)).toBe(2);
        expect(yield* Ref.get(subscriptionCalls)).toBe(2);
      }),
    ),
  );

  it.effect("filters mismatched seed rows and live events by the full run identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const matchingSeed = run("matching-seed", "epic-1", "2026-07-29T00:01:00.000Z");
        const wrongProject = run("wrong-project", "epic-1", "2026-07-29T00:09:00.000Z", 0, {
          projectId: "project-2",
        });
        const wrongCwd = run("wrong-cwd", "epic-1", "2026-07-29T00:10:00.000Z", 0, {
          cwd: "/other",
        });
        const wrongEpic = run("wrong-epic", "epic-2", "2026-07-29T00:11:00.000Z");
        const matchingLive = run("matching-live", "epic-1", "2026-07-29T00:12:00.000Z");
        const listCalls = yield* Ref.make(0);
        const subscriptionCalls = yield* Ref.make(0);
        const events = yield* Queue.unbounded<{
          readonly version: 1;
          readonly type: "run-state-changed";
          readonly run: EpicRun;
        }>();
        const rpcSession = session(
          Effect.succeed([wrongProject, wrongCwd, wrongEpic, matchingSeed]),
          events,
          listCalls,
          subscriptionCalls,
        );
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some(rpcSession)),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const observed = yield* Ref.make<ReadonlyArray<EpicRun | null>>([]);
        yield* epicRunChanges({ epicId: "epic-1", projectId: "project-1", cwd: "/repo" }).pipe(
          Stream.runForEach((value) => Ref.update(observed, (values) => [...values, value])),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* waitFor(listCalls, 1);
        for (const candidate of [wrongProject, wrongCwd, wrongEpic]) {
          yield* Queue.offer(events, {
            version: 1,
            type: "run-state-changed",
            run: candidate,
          });
        }
        for (let attempt = 0; attempt < 100; attempt += 1) {
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(observed)).toEqual([matchingSeed]);

        yield* Queue.offer(events, {
          version: 1,
          type: "run-state-changed",
          run: matchingLive,
        });
        for (
          let attempt = 0;
          attempt < 100 && (yield* Ref.get(observed)).length < 2;
          attempt += 1
        ) {
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(observed)).toEqual([matchingSeed, matchingLive]);
      }),
    ),
  );

  it.effect("emits initialized idle state when no run exists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const listCalls = yield* Ref.make(0);
        const subscriptionCalls = yield* Ref.make(0);
        const events = yield* Queue.unbounded<{
          readonly version: 1;
          readonly type: "run-state-changed";
          readonly run: EpicRun;
        }>();
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(
            Option.some(session(Effect.succeed([]), events, listCalls, subscriptionCalls)),
          ),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const observed = yield* Ref.make<ReadonlyArray<EpicRun | null>>([]);
        yield* epicRunChanges({ epicId: "epic-1", projectId: "project-1", cwd: "/repo" }).pipe(
          Stream.runForEach((value) => Ref.update(observed, (values) => [...values, value])),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* waitFor(listCalls, 1);
        for (
          let attempt = 0;
          attempt < 100 && (yield* Ref.get(observed)).length === 0;
          attempt += 1
        ) {
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(observed)).toEqual([null]);
      }),
    ),
  );

  it.effect("survives a seed transport failure and reseeds on the next session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const live = run("run-1", "epic-1", "2026-07-29T00:02:00.000Z", 2);
        const reseeded = run("run-1", "epic-1", "2026-07-29T00:03:00.000Z", 3);
        const listCalls = yield* Ref.make(0);
        const subscriptionCalls = yield* Ref.make(0);
        const firstEvents = yield* Queue.unbounded<{
          readonly version: 1;
          readonly type: "run-state-changed";
          readonly run: EpicRun;
        }>();
        const secondEvents = yield* Queue.unbounded<{
          readonly version: 1;
          readonly type: "run-state-changed";
          readonly run: EpicRun;
        }>();
        const transportFailure = new RpcClientError.RpcClientError({
          reason: new RpcClientError.RpcClientDefect({
            message: "socket closed",
            cause: new Error("socket closed"),
          }),
        });
        const firstSession = session(
          Effect.fail(transportFailure),
          firstEvents,
          listCalls,
          subscriptionCalls,
        );
        const secondSession = session(
          Effect.succeed([reseeded]),
          secondEvents,
          listCalls,
          subscriptionCalls,
        );
        const sessionRef = yield* SubscriptionRef.make(Option.some(firstSession));
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: sessionRef,
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const observed = yield* Ref.make<ReadonlyArray<EpicRun | null>>([]);
        yield* epicRunChanges({ epicId: "epic-1", projectId: "project-1", cwd: "/repo" }).pipe(
          Stream.runForEach((value) => Ref.update(observed, (values) => [...values, value])),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );

        yield* waitFor(listCalls, 1);
        yield* waitFor(subscriptionCalls, 1);
        yield* Queue.offer(firstEvents, { version: 1, type: "run-state-changed", run: live });
        for (
          let attempt = 0;
          attempt < 100 && (yield* Ref.get(observed)).at(-1)?.updatedAt !== live.updatedAt;
          attempt += 1
        ) {
          yield* Effect.yieldNow;
        }
        expect((yield* Ref.get(observed)).at(-1)).toEqual(live);

        yield* SubscriptionRef.set(sessionRef, Option.some(secondSession));
        yield* waitFor(listCalls, 2);
        yield* waitFor(subscriptionCalls, 2);
        for (
          let attempt = 0;
          attempt < 100 && (yield* Ref.get(observed)).at(-1)?.updatedAt !== reseeded.updatedAt;
          attempt += 1
        ) {
          yield* Effect.yieldNow;
        }
        expect((yield* Ref.get(observed)).at(-1)).toEqual(reseeded);
      }),
    ),
  );

  it.effect("does not swallow a seed domain failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const listCalls = yield* Ref.make(0);
        const subscriptionCalls = yield* Ref.make(0);
        const events = yield* Queue.unbounded<{
          readonly version: 1;
          readonly type: "run-state-changed";
          readonly run: EpicRun;
        }>();
        const failure = new EpicRunnerStoreError({ operation: "list" });
        const activeSession = session(Effect.fail(failure), events, listCalls, subscriptionCalls);
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some(activeSession)),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);

        const error = yield* epicRunChanges({
          epicId: "epic-1",
          projectId: "project-1",
          cwd: "/repo",
        }).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.flip,
        );

        expect(error).toBe(failure);
      }),
    ),
  );
});

describe("createEpicsEnvironmentAtoms", () => {
  it("keys list and run atoms with five-minute retention and stable labels", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const epics = createEpicsEnvironmentAtoms(runtime);
    const listTarget = {
      environmentId: ENVIRONMENT_ID,
      input: { workspaceRoot: "/repo" },
    };
    const runTarget = {
      environmentId: ENVIRONMENT_ID,
      input: { epicId: "epic-1", projectId: "project-1", cwd: "/repo" },
    };
    const listAtom = epics.list(listTarget);
    const runAtom = epics.run(runTarget);
    const latestRunAtom = epics.latestRun(runTarget);
    const allRunsAtom = epics.allRuns({ environmentId: ENVIRONMENT_ID, input: {} });
    const threadRunAtom = epics.activeRunForThread({
      environmentId: ENVIRONMENT_ID,
      input: { threadId: "thread-1" },
    });

    expect(epics.list({ ...listTarget, input: { ...listTarget.input } })).toBe(listAtom);
    expect(
      epics.list({
        environmentId: ENVIRONMENT_ID,
        input: { workspaceRoot: "/other" },
      }),
    ).not.toBe(listAtom);
    expect(epics.run({ ...runTarget, input: { ...runTarget.input } })).toBe(runAtom);
    expect(
      epics.run({
        environmentId: ENVIRONMENT_ID,
        input: { epicId: "epic-2", projectId: "project-1", cwd: "/repo" },
      }),
    ).not.toBe(runAtom);
    expect(listAtom.idleTTL).toBe(5 * 60_000);
    expect(runAtom.idleTTL).toBe(5 * 60_000);
    expect(latestRunAtom.idleTTL).toBe(5 * 60_000);
    expect(allRunsAtom.idleTTL).toBe(5 * 60_000);
    expect(threadRunAtom.idleTTL).toBe(5 * 60_000);
    expect(listAtom.label?.[0]).toContain("environment-data:epics:list");
    expect(runAtom.label?.[0]).toContain("environment-data:epics:run");
    expect(latestRunAtom.label?.[0]).toContain("environment-data:epics:latest-run");
    expect(allRunsAtom.label?.[0]).toContain("environment-data:epics:all-runs");
    expect(threadRunAtom.label?.[0]).toContain("environment-data:epics:active-run-for-thread");
  });
});
