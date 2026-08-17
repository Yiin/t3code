/**
 * childMirror - show a thread-backed child on its parent's subagent read model.
 *
 * The roster, the composer banner count and the drawer all read
 * `thread.subagents` on the *parent*. That read model is folded from `task.*`
 * activities (`applySubagentActivity` in `packages/contracts/src/orchestration.ts`),
 * and those activities normally come from provider events. A child spawned by
 * `spawn_agent` produces none: it is its own thread with its own provider
 * session, and the parent's session never hears about it. Without this module
 * the parent shows no subagents at all.
 *
 * So the spawner writes the same rows itself, through the internal
 * `thread.activity.append` command. The payload shapes are copied from
 * `ProviderRuntimeIngestion.ts` verbatim — those field names are what the fold
 * decodes, and a drifted name silently folds to nothing.
 *
 * The subagent id **is** the child thread id. That makes the roster→drawer join
 * an identity and needs no extra table.
 *
 * Contracts pins the emission order for a thread-backed spawner:
 * `task.started`, then `subagent.child-thread.linked`, then `task.completed`
 * (see `SUBAGENT_CHILD_THREAD_LINKED_ACTIVITY_KIND`).
 *
 * **Every append is best-effort.** A lost activity costs the human a stale
 * roster row; failing the parent's tool call over it costs the parent its work.
 *
 * @module agents/childMirror
 */
import {
  CommandId,
  EventId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadActivityTone,
  SUBAGENT_CHILD_THREAD_LINKED_ACTIVITY_KIND,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

/**
 * How often the mirror re-reads the child while the parent waits.
 *
 * Matches the runner's own settle cadence. Each tick is a full thread-detail
 * read of the child, so the interval is the cost knob: shorter means a fresher
 * roster and more reads per live child.
 */
export const CHILD_MIRROR_POLL_INTERVAL = Duration.seconds(2);

/** Ingestion's truncation, copied so the mirrored rows read identically. */
const truncateDetail = (value: string, limit = 180): string =>
  value.length > limit ? `${value.slice(0, limit - 3)}...` : value;

/** `undefined` for a blank string, so an optional payload key stays absent. */
const nonEmpty = (value: string | undefined, limit = 180): string | undefined => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? truncateDetail(trimmed, limit) : undefined;
};

/** The child, and the parent row it is mirrored onto. */
export interface ChildMirrorTarget {
  readonly parentThreadId: ThreadId;
  /** The parent turn that spawned the child, so the row binds to that turn. */
  readonly parentTurnId: TurnId | null;
  readonly childThreadId: ThreadId;
  readonly agentType: string;
  readonly description: string;
  readonly prompt: string;
  /** The spawning tool_use id, when the provider exposed one to the toolkit. */
  readonly toolUseId?: string | undefined;
}

/** How the parent's wait on the child ended. */
export type ChildMirrorOutcome =
  | {
      readonly _tag: "settled";
      readonly status: "completed" | "failed" | "stopped";
      /** The child's final assistant message, if it produced one. */
      readonly summary?: string | undefined;
    }
  | { readonly _tag: "timeout" };

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Append one activity to the parent thread, swallowing every failure.
 *
 * Follows `dispatchBestEffort` in `PoolDispatch.ts`: `catchCause`
 * recovers defects too, so a broken projection cannot escape as an unhandled
 * cause into the tool call.
 */
const appendActivity = (input: {
  readonly parentThreadId: ThreadId;
  readonly commandId: string;
  readonly activity: Omit<OrchestrationThreadActivity, "createdAt" | "turnId"> & {
    readonly turnId: TurnId | null;
  };
}): Effect.Effect<void, never, OrchestrationEngineService> =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const createdAt = yield* nowIso;
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(input.commandId),
      threadId: input.parentThreadId,
      activity: { ...input.activity, createdAt },
      createdAt,
    });
  }).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.logWarning("subagent.child-mirror.append-failed", {
        parentThreadId: input.parentThreadId,
        commandId: input.commandId,
        cause,
      }),
    ),
  );

