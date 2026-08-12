import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Struct from "effect/Struct";
import { ProviderOptionSelections } from "./model.ts";
import { RepositoryIdentity } from "./environment.ts";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ORCHESTRATION_WS_METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getSubagentActivities: "orchestration.getSubagentActivities",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  replayEvents: "orchestration.replayEvents",
  getArchivedShellSnapshot: "orchestration.getArchivedShellSnapshot",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
} as const;

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;
export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

/**
 * `ModelSelection` — selection of a model on a configured provider instance.
 *
 * The routing key is `instanceId` (a user-defined slug identifying one
 * configured provider instance). Drivers, credentials, working-directory
 * bindings, and any other per-instance state are recovered from the
 * runtime registry via the instance id.
 *
 * Wire legacy: persisted selections produced before the driver/instance
 * split carried a `provider: <driver-id>` field instead. The schema absorbs
 * that shape via a pre-decoding transform — `{provider, model}` is promoted
 * to `{instanceId: defaultInstanceIdForDriver(provider), model}`. No
 * post-decode compatibility code lives in the runtime; the transform is the
 * only compat surface.
 */
const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

// Source shape for persisted legacy payloads. Fields are typed as
// `Schema.Unknown` so malformed drafts still make it into the transform and
// fail validation through the target schema (with proper error messages)
// rather than at the source-struct layer where the error is less actionable.
const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
});

export const ModelSelection = ModelSelectionSource.pipe(
  Schema.decodeTo(
    ModelSelectionWire,
    SchemaTransformation.transformOrFail({
      decode: (raw) => {
        // Resolve the routing key: prefer an explicit `instanceId`; fall
        // back to promoting the legacy `provider` slug (the canonical
        // `defaultInstanceIdForDriver` mapping) so persisted rollout-era
        // payloads decode without data loss. The target schema brands the
        // string as `ProviderInstanceId`.
        const instanceIdSource =
          raw.instanceId !== undefined
            ? raw.instanceId
            : typeof raw.provider === "string"
              ? raw.provider
              : undefined;
        const base: Record<string, unknown> = {
          instanceId: instanceIdSource,
          model: raw.model,
        };
        if (raw.options !== undefined) base.options = raw.options;
        return Effect.succeed(base as typeof ModelSelectionWire.Encoded);
      },
      encode: (value) => {
        const base: Record<string, unknown> = {
          model: value.model,
          instanceId: value.instanceId,
        };
        if (value.options !== undefined) base.options = value.options;
        return Effect.succeed(base as typeof ModelSelectionSource.Encoded);
      },
    }),
  ),
);
export type ModelSelection = typeof ModelSelection.Type;

export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";
export const ProviderRequestKind = Schema.Literals(["command", "file-read", "file-change"]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PROVIDER_SEND_TURN_MAX_ATTACHMENT_DATA_URL_CHARS = 14_000_000;
const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(
    Schema.isMaxLength(100),
    Schema.isPattern(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i),
  ),
  sizeBytes: NonNegativeInt.check(
    Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES),
  ),
});
export type ChatFileAttachment = typeof ChatFileAttachment.Type;

const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

const UploadChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(
    Schema.isMaxLength(100),
    Schema.isPattern(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i),
  ),
  sizeBytes: NonNegativeInt.check(
    Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES),
  ),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENT_DATA_URL_CHARS),
  ),
});

export const ChatAttachment = Schema.Union([ChatImageAttachment, ChatFileAttachment]);
export type ChatAttachment = typeof ChatAttachment.Type;
const UploadChatAttachment = Schema.Union([UploadChatImageAttachment, UploadChatFileAttachment]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  /**
   * URL to open in the in-app browser preview when this script runs (or
   * when the user explicitly requests a preview). Optional; only honored on
   * the desktop build.
   */
  previewUrl: Schema.optional(TrimmedNonEmptyString),
  /**
   * When true, automatically open the preview panel pointed at `previewUrl`
   * the moment this script starts. Ignored without `previewUrl` or on web.
   */
  autoOpenPreview: Schema.optional(Schema.Boolean),
});
export type ProjectScript = typeof ProjectScript.Type;

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

/**
 * Who authored a message. A parent thread writing into a thread-backed
 * subagent's chat is `agent`; a person typing in the composer is `human`.
 * Absent means `human` — every message written before this field existed.
 */
export const OrchestrationMessageOrigin = Schema.Literals(["human", "agent"]);
export type OrchestrationMessageOrigin = typeof OrchestrationMessageOrigin.Type;

