/**
 * Durable storage for {@link GateReceipt}s.
 *
 * A run's terminal state says a child passed verification; it never says what
 * was verified, on which commits, or how much of the run's wall time the gate
 * took. The receipts are that record, and they outlive the process: a restart
 * reads back every receipt the run already wrote.
 *
 * Deliberately separate from `RunJournal`. A receipt is written by the merge
 * drain and by the sequential loop, both of which run outside the iteration
 * record's lifecycle, and a receipt for a control or recheck gate belongs to
 * no iteration at all.
 */
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";

import type { GateError, GateReceipt } from "./Gate.ts";

/**
 * Which gate produced the receipt.
 *
 * - `entry`: the branch's own gate, with the trial merge applied.
 * - `control`: the same gate on the base branch with nothing merged, run to
 *   decide whether the branch or the environment is at fault.
 * - `recheck`: the control gate re-run after the integration worktrees were
 *   repaired. Only this one can turn a red drain green again.
 * - `sequential`: the sequential loop's own post-commit gate.
 */
export const GateReceiptPhase = Schema.Literals(["entry", "control", "recheck", "sequential"]);
export type GateReceiptPhase = typeof GateReceiptPhase.Type;

export const PersistedGateInputHead = Schema.Struct({
  repositoryPath: Schema.String,
  head: Schema.NullOr(Schema.String),
});

export const PersistedGateReceipt = Schema.Struct({
  runId: Schema.String,
  /**
   * Monotonic per run, allocated by the store. `0` on a record handed to
   * `record`, which ignores it — only a read-back carries the real value.
   */
  sequence: Schema.Number,
  phase: GateReceiptPhase,
  /** The child whose branch was under test, or `null` for a `control` gate. */
  childId: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  commandDigest: Schema.String,
  cwd: Schema.String,
  outcome: Schema.Literals(["passed", "failed", "error"]),
  exitCode: Schema.NullOr(Schema.Number),
  queuedAt: Schema.String,
  acquiredAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.String,
  lockWaitMs: Schema.Number,
  executionMs: Schema.Number,
  inputHeads: Schema.Array(PersistedGateInputHead),
  output: Schema.String,
  outputPath: Schema.NullOr(Schema.String),
});
export type PersistedGateReceipt = typeof PersistedGateReceipt.Type;

/** Flatten a receipt into the durable row shape. */
export const persistedGateReceipt = (input: {
  readonly runId: string;
  readonly phase: GateReceiptPhase;
  readonly childId: string | null;
  readonly branch: string | null;
  readonly receipt: GateReceipt;
}): PersistedGateReceipt => ({
  runId: input.runId,
  sequence: 0,
  phase: input.phase,
  childId: input.childId,
  branch: input.branch,
  commandDigest: input.receipt.commandDigest,
  cwd: input.receipt.cwd,
  outcome: input.receipt.outcome,
  exitCode: input.receipt.exitCode,
  queuedAt: input.receipt.queuedAt,
  acquiredAt: input.receipt.acquiredAt,
  finishedAt: input.receipt.finishedAt,
  lockWaitMs: input.receipt.lockWaitMs,
  executionMs: input.receipt.executionMs,
  inputHeads: input.receipt.inputHeads,
  output: input.receipt.output,
  outputPath: input.receipt.outputPath ?? null,
});

export interface GateReceiptJournalShape {
  /**
   * Append one receipt.
   *
   * Callers write this BEFORE they act on the gate's verdict, so a crash
   * between the gate and the land or park still leaves the evidence. The
   * store allocates `sequence`.
   */
  readonly record: (receipt: PersistedGateReceipt) => Effect.Effect<void, GateError>;
  /** Every receipt for one run, in the order it was recorded. */
  readonly list: (runId: string) => Effect.Effect<ReadonlyArray<PersistedGateReceipt>, GateError>;
}
