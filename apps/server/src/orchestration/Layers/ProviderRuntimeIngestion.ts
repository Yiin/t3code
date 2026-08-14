import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  isToolLifecycleItemType,
  SUBAGENT_TEXT_ACTIVITY_KIND,
  SUBAGENT_THINKING_ACTIVITY_KIND,
  type RuntimeItemId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
  DEFAULT_EPIC_RUN_CONFIG,
  parseEpicRunIterationThreadId,
  PROVIDER_ACCOUNT_ROTATION_REFUSED_ACTIVITY_KIND,
  PROVIDER_ACCOUNT_ROTATED_ACTIVITY_KIND,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { type DrainableWorker, makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { parseTerminalEpicPlanMarker } from "@t3tools/shared/epicPlanMarker";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderAccountLimitsStore } from "../../persistence/Services/ProviderAccountLimits.ts";
import { ProviderUsageLedgerStore } from "../../persistence/Services/ProviderUsageLedger.ts";
import {
  accountRotationRefusedSummary,
  accountRotationSummary,
  buildExhaustedAccountBlocklist,
  classifyAccountRotationReason,
  resolveAccountRotationTarget,
} from "../providerAccountRotation.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerTaskKey = (threadId: ThreadId, taskId: string) => `${threadId}:${taskId}`;
const toolUpdateThrottleKey = (threadId: ThreadId, itemId: RuntimeItemId) =>
  `${threadId}:${itemId}`;
const transcriptParentKey = (threadId: ThreadId, parentToolUseId: string) =>
  `${threadId}:${parentToolUseId}`;

type SubagentTranscriptStreamKind = "assistant_text" | "reasoning_text";

const transcriptKey = (
  threadId: ThreadId,
  parentToolUseId: string,
  streamKind: SubagentTranscriptStreamKind,
  segment: number,
) => `${threadId}:${parentToolUseId}:${streamKind}:${segment}`;

interface SubagentTranscriptState {
  readonly threadId: ThreadId;
  readonly parentToolUseId: string;
  readonly streamKind: SubagentTranscriptStreamKind;
  readonly segment: number;
  readonly text: string;
  readonly truncated: boolean;
}

interface PendingTranscriptActivity {
  readonly event: ProviderRuntimeEvent;
  readonly activity: OrchestrationThreadActivity;
  readonly state: SubagentTranscriptState;
}

// A coalesced-but-not-yet-dispatched tool.updated activity, held for at most
// TOOL_UPDATE_THROTTLE_WINDOW_MILLIS before the trailing-edge flush fires.
interface PendingToolUpdate {
  readonly threadId: ThreadId;
  readonly event: ProviderRuntimeEvent;
  readonly activity: OrchestrationThreadActivity;
}

// Value shape of the per-task metadata cache below (keyed by providerTaskKey).
interface RememberedTaskMetadata {
  readonly description?: string | undefined;
  readonly subagentType?: string | undefined;
  readonly taskType?: string | undefined;
}

// Task metadata that arrives on task.started/task.progress but not on the
// later task.completed/task.updated events, resolved by the dispatch site and
// threaded into runtimeEventToActivities so those activities stay labeled.
export interface TaskActivityMetadata {
  readonly title?: string | undefined;
  readonly subagentType?: string | undefined;
  // The task kind from task.started. `applySubagentActivity` reads it off the
  // completion payload to keep a non-agent task (a backgrounded Bash command)
  // out of the subagent read model when its completion is the first activity
  // the fold sees.
  readonly taskType?: string | undefined;
}

// Fallback when the in-memory metadata cache no longer has the task name or
// subagent type (server restart, session-exit sweep, TTL/capacity eviction):
// earlier task.started/task.progress activities for the task are persisted
// with them.
function findTaskMetadataInActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
  taskId: string,
): TaskActivityMetadata {
  if (!activities) {
    return {};
  }
  let title: string | undefined;
  let subagentType: string | undefined;
  let taskType: string | undefined;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || (activity.kind !== "task.started" && activity.kind !== "task.progress")) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as {
            taskId?: unknown;
            title?: unknown;
            detail?: unknown;
            subagentType?: unknown;
            taskType?: unknown;
          })
        : undefined;
    if (payload?.taskId !== taskId) {
      continue;
    }
    if (title === undefined) {
      const candidate =
        typeof payload.title === "string"
          ? payload.title
          : activity.kind === "task.started" && typeof payload.detail === "string"
            ? payload.detail
            : undefined;
      if (candidate && candidate.trim().length > 0) {
        title = candidate;
      }
    }
    if (subagentType === undefined && typeof payload.subagentType === "string") {
      subagentType = payload.subagentType;
    }
    if (taskType === undefined && typeof payload.taskType === "string") {
      taskType = payload.taskType;
    }
    if (title !== undefined && subagentType !== undefined && taskType !== undefined) {
      break;
    }
  }
  return {
    ...(title !== undefined ? { title } : {}),
    ...(subagentType !== undefined ? { subagentType } : {}),
    ...(taskType !== undefined ? { taskType } : {}),
  };
}

interface AssistantSegmentState {
  baseKey: string;
  nextSegmentIndex: number;
  activeMessageId: MessageId | null;
}

const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY = 10_000;
const TASK_DESCRIPTION_BY_TASK_TTL = Duration.minutes(120);
// Leading-edge throttle window for streamed item.updated -> tool.updated
// activity dispatches, keyed by (threadId, itemId). The first update after a
// quiet period dispatches immediately; further updates inside the window are
// coalesced into a single pending value and flushed by a trailing-edge timer
// (see dispatchOrCoalesceToolUpdate) so a fast stream never issues more than
// one thread.activity.append command per window per tool call.
const TOOL_UPDATE_THROTTLE_WINDOW_MILLIS = 150;
const PENDING_TOOL_UPDATE_CACHE_CAPACITY = 10_000;
const PENDING_TOOL_UPDATE_TTL = Duration.minutes(120);
const LAST_TOOL_UPDATE_DISPATCH_CACHE_CAPACITY = 10_000;
const LAST_TOOL_UPDATE_DISPATCH_TTL = Duration.minutes(120);
const MAX_SUBAGENT_TRANSCRIPT_CHARS = 4_000;
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    }
  | {
      // Synthetic input: the trailing-edge timer forked from
      // dispatchOrCoalesceToolUpdate enqueues this instead of dispatching
      // directly, so the flush is serialized with the same queue that
      // processes runtime/domain events and never races them over the
      // pending/last-dispatch throttle caches.
      source: "tool-update-flush";
      key: string;
    }
  | {
      // Synthetic input for the subagent transcript trailing-edge timer. It
      // shares the worker queue with runtime events to serialize cache access.
      source: "transcript-flush";
      key: string;
    };

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.make(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.make(value);
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function hasAssistantMessageForTurn(
  messages: ReadonlyArray<OrchestrationMessage>,
  turnId: TurnId,
  options?: { readonly streamingOnly?: boolean },
): boolean {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role !== "assistant" || message.turnId !== turnId) {
      continue;
    }
    if (options?.streamingOnly === true && !message.streaming) {
      continue;
    }
    return true;
  }
  return false;
}

function findMessageById(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: MessageId,
): OrchestrationMessage | undefined {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.id === messageId) {
      return message;
    }
  }
  return undefined;
}

function findProposedPlanById(
  proposedPlans: ReadonlyArray<
    Pick<OrchestrationProposedPlan, "id" | "createdAt" | "implementedAt" | "implementationThreadId">
  >,
  planId: string,
):
  | Pick<OrchestrationProposedPlan, "id" | "createdAt" | "implementedAt" | "implementationThreadId">
  | undefined {
  for (let index = 0; index < proposedPlans.length; index += 1) {
    const proposedPlan = proposedPlans[index];
    if (proposedPlan?.id === planId) {
      return proposedPlan;
    }
  }
  return undefined;
}

function hasCheckpointForTurn(
  checkpoints: ReadonlyArray<Pick<OrchestrationCheckpointSummary, "turnId">>,
  turnId: TurnId,
): boolean {
  for (let index = 0; index < checkpoints.length; index += 1) {
    if (checkpoints[index]?.turnId === turnId) {
      return true;
    }
  }
  return false;
}