/**
 * The observed delivery state of a message, as opposed to the caller's intent
 * on the command (`delivery` on `thread.turn.start`). `queued` means the
 * message is waiting for the target thread's next turn boundary. Absent means
 * nothing is pending — a redelivery re-sends the same `messageId` with this
 * field omitted, and that omission is what clears the queued flag.
 */
export const OrchestrationMessageDeliveryState = Schema.Literals(["queued"]);
export type OrchestrationMessageDeliveryState = typeof OrchestrationMessageDeliveryState.Type;

/**
 * The caller's delivery intent on a turn-start command. Absent means
 * `immediate`, which is what every caller did before this field existed.
 */
export const ThreadTurnStartDelivery = Schema.Literals(["immediate", "turn-boundary"]);
export type ThreadTurnStartDelivery = typeof ThreadTurnStartDelivery.Type;

export const EpicPlanCorrelation = Schema.Struct({
  threadId: ThreadId,
  epicId: TrimmedNonEmptyString,
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
});
export type EpicPlanCorrelation = typeof EpicPlanCorrelation.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  correlation: Schema.optional(EpicPlanCorrelation),
  origin: Schema.optional(OrchestrationMessageOrigin),
  deliveryState: Schema.optional(OrchestrationMessageDeliveryState),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

/**
 * One thread-backed subagent's file-level share of a parent turn's diff.
 *
 * `spawn_agent` blocks inside the parent's turn and the parent's checkpoint is
 * captured at `turn.completed`, so the parent's turn diff always contains every
 * file its children wrote. The tree is a correct worktree snapshot; only the
 * attribution is wrong. These rows name the child that wrote each path so the
 * diff view can label it instead of claiming it for the parent.
 */
export const ThreadTurnDiffSubagentContribution = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  paths: Schema.Array(TrimmedNonEmptyString),
});
export type ThreadTurnDiffSubagentContribution = typeof ThreadTurnDiffSubagentContribution.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  // The same read-time attribution the turn diff carries, so the timeline's
  // changed-files tree can label a subagent's files without fetching a diff.
  // Defaulted so a newer client keeps decoding an older server's response.
  subagentContributions: Schema.Array(ThreadTurnDiffSubagentContribution).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

/**
 * Present when the server returned only part of a thread's activity history.
 *
 * The thread-detail read caps how many activities it returns, and there is no
 * pagination or cursor for activities anywhere. Without this marker the omission
 * is invisible: scrolling up a long thread shows messages whose tool rows
 * silently vanished. Absent means nothing was cut, so old servers and cached
 * snapshots decode unchanged.
 */
export const OrchestrationThreadActivityTruncation = Schema.Struct({
  /** How many of the thread's activities the server did not return. */
  omittedCount: NonNegativeInt,
});
export type OrchestrationThreadActivityTruncation =
  typeof OrchestrationThreadActivityTruncation.Type;

/**
 * How many of a thread's newest activities a client or the server keeps.
 *
 * Reading every activity of a chatty thread is the most expensive query on the
 * snapshot path, and it runs inside the transaction that holds the only SQL
 * connection permit, so it blocks every writer for its whole duration. One
 * measured thread held 39,732 rows and 123 MB of payload. The client applies
 * the same cap to live appends, so a warm client that resumed by sequence and
 * a cold client that fetched a snapshot show the same window of the thread.
 *
 * Activities of a kind in `THREAD_ACTIVITY_OPEN_REQUEST_KINDS` are kept on top
 * of this window, however old they are.
 */
export const THREAD_DETAIL_ACTIVITY_LIMIT = 500;

/** Maximum number of activities returned by one subagent transcript page. */
export const SUBAGENT_ACTIVITY_PAGE_LIMIT = 200;

export const OrchestrationSubagentActivityCursor = Schema.Struct({
  sequence: Schema.NullOr(NonNegativeInt),
  createdAt: IsoDateTime,
  activityId: EventId,
});
export type OrchestrationSubagentActivityCursor = typeof OrchestrationSubagentActivityCursor.Type;

export const OrchestrationGetSubagentActivitiesInput = Schema.Struct({
  threadId: ThreadId,
  subagentId: TrimmedNonEmptyString,
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SUBAGENT_ACTIVITY_PAGE_LIMIT })),
  ),
  before: Schema.optionalKey(OrchestrationSubagentActivityCursor),
});
export type OrchestrationGetSubagentActivitiesInput =
  typeof OrchestrationGetSubagentActivitiesInput.Type;

export const OrchestrationGetSubagentActivitiesResult = Schema.Struct({
  activities: Schema.Array(OrchestrationThreadActivity),
  hasMore: Schema.Boolean,
  nextBefore: Schema.NullOr(OrchestrationSubagentActivityCursor),
});
export type OrchestrationGetSubagentActivitiesResult =
  typeof OrchestrationGetSubagentActivitiesResult.Type;

