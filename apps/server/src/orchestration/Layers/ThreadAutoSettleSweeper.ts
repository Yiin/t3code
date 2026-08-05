import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster, type VcsStatusPeek } from "../../vcs/VcsStatusBroadcaster.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionAutoSettleCandidate,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadAutoSettleSweeper,
  type ThreadAutoSettleSweeperShape,
} from "../Services/ThreadAutoSettleSweeper.ts";
import { RUNNING_SUBAGENT_FRESHNESS_MS } from "../subagentLiveness.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1_000;
/**
 * One sweep dispatches at most this many settles. The window is measured in
 * days, so the first sweep after this feature ships (or after the setting is
 * lowered) can find a whole backlog at once; the rest is picked up by the next
 * sweep instead of flooding the command queue in one pass.
 */
const DEFAULT_CANDIDATE_LIMIT = 100;

export interface ThreadAutoSettleSweeperLiveOptions {
  readonly sweepIntervalMs?: number;
  readonly candidateLimit?: number;
}

const isSettleRefusal = (error: OrchestrationDispatchError): boolean =>
  error._tag === "OrchestrationCommandInvariantError" ||
  error._tag === "OrchestrationCommandPreviouslyRejectedError";

/**
 * Which rule asked for a settle. The two passes get their own command id
 * prefix so a receipt from one never suppresses the other, and their own log
 * field so an operator can tell why a thread settled.
 */
type SweepPass = "idle" | "pr-merged";

const COMMAND_ID_PREFIX = {
  idle: "thread-auto-settle",
  "pr-merged": "thread-pr-settle",
} as const satisfies Record<SweepPass, string>;

/**
 * The server twin of the client's `resolveThreadPr`
 * (apps/web/src/components/ThreadStatusIndicators.tsx). A thread with its own
 * worktree owns whatever change request that cwd reports. A thread working in
 * the shared workspace root only owns it while the checked-out ref is still
 * the thread's branch — otherwise a sibling thread's merged PR, or a plain
 * `git switch` by the user, would settle it.
 */
const resolveCandidatePr = (candidate: ProjectionAutoSettleCandidate, status: VcsStatusPeek) => {
  if (
    candidate.worktreePath === null &&
    (candidate.branch === null || status.local?.refName !== candidate.branch)
  ) {
    return null;
  }
  return status.remote?.pr ?? null;
};

