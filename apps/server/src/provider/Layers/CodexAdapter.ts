/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps the typed Codex session runtime behind the `CodexAdapter` service
 * contract and maps runtime failures into the shared `ProviderAdapterError`
 * algebra.
 *
 * @module CodexAdapterLive
 */
import {
  attachmentCapabilityForDriver,
  type CanonicalItemType,
  type CanonicalRequestType,
  type CodexSettings,
  ProviderDriverKind,
  type ProviderEvent,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderRequestKind,
  type ProviderUsageSample,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ProviderApprovalDecision,
  ThreadId,
  ProviderSendTurnInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { getCodexServiceTierOptionValue } from "../../codexModelOptions.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { toT3EnvironmentEnv } from "../t3Environment.ts";
import { toGitCommitterEnv } from "../gitCommitterEnv.ts";

import {
  ProviderAdapterRequestError,
  ProviderAdapterProcessError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import type { ProviderAdapterCapabilities } from "../Services/ProviderAdapter.ts";
import type { ProviderAccountLimitsStoreShape } from "../../persistence/Services/ProviderAccountLimits.ts";
import type { ProviderUsageLedgerStoreShape } from "../../persistence/Services/ProviderUsageLedger.ts";
import { classifyCodexRateLimits, normalizeEpochResetsAt } from "../providerLimitSignal.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  formatAttachmentPathReferenceText,
  type AttachmentPathReference,
} from "../attachmentEncoding.ts";
import {
  CODEX_SUBAGENT_TURN_COMPLETED_METHOD,
  CODEX_SUBAGENT_TURN_STARTED_METHOD,
  CodexResumeCursorSchema,
  CodexSessionRuntimeThreadIdMissingError,
  makeCodexSessionRuntime,
  type CodexSessionRuntimeError,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeShape,
  type CodexTurnAttachmentInput,
} from "./CodexSessionRuntime.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";
const isCodexAppServerProcessExitedError = Schema.is(CodexErrors.CodexAppServerProcessExitedError);
const isCodexAppServerTransportError = Schema.is(CodexErrors.CodexAppServerTransportError);
const isCodexSessionRuntimeThreadIdMissingError = Schema.is(
  CodexSessionRuntimeThreadIdMissingError,
);
const isCodexResumeCursorSchema = Schema.is(CodexResumeCursorSchema);

const PROVIDER = ProviderDriverKind.make("codex");

/**
 * Attachment and session capabilities this adapter declares. Sourced from the
 * shared contracts table so the server and the clients cannot drift.
 */
export const CODEX_ADAPTER_CAPABILITIES: ProviderAdapterCapabilities = {
  sessionModelSwitch: "in-session",
  sessionLifecycle: { resume: "cursor" },
  attachments: attachmentCapabilityForDriver(PROVIDER),
};

export interface CodexAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeRuntime?: (
    options: CodexSessionRuntimeOptions,
  ) => Effect.Effect<
    CodexSessionRuntimeShape,
    CodexSessionRuntimeError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Optional persistence ports for `account/rateLimits/updated` push
   * notifications, mirroring the Claude adapter's ports. Optional on purpose:
   * test layers build the adapter without persistence, and a missing port
   * only skips the write, never the runtime event.
   */
  readonly recordUsageSamples?: ProviderUsageLedgerStoreShape["recordSamples"];
  readonly recordAccountLimit?: ProviderAccountLimitsStoreShape["recordLimit"];
}

interface CodexAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly runtime: CodexSessionRuntimeShape;
  readonly eventFiber: Fiber.Fiber<void, never>;
  stopped: boolean;
}

function mapCodexRuntimeError(
  threadId: ThreadId,
  method: string,
  error: CodexSessionRuntimeError,
): ProviderAdapterError {
  if (isCodexAppServerProcessExitedError(error) || isCodexAppServerTransportError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
  }

  if (isCodexSessionRuntimeThreadIdMissingError(error)) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
  }

  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: error.message,
    cause: error,
  });
}

type CodexLifecycleItem =
  | EffectCodexSchema.V2ItemStartedNotification["item"]
  | EffectCodexSchema.V2ItemCompletedNotification["item"];

type CodexToolUserInputQuestion =
  | EffectCodexSchema.ServerRequest__ToolRequestUserInputQuestion
  | EffectCodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion;

const ApprovalDecisionPayload = Schema.Struct({
  decision: ProviderApprovalDecision,
});

function readPayload<A>(
  schema: Schema.Schema<A>,
  payload: ProviderEvent["payload"],
): A | undefined {
  const isPayload = Schema.is(schema);
  return isPayload(payload) ? payload : undefined;
}

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

const FATAL_CODEX_STDERR_SNIPPETS = ["failed to connect to websocket"];

function isFatalCodexProcessStderrMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return FATAL_CODEX_STDERR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

function normalizeCodexTokenUsage(
  usage: EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
): ThreadTokenUsageSnapshot | undefined {
  const totalProcessedTokens = usage.total.totalTokens;
  const usedTokens = usage.last.totalTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = usage.modelContextWindow ?? undefined;
  const inputTokens = usage.last.inputTokens;
  const cachedInputTokens = usage.last.cachedInputTokens;
  const outputTokens = usage.last.outputTokens;
  const reasoningOutputTokens = usage.last.reasoningOutputTokens;

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
  };
}

