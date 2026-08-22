/**
 * spawnReconciliation - stop the parent's roster from lying after a restart.
 *
 * A restart kills the parent's `spawn_agent` call and the in-process
 * `SpawnRegistry`, but not the parent's projected subagent row and not the
 * child thread. The row keeps saying `running` with nobody waiting on it, so
 * the roster shows a subagent that never ends and `activeSubagentCount` stays
 * wrong.
 *
 * Even doing nothing self-heals eventually: nothing refreshes the row, so it
 * falls out of `countFreshRunningSubagents` after `RUNNING_SUBAGENT_FRESHNESS_MS`
 * (15 minutes, `packages/contracts/src/orchestration.ts`). This sweep makes the
 * state honest at once instead of after a 15-minute lie.
 *
 * It is **not** a resume path. Epic `t3code-y5l` owns session lifecycle: a
 * child thread gets its session back through
 * `ProviderService.startSession` / `recoverSessionForThread` the moment the
 * human sends it a message from the drawer, exactly like any other thread. So
 * this dispatches nothing but `thread.activity.append` — no `thread.create`, no
 * `thread.turn.start`, and nothing that could revive a child on its own.
 *
 * Two outcomes per orphan:
 *
 * - The child thread still exists and its provider session is live -> leave the
 *   child alone and write one `task.progress` saying the parent stopped
 *   waiting. The human can still open the drawer and talk to it.
 * - Anything else -> close the row with `task.completed { status: "stopped" }`.
 *
 * In-process rows (`child_thread_id IS NULL`, e.g. Claude/Codex Task spawns)
 * get only the second outcome: they live inside the parent's provider session,
 * so a restart kills them with it. They are closed unless the parent session
 * is live in this process.
 *
 * @module agents/spawnReconciliation
 */
import { EventId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  ProjectionSnapshotQuery,
  type ProjectionRunningInProcessSubagent,
  type ProjectionRunningThreadBackedSubagent,
} from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../../../provider/Services/ProviderService.ts";
import {
  appendActivity,
  appendChildProgress,
  appendChildSettled,
  type ChildMirrorTarget,
} from "./childMirror.ts";
import { findSpawnByChild } from "./SpawnRegistry.ts";

/** The progress line for a child that outlived the parent waiting on it. */
export const ORPHANED_SPAWN_DETACHED_SUMMARY =
  "The server restarted, so nothing is waiting on this subagent any more. It is still running; open it to talk to it.";

/** The closing line for a child the restart took with it. */
export const ORPHANED_SPAWN_STOPPED_SUMMARY = "Server restarted while this subagent was running.";

/**
 * The mirror target rebuilt from the projected row.
 *
 * `prompt` is empty on purpose: neither append reads it, and the original
 * prompt died with the tool call that carried it.
 */
const targetOf = (orphan: ProjectionRunningThreadBackedSubagent): ChildMirrorTarget => ({
  parentThreadId: orphan.parentThreadId,
  parentTurnId: orphan.turnId,
  childThreadId: orphan.childThreadId,
  agentType: orphan.agentType ?? "subagent",
  description: orphan.description ?? "",
  prompt: "",
});

/**
 * Is this child still there, with a session this process can reach?
 *
 * `hasLiveSession` reads the adapter's own session map with recovery disabled,
 * so it answers for the running process and never starts anything. A read that
 * fails answers `false`: an orphan we cannot judge is closed rather than left
 * claiming work, which is the whole point of the sweep.
 */
