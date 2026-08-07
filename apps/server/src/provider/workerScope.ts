/**
 * Server-side plumbing for epic worker systemd scopes.
 *
 * The runner prepares one scope identity per epic run and binds every
 * iteration thread to its worker unit (`EpicRunner` via
 * `prepareWorkerScope` in `@t3tools/epic-core/workerScope`);
 * `ProviderService` resolves the binding at session start and every provider
 * adapter routes its CLI spawn through `wrapSpawnWithWorkerScope`. When the
 * run's preparation is inactive (a non-Linux host, no systemd user manager)
 * resolution yields `None` and spawns proceed unwrapped — governance is a
 * nicety, never a precondition.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import { ProviderWorkerScopeBinding, type EpicRunId, type ThreadId } from "@t3tools/contracts";
import { wrapWorkerScopeSpawn, type WorkerScopePreparation } from "@t3tools/epic-core/workerScope";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export interface WorkerScopeSpawnCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * Rewrite a provider CLI spawn into the bound systemd scope unit. Identity
 * when no binding is attached, so spawn sites can call it unconditionally.
 */
export const wrapSpawnWithWorkerScope = (
  workerScope: ProviderWorkerScopeBinding | undefined,
  command: string,
  args: ReadonlyArray<string>,
): WorkerScopeSpawnCommand =>
  workerScope === undefined
    ? { command, args }
    : wrapWorkerScopeSpawn(
        { scopeId: workerScope.scopeId, active: true },
        workerScope.worker,
        command,
        args,
      );

/**
 * The Claude Agent SDK spawns its CLI internally; `spawnClaudeCodeProcess`
 * is its only argv seam. A Node `ChildProcess` satisfies the SDK's
 * `SpawnedProcess` interface.
 */
export const spawnWorkerScopeWrappedProcess = (
  workerScope: ProviderWorkerScopeBinding,
  spawnOptions: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd?: string;
    readonly env: { readonly [key: string]: string | undefined };
    readonly signal?: AbortSignal;
  },
): NodeChildProcess.ChildProcessWithoutNullStreams => {
  const scoped = wrapSpawnWithWorkerScope(workerScope, spawnOptions.command, spawnOptions.args);
  return NodeChildProcess.spawn(scoped.command, [...scoped.args], {
    ...(spawnOptions.cwd !== undefined ? { cwd: spawnOptions.cwd } : {}),
    env: spawnOptions.env,
    ...(spawnOptions.signal !== undefined ? { signal: spawnOptions.signal } : {}),
  });
};

interface WorkerBinding {
  readonly runId: EpicRunId;
  readonly worker: string;
}

/**
 * In-memory map from session thread to the epic run's systemd worker scope.
 * Written by the runner (`setRunPreparation` once per run, `bindWorker` per
 * iteration thread), read by `ProviderService` at session start. Deliberately
 * ephemeral: after a server restart, recovered sessions spawn unwrapped —
 * the same fail-soft degradation as an inactive preparation.
 */
export class EpicWorkerScopeRegistry extends Context.Service<
  EpicWorkerScopeRegistry,
  {
    /** Record a run's scope preparation. Called once per run, before iterations dispatch. */
    readonly setRunPreparation: (
      runId: EpicRunId,
      preparation: WorkerScopePreparation,
    ) => Effect.Effect<void>;
    /** Bind an iteration thread to its worker unit within the run's scope. */
    readonly bindWorker: (input: {
      readonly runId: EpicRunId;
      readonly threadId: ThreadId;
      readonly worker: string;
    }) => Effect.Effect<void>;
    /**
     * The scope binding for a session's thread. `None` when the thread is not
     * an epic worker or the run's scope governance is inactive.
     */
    readonly resolve: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<ProviderWorkerScopeBinding>>;
    /** Drop every preparation and binding for a finished run. */
    readonly releaseRun: (runId: EpicRunId) => Effect.Effect<void>;
  }
>()("t3/provider/workerScope/EpicWorkerScopeRegistry") {
  static readonly layer = Layer.sync(this, () => {
    const preparations = new Map<EpicRunId, WorkerScopePreparation>();
    const bindings = new Map<ThreadId, WorkerBinding>();
    return {
      setRunPreparation: (runId, preparation) =>
        Effect.sync(() => {
          preparations.set(runId, preparation);
        }),
      bindWorker: ({ runId, threadId, worker }) =>
        Effect.sync(() => {
          bindings.set(threadId, { runId, worker });
        }),
      resolve: (threadId) =>
        Effect.sync(() => {
          const binding = bindings.get(threadId);
          if (binding === undefined) return Option.none();
          const preparation = preparations.get(binding.runId);
          if (preparation === undefined || !preparation.active) return Option.none();
          return Option.some(
            ProviderWorkerScopeBinding.make({
              scopeId: preparation.scopeId,
              worker: binding.worker,
            }),
          );
        }),
      releaseRun: (runId) =>
        Effect.sync(() => {
          preparations.delete(runId);
          for (const [threadId, binding] of bindings) {
            if (binding.runId === runId) bindings.delete(threadId);
          }
        }),
    };
  });
}
