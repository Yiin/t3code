import {
  ChatAttachment,
  EpicPlanCorrelation,
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationProposedPlanId,
  OrchestrationReadModel,
  OrchestrationGetSubagentActivitiesInput,
  OrchestrationMessageDeliveryState,
  OrchestrationMessageOrigin,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  ProjectScript,
  THREAD_ACTIVITY_OPEN_REQUEST_KINDS,
  THREAD_DETAIL_ACTIVITY_LIMIT,
  SUBAGENT_ACTIVITY_PAGE_LIMIT,
  TrimmedNonEmptyString,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type OrchestrationThreadSubagent,
  ModelSelection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThreadSubagent } from "../../persistence/Services/ProjectionThreadSubagents.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionFullThreadDiffContext,
  type ProjectionSnapshotCounts,
  type ProjectionThreadCheckpointContext,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeShellSnapshot = Schema.decodeUnknownEffect(OrchestrationShellSnapshot);
const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);
const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    correlation: Schema.NullOr(Schema.fromJsonString(EpicPlanCorrelation)),
    origin: Schema.NullOr(OrchestrationMessageOrigin),
    deliveryState: Schema.NullOr(OrchestrationMessageDeliveryState),
  }),
);
const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;
const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
  }),
);
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
// Same NullOr mapping the repository layer uses: nullable TEXT columns come
// back as SQL NULL, which the mapper below folds into absent optional fields.
const ProjectionThreadSubagentDbRowSchema = ProjectionThreadSubagent.mapFields(
  Struct.assign({
    agentType: Schema.NullOr(TrimmedNonEmptyString),
    description: Schema.NullOr(TrimmedNonEmptyString),
    lastProgressSummary: Schema.NullOr(TrimmedNonEmptyString),
    lastToolName: Schema.NullOr(TrimmedNonEmptyString),
    usage: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
    spawnedByItemId: Schema.NullOr(TrimmedNonEmptyString),
    childThreadId: Schema.NullOr(ThreadId),
  }),
);
const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
});
const ProjectionStateDbRowSchema = ProjectionState;
const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
});
const ProjectionThreadActivityCountRowSchema = Schema.Struct({
  activityCount: Schema.Number,
});
const ProjectionRunningSubagentCountRowSchema = Schema.Struct({
  threadId: ThreadId,
  activeSubagentCount: Schema.Number,
});
const ProjectionThreadRunningSubagentCountRowSchema = Schema.Struct({
  activeSubagentCount: Schema.Number,
  newestRunningUpdatedAt: Schema.NullOr(Schema.String),
});
const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});
const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
});
const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
});
const ParentThreadIdLookupInput = Schema.Struct({
  parentThreadId: ThreadId,
});

const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema;
const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
});
const ProjectionThreadCheckpointContextThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
});
const FullThreadDiffContextLookupInput = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
});
const ProjectionFullThreadDiffContextRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  latestCheckpointTurnCount: Schema.NullOr(NonNegativeInt),
  toCheckpointRef: Schema.NullOr(CheckpointRef),
});
const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
] as const;

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

function mapLatestTurn(
  row: Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>,
): OrchestrationLatestTurn {
  return {
    turnId: row.turnId,
    state:
      row.state === "error"
        ? "error"
        : row.state === "interrupted"
          ? "interrupted"
          : row.state === "completed"
            ? "completed"
            : "running",
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    assistantMessageId: row.assistantMessageId,
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
  };
}

