/**
 * InterruptedTurnNudger - the boot pass that restarts an interrupted turn.
 *
 * See `../Services/InterruptedTurnNudger.ts` for why this exists and why it is
 * two calls. The per-thread path here is the same handshake
 * `PoolDispatch.resumeIteration` (runner/Layers/PoolDispatch.ts) uses for an
 * epic iteration: dispatch `thread.session.resume`, wait for the durable
 * `provider.session.resume.settled` activity, and say nothing to the agent
 * until the outcome is `resumed`. The proof is not optional — Codex and
 * OpenCode silently open a blank session on a stale cursor, and prompting one
 * of those would put a "carry on" message in front of an agent with no memory
 * of the work.
 *
 * @module InterruptedTurnNudger
 */
import {
  CommandId,
  MessageId,
  parseEpicRunIterationThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeThreadSettleWatch } from "../../orchestration/ThreadSettleWatch.ts";
import {
  InterruptedTurnNudger,
  type InterruptedThreadCandidate,
  type InterruptedTurnNudgerShape,
} from "../Services/InterruptedTurnNudger.ts";
import { BOOT_RECONCILE_STOP_REASON } from "./ProviderSessionReaper.ts";

/**
 * What the agent is told after its turn was cut off.
 *
 * It has to carry three things the transcript cannot show. The turn ended
 * because the process died, not because anything finished. Tool calls that were
 * in flight never returned, so their results are absent rather than empty. And
 * the work may in fact be complete, with only the report lost — which is why
 * the last instruction is "or send your report again" rather than "start over".
 */
export const RESTART_NUDGE_PROMPT = [
  "The T3 Code server restarted while you were working, so your turn was cut off mid-way.",
  "Any tool call that was in flight never returned, and its result is lost.",
  "Re-verify the current state before you continue: re-read the files you were changing, re-run the command you were waiting on, and check `git status` if you were committing.",
  "Then finish the work you were on. If it was already done and only your report was lost, send that report again.",
].join(" ");

/**
 * How often a resume wait re-reads the projection. The answer is written when
 * the provider session starts, so this is provider latency, not projection lag.
 */
const RESUME_POLL_INTERVAL_MS = 250;

/**
 * How many threads are resumed at once.
 *
 * Every resume starts a real harness process, so this is a load bound, not a
 * throughput knob. A restart normally leaves one or two interrupted threads;
 * four keeps a rare pile-up from serializing behind a 120s resume timeout
 * without opening a fork bomb at boot.
 */
const NUDGE_CONCURRENCY = 4;

/**
 * The threads a restart left mid-turn, out of a whole shell snapshot.
 *
 * Read before any reactor starts, so "running" cannot mean anything except
 * "left running by the process that died" — this process has not started a
 * turn yet. That is the whole reason the read happens where it does: once the
 * reaper has reconciled, an interrupted turn is indistinguishable from one a
 * human pressed Stop on.
 *
 * Four kinds of thread are excluded even when they match:
 *
 * - Epic-run iteration threads. `EpicRunner.start` adopts its own interrupted
 *   iterations with its own resume and its own prompt, so a nudge here would
 *   be a second prompt racing the runner's.
 * - Thread-backed subagent children. Their parent's roster row is closed by
 *   the spawn reconciliation, so waking a child would produce work nothing is
 *   waiting on.
 * - Threads the user explicitly settled. Settling says "I am done with this",
 *   and the nudge's own turn start would wake the thread right back up
 *   (`thread.unsettled` with reason `activity`, decider.ts). A restart is not
 *   grounds to overrule that.
 * - Threads holding a message parked at a turn boundary.
 *   `QueuedTurnDeliveryReactor`'s boot sweep is waiting for exactly this
 *   thread's turn to end so it can deliver that message. Settling the dead
 *   turn releases that poller, so nudging too would put two turns on one
 *   session — and the human's own parked message is the better prompt anyway.
 *
 * Archived and deleted threads never appear: `getShellSnapshot` filters them.
 *
 * A thread with a stale pending approval is deliberately NOT excluded. Its
 * callback state died with the process, and the failure text the reactor
 * already writes for one (`stalePendingRequestDetail`,
 * ProviderCommandReactor.ts) says to restart the turn — which is what this
 * does.
 */