function maxCheckpointTurnCount(
  checkpoints: ReadonlyArray<Pick<OrchestrationCheckpointSummary, "checkpointTurnCount">>,
): number {
  let maxTurnCount = 0;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint && checkpoint.checkpointTurnCount > maxTurnCount) {
      maxTurnCount = checkpoint.checkpointTurnCount;
    }
  }
  return maxTurnCount;
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function normalizeProposedPlanMarkdown(planMarkdown: string | undefined): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function hasRenderableAssistantText(text: string | undefined): boolean {
  return (text?.trim().length ?? 0) > 0;
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

function assistantSegmentBaseKeyFromEvent(event: ProviderRuntimeEvent): string {
  return String(event.itemId ?? event.turnId ?? event.eventId);
}

function assistantSegmentMessageId(baseKey: string, segmentIndex: number): MessageId {
  return MessageId.make(
    segmentIndex === 0 ? `assistant:${baseKey}` : `assistant:${baseKey}:segment:${segmentIndex}`,
  );
}
function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens <= 0) {
    return undefined;
  }
  return event.payload.usage;
}

function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

function sessionStatusAllowsActiveTurn(
  status: ReturnType<typeof orchestrationSessionStatusFromRuntimeState>,
): boolean {
  return status === "starting" || status === "running";
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return undefined;
  }
}