/**
 * Activity kinds that a capped activity list must never drop.
 *
 * The sidebar badge comes from an independent SQL projection
 * (pending_approval_count / pending_user_input_count) while the chat prompt is
 * derived from the activity list. Drop an unresolved `approval.requested` and
 * the sidebar says "waiting for approval" while the chat shows no prompt to
 * answer — the agent stays blocked with no way out. The resolution and
 * stale-failure kinds are pinned for the mirror bug: keep a request without
 * its resolution and the prompt never goes away.
 */
export const THREAD_ACTIVITY_OPEN_REQUEST_KINDS = [
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
] as const;

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const OrchestrationThreadSubagentStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "stopped",
]);
export type OrchestrationThreadSubagentStatus = typeof OrchestrationThreadSubagentStatus.Type;

/**
 * One ad-hoc subagent (Agent/Task tool spawn) observed on a thread.
 *
 * Subagent data travels only inside `thread.activity-appended` events — the
 * activity kind is an open string and the payload is `Schema.Unknown`, so no
 * closed union changes and older clients keep decoding frames. This row is
 * the folded read-model view of those activities, keyed by `subagentId`.
 */
export const OrchestrationThreadSubagent = Schema.Struct({
  /** The provider `RuntimeTaskId` — the upsert key across projections. */
  subagentId: TrimmedNonEmptyString,
  turnId: Schema.NullOr(TurnId),
  /** Provider subagent type (e.g. `Explore`), when the provider reports one. */
  agentType: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  status: OrchestrationThreadSubagentStatus,
  lastProgressSummary: Schema.optional(TrimmedNonEmptyString),
  lastToolName: Schema.optional(TrimmedNonEmptyString),
  usage: Schema.optional(Schema.Unknown),
  /**
   * The spawning `collab_agent_tool_call` tool_use id. Providers report it
   * alongside task events (Claude: `tool_use_id`), letting the UI nest live
   * progress under the spawning tool row.
   */
  spawnedByItemId: Schema.optional(TrimmedNonEmptyString),
  /**
   * The child thread this subagent runs as, when it is thread-backed.
   * Absent for in-process Task subagents: they own no thread and no inbox.
   */
  childThreadId: Schema.optional(ThreadId),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationThreadSubagent = typeof OrchestrationThreadSubagent.Type;

/**
 * Typed views of the `task.*` activity payloads that ingestion builds.
 *
 * Ingestion (`ProviderRuntimeIngestion`) constructs these payloads untyped;
 * these schemas pin the shape so the fold below — and any other consumer —
 * decodes instead of casting. `toolUseId` and `subagentType` are absent from
 * payloads today; they are declared here so ingestion can start forwarding
 * them without another contract change.
 */
export const SubagentTaskStartedActivityPayload = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  taskType: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedNonEmptyString),
  subagentType: Schema.optional(TrimmedNonEmptyString),
  toolUseId: Schema.optional(TrimmedNonEmptyString),
});
export type SubagentTaskStartedActivityPayload = typeof SubagentTaskStartedActivityPayload.Type;

export const SubagentTaskProgressActivityPayload = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  summary: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedNonEmptyString),
  lastToolName: Schema.optional(TrimmedNonEmptyString),
  usage: Schema.optional(Schema.Unknown),
});
export type SubagentTaskProgressActivityPayload = typeof SubagentTaskProgressActivityPayload.Type;

export const SubagentTaskCompletedActivityPayload = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  status: Schema.Literals(["completed", "failed", "stopped"]),
  /**
   * Copied forward from the task's `task.started` by ingestion: the wire
   * completion event carries no task kind, and the fold below needs it to keep
   * a non-agent task out of the read model when its completion is the first
   * activity that reaches the fold.
   */
  taskType: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  summary: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedNonEmptyString),
  usage: Schema.optional(Schema.Unknown),
});
export type SubagentTaskCompletedActivityPayload = typeof SubagentTaskCompletedActivityPayload.Type;

/**
 * Task kinds that mean "a subagent is running".
 *
 * Providers report other background work over the same `task.*` events: the
 * Claude SDK sends `task_started` with `task_type: "local_bash"` for every
 * backgrounded Bash command, and `task_type: "local_workflow"` for a workflow
 * script. Folding those into the subagent read model listed shell jobs in the
 * roster as untyped "Subagent" rows and made the composer banner count
 * disagree with the popover.
 *
 * Allowlist, not denylist, so a task kind the SDK adds later stays out until
 * someone names it here. A task with no kind at all still counts: only Claude
 * sets one, and every other provider reports subagents without it.
 */
