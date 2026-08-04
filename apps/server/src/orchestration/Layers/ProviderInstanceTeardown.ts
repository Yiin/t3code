/**
 * ProviderInstanceTeardownLive — stop the sessions that live on a provider
 * instance the registry is about to tear down.
 *
 * `ProviderInstanceRegistryMutator.reconcile` calls this right before it
 * closes the scope of every removed or replaced instance. Closing that scope
 * kills the subprocess through the driver's finalizers and writes nothing, so
 * without this hook the directory keeps reporting `running` for a session
 * that no longer has a process, the reaper never collects it (it only looks
 * at idle time and the active-turn pointer), the UI keeps showing a live
 * provider, and the thread's MCP credential stays resolvable until it times
 * out.
 *
 * Why the command path and not `ProviderService.stopSession`
 * ----------------------------------------------------------
 * `stopSession` writes the binding and clears the MCP session, but it does
 * not touch the projection — that is what makes the UI stop claiming the
 * session is alive. Only `thread.session.stop` does all three, by way of
 * `ProviderCommandReactor.processSessionStopRequested`, which calls
 * `ProviderService.stopSession` and *then* writes the projected session.
 * Dispatching the command reuses the same path as the stop button and
 * `ThreadTeardownReactor`, so there is one teardown path, not two.
 *
 * Why it waits
 * ------------
 * `dispatch` resolves once the command's own event is persisted and
 * published, not once the reactor has handled it. Reconcile closes the
 * instance scope the moment this effect returns, and a `stopSession` that
 * runs after that close fails with `ProviderUnsupportedError` —
 * `ProviderAdapterRegistry` resolves adapters live, so the removed instance
 * is already gone. So we wait for the projected session to report `stopped`,
 * the same signal `ws.ts` waits on before removing a worktree: the reactor
 * writes it only after `ProviderService.stopSession` returns.
 *
 * @module orchestration/Layers/ProviderInstanceTeardown
 */
import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { CommandId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import {
  ProviderInstanceTeardown,
  type ProviderInstanceTeardownShape,
} from "../../provider/Services/ProviderInstanceTeardown.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

/**
 * How long we wait for one thread's projected session to report `stopped`
 * before giving up and letting reconcile close the instance anyway. A wedged
 * session must not block a settings reload, so this is a backstop, not a
 * promise. It matches the bound `ws.ts` uses for the same wait.
 */
const SESSION_STOP_TIMEOUT = Duration.seconds(15);
const SESSION_STOP_POLL_INTERVAL = Duration.millis(50);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory;

  // Command ids are deduplicated by receipt, so two teardowns of the same
  // thread must not collide. A counter is enough — nothing replays these, and
  // it keeps the layer free of a `Crypto` dependency it would otherwise need
  // only for an id.
  const stopCounter = yield* Ref.make(0);
  const teardownCommandId = (threadId: ThreadId, instanceId: ProviderInstanceId) =>
    Ref.updateAndGet(stopCounter, (n) => n + 1).pipe(
      Effect.map((n) =>
        CommandId.make(`server:session-stop-for-instance-teardown:${instanceId}:${threadId}:${n}`),
      ),
    );

  // A missing session row counts as stopped: the reactor writes the row, so
  // "no row" means there is nothing left to wait for.
  const waitForSessionStopped = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadSessionById(threadId).pipe(
      Effect.map(
        Option.match({
          onNone: () => false,
          onSome: (session) => session.status !== "stopped",
        }),
      ),
      Effect.repeat({
        while: (running) => running,
        schedule: Schedule.spaced(SESSION_STOP_POLL_INTERVAL),
      }),
      Effect.timeout(SESSION_STOP_TIMEOUT),
      Effect.asVoid,
    );

  // One failed or slow thread must not skip the others, and must not stop
  // reconcile: log it and let the instance close. That is no worse than the
  // behaviour before this hook existed.
  const stopThreadSession = (threadId: ThreadId, instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      yield* orchestrationEngine.dispatch({
        type: "thread.session.stop",
        commandId: yield* teardownCommandId(threadId, instanceId),
        threadId,
        createdAt: yield* nowIso,
      });
      yield* waitForSessionStopped(threadId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider session before instance teardown", {
          threadId,
          providerInstanceId: instanceId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const stopSessionsOnInstances: ProviderInstanceTeardownShape["stopSessionsOnInstances"] = (
    instanceIds,
  ) =>
    Effect.gen(function* () {
      if (instanceIds.length === 0) {
        return;
      }
      const torndown = new Set<ProviderInstanceId>(instanceIds);
      const bindings = yield* directory.listBindings();
      // `status` is optional on the read shape. A binding with no status is a
      // row we cannot prove is stopped, so stop it — an already-stopped
      // session costs one no-op command.
      const doomed: Array<{
        readonly threadId: ThreadId;
        readonly instanceId: ProviderInstanceId;
      }> = [];
      for (const binding of bindings) {
        const instanceId = binding.providerInstanceId;
        if (instanceId === undefined || !torndown.has(instanceId)) {
          continue;
        }
        if (binding.status === "stopped") {
          continue;
        }
        doomed.push({ threadId: binding.threadId, instanceId });
      }
      yield* Effect.forEach(
        doomed,
        ({ threadId, instanceId }) => stopThreadSession(threadId, instanceId),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider instance teardown failed to enumerate sessions", {
          providerInstanceIds: instanceIds,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  return { stopSessionsOnInstances } satisfies ProviderInstanceTeardownShape;
});

export const ProviderInstanceTeardownLive = Layer.effect(ProviderInstanceTeardown, make);
