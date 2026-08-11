/**
 * ThreadSettleWatch - wait for a thread's turn to end, then read what it said.
 *
 * Extracted verbatim from `runner/Layers/EpicRunnerPoolPorts.ts`, where every
 * piece of it was module-private. The epic runner needs it to settle an
 * iteration; the `spawn_agent` toolkit needs exactly the same thing to settle a
 * thread-backed subagent, and nothing else the runner wraps around it.
 *
 * Nothing here knows about epic runs. The epic-specific waits — subagent drain,
 * grace continuations, worktree fingerprints, RALPH tokens — stay in the runner.
 *
 * The timings parameter is a local shape rather than `PoolTimings`, so this
 * module does not depend on `@t3tools/epic-core`. `PoolTimings` satisfies it
 * structurally, which is why the runner still passes its policy untouched.
 *
 * @module ThreadSettleWatch
 */
import type {
  OrchestrationSessionStatus,
  OrchestrationThread,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const MAX_SETTLE_READS = 20;
/**
 * The bound for the one absence worth waiting out: a completed turn whose
 * assistant row has not projected at all. Two minutes at the default quiet
 * period, which is far past any projection lag but nothing against an iteration
 * measured in hours — and it is only ever spent when the alternative is calling
 * a pending message a missing one.
 */
const MAX_ABSENT_MESSAGE_SETTLE_READS = 120;

/** The polling cadence a settle watch needs. `PoolTimings` satisfies this. */
export interface ThreadSettleTimings {
  readonly pollIntervalMs: number;
  readonly quietPeriodMs: number;
}

/**
 * The settled state of a thread's latest turn, or `null` when nothing has been
 * projected yet. Structurally identical to the loop's `IterationTurnState`.
 */
export type ThreadTurnState = "running" | "completed" | "interrupted" | "error" | null;

/**
 * The turn state a session status implies, or null while the session is
 * (re)starting or running and turns must stay unsettled.
 *
 * Mirrors `settledTurnStateForSessionStatus`
 * (`orchestration/Layers/ProjectionPipeline.ts:78-94`) exactly, because the
 * projector settles a thread's running turns from this same status in the same
 * transaction that writes it. That shared origin is what makes this a safe
 * stand-in when the turn row cannot be read.
 */
export const settledTurnStateFromSessionStatus = (
  status: OrchestrationSessionStatus,
): "completed" | "interrupted" | "error" | null => {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
};

/**
 * Whether a session status settles the turn.
 *
 * Derived from `settledTurnStateFromSessionStatus` so the two cannot drift. It
 * is not simply `status !== "running"`, and the difference matters: a fresh
 * thread's session is `"starting"` before its turn begins, which under that
 * looser test would end the turn before the agent had said a word.
 */
export const isTurnEndSessionStatus = (status: OrchestrationSessionStatus): boolean =>
  settledTurnStateFromSessionStatus(status) !== null;

/**
 * The assistant message a thread's verdict is read from.
 *
 * Prefers the turn's own pointer, but resolves it against the projected rows
 * first: `CheckpointReactor.ts:294-299` synthesizes an `assistant:<turnId>`
 * pointer for turns that produced no message, and that synthetic id names no
 * row. Falling back to the last projected assistant row matches terminal
 * ralph, whose result is the last agent message of the run.
 */
export const resolveFinalAssistantMessage = (
  thread: OrchestrationThread | undefined,
): { readonly text: string; readonly streaming: boolean } | null => {
  if (thread === undefined) {
    return null;
  }
  const assistantMessages = thread.messages.filter((message) => message.role === "assistant");
  const pointer = thread.latestTurn?.assistantMessageId ?? null;
  const named =
    pointer === null ? undefined : assistantMessages.find((message) => message.id === pointer);
  const message = named ?? assistantMessages[assistantMessages.length - 1];
  return message === undefined ? null : { text: message.text, streaming: message.streaming };
};

/**
 * The turn state a thread detail implies, turn row first and session status
 * second.
 *
 * `latestTurn` resolves through an inner join on `threads.latest_turn_id`
 * (`ProjectionSnapshotQuery.ts:1122-1130`), and the same transaction that
 * settles the turn nulls that pointer (`ProjectionPipeline.ts:757-771`). The
 * pointer is only restored later, by `thread.turn-diff-completed` after the
 * CheckpointReactor has captured a git checkpoint and diffed it — seconds of
 * work unrelated to the turn, and skipped entirely when that capture fails. So
 * a settled turn routinely reads back as `null` here, which `classifyIteration`
 * cannot distinguish from "never ran".
 *
 * The session row is the reliable stand-in: the projector writes it in the same
 * transaction it settles the turn with, from this exact mapping, so it can never
 * disagree with the turn row that eventually reappears.
 */
export const threadTurnState = (thread: OrchestrationThread | undefined): ThreadTurnState => {
  const sessionStatus = thread?.session?.status ?? null;
  return (
    thread?.latestTurn?.state ??
    (sessionStatus === null ? null : settledTurnStateFromSessionStatus(sessionStatus))
  );
};

export interface ThreadSettleWatchDeps {
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery["Service"];
  /**
   * Prefix for the two read-failure warnings and the never-settled warning.
   *
   * The epic runner passes `"epic.runner"` so its log keys stay exactly what
   * they were before this module existed.
   */
  readonly logPrefix?: string;
}

/**
 * Build the settle watch over one projection query.
 *
 * A factory rather than free functions because every read needs the projection
 * service, and the two callers get it from different places: the runner already
 * holds the service value, the toolkit yields it out of context.
 */
export const makeThreadSettleWatch = (deps: ThreadSettleWatchDeps) => {
  const { projectionSnapshotQuery } = deps;
  const logPrefix = deps.logPrefix ?? "thread-settle";

  const readThreadShell = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadShellById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catchCause((cause) =>
        Effect.logWarning(`${logPrefix}.shell-read-failed`, { threadId, cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );

  /**
   * The thread detail read every settle check shares. `undefined` (missing
   * thread, read failure) reads as "nothing projected". Callers that authorize
   * something destructive must re-check atomically rather than trust this, so a
   * broken read can never be mistaken for a settled thread.
   */
  const readThreadDetail = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadDetailSnapshot(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catchCause((cause) =>
        Effect.logWarning(`${logPrefix}.snapshot-read-failed`, { threadId, cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );

  /**
   * Wait until the thread's turn has ended.
   *
   * Polls the projection rather than subscribing to `streamDomainEvents`.
   * That is a deliberate trade. The event stream is lower-latency, but there
   * is no way to know a subscription is live before dispatching: neither
   * `Stream.toPull`, `Stream.toQueue`, nor `Stream.onStart` opens the
   * underlying `Stream.fromPubSub` (`OrchestrationEngine.ts:326-331`) eagerly,
   * so a fast turn can publish its entire lifecycle into a subscription that
   * does not exist yet — and the caller then hangs until its timeout. Polling
   * has no such window: projections are committed in the same transaction as
   * the append (`OrchestrationEngine.ts:170-180`), so every read is consistent
   * and no signal can be missed. At turn timescales the added latency is
   * irrelevant, and the read is the cheap shell row, not the full thread.
   *
   * Turn end is the same signal the projector uses — a turn leaving
   * `running` (`ProjectionPipeline.ts:1059-1073`). The session is a fallback
   * for the case where the provider dies before a turn row ever exists, which
   * would otherwise be indistinguishable from "still starting".
   */
  const awaitTurnEnd = (
    threadId: ThreadId,
    timings: ThreadSettleTimings,
    priorTurnId: TurnId | null = null,
  ) =>
    Effect.gen(function* () {
      let observedActive = false;
      while (true) {
        const shell = yield* readThreadShell(threadId);
        // A continuation turn is dispatched while the thread's PREVIOUS turn
        // is still the projected latest — turn rows are created at provider
        // adoption, not at turn.start — so until the new turn appears, the
        // prior turn's settled state must not read as this turn's end.
        const latestTurn =
          shell?.latestTurn != null && shell.latestTurn.turnId !== priorTurnId
            ? shell.latestTurn
            : null;
        const turnState = latestTurn?.state ?? null;
        const sessionStatus = shell?.session?.status ?? null;

        if (
          turnState === "running" ||
          sessionStatus === "starting" ||
          sessionStatus === "running"
        ) {
          observedActive = true;
        }
        if (turnState !== null && turnState !== "running") {
          return;
        }
        if (observedActive && sessionStatus !== null && isTurnEndSessionStatus(sessionStatus)) {
          return;
        }

        yield* Effect.sleep(Duration.millis(timings.pollIntervalMs));
      }
    });

  /**
   * Read the turn's final assistant message once it has stopped changing.
   *
   * The turn-end signal is not the read point: ingestion dispatches
   * `thread.session.set` (`ProviderRuntimeIngestion.ts:1666`) before it
   * finalizes the turn's assistant messages, so reading immediately returns a
   * still-streaming row — empty, on ACP providers whose text exists only as
   * deltas. Waiting for two consecutive identical reads closes that gap.
   *
   * An absent message (`resolveFinalAssistantMessage` returning `null`) is
   * never treated as settled on its own: it means the assistant row hasn't
   * projected yet, not that the turn produced none, so `null === null` across
   * two reads must keep polling rather than return early. A genuinely
   * message-less completed turn is indistinguishable from this in-flight gap
   * until the bound below is exhausted — that is the correct, if slower,
   * outcome, since guessing wrong here silently drops the rest of the epic's
   * backlog (`classifyIteration` treats a spurious `null` as a protocol
   * error, and three of those trip `maxConsecutiveFailures`).
   *
   * Bounded: a provider that never stops rewriting the message — or one
   * whose turn truly ends with no assistant row — would otherwise hold the
   * caller here forever, so after `MAX_SETTLE_READS` the last read is used
   * as-is and classification decides what it means.
   *
   * That base bound is short because a rewriting provider is still working.
   * A *completed* turn with no assistant row at all is a different wait: the
   * only outstanding work is ingestion's own finalize, so the wait extends to
   * `MAX_ABSENT_MESSAGE_SETTLE_READS` for as long as the turn keeps reading
   * back completed. The extension is why the exhausted flag below means
   * something: when even that runs out, the absence has been watched for as
   * long as it is worth watching.
   */
  const readSettledFinalMessage = (threadId: ThreadId, timings: ThreadSettleTimings) =>
    Effect.gen(function* () {
      const read = () => readThreadDetail(threadId);

      let previous = yield* read();
      // Raised, in the loop, the first time a completed turn reads back with
      // no assistant row — the one absence worth waiting out.
      let maxReads = MAX_SETTLE_READS;
      let watchedCompletedTurnWithoutMessage = false;
      for (let attempt = 0; attempt < maxReads; attempt += 1) {
        yield* Effect.sleep(Duration.millis(timings.quietPeriodMs));
        const current = yield* read();
        const previousMessage = resolveFinalAssistantMessage(previous?.thread);
        const currentMessage = resolveFinalAssistantMessage(current?.thread);
        if (
          currentMessage !== null &&
          previousMessage?.text === currentMessage.text &&
          previousMessage?.streaming === currentMessage.streaming
        ) {
          return { snapshot: current, messageWaitExhausted: false };
        }
        if (currentMessage === null && threadTurnState(current?.thread) === "completed") {
          watchedCompletedTurnWithoutMessage = true;
          maxReads = MAX_ABSENT_MESSAGE_SETTLE_READS;
        }
        previous = current;
      }
      const settledMessage = resolveFinalAssistantMessage(previous?.thread);
      yield* Effect.logWarning(`${logPrefix}.final-message-never-settled`, {
        threadId,
        messageProjected: settledMessage !== null,
      });
      return {
        snapshot: previous,
        messageWaitExhausted: watchedCompletedTurnWithoutMessage && settledMessage === null,
      };
    });

  return {
    readThreadShell,
    readThreadDetail,
    awaitTurnEnd,
    readSettledFinalMessage,
    threadTurnState,
    resolveFinalAssistantMessage,
  } as const;
};

export type ThreadSettleWatch = ReturnType<typeof makeThreadSettleWatch>;
