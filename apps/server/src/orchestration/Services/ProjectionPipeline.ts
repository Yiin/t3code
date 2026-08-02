/**
 * OrchestrationProjectionPipeline - Event projection pipeline service interface.
 *
 * Coordinates projection bootstrap/replay and per-event projection updates for
 * orchestration read models.
 *
 * @module OrchestrationProjectionPipeline
 */
import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { OrchestrationProjectionStalledError } from "../Errors.ts";

/**
 * OrchestrationProjectionPipelineShape - Service API for projection execution.
 */
export interface OrchestrationProjectionPipelineShape {
  /**
   * Bootstrap projections by replaying persisted events.
   *
   * Resumes each projector from its stored projection-state cursor and
   * blocks until every projector has fully caught up to the event store's
   * tail as of when this effect started running. The caller (the command
   * engine) must await this before seeding its in-memory read model or
   * accepting any command — seeding from a partially-applied projection
   * would make the decider believe existing aggregates do not exist.
   */
  readonly bootstrap: Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Project a single orchestration event into projection repositories.
   *
   * Projectors are executed sequentially to preserve deterministic ordering.
   * This is the low-level primitive `bootstrap` and `runLive` are both built
   * from; nothing outside this module should call it directly for live
   * traffic — use `runLive`, which owns the persisted cursor and the
   * `awaitProjectedSequence` bookkeeping.
   */
  readonly projectEvent: (
    event: OrchestrationEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Continuously apply events from wherever `bootstrap` left the persisted
   * cursor forward, forever, waking on `notifyAppended` rather than polling.
   *
   * Must be started (forked into a scope) exactly once, after `bootstrap`
   * has completed, by the same process that ran `bootstrap` — never
   * concurrently with it. This is what keeps `runAttachmentSideEffects`
   * (which deletes files and is not safe to double-run) to exactly one
   * applier for any given event.
   *
   * On a projector failure this retries a bounded number of times and then
   * halts permanently: it logs loudly, flips the pipeline to "halted" so
   * `awaitProjectedSequence` fails fast for every current and future waiter,
   * and the effect itself completes (successfully, from the fiber-lifecycle
   * point of view) rather than failing — so a plain `Effect.forkScoped` can
   * never silently swallow the failure the way an unhandled child failure
   * would.
   */
  readonly runLive: Effect.Effect<void, never, Scope.Scope>;

  /**
   * Tell the live loop that a new event has been appended, so it can wake
   * from its wait instead of polling. Cheap and safe to call unconditionally
   * after every successful append.
   */
  readonly notifyAppended: (sequence: number) => Effect.Effect<void>;

  /**
   * Resolve once every projector has applied at least `sequence`, or reject
   * with a typed, bounded failure — never blocks forever.
   *
   * Illegal to call from inside a `sql.withTransaction` block: the pipeline
   * shares the single sqlite connection's transaction semaphore, so a
   * waiter parked here while holding that permit would prevent the live
   * loop from ever acquiring it to make progress. Calling it inside a
   * transaction is a programmer error and dies loudly rather than
   * deadlocking silently.
   *
   * Callers should treat both failure reasons ("timeout" and "halted") as
   * "serve what we have and mark the response degraded", not as reasons to
   * fail the surrounding request.
   */
  readonly awaitProjectedSequence: (
    sequence: number,
  ) => Effect.Effect<void, OrchestrationProjectionStalledError>;
}

/**
 * OrchestrationProjectionPipeline - Service tag for orchestration projections.
 */
export class OrchestrationProjectionPipeline extends Context.Service<
  OrchestrationProjectionPipeline,
  OrchestrationProjectionPipelineShape
>()("t3/orchestration/Services/ProjectionPipeline/OrchestrationProjectionPipeline") {}