export const SUBAGENT_TASK_TYPES: ReadonlyArray<string> = ["local_agent"];

export const isSubagentTaskType = (taskType: string | undefined): boolean =>
  taskType === undefined || SUBAGENT_TASK_TYPES.includes(taskType);

export const SUBAGENT_STEER_REQUESTED_ACTIVITY_KIND = "subagent.steer.requested";
export const SUBAGENT_STEER_DELIVERED_ACTIVITY_KIND = "subagent.steer.delivered";
export const PROVIDER_SUBAGENT_STEER_FAILED_ACTIVITY_KIND = "provider.subagent.steer.failed";
export const SUBAGENT_STOP_REQUESTED_ACTIVITY_KIND = "subagent.stop.requested";
export const SUBAGENT_STOP_ESCALATED_ACTIVITY_KIND = "subagent.stop.escalated";
export const PROVIDER_SUBAGENT_STOP_FAILED_ACTIVITY_KIND = "provider.subagent.stop.failed";

export const SubagentSteerRequestedActivityPayload = Schema.Struct({
  subagentId: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  steerId: CommandId,
});
export type SubagentSteerRequestedActivityPayload =
  typeof SubagentSteerRequestedActivityPayload.Type;

export const SubagentSteerDeliveredActivityPayload = Schema.Struct({
  subagentId: TrimmedNonEmptyString,
  steerId: CommandId,
});
export type SubagentSteerDeliveredActivityPayload =
  typeof SubagentSteerDeliveredActivityPayload.Type;

export const SubagentSteerFailedActivityPayload = Schema.Struct({
  subagentId: TrimmedNonEmptyString,
  steerId: CommandId,
  detail: TrimmedNonEmptyString,
});
export type SubagentSteerFailedActivityPayload = typeof SubagentSteerFailedActivityPayload.Type;

export const SubagentStopRequestedActivityPayload = Schema.Struct({
  subagentId: TrimmedNonEmptyString,
  stopId: CommandId,
});
export type SubagentStopRequestedActivityPayload = typeof SubagentStopRequestedActivityPayload.Type;

export const SubagentStopEscalatedActivityPayload = Schema.Struct({
  subagentId: TrimmedNonEmptyString,
  stopId: CommandId,
});
export type SubagentStopEscalatedActivityPayload = typeof SubagentStopEscalatedActivityPayload.Type;

export const SubagentStopFailedActivityPayload = Schema.Struct({
  subagentId: TrimmedNonEmptyString,
  stopId: CommandId,
  detail: TrimmedNonEmptyString,
});
export type SubagentStopFailedActivityPayload = typeof SubagentStopFailedActivityPayload.Type;

/**
 * Marks a subagent as thread-backed: it runs as the named child thread, so a
 * client can open that thread and talk to it directly.
 *
 * A thread-backed spawner owns the whole subagent lifecycle and must emit, in
 * order: `task.started` with `taskId` set to the chosen `subagentId`, then
 * `subagent.child-thread.linked`, then `task.completed`. An MCP-spawned child
 * produces no provider `task.*` events, so nothing else emits them for it.
 */
export const SUBAGENT_CHILD_THREAD_LINKED_ACTIVITY_KIND = "subagent.child-thread.linked";

export const SubagentChildThreadLinkedActivityPayload = Schema.Struct({
  subagentId: TrimmedNonEmptyString,
  childThreadId: ThreadId,
});
export type SubagentChildThreadLinkedActivityPayload =
  typeof SubagentChildThreadLinkedActivityPayload.Type;

export const SUBAGENT_TEXT_ACTIVITY_KIND = "subagent.text";
export const SUBAGENT_THINKING_ACTIVITY_KIND = "subagent.thinking";

/**
 * Accumulated prose or thinking emitted by one subagent.
 *
 * Transcript activities key by `parentToolUseId`, while the subagent read
 * model keys by `subagentId`, sourced from the `task.started` payload's
 * `taskId`. Clients join the activity to a subagent when `parentToolUseId`
 * equals the `spawnedByItemId` carried from that payload.
 */
export const SubagentTranscriptActivityPayload = Schema.Struct({
  /** The spawning Task tool_use id; joins to `OrchestrationThreadSubagent.spawnedByItemId`. */
  parentToolUseId: TrimmedNonEmptyString,
  /** Accumulated block text (server truncates; see `truncated`). */
  text: TrimmedNonEmptyString,
  subagentType: Schema.optional(TrimmedNonEmptyString),
  /** True when the server cut the accumulated text at its cap. */
  truncated: Schema.optional(Schema.Boolean),
});
export type SubagentTranscriptActivityPayload = typeof SubagentTranscriptActivityPayload.Type;

