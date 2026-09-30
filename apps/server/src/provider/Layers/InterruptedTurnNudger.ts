/**
 * InterruptedTurnNudger - restart a turn that a dead harness process cut off.
 *
 * Two triggers share one per-thread path. The boot pass (`collect` + `nudge`)
 * handles a server restart. The process-exit watcher (`watchProcessExits`)
 * handles a Claude Code process that died under a server that kept running.
 * See `../Services/InterruptedTurnNudger.ts` for why each exists and why the
 * boot pass is two calls.
 *
 * The per-thread path here is the same handshake
 * `PoolDispatch.resumeIteration` (runner/Layers/PoolDispatch.ts) uses for an
 * epic iteration: dispatch `thread.session.resume`, wait for the durable
 * `provider.session.resume.settled` activity, and say nothing to the agent
 * until the outcome is `resumed`. The proof is not optional — Codex and
 * OpenCode silently open a blank session on a stale cursor, and prompting one
 * of those would put a "carry on" message in front of an agent with no memory
 * of the work.
 *
 * The watcher reads `session.exited` straight off `ProviderService.streamEvents`
 * rather than the projection, because only the adapter knows the two facts it
 * acts on: whether a turn was in flight (`midTurn`) and which background tasks
 * and Monitors died with the process (`orphanedTasks`). The projection records
 * neither. A crash that leaves an idle thread with no tasks is ignored on
 * purpose: nothing was lost, and the next human message restarts the session
 * anyway.
 *
 * @module InterruptedTurnNudger
 */
import {
  CommandId,
  MessageId,
  parseEpicRunIterationThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
  type RuntimeOrphanedTask,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeThreadSettleWatch } from "../../orchestration/ThreadSettleWatch.ts";
import {
  InterruptedTurnNudger,
  type InterruptedThreadCandidate,
  type InterruptedTurnNudgerShape,
} from "../Services/InterruptedTurnNudger.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { BOOT_RECONCILE_STOP_REASON } from "./ProviderSessionReaper.ts";

/**
 * Where a process started from a session actually lives, and how to escape it.
 *
 * Agents reach for `nohup`, `setsid` or `disown` to keep a watcher alive, and
 * none of them help: systemd tracks the T3 Code service by cgroup, not by
 * process tree, so a restart kills every process in that cgroup however it was
 * detached. A transient user unit is the one launch that lands in a cgroup of
 * its own. `--setenv` is spelled out because a transient unit does not inherit
 * the session's environment, which is the first thing that breaks.
 */
export const PROCESS_LIFETIME_NOTE = [
  "A process you start from this session, even with nohup/setsid/disown, lives in the T3 Code service's cgroup and dies when the server restarts.",
  "For anything that must outlive a restart, use `systemd-run --user --unit=<name> --setenv=VAR=value <command>`.",
].join(" ");

/**
 * The in-flight and re-verify lines both prompts share.
 *
 * They carry what the transcript cannot show. Tool calls that were in flight
 * never returned, so their results are absent rather than empty. And the work
 * may in fact be complete, with only the report lost — which is why the last
 * instruction is "or send your report again" rather than "start over".
 */
const CUT_OFF_TURN_LINES = [
  "Any tool call that was in flight never returned, and its result is lost.",
  "Re-verify the current state before you continue: re-read the files you were changing, re-run the command you were waiting on, and check `git status` if you were committing.",
  "Then finish the work you were on. If it was already done and only your report was lost, send that report again.",
];

/**
 * What the agent is told after a server restart cut its turn off.
 *
 * The first line says the turn ended because the process died, not because
 * anything finished. The background-task line is unconditional: the boot pass
 * has no record of which tasks the dead process was running (that list lived
 * in the old server's memory), but a restart kills every one of them, so the
 * agent is told to assume the worst and re-arm what it still needs.
 */
export const RESTART_NUDGE_PROMPT = [
  "The T3 Code server restarted while you were working, so your turn was cut off mid-way.",
  ...CUT_OFF_TURN_LINES,
  "Background shell tasks and Monitors started before the restart died with it; re-arm the ones you still need.",
  PROCESS_LIFETIME_NOTE,
].join(" ");

