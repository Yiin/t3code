/**
 * ProviderInstanceTeardown — the hook `ProviderInstanceRegistryMutator.reconcile`
 * calls before it closes the scope of a removed or replaced provider instance.
 *
 * Why a hook instead of a direct call
 * -----------------------------------
 * Closing an instance's scope kills every session running on it through the
 * driver's own finalizers. That path writes nothing: the provider session
 * binding keeps saying `running`, the thread's MCP credential stays
 * resolvable, and the projected thread session keeps claiming a live
 * provider. The single teardown path that writes all three is the
 * `thread.session.stop` command (decider -> `thread.session-stop-requested`
 * -> `ProviderCommandReactor` -> `ProviderService.stopSession` + the
 * projection write).
 *
 * The registry cannot call that path directly. `ProviderService` and
 * `OrchestrationEngineService` are both built *on top of*
 * `ProviderInstanceRegistry` resolves every
 * adapter through it — so a direct dependency would close a layer cycle.
 * This tag inverts it: the registry depends on a narrow interface, and the
 * implementation that knows about commands lives in `orchestration/Layers`
 * next to the other teardown reactors.
 *
 * The write has to survive the scope close, so `stopSessionsOnInstances`
 * must complete *before* reconcile closes anything. Once the scope is closed
 * and the entry is dropped from the registry, `ProviderInstanceRegistry`
 * fails to resolve the instance and `ProviderService.stopSession` fails with
 * `ProviderUnsupportedError` — nothing gets written at all.
 *
 * @module provider/Services/ProviderInstanceTeardown
 */
import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ProviderInstanceTeardownShape {
  /**
   * Stop every live session bound to any of `instanceIds`, and only return
   * once each of those sessions is really stopped.
   *
   * The effect never fails: a session that refuses to stop must not wedge
   * the settings reconcile, so the implementation logs and gives up rather
   * than propagating. Callers treat a completed effect as "we did what we
   * could", not "every session is stopped".
   */
  readonly stopSessionsOnInstances: (
    instanceIds: ReadonlyArray<ProviderInstanceId>,
  ) => Effect.Effect<void>;
}

export class ProviderInstanceTeardown extends Context.Service<
  ProviderInstanceTeardown,
  ProviderInstanceTeardownShape
>()("t3/provider/Services/ProviderInstanceTeardown") {}

/**
 * No-op teardown. For stacks that build a registry without an orchestration
 * engine behind it — driver/registry unit tests, and any future embedding
 * that has no session directory to keep honest.
 */
export const NoOpProviderInstanceTeardown: ProviderInstanceTeardownShape = {
  stopSessionsOnInstances: () => Effect.void,
};

export const NoOpProviderInstanceTeardownLive = Layer.succeed(
  ProviderInstanceTeardown,
  NoOpProviderInstanceTeardown,
);
