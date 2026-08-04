/**
 * Regression net for the reconcile-time half of the session teardown map.
 *
 * `ProviderInstanceRegistryMutator.reconcile` closes the scope of every
 * removed or replaced provider instance, which kills the sessions on it
 * through the driver's finalizers and writes nothing. This layer is what
 * makes those sessions land on a `stopped` binding, a revoked MCP credential,
 * and a projected session that no longer claims a live provider — by routing
 * each one through the same `thread.session.stop` command the stop button and
 * `ThreadTeardownReactor` use.
 *
 * The tests here pin the two properties reconcile depends on: it stops
 * exactly the threads on the doomed instances, and it does not return until
 * each of those sessions really reports stopped. Sibling coverage for what
 * the command then does lives in `ProviderCommandReactor.test.ts`
 * ("stops the provider session on thread.session.stop").
 */
import type { OrchestrationCommand, OrchestrationSession } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  ProviderInstanceTeardown,
  type ProviderInstanceTeardownShape,
} from "../../provider/Services/ProviderInstanceTeardown.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBindingWithMetadata,
  type ProviderSessionDirectoryShape,
} from "../../provider/Services/ProviderSessionDirectory.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceTeardownLive } from "./ProviderInstanceTeardown.ts";

const now = "2026-08-04T00:00:00.000Z";

const doomedInstance = ProviderInstanceId.make("codex_doomed");
const survivingInstance = ProviderInstanceId.make("codex_surviving");

const binding = (
  threadId: string,
  overrides: {
    readonly status?: ProviderRuntimeBindingWithMetadata["status"];
    readonly providerInstanceId?: ProviderInstanceId;
    /** Legacy row that never recorded which instance owned the session. */
    readonly unbound?: boolean;
  },
): ProviderRuntimeBindingWithMetadata => {
  const instanceId = overrides.providerInstanceId ?? doomedInstance;
  return {
    threadId: ThreadId.make(threadId),
    provider: ProviderDriverKind.make("codex"),
    ...(overrides.unbound === true ? {} : { providerInstanceId: instanceId }),
    status: overrides.status ?? "running",
    lastSeenAt: now,
  };
};

const session = (threadId: ThreadId, status: OrchestrationSession["status"]) =>
  ({
    threadId,
    status,
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: now,
  }) satisfies OrchestrationSession;

interface Harness {
  /** Commands the layer dispatched, in order. */
  readonly dispatched: ReadonlyArray<OrchestrationCommand>;
  /** How many times each thread's projected session was read. */
  readonly polls: ReadonlyMap<ThreadId, number>;
}

function withHarness(
  options: {
    readonly bindings: ReadonlyArray<ProviderRuntimeBindingWithMetadata>;
    /**
     * How many reads of a thread's projected session still report a live
     * session before it flips to `stopped`. Defaults to zero — stopped on the
     * first read.
     */
    readonly runningReads?: number;
    readonly dispatch?: (
      command: OrchestrationCommand,
    ) => Effect.Effect<{ readonly sequence: number }>;
    readonly listBindings?: ProviderSessionDirectoryShape["listBindings"];
  },
  body: (teardown: ProviderInstanceTeardownShape, harness: Harness) => Effect.Effect<void>,
) {
  const dispatched: OrchestrationCommand[] = [];
  const polls = new Map<ThreadId, number>();

  const engine = {
    dispatch: (command: OrchestrationCommand) => {
      dispatched.push(command);
      return options.dispatch === undefined
        ? Effect.succeed({ sequence: dispatched.length })
        : options.dispatch(command);
    },
  } as unknown as OrchestrationEngineShape;

  const snapshotQuery = {
    // `getThreadSessionById` and not `getThreadShellById`: the shell read
    // filters `archived_at IS NULL`, so it goes blind exactly when an
    // archived thread's session still has to be waited on.
    getThreadSessionById: (threadId: ThreadId) =>
      Effect.sync(() => {
        const seen = (polls.get(threadId) ?? 0) + 1;
        polls.set(threadId, seen);
        return Option.some(
          session(threadId, seen > (options.runningReads ?? 0) ? "stopped" : "running"),
        );
      }),
  } as unknown as ProjectionSnapshotQueryShape;

  const directory = {
    listBindings: options.listBindings ?? (() => Effect.succeed(options.bindings)),
  } as unknown as ProviderSessionDirectoryShape;

  return Effect.gen(function* () {
    const teardown = yield* ProviderInstanceTeardown;
    yield* body(teardown, { dispatched, polls });
  }).pipe(
    Effect.provide(
      ProviderInstanceTeardownLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(OrchestrationEngineService, engine),
            Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
            Layer.succeed(ProviderSessionDirectory, directory),
          ),
        ),
      ),
    ),
  );
}