const childIsLive = (
  childThreadId: ThreadId,
): Effect.Effect<boolean, never, ProjectionSnapshotQuery | ProviderService> =>
  Effect.gen(function* () {
    const projection = yield* ProjectionSnapshotQuery;
    const providerService = yield* ProviderService;
    const shell = yield* projection.getThreadShellById(childThreadId);
    if (Option.isNone(shell)) return false;
    return yield* providerService.hasLiveSession(childThreadId);
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("subagent.spawn.reconcile-liveness-failed", {
            childThreadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
    ),
  );

/**
 * Is this parent thread's provider session live in this process?
 *
 * Same read as `childIsLive` minus the thread-shell check: the sweep query
 * already joined the live parent thread. A live parent means a possibly-live
 * in-process subagent — only reachable if the layer is rebuilt mid-life, but
 * closing a live spawn's row underneath it is the exact bug the guard exists
 * against. A read that fails answers `false`, as in `childIsLive`.
 */
const parentIsLive = (parentThreadId: ThreadId): Effect.Effect<boolean, never, ProviderService> =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    return yield* providerService.hasLiveSession(parentThreadId);
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("subagent.spawn.reconcile-parent-liveness-failed", {
            parentThreadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
    ),
  );

/**
 * Close an in-process subagent row the restart took with the parent's session.
 *
 * `appendChildSettled` cannot serve here: it keys `taskId` on the child
 * thread id, which an in-process row does not have. Same activity shape
 * otherwise — the `task.completed` fold (`applySubagentActivity`) matches the
 * existing row by `taskId` regardless of `childThreadId`.
 */
const appendInProcessStopped = (
  row: ProjectionRunningInProcessSubagent,
  stamp: string,
): Effect.Effect<void, never, OrchestrationEngineService> => {
  const title =
    row.description !== null && row.description.trim().length > 0
      ? row.description.trim().slice(0, 120)
      : undefined;
  return appendActivity({
    parentThreadId: row.parentThreadId,
    commandId: `server:subagent-reconcile-stopped:${row.parentThreadId}:${row.subagentId}:${stamp}`,
    activity: {
      id: EventId.make(`task-completed:${row.parentThreadId}:${row.subagentId}`),
      tone: "info",
      kind: "task.completed",
      summary: "Subagent stopped",
      payload: {
        taskId: row.subagentId,
        status: "stopped",
        subagentType: row.agentType ?? "subagent",
        ...(title !== undefined ? { title } : {}),
        summary: ORPHANED_SPAWN_STOPPED_SUMMARY,
        detail: ORPHANED_SPAWN_STOPPED_SUMMARY,
      },
      turnId: row.turnId,
    },
  });
};

/**
 * Make every stranded subagent row honest, once.
 *
 * Runs at layer build. It needs no ordering against the session reaper's own
 * boot pass: `hasLiveSession` reads in-process adapter state, which a restart
 * emptied whatever else has run by then.
 */
export const reconcileOrphanedSpawns = Effect.gen(function* () {
  const projection = yield* ProjectionSnapshotQuery;
  const orphans = yield* projection.listRunningThreadBackedSubagents();
  const inProcessRows = yield* projection.listRunningInProcessSubagents();
  if (orphans.length === 0 && inProcessRows.length === 0) return;
  // Varies the command ids, so a second boot over the same row is a second
  // append rather than a receipt-deduplicated no-op.
  const stamp = yield* Effect.map(DateTime.now, DateTime.formatIso);
  yield* Effect.logInfo("subagent.spawn.reconcile-start", {
    orphanCount: orphans.length,
    inProcessCount: inProcessRows.length,
  });
  for (const orphan of orphans) {
    // A row this process is already waiting on is not an orphan. Only reachable
    // if the layer is rebuilt mid-life, but cheap insurance against closing a
    // live spawn's row underneath it.
    if (findSpawnByChild(orphan.childThreadId) !== undefined) continue;
    const target = targetOf(orphan);
    if (yield* childIsLive(orphan.childThreadId)) {
      yield* Effect.logInfo("subagent.spawn.reconcile-detached", {
        parentThreadId: orphan.parentThreadId,
        childThreadId: orphan.childThreadId,
      });
      yield* appendChildProgress(target, {
        commandId: `server:subagent-reconcile-detached:${orphan.childThreadId}:${stamp}`,
        title: ORPHANED_SPAWN_DETACHED_SUMMARY,
      });
      continue;
    }
    yield* Effect.logInfo("subagent.spawn.reconcile-stopped", {
      parentThreadId: orphan.parentThreadId,
      childThreadId: orphan.childThreadId,
    });
    yield* appendChildSettled(target, {
      _tag: "settled",
      status: "stopped",
      summary: ORPHANED_SPAWN_STOPPED_SUMMARY,
    });
  }
  for (const row of inProcessRows) {
    // An in-process subagent dies with its parent's provider session. A live
    // parent session means a possibly-live subagent, so skip it — the guard
    // is only reachable if the layer is rebuilt mid-life.
    if (yield* parentIsLive(row.parentThreadId)) continue;
    yield* Effect.logInfo("subagent.spawn.reconcile-stopped-in-process", {
      parentThreadId: row.parentThreadId,
      subagentId: row.subagentId,
    });
    yield* appendInProcessStopped(row, stamp);
  }
}).pipe(
  // Total on purpose: a sweep that cannot read the projection leaves every row
  // where the crash left it, and the 15-minute freshness window still clears it.
  Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.void
      : Effect.logWarning("subagent.spawn.reconcile-failed", { cause: Cause.pretty(cause) }),
  ),
);

/**
 * Ships with the agents toolkit rather than with the epic runner's restart
 * reconciliation: a spawned subagent is not an epic iteration, and the runner
 * should keep owning only epic runs.
 */
export const SpawnReconciliationLive = Layer.effectDiscard(reconcileOrphanedSpawns);
