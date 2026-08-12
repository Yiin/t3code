/** Observable state changes produced by the shared loop. */
import {
  EpicRunId,
  NonNegativeInt,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PersistedEpicRun, PersistedEpicRunIteration } from "./RunJournal.ts";

export const CHILD_CLAIM_RELEASED_REASON = "retry budget exhausted; child reopened" as const;

/** Mirrors `WorkerLivenessEvent["type"]` in `../workerLiveness.ts`. */
export const WorkerLivenessStage = Schema.Literals([
  "worker-idle",
  "inspection-started",
  "inspection-continue",
  "inspection-uncertain",
  "inspection-stop-pending",
  "inspection-stop",
]);
export type WorkerLivenessStage = typeof WorkerLivenessStage.Type;

export const RunEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("run-state-changed"),
    run: PersistedEpicRun,
  }),
  Schema.Struct({
    type: Schema.Literal("iteration-state-changed"),
    iteration: PersistedEpicRunIteration,
  }),
  Schema.Struct({
    type: Schema.Literal("subagent-liveness-degraded"),
    runId: EpicRunId,
    iterationIndex: NonNegativeInt,
    evidence: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("subagent-liveness-unavailable"),
    runId: EpicRunId,
    iterationIndex: NonNegativeInt,
    reason: Schema.String,
  }),
  /**
   * One decision of the per-worker liveness machine (`workerLiveness.ts`).
   *
   * Every stage is surfaced, not just the stop: an inspection that keeps a
   * worker alive is the evidence that supervision is running and chose not to
   * act, which is the only way to tell "supervised and healthy" from "not
   * supervised at all".
   */
  Schema.Struct({
    type: Schema.Literal("worker-liveness"),
    runId: EpicRunId,
    iterationIndex: NonNegativeInt,
    issueId: Schema.String,
    stage: WorkerLivenessStage,
    detail: Schema.String,
  }),
  /**
   * What the loop decided about one iteration a restart interrupted.
   *
   * Published once per interrupted iteration, whichever way the decision went.
   * Anything but `resumed` is a data-loss event — the agent's own session is
   * dropped and the child starts over from a clean worktree — so an operator
   * needs the refusal in the record, not only in a log line.
   *
   * `capability`, `no-durable-state` and `not-continued` are the harness's own
   * `IterationResumeRefusal` tags. `workspace-missing` and `child-closed` are
   * the loop's: the worktree is gone, or the bead closed while the run was
   * down. `origin` is set only by `not-continued`.
   */
  Schema.Struct({
    type: Schema.Literal("iteration-resume-decision"),
    runId: EpicRunId,
    iterationIndex: NonNegativeInt,
    issueId: Schema.String,
    decision: Schema.Literals([
      "resumed",
      "capability",
      "no-durable-state",
      "not-continued",
      "failed",
      "workspace-missing",
      "child-closed",
    ]),
    origin: Schema.NullOr(Schema.Literals(["started-fresh", "forked", "unknown"])),
    detail: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("child-claim-released"),
    runId: EpicRunId,
    issueId: Schema.String,
    iterationIndex: NonNegativeInt,
    reason: Schema.Literal(CHILD_CLAIM_RELEASED_REASON),
  }),
  Schema.Struct({
    type: Schema.Literal("provider-fallback"),
    runId: EpicRunId,
    issueId: Schema.String,
    iterationIndex: NonNegativeInt,
    failureReason: Schema.String,
    fromInstanceId: ProviderInstanceId,
    fromDriver: ProviderDriverKind,
    fromModel: Schema.String,
    toInstanceId: ProviderInstanceId,
    toDriver: ProviderDriverKind,
    toModel: Schema.String,
  }),
]);
export type RunEvent = typeof RunEvent.Type;

export class RunEventsError extends Schema.TaggedErrorClass<RunEventsError>()("RunEventsError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface RunEventsShape {
  /** Server adapters publish to PubSub. Terminal adapters publish stdout/mailbox records. */
  readonly publish: (event: RunEvent) => Effect.Effect<void, RunEventsError>;
}