describe("ProviderInstanceTeardownLive", () => {
  it.live("stops every live session bound to the torn-down instance", () =>
    withHarness(
      {
        bindings: [
          binding("thread-a", {}),
          binding("thread-b", { status: "starting" }),
          // Already stopped — nothing to tear down.
          binding("thread-stopped", { status: "stopped" }),
          // A different instance keeps running; reconcile did not touch it.
          binding("thread-other", { providerInstanceId: survivingInstance }),
          // Legacy row with no instance id: not attributable, so left alone.
          binding("thread-unbound", { unbound: true }),
        ],
      },
      (teardown, harness) =>
        Effect.gen(function* () {
          yield* teardown.stopSessionsOnInstances([doomedInstance]);

          expect(harness.dispatched.map((command) => command.type)).toEqual([
            "thread.session.stop",
            "thread.session.stop",
          ]);
          // `Effect.forEach` runs the stops concurrently, so assert the set,
          // not the order.
          expect(
            harness.dispatched
              .map((command) => ("threadId" in command ? command.threadId : null))
              .toSorted(),
          ).toEqual([ThreadId.make("thread-a"), ThreadId.make("thread-b")]);
        }),
    ),
  );

  it.live("waits for each projected session to report stopped", () =>
    withHarness({ bindings: [binding("thread-a", {})], runningReads: 2 }, (teardown, harness) =>
      Effect.gen(function* () {
        yield* teardown.stopSessionsOnInstances([doomedInstance]);

        // Returning on the first read would let reconcile close the
        // instance while `ProviderService.stopSession` was still running,
        // and that stop would then fail to resolve its own adapter.
        expect(harness.polls.get(ThreadId.make("thread-a"))).toBe(3);
      }),
    ),
  );

  it.live("keeps stopping the other threads when one dispatch fails", () =>
    withHarness(
      {
        bindings: [binding("thread-a", {}), binding("thread-b", {})],
        dispatch: (command) =>
          "threadId" in command && command.threadId === ThreadId.make("thread-a")
            ? Effect.die(new Error("dispatch exploded"))
            : Effect.succeed({ sequence: 1 }),
      },
      (teardown, harness) =>
        Effect.gen(function* () {
          yield* teardown.stopSessionsOnInstances([doomedInstance]);

          expect(harness.dispatched).toHaveLength(2);
          // Only the healthy thread got as far as the wait.
          expect(harness.polls.get(ThreadId.make("thread-a"))).toBeUndefined();
          expect(harness.polls.get(ThreadId.make("thread-b"))).toBe(1);
        }),
    ),
  );

  it.live("survives a directory read failure instead of wedging reconcile", () =>
    withHarness(
      {
        bindings: [],
        listBindings: () => Effect.die(new Error("directory unavailable")),
      },
      (teardown, harness) =>
        Effect.gen(function* () {
          yield* teardown.stopSessionsOnInstances([doomedInstance]);
          expect(harness.dispatched).toEqual([]);
        }),
    ),
  );

  it.live("reads nothing when no instance is being torn down", () =>
    withHarness(
      {
        bindings: [],
        listBindings: () => Effect.die(new Error("must not be read")),
      },
      (teardown, harness) =>
        Effect.gen(function* () {
          yield* teardown.stopSessionsOnInstances([]);
          expect(harness.dispatched).toEqual([]);
        }),
    ),
  );
});