/**
 * Open the parent's row for a freshly spawned child: `task.started`, then the
 * link that marks the row thread-backed.
 *
 * Both activity ids are derived from the thread pair rather than random, so a
 * retried spawn upserts the same two rows instead of stacking duplicates.
 */
export const appendChildSpawned = (
  target: ChildMirrorTarget,
): Effect.Effect<void, never, OrchestrationEngineService> =>
  Effect.gen(function* () {
    const description = nonEmpty(target.description);
    const prompt = nonEmpty(target.prompt, 2000);
    yield* appendActivity({
      parentThreadId: target.parentThreadId,
      commandId: `server:subagent-mirror-started:${target.childThreadId}`,
      activity: {
        id: EventId.make(`task-started:${target.parentThreadId}:${target.childThreadId}`),
        tone: "info",
        kind: "task.started",
        summary: `${target.agentType} subagent started`,
        payload: {
          taskId: target.childThreadId,
          subagentType: target.agentType,
          ...(description !== undefined ? { detail: description } : {}),
          ...(prompt !== undefined ? { prompt } : {}),
          // toolUseId is the wire name and spawnedByItemId the read-model name
          // for the same value, exactly as ingestion emits them.
          ...(target.toolUseId
            ? { toolUseId: target.toolUseId, spawnedByItemId: target.toolUseId }
            : {}),
        },
        turnId: target.parentTurnId,
      },
    });
    yield* appendActivity({
      parentThreadId: target.parentThreadId,
      commandId: `server:subagent-mirror-linked:${target.childThreadId}`,
      activity: {
        id: EventId.make(`subagent-link:${target.parentThreadId}:${target.childThreadId}`),
        tone: "info",
        kind: SUBAGENT_CHILD_THREAD_LINKED_ACTIVITY_KIND,
        summary: "Subagent runs as its own thread",
        payload: {
          subagentId: target.childThreadId,
          childThreadId: target.childThreadId,
        },
        turnId: target.parentTurnId,
      },
    });
  });

/** The newest activity summary on the child, as the roster's progress line. */
const latestActivitySummary = (thread: OrchestrationThread | undefined): string | undefined =>
  nonEmpty(thread?.activities[thread.activities.length - 1]?.summary, 120);

/**
 * The child's newest tool row, named the way the roster labels it.
 *
 * Only `tool.denied`/`tool.progress` payloads carry an explicit `toolName`;
 * the rest of the tool kinds put the provider's title in `summary`.
 */
const latestToolName = (thread: OrchestrationThread | undefined): string | undefined => {
  const activities = thread?.activities ?? [];
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity === undefined || !activity.kind.startsWith("tool.")) continue;
    const payload = activity.payload;
    const named =
      typeof payload === "object" && payload !== null && "toolName" in payload
        ? (payload as { readonly toolName?: unknown }).toolName
        : undefined;
    return nonEmpty(typeof named === "string" ? named : activity.summary, 120);
  }
  return undefined;
};

/**
 * Write one `task.progress` row for a child.
 *
 * The activity id is fixed per thread pair (`task-progress:<parent>:<child>`,
 * the same scheme ingestion uses), so every call coalesces onto one row instead
 * of stacking. The *command* id must vary per call: `dispatch` deduplicates by
 * command receipt, so a repeated one is silently dropped.
 */
export const appendChildProgress = (
  target: ChildMirrorTarget,
  input: {
    readonly commandId: string;
    readonly title: string | undefined;
    readonly lastToolName?: string | undefined;
  },
): Effect.Effect<void, never, OrchestrationEngineService> =>
  appendActivity({
    parentThreadId: target.parentThreadId,
    commandId: input.commandId,
    activity: {
      id: EventId.make(`task-progress:${target.parentThreadId}:${target.childThreadId}`),
      tone: "info",
      kind: "task.progress",
      summary: input.title ?? "Subagent working",
      payload: {
        taskId: target.childThreadId,
        subagentType: target.agentType,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.lastToolName !== undefined ? { lastToolName: input.lastToolName } : {}),
      },
      turnId: target.parentTurnId,
    },
  });

