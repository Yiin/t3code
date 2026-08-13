// @effect-diagnostics nodeBuiltinImport:off
/** Configured verification across every repository changed by an epic child. */
import * as NodeCrypto from "node:crypto";

import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { describePortFailure } from "./portFailure.ts";
import type { RepoRef } from "./Vcs.ts";

export class GateError extends Schema.TaggedErrorClass<GateError>()("GateError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  /** See `describePortFailure`: without this the gate's own timeout is invisible. */
  override get message(): string {
    return describePortFailure(this.operation, this.detail, this.cause);
  }
}

/** What one gate run decided. `error` means the adapter never got an exit code. */
export type GateOutcome = "passed" | "failed" | "error";

/**
 * One repository the gate command read, and the commit it was sitting on.
 *
 * `head` is `null` only when the adapter could not read it. A head is never
 * invented: a receipt that names the wrong input proves nothing.
 */
export interface GateInputHead {
  readonly repositoryPath: string;
  readonly head: string | null;
}

/**
 * Durable evidence for exactly one gate run.
 *
 * This is what makes a run's wall time explainable and its verification
 * provable after the fact: which commits were tested, how long the shared
 * heavy-work lock was held away from it, how long the command itself took,
 * and what it decided.
 *
 * The command text itself never travels — only `commandDigest`, because a
 * gate command can carry credentials. `output` is bounded by the caller's
 * `maxOutputBytes`; the full log, when an adapter keeps one, is at
 * `outputPath`.
 */
export interface GateReceipt {
  /** Lowercase sha256 hex of the exact command text. See {@link gateCommandDigest}. */
  readonly commandDigest: string;
  readonly cwd: string;
  /** `passed` requires `exitCode === 0`. Nothing else may claim success. */
  readonly outcome: GateOutcome;
  /** `null` when the command never produced one — a spawn failure or a timeout. */
  readonly exitCode: number | null;
  /** When the gate was asked to run, before any waiting. ISO 8601. */
  readonly queuedAt: string;
  /** When the command itself started, after the lock and host waits. ISO 8601. */
  readonly acquiredAt: string | null;
  readonly finishedAt: string;
  /** Wall time spent waiting to start: the heavy-work lock plus the host wait. */
  readonly lockWaitMs: number;
  /** Wall time of the command itself, excluding `lockWaitMs`. */
  readonly executionMs: number;
  readonly inputHeads: ReadonlyArray<GateInputHead>;
  readonly output: string;
  readonly outputPath?: string;
}

/**
 * The digest a receipt carries instead of the command text.
 *
 * Exported so a caller that has to write an adapter-error receipt — where no
 * {@link GateResult} exists — digests the command the same way the adapter
 * would, and two receipts for the same command compare equal.
 */
export const gateCommandDigest = (command: string): string =>
  NodeCrypto.createHash("sha256").update(command, "utf8").digest("hex");

export interface GateResult {
  readonly passed: boolean;
  readonly repositoryPaths: ReadonlyArray<string>;
  /** Bounded combined output. The adapter must not retain unbounded logs. */
  readonly output: string;
  /**
   * Where the full, unbounded gate output was persisted, if anywhere.
   *
   * `output` is capped, so a diagnosis built from it can lose the real
   * failure. Adapters that keep the whole log set this so the diagnosis can
   * point at it (t3code-9hv).
   */
  readonly outputPath?: string;
  /** Durable evidence for this run. `receipt.outcome === "passed"` iff `passed`. */
  readonly receipt: GateReceipt;
}

export interface GateShape {
  /**
   * Run once from the main integration worktree under the shared heavy-work lock.
   *
   * Adapters remove `COOKEPIC_*` and `FLEET_UNIT` from the child environment.
   * `repositories` records the repo set represented by the one command.
   * `maxOutputBytes` bounds combined output across both streams.
   */
  readonly run: (input: {
    readonly command: string;
    readonly repositories: ReadonlyArray<RepoRef>;
    readonly cwd: string;
    readonly maxOutputBytes: number;
  }) => Effect.Effect<GateResult, GateError>;
}