function toTurnStatus(
  value: EffectCodexSchema.V2TurnCompletedNotification["turn"]["status"] | "cancelled",
): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

function normalizeItemType(raw: string | undefined | null): string {
  const type = trimText(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toCanonicalItemType(raw: string | undefined | null): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  // codex-cli 0.147 reports a collab spawn as `subAgentActivity` instead of
  // through `collabAgentToolCall.receiverThreadIds`; both are subagent rows.
  if (type.includes("sub agent") || type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered")) return "review_entered";
  if (type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

function itemTitle(itemType: CanonicalItemType, item?: CodexLifecycleItem): string | undefined {
  if (itemType === "mcp_tool_call" && item?.type === "mcpToolCall") {
    return `${item.server} · ${item.tool}`;
  }
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function itemDetail(itemType: CanonicalItemType, item: CodexLifecycleItem): string | undefined {
  const itemRecord = item as Record<string, unknown>;
  const action = itemRecord.action as Record<string, unknown> | undefined;
  const actionQueries = Array.isArray(action?.queries) ? action.queries : [];
  const candidates = [
    ...(itemType === "web_search"
      ? [itemRecord.query, action?.query, ...actionQueries, action?.pattern, action?.url]
      : []),
    "command" in item ? item.command : undefined,
    "title" in item ? item.title : undefined,
    "summary" in item ? item.summary : undefined,
    "text" in item ? item.text : undefined,
    "path" in item ? item.path : undefined,
    "prompt" in item ? item.prompt : undefined,
  ];

  for (const candidate of candidates) {
    const trimmed = typeof candidate === "string" ? trimText(candidate) : undefined;
    if (!trimmed) continue;
    return trimmed;
  }
  return undefined;
}

function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

function toRequestTypeFromKind(kind: ProviderRequestKind | undefined): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function toCanonicalUserInputAnswers(
  answers: EffectCodexSchema.ToolRequestUserInputResponse["answers"],
): ProviderUserInputAnswers {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => {
      const normalizedAnswers = value.answers.length === 1 ? value.answers[0]! : [...value.answers];
      return [questionId, normalizedAnswers] as const;
    }),
  );
}

function toUserInputQuestions(questions: ReadonlyArray<CodexToolUserInputQuestion>) {
  const parsedQuestions = questions
    .map((question) => {
      const options =
        question.options
          ?.map((option) => {
            const label = trimText(option.label);
            const description = trimText(option.description);
            if (!label || !description) {
              return undefined;
            }
            return { label, description };
          })
          .filter((option) => option !== undefined) ?? [];

      const id = trimText(question.id);
      const header = trimText(question.header);
      const prompt = trimText(question.question);
      if (!id || !header || !prompt || options.length === 0) {
        return undefined;
      }
      return {
        id,
        header,
        question: prompt,
        options,
        multiSelect: false,
      };
    })
    .filter((question) => question !== undefined);

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

function toThreadState(
  status: EffectCodexSchema.V2ThreadStatusChangedNotification["status"],
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (status.type) {
    case "idle":
      return "idle";
    case "systemError":
      return "error";
    default:
      return "active";
  }
}

function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

function asRuntimeItemId(itemId: ProviderEvent["itemId"] & string): RuntimeItemId {
  return RuntimeItemId.make(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.make(requestId);
}

function eventRawSource(event: ProviderEvent): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function isProviderRootSubAgentActivity(item: SubAgentActivityItem): boolean {
  return item.agentPath === "/root";
}

function collabReceiverThreadIds(
  item: CollabAgentToolCallItem,
  providerThreadId: string | undefined,
): ReadonlyArray<string> {
  return item.receiverThreadIds.filter((threadId) => threadId !== providerThreadId);
}

function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload =
    readPayload(EffectCodexSchema.V2ItemStartedNotification, event.payload) ??
    readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
  const item = payload?.item;
  if (!item) {
    return undefined;
  }
  const itemType = toCanonicalItemType(item.type);
  if (itemType === "unknown" && lifecycle !== "item.updated") {
    return undefined;
  }

  const detail = itemDetail(itemType, item);
  const status =
    lifecycle === "item.started"
      ? "inProgress"
      : lifecycle === "item.completed"
        ? item.type === "collabAgentToolCall" && item.status === "failed"
          ? "failed"
          : "completed"
        : undefined;
  const data =
    item.type === "collabAgentToolCall"
      ? normalizeCollabAgentActivityData(item, event.providerThreadId)
      : item.type === "subAgentActivity"
        ? normalizeSubAgentActivityData(item)
        : event.payload;

  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(itemTitle(itemType, item) ? { title: itemTitle(itemType, item) } : {}),
      ...(detail ? { detail } : {}),
      ...(data !== undefined ? { data } : {}),
    },
  };
}

type CollabAgentToolCallItem = Extract<CodexLifecycleItem, { type: "collabAgentToolCall" }>;
type CollabAgentState = CollabAgentToolCallItem["agentsStates"][string];
type SubAgentActivityItem = Extract<CodexLifecycleItem, { type: "subAgentActivity" }>;

// A `subAgentActivity` kind maps onto the collab tool vocabulary the web
// subagent projection already groups by: only a spawn opens a group, the
// other two are later operations on an open one.
const SUB_AGENT_ACTIVITY_COLLAB_TOOL: Record<SubAgentActivityItem["kind"], string> = {
  started: "spawnAgent",
  interacted: "sendInput",
  interrupted: "closeAgent",
};

function subAgentActivityType(item: SubAgentActivityItem): string {
  const segments = item.agentPath
    .split("/")
    .map((segment) => trimText(segment))
    .filter((segment): segment is string => segment !== undefined);
  return segments[segments.length - 1] ?? "Subagent";
}

/**
 * codex-cli 0.147 emits `subAgentActivity` (agentThreadId + agentPath) for a
 * `collaboration.spawn_agent` call, and the matching `collabAgentToolCall` is
 * a `wait` with empty `receiverThreadIds`. Normalize it onto the same collab
 * shape `deriveSubagentGroups` reads, so the spawn renders as a subagent row
 * rather than an unknown item that gets dropped.
 */
function normalizeSubAgentActivityData(item: SubAgentActivityItem) {
  return {
    toolCallId: item.id,
    toolName: "Task",
    collabTool: SUB_AGENT_ACTIVITY_COLLAB_TOOL[item.kind],
    subAgentActivityKind: item.kind,
    agentPath: item.agentPath,
    receiverThreadIds: [item.agentThreadId],
    agentsStates: {},
    input: {
      description: item.agentPath,
      subagent_type: subAgentActivityType(item),
    },
  };
}

// The child thread id is the task id, matching `mapCollabAgentTaskEvents`.
// Called from `item/started` only: Codex repeats the same snapshot on
// `item/completed`, where a second task event would duplicate the row.
function mapSubAgentActivityTaskEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  item: SubAgentActivityItem,
): ReadonlyArray<ProviderRuntimeEvent> {
  const base = runtimeEventBase(event, canonicalThreadId);
  const taskId = RuntimeTaskId.make(item.agentThreadId);
  const subagentType = subAgentActivityType(item);
  if (item.kind === "started") {
    return [
      {
        ...base,
        type: "task.started",
        payload: {
          taskId,
          toolUseId: item.id,
          subagentType,
          description: item.agentPath,
        },
      },
    ];
  }
  if (item.kind === "interrupted") {
    return [
      {
        ...base,
        type: "task.completed",
        payload: {
          taskId,
          status: "stopped",
          toolUseId: item.id,
        },
      },
    ];
  }
  return [
    {
      ...base,
      type: "task.progress",
      payload: {
        taskId,
        ...(event.providerThreadId ? { providerThreadId: event.providerThreadId } : {}),
        description: "Subagent received input",
        toolUseId: item.id,
        subagentType,
      },
    },
  ];
}

// A collab child never reaches a terminal collab state in 0.147; its own
// `turn/completed` is the only completion signal, and the session runtime
// renames it so it cannot be read as the parent's turn ending.
function subAgentTaskStatusFromTurn(
  status: EffectCodexSchema.V2TurnCompletedNotification["turn"]["status"],
): "completed" | "failed" | "stopped" {
  switch (toTurnStatus(status)) {
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
    default:
      return "completed";
  }
}

const PROMPT_EXCERPT_MAX_LENGTH = 200;

function promptExcerpt(prompt: string | null | undefined): string | undefined {
  const trimmed = trimText(prompt ?? undefined);
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > PROMPT_EXCERPT_MAX_LENGTH
    ? `${trimmed.slice(0, PROMPT_EXCERPT_MAX_LENGTH - 3)}...`
    : trimmed;
}

function collabAgentSubagentType(item: CollabAgentToolCallItem): string {
  return trimText(item.model ?? undefined) ?? item.tool;
}

function collabAgentResult(item: CollabAgentToolCallItem): string | undefined {
  const summaries = item.receiverThreadIds.flatMap((childThreadId) => {
    const summary = trimText(item.agentsStates[childThreadId]?.message ?? undefined);
    return summary ? [summary] : [];
  });
  return summaries.length > 0 ? summaries.join("\n") : undefined;
}

/**
 * Codex nests collab fields under the V2 notification's `item`. The web
 * subagent projection consumes the provider-neutral Task shape instead, so
 * normalize only this item type while the untouched notification remains in
 * `ProviderRuntimeEvent.raw.payload` for diagnostics.
 */
function normalizeCollabAgentActivityData(
  item: CollabAgentToolCallItem,
  providerThreadId: string | undefined,
) {
  const prompt = trimText(item.prompt ?? undefined);
  const description = promptExcerpt(item.prompt);
  const receiverThreadIds = collabReceiverThreadIds(item, providerThreadId);
  const result = collabAgentResult({ ...item, receiverThreadIds });
  const agentsStates = Object.fromEntries(
    Object.entries(item.agentsStates).filter(([threadId]) => threadId !== providerThreadId),
  );
  return {
    toolCallId: item.id,
    toolName: item.tool === "spawnAgent" ? "Task" : item.tool,
    collabTool: item.tool,
    receiverThreadIds,
    agentsStates,
    input: {
      ...(prompt ? { prompt } : {}),
      ...(description ? { description } : {}),
      subagent_type: collabAgentSubagentType(item),
    },
    ...(result ? { result } : {}),
  };
}

// Maps the collab tool call's per-thread agent status onto a terminal task
// status, or `undefined` when the agent is still in flight (pendingInit,
// running, interrupted) — the caller treats that as a task.progress signal.
function collabAgentTerminalTaskStatus(
  status: CollabAgentState["status"],
): "completed" | "failed" | "stopped" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "errored":
    case "notFound":
      return "failed";
    case "shutdown":
      return "stopped";
    default:
      return undefined;
  }
}