function mapSessionRow(
  row: Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>,
): OrchestrationSession {
  return {
    threadId: row.threadId,
    status: row.status,
    providerName: row.providerName,
    ...(row.providerInstanceId !== null ? { providerInstanceId: row.providerInstanceId } : {}),
    runtimeMode: row.runtimeMode,
    activeTurnId: row.activeTurnId,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

// Same shape the projection pipeline's `toThreadSubagentReadModel` produces:
// the persistence-only `threadId` stays off the read model, and SQL NULLs
// become absent optional fields so the row matches what the shared
// `applySubagentActivity` fold would have built.
function mapThreadSubagentRow(
  row: Schema.Schema.Type<typeof ProjectionThreadSubagentDbRowSchema>,
): OrchestrationThreadSubagent {
  return {
    subagentId: row.subagentId,
    turnId: row.turnId,
    ...(row.agentType !== null ? { agentType: row.agentType } : {}),
    ...(row.description !== null ? { description: row.description } : {}),
    status: row.status,
    ...(row.lastProgressSummary !== null ? { lastProgressSummary: row.lastProgressSummary } : {}),
    ...(row.lastToolName !== null ? { lastToolName: row.lastToolName } : {}),
    ...(row.usage !== null ? { usage: row.usage } : {}),
    ...(row.spawnedByItemId !== null ? { spawnedByItemId: row.spawnedByItemId } : {}),
    ...(row.childThreadId !== null ? { childThreadId: row.childThreadId } : {}),
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

function mapProjectShellRow(
  row: Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>,
  repositoryIdentity: OrchestrationProject["repositoryIdentity"],
): OrchestrationProjectShell {
  return {
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: row.defaultModelSelection,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapProposedPlanRow(
  row: Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>,
): OrchestrationProposedPlan {
  return {
    id: row.planId,
    turnId: row.turnId,
    planMarkdown: row.planMarkdown,
    implementedAt: row.implementedAt,
    implementationThreadId: row.implementationThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

/**
 * The query half of a traced read: encode the request, run the statement, hand
 * back the rows undecoded.
 *
 * Kept separate from the decode half so a caller can run this inside
 * `sql.withTransaction` and {@link tracedDecodeRows} after it. A transaction
 * holds the single connection permit for its whole duration, so every
 * millisecond of decode left inside it is a millisecond every writer waits.
 *
 * The caller passes the same operation name it would otherwise pass to
 * `toPersistenceSqlOrDecodeError`, and this applies that mapping too, so a span
 * and the error the same step would raise can never drift apart.
 */
const tracedFindAllRaw = <Req extends Schema.Top, E, R>(options: {
  readonly Request: Req;
  readonly execute: (request: Req["Encoded"]) => Effect.Effect<ReadonlyArray<unknown>, E, R>;
}) => {
  const encodeRequest = Schema.encodeEffect(options.Request);
  return (
    request: Req["Type"],
    operation: string,
  ): Effect.Effect<
    ReadonlyArray<unknown>,
    ProjectionRepositoryError,
    Req["EncodingServices"] | R
  > =>
    encodeRequest(request).pipe(
      Effect.flatMap(options.execute),
      Effect.tap((rows) => Effect.annotateCurrentSpan("db.rows", rows.length)),
      Effect.withSpan(`${operation}:query`),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(`${operation}:query`, `${operation}:decodeRows`),
      ),
    );
};

/**
 * The decode half of a traced read.
 *
 * Safe to run after the transaction that produced `rows` has committed:
 * `NodeSqliteClient` reads through `statement.all()`, so every row is fully
 * materialised before this sees it and no cursor depends on the open
 * transaction. A decode failure after COMMIT fails the effect, so no
 * half-assembled value can escape.
 */
const tracedDecodeRows = <Res extends Schema.Top>(Result: Res) => {
  const decodeRows = Schema.decodeUnknownEffect(Schema.mutable(Schema.Array(Result)));
  return (
    rows: ReadonlyArray<unknown>,
    operation: string,
  ): Effect.Effect<Array<Res["Type"]>, ProjectionRepositoryError, Res["DecodingServices"]> =>
    decodeRows(rows).pipe(
      Effect.withSpan(`${operation}:decodeRows`, {
        attributes: { "db.rows": rows.length },
      }),
      Effect.mapError(toPersistenceDecodeError(`${operation}:decodeRows`)),
    );
};

/**
 * `SqlSchema.findAll` fuses the statement and the row decode into one effect,
 * so a trace can only show their sum. This runs the two halves above back to
 * back instead, so a read's SQL time and its decode time are each readable
 * straight off a span, with no subtracting one duration from another.
 *
 * Reads whose decode must leave the transaction call the two halves separately.
 * This is for the ones whose decode stays where it is.
 */
const tracedFindAll = <Req extends Schema.Top, Res extends Schema.Top, E, R>(options: {
  readonly Request: Req;
  readonly Result: Res;
  readonly execute: (request: Req["Encoded"]) => Effect.Effect<ReadonlyArray<unknown>, E, R>;
}) => {
  const fetchRows = tracedFindAllRaw(options);
  const decodeRows = tracedDecodeRows(options.Result);
  return (
    request: Req["Type"],
    operation: string,
  ): Effect.Effect<
    Array<Res["Type"]>,
    ProjectionRepositoryError,
    Req["EncodingServices"] | Res["DecodingServices"] | R
  > => fetchRows(request, operation).pipe(Effect.flatMap((rows) => decodeRows(rows, operation)));
};

/**
 * Operation names for the thread-detail reads.
 *
 * The query and the decode of one read now happen in two different places, and
 * both name their span and their error from the same constant, so the halves of
 * a read cannot end up labelled differently. They keep the
 * `getThreadDetailById` prefix on both entry points, as they did when
 * `getThreadDetailSnapshot` reached these reads through that method.
 */
const THREAD_DETAIL_GET_THREAD = "ProjectionSnapshotQuery.getThreadDetailById:getThread";
const THREAD_DETAIL_LIST_MESSAGES = "ProjectionSnapshotQuery.getThreadDetailById:listMessages";
const THREAD_DETAIL_LIST_ACTIVITIES = "ProjectionSnapshotQuery.getThreadDetailById:listActivities";
const THREAD_DETAIL_LIST_CHECKPOINTS =
  "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints";
const THREAD_DETAIL_LIST_SUBAGENTS = "ProjectionSnapshotQuery.getThreadDetailById:listSubagents";
const SUBAGENT_ACTIVITY_LIST = "ProjectionSnapshotQuery.getSubagentActivities:listActivities";

const decodeThreadRow = Schema.decodeUnknownEffect(ProjectionThreadDbRowSchema);
const decodeThreadMessageRows = tracedDecodeRows(ProjectionThreadMessageDbRowSchema);
const decodeThreadActivityRows = tracedDecodeRows(ProjectionThreadActivityDbRowSchema);
const decodeCheckpointRows = tracedDecodeRows(ProjectionCheckpointDbRowSchema);
const decodeThreadSubagentRows = tracedDecodeRows(ProjectionThreadSubagentDbRowSchema);

/**
 * Operation names for the bulk-snapshot reads: one name per read, not one per
 * half.
 *
 * Same reason as the thread-detail constants above. Each of these reads now has
 * its statement in one place and its decode in another, and both name their
 * span and their error from this single string.
 */
const COMMAND_READ_MODEL_READS = {
  projects: "ProjectionSnapshotQuery.getCommandReadModel:listProjects",
  threads: "ProjectionSnapshotQuery.getCommandReadModel:listThreads",
  proposedPlans: "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans",
  sessions: "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions",
  latestTurns: "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns",
} as const;
const SHELL_SNAPSHOT_READS = {
  projects: "ProjectionSnapshotQuery.getShellSnapshot:listProjects",
  threads: "ProjectionSnapshotQuery.getShellSnapshot:listThreads",
  sessions: "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions",
  latestTurns: "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns",
} as const;
const ARCHIVED_SHELL_SNAPSHOT_READS = {
  projects: "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects",
  threads: "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads",
  sessions: "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions",
  latestTurns: "ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns",
} as const;

/**
 * Row decoders for the reads the bulk snapshots share.
 *
 * Every one of these reads grows with the project or the thread count, so its
 * decode runs after the transaction that read it. They decode with the same row
 * schemas the fused reads use, so a column rename cannot make one half of a
 * read disagree with the other.
 */
const decodeProjectRows = tracedDecodeRows(ProjectionProjectDbRowSchema);
const decodeThreadRows = tracedDecodeRows(ProjectionThreadDbRowSchema);
const decodeThreadProposedPlanRows = tracedDecodeRows(ProjectionThreadProposedPlanDbRowSchema);
const decodeThreadSessionRows = tracedDecodeRows(ProjectionThreadSessionDbRowSchema);
const decodeLatestTurnRows = tracedDecodeRows(ProjectionLatestTurnDbRowSchema);

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const repositoryIdentityResolutionConcurrency = 4;
  const resolveRepositoryIdentitiesForProjects = Effect.fn(
    "ProjectionSnapshotQuery.resolveRepositoryIdentitiesForProjects",
  )(function* (
    projectRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>>,
    options?: {
      readonly includeDeleted?: boolean;
    },
  ) {
    const filteredProjectRows =
      options?.includeDeleted === true
        ? projectRows
        : projectRows.filter((row) => row.deletedAt === null);
    const uniqueWorkspaceRoots = [...new Set(filteredProjectRows.map((row) => row.workspaceRoot))];
    const repositoryIdentityByWorkspaceRoot = new Map(
      yield* Effect.forEach(
        uniqueWorkspaceRoots,
        (workspaceRoot) =>
          repositoryIdentityResolver
            .resolve(workspaceRoot)
            .pipe(Effect.map((identity) => [workspaceRoot, identity] as const)),
        { concurrency: repositoryIdentityResolutionConcurrency },
      ),
    );

    return new Map(
      filteredProjectRows.map((row) => [
        row.projectId,
        repositoryIdentityByWorkspaceRoot.get(row.workspaceRoot) ?? null,
      ]),
    );
  });

  /**
   * The statements the bulk snapshots and `getSnapshot` share.
   *
   * Each one backs two reads: a raw read the bulk snapshots run inside their
   * transaction and decode after it, and a fused read `getSnapshot` still runs
   * as one step. Both halves come off the same statement, so the columns a
   * decode expects cannot drift from the columns a read returns.
   */
  const selectProjectRows = () =>
    sql`
      SELECT
        project_id AS "projectId",
        title,
        workspace_root AS "workspaceRoot",
        default_model_selection_json AS "defaultModelSelection",
        scripts_json AS "scripts",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM projection_projects
      ORDER BY created_at ASC, project_id ASC
    `;

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: selectProjectRows,
  });

  const listProjectRawRows = tracedFindAllRaw({
    Request: Schema.Void,
    execute: selectProjectRows,
  });

  const selectThreadRows = () =>
    sql`
      SELECT
        thread_id AS "threadId",
        project_id AS "projectId",
        title,
        model_selection_json AS "modelSelection",
        runtime_mode AS "runtimeMode",
        interaction_mode AS "interactionMode",
        branch,
        worktree_path AS "worktreePath",
        latest_turn_id AS "latestTurnId",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        archived_at AS "archivedAt",
        settled_override AS "settledOverride",
        settled_at AS "settledAt",
        latest_user_message_at AS "latestUserMessageAt",
        pending_approval_count AS "pendingApprovalCount",
        pending_user_input_count AS "pendingUserInputCount",
        has_actionable_proposed_plan AS "hasActionableProposedPlan",
        deleted_at AS "deletedAt",
        parent_thread_id AS "parentThreadId"
      FROM projection_threads
      ORDER BY created_at ASC, thread_id ASC
    `;

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: selectThreadRows,
  });

  const listThreadRawRows = tracedFindAllRaw({
    Request: Schema.Void,
    execute: selectThreadRows,
  });

  // The shell snapshots are the only callers of the active and archived reads,
  // and both decode after their transaction, so these have no fused variant.
  const listActiveThreadRawRows = tracedFindAllRaw({
    Request: Schema.Void,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt",
          parent_thread_id AS "parentThreadId"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY project_id ASC, created_at ASC, thread_id ASC
      `,
  });

  const listArchivedThreadRawRows = tracedFindAllRaw({
    Request: Schema.Void,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt",
          parent_thread_id AS "parentThreadId"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND archived_at IS NOT NULL
        ORDER BY project_id ASC, archived_at DESC, thread_id DESC
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          correlation_json AS "correlation",
          origin,
          delivery_state AS "deliveryState",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  const selectThreadProposedPlanRows = () =>
    sql`
      SELECT
        plan_id AS "planId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        plan_markdown AS "planMarkdown",
        implemented_at AS "implementedAt",
        implementation_thread_id AS "implementationThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans
      ORDER BY thread_id ASC, created_at ASC, plan_id ASC
    `;

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: selectThreadProposedPlanRows,
  });

  const listThreadProposedPlanRawRows = tracedFindAllRaw({
    Request: Schema.Void,
    execute: selectThreadProposedPlanRows,
  });

  const listThreadActivityRows = tracedFindAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        ORDER BY
          thread_id ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const selectThreadSessionRows = () =>
    sql`
      SELECT
        thread_id AS "threadId",
        status,
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId",
        provider_session_id AS "providerSessionId",
        provider_thread_id AS "providerThreadId",
        runtime_mode AS "runtimeMode",
        active_turn_id AS "activeTurnId",
        last_error AS "lastError",
        updated_at AS "updatedAt"
      FROM projection_thread_sessions
      ORDER BY thread_id ASC
    `;

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: selectThreadSessionRows,
  });

  const listThreadSessionRawRows = tracedFindAllRaw({
    Request: Schema.Void,
    execute: selectThreadSessionRows,
  });

  const listActiveThreadSessionRawRows = tracedFindAllRaw({
    Request: Schema.Void,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        ORDER BY sessions.thread_id ASC
      `,
  });

  const listArchivedThreadSessionRawRows = tracedFindAllRaw({
    Request: Schema.Void,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
        ORDER BY sessions.thread_id ASC
      `,
  });

  const listThreadSubagentRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSubagentDbRowSchema,
    execute: () =>
      sql`
        SELECT
          subagent_id AS "subagentId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          agent_type AS "agentType",
          description,
          status,
          last_progress_summary AS "lastProgressSummary",
          last_tool_name AS "lastToolName",
          usage_json AS "usage",
          spawned_by_item_id AS "spawnedByItemId",
          child_thread_id AS "childThreadId",
          started_at AS "startedAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
        FROM projection_thread_subagents
        ORDER BY thread_id ASC, started_at ASC, subagent_id ASC
      `,
  });

  const listThreadSubagentRawRowsByThread = tracedFindAllRaw({
    Request: ThreadIdLookupInput,
    execute: ({ threadId }) =>
      sql`
        SELECT
          subagent_id AS "subagentId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          agent_type AS "agentType",
          description,
          status,
          last_progress_summary AS "lastProgressSummary",
          last_tool_name AS "lastToolName",
          usage_json AS "usage",
          spawned_by_item_id AS "spawnedByItemId",
          child_thread_id AS "childThreadId",
          started_at AS "startedAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
        FROM projection_thread_subagents
        WHERE thread_id = ${threadId}
        ORDER BY started_at ASC, subagent_id ASC
      `,
  });

  // One row per thread that still has a running subagent, so the decode cost
  // inside the shell transactions is bounded by concurrent subagent use, not
  // by workspace size. Rides idx_projection_thread_subagents_thread_status.
  const listRunningSubagentCountRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionRunningSubagentCountRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          COUNT(*) AS "activeSubagentCount"
        FROM projection_thread_subagents
        WHERE status = 'running'
        GROUP BY thread_id
      `,
  });

  // The command read model's slice of the subagent table: only `running` rows
  // matter there (the decider's settle invariant counts fresh running work),
  // and their number is bounded by concurrent subagent use rather than by
  // workspace size, so the decode may stay inline like `projection_state`'s.
  // Rides idx_projection_thread_subagents_thread_status.
  const listRunningThreadSubagentRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSubagentDbRowSchema,
    execute: () =>
      sql`
        SELECT
          subagent_id AS "subagentId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          agent_type AS "agentType",
          description,
          status,
          last_progress_summary AS "lastProgressSummary",
          last_tool_name AS "lastToolName",
          usage_json AS "usage",
          spawned_by_item_id AS "spawnedByItemId",
          child_thread_id AS "childThreadId",
          started_at AS "startedAt",
          updated_at AS "updatedAt",
          completed_at AS "completedAt"
        FROM projection_thread_subagents
        WHERE status = 'running'
        ORDER BY thread_id ASC, started_at ASC, subagent_id ASC
      `,
  });

  const countRunningSubagentRowsByThread = SqlSchema.findOne({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadRunningSubagentCountRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          COUNT(*) AS "activeSubagentCount",
          MAX(updated_at) AS "newestRunningUpdatedAt"
        FROM projection_thread_subagents
        WHERE thread_id = ${threadId}
          AND status = 'running'
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const selectLatestTurnRows = () =>
    sql`
      SELECT
        turns.thread_id AS "threadId",
        turns.turn_id AS "turnId",
        turns.state,
        turns.requested_at AS "requestedAt",
        turns.started_at AS "startedAt",
        turns.completed_at AS "completedAt",
        turns.assistant_message_id AS "assistantMessageId",
        turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
        turns.source_proposed_plan_id AS "sourceProposedPlanId"
      FROM projection_threads threads
      JOIN projection_turns turns
        ON turns.thread_id = threads.thread_id
        AND turns.turn_id = threads.latest_turn_id
      WHERE threads.latest_turn_id IS NOT NULL
      ORDER BY turns.thread_id ASC
    `;

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: selectLatestTurnRows,
  });

  const listLatestTurnRawRows = tracedFindAllRaw({
    Request: Schema.Void,
    execute: selectLatestTurnRows,
  });

  const listActiveLatestTurnRawRows = tracedFindAllRaw({
    Request: Schema.Void,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listArchivedLatestTurnRawRows = tracedFindAllRaw({
    Request: Schema.Void,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
      `,
  });

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
        LIMIT 1
      `,
  });

  const getActiveProjectRowById = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getFirstActiveThreadIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  // Rides `idx_projection_threads_parent_thread`.
  const listChildThreadIdRows = SqlSchema.findAll({
    Request: ParentThreadIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ parentThreadId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE parent_thread_id = ${parentThreadId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listThreadIdsWithQueuedMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: () =>
      sql`
        SELECT DISTINCT
          messages.thread_id AS "threadId"
        FROM projection_thread_messages AS messages
        JOIN projection_threads AS threads
          ON threads.thread_id = messages.thread_id
        WHERE messages.delivery_state = 'queued'
          AND threads.deleted_at IS NULL
        ORDER BY messages.thread_id ASC
      `,
  });

  const getThreadCheckpointContextThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCheckpointContextThreadRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  // Reads the row undecoded, for the same reason as `tracedFindAllRaw`: the
  // caller decodes it with `decodeThreadRow` after the transaction has
  // committed, so the connection permit is not held for the decode.
  const getActiveThreadRawRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: Schema.Unknown,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt",
          parent_thread_id AS "parentThreadId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        LIMIT 1
      `,
  });

  const listThreadMessageRawRowsByThread = tracedFindAllRaw({
    Request: ThreadIdLookupInput,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          correlation_json AS "correlation",
          origin,
          delivery_state AS "deliveryState",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, plan_id ASC
      `,
  });

  // Reads the newest `THREAD_DETAIL_ACTIVITY_LIMIT` activities, plus every
  // request/response activity for the thread regardless of how old it is.
  //
  // The window alone is not safe. The sidebar badge comes from an independent
  // SQL projection (pending_approval_count / pending_user_input_count), while
  // the chat prompt is derived from this activity list. Drop an unresolved
  // `approval.requested` and the sidebar says "waiting for approval" while the
  // chat shows no prompt to answer — the agent stays blocked with no way out.
  // The resolution and stale-failure kinds are pinned for the mirror bug: keep
  // a request without its resolution and the prompt never goes away.
  //
  // The two CTEs select `activity_id` only so the dedupe never compares
  // `payload_json`, which is 75-97% of this table's bytes.
  //
  // The same policy is implemented twice. This copy is the one clients see.
  // The other is `capThreadActivities` in `orchestration/projector.ts`, which
  // feeds only the decider's command read model. Change both or neither.
  //
  // Neither copy pins subagent activities, and that is deliberate: subagents
  // reach clients from `projection_thread_subagents`, not from this list, so
  // the roster survives the cap on its own. Locked by "keeps the subagent
  // roster after the activity cap evicts its task.started row" in
  // `ProjectionSnapshotQuery.test.ts`.
  const listThreadActivityRawRowsByThread = tracedFindAllRaw({
    Request: ThreadIdLookupInput,
    execute: ({ threadId }) =>
      sql`
        WITH newest_activity_ids AS (
          SELECT activity_id
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
          ORDER BY
            sequence DESC,
            created_at DESC,
            activity_id DESC
          LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
        ),
        selected_activity_ids AS (
          SELECT activity_id FROM newest_activity_ids
          UNION
          SELECT activity_id
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND ${sql.in("kind", THREAD_ACTIVITY_OPEN_REQUEST_KINDS)}
        )
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND activity_id IN (SELECT activity_id FROM selected_activity_ids)
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listSubagentActivityRawRows = tracedFindAllRaw({
    Request: OrchestrationGetSubagentActivitiesInput,
    execute: ({ threadId, subagentId, limit, before }) => {
      const pageLimit = Math.max(
        1,
        Math.min(limit ?? SUBAGENT_ACTIVITY_PAGE_LIMIT, SUBAGENT_ACTIVITY_PAGE_LIMIT),
      );
      const hasCursor = before === undefined ? 0 : 1;

      return sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND EXISTS (
            SELECT 1
            FROM projection_thread_subagents
            WHERE thread_id = ${threadId}
              AND subagent_id = ${subagentId}
          )
          AND (
            (
              parent_tool_use_id IS NOT NULL
              AND parent_tool_use_id = (
                SELECT spawned_by_item_id
                FROM projection_thread_subagents
                WHERE thread_id = ${threadId}
                  AND subagent_id = ${subagentId}
              )
            )
            OR task_id = ${subagentId}
          )
          AND (
            ${hasCursor} = 0
            OR (COALESCE(sequence, -1), created_at, activity_id) < (
              COALESCE(${before?.sequence ?? null}, -1),
              ${before?.createdAt ?? ""},
              ${before?.activityId ?? ""}
            )
          )
        ORDER BY COALESCE(sequence, -1) DESC, created_at DESC, activity_id DESC
        LIMIT ${pageLimit + 1}
      `;
    },
  });

  // How many activities the thread actually holds, so the capped read above can
  // report how many it left out. `COUNT(*)` never touches `payload_json`, which
  // is 75-97% of this table's bytes, and it rides the
  // `(thread_id, sequence, created_at, activity_id)` index.
  const countThreadActivityRowsByThread = SqlSchema.findOne({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityCountRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT COUNT(*) AS "activityCount"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
      `,
  });

  const getThreadSessionRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        LIMIT 1
      `,
  });

  const listCheckpointRawRowsByThread = tracedFindAllRaw({
    Request: ThreadIdLookupInput,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const getFullThreadDiffContextRow = SqlSchema.findOneOption({
    Request: FullThreadDiffContextLookupInput,
    Result: ProjectionFullThreadDiffContextRowSchema,
    execute: ({ threadId, checkpointTurnCount }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath",
          (
            SELECT MAX(turns.checkpoint_turn_count)
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count IS NOT NULL
          ) AS "latestCheckpointTurnCount",
          (
            SELECT turns.checkpoint_ref
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count = ${checkpointTurnCount}
            LIMIT 1
          ) AS "toCheckpointRef"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listThreadMessageRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listThreadActivityRows(
            undefined,
            "ProjectionSnapshotQuery.getSnapshot:listThreadActivities",
          ),
          listThreadSubagentRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadSubagents:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadSubagents:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listCheckpointRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            messageRows,
            proposedPlanRows,
            activityRows,
            subagentRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
              const subagentsByThread = new Map<string, Array<OrchestrationThreadSubagent>>();
              const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
              const sessionsByThread = new Map<string, OrchestrationSession>();
              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();

              let updatedAt: string | null = null;

              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of messageRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadMessages = messagesByThread.get(row.threadId) ?? [];
                threadMessages.push({
                  id: row.messageId,
                  role: row.role,
                  text: row.text,
                  ...(row.attachments !== null ? { attachments: row.attachments } : {}),
                  ...(row.correlation !== null ? { correlation: row.correlation } : {}),
                  ...(row.origin !== null ? { origin: row.origin } : {}),
                  ...(row.deliveryState !== null ? { deliveryState: row.deliveryState } : {}),
                  turnId: row.turnId,
                  streaming: row.isStreaming === 1,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                messagesByThread.set(row.threadId, threadMessages);
              }

              for (const row of proposedPlanRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push({
                  id: row.planId,
                  turnId: row.turnId,
                  planMarkdown: row.planMarkdown,
                  implementedAt: row.implementedAt,
                  implementationThreadId: row.implementationThreadId,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (const row of activityRows) {
                updatedAt = maxIso(updatedAt, row.createdAt);
                const threadActivities = activitiesByThread.get(row.threadId) ?? [];
                threadActivities.push({
                  id: row.activityId,
                  tone: row.tone,
                  kind: row.kind,
                  summary: row.summary,
                  payload: row.payload,
                  turnId: row.turnId,
                  ...(row.sequence !== null ? { sequence: row.sequence } : {}),
                  createdAt: row.createdAt,
                });
                activitiesByThread.set(row.threadId, threadActivities);
              }

              for (const row of subagentRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadSubagents = subagentsByThread.get(row.threadId) ?? [];
                threadSubagents.push(mapThreadSubagentRow(row));
                subagentsByThread.set(row.threadId, threadSubagents);
              }

              for (const row of checkpointRows) {
                updatedAt = maxIso(updatedAt, row.completedAt);
                const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
                threadCheckpoints.push({
                  turnId: row.turnId,
                  checkpointTurnCount: row.checkpointTurnCount,
                  checkpointRef: row.checkpointRef,
                  status: row.status,
                  files: row.files,
                  assistantMessageId: row.assistantMessageId,
                  completedAt: row.completedAt,
                });
                checkpointsByThread.set(row.threadId, threadCheckpoints);
              }

              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
                if (latestTurnByThread.has(row.threadId)) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, {
                  turnId: row.turnId,
                  state:
                    row.state === "error"
                      ? "error"
                      : row.state === "interrupted"
                        ? "interrupted"
                        : row.state === "completed"
                          ? "completed"
                          : "running",
                  requestedAt: row.requestedAt,
                  startedAt: row.startedAt,
                  completedAt: row.completedAt,
                  assistantMessageId: row.assistantMessageId,
                  ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
                    ? {
                        sourceProposedPlan: {
                          threadId: row.sourceProposedPlanThreadId,
                          planId: row.sourceProposedPlanId,
                        },
                      }
                    : {}),
                });
              }

              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                sessionsByThread.set(row.threadId, {
                  threadId: row.threadId,
                  status: row.status,
                  providerName: row.providerName,
                  ...(row.providerInstanceId !== null
                    ? { providerInstanceId: row.providerInstanceId }
                    : {}),
                  runtimeMode: row.runtimeMode,
                  activeTurnId: row.activeTurnId,
                  lastError: row.lastError,
                  updatedAt: row.updatedAt,
                });
              }

              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows,
                { includeDeleted: true },
              );

              const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
                id: row.projectId,
                title: row.title,
                workspaceRoot: row.workspaceRoot,
                repositoryIdentity: repositoryIdentities.get(row.projectId) ?? null,
                defaultModelSelection: row.defaultModelSelection,
                scripts: row.scripts,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                deletedAt: row.deletedAt,
              }));

              const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) => ({
                id: row.threadId,
                projectId: row.projectId,
                title: row.title,
                modelSelection: row.modelSelection,
                runtimeMode: row.runtimeMode,
                interactionMode: row.interactionMode,
                branch: row.branch,
                worktreePath: row.worktreePath,
                latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                archivedAt: row.archivedAt,
                settledOverride: row.settledOverride,
                settledAt: row.settledAt,
                deletedAt: row.deletedAt,
                parentThreadId: row.parentThreadId,
                messages: messagesByThread.get(row.threadId) ?? [],
                proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                subagents: subagentsByThread.get(row.threadId) ?? [],
                activities: activitiesByThread.get(row.threadId) ?? [],
                checkpoints: checkpointsByThread.get(row.threadId) ?? [],
                session: sessionsByThread.get(row.threadId) ?? null,
              }));

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                threads,
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              };

              return yield* decodeReadModel(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  const getCommandReadModel: ProjectionSnapshotQueryShape["getCommandReadModel"] = () =>
    sql
      // Every command dispatch waits on this read, and the transaction holds the
      // single connection permit for its whole duration, so only the statements
      // go inside. The row decode runs after the commit, in the `flatMap` below.
      .withTransaction(
        Effect.all([
          listProjectRawRows(undefined, COMMAND_READ_MODEL_READS.projects),
          listThreadRawRows(undefined, COMMAND_READ_MODEL_READS.threads),
          listThreadProposedPlanRawRows(undefined, COMMAND_READ_MODEL_READS.proposedPlans),
          listThreadSessionRawRows(undefined, COMMAND_READ_MODEL_READS.sessions),
          listLatestTurnRawRows(undefined, COMMAND_READ_MODEL_READS.latestTurns),
          // Running subagent rows keep their decode inside too: their number is
          // bounded by concurrent subagent use, not workspace size. The settle
          // invariant needs them here — the in-memory read model accumulates
          // them from live events, but every dispatch failure reconciles from
          // this snapshot, and an empty list would erase exactly the state
          // that made the decider refuse.
          listRunningThreadSubagentRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listRunningThreadSubagents:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listRunningThreadSubagents:decodeRows",
              ),
            ),
          ),
          // The one read that keeps its decode inside. `projection_state` holds
          // one row per projector — a fixed set — so its decode cannot grow
          // with the workspace, and splitting it would buy nothing.
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRawRows,
            threadRawRows,
            proposedPlanRawRows,
            sessionRawRows,
            latestTurnRawRows,
            runningSubagentRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              // Safe after the commit: `statement.all()` materialised every row
              // before the transaction closed, so no cursor here depends on it.
              const [projectRows, threadRows, proposedPlanRows, sessionRows, latestTurnRows] =
                yield* Effect.all([
                  decodeProjectRows(projectRawRows, COMMAND_READ_MODEL_READS.projects),
                  decodeThreadRows(threadRawRows, COMMAND_READ_MODEL_READS.threads),
                  decodeThreadProposedPlanRows(
                    proposedPlanRawRows,
                    COMMAND_READ_MODEL_READS.proposedPlans,
                  ),
                  decodeThreadSessionRows(sessionRawRows, COMMAND_READ_MODEL_READS.sessions),
                  decodeLatestTurnRows(latestTurnRawRows, COMMAND_READ_MODEL_READS.latestTurns),
                ]);

              let updatedAt: string | null = null;
              const projects: OrchestrationProject[] = [];
              const threads: OrchestrationThread[] = [];

              for (let index = 0; index < projectRows.length; index += 1) {
                const row = projectRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
                projects.push({
                  id: row.projectId,
                  title: row.title,
                  workspaceRoot: row.workspaceRoot,
                  defaultModelSelection: row.defaultModelSelection,
                  scripts: row.scripts,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  deletedAt: row.deletedAt,
                });
              }
              for (let index = 0; index < threadRows.length; index += 1) {
                const row = threadRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < proposedPlanRows.length; index += 1) {
                const row = proposedPlanRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < sessionRows.length; index += 1) {
                const row = sessionRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < latestTurnRows.length; index += 1) {
                const row = latestTurnRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (let index = 0; index < stateRows.length; index += 1) {
                const row = stateRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
              for (let index = 0; index < latestTurnRows.length; index += 1) {
                const row = latestTurnRows[index];
                if (!row) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, mapLatestTurn(row));
              }
              const runningSubagentsByThread = new Map<
                string,
                Array<OrchestrationThreadSubagent>
              >();
              for (const row of runningSubagentRows) {
                const threadSubagents = runningSubagentsByThread.get(row.threadId) ?? [];
                threadSubagents.push(mapThreadSubagentRow(row));
                runningSubagentsByThread.set(row.threadId, threadSubagents);
              }
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const sessionByThread = new Map<string, OrchestrationSession>();

              for (let index = 0; index < sessionRows.length; index += 1) {
                const row = sessionRows[index];
                if (!row) {
                  continue;
                }
                sessionByThread.set(row.threadId, mapSessionRow(row));
              }

              for (let index = 0; index < proposedPlanRows.length; index += 1) {
                const row = proposedPlanRows[index];
                if (!row) {
                  continue;
                }
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push(mapProposedPlanRow(row));
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (let index = 0; index < threadRows.length; index += 1) {
                const row = threadRows[index];
                if (!row) {
                  continue;
                }
                threads.push({
                  id: row.threadId,
                  projectId: row.projectId,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  settledOverride: row.settledOverride,
                  settledAt: row.settledAt,
                  deletedAt: row.deletedAt,
                  parentThreadId: row.parentThreadId,
                  messages: [],
                  proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                  // Only the `running` rows: they are all the settle invariant
                  // reads, and settled rows would grow with history. Between
                  // reconciles the in-memory fold may settle these in place —
                  // `countFreshRunningSubagents` filters by status, so a
                  // lingering settled row is inert.
                  subagents: runningSubagentsByThread.get(row.threadId) ?? [],
                  activities: [],
                  checkpoints: [],
                  session: sessionByThread.get(row.threadId) ?? null,
                });
              }

              return {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                threads,
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              } satisfies OrchestrationReadModel;
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getCommandReadModel:query")(error);
        }),
      );

  const getShellSnapshot: ProjectionSnapshotQueryShape["getShellSnapshot"] = () =>
    sql
      // Statements only, for the same reason as `getCommandReadModel`.
      .withTransaction(
        Effect.all([
          listProjectRawRows(undefined, SHELL_SNAPSHOT_READS.projects),
          listActiveThreadRawRows(undefined, SHELL_SNAPSHOT_READS.threads),
          listActiveThreadSessionRawRows(undefined, SHELL_SNAPSHOT_READS.sessions),
          listActiveLatestTurnRawRows(undefined, SHELL_SNAPSHOT_READS.latestTurns),
          listRunningSubagentCountRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listRunningSubagentCounts:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listRunningSubagentCounts:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRawRows,
            threadRawRows,
            sessionRawRows,
            latestTurnRawRows,
            subagentCountRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              const [projectRows, threadRows, sessionRows, latestTurnRows] = yield* Effect.all([
                decodeProjectRows(projectRawRows, SHELL_SNAPSHOT_READS.projects),
                decodeThreadRows(threadRawRows, SHELL_SNAPSHOT_READS.threads),
                decodeThreadSessionRows(sessionRawRows, SHELL_SNAPSHOT_READS.sessions),
                decodeLatestTurnRows(latestTurnRawRows, SHELL_SNAPSHOT_READS.latestTurns),
              ]);

              let updatedAt: string | null = null;
              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const repositoryIdentities =
                yield* resolveRepositoryIdentitiesForProjects(projectRows);
              const latestTurnByThread = new Map(
                latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
              );
              const sessionByThread = new Map(
                sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
              );
              const activeSubagentCountByThread = new Map(
                subagentCountRows.map((row) => [row.threadId, row.activeSubagentCount] as const),
              );

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects: Arr.filterMap(projectRows, (row) =>
                  row.deletedAt === null
                    ? Result.succeed(
                        mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                      )
                    : Result.failVoid,
                ),
                threads: Arr.filterMap(threadRows, (row) =>
                  row.deletedAt === null
                    ? Result.succeed({
                        id: row.threadId,
                        projectId: row.projectId,
                        title: row.title,
                        modelSelection: row.modelSelection,
                        runtimeMode: row.runtimeMode,
                        interactionMode: row.interactionMode,
                        branch: row.branch,
                        worktreePath: row.worktreePath,
                        latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                        createdAt: row.createdAt,
                        updatedAt: row.updatedAt,
                        archivedAt: row.archivedAt,
                        settledOverride: row.settledOverride,
                        settledAt: row.settledAt,
                        session: sessionByThread.get(row.threadId) ?? null,
                        latestUserMessageAt: row.latestUserMessageAt,
                        hasPendingApprovals: row.pendingApprovalCount > 0,
                        hasPendingUserInput: row.pendingUserInputCount > 0,
                        hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                        activeSubagentCount: activeSubagentCountByThread.get(row.threadId) ?? 0,
                        parentThreadId: row.parentThreadId,
                      } satisfies OrchestrationThreadShell)
                    : Result.failVoid,
                ),
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              };

              return yield* decodeShellSnapshot(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:decodeShellSnapshot",
                  ),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getShellSnapshot:query")(error);
        }),
      );

  const getArchivedShellSnapshot: ProjectionSnapshotQueryShape["getArchivedShellSnapshot"] = () =>
    sql
      // Statements only, for the same reason as `getCommandReadModel`.
      .withTransaction(
        Effect.all([
          listProjectRawRows(undefined, ARCHIVED_SHELL_SNAPSHOT_READS.projects),
          listArchivedThreadRawRows(undefined, ARCHIVED_SHELL_SNAPSHOT_READS.threads),
          listArchivedThreadSessionRawRows(undefined, ARCHIVED_SHELL_SNAPSHOT_READS.sessions),
          listArchivedLatestTurnRawRows(undefined, ARCHIVED_SHELL_SNAPSHOT_READS.latestTurns),
          listRunningSubagentCountRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listRunningSubagentCounts:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listRunningSubagentCounts:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRawRows,
            threadRawRows,
            sessionRawRows,
            latestTurnRawRows,
            subagentCountRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              const [projectRows, threadRows, sessionRows, latestTurnRows] = yield* Effect.all([
                decodeProjectRows(projectRawRows, ARCHIVED_SHELL_SNAPSHOT_READS.projects),
                decodeThreadRows(threadRawRows, ARCHIVED_SHELL_SNAPSHOT_READS.threads),
                decodeThreadSessionRows(sessionRawRows, ARCHIVED_SHELL_SNAPSHOT_READS.sessions),
                decodeLatestTurnRows(latestTurnRawRows, ARCHIVED_SHELL_SNAPSHOT_READS.latestTurns),
              ]);

              let updatedAt: string | null = null;
              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const activeProjectIds = new Set(threadRows.map((row) => row.projectId));
              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows.filter((row) => activeProjectIds.has(row.projectId)),
              );
              const latestTurnByThread = new Map(
                latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
              );
              const sessionByThread = new Map(
                sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
              );
              const activeSubagentCountByThread = new Map(
                subagentCountRows.map((row) => [row.threadId, row.activeSubagentCount] as const),
              );

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects: Arr.filterMap(projectRows, (row) =>
                  row.deletedAt === null && activeProjectIds.has(row.projectId)
                    ? Result.succeed(
                        mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                      )
                    : Result.failVoid,
                ),
                threads: threadRows.map(
                  (row): OrchestrationThreadShell => ({
                    id: row.threadId,
                    projectId: row.projectId,
                    title: row.title,
                    modelSelection: row.modelSelection,
                    runtimeMode: row.runtimeMode,
                    interactionMode: row.interactionMode,
                    branch: row.branch,
                    worktreePath: row.worktreePath,
                    latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                    createdAt: row.createdAt,
                    updatedAt: row.updatedAt,
                    archivedAt: row.archivedAt,
                    settledOverride: row.settledOverride,
                    settledAt: row.settledAt,
                    session: sessionByThread.get(row.threadId) ?? null,
                    latestUserMessageAt: row.latestUserMessageAt,
                    hasPendingApprovals: row.pendingApprovalCount > 0,
                    hasPendingUserInput: row.pendingUserInputCount > 0,
                    hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                    activeSubagentCount: activeSubagentCountByThread.get(row.threadId) ?? 0,
                    parentThreadId: row.parentThreadId,
                  }),
                ),
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              };

              return yield* decodeShellSnapshot(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    "ProjectionSnapshotQuery.getArchivedShellSnapshot:decodeShellSnapshot",
                  ),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getArchivedShellSnapshot:query")(
            error,
          );
        }),
      );

  const getSnapshotSequence: ProjectionSnapshotQueryShape["getSnapshotSequence"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSnapshotSequence:query",
          "ProjectionSnapshotQuery.getSnapshotSequence:decodeRows",
        ),
      ),
      Effect.map((stateRows) => ({
        snapshotSequence: computeSnapshotSequence(stateRows),
      })),
    );

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          threadCount: row.threadCount,
        }),
      ),
    );

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          Option.isNone(option)
            ? Effect.succeed(Option.none<OrchestrationProject>())
            : repositoryIdentityResolver.resolve(option.value.workspaceRoot).pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some({
                    id: option.value.projectId,
                    title: option.value.title,
                    workspaceRoot: option.value.workspaceRoot,
                    repositoryIdentity,
                    defaultModelSelection: option.value.defaultModelSelection,
                    scripts: option.value.scripts,
                    createdAt: option.value.createdAt,
                    updatedAt: option.value.updatedAt,
                    deletedAt: option.value.deletedAt,
                  } satisfies OrchestrationProject),
                ),
              ),
        ),
      );

  const getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"] = (projectId) =>
    getActiveProjectRowById({ projectId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShellById:query",
          "ProjectionSnapshotQuery.getProjectShellById:decodeRow",
        ),
      ),
      Effect.flatMap((option) =>
        Option.isNone(option)
          ? Effect.succeed(Option.none<OrchestrationProjectShell>())
          : repositoryIdentityResolver
              .resolve(option.value.workspaceRoot)
              .pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some(mapProjectShellRow(option.value, repositoryIdentity)),
                ),
              ),
      ),
    );

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const listChildThreadIds: ProjectionSnapshotQueryShape["listChildThreadIds"] = (parentThreadId) =>
    listChildThreadIdRows({ parentThreadId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listChildThreadIds:query",
          "ProjectionSnapshotQuery.listChildThreadIds:decodeRow",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  const listThreadIdsWithQueuedMessages: ProjectionSnapshotQueryShape["listThreadIdsWithQueuedMessages"] =
    () =>
      listThreadIdsWithQueuedMessageRows().pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.listThreadIdsWithQueuedMessages:query",
            "ProjectionSnapshotQuery.listThreadIdsWithQueuedMessages:decodeRow",
          ),
        ),
        Effect.map((rows) => rows.map((row) => row.threadId)),
      );

  const getThreadCheckpointContext: ProjectionSnapshotQueryShape["getThreadCheckpointContext"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadCheckpointContextThreadRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointOperation =
        "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints";
      const checkpointRows = yield* listCheckpointRawRowsByThread(
        { threadId },
        checkpointOperation,
      ).pipe(Effect.flatMap((rows) => decodeCheckpointRows(rows, checkpointOperation)));

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        worktreePath: threadRow.value.worktreePath,
        checkpoints: checkpointRows.map(
          (row): OrchestrationCheckpointSummary => ({
            turnId: row.turnId,
            checkpointTurnCount: row.checkpointTurnCount,
            checkpointRef: row.checkpointRef,
            status: row.status,
            files: row.files,
            assistantMessageId: row.assistantMessageId,
            completedAt: row.completedAt,
          }),
        ),
      });
    });

  const getFullThreadDiffContext: NonNullable<
    ProjectionSnapshotQueryShape["getFullThreadDiffContext"]
  > = (threadId, toTurnCount) =>
    Effect.gen(function* () {
      const row = yield* getFullThreadDiffContextRow({
        threadId,
        checkpointTurnCount: toTurnCount,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFullThreadDiffContext:query",
            "ProjectionSnapshotQuery.getFullThreadDiffContext:decodeRow",
          ),
        ),
      );
      if (Option.isNone(row)) {
        return Option.none<ProjectionFullThreadDiffContext>();
      }

      return Option.some({
        threadId: row.value.threadId,
        projectId: row.value.projectId,
        workspaceRoot: row.value.workspaceRoot,
        worktreePath: row.value.worktreePath,
        latestCheckpointTurnCount: row.value.latestCheckpointTurnCount ?? 0,
        toCheckpointRef: row.value.toCheckpointRef,
      });
    });

  const getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"] = (threadId) =>
    Effect.gen(function* () {
      const [threadRawRow, latestTurnRow, sessionRow, subagentCountRow] = yield* Effect.all([
        getActiveThreadRawRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getThread:query",
              "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getSession:query",
              "ProjectionSnapshotQuery.getThreadShellById:getSession:decodeRow",
            ),
          ),
        ),
        countRunningSubagentRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:countRunningSubagents:query",
              "ProjectionSnapshotQuery.getThreadShellById:countRunningSubagents:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRawRow)) {
        return Option.none<OrchestrationThreadShell>();
      }
      const threadRow = yield* decodeThreadRow(threadRawRow.value).pipe(
        Effect.mapError(
          toPersistenceDecodeError(
            "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
          ),
        ),
      );

      return Option.some({
        id: threadRow.threadId,
        projectId: threadRow.projectId,
        title: threadRow.title,
        modelSelection: threadRow.modelSelection,
        runtimeMode: threadRow.runtimeMode,
        interactionMode: threadRow.interactionMode,
        branch: threadRow.branch,
        worktreePath: threadRow.worktreePath,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        createdAt: threadRow.createdAt,
        updatedAt: threadRow.updatedAt,
        archivedAt: threadRow.archivedAt,
        settledOverride: threadRow.settledOverride,
        settledAt: threadRow.settledAt,
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
        latestUserMessageAt: threadRow.latestUserMessageAt,
        hasPendingApprovals: threadRow.pendingApprovalCount > 0,
        hasPendingUserInput: threadRow.pendingUserInputCount > 0,
        hasActionableProposedPlan: threadRow.hasActionableProposedPlan > 0,
        activeSubagentCount: subagentCountRow.activeSubagentCount,
        parentThreadId: threadRow.parentThreadId,
      } satisfies OrchestrationThreadShell);
    });

  const getThreadSubagentLiveness: ProjectionSnapshotQueryShape["getThreadSubagentLiveness"] = (
    threadId,
  ) =>
    countRunningSubagentRowsByThread({ threadId }).pipe(
      Effect.map((row) => ({
        activeSubagentCount: row.activeSubagentCount,
        newestRunningUpdatedAt: row.newestRunningUpdatedAt,
      })),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getThreadSubagentLiveness:query",
          "ProjectionSnapshotQuery.getThreadSubagentLiveness:decodeRow",
        ),
      ),
      Effect.withSpan("ProjectionSnapshotQuery.getThreadSubagentLiveness"),
    );

  // `projection_thread_sessions` has no archived_at column, so this read works
  // for an archived thread just as well as for an active one. That is the point:
  // teardown triggered by `thread.archived` has no other way to see the session.
  const getThreadSessionById: ProjectionSnapshotQueryShape["getThreadSessionById"] = (threadId) =>
    getThreadSessionRowByThread({ threadId }).pipe(
      Effect.map(Option.map(mapSessionRow)),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getThreadSessionById:query",
          "ProjectionSnapshotQuery.getThreadSessionById:decodeRow",
        ),
      ),
      Effect.withSpan("ProjectionSnapshotQuery.getThreadSessionById"),
    );

  /**
   * The SQL half of a thread-detail read: every statement it needs, and not one
   * byte of decoding.
   *
   * Split out from {@link assembleThreadDetail} so `getThreadDetailSnapshot` can
   * hold the connection permit for the statements alone. The four heavy reads
   * come back undecoded; the four constant-size ones (plans, the activity count,
   * the latest turn, the session) still decode here, because their cost does not
   * grow with the thread.
   */
  const fetchThreadDetailRows = (threadId: ThreadId) =>
    Effect.all([
      getActiveThreadRawRowById({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            `${THREAD_DETAIL_GET_THREAD}:query`,
            `${THREAD_DETAIL_GET_THREAD}:decodeRow`,
          ),
        ),
      ),
      listThreadMessageRawRowsByThread({ threadId }, THREAD_DETAIL_LIST_MESSAGES),
      listThreadProposedPlanRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:listPlans:query",
            "ProjectionSnapshotQuery.getThreadDetailById:listPlans:decodeRows",
          ),
        ),
      ),
      listThreadActivityRawRowsByThread({ threadId }, THREAD_DETAIL_LIST_ACTIVITIES),
      countThreadActivityRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:countActivities:query",
            "ProjectionSnapshotQuery.getThreadDetailById:countActivities:decodeRow",
          ),
        ),
      ),
      listThreadSubagentRawRowsByThread({ threadId }, THREAD_DETAIL_LIST_SUBAGENTS),
      listCheckpointRawRowsByThread({ threadId }, THREAD_DETAIL_LIST_CHECKPOINTS),
      getLatestTurnRowByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:query",
            "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:decodeRow",
          ),
        ),
      ),
      getThreadSessionRowByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:getSession:query",
            "ProjectionSnapshotQuery.getThreadDetailById:getSession:decodeRow",
          ),
        ),
      ),
    ]);

  type ThreadDetailRows = Effect.Success<ReturnType<typeof fetchThreadDetailRows>>;

  /**
   * The decode-and-map half of a thread-detail read. Runs on rows that are
   * already fully materialised, so it is safe outside the transaction that read
   * them, and a failure here fails the whole effect rather than escaping as a
   * half-assembled thread.
   */
  const assembleThreadDetail = (rows: ThreadDetailRows) =>
    Effect.gen(function* () {
      const [
        threadRawRow,
        messageRawRows,
        proposedPlanRows,
        activityRawRows,
        activityCountRow,
        subagentRawRows,
        checkpointRawRows,
        latestTurnRow,
        sessionRow,
      ] = rows;

      if (Option.isNone(threadRawRow)) {
        return Option.none<OrchestrationThread>();
      }

      const [threadRow, messageRows, activityRows, subagentRows, checkpointRows] =
        yield* Effect.all([
          decodeThreadRow(threadRawRow.value).pipe(
            Effect.mapError(toPersistenceDecodeError(`${THREAD_DETAIL_GET_THREAD}:decodeRow`)),
          ),
          decodeThreadMessageRows(messageRawRows, THREAD_DETAIL_LIST_MESSAGES),
          decodeThreadActivityRows(activityRawRows, THREAD_DETAIL_LIST_ACTIVITIES),
          decodeThreadSubagentRows(subagentRawRows, THREAD_DETAIL_LIST_SUBAGENTS),
          decodeCheckpointRows(checkpointRawRows, THREAD_DETAIL_LIST_CHECKPOINTS),
        ]);

      // The capped read returns the newest window plus every pinned
      // request/response row, so the omitted count is whatever the thread holds
      // beyond what came back — not `total - THREAD_DETAIL_ACTIVITY_LIMIT`.
      const omittedActivityCount = Math.max(
        0,
        activityCountRow.activityCount - activityRows.length,
      );

      const thread = {
        id: threadRow.threadId,
        projectId: threadRow.projectId,
        title: threadRow.title,
        modelSelection: threadRow.modelSelection,
        runtimeMode: threadRow.runtimeMode,
        interactionMode: threadRow.interactionMode,
        branch: threadRow.branch,
        worktreePath: threadRow.worktreePath,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        createdAt: threadRow.createdAt,
        updatedAt: threadRow.updatedAt,
        archivedAt: threadRow.archivedAt,
        settledOverride: threadRow.settledOverride,
        settledAt: threadRow.settledAt,
        deletedAt: null,
        messages: messageRows.map((row) => {
          const message = {
            id: row.messageId,
            role: row.role,
            text: row.text,
            turnId: row.turnId,
            streaming: row.isStreaming === 1,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
          return Object.assign(
            message,
            row.attachments !== null ? { attachments: row.attachments } : {},
            row.correlation !== null ? { correlation: row.correlation } : {},
            row.origin !== null ? { origin: row.origin } : {},
            row.deliveryState !== null ? { deliveryState: row.deliveryState } : {},
          );
        }),
        proposedPlans: proposedPlanRows.map(mapProposedPlanRow),
        subagents: subagentRows.map(mapThreadSubagentRow),
        activities: activityRows.map((row) => {
          const activity = {
            id: row.activityId,
            tone: row.tone,
            kind: row.kind,
            summary: row.summary,
            payload: row.payload,
            turnId: row.turnId,
            createdAt: row.createdAt,
          };
          if (row.sequence !== null) {
            return Object.assign(activity, { sequence: row.sequence });
          }
          return activity;
        }),
        ...(omittedActivityCount > 0
          ? { activitiesTruncated: { omittedCount: omittedActivityCount } }
          : {}),
        checkpoints: checkpointRows.map((row) => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          status: row.status,
          files: row.files,
          assistantMessageId: row.assistantMessageId,
          completedAt: row.completedAt,
        })),
        session: Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null,
      };

      return Option.some(
        yield* decodeThread(thread).pipe(
          Effect.mapError(
            toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadDetailById:decodeThread"),
          ),
        ),
      );
    });

  // Opens no transaction, exactly as before: its statements each take and
  // release the connection permit on their own, and its decode never holds one.
  // `getThreadDetailSnapshot` needs a transaction and so builds its own from the
  // same two halves.
  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (threadId) =>
    fetchThreadDetailRows(threadId).pipe(Effect.flatMap(assembleThreadDetail));

  const getThreadDetailSnapshot: ProjectionSnapshotQueryShape["getThreadDetailSnapshot"] = (
    threadId,
  ) =>
    // Read the thread rows and the snapshot sequence within a single
    // transaction so the sequence is consistent with the returned state; a
    // projector update landing between two separate reads could otherwise return
    // a sequence ahead of the thread detail, causing the client to resume from
    // too far and drop events.
    //
    // Only the statements go inside. The transaction holds the one connection
    // permit for its whole duration, so decoding the rows in here would block
    // every writer for the decode too — and on a long thread the decode is a
    // third of the cost. `statement.all()` materialises every row before COMMIT,
    // so nothing the assembly reads depends on the transaction still being open.
    sql.withTransaction(Effect.all([fetchThreadDetailRows(threadId), getSnapshotSequence()])).pipe(
      Effect.flatMap(([rows, { snapshotSequence }]) =>
        assembleThreadDetail(rows).pipe(
          Effect.map(
            Option.map(
              (thread): OrchestrationThreadDetailSnapshot => ({ snapshotSequence, thread }),
            ),
          ),
        ),
      ),
      Effect.mapError((error) =>
        isPersistenceError(error)
          ? error
          : toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailSnapshot:transaction")(
              error,
            ),
      ),
    );

  const getSubagentActivities: ProjectionSnapshotQueryShape["getSubagentActivities"] = Effect.fn(
    "ProjectionSnapshotQuery.getSubagentActivities",
  )(function* (input) {
    const requestedLimit = Math.max(
      1,
      Math.min(input.limit ?? SUBAGENT_ACTIVITY_PAGE_LIMIT, SUBAGENT_ACTIVITY_PAGE_LIMIT),
    );
    const rawRows = yield* listSubagentActivityRawRows(
      { ...input, limit: requestedLimit },
      SUBAGENT_ACTIVITY_LIST,
    );
    const decodedRows = yield* decodeThreadActivityRows(rawRows, SUBAGENT_ACTIVITY_LIST);
    const hasMore = decodedRows.length > requestedLimit;
    const pageRows = decodedRows.slice(0, requestedLimit);
    const oldestRow = pageRows.at(-1);

    return {
      activities: pageRows.toReversed().map((row) => {
        const activity = {
          id: row.activityId,
          tone: row.tone,
          kind: row.kind,
          summary: row.summary,
          payload: row.payload,
          turnId: row.turnId,
          createdAt: row.createdAt,
        };
        return row.sequence === null
          ? activity
          : Object.assign(activity, { sequence: row.sequence });
      }),
      hasMore,
      nextBefore:
        hasMore && oldestRow !== undefined
          ? {
              sequence: oldestRow.sequence,
              createdAt: oldestRow.createdAt,
              activityId: oldestRow.activityId,
            }
          : null,
    };
  });

  return {
    getCommandReadModel,
    getSnapshot,
    getShellSnapshot,
    getArchivedShellSnapshot,
    getSnapshotSequence,
    getCounts,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getFirstActiveThreadIdByProjectId,
    listChildThreadIds,
    listThreadIdsWithQueuedMessages,
    getThreadCheckpointContext,
    getFullThreadDiffContext,
    getThreadShellById,
    getThreadSessionById,
    getThreadSubagentLiveness,
    getSubagentActivities,
    getThreadDetailById,
    getThreadDetailSnapshot,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);