const describeOrphanedTask = (task: RuntimeOrphanedTask): string =>
  [
    `- \`${task.taskId}\``,
    task.taskType === undefined ? "" : ` (${task.taskType})`,
    task.description === undefined ? "" : `: ${task.description}`,
  ].join("");

/**
 * What the agent is told after its own Claude Code process died.
 *
 * Unlike a restart, the adapter knows exactly what was lost, so the prompt
 * names it instead of hedging. The cut-off lines appear only when a turn was
 * actually in flight: an idle agent told its "tool call never returned" would
 * go hunting for a call that never existed. The task list is by id because an
 * agent re-arms a Monitor from its own transcript, and the id is what it can
 * search for there.
 */
export const processExitNudgePrompt = (input: {
  readonly midTurn: boolean;
  readonly orphanedTasks: ReadonlyArray<RuntimeOrphanedTask>;
}): string => {
  const sections: Array<string> = [
    [
      "Your Claude Code process exited unexpectedly, so the T3 Code server resumed this session.",
      ...(input.midTurn ? ["Your turn was cut off mid-way.", ...CUT_OFF_TURN_LINES] : []),
    ].join(" "),
  ];
  if (input.orphanedTasks.length > 0) {
    sections.push(
      [
        "These background tasks and Monitors died with it:",
        ...input.orphanedTasks.map(describeOrphanedTask),
      ].join("\n"),
      "Re-check the state they were watching and re-arm the ones you still need.",
    );
  }
  sections.push(PROCESS_LIFETIME_NOTE);
  return sections.join("\n\n");
};

/**
 * The stop reason the process-exit path settles the dead turn with. Distinct
 * from `BOOT_RECONCILE_STOP_REASON` so the thread's history says which of the
 * two killed the turn.
 */
export const PROCESS_EXIT_STOP_REASON =
  "session interrupted: Claude Code process exited unexpectedly";

/**
 * How often a resume wait re-reads the projection. The answer is written when
 * the provider session starts, so this is provider latency, not projection lag.
 */
const RESUME_POLL_INTERVAL_MS = 250;

/**
 * How many threads are resumed at once, across both triggers.
 *
 * Every resume starts a real harness process, so this is a load bound, not a
 * throughput knob. A restart normally leaves one or two interrupted threads;
 * four keeps a rare pile-up from serializing behind a 120s resume timeout
 * without opening a fork bomb at boot. The bound is one semaphore shared by
 * the boot pass and the exit watcher, because a crash storm right after boot
 * would otherwise double it.
 */
const NUDGE_CONCURRENCY = 4;

/**
 * How long the exit watcher waits for the projection to record the exit.
 *
 * Ingestion and the watcher are independent subscribers of `streamEvents`, so
 * the watcher can see `session.exited` before the projected session turns
 * `stopped`. Resuming before then would let the late `stopped` land on top of
 * the resumed session. Projection lag is milliseconds; fifteen seconds is far
 * past it, and a thread that still is not stopped is left alone.
 */
const EXIT_SETTLE_TIMEOUT_MS = 15_000;

/**
 * The crash-loop guard: at most one process-exit nudge per thread in this
 * window.
 *
 * A process that dies on the same input every time would otherwise be resumed,
 * prompted, and killed again forever, each round costing a real harness start.
 * Ten minutes lets a one-off crash recover at once while turning a loop into a
 * thread that waits for a human. In memory on purpose: a server restart is a
 * fresh start, and the boot pass has its own single-shot semantics.
 */
const EXIT_NUDGE_COOLDOWN_MS = 10 * 60_000;

/**
 * Whether a thread may be nudged at all, whatever killed its process.
 *
 * One function for both triggers, because every reason below holds as much
 * for a crashed process as for a restart: the epic runner owns its iterations,
 * a subagent child has nobody waiting on it, a settled thread was put down on
 * purpose, and a parked message is a better prompt than ours. The reasons are
 * spelled out on `selectInterruptedThreads`.
 */
export const isNudgeEligibleThread = (
  thread: OrchestrationThreadShell,
  queuedMessageThreadIds: ReadonlySet<ThreadId>,
): boolean =>
  parseEpicRunIterationThreadId(thread.id) === null &&
  thread.parentThreadId === null &&
  thread.settledOverride !== "settled" &&
  !queuedMessageThreadIds.has(thread.id);

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
 *
 * The four exclusions live in `isNudgeEligibleThread`, which the process-exit
 * watcher applies too.
 */