const decodeSubagentTaskStartedPayload = Schema.decodeUnknownOption(
  SubagentTaskStartedActivityPayload,
);
const decodeSubagentTaskProgressPayload = Schema.decodeUnknownOption(
  SubagentTaskProgressActivityPayload,
);
const decodeSubagentTaskCompletedPayload = Schema.decodeUnknownOption(
  SubagentTaskCompletedActivityPayload,
);
export const decodeSubagentTranscriptActivityPayload = Schema.decodeUnknownOption(
  SubagentTranscriptActivityPayload,
);
const decodeSubagentChildThreadLinkedPayload = Schema.decodeUnknownOption(
  SubagentChildThreadLinkedActivityPayload,
);

const replaceSubagentAt = (
  subagents: ReadonlyArray<OrchestrationThreadSubagent>,
  index: number,
  next: OrchestrationThreadSubagent,
): ReadonlyArray<OrchestrationThreadSubagent> => {
  const copy = subagents.slice();
  copy[index] = next;
  return copy;
};

/**
 * Fold one thread activity into the subagent read model, upserting by
 * `subagentId`. The SQL projector, the in-memory projector, and the client
 * reducer all call this one function so their views cannot drift (precedent:
 * the build/parse pair in `epicRuns.ts`).
 *
 * Total and replay-safe: non-`task.*` kinds, non-subagent task kinds (see
 * `SUBAGENT_TASK_TYPES`) and undecodable payloads return
 * the input array unchanged (same reference), applying the same activity
 * twice is a no-op the second time, and a `task.progress` arriving after the
 * row settled (reconnect replay) is ignored rather than reviving the row.
 */