export const selectInterruptedThreads = (input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly queuedMessageThreadIds: ReadonlySet<ThreadId>;
}): ReadonlyArray<InterruptedThreadCandidate> =>
  input.threads
    .filter(
      (thread) =>
        parseEpicRunIterationThreadId(thread.id) === null &&
        thread.parentThreadId === null &&
        thread.settledOverride !== "settled" &&
        !input.queuedMessageThreadIds.has(thread.id) &&
        (thread.latestTurn?.state === "running" || (thread.session?.activeTurnId ?? null) !== null),
    )
    .map((thread) => ({
      threadId: thread.id,
      latestTurnId: thread.latestTurn?.turnId ?? thread.session?.activeTurnId ?? null,
    }));

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const { readThreadShell, awaitResumeOutcome } = makeThreadSettleWatch({
    projectionSnapshotQuery,
    logPrefix: "provider.session.restart-nudge",
  });

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /**
   * A fresh uuid every time, never an id derived from the thread. Command
   * receipts are persisted, so a derived id would be deduped by the engine on
   * the next restart and the nudge would silently never happen again.
   */
  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:restart-nudge-${tag}:${uuid}`)),
      Effect.orDie,
    );

  const dispatch = (command: OrchestrationCommand) =>
    orchestrationEngine.dispatch(command).pipe(Effect.asVoid);

  const dispatchBestEffort = (label: string, threadId: ThreadId, command: OrchestrationCommand) =>
    dispatch(command).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(label, { threadId, cause: Cause.pretty(cause) }),
      ),
    );

  /**
   * Settle the dead turn before resuming, whatever killed the process.
   *
   * The reaper's boot pass already did this for a thread whose binding
   * outlived the process (a SIGKILL). It could not for a graceful SIGTERM:
   * `runStopAll` writes `stopped` into the session directory on the way out,
   * so at boot the reaper sees a stopped binding and skips the thread while
   * its projected turn is still running. Stopping here makes both restarts end
   * in the same place — turn `interrupted`, `activeTurnId` null — instead of
   * letting a resume settle a cut-off turn as `completed`, which is what
   * `settledTurnStateForSessionStatus` (ProjectionPipeline.ts) does for a
   * session that comes back `ready`.
   *
   * Best-effort: on the common path the thread is already stopped and this
   * changes nothing, so a failure is not a reason to abandon the resume.
   */
  const settleDeadTurn = (threadId: ThreadId) =>
    Effect.all({ commandId: commandId("session-stop"), createdAt: nowIso }).pipe(
      Effect.flatMap(({ commandId: stopCommandId, createdAt }) =>
        dispatchBestEffort("provider.session.restart-nudge.stop-failed", threadId, {
          type: "thread.session.stop",
          commandId: stopCommandId,
          threadId,
          reason: BOOT_RECONCILE_STOP_REASON,
          createdAt,
        }),
      ),
    );

  const nudgeThread = Effect.fn("InterruptedTurnNudger.nudgeThread")(function* (
    candidate: InterruptedThreadCandidate,
  ) {
    const { threadId } = candidate;
    const shell = yield* readThreadShell(threadId);
    if (shell === undefined) {
      // Deleted, archived, or unreadable since `collect`. Nothing to wake.
      return;
    }
    // Some other turn is already running on this thread: a human typed while
    // the boot pass worked through an earlier thread, or the queued-delivery
    // sweep released a parked message. Either way the thread is no longer
    // waiting on the restart, and a nudge would talk over live work.
    if (
      shell.latestTurn !== null &&
      shell.latestTurn.state === "running" &&
      shell.latestTurn.turnId !== candidate.latestTurnId
    ) {
      yield* Effect.logInfo("provider.session.restart-nudge.skipped-busy", {
        threadId,
        runningTurnId: shell.latestTurn.turnId,
      });
      return;
    }

    yield* settleDeadTurn(threadId);

    const resumeCommandId = yield* commandId("session-resume");
    const dispatched = yield* dispatch({
      type: "thread.session.resume",
      commandId: resumeCommandId,
      threadId,
      createdAt: yield* nowIso,
    }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.restart-nudge.resume-dispatch-failed", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );
    if (!dispatched) {
      return;
    }

    const outcome = yield* awaitResumeOutcome({
      threadId,
      requestCommandId: resumeCommandId,
      pollIntervalMs: RESUME_POLL_INTERVAL_MS,
    });
    yield* Effect.logInfo("provider.session.restart-nudge.resume-outcome", {
      threadId,
      outcome: outcome._tag,
    });
    if (outcome._tag !== "resumed") {
      // The thread stays stopped, exactly as it does today. A session that
      // started fresh has no memory of the interrupted work, so a "carry on"
      // prompt would be worse than the silence it replaces.
      return;
    }

    const promptId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* dispatchBestEffort("provider.session.restart-nudge.turn-start-failed", threadId, {
      type: "thread.turn.start",
      commandId: yield* commandId("turn-start"),
      threadId,
      message: {
        // A fresh id: reusing one already on the thread would rewrite that
        // message instead of adding this one.
        messageId: MessageId.make(`${threadId}-restart-nudge-${promptId}`),
        role: "user",
        text: RESTART_NUDGE_PROMPT,
        attachments: [],
      },
      // Written by the server, not by the person who owns the thread.
      origin: "agent",
      // `modelSelection` is deliberately omitted so the turn runs on whatever
      // the thread is set to, which is what the interrupted turn ran on.
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      createdAt: yield* nowIso,
    });
    yield* Effect.logInfo("provider.session.restart-nudge.nudged", { threadId });
  });

  const noCandidates: ReadonlyArray<InterruptedThreadCandidate> = [];

  const collectFailed = (cause: unknown) =>
    Effect.logWarning("provider.session.restart-nudge.collect-failed", { cause }).pipe(
      Effect.as(noCandidates),
    );

  const collect: InterruptedTurnNudgerShape["collect"] = () =>
    Effect.all({
      snapshot: projectionSnapshotQuery.getShellSnapshot(),
      queuedMessageThreadIds: projectionSnapshotQuery.listThreadIdsWithQueuedMessages(),
    }).pipe(
      Effect.map(({ snapshot, queuedMessageThreadIds }) =>
        selectInterruptedThreads({
          threads: snapshot.threads,
          queuedMessageThreadIds: new Set(queuedMessageThreadIds),
        }),
      ),
      Effect.tap((candidates) =>
        candidates.length === 0
          ? Effect.void
          : Effect.logInfo("provider.session.restart-nudge.collected", {
              threadCount: candidates.length,
              threadIds: candidates.map((candidate) => candidate.threadId),
            }),
      ),
      // Total on purpose: `collect` runs before anything else at boot, and a
      // read that fails must not take the server down with it. Caught as a
      // typed error plus a defect rather than as a whole cause, so an
      // interruption still propagates instead of reading as "no candidates".
      Effect.catch((error) => collectFailed(error)),
      Effect.catchDefect((defect) => collectFailed(defect)),
    );

  const nudge: InterruptedTurnNudgerShape["nudge"] = (candidates) =>
    candidates.length === 0
      ? Effect.void
      : Effect.forkScoped(
          Effect.forEach(
            candidates,
            (candidate) =>
              nudgeThread(candidate).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Effect.logWarning("provider.session.restart-nudge.failed", {
                        threadId: candidate.threadId,
                        cause: Cause.pretty(cause),
                      }),
                ),
              ),
            { concurrency: NUDGE_CONCURRENCY, discard: true },
          ),
        ).pipe(Effect.asVoid);

  return { collect, nudge } satisfies InterruptedTurnNudgerShape;
});

export const InterruptedTurnNudgerLive = Layer.effect(InterruptedTurnNudger, make);
