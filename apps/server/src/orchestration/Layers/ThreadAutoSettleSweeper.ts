import { CommandId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { ServerSettingsService } from "../../serverSettings.ts";
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

const makeThreadAutoSettleSweeper = (options?: ThreadAutoSettleSweeperLiveOptions) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const serverSettings = yield* ServerSettingsService;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const candidateLimit = Math.max(1, options?.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT);

    // A refusal is the decider doing its job — the thread picked up an
    // approval, a session or a queued turn between the candidate read and the
    // dispatch — so it is logged as ordinary traffic. Anything else (a
    // persistence failure, a projector decode failure) is an operator's
    // problem and reaches a warning.
    const settleCandidate = (candidate: ProjectionAutoSettleCandidate, nowIso: string) =>
      orchestrationEngine
        .dispatch({
          type: "thread.settle",
          // A fresh id per sweep: command receipts remember rejections, so a
          // stable id would make one refusal permanent and the thread would
          // never be retried.
          commandId: CommandId.make(`thread-auto-settle:${candidate.threadId}:${nowIso}`),
          threadId: candidate.threadId,
        })
        .pipe(
          Effect.as(true),
          Effect.catch((error) =>
            (isSettleRefusal(error)
              ? Effect.logInfo("thread.auto-settle.refused", {
                  threadId: candidate.threadId,
                  lastActivityAt: candidate.lastActivityAt,
                  detail: error.message,
                })
              : Effect.logWarning("thread.auto-settle.dispatch-failed", {
                  threadId: candidate.threadId,
                  lastActivityAt: candidate.lastActivityAt,
                  error,
                })
            ).pipe(Effect.as(false)),
          ),
        );

    const sweep = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const autoSettleAfterDays = settings.threadAutoSettleAfterDays;
      if (autoSettleAfterDays === null) {
        return;
      }

      const windowMs = autoSettleAfterDays * DAY_MS;
      const now = yield* DateTime.now;
      const idleBefore = DateTime.formatIso(
        DateTime.subtractDuration(now, Duration.millis(windowMs)),
      );

      const candidates = yield* projectionSnapshotQuery.listAutoSettleCandidates({
        idleBefore,
        limit: candidateLimit,
      });
      if (candidates.length === 0) {
        return;
      }

      const nowIso = DateTime.formatIso(now);
      let settledCount = 0;
      for (const candidate of candidates) {
        if (yield* settleCandidate(candidate, nowIso)) {
          settledCount += 1;
        }
      }

      yield* Effect.logInfo("thread.auto-settle.sweep-complete", {
        settledCount,
        candidateCount: candidates.length,
        idleBefore,
        // The sweep stopped at the limit, so more candidates may remain for the
        // next one. Never truncate silently.
        limited: candidates.length === candidateLimit,
      });
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