export const applySubagentActivity = (
  subagents: ReadonlyArray<OrchestrationThreadSubagent>,
  activity: OrchestrationThreadActivity,
): ReadonlyArray<OrchestrationThreadSubagent> => {
  switch (activity.kind) {
    case "task.started": {
      const decoded = decodeSubagentTaskStartedPayload(activity.payload);
      if (Option.isNone(decoded)) return subagents;
      const payload = decoded.value;
      if (!isSubagentTaskType(payload.taskType)) return subagents;
      const index = subagents.findIndex((entry) => entry.subagentId === payload.taskId);
      const existing = index === -1 ? undefined : subagents[index];
      if (existing === undefined) {
        return [
          ...subagents,
          {
            subagentId: payload.taskId,
            turnId: activity.turnId,
            ...(payload.subagentType !== undefined ? { agentType: payload.subagentType } : {}),
            ...(payload.detail !== undefined ? { description: payload.detail } : {}),
            status: "running",
            ...(payload.toolUseId !== undefined ? { spawnedByItemId: payload.toolUseId } : {}),
            startedAt: activity.createdAt,
            updatedAt: activity.createdAt,
            completedAt: null,
          },
        ];
      }
      // A row can pre-exist a replayed `task.started` (duplicate delivery, or
      // a `task.progress` that arrived first). Fill start metadata without
      // downgrading a settled status or rolling `updatedAt` back.
      return replaceSubagentAt(subagents, index, {
        ...existing,
        turnId: existing.turnId ?? activity.turnId,
        ...(existing.agentType === undefined && payload.subagentType !== undefined
          ? { agentType: payload.subagentType }
          : {}),
        ...(existing.description === undefined && payload.detail !== undefined
          ? { description: payload.detail }
          : {}),
        ...(existing.spawnedByItemId === undefined && payload.toolUseId !== undefined
          ? { spawnedByItemId: payload.toolUseId }
          : {}),
        startedAt: activity.createdAt,
      });
    }

    case "task.progress": {
      const decoded = decodeSubagentTaskProgressPayload(activity.payload);
      if (Option.isNone(decoded)) return subagents;
      const payload = decoded.value;
      const progressSummary = payload.title ?? payload.summary ?? payload.detail;
      const index = subagents.findIndex((entry) => entry.subagentId === payload.taskId);
      const existing = index === -1 ? undefined : subagents[index];
      if (existing === undefined) {
        return [
          ...subagents,
          {
            subagentId: payload.taskId,
            turnId: activity.turnId,
            status: "running",
            ...(progressSummary !== undefined ? { lastProgressSummary: progressSummary } : {}),
            ...(payload.lastToolName !== undefined ? { lastToolName: payload.lastToolName } : {}),
            ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
            startedAt: activity.createdAt,
            updatedAt: activity.createdAt,
            completedAt: null,
          },
        ];
      }
      // Progress after settlement is replay noise; reviving the row would
      // flip a completed card back to running on reconnect.
      if (existing.status !== "running") return subagents;
      return replaceSubagentAt(subagents, index, {
        ...existing,
        ...(progressSummary !== undefined ? { lastProgressSummary: progressSummary } : {}),
        ...(payload.lastToolName !== undefined ? { lastToolName: payload.lastToolName } : {}),
        ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
        updatedAt: activity.createdAt,
      });
    }

    case "task.completed": {
      const decoded = decodeSubagentTaskCompletedPayload(activity.payload);
      if (Option.isNone(decoded)) return subagents;
      const payload = decoded.value;
      const finalSummary = payload.summary ?? payload.detail;
      const index = subagents.findIndex((entry) => entry.subagentId === payload.taskId);
      const existing = index === -1 ? undefined : subagents[index];
      if (existing === undefined) {
        // A backgrounded Bash command settles with its own `task.completed`,
        // and its `task.started` never opened a row. Creating one here would
        // put the finished shell job in the roster after the fact.
        if (!isSubagentTaskType(payload.taskType)) return subagents;
        return [
          ...subagents,
          {
            subagentId: payload.taskId,
            turnId: activity.turnId,
            ...(payload.title !== undefined ? { description: payload.title } : {}),
            status: payload.status,
            ...(finalSummary !== undefined ? { lastProgressSummary: finalSummary } : {}),
            ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
            startedAt: activity.createdAt,
            updatedAt: activity.createdAt,
            completedAt: activity.createdAt,
          },
        ];
      }
      return replaceSubagentAt(subagents, index, {
        ...existing,
        ...(existing.description === undefined && payload.title !== undefined
          ? { description: payload.title }
          : {}),
        status: payload.status,
        ...(finalSummary !== undefined ? { lastProgressSummary: finalSummary } : {}),
        ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
        updatedAt: activity.createdAt,
        completedAt: activity.createdAt,
      });
    }

    case SUBAGENT_CHILD_THREAD_LINKED_ACTIVITY_KIND: {
      const decoded = decodeSubagentChildThreadLinkedPayload(activity.payload);
      if (Option.isNone(decoded)) return subagents;
      const payload = decoded.value;
      const index = subagents.findIndex((entry) => entry.subagentId === payload.subagentId);
      const existing = index === -1 ? undefined : subagents[index];
      // Creating the row when it is absent makes the link order-independent,
      // mirroring `task.progress` above. `updatedAt` never rolls on a link:
      // `RUNNING_SUBAGENT_FRESHNESS_MS` consumers read it, and a replayed
      // link must not refresh a stale row's freshness.
      if (existing === undefined) {
        return [
          ...subagents,
          {
            subagentId: payload.subagentId,
            turnId: activity.turnId,
            status: "running",
            childThreadId: payload.childThreadId,
            startedAt: activity.createdAt,
            updatedAt: activity.createdAt,
            completedAt: null,
          },
        ];
      }
      if (existing.childThreadId === payload.childThreadId) return subagents;
      return replaceSubagentAt(subagents, index, {
        ...existing,
        childThreadId: payload.childThreadId,
      });
    }

    default:
      return subagents;
  }
};

/**
 * How recently a `running` subagent row must have been touched to count as
 * live work. Rows only leave `running` via `task.completed`/`task.progress`
 * activities or a terminal session status (`closeRunningSubagentsForSession`),
 * so a row stranded by a crashed server would otherwise block its consumers
 * forever. The freshness bound lets consumers trust the read model.
 *
 * Shared by every consumer of running-subagent state so "still working" has
 * one meaning across the server and clients.
 *
 * The bound trades against long tool calls. `task.progress` arrives at
 * tool-call cadence, so one quiet call longer than this window reads as stale.
 */
export const RUNNING_SUBAGENT_FRESHNESS_MS = 15 * 60 * 1_000;
export const SUBAGENT_STOP_ESCALATION_GRACE_MS = 30_000;

/** Whether a subagent is running and has server-observed activity in the freshness window. */
export const isFreshRunningSubagent = (
  subagent: Pick<OrchestrationThreadSubagent, "status" | "updatedAt">,
  nowMs: number,
): boolean => {
  if (subagent.status !== "running") return false;
  const updatedAtMs = Date.parse(subagent.updatedAt);
  return !Number.isNaN(updatedAtMs) && nowMs - updatedAtMs <= RUNNING_SUBAGENT_FRESHNESS_MS;
};

export const countFreshRunningSubagents = (
  subagents: ReadonlyArray<Pick<OrchestrationThreadSubagent, "status" | "updatedAt">>,
  nowMs: number,
): number => subagents.filter((subagent) => isFreshRunningSubagent(subagent, nowMs)).length;