const makeThreadAutoSettleSweeper = (options?: ThreadAutoSettleSweeperLiveOptions) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const serverSettings = yield* ServerSettingsService;
    const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const candidateLimit = Math.max(1, options?.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT);

    // A refusal is the decider doing its job — the thread picked up an
    // approval, a session or a queued turn between the candidate read and the
    // dispatch — so it is logged as ordinary traffic. Anything else (a
    // persistence failure, a projector decode failure) is an operator's
    // problem and reaches a warning.
    const settleCandidate = (
      candidate: ProjectionAutoSettleCandidate,
      nowIso: string,
      pass: SweepPass,
    ) =>
      orchestrationEngine
        .dispatch({
          type: "thread.settle",
          // A fresh id per sweep: command receipts remember rejections, so a
          // stable id would make one refusal permanent and the thread would
          // never be retried.
          commandId: CommandId.make(`${COMMAND_ID_PREFIX[pass]}:${candidate.threadId}:${nowIso}`),
          threadId: candidate.threadId,
        })
        .pipe(
          Effect.as(true),
          Effect.catch((error) =>
            (isSettleRefusal(error)
              ? Effect.logInfo("thread.auto-settle.refused", {
                  pass,
                  threadId: candidate.threadId,
                  lastActivityAt: candidate.lastActivityAt,
                  detail: error.message,
                })
              : Effect.logWarning("thread.auto-settle.dispatch-failed", {
                  pass,
                  threadId: candidate.threadId,
                  lastActivityAt: candidate.lastActivityAt,
                  error,
                })
            ).pipe(Effect.as(false)),
          ),
        );

    /**
     * Settle everything idle past the configured window. Returns the threads it
     * settled, so the merged-PR pass does not dispatch a second command against
     * a row whose projection has not caught up yet.
     */
    /**
     * Threads with a `running` subagent row touched after this cutoff are
     * excluded from both passes: the settle decider would refuse them anyway,
     * so reading them as candidates only produces refusal traffic.
     */
    const runningSubagentFreshAfter = (now: DateTime.DateTime) =>
      DateTime.formatIso(
        DateTime.subtractDuration(now, Duration.millis(RUNNING_SUBAGENT_FRESHNESS_MS)),
      );

    const sweepIdle = (now: DateTime.DateTime, nowIso: string) =>
      Effect.gen(function* () {
        const settled = new Set<ThreadId>();
        const settings = yield* serverSettings.getSettings;
        const autoSettleAfterDays = settings.threadAutoSettleAfterDays;
        if (autoSettleAfterDays === null) {
          return settled;
        }

        const windowMs = autoSettleAfterDays * DAY_MS;
        const idleBefore = DateTime.formatIso(
          DateTime.subtractDuration(now, Duration.millis(windowMs)),
        );

        const candidates = yield* projectionSnapshotQuery.listAutoSettleCandidates({
          idleBefore,
          limit: candidateLimit,
          runningSubagentFreshAfter: runningSubagentFreshAfter(now),
        });
        if (candidates.length === 0) {
          return settled;
        }

        for (const candidate of candidates) {
          if (yield* settleCandidate(candidate, nowIso, "idle")) {
            settled.add(candidate.threadId);
          }
        }

        yield* Effect.logInfo("thread.auto-settle.sweep-complete", {
          settledCount: settled.size,
          candidateCount: candidates.length,
          idleBefore,
          // The sweep stopped at the limit, so more candidates may remain for the
          // next one. Never truncate silently.
          limited: candidates.length === candidateLimit,
        });
        return settled;
      });

    /**
     * Settle everything whose change request the server can already see is
     * merged. No idle window, and no loading either: this reads only what the
     * VCS status cache happens to hold, which is the cwds a client is watching
     * — the same set where the client's display-only merge rule fires today,
     * and the only set where server and client can be seen to disagree.
     *
     * It runs whatever `threadAutoSettleAfterDays` says, because that setting
     * governs the idle rule alone; the client's merge rule ignores it too
     * (packages/client-runtime/src/state/threadSettled.ts).
     */
    const sweepPrMerged = (
      now: DateTime.DateTime,
      nowIso: string,
      alreadySettled: ReadonlySet<ThreadId>,
    ) =>
      Effect.gen(function* () {
        const candidates = yield* projectionSnapshotQuery.listAutoSettleCandidates({
          idleBefore: null,
          limit: candidateLimit,
          runningSubagentFreshAfter: runningSubagentFreshAfter(now),
        });

        let settledCount = 0;
        let mergedCount = 0;
        for (const candidate of candidates) {
          if (alreadySettled.has(candidate.threadId)) {
            continue;
          }
          const status = yield* vcsStatusBroadcaster.peekStatus(
            candidate.worktreePath ?? candidate.workspaceRoot,
          );
          if (status === null) {
            continue;
          }
          // `merged` only, never `closed`. The cache has no expiry, so a peeked
          // value can be arbitrarily old: a merge never un-merges, but a closed
          // change request can be reopened.
          if (resolveCandidatePr(candidate, status)?.state !== "merged") {
            continue;
          }
          mergedCount += 1;
          if (yield* settleCandidate(candidate, nowIso, "pr-merged")) {
            settledCount += 1;
          }
        }

        if (mergedCount === 0) {
          return;
        }
        yield* Effect.logInfo("thread.pr-settle.sweep-complete", {
          settledCount,
          mergedCount,
          candidateCount: candidates.length,
          // Candidates are read oldest-activity first, so a database with more
          // unsettled threads than the limit hides the freshest ones from this
          // pass until the older ones settle. Never truncate silently.
          limited: candidates.length === candidateLimit,
        });
      });

    const sweep = Effect.gen(function* () {
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const settled = yield* sweepIdle(now, nowIso);
      yield* sweepPrMerged(now, nowIso, settled);
    });

    const start: ThreadAutoSettleSweeperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("thread.auto-settle.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("thread.auto-settle.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("thread.auto-settle.started", {
          sweepIntervalMs,
          candidateLimit,
        });
      });

    return {
      start,
    } satisfies ThreadAutoSettleSweeperShape;
  });

export const makeThreadAutoSettleSweeperLive = (options?: ThreadAutoSettleSweeperLiveOptions) =>
  Layer.effect(ThreadAutoSettleSweeper, makeThreadAutoSettleSweeper(options));

export const ThreadAutoSettleSweeperLive = makeThreadAutoSettleSweeperLive();
