/**
 * Server-side plumbing for the epic runner's run-scoped git committer
 * identity (t3code-e6l).
 *
 * The runner binds every iteration thread to its run id here; `ProviderService`
 * resolves the identity at session start and every adapter merges it into the
 * worker process's spawn env as `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL`.
 * `ParallelEpicLoop.iterationCommitted` checks an in-place iteration's new
 * commits against the same identity (`policy.ts#runCommitterEmail`), computed
 * independently from the same `runId` — nothing here is read back by the loop.
 *
 * The registry mirrors `EpicSubagentRegistry` on purpose, including its
 * ephemerality: a session recovered after a server restart simply carries no
 * stamped identity. An in-place iteration of such a session earns no commit
 * credit from `iterationCommitted`'s identity check — its commits carry the
 * operator's identity — and must close with bead evidence instead.
 */
import { EpicRunId, GitCommitterIdentity, type ThreadId } from "@t3tools/contracts";
import { runCommitterEmail } from "@t3tools/epic-core/policy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/** The identity every worker of this run's commits should carry. */
export const epicRunCommitterIdentity = (runId: EpicRunId): GitCommitterIdentity => ({
  name: `T3 epic run ${runId}`,
  email: runCommitterEmail(runId),
});

/**
 * In-memory map from session thread to the epic run it belongs to. Written by
 * the runner per iteration thread, read by `ProviderService` at session start.
 */
export class EpicCommitterRegistry extends Context.Service<
  EpicCommitterRegistry,
  {
    /** Bind an iteration thread to the run whose identity its commits carry. */
    readonly bindThread: (input: {
      readonly runId: EpicRunId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<void>;
    /** The committer identity for a session's thread, `None` off an epic worker. */
    readonly resolve: (threadId: ThreadId) => Effect.Effect<Option.Option<GitCommitterIdentity>>;
    /** Drop every binding for a finished run. */
    readonly releaseRun: (runId: EpicRunId) => Effect.Effect<void>;
  }
>()("t3/provider/epicCommitter/EpicCommitterRegistry") {
  static readonly layer = Layer.sync(this, () => {
    const bindings = new Map<ThreadId, EpicRunId>();
    return {
      bindThread: ({ runId, threadId }) =>
        Effect.sync(() => {
          bindings.set(threadId, runId);
        }),
      resolve: (threadId) =>
        Effect.sync(() => {
          const runId = bindings.get(threadId);
          return runId === undefined ? Option.none() : Option.some(epicRunCommitterIdentity(runId));
        }),
      releaseRun: (runId) =>
        Effect.sync(() => {
          for (const [threadId, boundRunId] of bindings) {
            if (boundRunId === runId) bindings.delete(threadId);
          }
        }),
    };
  });
}