export function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
  taskContext?: TaskActivityMetadata,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(event.payload.message),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.denied": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "tool.denied",
          summary: `Tool denied: ${event.payload.toolName}`,
          payload: {
            toolName: event.payload.toolName,
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.reason ? { detail: truncateDetail(event.payload.reason) } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          // Use the adapter-supplied message as the row label so the work log
          // shows what the warning was about, not a generic "Runtime warning".
          summary: truncateDetail(event.payload.message, 120),
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...(event.payload.subagentType ? { subagentType: event.payload.subagentType } : {}),
            // toolUseId is the wire correlation id (the spawning
            // collab_agent_tool_call's Task tool_use id); spawnedByItemId is
            // the same value under its read-model name
            // (OrchestrationThreadSubagent.spawnedByItemId) so payload
            // consumers need no join logic.
            ...(event.payload.toolUseId
              ? { toolUseId: event.payload.toolUseId, spawnedByItemId: event.payload.toolUseId }
              : {}),
            ...(event.payload.prompt ? { prompt: truncateDetail(event.payload.prompt, 2000) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      // A chatty subagent emits hundreds of task.progress events per run. Key
      // the activity by (threadId, taskId) instead of the per-event eventId so
      // the projection upserts one row in place, mirroring the tool.updated
      // coalescing in the "item.updated" case below (same rationale for the
      // kind-specific prefix: task.started/task.completed keep their own ids,
      // and a shared key would upsert-overwrite them on the activity_id
      // primary key). Unlike item.updated there is no dispatch throttle on
      // top: task.progress arrives at tool-call cadence (roughly one event
      // per subagent tool use), not at streaming-delta cadence, so one
      // dispatch per event stays cheap once the row count is fixed.
      return [
        {
          id: EventId.make(`task-progress:${event.threadId}:${event.payload.taskId}`),
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary:
            event.payload.description.trim().length > 0
              ? truncateDetail(event.payload.description, 120)
              : "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.description.trim().length > 0
              ? { title: truncateDetail(event.payload.description, 120) }
              : {}),
            detail: truncateDetail(event.payload.summary ?? event.payload.description),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.subagentType ? { subagentType: event.payload.subagentType } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.updated": {
      const patch = event.payload.patch;
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: patch.status === "failed" ? "error" : "info",
          kind: "task.updated",
          summary:
            patch.isBackgrounded === true
              ? "Task moved to background"
              : patch.isBackgrounded === false
                ? "Task moved to foreground"
                : patch.status
                  ? `Task ${patch.status}`
                  : "Task updated",
          payload: {
            taskId: event.payload.taskId,
            ...(patch.status ? { status: patch.status } : {}),
            ...(patch.description
              ? { title: truncateDetail(patch.description, 120) }
              : taskContext?.title
                ? { title: truncateDetail(taskContext.title, 120) }
                : {}),
            ...(patch.isBackgrounded !== undefined ? { isBackgrounded: patch.isBackgrounded } : {}),
            ...(patch.error ? { error: truncateDetail(patch.error) } : {}),
            ...(taskContext?.subagentType ? { subagentType: taskContext.subagentType } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(taskContext?.title ? { title: truncateDetail(taskContext.title, 120) } : {}),
            ...(taskContext?.subagentType ? { subagentType: taskContext.subagentType } : {}),
            // Carried forward from task.started so `applySubagentActivity` can
            // tell a settled subagent from a settled background Bash command.
            ...(taskContext?.taskType ? { taskType: taskContext.taskType } : {}),
            // summary + detail mirror task.progress: clients label the row from
            // summary and keep detail for the preview/expanded body.
            ...(event.payload.summary
              ? {
                  summary: truncateDetail(event.payload.summary),
                  detail: truncateDetail(event.payload.summary),
                }
              : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.outputFile ? { outputFile: event.payload.outputFile } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.progress": {
      // Long-running tools emit periodic heartbeats. Key the activity by the
      // owning task (or the tool call itself for top-level tools) so repeated
      // heartbeats upsert one row instead of appending one per beat -- the
      // same stable-id pattern as the "item.updated" case below. Fall back to
      // eventId when the event carries neither id; nothing coalesces there.
      const heartbeatKey = event.payload.taskId ?? event.payload.toolUseId;
      return [
        {
          id:
            heartbeatKey !== undefined
              ? EventId.make(`tool-progress:${event.threadId}:${heartbeatKey}`)
              : event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.progress",
          summary: event.payload.summary
            ? truncateDetail(event.payload.summary, 120)
            : event.payload.toolName
              ? `${event.payload.toolName} running`
              : "Tool running",
          payload: {
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.toolName ? { toolName: event.payload.toolName } : {}),
            ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.elapsedSeconds !== undefined
              ? { elapsedSeconds: event.payload.elapsedSeconds }
              : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
            ...(event.payload.taskId ? { taskId: event.payload.taskId } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary: "Context compacted",
          payload: {
            state: event.payload.state,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      // Streamed argument/output chunks for the same tool call arrive as many
      // item.updated events. Key the row by the tool-call item (scoped to the
      // thread, since itemId is only unique within a provider session, not
      // globally -- activity_id is a single global primary key) instead of
      // the per-delta eventId, so the upsert replaces the row in place rather
      // than inserting a new one per chunk. Fall back to eventId when the
      // provider didn't send an itemId; there is nothing to coalesce there,
      // so each such event still gets its own (already-unique) row. Keep the
      // "tool-updated:" prefix: item.started/item.completed stay keyed by
      // eventId, and a shared itemId-only key across the three kinds would
      // make them upsert-overwrite each other on the same primary key.
      return [
        {
          id:
            event.itemId !== undefined
              ? EventId.make(`tool-updated:${event.threadId}:${event.itemId}`)
              : event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            // parentToolUseId marks tool calls that ran inside a subagent (it
            // is the spawning Task tool_use id), letting the UI nest the row
            // under that task.
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
            ...(event.payload.subagentType ? { subagentType: event.payload.subagentType } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
            ...(event.payload.subagentType ? { subagentType: event.payload.subagentType } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
            ...(event.payload.subagentType ? { subagentType: event.payload.subagentType } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverSettingsService = yield* ServerSettingsService;
  // Optional seams for account rotation on usage-limit failures. Absent in
  // minimal harnesses (most tests); rotation simply stays off then.
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  const providerAccountLimits = yield* Effect.serviceOption(ProviderAccountLimitsStore);
  const providerUsageLedger = yield* Effect.serviceOption(ProviderUsageLedgerStore);
  // Assigned once, near the bottom of this generator, once processInputSafely
  // exists. dispatchOrCoalesceToolUpdate below only reads it from inside a
  // forked, sleeping fiber -- by the time that fiber wakes, start() has
  // already run and this is always assigned.
  let worker: DrainableWorker<RuntimeIngestionInput>;
  const providerCommandId = (event: ProviderRuntimeEvent, tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`provider:${event.eventId}:${tag}:${uuid}`)),
    );

  // A provider can emit both runtime.error and turn.completed for one failed
  // turn. Remember that turn, not the account, so a later turn can rotate if
  // the user selected the account again after its limit reset.
  const handledRotationTurns = yield* Cache.make<string, boolean>({
    capacity: 4096,
    timeToLive: Duration.minutes(30),
    lookup: () => Effect.succeed(false),
  });

  const maybeRotateAccountOnProviderLimit = Effect.fn("maybeRotateAccountOnProviderLimit")(
    function* (input: {
      readonly thread: OrchestrationThreadShell;
      readonly event: ProviderRuntimeEvent;
      readonly message: string;
    }) {
      const { thread, event } = input;
      const failingInstanceId = event.providerInstanceId;
      if (failingInstanceId === undefined) return;
      // Epic iteration threads rotate through the runner's own selection
      // between iterations; a thread-level rebind would fight the run row.
      if (parseEpicRunIterationThreadId(thread.id) !== null) return;
      // Only rotate the account the thread is actually bound to. A mismatch
      // means the thread already rebound (this turn or by the user).
      if (thread.modelSelection.instanceId !== failingInstanceId) return;
      const reason = classifyAccountRotationReason(input.message);
      if (reason === null) return;
      if (Option.isNone(providerRegistry)) return;
      const turnKey = `${thread.id}:${event.turnId ?? event.eventId}:${failingInstanceId}`;
      if (yield* Cache.get(handledRotationTurns, turnKey)) return;

      const providers = yield* providerRegistry.value.getProviders;
      const now = event.createdAt;
      const limits = Option.isNone(providerAccountLimits)
        ? []
        : yield* providerAccountLimits.value.listAll.pipe(Effect.orElseSucceed(() => []));
      const samples = Option.isNone(providerUsageLedger)
        ? []
        : yield* providerUsageLedger.value.listAll.pipe(Effect.orElseSucceed(() => []));
      const blocked = new Set(
        buildExhaustedAccountBlocklist({
          limits,
          samples,
          now,
          degradationTtlMs: DEFAULT_EPIC_RUN_CONFIG.server.providerDegradationTtlMs,
        }),
      );
      const failingInfo = yield* providerService.getInstanceInfo(failingInstanceId);
      let refusedTarget: ReturnType<typeof resolveAccountRotationTarget> = null;
      let target = resolveAccountRotationTarget({
        providers,
        current: thread.modelSelection,
        failingInstanceId,
        blocked,
      });
      while (target !== null) {
        const targetInfo = yield* providerService.getInstanceInfo(target.instanceId);
        if (
          targetInfo.continuationIdentity.driverKind ===
            failingInfo.continuationIdentity.driverKind &&
          targetInfo.continuationIdentity.continuationKey ===
            failingInfo.continuationIdentity.continuationKey
        ) {
          break;
        }
        refusedTarget ??= target;
        blocked.add(target.instanceId);
        target = resolveAccountRotationTarget({
          providers,
          current: thread.modelSelection,
          failingInstanceId,
          blocked,
        });
      }

      const labelOf = (instanceId: typeof failingInstanceId) => {
        const snapshot = providers.find((provider) => provider.instanceId === instanceId);
        return snapshot?.displayName ?? String(instanceId);
      };
      if (target === null) {
        if (refusedTarget !== null) {
          yield* Cache.set(handledRotationTurns, turnKey, true);
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: yield* providerCommandId(event, "account-rotation-refused"),
            threadId: thread.id,
            activity: {
              id: EventId.make(`${event.eventId}:account-rotation-refused`),
              tone: "info",
              kind: PROVIDER_ACCOUNT_ROTATION_REFUSED_ACTIVITY_KIND,
              summary: accountRotationRefusedSummary({
                fromLabel: labelOf(failingInstanceId),
                toLabel: labelOf(refusedTarget.instanceId),
                reason,
              }),
              payload: {
                fromInstanceId: failingInstanceId,
                toInstanceId: refusedTarget.instanceId,
                reason,
                refusal: "continuation-group-mismatch",
              },
              turnId: toTurnId(event.turnId) ?? null,
              createdAt: now,
            },
            createdAt: now,
          });
        }
        // The original error remains the thread's lastError.
        return;
      }

      yield* Cache.set(handledRotationTurns, turnKey, true);

      // Do not rebind if the old session cannot stop. The outer fail-soft
      // wrapper preserves ingestion of the original provider error.
      yield* providerService.stopSession({ threadId: thread.id });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* providerCommandId(event, "account-rotation-rebind"),
        threadId: thread.id,
        modelSelection: target,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* providerCommandId(event, "account-rotation-activity"),
        threadId: thread.id,
        activity: {
          id: EventId.make(`${event.eventId}:account-rotation`),
          tone: "info",
          kind: PROVIDER_ACCOUNT_ROTATED_ACTIVITY_KIND,
          summary: accountRotationSummary({
            fromLabel: labelOf(failingInstanceId),
            toLabel: labelOf(target.instanceId),
            reason,
            fromModel: thread.modelSelection.model,
            toModel: target.model,
          }),
          payload: {
            fromInstanceId: failingInstanceId,
            toInstanceId: target.instanceId,
            model: target.model,
            reason,
          },
          turnId: toTurnId(event.turnId) ?? null,
          createdAt: now,
        },
        createdAt: now,
      });
      yield* Effect.logInfo("provider account rotated after usage-limit failure", {
        threadId: thread.id,
        fromInstanceId: failingInstanceId,
        toInstanceId: target.instanceId,
        reason,
      });
    },
  );

  // Never let a rotation attempt break ingestion of the event that carried
  // the failure. The user must still see the original error.
  const tryRotateAccountOnProviderLimit = (input: {
    readonly thread: OrchestrationThreadShell;
    readonly event: ProviderRuntimeEvent;
    readonly message: string;
  }) =>
    maybeRotateAccountOnProviderLimit(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider account rotation failed", {
          threadId: input.thread.id,
          eventId: input.event.eventId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });

  const assistantSegmentStateByTurnKey = yield* Cache.make<string, AssistantSegmentState>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () =>
      Effect.die(
        new Error("assistant segment state should be read through getOption before initialization"),
      ),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  // Task names and subagent types arrive on task.started/task.progress but
  // not on task.completed/task.updated, so remember them per task to label
  // the later activities.
  const taskMetadataByTaskKey = yield* Cache.make<string, RememberedTaskMetadata>({
    capacity: TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY,
    timeToLive: TASK_DESCRIPTION_BY_TASK_TTL,
    lookup: () => Effect.succeed({}),
  });

  // content.delta identifies a subagent by its spawning Task tool_use id, not
  // by taskId. Keep the subagent type under that wire join key as well.
  const subagentTypeByTranscriptParentKey = yield* Cache.make<string, string>({
    capacity: TASK_DESCRIPTION_BY_TASK_CACHE_CAPACITY,
    timeToLive: TASK_DESCRIPTION_BY_TASK_TTL,
    lookup: () =>
      Effect.die(new Error("subagent type must be read through getOption before initialization")),
  });

  // Merges with the remembered entry: a later event that carries only one of
  // the fields (e.g. a task.progress without subagentType) must not wipe the
  // other one remembered from task.started.
  const rememberTaskMetadata = (
    threadId: ThreadId,
    taskId: string,
    metadata: RememberedTaskMetadata,
  ) =>
    Cache.getOption(taskMetadataByTaskKey, providerTaskKey(threadId, taskId)).pipe(
      Effect.flatMap((existing) => {
        const current = Option.getOrUndefined(existing);
        return Cache.set(taskMetadataByTaskKey, providerTaskKey(threadId, taskId), {
          ...((metadata.description ?? current?.description)
            ? { description: metadata.description ?? current?.description }
            : {}),
          ...((metadata.subagentType ?? current?.subagentType)
            ? { subagentType: metadata.subagentType ?? current?.subagentType }
            : {}),
          ...((metadata.taskType ?? current?.taskType)
            ? { taskType: metadata.taskType ?? current?.taskType }
            : {}),
        });
      }),
    );

  // Coalesced item.updated -> tool.updated activity awaiting dispatch, keyed
  // by toolUpdateThrottleKey(threadId, itemId). Entries live for at most one
  // throttle window in the normal case: the trailing-edge fiber forked from
  // dispatchOrCoalesceToolUpdate flushes (and invalidates) them unconditionally,
  // so TTL/capacity eviction here is a backstop, not the flush mechanism.
  const pendingToolUpdateByThrottleKey = yield* Cache.make<string, PendingToolUpdate>({
    capacity: PENDING_TOOL_UPDATE_CACHE_CAPACITY,
    timeToLive: PENDING_TOOL_UPDATE_TTL,
    lookup: () => Effect.die(new Error("pending tool update must be set before it is looked up")),
  });

  // Epoch millis (via Clock, never Date.now()) of the last dispatched
  // tool.updated for a throttle key; 0 means "never", which always clears the
  // throttle window so the first update for a key dispatches immediately.
  const lastToolUpdateDispatchAtByThrottleKey = yield* Cache.make<string, number>({
    capacity: LAST_TOOL_UPDATE_DISPATCH_CACHE_CAPACITY,
    timeToLive: LAST_TOOL_UPDATE_DISPATCH_TTL,
    lookup: () => Effect.succeed(0),
  });

  const dispatchToolUpdateActivity = (pending: PendingToolUpdate) =>
    providerCommandId(pending.event, "thread-activity-append-tool-updated").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: pending.threadId,
          activity: pending.activity,
          createdAt: pending.activity.createdAt,
        }),
      ),
    );

  // Dispatches whatever is currently pending for this key, if anything, and
  // clears it. Safe to call redundantly (from the trailing-edge timer, from a
  // terminal-event accelerator, or from the session-exit sweep): a no-op once
  // the pending entry has already been flushed once.
  const flushPendingToolUpdate = (key: string) =>
    Cache.getOption(pendingToolUpdateByThrottleKey, key).pipe(
      Effect.flatMap((pendingOption) =>
        Option.match(pendingOption, {
          onNone: () => Effect.void,
          onSome: (pending) =>
            Cache.invalidate(pendingToolUpdateByThrottleKey, key).pipe(
              Effect.andThen(Clock.currentTimeMillis),
              Effect.tap((dispatchedAt) =>
                Cache.set(lastToolUpdateDispatchAtByThrottleKey, key, dispatchedAt),
              ),
              Effect.andThen(dispatchToolUpdateActivity(pending)),
            ),
        }),
      ),
    );

  // Best-effort accelerator for terminal events that are thread- or
  // turn-scoped rather than item-scoped (turn.completed, turn.aborted,
  // session.exited, runtime.error): flush every item still pending for this
  // thread instead of waiting out the throttle window. This is purely a
  // latency improvement -- the trailing-edge timer in
  // dispatchOrCoalesceToolUpdate is what guarantees a pending update is never
  // stranded, including on paths this sweep cannot see (e.g. a failure
  // earlier in processRuntimeEvent for some other event on this thread).
  const flushPendingToolUpdatesForThread = (threadId: ThreadId) =>
    Cache.entries(pendingToolUpdateByThrottleKey).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(
          Array.from(entries).filter(([, pending]) => pending.threadId === threadId),
          ([key]) => flushPendingToolUpdate(key),
          { concurrency: 1 },
        ),
      ),
      Effect.asVoid,
    );

  // Leading-edge throttle + trailing-edge guarantee for item.updated ->
  // tool.updated dispatches. See TOOL_UPDATE_THROTTLE_WINDOW_MILLIS.
  //
  // - First update for a key after a quiet period: dispatch immediately.
  // - Update inside the window: overwrite the pending value for this key and,
  //   only if nothing was already pending (i.e. no flush is already
  //   scheduled), fork a timer that flushes whatever is pending once the
  //   window elapses. Because the timer re-reads the pending cache at fire
  //   time rather than closing over a specific activity, later updates in the
  //   same burst are picked up for free without scheduling a second timer.
  // - The forked timer enqueues onto the same DrainableWorker queue that
  //   processRuntimeEvent runs on (via a synthetic "tool-update-flush" input)
  //   instead of dispatching directly, so it never races the main
  //   processing loop over the pending/last-dispatch caches.
  //
  // One path does not flush: on layer-scope teardown (server shutdown) the
  // forked timers are interrupted and anything still pending is dropped. The
  // last dispatched detail survives in the projection, and the process is
  // exiting, so this is accepted rather than worked around.
  const dispatchOrCoalesceToolUpdate = (
    threadId: ThreadId,
    itemId: RuntimeItemId,
    event: ProviderRuntimeEvent,
    activity: OrchestrationThreadActivity,
  ) =>
    Effect.gen(function* () {
      const key = toolUpdateThrottleKey(threadId, itemId);
      const now = yield* Clock.currentTimeMillis;
      const lastDispatchedAt = yield* Cache.get(lastToolUpdateDispatchAtByThrottleKey, key);
      const elapsed = now - lastDispatchedAt;

      if (elapsed >= TOOL_UPDATE_THROTTLE_WINDOW_MILLIS) {
        // Drop anything still pending for this key: this activity is a newer
        // snapshot of the same tool call, so the pending one is stale. Without
        // this, a timer whose flush enqueue lands after this dispatch would
        // re-dispatch the older activity, and the projector's last-write-wins
        // on activity id would leave the row permanently showing stale detail.
        yield* Cache.invalidate(pendingToolUpdateByThrottleKey, key);
        yield* Cache.set(lastToolUpdateDispatchAtByThrottleKey, key, now);
        yield* dispatchToolUpdateActivity({ threadId, event, activity });
        return;
      }

      const hadPendingBeforeSet = yield* Cache.has(pendingToolUpdateByThrottleKey, key);
      yield* Cache.set(pendingToolUpdateByThrottleKey, key, { threadId, event, activity });
      if (hadPendingBeforeSet) {
        return;
      }

      const remaining = Math.max(TOOL_UPDATE_THROTTLE_WINDOW_MILLIS - elapsed, 0);
      yield* Effect.forkScoped(
        Effect.sleep(Duration.millis(remaining)).pipe(
          Effect.andThen(() => worker.enqueue({ source: "tool-update-flush", key })),
          Effect.asVoid,
        ),
      );
    });

  const transcriptSegmentByParentKey = yield* Cache.make<string, number>({
    capacity: PENDING_TOOL_UPDATE_CACHE_CAPACITY,
    timeToLive: PENDING_TOOL_UPDATE_TTL,
    lookup: () => Effect.succeed(0),
  });

  const transcriptStateByKey = yield* Cache.make<string, SubagentTranscriptState>({
    capacity: PENDING_TOOL_UPDATE_CACHE_CAPACITY,
    timeToLive: PENDING_TOOL_UPDATE_TTL,
    lookup: () =>
      Effect.die(
        new Error("transcript state must be read through getOption before initialization"),
      ),
  });

  const pendingTranscriptActivityByKey = yield* Cache.make<string, PendingTranscriptActivity>({
    capacity: PENDING_TOOL_UPDATE_CACHE_CAPACITY,
    timeToLive: PENDING_TOOL_UPDATE_TTL,
    lookup: () =>
      Effect.die(new Error("pending transcript activity must be set before it is looked up")),
  });

  const lastTranscriptDispatchAtByKey = yield* Cache.make<string, number>({
    capacity: LAST_TOOL_UPDATE_DISPATCH_CACHE_CAPACITY,
    timeToLive: LAST_TOOL_UPDATE_DISPATCH_TTL,
    lookup: () => Effect.succeed(0),
  });

  const dispatchTranscriptActivity = (pending: PendingTranscriptActivity) =>
    providerCommandId(pending.event, "thread-activity-append-subagent-transcript").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: pending.state.threadId,
          activity: pending.activity,
          createdAt: pending.activity.createdAt,
        }),
      ),
    );

  const flushPendingTranscriptActivity = (key: string) =>
    Cache.getOption(pendingTranscriptActivityByKey, key).pipe(
      Effect.flatMap((pendingOption) =>
        Option.match(pendingOption, {
          onNone: () => Effect.void,
          onSome: (pending) =>
            Cache.invalidate(pendingTranscriptActivityByKey, key).pipe(
              Effect.andThen(Clock.currentTimeMillis),
              Effect.tap((dispatchedAt) =>
                Cache.set(lastTranscriptDispatchAtByKey, key, dispatchedAt),
              ),
              Effect.andThen(dispatchTranscriptActivity(pending)),
            ),
        }),
      ),
    );

  const flushPendingTranscriptActivities = (
    predicate: (pending: PendingTranscriptActivity) => boolean,
  ) =>
    Cache.entries(pendingTranscriptActivityByKey).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(
          Array.from(entries).filter(([, pending]) => predicate(pending)),
          ([key]) => flushPendingTranscriptActivity(key),
          { concurrency: 1 },
        ),
      ),
      Effect.asVoid,
    );

  const flushPendingTranscriptActivitiesForThread = (threadId: ThreadId) =>
    flushPendingTranscriptActivities((pending) => pending.state.threadId === threadId);

  const flushPendingTranscriptActivitiesForParent = (threadId: ThreadId, parentToolUseId: string) =>
    flushPendingTranscriptActivities(
      (pending) =>
        pending.state.threadId === threadId && pending.state.parentToolUseId === parentToolUseId,
    );

  const rotateTranscriptSegment = (threadId: ThreadId, parentToolUseId: string) => {
    const parentKey = transcriptParentKey(threadId, parentToolUseId);
    return Cache.get(transcriptSegmentByParentKey, parentKey).pipe(
      Effect.flatMap((segment) => Cache.set(transcriptSegmentByParentKey, parentKey, segment + 1)),
    );
  };

  const dispatchOrCoalesceTranscriptActivity = (key: string, pending: PendingTranscriptActivity) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const lastDispatchedAt = yield* Cache.get(lastTranscriptDispatchAtByKey, key);
      const elapsed = now - lastDispatchedAt;

      if (elapsed >= TOOL_UPDATE_THROTTLE_WINDOW_MILLIS) {
        yield* Cache.invalidate(pendingTranscriptActivityByKey, key);
        yield* Cache.set(lastTranscriptDispatchAtByKey, key, now);
        yield* dispatchTranscriptActivity(pending);
        return;
      }

      const hadPendingBeforeSet = yield* Cache.has(pendingTranscriptActivityByKey, key);
      yield* Cache.set(pendingTranscriptActivityByKey, key, pending);
      if (hadPendingBeforeSet) {
        return;
      }

      const remaining = Math.max(TOOL_UPDATE_THROTTLE_WINDOW_MILLIS - elapsed, 0);
      yield* Effect.forkScoped(
        Effect.sleep(Duration.millis(remaining)).pipe(
          Effect.andThen(() => worker.enqueue({ source: "transcript-flush", key })),
          Effect.asVoid,
        ),
      );
    });

  const ingestSubagentTranscriptDelta = (
    event: Extract<ProviderRuntimeEvent, { type: "content.delta" }>,
  ) =>
    Effect.gen(function* () {
      const parentToolUseId = event.payload.parentToolUseId;
      const streamKind = event.payload.streamKind;
      const delta = event.payload.delta;
      if (
        parentToolUseId === undefined ||
        (streamKind !== "assistant_text" && streamKind !== "reasoning_text") ||
        delta.length === 0
      ) {
        return;
      }

      const parentKey = transcriptParentKey(event.threadId, parentToolUseId);
      const segment = yield* Cache.get(transcriptSegmentByParentKey, parentKey);
      const key = transcriptKey(event.threadId, parentToolUseId, streamKind, segment);
      const previousOption = yield* Cache.getOption(transcriptStateByKey, key);
      const previous = Option.getOrUndefined(previousOption);
      const previousText = previous?.text ?? "";
      const combinedLength = previousText.length + delta.length;
      const text = previous?.truncated
        ? previousText
        : `${previousText}${delta}`.slice(0, MAX_SUBAGENT_TRANSCRIPT_CHARS);
      const state: SubagentTranscriptState = {
        threadId: event.threadId,
        parentToolUseId,
        streamKind,
        segment,
        text,
        truncated: previous?.truncated === true || combinedLength > MAX_SUBAGENT_TRANSCRIPT_CHARS,
      };
      yield* Cache.set(transcriptStateByKey, key, state);

      // The shared payload schema rejects whitespace-only text. Keep such
      // chunks buffered so a later visible token still includes them.
      if (text.trim().length === 0) {
        return;
      }

      const subagentType = yield* Cache.getOption(
        subagentTypeByTranscriptParentKey,
        parentKey,
      ).pipe(Effect.map(Option.getOrUndefined));
      const kind =
        streamKind === "assistant_text"
          ? SUBAGENT_TEXT_ACTIVITY_KIND
          : SUBAGENT_THINKING_ACTIVITY_KIND;
      const idPrefix = streamKind === "assistant_text" ? "subagent-text" : "subagent-thinking";
      const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
      const activity: OrchestrationThreadActivity = {
        id: EventId.make(`${idPrefix}:${event.threadId}:${parentToolUseId}:${segment}`),
        createdAt: event.createdAt,
        tone: "info",
        kind,
        summary: truncateDetail(text, 120),
        payload: {
          parentToolUseId,
          text,
          ...(state.truncated ? { truncated: true } : {}),
          ...(subagentType ? { subagentType } : {}),
        },
        turnId: toTurnId(event.turnId) ?? null,
        ...(eventWithSequence.sessionSequence !== undefined
          ? { sequence: eventWithSequence.sessionSequence }
          : {}),
      };

      // Claude normally emits one complete block, but can defensively emit
      // token-cadence deltas too. Stable ids and this throttle coalesce both;
      // deduplicating a provider that sends both forms is intentionally out of
      // scope because the wire events carry no safe identity for that join.
      yield* dispatchOrCoalesceTranscriptActivity(key, { event, activity, state });
    });

  // Entries are left in place after completion so replayed or duplicate
  // terminal events stay titled; TTL, capacity, and the session-exit sweep
  // bound the cache.
  const lookupTaskMetadata = (threadId: ThreadId, taskId: string) =>
    Cache.getOption(taskMetadataByTaskKey, providerTaskKey(threadId, taskId)).pipe(
      Effect.map(Option.getOrUndefined),
    );

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadShell = Effect.fn("resolveThreadShell")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const getAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const setAssistantSegmentStateForTurn = (
    threadId: ThreadId,
    turnId: TurnId,
    state: AssistantSegmentState,
  ) => Cache.set(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId), state);

  const clearAssistantSegmentStateForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(assistantSegmentStateByTurnKey, providerTurnKey(threadId, turnId));

  const getActiveAssistantMessageIdForTurn = (threadId: ThreadId, turnId: TurnId) =>
    getAssistantSegmentStateForTurn(threadId, turnId).pipe(
      Effect.map((state) =>
        Option.flatMap(state, (entry) =>
          entry.activeMessageId ? Option.some(entry.activeMessageId) : Option.none(),
        ),
      ),
    );

  const startAssistantSegmentForTurn = (input: {
    threadId: ThreadId;
    turnId: TurnId;
    baseKey: string;
  }) =>
    getAssistantSegmentStateForTurn(input.threadId, input.turnId).pipe(
      Effect.flatMap((existingState) =>
        Effect.gen(function* () {
          const nextState = Option.match(existingState, {
            onNone: () => ({
              baseKey: input.baseKey,
              nextSegmentIndex: 1,
              activeMessageId: assistantSegmentMessageId(input.baseKey, 0),
            }),
            onSome: (state) => {
              const segmentIndex = state.baseKey === input.baseKey ? state.nextSegmentIndex : 0;
              const messageId = assistantSegmentMessageId(input.baseKey, segmentIndex);
              return {
                baseKey: input.baseKey,
                nextSegmentIndex: state.baseKey === input.baseKey ? state.nextSegmentIndex + 1 : 1,
                activeMessageId: messageId,
              } satisfies AssistantSegmentState;
            },
          });
          yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, nextState);
          return nextState.activeMessageId!;
        }),
      ),
    );

  const getOrCreateAssistantMessageId = (input: {
    threadId: ThreadId;
    event: ProviderRuntimeEvent;
    turnId?: TurnId;
  }) =>
    Effect.gen(function* () {
      if (!input.turnId) {
        return assistantSegmentMessageId(assistantSegmentBaseKeyFromEvent(input.event), 0);
      }

      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isSome(activeMessageId)) {
        return activeMessageId.value;
      }

      return yield* startAssistantSegmentForTurn({
        threadId: input.threadId,
        turnId: input.turnId,
        baseKey: assistantSegmentBaseKeyFromEvent(input.event),
      });
    });

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Effect.gen(function* () {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId);

  const flushBufferedAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      if (!hasRenderableAssistantText(bufferedText)) {
        return false;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: yield* providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: bufferedText,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
      return true;
    });

  const flushBufferedAssistantMessagesForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
  }) =>
    Effect.gen(function* () {
      const assistantMessageIds = yield* getAssistantMessageIdsForTurn(
        input.threadId,
        input.turnId,
      );
      const flushedMessageIds = new Set<MessageId>();
      yield* Effect.forEach(
        assistantMessageIds,
        (messageId) =>
          flushBufferedAssistantMessage({
            event: input.event,
            threadId: input.threadId,
            messageId,
            turnId: input.turnId,
            createdAt: input.createdAt,
            commandTag: input.commandTag,
          }).pipe(
            Effect.tap((flushed) =>
              flushed ? Effect.sync(() => flushedMessageIds.add(messageId)) : Effect.void,
            ),
          ),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      return flushedMessageIds;
    });

  const finalizeAssistantMessage = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
    hasProjectedMessage?: boolean;
  }) =>
    Effect.gen(function* () {
      const bufferedText = yield* takeBufferedAssistantText(input.messageId);
      const text =
        bufferedText.length > 0
          ? bufferedText
          : (input.fallbackText?.trim().length ?? 0) > 0
            ? input.fallbackText!
            : "";
      const hasRenderableText = hasRenderableAssistantText(text);
      const projectedThread = yield* resolveThreadDetail(input.threadId);
      const projectedText =
        projectedThread?.messages.find((message) => message.id === input.messageId)?.text ?? "";
      const marker = parseTerminalEpicPlanMarker(`${projectedText}${text}`);

      if (hasRenderableText) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: yield* providerCommandId(input.event, input.finalDeltaCommandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          delta: text,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt: input.createdAt,
        });
      }

      if (input.hasProjectedMessage || hasRenderableText) {
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: yield* providerCommandId(input.event, input.commandTag),
          threadId: input.threadId,
          messageId: input.messageId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(marker ? { plannedEpicId: marker.epicId } : {}),
          createdAt: input.createdAt,
        });
      }
      yield* clearAssistantMessageState(input.messageId);
    });

  const finalizeActiveAssistantSegmentForTurn = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    hasProjectedMessage: boolean;
    flushedMessageIds?: ReadonlySet<MessageId>;
  }) =>
    Effect.gen(function* () {
      const activeMessageId = yield* getActiveAssistantMessageIdForTurn(
        input.threadId,
        input.turnId,
      );
      if (Option.isNone(activeMessageId)) {
        return;
      }

      yield* finalizeAssistantMessage({
        event: input.event,
        threadId: input.threadId,
        messageId: activeMessageId.value,
        turnId: input.turnId,
        createdAt: input.createdAt,
        commandTag: input.commandTag,
        finalDeltaCommandTag: input.finalDeltaCommandTag,
        hasProjectedMessage:
          input.hasProjectedMessage ||
          (input.flushedMessageIds?.has(activeMessageId.value) ?? false),
      });
      yield* forgetAssistantMessageId(input.threadId, input.turnId, activeMessageId.value);

      const state = yield* getAssistantSegmentStateForTurn(input.threadId, input.turnId);
      if (Option.isSome(state)) {
        yield* setAssistantSegmentStateForTurn(input.threadId, input.turnId, {
          ...state.value,
          activeMessageId: null,
        });
      }
    });

  const upsertProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
      if (!planMarkdown) {
        return;
      }

      const existingPlan = findProposedPlanById(input.threadProposedPlans, input.planId);
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: yield* providerCommandId(input.event, "proposed-plan-upsert"),
        threadId: input.threadId,
        proposedPlan: {
          id: input.planId,
          turnId: input.turnId ?? null,
          planMarkdown,
          implementedAt: existingPlan?.implementedAt ?? null,
          implementationThreadId: existingPlan?.implementationThreadId ?? null,
          createdAt: existingPlan?.createdAt ?? input.createdAt,
          updatedAt: input.updatedAt,
        },
        createdAt: input.updatedAt,
      });
    });

  const finalizeBufferedProposedPlan = (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) =>
    Effect.gen(function* () {
      const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
      const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
      const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
      const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
      if (!planMarkdown) {
        return;
      }

      yield* upsertProposedPlan({
        event: input.event,
        threadId: input.threadId,
        threadProposedPlans: input.threadProposedPlans,
        planId: input.planId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        planMarkdown,
        createdAt:
          bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
            ? bufferedPlan.createdAt
            : input.updatedAt,
        updatedAt: input.updatedAt,
      });
      yield* clearBufferedProposedPlan(input.planId);
    });

  const clearTurnStateForSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const prefix = `${threadId}:`;
      const proposedPlanPrefix = `plan:${threadId}:`;
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      const assistantSegmentKeys = Array.from(yield* Cache.keys(assistantSegmentStateByTurnKey));
      const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
      const taskMetadataKeys = Array.from(yield* Cache.keys(taskMetadataByTaskKey));
      const transcriptParentKeys = Array.from(yield* Cache.keys(transcriptSegmentByParentKey));
      const transcriptStateKeys = Array.from(yield* Cache.keys(transcriptStateByKey));
      const transcriptTypeKeys = Array.from(yield* Cache.keys(subagentTypeByTranscriptParentKey));
      const transcriptDispatchKeys = Array.from(yield* Cache.keys(lastTranscriptDispatchAtByKey));
      // Nothing should be left pending here: the processRuntimeEvent
      // accelerator flushes every pending tool.updated for this thread (via
      // flushPendingToolUpdatesForThread) before this function runs. Only the
      // last-dispatch bookkeeping needs sweeping.
      const toolUpdateDispatchKeys = Array.from(
        yield* Cache.keys(lastToolUpdateDispatchAtByThrottleKey),
      );
      yield* Effect.forEach(
        turnKeys,
        (key) =>
          Effect.gen(function* () {
            if (!key.startsWith(prefix)) {
              return;
            }

            const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
            if (Option.isSome(messageIds)) {
              yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
                concurrency: 1,
              }).pipe(Effect.asVoid);
            }

            yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
          }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        assistantSegmentKeys,
        (key) =>
          key.startsWith(prefix)
            ? Cache.invalidate(assistantSegmentStateByTurnKey, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        proposedPlanKeys,
        (key) =>
          key.startsWith(proposedPlanPrefix)
            ? Cache.invalidate(bufferedProposedPlanById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        taskMetadataKeys,
        (key) =>
          key.startsWith(prefix) ? Cache.invalidate(taskMetadataByTaskKey, key) : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        toolUpdateDispatchKeys,
        (key) =>
          key.startsWith(prefix)
            ? Cache.invalidate(lastToolUpdateDispatchAtByThrottleKey, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        transcriptParentKeys,
        (key) =>
          key.startsWith(prefix)
            ? Cache.invalidate(transcriptSegmentByParentKey, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        transcriptStateKeys,
        (key) =>
          key.startsWith(prefix) ? Cache.invalidate(transcriptStateByKey, key) : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        transcriptTypeKeys,
        (key) =>
          key.startsWith(prefix)
            ? Cache.invalidate(subagentTypeByTranscriptParentKey, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        transcriptDispatchKeys,
        (key) =>
          key.startsWith(prefix)
            ? Cache.invalidate(lastTranscriptDispatchAtByKey, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForPendingTurnStart",
  )(function* (threadId: ThreadId) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fn("getExpectedProviderTurnIdForThread")(
    function* (threadId: ThreadId) {
      const sessions = yield* providerService.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      return session?.activeTurnId;
    },
  );

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForAcceptedTurnStart",
  )(function* (threadId: ThreadId, eventTurnId: TurnId | undefined) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fn("markSourceProposedPlanImplemented")(
    function* (
      sourceThreadId: ThreadId,
      sourcePlanId: OrchestrationProposedPlanId,
      implementationThreadId: ThreadId,
      implementedAt: string,
    ) {
      const sourceThread = yield* resolveThreadDetail(sourceThreadId);
      const sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
      if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
        return;
      }

      const commandUuid = yield* crypto.randomUUIDv4;
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.make(
          `provider:source-proposed-plan-implemented:${implementationThreadId}:${commandUuid}`,
        ),
        threadId: sourceThread.id,
        proposedPlan: {
          ...sourcePlan,
          implementedAt,
          implementationThreadId,
          updatedAt: implementedAt,
        },
        createdAt: implementedAt,
      });
    },
  );

  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const thread = yield* resolveThreadShell(event.threadId);
      if (!thread) return;

      // Best-effort accelerator: flush any pending (throttled) tool.updated
      // activity for this item/thread at a natural stopping point, instead of
      // waiting out the throttle window. Placed first, before any of the
      // per-event work below that can fail, so a later failure in this
      // function can never suppress it. It is deliberately *not* the source
      // of correctness: dispatchOrCoalesceToolUpdate's trailing-edge timer
      // flushes unconditionally, including turn.aborted/session-exit/error
      // paths this switch also covers, and any path it doesn't (e.g. this
      // event itself throwing before reaching here).
      switch (event.type) {
        case "item.started":
          if (event.payload.parentToolUseId !== undefined) {
            // Flush the prior prose/thinking segment before tool.started gets
            // its sequence, then rotate so later text lands after the tool.
            yield* flushPendingTranscriptActivitiesForParent(
              thread.id,
              event.payload.parentToolUseId,
            );
            yield* rotateTranscriptSegment(thread.id, event.payload.parentToolUseId);
          }
          break;
        case "item.completed":
          if (event.itemId !== undefined) {
            yield* flushPendingToolUpdate(toolUpdateThrottleKey(thread.id, event.itemId));
          }
          break;
        case "task.completed":
          if (event.payload.toolUseId !== undefined) {
            yield* flushPendingTranscriptActivitiesForParent(thread.id, event.payload.toolUseId);
          }
          break;
        case "turn.completed":
        case "turn.aborted":
        case "session.exited":
        case "runtime.error":
          yield* flushPendingToolUpdatesForThread(thread.id);
          yield* flushPendingTranscriptActivitiesForThread(thread.id);
          break;
        default:
          break;
      }

      let loadedThreadDetail: OrchestrationThread | null | undefined;
      const getLoadedThreadDetail = () =>
        Effect.gen(function* () {
          if (loadedThreadDetail !== undefined) {
            return loadedThreadDetail;
          }
          loadedThreadDetail = (yield* resolveThreadDetail(thread.id)) ?? null;
          return loadedThreadDetail;
        });

      const now = event.createdAt;
      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;
      const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
        threadId: thread.id,
      });
      const hasPendingTurnStart =
        Option.isSome(pendingTurnStart) && thread.session?.status === "starting";

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

      // A turn.started that conflicts with the active turn is legitimate when
      // the server itself has a turn start pending for this thread AND the
      // provider session already tracks the event's turn as its active turn:
      // steering a running turn makes some providers (e.g. opencode) open a
      // new turn without ever completing the superseded one. A stale
      // turn.started for some other turn id still gets rejected.
      const conflictingTurnStartIsPendingTurnStart =
        event.type === "turn.started" && conflictsWithActiveTurn
          ? sameId(yield* getExpectedProviderTurnIdForThread(thread.id), eventTurnId) &&
            Option.isSome(pendingTurnStart)
          : false;

      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return true;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return !conflictsWithActiveTurn || conflictingTurnStartIsPendingTurnStart;
          case "turn.completed":
            if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // If no active turn is tracked, accept completion scoped to this thread.
            return true;
          default:
            return true;
        }
      })();
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed"
      ) {
        const status = (() => {
          switch (event.type) {
            case "session.state.changed": {
              const runtimeStatus = orchestrationSessionStatusFromRuntimeState(event.payload.state);
              return hasPendingTurnStart && runtimeStatus === "ready" ? "starting" : runtimeStatus;
            }
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return normalizeRuntimeTurnState(event.payload.state) === "failed"
                ? "error"
                : "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active or pending turn; preserve that lifecycle state.
              return activeTurnId !== null ? "running" : hasPendingTurnStart ? "starting" : "ready";
          }
        })();
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" || event.type === "session.exited"
              ? null
              : event.type === "session.state.changed" &&
                  !sessionStatusAllowsActiveTurn(
                    orchestrationSessionStatusFromRuntimeState(event.payload.state),
                  )
                ? null
                : activeTurnId;
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" &&
                normalizeRuntimeTurnState(event.payload.state) === "failed"
              ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready"
                ? null
                : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
            yield* markSourceProposedPlanImplemented(
              acceptedTurnStartedSourcePlan.sourceThreadId,
              acceptedTurnStartedSourcePlan.sourcePlanId,
              thread.id,
              now,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "provider runtime ingestion failed to mark source proposed plan",
                  {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  },
                ),
              ),
            );
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: yield* providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            createdAt: now,
          });
        }

        if (
          event.type === "turn.completed" &&
          normalizeRuntimeTurnState(event.payload.state) === "failed" &&
          shouldApplyThreadLifecycle
        ) {
          yield* tryRotateAccountOnProviderLimit({
            thread,
            event,
            message: event.payload.errorMessage ?? thread.session?.lastError ?? "",
          });
        }
      }

      const assistantDelta =
        event.type === "content.delta" &&
        event.payload.streamKind === "assistant_text" &&
        event.payload.parentToolUseId === undefined
          ? event.payload.delta
          : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      if (event.type === "content.delta") {
        yield* ingestSubagentTranscriptDelta(event);
      }

      if (assistantDelta && assistantDelta.length > 0) {
        const turnId = toTurnId(event.turnId);
        const assistantMessageId = yield* getOrCreateAssistantMessageId({
          threadId: thread.id,
          event,
          ...(turnId ? { turnId } : {}),
        });
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
          serverSettingsService.getSettings,
          (settings) => (settings.enableAssistantStreaming ? "streaming" : "buffered"),
        );
        if (assistantDeliveryMode === "buffered") {
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
          if (spillChunk.length > 0) {
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: yield* providerCommandId(event, "assistant-delta-buffer-spill"),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        } else {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: yield* providerCommandId(event, "assistant-delta"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      const pauseForUserTurnId =
        event.type === "request.opened" || event.type === "user-input.requested"
          ? toTurnId(event.turnId)
          : undefined;
      if (pauseForUserTurnId) {
        const detailedThread = yield* getLoadedThreadDetail();
        const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
          serverSettingsService.getSettings,
          (settings) => (settings.enableAssistantStreaming ? "streaming" : "buffered"),
        );
        const flushedMessageIds =
          assistantDeliveryMode === "buffered"
            ? yield* flushBufferedAssistantMessagesForTurn({
                event,
                threadId: thread.id,
                turnId: pauseForUserTurnId,
                createdAt: now,
                commandTag:
                  event.type === "request.opened"
                    ? "assistant-delta-flush-on-request-opened"
                    : "assistant-delta-flush-on-user-input-requested",
              })
            : new Set<MessageId>();
        yield* finalizeActiveAssistantSegmentForTurn({
          event,
          threadId: thread.id,
          turnId: pauseForUserTurnId,
          createdAt: now,
          commandTag:
            event.type === "request.opened"
              ? "assistant-complete-on-request-opened"
              : "assistant-complete-on-user-input-requested",
          finalDeltaCommandTag:
            event.type === "request.opened"
              ? "assistant-delta-finalize-on-request-opened"
              : "assistant-delta-finalize-on-user-input-requested",
          hasProjectedMessage:
            detailedThread !== null &&
            hasAssistantMessageForTurn(detailedThread.messages, pauseForUserTurnId, {
              streamingOnly: true,
            }),
          flushedMessageIds,
        });
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      const assistantCompletion =
        event.type === "item.completed" && event.payload.itemType === "assistant_message"
          ? {
              messageId: MessageId.make(
                `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
              ),
              fallbackText: event.payload.detail,
            }
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const detailedThread = yield* getLoadedThreadDetail();
        const messages = detailedThread?.messages ?? [];
        const turnId = toTurnId(event.turnId);
        const activeAssistantMessageId = turnId
          ? yield* getActiveAssistantMessageIdForTurn(thread.id, turnId)
          : Option.none<MessageId>();
        const hasAssistantMessagesForTurn =
          turnId !== undefined ? hasAssistantMessageForTurn(messages, turnId) : false;
        const assistantMessageId = Option.getOrElse(
          activeAssistantMessageId,
          () => assistantCompletion.messageId,
        );
        const existingAssistantMessage = findMessageById(messages, assistantMessageId);
        const shouldApplyFallbackCompletionText =
          !existingAssistantMessage || existingAssistantMessage.text.length === 0;

        const shouldSkipRedundantCompletion =
          Option.isNone(activeAssistantMessageId) &&
          turnId !== undefined &&
          hasAssistantMessagesForTurn &&
          (assistantCompletion.fallbackText?.trim().length ?? 0) === 0;

        if (!shouldSkipRedundantCompletion) {
          if (turnId && Option.isNone(activeAssistantMessageId)) {
            yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
          }

          yield* finalizeAssistantMessage({
            event,
            threadId: thread.id,
            messageId: assistantMessageId,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
            commandTag: "assistant-complete",
            finalDeltaCommandTag: "assistant-delta-finalize",
            hasProjectedMessage: existingAssistantMessage !== undefined,
            ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
              ? { fallbackText: assistantCompletion.fallbackText }
              : {}),
          });

          if (turnId) {
            yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
          }
        }

        if (turnId) {
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);
        }
      }

      if (proposedPlanCompletion) {
        const detailedThread = yield* getLoadedThreadDetail();
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: detailedThread?.proposedPlans ?? [],
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (event.type === "turn.completed") {
        const detailedThread = yield* getLoadedThreadDetail();
        const messages = detailedThread?.messages ?? [];
        const proposedPlans = detailedThread?.proposedPlans ?? [];
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
                hasProjectedMessage: findMessageById(messages, assistantMessageId) !== undefined,
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            threadProposedPlans: proposedPlans,
            planId: proposedPlanIdForTurn(thread.id, turnId),
            turnId,
            updatedAt: now,
          });
        }
      }

      if (event.type === "session.exited") {
        yield* clearTurnStateForSession(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = event.payload.message;

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: yield* providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });

          yield* tryRotateAccountOnProviderLimit({
            thread,
            event,
            message: runtimeErrorMessage,
          });
        }
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
        });
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        const checkpointContext = turnId
          ? yield* projectionSnapshotQuery
              .getThreadCheckpointContext(thread.id)
              .pipe(Effect.map(Option.getOrUndefined))
          : undefined;
        const workspaceCwd =
          checkpointContext?.worktreePath ?? checkpointContext?.workspaceRoot ?? undefined;
        if (turnId && checkpointContext && workspaceCwd && isGitRepository(workspaceCwd)) {
          // Skip if a checkpoint already exists for this turn. A real
          // (non-placeholder) capture from CheckpointReactor should not
          // be clobbered, and dispatching a duplicate placeholder for the
          // same turnId would produce an unstable checkpointTurnCount.
          if (hasCheckpointForTurn(checkpointContext.checkpoints, turnId)) {
            // Already tracked; no-op.
          } else {
            const assistantMessageId = MessageId.make(
              `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
            );
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.diff.complete",
              commandId: yield* providerCommandId(event, "thread-turn-diff-complete"),
              threadId: thread.id,
              turnId,
              completedAt: now,
              checkpointRef: CheckpointRef.make(`provider-diff:${event.eventId}`),
              status: "missing",
              files: [],
              assistantMessageId,
              checkpointTurnCount: maxCheckpointTurnCount(checkpointContext.checkpoints) + 1,
              createdAt: now,
            });
          }
        }
      }

      if (event.type === "task.started" || event.type === "task.progress") {
        const description = event.payload.description?.trim();
        const subagentType = event.payload.subagentType;
        // Only task.started carries the task kind; task.progress has none.
        const taskType = event.type === "task.started" ? event.payload.taskType : undefined;
        if (description || subagentType || taskType) {
          yield* rememberTaskMetadata(thread.id, event.payload.taskId, {
            ...(description ? { description } : {}),
            ...(subagentType ? { subagentType } : {}),
            ...(taskType ? { taskType } : {}),
          });
        }
        if (event.payload.toolUseId && subagentType) {
          yield* Cache.set(
            subagentTypeByTranscriptParentKey,
            transcriptParentKey(thread.id, event.payload.toolUseId),
            subagentType,
          );
        }
      }
      if (event.type === "task.updated" && event.payload.patch.description) {
        yield* rememberTaskMetadata(thread.id, event.payload.taskId, {
          description: event.payload.patch.description.trim(),
        });
      }
      let taskContext: TaskActivityMetadata | undefined;
      if (event.type === "task.completed" || event.type === "task.updated") {
        const remembered = yield* lookupTaskMetadata(thread.id, event.payload.taskId);
        let title = remembered?.description;
        let subagentType = remembered?.subagentType;
        let taskType = remembered?.taskType;
        // Fall back to persisted activities only when the title is gone: the
        // cache remembers all three fields together, so a present title with an
        // absent subagentType or taskType means the wire never carried one and
        // the persisted payloads will not have it either.
        if (!title) {
          const threadDetail = yield* getLoadedThreadDetail();
          const persisted = findTaskMetadataInActivities(
            threadDetail?.activities,
            event.payload.taskId,
          );
          title = persisted.title;
          subagentType = subagentType ?? persisted.subagentType;
          taskType = taskType ?? persisted.taskType;
        }
        taskContext = {
          ...(title ? { title } : {}),
          ...(subagentType ? { subagentType } : {}),
          ...(taskType ? { taskType } : {}),
        };
      }

      const activities = runtimeEventToActivities(event, taskContext);
      yield* Effect.forEach(activities, (activity) => {
        // Only item.updated's tool.updated activity is throttled -- every
        // other kind (approvals, tool.started/completed, task.*, ...) keeps
        // dispatching straight through, one command per event, as before.
        if (event.type === "item.updated" && event.itemId !== undefined) {
          return dispatchOrCoalesceToolUpdate(thread.id, event.itemId, event, activity);
        }
        return providerCommandId(event, "thread-activity-append").pipe(
          Effect.flatMap((commandId) =>
            orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId,
              threadId: thread.id,
              activity,
              createdAt: activity.createdAt,
            }),
          ),
        );
      }).pipe(Effect.asVoid);
    });

  const processDomainEvent = (_event: TurnStartRequestedDomainEvent) => Effect.void;

  const processInput = (input: RuntimeIngestionInput) => {
    switch (input.source) {
      case "runtime":
        return processRuntimeEvent(input.event);
      case "domain":
        return processDomainEvent(input.event);
      case "tool-update-flush":
        return flushPendingToolUpdate(input.key);
      case "transcript-flush":
        return flushPendingTranscriptActivity(input.key);
    }
  };

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          ...(input.source === "tool-update-flush"
            ? { toolUpdateThrottleKey: input.key }
            : input.source === "transcript-flush"
              ? { transcriptThrottleKey: input.key }
              : { eventId: input.event.eventId, eventType: input.event.type }),
          cause: Cause.pretty(cause),
        });
      }),
    );

  worker = yield* makeDrainableWorker(processInputSafely);

  const start: ProviderRuntimeIngestionShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) =>
          worker.enqueue({ source: "runtime", event }),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "thread.turn-start-requested") {
            return Effect.void;
          }
          return worker.enqueue({ source: "domain", event });
        }),
      );
    });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
