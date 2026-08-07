/** Observable state changes produced by the shared loop. */
import { EpicRunId, NonNegativeInt } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PersistedEpicRun, PersistedEpicRunIteration } from "./RunJournal.ts";

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