/**
 * Refresh the parent's row from the child, forever, until interrupted.
 *
 * Every tick reuses one coalescing activity id
 * (`task-progress:<parent>:<child>`, the same scheme ingestion uses), so N
 * ticks project one row instead of N. A tick that learns nothing new still
 * appends: `updatedAt` is what `countFreshRunningSubagents` reads, so a silent
 * child must still read as live work.
 *
 * Fork this scoped to the parent's wait. On timeout the scope closes, the loop
 * dies, and the row goes stale on its own after
 * `RUNNING_SUBAGENT_FRESHNESS_MS` instead of pinning the count forever.
 */
export const mirrorChildProgress = (
  target: ChildMirrorTarget,
): Effect.Effect<never, never, OrchestrationEngineService | ProjectionSnapshotQuery> =>
  Effect.gen(function* () {
    const projection = yield* ProjectionSnapshotQuery;
    // The started row is fresh already, so the first read is one interval out.
    let tick = 0;
    while (true) {
      yield* Effect.sleep(CHILD_MIRROR_POLL_INTERVAL);
      tick += 1;
      const child = yield* projection.getThreadDetailById(target.childThreadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.catchCause((cause) =>
          Effect.logWarning("subagent.child-mirror.read-failed", {
            childThreadId: target.childThreadId,
            cause,
          }).pipe(Effect.as(undefined)),
        ),
      );
      yield* appendChildProgress(target, {
        commandId: `server:subagent-mirror-progress:${target.childThreadId}:${tick}`,
        title: latestActivitySummary(child),
        lastToolName: latestToolName(child),
      });
    }
  });

const settledTone = (status: "completed" | "failed" | "stopped"): OrchestrationThreadActivityTone =>
  status === "failed" ? "error" : "info";

const settledSummaryLine = (status: "completed" | "failed" | "stopped"): string =>
  status === "failed"
    ? "Subagent failed"
    : status === "stopped"
      ? "Subagent stopped"
      : "Subagent completed";

/** Close the parent's row with the child's outcome and final message. */
export const appendChildSettled = (
  target: ChildMirrorTarget,
  settled: Extract<ChildMirrorOutcome, { _tag: "settled" }>,
): Effect.Effect<void, never, OrchestrationEngineService> => {
  const finalMessage = nonEmpty(settled.summary);
  const title = nonEmpty(target.description, 120);
  return appendActivity({
    parentThreadId: target.parentThreadId,
    commandId: `server:subagent-mirror-completed:${target.childThreadId}`,
    activity: {
      id: EventId.make(`task-completed:${target.parentThreadId}:${target.childThreadId}`),
      tone: settledTone(settled.status),
      kind: "task.completed",
      summary: settledSummaryLine(settled.status),
      payload: {
        taskId: target.childThreadId,
        status: settled.status,
        subagentType: target.agentType,
        ...(title !== undefined ? { title } : {}),
        // summary + detail mirror task.progress: clients label the row from
        // summary and keep detail for the expanded body.
        ...(finalMessage !== undefined ? { summary: finalMessage, detail: finalMessage } : {}),
      },
      turnId: target.parentTurnId,
    },
  });
};

/**
 * Mirror one child's whole life onto the parent while `wait` runs.
 *
 * `wait` owns the waiting policy — how long, and how a settle is detected. This
 * owns only the mirroring: open the row, refresh it on a forked fiber for as
 * long as the wait lasts, and close it when the wait says the child settled. A
 * timeout closes nothing on purpose; the row ages out of the fresh-running
 * count instead of claiming an outcome the child never reported.
 */
export const mirrorChildLifecycle = <E, R>(
  target: ChildMirrorTarget,
  wait: Effect.Effect<ChildMirrorOutcome, E, R>,
): Effect.Effect<ChildMirrorOutcome, E, R | OrchestrationEngineService | ProjectionSnapshotQuery> =>
  Effect.gen(function* () {
    yield* appendChildSpawned(target);
    const outcome = yield* Effect.gen(function* () {
      yield* Effect.forkScoped(mirrorChildProgress(target));
      return yield* wait;
    }).pipe(Effect.scoped);
    if (outcome._tag === "settled") {
      yield* appendChildSettled(target, outcome);
    }
    return outcome;
  });