export const selectInterruptedThreads = (input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly queuedMessageThreadIds: ReadonlySet<ThreadId>;
}): ReadonlyArray<InterruptedThreadCandidate> =>
  input.threads
    .filter(
      (thread) =>
        isNudgeEligibleThread(thread, input.queuedMessageThreadIds) &&
        (thread.latestTurn?.state === "running" || (thread.session?.activeTurnId ?? null) !== null),
    )
    .map((thread) => ({
      threadId: thread.id,
      latestTurnId: thread.latestTurn?.turnId ?? thread.session?.activeTurnId ?? null,
    }));

/**
 * What differs between the two triggers once a thread is chosen. Everything
 * else in the per-thread path is shared, so a fix to the handshake lands in
 * both at once.
 */
interface NudgeKind {
  readonly prompt: string;
  readonly stopReason: string;
  /** Goes into every command id, so receipts say which trigger sent them. */
  readonly commandTag: string;
  /** Goes into the nudge message id, for the same reason. */
  readonly messageIdTag: string;
  readonly logPrefix: string;
  /**
   * Settle only a thread whose projected session is `stopped` right before
   * the settle. The exit path waited for exactly that, and anything else now
   * means a human started a new session since, which the settle would kill.
   * The restart path must not require it: its settle exists because a
   * SIGTERM restart leaves the dead session projected `running`.
   */
  readonly requireStoppedSession: boolean;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;

  const nudgeSemaphore = yield* Semaphore.make(NUDGE_CONCURRENCY);
  /** Last process-exit nudge per thread, for the crash-loop guard. */
  const lastExitNudgeAtMs = new Map<ThreadId, number>();

  const { readThreadShell } = makeThreadSettleWatch({
    projectionSnapshotQuery,
    logPrefix: "provider.session.exit-nudge",
  });

