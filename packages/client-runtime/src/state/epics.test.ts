import { EnvironmentId, EpicRun, EpicRunnerStoreError, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
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
import { createEpicsEnvironmentAtoms, epicRunChanges, latestEpicRun } from "./epics.ts";

const decodeRun = Schema.decodeUnknownSync(EpicRun);
const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const TARGET = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function run(runId: string, epicId: string, updatedAt: string, iterationsCompleted = 0): EpicRun {
  return decodeRun({
    runId,
    epicId,
    projectId: "project-1",
    cwd: "/repo",
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
  return batches.reduce<EpicRun | null>(
    (current, batch) => latestEpicRun(current, batch, epicId),
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
  it("selects the latest run for the requested epic", () => {
    const older = run("run-1", "epic-1", "2026-07-29T00:01:00.000Z", 1);
    const newer = run("run-1", "epic-1", "2026-07-29T00:02:00.000Z", 2);
    const otherEpic = run("run-2", "epic-2", "2026-07-29T00:03:00.000Z", 3);

    expect(latestEpicRun(null, [older, otherEpic, newer], "epic-1")).toEqual(newer);
    expect(latestEpicRun(newer, [older], "epic-1")).toBe(newer);
    expect(latestEpicRun(null, [otherEpic], "epic-1")).toBeNull();
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
        const observed = yield* Ref.make<ReadonlyArray<EpicRun>>([]);
        yield* epicRunChanges("epic-1").pipe(
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
        const observed = yield* Ref.make<ReadonlyArray<EpicRun>>([]);
        yield* epicRunChanges("epic-1").pipe(
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

        const error = yield* epicRunChanges("epic-1").pipe(
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
      input: { epicId: "epic-1" },
    };
    const listAtom = epics.list(listTarget);
    const runAtom = epics.run(runTarget);

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
        input: { epicId: "epic-2" },
      }),
    ).not.toBe(runAtom);
    expect(listAtom.idleTTL).toBe(5 * 60_000);
    expect(runAtom.idleTTL).toBe(5 * 60_000);
    expect(listAtom.label?.[0]).toContain("environment-data:epics:list");
    expect(runAtom.label?.[0]).toContain("environment-data:epics:run");
  });
});
