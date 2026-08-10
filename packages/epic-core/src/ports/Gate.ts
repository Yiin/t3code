/** Configured verification across every repository changed by an epic child. */
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

export interface GateResult {
  readonly passed: boolean;
  readonly repositoryPaths: ReadonlyArray<string>;
  /** Bounded combined output. The adapter must not retain unbounded logs. */
  readonly output: string;
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
