/** Durable issue-tracker effects required by the epic loop. */
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class BacklogError extends Schema.TaggedErrorClass<BacklogError>()("BacklogError", {
  operation: Schema.String,
  issueId: Schema.optional(Schema.String),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface BacklogIssue {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly priority: number | null;
  readonly issueType: string | null;
  readonly parentId: string | null;
}

export type MergeSlotAction = "create" | "check" | "acquire" | "release";
export type BacklogIssueStatus = "open" | "in_progress" | "blocked" | "closed";

export interface MergeSlotLease {
  readonly holder: string;
}

export interface BacklogShape {
  /**
   * Return only ready children of `epicId`, in tracker priority order.
   *
   * `bd ready --parent` is the authority. Its JSON can omit each child's
   * `parent` field. An adapter must not discard those records for that omission.
   * An empty result means no ready child, not that the epic is complete. The
   * loop must compare it with `listChildren` before it reports completion.
   */
  readonly readyChildren: (
    epicId: string,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<BacklogIssue>, BacklogError>;
  readonly showIssue: (issueId: string) => Effect.Effect<BacklogIssue, BacklogError>;
  readonly listChildren: (
    epicId: string,
  ) => Effect.Effect<ReadonlyArray<BacklogIssue>, BacklogError>;
  readonly claim: (issueId: string, actor?: string) => Effect.Effect<void, BacklogError>;
  /** Reopen a retry or block a child after its attempt budget ends. */
  readonly setStatus: (
    issueId: string,
    status: BacklogIssueStatus,
  ) => Effect.Effect<void, BacklogError>;
  /** Create discovered work, including the merge-fix child used when a branch is parked. */
  readonly createChild: (input: {
    readonly epicId: string;
    readonly title: string;
    readonly description: string;
    readonly priority: number;
    readonly discoveredFrom?: string;
  }) => Effect.Effect<BacklogIssue, BacklogError>;
  readonly close: (input: {
    readonly issueId: string;
    readonly reason: string;
  }) => Effect.Effect<void, BacklogError>;
  readonly comment: (input: {
    readonly issueId: string;
    readonly body: string;
  }) => Effect.Effect<void, BacklogError>;
  /** Return the append-only note text exactly as the tracker stores it. */
  readonly readNotes: (issueId: string) => Effect.Effect<string, BacklogError>;
  /** Append one note. Never replace or reorder existing notes. */
  readonly writeNotes: (input: {
    readonly issueId: string;
    readonly note: string;
  }) => Effect.Effect<void, BacklogError>;
  readonly swarm: (input: {
    readonly epicId: string;
    readonly action: "create" | "status" | "validate";
  }) => Effect.Effect<string, BacklogError>;
  /** Create the swarm metadata when it does not exist. */
  readonly ensureSwarm: (epicId: string) => Effect.Effect<void, BacklogError>;
  /** Acquire only the lease. The core still owns merge queue order and cleanup. */
  readonly acquireMergeSlot: (
    holder: string,
  ) => Effect.Effect<Option.Option<MergeSlotLease>, BacklogError>;
  readonly mergeSlot: (input: {
    readonly repositoryPath: string;
    readonly action: MergeSlotAction;
    readonly holder?: string;
  }) => Effect.Effect<string, BacklogError>;
}
