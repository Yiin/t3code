import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { MergeParkReason } from "../policy.ts";

export class MergeQueuePortError extends Schema.TaggedErrorClass<MergeQueuePortError>()(
  "MergeQueuePortError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type MergeQueueEntryStatus = "queued" | "draining" | "parked";

export interface MergeQueueEntry {
  readonly sequence: number;
  readonly childId: string;
  readonly branch: string;
  readonly status: MergeQueueEntryStatus;
  readonly reason: MergeParkReason | null;
  readonly fixIssueId: string | null;
}

/** One sibling repository's merge-tracking state (`skills/cook-epic/run-legacy.sh:239`). */
export interface MergeQueueSiblingSnapshot {
  readonly repositoryPath: string;
  readonly baseBranch: string;
  readonly integrationWorktreePath: string;
  readonly lastAcceptedHead: string;
}

export interface MergeQueueSnapshot {
  readonly runId: string;
  readonly lastAcceptedHead: string;
  readonly repositoryPath: string;
  readonly baseBranch: string;
  readonly integrationBranch: string;
  readonly integrationWorktreePath: string;
  /** Empty for single-repo runs; persistence defaults old rows to `[]`. */
  readonly siblings: ReadonlyArray<MergeQueueSiblingSnapshot>;
  readonly entries: ReadonlyArray<MergeQueueEntry>;
}

export interface MergeQueueStoreShape {
  readonly read: (runId: string) => Effect.Effect<MergeQueueSnapshot, MergeQueuePortError>;
  /** Atomically change every queued entry to draining and return active work in order. */
  readonly beginDrain: (
    runId: string,
  ) => Effect.Effect<ReadonlyArray<MergeQueueEntry>, MergeQueuePortError>;
  readonly enqueue: (input: {
    readonly runId: string;
    readonly childId: string;
    readonly branch: string;
  }) => Effect.Effect<void, MergeQueuePortError>;
  readonly restoreTail: (input: {
    readonly runId: string;
    readonly fromSequence: number;
  }) => Effect.Effect<void, MergeQueuePortError>;
  /** Persist the parked intent before any external backlog mutation. */
  readonly beginPark: (input: {
    readonly runId: string;
    readonly sequence: number;
    readonly reason: MergeParkReason;
  }) => Effect.Effect<void, MergeQueuePortError>;
  /** Finalize a parked intent after its merge-fix child is known. */
  readonly finalizePark: (input: {
    readonly runId: string;
    readonly sequence: number;
    readonly fixIssueId: string;
  }) => Effect.Effect<void, MergeQueuePortError>;
  readonly complete: (input: {
    readonly runId: string;
    readonly sequence: number;
    readonly lastAcceptedHead: string;
    /**
     * New accepted heads for every sibling, including siblings without
     * commits (`skills/cook-epic/run-legacy.sh:3040-3047`). Omitted by
     * single-repo callers.
     */
    readonly siblingHeads?: ReadonlyArray<{
      readonly repositoryPath: string;
      readonly lastAcceptedHead: string;
    }>;
  }) => Effect.Effect<void, MergeQueuePortError>;
  readonly drop: (input: {
    readonly runId: string;
    readonly sequence: number;
  }) => Effect.Effect<void, MergeQueuePortError>;
  readonly parkedOriginalChild: (
    runId: string,
    branch: string,
  ) => Effect.Effect<Option.Option<string>, MergeQueuePortError>;
}

export interface MergeGitShape {
  readonly head: (cwd: string) => Effect.Effect<string, MergeQueuePortError>;
  readonly commitsAhead: (input: {
    readonly repositoryPath: string;
    readonly baseBranch: string;
    readonly branch: string;
  }) => Effect.Effect<number, MergeQueuePortError>;
  readonly resetHard: (cwd: string, ref: string) => Effect.Effect<void, MergeQueuePortError>;
  readonly clean: (cwd: string) => Effect.Effect<void, MergeQueuePortError>;
  readonly setupWorktree: (cwd: string) => Effect.Effect<void, MergeQueuePortError>;
  readonly trialMerge: (input: {
    readonly cwd: string;
    readonly branch: string;
    readonly message: string;
  }) => Effect.Effect<{ readonly merged: boolean; readonly output: string }, MergeQueuePortError>;
  readonly abortMerge: (cwd: string) => Effect.Effect<void, MergeQueuePortError>;
  readonly fastForward: (input: {
    readonly cwd: string;
    readonly ref: string;
  }) => Effect.Effect<{ readonly landed: boolean; readonly output: string }, MergeQueuePortError>;
  readonly push: (input: {
    readonly cwd: string;
    readonly remote: string;
    readonly refspec: string;
  }) => Effect.Effect<{ readonly pushed: boolean; readonly output: string }, MergeQueuePortError>;
  readonly deleteLocalBranch: (
    cwd: string,
    branch: string,
  ) => Effect.Effect<void, MergeQueuePortError>;
  readonly deleteRemoteBranch: (
    cwd: string,
    remote: string,
    branch: string,
  ) => Effect.Effect<void, MergeQueuePortError>;
}

/**
 * One bounded, mechanical repair of the integration worktrees.
 *
 * Only the integration worktrees are ever touched. The source checkout is off
 * limits: a repair that reaches it can break every other worker at once, which
 * is exactly how run 87a9d295 lost its dependency store.
 *
 * The port decides *how* to repair; `MergeQueue` decides *whether* to, and
 * proves the repair worked by re-running the same gate afterwards.
 */
export interface MergeRepairShape {
  readonly restoreDependencies: (input: {
    /** Main integration worktree first, then every sibling's. */
    readonly worktrees: ReadonlyArray<string>;
  }) => Effect.Effect<{ readonly restored: boolean; readonly detail: string }, MergeQueuePortError>;
}

export interface MergeSlotShape {
  /** `None` means another coordinator owns the nonblocking slot. */
  readonly tryAcquire: (
    holder: string,
  ) => Effect.Effect<Option.Option<{ readonly holder: string }>, MergeQueuePortError>;
  readonly release: (holder: string) => Effect.Effect<void, MergeQueuePortError>;
  /**
   * Release the slot only if `holder` is provably the one holding it, and
   * report whether that happened.
   *
   * For the boot path. The slot is released from a finalizer, which a SIGKILL
   * or a systemd stop skips, so a hard-killed run leaves the slot held under
   * its own holder id. The next boot then cannot acquire it, every drain
   * defers, and the run neither fails nor progresses — a silent hang that
   * reads as a healthy run.
   *
   * Holder identity is the only evidence used. A slot held by another run,
   * another epic, or the terminal coordinator is left alone, because deferring
   * to a live holder is the correct behaviour.
   */
  readonly reclaim: (
    holder: string,
  ) => Effect.Effect<{ readonly reclaimed: boolean }, MergeQueuePortError>;
}

export type MergeQueueEvent =
  | {
      /** A repair of the integration worktrees is about to start. */
      readonly event: "remediating";
      readonly branch: string;
      readonly worktrees: ReadonlyArray<string>;
      readonly signature: string;
    }
  | {
      /**
       * The repair finished. `recovered` is true only when the same gate then
       * passed on the base with nothing merged — repairing something is never
       * itself a pass.
       */
      readonly event: "remediated";
      readonly branch: string;
      readonly worktrees: ReadonlyArray<string>;
      readonly signature: string;
      readonly recovered: boolean;
      readonly detail: string;
    }
  | {
      readonly event: "parked";
      readonly child: string;
      readonly branch: string;
      readonly reason: MergeParkReason;
      readonly fix: string;
    }
  | {
      readonly event: "merged";
      readonly child: string;
      readonly branch: string;
      readonly commit: string;
      readonly landing: string;
      readonly repositories: ReadonlyArray<{
        readonly repo: string;
        readonly commits: number;
        readonly head: string;
      }>;
    };

export interface MergeEventsShape {
  readonly emit: (event: MergeQueueEvent) => Effect.Effect<void, MergeQueuePortError>;
}

export interface FoldShape {
  readonly run: (childId: string) => Effect.Effect<void, MergeQueuePortError>;
}
