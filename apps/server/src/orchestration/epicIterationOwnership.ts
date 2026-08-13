/**
 * EpicIterationOwnership - one gate for client commands aimed at a live epic
 * iteration thread.
 *
 * An epic run's iteration is an ordinary orchestration thread, so every client
 * surface can already reach it: the sidebar opens it, the composer sends to it,
 * the stop button interrupts it. That is deliberate for a *settled* iteration —
 * reading and continuing a finished worker's thread is how a run is reviewed.
 * While the runner owns the turn it is not: a client turn start replaces the
 * assistant message the runner is about to read as its evidence, and a client
 * interrupt or session stop ends the work the run is still waiting on.
 *
 * The gate is deliberately at client ingress (`ws.ts`, `orchestration/http.ts`)
 * rather than inside `OrchestrationEngine.dispatch`. The runner drives its own
 * iterations through that same engine, so a check there would have to tell the
 * runner's commands apart from a client's by inspecting them; here the
 * distinction is structural — only clients come through these two doors.
 *
 * Ownership is read from the durable `epic_run_iterations` row, not from the
 * projection and not from in-memory runner state. The row is written ahead of
 * the dispatch and flipped to a terminal status only after the iteration's
 * final message has been read and its handle released
 * (`ParallelEpicLoop.ts`), so "row is running" covers the whole window in
 * which a stray client command could do damage — including the gap between
 * turn end and evidence read, which is exactly when a human watching the
 * thread is most tempted to type into it.
 *
 * @module epicIterationOwnership
 */
import {
  EpicRunId,
  parseEpicRunIterationThreadId,
  type OrchestrationCommand,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { EpicRunStore } from "../persistence/Services/EpicRuns.ts";

/**
 * The client commands that change a thread's turn or session lifecycle.
 *
 * Every other dispatchable client command stays allowed on a running
 * iteration on purpose. Approvals and user-input responses are how a human
 * unblocks a worker that is waiting on them; subagent steer and stop are an
 * escape hatch for one runaway child that neither ends the owned turn nor
 * rewrites its final message; meta, mode and unsettle updates are bookkeeping
 * the next turn picks up. Blocking those would make a live run less
 * supervisable without protecting anything.
 */
export const EPIC_ITERATION_GUARDED_COMMAND_TYPES = [
  // Would start a competing turn on the thread, and its assistant message
  // would become the newest one on a thread the runner reads evidence from.
  "thread.turn.start",
  // Would end the turn the runner owns and is waiting to settle.
  "thread.turn.interrupt",
  // Would kill the worker's provider session mid-iteration.
  "thread.session.stop",
  // Would rewrite the worktree under a working agent.
  "thread.checkpoint.revert",
  // Would destroy the thread the run's evidence lives on.
  "thread.delete",
  // Archiving stops the session through `ThreadTeardownReactor`.
  "thread.archive",
  // Marking a live iteration settled hands its session to the reaper.
  "thread.settle",
] as const satisfies ReadonlyArray<OrchestrationCommand["type"]>;

export type EpicIterationGuardedCommandType = (typeof EPIC_ITERATION_GUARDED_COMMAND_TYPES)[number];

const GUARDED_COMMAND_TYPES: ReadonlySet<string> = new Set(EPIC_ITERATION_GUARDED_COMMAND_TYPES);

export const isEpicIterationGuardedCommandType = (
  type: string,
): type is EpicIterationGuardedCommandType => GUARDED_COMMAND_TYPES.has(type);

/** The iteration a guarded command names, or `null` when there is nothing to check. */
export interface EpicIterationCommandTarget {
  readonly threadId: ThreadId;
  readonly runId: string;
  readonly iterationIndex: number;
  readonly commandType: EpicIterationGuardedCommandType;
}

/**
 * The iteration row a command would have to be checked against.
 *
 * Pure, and `null` for the overwhelmingly common cases: a command that changes
 * no lifecycle, and any thread the runner did not name. Callers use it to skip
 * the durable read entirely, so an interactive thread costs nothing.
 */
export const epicIterationCommandTarget = (
  command: OrchestrationCommand,
): EpicIterationCommandTarget | null => {
  if (!isEpicIterationGuardedCommandType(command.type)) return null;
  if (!("threadId" in command)) return null;
  const threadId = command.threadId;
  const parsed = parseEpicRunIterationThreadId(threadId);
  if (parsed === null) return null;
  return {
    threadId,
    runId: parsed.runId,
    iterationIndex: parsed.iterationIndex,
    commandType: command.type,
  };
};

/**
 * Why a command was refused.
 *
 * `iteration-running` is the ordinary answer. `state-unreadable` means the
 * durable read itself failed: the gate refuses rather than guesses, because
 * the alternative is letting a broken database read look like a finished
 * iteration and hand the client an interrupt for a live run. The cost is
 * bounded — it can only ever affect commands aimed at epic iteration threads,
 * and the client can retry.
 */
export type EpicIterationRejectionEvidence = "iteration-running" | "state-unreadable";

export interface EpicIterationRejection extends EpicIterationCommandTarget {
  readonly evidence: EpicIterationRejectionEvidence;
}

/** The one refusal wording both client surfaces report. */
export const describeEpicIterationRejection = (rejection: EpicIterationRejection): string =>
  rejection.evidence === "iteration-running"
    ? `${rejection.commandType} is not allowed on ${rejection.threadId}: epic run ${rejection.runId} owns iteration ${String(rejection.iterationIndex)} until it finishes.`
    : `${rejection.commandType} is not allowed on ${rejection.threadId}: epic run ${rejection.runId} iteration state could not be read.`;

export interface EpicIterationOwnershipShape {
  /**
   * `null` when the command may proceed, a rejection when it may not.
   *
   * Never fails: a store error is folded into a `state-unreadable` rejection
   * so callers have exactly one refusal shape to translate.
   */
  readonly checkClientCommand: (
    command: OrchestrationCommand,
  ) => Effect.Effect<EpicIterationRejection | null>;
}

export class EpicIterationOwnership extends Context.Service<
  EpicIterationOwnership,
  EpicIterationOwnershipShape
>()("t3/orchestration/epicIterationOwnership") {}

/** Build the gate over any epic run store. Exported for tests with a fake store. */
export const makeEpicIterationOwnership = (
  store: EpicRunStore["Service"],
): EpicIterationOwnershipShape => ({
  checkClientCommand: (command) =>
    Effect.gen(function* () {
      const target = epicIterationCommandTarget(command);
      if (target === null) return null;
      const running = yield* store
        .listRunningIterations({ runId: EpicRunId.make(target.runId) })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("epic.iteration-ownership.read-failed", {
              threadId: target.threadId,
              commandType: target.commandType,
              cause,
            }).pipe(Effect.as(null)),
          ),
        );
      const rejection: EpicIterationRejection | null =
        running === null
          ? { ...target, evidence: "state-unreadable" }
          : running.some((iteration) => iteration.iterationIndex === target.iterationIndex)
            ? { ...target, evidence: "iteration-running" }
            : null;
      if (rejection !== null) {
        yield* Effect.logInfo("epic.iteration-ownership.rejected", {
          threadId: rejection.threadId,
          runId: rejection.runId,
          iterationIndex: rejection.iterationIndex,
          commandType: rejection.commandType,
          evidence: rejection.evidence,
        });
      }
      return rejection;
    }),
});

export const EpicIterationOwnershipLive = Layer.effect(
  EpicIterationOwnership,
  Effect.gen(function* () {
    const store = yield* EpicRunStore;
    return makeEpicIterationOwnership(store);
  }),
);