function collabAgentProgressDescription(
  state: CollabAgentState | undefined,
  fallback: string | undefined,
): string {
  return trimText(state?.message ?? undefined) ?? fallback ?? `Agent ${state?.status ?? "update"}`;
}

// Codex has no live `item/updated` notification for collabAgentToolCall
// (unlike Claude's task_started/task_progress/task_notification triad): a
// subagent's lifecycle instead spans several distinct collab items sharing
// the same receiver thread id (spawnAgent, then wait/sendInput/resumeAgent,
// then closeAgent). We use the receiver thread id itself as the stable
// `taskId` across that whole lifecycle, and derive task.started /
// task.progress / task.completed from each item's snapshot of
// `agentsStates` — terminal statuses (completed/errored/shutdown/notFound)
// complete the task, everything else is progress. `toolUseId` is set to the
// id of the collab item that produced this particular event; it is the
// join key for THAT item, not a stable spawn-time id (Codex has no such
// field), so it will differ between the spawnAgent item and any later
// wait/closeAgent item for the same task.
function mapCollabAgentTaskEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.completed",
  item: CollabAgentToolCallItem,
): ReadonlyArray<ProviderRuntimeEvent> {
  const base = runtimeEventBase(event, canonicalThreadId);
  const prompt = trimText(item.prompt ?? undefined);
  const excerpt = promptExcerpt(item.prompt);
  const subagentType = collabAgentSubagentType(item);
  const receiverThreadIds = collabReceiverThreadIds(item, event.providerThreadId);

  if (lifecycle === "item.started") {
    if (item.tool !== "spawnAgent") {
      return [];
    }
    return receiverThreadIds.map(
      (childThreadId): ProviderRuntimeEvent => ({
        ...base,
        type: "task.started",
        payload: {
          taskId: RuntimeTaskId.make(childThreadId),
          toolUseId: item.id,
          subagentType,
          ...(excerpt ? { description: excerpt } : {}),
          ...(prompt ? { prompt } : {}),
        },
      }),
    );
  }

  return receiverThreadIds.flatMap((childThreadId): ReadonlyArray<ProviderRuntimeEvent> => {
    const state = item.agentsStates[childThreadId];
    if (!state) {
      return [];
    }
    const terminalStatus = collabAgentTerminalTaskStatus(state.status);
    if (terminalStatus) {
      const summary = trimText(state.message ?? undefined);
      return [
        {
          ...base,
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.make(childThreadId),
            status: terminalStatus,
            toolUseId: item.id,
            ...(summary ? { summary } : {}),
          },
        },
      ];
    }
    return [
      {
        ...base,
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make(childThreadId),
          description: collabAgentProgressDescription(state, excerpt),
          ...(event.providerThreadId ? { providerThreadId: event.providerThreadId } : {}),
          toolUseId: item.id,
          subagentType,
        },
      },
    ];
  });
}