/**
 * The terminal subagent status a session status forces, or `null` when the
 * session status says nothing about subagent liveness.
 *
 * Only `stopped` and `error` close rows: a dead session can no longer emit
 * the `task.completed` that would settle them. `idle`/`ready` must leave
 * running rows untouched — the incident class has the main stream falsely
 * idle while a subagent still works, and that running row is exactly the
 * signal the settle/reap guards consume.
 */
export const subagentCloseStatusForSessionStatus = (
  status: OrchestrationSessionStatus,
): Extract<OrchestrationThreadSubagentStatus, "failed" | "stopped"> | null => {
  switch (status) {
    case "error":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return null;
  }
};

/**
 * Fold one `thread.session-set` into the subagent read model: a terminal
 * session status orphans any still-running rows, so close them at the
 * session timestamp. Total and replay-safe like `applySubagentActivity` —
 * non-terminal statuses and already-settled rows return the input array
 * unchanged (same reference), and the SQL projector, the in-memory
 * projector, and the client reducer all share this one fold so their views
 * cannot drift.
 */
export const closeRunningSubagentsForSession = (
  subagents: ReadonlyArray<OrchestrationThreadSubagent>,
  session: Pick<OrchestrationSession, "status" | "updatedAt">,
): ReadonlyArray<OrchestrationThreadSubagent> => {
  const closeStatus = subagentCloseStatusForSessionStatus(session.status);
  if (closeStatus === null) return subagents;
  if (!subagents.some((entry) => entry.status === "running")) return subagents;
  return subagents.map((entry) =>
    entry.status === "running"
      ? {
          ...entry,
          status: closeStatus,
          updatedAt: session.updatedAt,
          completedAt: session.updatedAt,
        }
      : entry,
  );
};

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  deletedAt: Schema.NullOr(IsoDateTime),
  /** The thread that spawned this one as a thread-backed subagent, if any. */
  parentThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  subagents: Schema.Array(OrchestrationThreadSubagent).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  activities: Schema.Array(OrchestrationThreadActivity),
  activitiesTruncated: Schema.optional(OrchestrationThreadActivityTruncation),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const OrchestrationProjectShell = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProjectShell = typeof OrchestrationProjectShell.Type;

export const OrchestrationThreadShell = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  session: Schema.NullOr(OrchestrationSession),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  activeSubagentCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** The thread that spawned this one as a thread-backed subagent, if any. */
  parentThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  threads: Schema.Array(OrchestrationThreadShell),
  updatedAt: IsoDateTime,
});
export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type;

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
]);
export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type;

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationShellSnapshot,
  }),
  OrchestrationShellStreamEvent,
]);
export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type;

export const OrchestrationSubscribeShellInput = Schema.Struct({
  /**
   * When provided, the server skips the initial full shell snapshot and instead
   * replays shell events after this sequence before streaming live events.
   * Clients that already hold a cached (or HTTP-loaded) shell snapshot pass its
   * sequence here so the subscription resumes without re-sending the entire
   * projects/threads list (overlapping events are deduped by sequence on the
   * client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationSubscribeShellInput = typeof OrchestrationSubscribeShellInput.Type;

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * When provided, the server skips the initial snapshot frame and instead
   * replays events after this sequence before streaming live events. Clients
   * that load the snapshot over HTTP pass the snapshot's sequence here so the
   * live subscription resumes without a gap (overlapping events are deduped by
   * sequence on the client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
});
export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type;

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  force: Schema.optional(Schema.Boolean),
});

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  /** Set only when spawning a thread-backed subagent under an existing thread. */
  parentThreadId: Schema.optionalKey(ThreadId),
  createdAt: IsoDateTime,
});

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.settle"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnsettleCommand = Schema.Struct({
  type: Schema.Literal("thread.unsettle"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity un-settles are decided server-side
  // (the decider emits thread.unsettled(reason: "activity") events directly,
  // never through this command), so a client cannot forge the neutral reset.
  reason: Schema.Literal("user"),
});

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  expectedBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  projectCwd: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

const ThreadTurnStartBootstrap = Schema.Struct({
  createThread: Schema.optional(ThreadTurnStartBootstrapCreateThread),
  prepareWorktree: Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
  runSetupScript: Schema.optional(Schema.Boolean),
});

