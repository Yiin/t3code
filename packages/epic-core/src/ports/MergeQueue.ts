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

export interface MergeSlotShape {
  /** `None` means another coordinator owns the nonblocking slot. */
  readonly tryAcquire: (
    holder: string,
  ) => Effect.Effect<Option.Option<{ readonly holder: string }>, MergeQueuePortError>;
  readonly release: (holder: string) => Effect.Effect<void, MergeQueuePortError>;
}

export type MergeQueueEvent =
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
