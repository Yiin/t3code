/**
 * The terminal pool dispatch adapter: `PoolDispatchShape` over a terminal
 * {@link AgentDispatchShape} (`makeTerminalAgentDispatch`).
 *
 * The two server-only phases collapse to no-ops here: there is no
 * orchestration thread to create (`createIteration`) and no project setup
 * script on the terminal (`prepareIteration`). `beginTurn` delegates to
 * `startIteration`, whose `IterationHandle` is exactly what the pool loop
 * expects. Process lifetime stays with the terminal dispatch — its
 * `timeoutSeconds`/`stopGraceSeconds` enforcement and the handle's
 * `interrupt`/`release` own every stop — so `stopAbandoned` and `stopForced`
 * have nothing to clean up.
 */
import * as Effect from "effect/Effect";

import { EpicRunnerDispatchError } from "../Errors.ts";
import type { AgentDispatchShape } from "../ports/AgentDispatch.ts";
import type { PoolDispatchShape } from "../ports/PoolDispatch.ts";

export const makeTerminalPoolDispatch = (deps: {
  readonly dispatch: AgentDispatchShape;
}): PoolDispatchShape => ({
  /** Whatever the wrapped terminal dispatch declares, including `resume`. */
  capabilities: deps.dispatch.capabilities,
  createIteration: (input) =>
    Effect.logDebug("epic.cook.pool-create-iteration", {
      runId: input.runId,
      iterationIndex: input.iterationIndex,
      threadId: input.threadId,
    }),
  prepareIteration: () => Effect.void,
  beginTurn: (input) =>
    deps.dispatch
      .startIteration({
        runId: input.runId,
        iterationIndex: input.iterationIndex,
        cwd: input.workspace.cwd,
        worktreePath: input.workspace.worktreePath,
        prompt: input.prompt,
        selection: input.selection,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new EpicRunnerDispatchError({
              commandType: "terminal.startIteration",
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
  /**
   * Always unavailable, matching the declared `lifecycle.resume:
   * "unsupported"`. The terminal harness persists no artifact until the child
   * process closes, so after a restart there is nothing to adopt — and
   * spawning a fresh process here would produce an agent with no memory of
   * the work, wearing the resumed iteration's row.
   */
  resumeIteration: (input) =>
    Effect.succeed({
      _tag: "unavailable",
      refusal: {
        _tag: "capability",
        detail: `The terminal harness cannot resume iteration ${String(input.iterationIndex)} at ref '${input.ref}': it declares lifecycle.resume "unsupported".`,
      },
    }),
  stopAbandoned: () => Effect.void,
  stopForced: () => Effect.void,
});