  const restartNudgeKind: NudgeKind = {
    prompt: RESTART_NUDGE_PROMPT,
    stopReason: BOOT_RECONCILE_STOP_REASON,
    commandTag: "restart-nudge",
    messageIdTag: "restart-nudge",
    logPrefix: "provider.session.restart-nudge",
    requireStoppedSession: false,
  };

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /**
   * A fresh uuid every time, never an id derived from the thread. Command
   * receipts are persisted, so a derived id would be deduped by the engine on
   * the next restart and the nudge would silently never happen again.
   */
  const commandId = (kind: NudgeKind, tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:${kind.commandTag}-${tag}:${uuid}`)),
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
   * session that comes back `ready`. A process exit has already stopped the
   * session by the time the watcher gets here, so on that path this is the
   * same no-op as the common restart path.
   *
   * Best-effort: on the common path the thread is already stopped and this
   * changes nothing, so a failure is not a reason to abandon the resume.
   */
  const settleDeadTurn = (kind: NudgeKind, threadId: ThreadId) =>
    Effect.all({ commandId: commandId(kind, "session-stop"), createdAt: nowIso }).pipe(
      Effect.flatMap(({ commandId: stopCommandId, createdAt }) =>
        dispatchBestEffort(`${kind.logPrefix}.stop-failed`, threadId, {
          type: "thread.session.stop",
          commandId: stopCommandId,
          threadId,
          reason: kind.stopReason,
          createdAt,
        }),
      ),
    );

  const nudgeThreadUnbounded = Effect.fn("InterruptedTurnNudger.nudgeThread")(function* (
    candidate: InterruptedThreadCandidate,
    kind: NudgeKind,
  ) {
    const { threadId } = candidate;
    // Built per call only so its read failures log under this trigger's prefix.
    const { readThreadShell: readShell, awaitResumeOutcome } = makeThreadSettleWatch({
      projectionSnapshotQuery,
      logPrefix: kind.logPrefix,
    });
    const shell = yield* readShell(threadId);
    if (shell === undefined) {
      // Deleted, archived, or unreadable since it was chosen. Nothing to wake.
      return;
    }
    // A turn this pass did not collect now sits on the thread: a human typed
    // while the boot pass worked through an earlier thread, or the
    // queued-delivery sweep released a parked message. Either way the thread
    // has moved on from the restart and is no longer waiting on it.
    //
    // Any different turn disqualifies the nudge, not just a running one. The
    // fan-out is four wide and a resume can hold a slot for the full 120s
    // bound, which is ample time for a turn to start AND finish ahead of this
    // one — and stopping a healthy session to tell it that it was "cut off"
    // is the worst outcome this pass can produce. Nothing legitimate is lost
    // by the wider test: both restart shapes leave the dead turn's own id in
    // place, so a thread that really is waiting still matches.
    if (shell.latestTurn !== null && shell.latestTurn.turnId !== candidate.latestTurnId) {
      yield* Effect.logInfo(`${kind.logPrefix}.skipped-moved-on`, {
        threadId,
        interruptedTurnId: candidate.latestTurnId,
        latestTurnId: shell.latestTurn.turnId,
        latestTurnState: shell.latestTurn.state,
      });
      return;
    }
    // A message parked since the thread was chosen. Same reasoning as the
    // collect-time exclusion (`selectInterruptedThreads`): the settle below
    // releases the delivery poller, so a nudge too would put two turns on one
    // session. Re-read here because the semaphore wait can be long, and the exit
    // watcher also spends up to `EXIT_SETTLE_TIMEOUT_MS` before it gets here.
    const queuedMessageThreadIds = yield* projectionSnapshotQuery.listThreadIdsWithQueuedMessages();
    const hasQueuedMessage = queuedMessageThreadIds.includes(threadId);

    if (kind.requireStoppedSession) {
      const current = yield* readShell(threadId);
      const status = current?.session?.status ?? null;
      if (status !== "stopped") {
        yield* Effect.logInfo(`${kind.logPrefix}.skipped-session-not-stopped`, {
          threadId,
          sessionStatus: status,
        });
        return;
      }
    }

    yield* settleDeadTurn(kind, threadId);

    if (hasQueuedMessage) {
      // Settled, but not resumed. After a SIGTERM restart the dead turn still
      // projects `running`, and the delivery poller waits for it to end, so
      // skipping the settle too would strand the parked message. The parked
      // message then becomes the next turn, so no nudge follows.
      yield* Effect.logInfo(`${kind.logPrefix}.settled-for-queued-message`, { threadId });
      return;
    }

    const resumeCommandId = yield* commandId(kind, "session-resume");
    const dispatched = yield* dispatch({
      type: "thread.session.resume",
      commandId: resumeCommandId,
      threadId,
      createdAt: yield* nowIso,
    }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning(`${kind.logPrefix}.resume-dispatch-failed`, {
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
    yield* Effect.logInfo(`${kind.logPrefix}.resume-outcome`, {
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
    yield* dispatchBestEffort(`${kind.logPrefix}.turn-start-failed`, threadId, {
      type: "thread.turn.start",
      commandId: yield* commandId(kind, "turn-start"),
      threadId,
      message: {
        // A fresh id: reusing one already on the thread would rewrite that
        // message instead of adding this one.
        messageId: MessageId.make(`${threadId}-${kind.messageIdTag}-${promptId}`),
        role: "user",
        text: kind.prompt,
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
    yield* Effect.logInfo(`${kind.logPrefix}.nudged`, { threadId });
  });

  /**
   * One thread's whole handshake under a shared permit, with every failure
   * logged. Never fails: one thread's broken resume must not stop the others.
   * Interruption is let through silently, since that is shutdown, not a fault.
   */
  const nudgeThread = (candidate: InterruptedThreadCandidate, kind: NudgeKind) =>
    nudgeSemaphore
      .withPermits(1)(nudgeThreadUnbounded(candidate, kind))
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning(`${kind.logPrefix}.failed`, {
                threadId: candidate.threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      );

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
          // Unbounded here because the shared semaphore inside `nudgeThread`
          // is the real bound.
          Effect.forEach(candidates, (candidate) => nudgeThread(candidate, restartNudgeKind), {
            concurrency: "unbounded",
            discard: true,
          }),
        ).pipe(Effect.asVoid);

  /**
   * Poll until the projected session is exactly `stopped`, or give up.
   *
   * Not `error`: a failed turn projects `error` before `session.exited` lands,
   * so resuming on `error` would let the late `stopped` overwrite the resumed
   * session. Only `stopped` proves ingestion has recorded the exit.
   */
  const awaitProjectedStop = (threadId: ThreadId) =>
    Effect.gen(function* () {
      while (true) {
        const shell = yield* readThreadShell(threadId);
        if (shell?.session?.status === "stopped") {
          return;
        }
        yield* Effect.sleep(Duration.millis(RESUME_POLL_INTERVAL_MS));
      }
    }).pipe(
      Effect.timeoutOption(Duration.millis(EXIT_SETTLE_TIMEOUT_MS)),
      Effect.map(Option.isSome),
    );

  const handleProcessExit = Effect.fn("InterruptedTurnNudger.handleProcessExit")(function* (
    threadId: ThreadId,
    payload: {
      readonly midTurn?: boolean | undefined;
      readonly orphanedTasks?: ReadonlyArray<RuntimeOrphanedTask> | undefined;
    },
  ) {
    // Read first, before any wait: the turn on the thread right now is the one
    // the process died in, and the moved-on check needs exactly that id.
    const shell = yield* readThreadShell(threadId);
    const midTurn = payload.midTurn === true;
    const orphanedTasks = payload.orphanedTasks ?? [];
    if (!midTurn && orphanedTasks.length === 0) {
      // Idle and task-free: nothing was lost, and the next message restarts
      // the session on its own.
      return;
    }
    if (shell === undefined) {
      return;
    }
    const queuedMessageThreadIds = yield* projectionSnapshotQuery.listThreadIdsWithQueuedMessages();
    if (!isNudgeEligibleThread(shell, new Set(queuedMessageThreadIds))) {
      yield* Effect.logInfo("provider.session.exit-nudge.skipped-ineligible", { threadId });
      return;
    }
    const candidate: InterruptedThreadCandidate = {
      threadId,
      latestTurnId: shell.latestTurn?.turnId ?? null,
    };

    const stopped = yield* awaitProjectedStop(threadId);
    if (!stopped) {
      yield* Effect.logWarning("provider.session.exit-nudge.skipped-not-stopped", {
        threadId,
        timeoutMs: EXIT_SETTLE_TIMEOUT_MS,
      });
      return;
    }

    // Checked and recorded in one synchronous step, after the wait, so two
    // exits racing for the same thread cannot both pass.
    const now = yield* Clock.currentTimeMillis;
    const previousNudgeAtMs = yield* Effect.sync(() => {
      const last = lastExitNudgeAtMs.get(threadId);
      if (last !== undefined && now - last < EXIT_NUDGE_COOLDOWN_MS) {
        return last;
      }
      lastExitNudgeAtMs.set(threadId, now);
      return undefined;
    });
    if (previousNudgeAtMs !== undefined) {
      yield* Effect.logWarning("provider.session.exit-nudge.skipped-crash-loop", {
        threadId,
        sinceLastNudgeMs: now - previousNudgeAtMs,
      });
      return;
    }

    yield* nudgeThread(candidate, {
      prompt: processExitNudgePrompt({ midTurn, orphanedTasks }),
      stopReason: PROCESS_EXIT_STOP_REASON,
      commandTag: "exit-nudge",
      messageIdTag: "exit-nudge",
      logPrefix: "provider.session.exit-nudge",
      requireStoppedSession: true,
    });
  });

  const watchProcessExits: InterruptedTurnNudgerShape["watchProcessExits"] = () =>
    Effect.gen(function* () {
      // Per-event fibers, so one thread's settle wait and resume never hold up
      // the stream. The set removes each fiber as it finishes and interrupts
      // the rest when the scope closes.
      const fibers = yield* FiberSet.make<void, never>();
      yield* Stream.runForEach(providerService.streamEvents, (event: ProviderRuntimeEvent) =>
        event.type === "session.exited" && event.payload.exitKind === "error"
          ? FiberSet.run(
              fibers,
              handleProcessExit(event.threadId, event.payload).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Effect.logWarning("provider.session.exit-nudge.failed", {
                        threadId: event.threadId,
                        cause: Cause.pretty(cause),
                      }),
                ),
              ),
            ).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkScoped);
    });

  return { collect, nudge, watchProcessExits } satisfies InterruptedTurnNudgerShape;
});

export const InterruptedTurnNudgerLive = Layer.effect(InterruptedTurnNudger, make);
