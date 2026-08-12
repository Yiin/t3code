/**
 * OrchestrationRetention - Bounded growth for the orchestration event store.
 *
 * Owns the one write path that removes rows from `orchestration_events`, and
 * the reclaim of the free pages those deletes leave behind. It does not read,
 * project, or reshape events.
 *
 * @module OrchestrationRetention
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceSqlError } from "../Errors.ts";

/**
 * OrchestrationRetentionPolicy - What a sweep is allowed to delete.
 */
export interface OrchestrationRetentionPolicy {
  /**
   * How many sequences below the slowest projector's watermark stay
   * untouched.
   *
   * A projector replays from its own `last_applied_sequence`, so anything at
   * or below the minimum watermark is already applied everywhere and no
   * projector will ask for it again. The margin is the safety band on top of
   * that: it keeps recent history replayable for a client that reconnects
   * with an old cursor, and it leaves room to rebuild a projection by hand
   * after an incident.
   */
  readonly retainSequenceMargin: number;
  /**
   * Reclaim free pages once a sweep leaves at least this many bytes of them.
   *
   * A `VACUUM` rewrites the whole file, so a sweep that frees a few megabytes
   * is not worth the rewrite.
   */
  readonly vacuumThresholdBytes: number;
}

/**
 * OrchestrationRetentionReport - What one sweep actually did.
 */
export interface OrchestrationRetentionReport {
  /** Lowest `last_applied_sequence` across every projector. */
  readonly watermarkSequence: number;
  /** Highest sequence the sweep was allowed to delete, watermark minus margin. */
  readonly deletableThroughSequence: number;
  /** Rows deleted from `orchestration_events`. */
  readonly deletedEvents: number;
  /** Database file size before the sweep, in bytes. */
  readonly sizeBeforeBytes: number;
  /** Database file size after the sweep, in bytes. */
  readonly sizeAfterBytes: number;
  /** Whether this sweep reclaimed free pages. */
  readonly vacuumed: boolean;
}

/**
 * OrchestrationRetentionShape - Service API for event store retention.
 */
export interface OrchestrationRetentionShape {
  /**
   * Run one retention sweep.
   *
   * @param policy - Overrides for the default policy.
   * @returns Effect containing what the sweep deleted and reclaimed.
   *
   * A sweep with no projector rows deletes nothing: an unprojected event
   * store is the one case where the log is still the only copy.
   */
  readonly sweep: (
    policy?: Partial<OrchestrationRetentionPolicy>,
  ) => Effect.Effect<OrchestrationRetentionReport, PersistenceSqlError>;
}

/**
 * The one event type a sweep may delete.
 *
 * `thread.activity-appended` is the only entry, and deliberately so. It is the
 * one high-volume event whose payload is copied verbatim into a projection
 * table (`projection_thread_activities`) that every read path already uses, so
 * deleting the log row loses no queryable state. Every other event type
 * carries structural history: threads, sessions, turns, messages. Those stay.
 */
export const PRUNABLE_EVENT_TYPE = "thread.activity-appended";

/**
 * Default retention policy.
 *
 * The margin is 50,000 sequences. On an active workspace that is a few days of
 * events and a few hundred megabytes, which is enough replay headroom without
 * letting the table grow without bound.
 */
export const DEFAULT_ORCHESTRATION_RETENTION_POLICY: OrchestrationRetentionPolicy = {
  retainSequenceMargin: 50_000,
  vacuumThresholdBytes: 64 * 1024 * 1024,
};

/**
 * OrchestrationRetention - Service tag for event store retention.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const retention = yield* OrchestrationRetention
 *   return yield* retention.sweep()
 * })
 * ```
 */
export class OrchestrationRetention extends Context.Service<
  OrchestrationRetention,
  OrchestrationRetentionShape
>()("t3/persistence/Services/OrchestrationRetention") {}
