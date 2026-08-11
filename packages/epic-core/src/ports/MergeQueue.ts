import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { MergeParkReason } from "../policy.ts";
import { describePortFailure } from "./portFailure.ts";

export class MergeQueuePortError extends Schema.TaggedErrorClass<MergeQueuePortError>()(
  "MergeQueuePortError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  /**
   * Without this the class inherits an empty `message`, and every reader of it
   * reports nothing. `EpicRunnerPoolPorts` renders a drain failure as
   * `Epic runner failed to dispatch git.merge-queue: ${message}`, so three epic
   * runs failed with a bare trailing colon while the real cause — a gate that
   * timed out after two hours — sat populated one level down.
   */
  override get message(): string {
    return describePortFailure(this.operation, this.detail, this.cause);
  }
}

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
  /**
   * The operator's branch at launch (t3code-sha), captured once when the run
   * owns its base branch (`baseBranch === runBaseBranch(epicId)`) and reused
   * verbatim for the run's whole life — never re-read from the working tree,
   * so an operator who switches branches mid-run cannot silently change what
   * gets integrated.
   *
   * `null` means either the run does not own its base branch, or the
   * snapshot predates this field. Both read the same way: no continuous
   * integration for this run.
   */
  readonly operatorBaseBranch: string | null;
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
  /**
   * Record a run base branch advance that did not land any queue entry
   * (t3code-sha): a successful continuous-integration merge, or an
   * integration-fix child committing its resolution directly onto the base
   * branch. Unlike `complete`, this touches no entry — there is none to
   * remove.
   *
   * Every later drain's "moved externally" guard compares `lastAcceptedHead`
   * against the base branch's live head, so a base advance the coordinator
   * itself caused has to update this or the very next drain would mistake
   * its own work for an external move and fail the run.
   */
  readonly advanceIntegration: (input: {
    readonly runId: string;
    readonly lastAcceptedHead: string;
  }) => Effect.Effect<void, MergeQueuePortError>;
}

export interface MergeGitShape {
  /**
   * `git rev-parse <ref>`. `ref` defaults to `HEAD` — the branch actually
   * checked out at `cwd` — which is exactly what a run sharing the operator's
   * checkout needs. A run-owned base branch (t3code-5m4) is never checked out
   * at `cwd`, so its callers pass the branch name explicitly instead.
   */
  readonly head: (cwd: string, ref?: string) => Effect.Effect<string, MergeQueuePortError>;
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
  /**
   * Advance the base branch to `ref`, fast-forward only.
   *
   * Without `branch`, this is `git merge --ff-only <ref>` at `cwd` — it
   * assumes the base branch is the branch checked out there. With `branch`,
   * it instead updates that ref directly (`git fetch . <ref>:<branch>`)
   * without touching `cwd`'s working tree at all: the run-owned base branch
   * case, where `cwd` still has the operator's own branch checked out.
   */
  readonly fastForward: (input: {
    readonly cwd: string;
    readonly ref: string;
    readonly branch?: string;
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
  /**
   * Who holds the slot, or `None` when it is free, missing, or unreadable.
   *
   * The boot path needs the holder itself, not just a yes/no on its own id: a
   * slot left by a DIFFERENT run that has since finished blocks every drain
   * just as thoroughly, and only the caller knows which runs are still going.
   */
  readonly holder: Effect.Effect<Option.Option<string>, MergeQueuePortError>;
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
      /**
       * Merging the operator's branch into the run's owned base branch
       * conflicted (t3code-sha). Not tied to any queue entry — the conflict
       * is between the run's own base and the operator's branch, not any
       * child — so this carries the operator branch and the one deduped fix
       * child instead of an entry's `child`/`branch`.
       */
      readonly event: "integration-blocked";
      readonly operatorBranch: string;
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
