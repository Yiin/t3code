/**
 * Server-side plumbing for the epic runner's per-role subagent definitions.
 *
 * The runner decides which planner / implementer / reviewer subagents an
 * iteration worker gets, and which model tier each one runs on. It binds the
 * map to the iteration thread here; `ProviderService` resolves it at session
 * start and the Claude adapter forwards it as the SDK's `agents` option.
 *
 * The registry mirrors `EpicWorkerScopeRegistry` (`./workerScope.ts`) on
 * purpose, including its ephemerality: a session recovered after a server
 * restart simply gets no injected agents. Missing agents cost a worker its
 * tiering, never its turn, so this is fail-soft by design.
 */
import type { EpicRunId, EpicSubagentMap, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

interface SubagentBinding {
  readonly runId: EpicRunId;
  readonly subagents: EpicSubagentMap;
}

/**
 * In-memory map from session thread to the epic run's injected subagent
 * definitions. Written by the runner per iteration thread, read by
 * `ProviderService` at session start.
 */
export class EpicSubagentRegistry extends Context.Service<
  EpicSubagentRegistry,
  {
    /** Bind an iteration thread to the subagent definitions its worker gets. */
    readonly bindThread: (input: {
      readonly runId: EpicRunId;
      readonly threadId: ThreadId;
      readonly subagents: EpicSubagentMap;
    }) => Effect.Effect<void>;
    /**
     * The subagent definitions for a session's thread. `None` when the thread
     * is not an epic worker, or the runner injected no definitions.
     */
    readonly resolve: (threadId: ThreadId) => Effect.Effect<Option.Option<EpicSubagentMap>>;
    /** Drop every binding for a finished run. */
    readonly releaseRun: (runId: EpicRunId) => Effect.Effect<void>;
  }
>()("t3/provider/epicSubagents/EpicSubagentRegistry") {
  static readonly layer = Layer.sync(this, () => {
    const bindings = new Map<ThreadId, SubagentBinding>();
    return {
      bindThread: ({ runId, threadId, subagents }) =>
        Effect.sync(() => {
          bindings.set(threadId, { runId, subagents });
        }),
      resolve: (threadId) =>
        Effect.sync(() => {
          const binding = bindings.get(threadId);
          if (binding === undefined) return Option.none();
          // An empty map is the same as no injection: the adapter would drop
          // it anyway, so never make a caller test for it twice.
          if (Object.keys(binding.subagents).length === 0) return Option.none();
          return Option.some(binding.subagents);
        }),
      releaseRun: (runId) =>
        Effect.sync(() => {
          for (const [threadId, binding] of bindings) {
            if (binding.runId === runId) bindings.delete(threadId);
          }
        }),
    };
  });
}