function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      const payload =
        readPayload(EffectCodexSchema.ServerRequest__ToolRequestUserInputParams, event.payload) ??
        readPayload(EffectCodexSchema.ToolRequestUserInputParams, event.payload);
      const questions = payload ? toUserInputQuestions(payload.questions) : undefined;
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const detail = (() => {
      switch (event.method) {
        case "item/commandExecution/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__CommandExecutionRequestApprovalParams,
            event.payload,
          );
          return payload?.command ?? payload?.reason ?? undefined;
        }
        case "item/fileChange/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__FileChangeRequestApprovalParams,
            event.payload,
          );
          return payload?.reason ?? undefined;
        }
        case "applyPatchApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ApplyPatchApprovalParams,
            event.payload,
          );
          return payload?.reason ?? undefined;
        }
        case "execCommandApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ExecCommandApprovalParams,
            event.payload,
          );
          return payload?.reason ?? payload?.command.join(" ");
        }
        case "item/tool/call": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__DynamicToolCallParams,
            event.payload,
          );
          return payload?.tool ?? undefined;
        }
        default:
          return undefined;
      }
    })();

    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method),
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const payload = readPayload(ApprovalDecisionPayload, event.payload);
    const requestType =
      event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(payload ? { decision: payload.decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const payload = readPayload(EffectCodexSchema.V2ThreadStartedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId: payload.thread.id,
        },
      },
    ];
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    const payload =
      event.method === "thread/status/changed"
        ? readPayload(EffectCodexSchema.V2ThreadStatusChangedNotification, event.payload)
        : undefined;
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/closed"
                ? "closed"
                : event.method === "thread/compacted"
                  ? "compacted"
                  : payload
                    ? toThreadState(payload.status)
                    : "active",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    const payload = readPayload(EffectCodexSchema.V2ThreadNameUpdatedNotification, event.payload);
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(trimText(payload?.threadName) ? { name: trimText(payload?.threadName) } : {}),
          ...(payload
            ? {
                metadata: {
                  threadId: payload.threadId,
                  ...(payload.threadName !== undefined && payload.threadName !== null
                    ? { threadName: payload.threadName }
                    : {}),
                },
              }
            : {}),
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification,
      event.payload,
    );
    const normalizedUsage = payload ? normalizeCodexTokenUsage(payload.tokenUsage) : undefined;
    if (!normalizedUsage) {
      return [];
    }
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: normalizedUsage,
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {},
      },
    ];
  }

  if (event.method === "turn/completed") {
    const payload = readPayload(EffectCodexSchema.V2TurnCompletedNotification, event.payload);
    if (!payload) {
      return [];
    }
    const errorMessage = trimText(payload.turn.error?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: toTurnStatus(payload.turn.status),
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === CODEX_SUBAGENT_TURN_STARTED_METHOD) {
    const payload = readPayload(EffectCodexSchema.V2TurnStartedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make(payload.threadId),
          ...(event.providerThreadId ? { providerThreadId: event.providerThreadId } : {}),
          description: "Subagent turn started",
        },
      },
    ];
  }

  if (event.method === CODEX_SUBAGENT_TURN_COMPLETED_METHOD) {
    const payload = readPayload(EffectCodexSchema.V2TurnCompletedNotification, event.payload);
    if (!payload) {
      return [];
    }
    const errorMessage = trimText(payload.turn.error?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.make(payload.threadId),
          status: subAgentTaskStatusFromTurn(payload.turn.status),
          ...(errorMessage ? { summary: errorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const payload = readPayload(EffectCodexSchema.V2TurnPlanUpdatedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.plan.updated",
        payload: {
          ...(trimText(payload.explanation) ? { explanation: trimText(payload.explanation) } : {}),
          plan: payload.plan.map((step) => ({
            step: trimText(step.step) ?? "step",
            status:
              step.status === "completed" || step.status === "inProgress" ? step.status : "pending",
          })),
        },
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    const payload = readPayload(EffectCodexSchema.V2TurnDiffUpdatedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff: payload.diff,
        },
      },
    ];
  }

  if (event.method === "item/started") {
    const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
    if (!started) {
      return [];
    }
    const startedItem = readPayload(
      EffectCodexSchema.V2ItemStartedNotification,
      event.payload,
    )?.item;
    const taskEvents =
      startedItem === undefined
        ? []
        : startedItem.type === "collabAgentToolCall"
          ? mapCollabAgentTaskEvents(event, canonicalThreadId, "item.started", startedItem)
          : startedItem.type === "subAgentActivity"
            ? isProviderRootSubAgentActivity(startedItem)
              ? []
              : mapSubAgentActivityTaskEvents(event, canonicalThreadId, startedItem)
            : [];
    return [started, ...taskEvents];
  }

  if (event.method === "item/completed") {
    const payload = readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
    const item = payload?.item;
    if (!item) {
      return [];
    }
    const itemType = toCanonicalItemType(item.type);
    if (itemType === "plan") {
      const detail = itemDetail(itemType, item);
      if (!detail) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: detail,
          },
        },
      ];
    }
    const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    if (!completed) {
      return [];
    }
    // `subAgentActivity` is absent here on purpose: its task lifecycle is
    // mapped once from `item/started`, and completed once from the child
    // thread's own renamed `turn/completed`.
    const taskEvents =
      item.type === "collabAgentToolCall"
        ? mapCollabAgentTaskEvents(event, canonicalThreadId, "item.completed", item)
        : [];
    return [completed, ...taskEvents];
  }

  if (
    event.method === "item/reasoning/summaryPartAdded" ||
    event.method === "item/commandExecution/terminalInteraction"
  ) {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.updated",
        payload: {
          itemType:
            event.method === "item/reasoning/summaryPartAdded" ? "reasoning" : "command_execution",
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/plan/delta") {
    const payload = readPayload(EffectCodexSchema.V2PlanDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.proposed.delta",
        payload: {
          delta,
        },
      },
    ];
  }

  if (event.method === "item/agentMessage/delta") {
    const payload = readPayload(EffectCodexSchema.V2AgentMessageDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
        },
      },
    ];
  }

  if (event.method === "item/commandExecution/outputDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2CommandExecutionOutputDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "command_output",
          delta,
        },
      },
    ];
  }

  if (event.method === "item/fileChange/outputDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2FileChangeOutputDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "file_change_output",
          delta,
        },
      },
    ];
  }

  if (event.method === "item/reasoning/summaryTextDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2ReasoningSummaryTextDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_summary_text",
          delta,
          ...(payload ? { summaryIndex: payload.summaryIndex } : {}),
        },
      },
    ];
  }

  if (event.method === "item/reasoning/textDelta") {
    const payload = readPayload(EffectCodexSchema.V2ReasoningTextDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_text",
          delta,
          ...(payload ? { contentIndex: payload.contentIndex } : {}),
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    const payload = readPayload(EffectCodexSchema.V2McpToolCallProgressNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "tool.progress",
        payload: {
          summary: payload.message,
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved") {
    const payload = readPayload(
      EffectCodexSchema.V2ServerRequestResolvedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const requestType = toRequestTypeFromKind(event.requestKind);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/tool/requestUserInput/answered") {
    const payload = readPayload(EffectCodexSchema.ToolRequestUserInputResponse, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: toCanonicalUserInputAnswers(payload.answers),
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    const payload = readPayload(EffectCodexSchema.V2ModelReroutedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: payload.fromModel,
          toModel: payload.toModel,
          reason: payload.reason,
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    const payload = readPayload(EffectCodexSchema.V2DeprecationNoticeNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: payload.summary,
          ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    const payload = readPayload(EffectCodexSchema.V2ConfigWarningNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: payload.summary,
          ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
          ...(trimText(payload.path) ? { path: trimText(payload.path) } : {}),
          ...(payload.range !== undefined && payload.range !== null
            ? { range: payload.range }
            : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    if (!readPayload(EffectCodexSchema.V2AccountUpdatedNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    if (!readPayload(EffectCodexSchema.V2AccountRateLimitsUpdatedNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    const payload = readPayload(
      EffectCodexSchema.V2McpServerOauthLoginCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload.success,
          name: payload.name,
          ...(trimText(payload.error) ? { error: trimText(payload.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeStartedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          realtimeSessionId: payload.realtimeSessionId ?? undefined,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeItemAddedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.item-added",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          item: payload.item,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeOutputAudioDeltaNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.audio.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          audio: payload.audio,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const payload = readPayload(EffectCodexSchema.V2ThreadRealtimeErrorNotification, event.payload);
    const message = payload?.message ?? event.message ?? "Realtime error";
    return [
      {
        type: "thread.realtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeClosedNotification,
      event.payload,
    );
    return [
      {
        type: "thread.realtime.closed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          reason: payload?.reason ?? event.message,
        },
      },
    ];
  }

  if (event.method === "error") {
    const payload = readPayload(EffectCodexSchema.V2ErrorNotification, event.payload);
    const message = payload?.error.message ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    return [
      {
        type: willRetry ? "runtime.warning" : "runtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(!willRetry ? { class: "provider_error" as const } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "process/stderr") {
    const message = event.message ?? "Codex process stderr";
    const isFatal = isFatalCodexProcessStderrMessage(message);
    return [
      isFatal
        ? {
            type: "runtime.error",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              class: "provider_error" as const,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          }
        : {
            type: "runtime.warning",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    if (!readPayload(EffectCodexSchema.V2WindowsWorldWritableWarningNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Windows world-writable warning",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payload = readPayload(
      EffectCodexSchema.V2WindowsSandboxSetupCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: payload.success === false ? "error" : "ready",
          reason: payload.success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(payload.success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  return [];
}

/**
 * Build a Codex provider adapter bound to a specific `CodexSettings` payload.
 *
 * The adapter is a captured closure over `codexConfig` — the `binaryPath` and
 * `homePath` are read from that payload, not from `ServerSettingsService`.
 * This is what makes multi-instance routing possible: each `ProviderInstance`
 * in the registry owns its own closure with its own config, so two Codex
 * instances with different `homePath`s cannot step on each other.
 */
export const makeCodexAdapter = Effect.fn("makeCodexAdapter")(function* (
  codexConfig: CodexSettings,
  options?: CodexAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("codex");
  const fileSystem = yield* FileSystem.FileSystem;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* Effect.service(ServerConfig);
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, CodexAdapterSessionContext>();

  const startSession: CodexAdapterShape["startSession"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* Effect.suspend(() => stopSessionInternal(existing));
        }

        const serviceTier =
          input.modelSelection?.instanceId === boundInstanceId
            ? getCodexServiceTierOptionValue(input.modelSelection)
            : undefined;
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const t3EnvironmentEnv = input.t3Environment
          ? toT3EnvironmentEnv(input.t3Environment)
          : undefined;
        // The run's committer stamp (t3code-e6l) is unconditional, unlike
        // `t3Environment` (optional per session, MCP-derived) — it must reach
        // the spawn env whether or not an MCP session exists.
        const gitCommitterEnv = input.gitCommitterIdentity
          ? toGitCommitterEnv(input.gitCommitterIdentity)
          : undefined;
        const runtimeInput: CodexSessionRuntimeOptions = {
          threadId: input.threadId,
          providerInstanceId: boundInstanceId,
          cwd: input.cwd ?? process.cwd(),
          binaryPath: codexConfig.binaryPath,
          launchArgs: resolveCodexLaunchArgs(codexConfig.launchArgs, options?.environment),
          ...(options?.environment ? { environment: options.environment } : {}),
          ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),
          ...(isCodexResumeCursorSchema(input.resumeCursor)
            ? { resumeCursor: input.resumeCursor }
            : {}),
          runtimeMode: input.runtimeMode,
          ...(input.workerScope !== undefined ? { workerScope: input.workerScope } : {}),
          ...(input.modelSelection?.instanceId === boundInstanceId
            ? { model: input.modelSelection.model }
            : {}),
          ...(serviceTier ? { serviceTier } : {}),
          ...(mcpSession
            ? {
                environment: {
                  ...(options?.environment ?? process.env),
                  ...t3EnvironmentEnv,
                  ...gitCommitterEnv,
                  T3_MCP_BEARER_TOKEN: mcpSession.authorizationHeader.replace(/^Bearer\s+/, ""),
                },
                appServerArgs: [
                  "-c",
                  `mcp_servers.t3-code.url=${mcpSession.endpoint}`,
                  "-c",
                  'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
                ],
              }
            : t3EnvironmentEnv || gitCommitterEnv
              ? {
                  environment: {
                    ...(options?.environment ?? process.env),
                    ...t3EnvironmentEnv,
                    ...gitCommitterEnv,
                  },
                }
              : {}),
        };
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );
        const createRuntime = options?.makeRuntime ?? makeCodexSessionRuntime;
        const runtime = yield* createRuntime(runtimeInput).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );

        const eventFiber = yield* Stream.runForEach(runtime.events, (event) =>
          Effect.gen(function* () {
            yield* writeNativeEvent(event);
            yield* recordRateLimitNotification(event);
            const runtimeEvents = mapToRuntimeEvents(event, event.threadId);
            if (runtimeEvents.length === 0) {
              yield* Effect.logDebug("ignoring unhandled Codex provider event", {
                method: event.method,
                threadId: event.threadId,
                turnId: event.turnId,
                itemId: event.itemId,
              });
              return;
            }
            yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
          }),
        ).pipe(Effect.forkChild);

        const started = yield* runtime.start().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
          Effect.onError(() =>
            runtime.close.pipe(
              Effect.andThen(Effect.ignore(Scope.close(sessionScope, Exit.void))),
              Effect.andThen(Fiber.interrupt(eventFiber)),
              Effect.ignore,
            ),
          ),
        );

        sessions.set(input.threadId, {
          threadId: input.threadId,
          scope: sessionScope,
          runtime,
          eventFiber,
          stopped: false,
        });
        sessionScopeTransferred = true;

        return started;
      }),
    );

  /**
   * Encodes a turn's attachments as Codex user input.
   *
   * An image keeps its data URL. A file has no member to ride in, so every file
   * in the turn is named once in a trailing text block pointing at its absolute
   * path; the `t3code-vzb.33` probe confirmed Codex reads those paths. Sending a
   * file as an image would hand Codex bytes it decodes as an image and corrupt
   * it. Replace this fallback once the app-server input union gains a file
   * member.
   */
  const resolveAttachments = Effect.fn("resolveAttachments")(function* (
    input: ProviderSendTurnInput,
  ) {
    const resolved: Array<CodexTurnAttachmentInput> = [];
    const filePaths: Array<AttachmentPathReference> = [];
    for (const attachment of input.attachments ?? []) {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Invalid attachment id '${attachment.id}'.`,
        });
      }

      if (attachment.type !== "image") {
        // A path reference needs no bytes, only proof that the file is there.
        const exists = yield* fileSystem
          .exists(attachmentPath)
          .pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: `Attachment file for '${attachment.id}' is missing.`,
          });
        }
        filePaths.push({ attachment, path: attachmentPath });
        continue;
      }

      const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: `Failed to read attachment file: ${cause.message}.`,
              cause,
            }),
        ),
      );
      resolved.push({
        type: "image",
        url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
      });
    }

    if (filePaths.length > 0) {
      resolved.push({ type: "text", text: formatAttachmentPathReferenceText(filePaths) });
    }
    return resolved;
  });

  const sendTurn: CodexAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const codexAttachments = yield* resolveAttachments(input);

    const session = yield* requireSession(input.threadId);
    const reasoningEffort =
      input.modelSelection?.instanceId === boundInstanceId
        ? getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort")
        : undefined;
    const serviceTier =
      input.modelSelection?.instanceId === boundInstanceId
        ? getCodexServiceTierOptionValue(input.modelSelection)
        : undefined;
    return yield* session.runtime
      .sendTurn({
        ...(input.input !== undefined ? { input: input.input } : {}),
        ...(input.modelSelection?.instanceId === boundInstanceId
          ? { model: input.modelSelection.model }
          : {}),
        ...(reasoningEffort
          ? {
              effort: reasoningEffort as EffectCodexSchema.V2TurnStartParams__ReasoningEffort,
            }
          : {}),
        ...(serviceTier ? { serviceTier } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
        ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
      })
      .pipe(Effect.mapError((cause) => mapCodexRuntimeError(input.threadId, "turn/start", cause)));
  });

  const requireSession = Effect.fn("requireSession")(function* (threadId: ThreadId) {
    const session = sessions.get(threadId);
    if (!session || session.stopped) {
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId,
      });
    }
    return session;
  });

  const interruptTurn: CodexAdapterShape["interruptTurn"] = (threadId, turnId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.interruptTurn(turnId)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "turn/interrupt", cause),
      ),
    );

  const readThread: CodexAdapterShape["readThread"] = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.readThread),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/read", cause),
      ),
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );

  const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns) => {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        }),
      );
    }

    return requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.rollbackThread(numTurns)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/rollback", cause),
      ),
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );
  };

  const respondToRequest: CodexAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.respondToRequest(requestId, decision)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "item/requestApproval/decision", cause),
      ),
    );

  const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.respondToUserInput(requestId, answers)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "item/tool/requestUserInput", cause),
      ),
    );

  const writeNativeEvent = Effect.fn("writeNativeEvent")(function* (event: ProviderEvent) {
    if (!nativeEventLogger) {
      return;
    }
    yield* nativeEventLogger.write(event, event.threadId);
  });

  /**
   * `account/rateLimits/updated` is a sparse rolling update, so only the
   * windows the payload actually carries become usage samples, and the same
   * snapshot is classified for a durable account-limit row. Both writes are
   * fail-soft: telemetry persistence must never stall the event stream, and
   * the runtime event mapping stays untouched either way.
   */
  const recordRateLimitNotification = Effect.fn("recordCodexRateLimitNotification")(function* (
    event: ProviderEvent,
  ) {
    const recordUsageSamples = options?.recordUsageSamples;
    const recordAccountLimit = options?.recordAccountLimit;
    if (
      event.method !== "account/rateLimits/updated" ||
      (recordUsageSamples === undefined && recordAccountLimit === undefined)
    ) {
      return;
    }
    const payload = readPayload(
      EffectCodexSchema.V2AccountRateLimitsUpdatedNotification,
      event.payload,
    );
    if (!payload) {
      return;
    }

    if (recordUsageSamples) {
      const samples: Array<ProviderUsageSample> = [];
      const addWindow = (
        window: Extract<ProviderUsageSample["window"], "primary" | "secondary">,
        value:
          | EffectCodexSchema.V2AccountRateLimitsUpdatedNotification__RateLimitWindow
          | null
          | undefined,
      ) => {
        if (
          !value ||
          typeof value.usedPercent !== "number" ||
          !Number.isFinite(value.usedPercent)
        ) {
          return;
        }
        samples.push({
          providerInstanceId: boundInstanceId,
          window,
          utilization: value.usedPercent,
          resetsAt: normalizeEpochResetsAt(value.resetsAt),
          source: "codex.app_server.notification",
          observedAt: event.createdAt,
        });
      };
      addWindow("primary", payload.rateLimits.primary);
      addWindow("secondary", payload.rateLimits.secondary);
      if (samples.length > 0) {
        yield* recordUsageSamples({ samples }).pipe(
          Effect.catch((cause) => Effect.logWarning("codex.usage-ledger.record-failed", { cause })),
        );
      }
    }

    if (recordAccountLimit) {
      const limitSignal = classifyCodexRateLimits(
        payload.rateLimits,
        event.createdAt,
        "codex.app_server.notification",
      );
      if (limitSignal) {
        yield* recordAccountLimit({
          ...limitSignal,
          providerInstanceId: boundInstanceId,
          driver: PROVIDER,
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("codex.account-limit.record-failed", { cause }),
          ),
        );
      }
    }
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    session: CodexAdapterSessionContext,
  ) {
    if (session.stopped) {
      return;
    }
    session.stopped = true;
    sessions.delete(session.threadId);
    yield* session.runtime.close.pipe(Effect.ignore);
    yield* Effect.ignore(Scope.close(session.scope, Exit.void));
    yield* Fiber.interrupt(session.eventFiber).pipe(Effect.ignore);
  });

  const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const session = sessions.get(threadId);
      if (!session) {
        return;
      }
      yield* stopSessionInternal(session);
    });

  const listSessions: CodexAdapterShape["listSessions"] = () =>
    Effect.forEach(
      Array.from(sessions.values()).filter((session) => !session.stopped),
      (session) => session.runtime.getSession,
      { concurrency: 1 },
    );

  const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(Boolean(sessions.get(threadId) && !sessions.get(threadId)?.stopped));

  const stopAll: CodexAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.asVoid);

  yield* Effect.acquireRelease(Effect.void, () =>
    stopAll().pipe(
      Effect.andThen(Queue.shutdown(runtimeEventQueue)),
      Effect.andThen(managedNativeEventLogger?.close() ?? Effect.void),
      Effect.ignore,
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: CODEX_ADAPTER_CAPABILITIES,
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies CodexAdapterShape;
});

// NOTE: the old `CodexAdapterLive` / `makeCodexAdapterLive` singleton Layer
// exports have been removed as part of the per-instance-driver refactor.
// `makeCodexAdapter(codexConfig, options?)` is now invoked directly by
// `CodexDriver.create()` for each configured instance; downstream consumers
// (server bootstrap, integration harness, this module's tests) will be
// migrated to the registry in a follow-up pass.