export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrap.Type;

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment).check(
      Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
    ),
  }),
  // `origin` describes who wrote the message; `delivery` is the caller's
  // intent for when it reaches the thread. Absent `delivery` means immediate.
  origin: Schema.optional(OrchestrationMessageOrigin),
  delivery: Schema.optional(ThreadTurnStartDelivery),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(UploadChatAttachment).check(
      Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
    ),
  }),
  origin: Schema.optional(OrchestrationMessageOrigin),
  delivery: Schema.optional(ThreadTurnStartDelivery),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadSubagentSteerCommand = Schema.Struct({
  type: Schema.Literal("thread.subagent.steer"),
  commandId: CommandId,
  threadId: ThreadId,
  subagentId: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const ThreadSubagentStopCommand = Schema.Struct({
  type: Schema.Literal("thread.subagent.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  subagentId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const OptionalThreadSessionStopReason = Schema.optionalKey(
  TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
);

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  preserveRunningSubagents: Schema.optionalKey(Schema.Literal(true)),
  reason: OptionalThreadSessionStopReason,
});

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadSubagentSteerCommand,
  ThreadSubagentStopCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadSubagentSteerCommand,
  ThreadSubagentStopCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  plannedEpicId: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  // Attribution the capture path already knows, so a live client labels a
  // child's files without waiting for the next thread read. Optional: the
  // placeholder dispatch in ProviderRuntimeIngestion has nothing to attribute.
  subagentContributions: Schema.optional(Schema.Array(ThreadTurnDiffSubagentContribution)),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const InternalOrchestrationCommand = Schema.Union([
  ThreadSessionSetCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadRevertCompleteCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.settled",
  "thread.unsettled",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals(["project", "thread"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  /** Absent from events persisted before the parent/child link shipped. */
  parentThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadSettledPayload = Schema.Struct({
  threadId: ThreadId,
  settledAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsettledPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: IsoDateTime,
});

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  correlation: Schema.optional(EpicPlanCorrelation),
  origin: Schema.optional(OrchestrationMessageOrigin),
  deliveryState: Schema.optional(OrchestrationMessageDeliveryState),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
  reason: OptionalThreadSessionStopReason,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  // What the capture path could attribute at capture time. A child checkpoint
  // that had not landed yet is missing here, never wrong, so the read-time
  // answer in `getThreadDetailById` stays the authority and only ever adds to
  // this. Defaulted so an event stored before this field decodes.
  subagentContributions: Schema.Array(ThreadTurnDiffSubagentContribution).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.settled"),
    payload: ThreadSettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsettled"),
    payload: ThreadUnsettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
]);
export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue(Option.some(input.fromTurnCount), {
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
    // Defaulted so a newer client keeps decoding an older server's response.
    subagentContributions: Schema.Array(ThreadTurnDiffSubagentContribution).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
  }),
  { unsafePreserveChecks: true },
);

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationReplayEventsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
});
export type OrchestrationReplayEventsInput = typeof OrchestrationReplayEventsInput.Type;

const OrchestrationReplayEventsResult = Schema.Array(OrchestrationEvent);
export type OrchestrationReplayEventsResult = typeof OrchestrationReplayEventsResult.Type;

export const OrchestrationRpcSchemas = {
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getSubagentActivities: {
    input: OrchestrationGetSubagentActivitiesInput,
    output: OrchestrationGetSubagentActivitiesResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  replayEvents: {
    input: OrchestrationReplayEventsInput,
    output: OrchestrationReplayEventsResult,
  },
  getArchivedShellSnapshot: {
    input: Schema.Struct({}),
    output: OrchestrationShellSnapshot,
  },
  subscribeThread: {
    input: OrchestrationSubscribeThreadInput,
    output: OrchestrationThreadStreamItem,
  },
  subscribeShell: {
    input: OrchestrationSubscribeShellInput,
    output: OrchestrationShellStreamItem,
  },
} as const;

export class OrchestrationGetSnapshotError extends Schema.TaggedErrorClass<OrchestrationGetSnapshotError>()(
  "OrchestrationGetSnapshotError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationDispatchCommandError extends Schema.TaggedErrorClass<OrchestrationDispatchCommandError>()(
  "OrchestrationDispatchCommandError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetTurnDiffError extends Schema.TaggedErrorClass<OrchestrationGetTurnDiffError>()(
  "OrchestrationGetTurnDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetSubagentActivitiesError extends Schema.TaggedErrorClass<OrchestrationGetSubagentActivitiesError>()(
  "OrchestrationGetSubagentActivitiesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetFullThreadDiffError extends Schema.TaggedErrorClass<OrchestrationGetFullThreadDiffError>()(
  "OrchestrationGetFullThreadDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationReplayEventsError extends Schema.TaggedErrorClass<OrchestrationReplayEventsError>()(
  "OrchestrationReplayEventsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
