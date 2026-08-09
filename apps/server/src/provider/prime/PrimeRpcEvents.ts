import * as Schema from "effect/Schema";

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const Message = Schema.Struct({
  id: Schema.optional(Schema.String),
  role: Schema.String,
  content: Schema.optional(Schema.Unknown),
  stopReason: Schema.optional(Schema.NullOr(Schema.String)),
  errorMessage: Schema.optional(Schema.String),
});
const AssistantMessageEvent = Schema.Struct({
  type: Schema.String,
  contentIndex: Schema.optional(Schema.Int),
  delta: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  error: Schema.optional(Message),
});

export const PrimeRpcAgentEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("agent_start") }),
  Schema.Struct({
    type: Schema.Literal("bash_execution_update"),
    id: Schema.optional(Schema.String),
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("agent_end"),
    messages: Schema.optional(Schema.Array(Schema.Unknown)),
    willRetry: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("agent_settled") }),
  Schema.Struct({ type: Schema.Literal("turn_start") }),
  Schema.Struct({
    type: Schema.Literal("queue_update"),
    steering: Schema.Array(Schema.String),
    followUp: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("turn_end"),
    message: Schema.optional(Message),
    toolResults: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
  Schema.Struct({ type: Schema.Literal("message_start"), message: Message }),
  Schema.Struct({
    type: Schema.Literal("message_update"),
    message: Message,
    assistantMessageEvent: AssistantMessageEvent,
  }),
  Schema.Struct({ type: Schema.Literal("message_end"), message: Message }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_start"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_update"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
    partialResult: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_end"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    result: Schema.Unknown,
    isError: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("compaction_start"), reason: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("compaction_end"),
    reason: Schema.String,
    result: Schema.optional(Schema.NullOr(Schema.Unknown)),
    aborted: Schema.Boolean,
    willRetry: Schema.Boolean,
    errorMessage: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("auto_retry_start"),
    attempt: Schema.Int,
    maxAttempts: Schema.Int,
    delayMs: Schema.Number,
    errorMessage: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("auto_retry_end"),
    success: Schema.Boolean,
    attempt: Schema.Int,
    finalError: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("summarization_retry_scheduled"),
    attempt: Schema.Int,
    maxAttempts: Schema.Int,
    delayMs: Schema.Number,
    errorMessage: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("summarization_retry_attempt_start"),
    source: Schema.Literals(["branchSummary", "compaction"]),
    reason: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("summarization_retry_finished") }),
  Schema.Struct({
    type: Schema.Literal("extension_error"),
    extensionPath: Schema.String,
    event: Schema.String,
    error: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("subagent_start"),
    taskId: Schema.String,
    description: Schema.optional(Schema.String),
    agentType: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("subagent_update"),
    taskId: Schema.String,
    description: Schema.String,
    summary: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("subagent_end"),
    taskId: Schema.String,
    status: Schema.Literals(["completed", "failed", "stopped"]),
    summary: Schema.optional(Schema.String),
  }),
]);
export type PrimeRpcAgentEvent = typeof PrimeRpcAgentEvent.Type;

export const PrimeRpcExtensionUiRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("select"),
    title: Schema.String,
    options: Schema.Array(Schema.String),
    timeout: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("confirm"),
    title: Schema.String,
    message: Schema.String,
    timeout: Schema.optional(Schema.Number),
  }),
]);
export type PrimeRpcExtensionUiRequest = typeof PrimeRpcExtensionUiRequest.Type;

export const PrimeRpcExtensionUiResponseEvent = Schema.Struct({
  type: Schema.Literal("extension_ui_response"),
  id: Schema.String,
  value: Schema.optional(Schema.String),
  confirmed: Schema.optional(Schema.Boolean),
  cancelled: Schema.optional(Schema.Boolean),
});
export type PrimeRpcExtensionUiResponseEvent = typeof PrimeRpcExtensionUiResponseEvent.Type;

export const PrimeRpcMappableEvent = Schema.Union([
  PrimeRpcAgentEvent,
  PrimeRpcExtensionUiRequest,
  PrimeRpcExtensionUiResponseEvent,
]);
export type PrimeRpcMappableEvent = typeof PrimeRpcMappableEvent.Type;

export const PrimeRpcUnknownEvent = Schema.Struct({
  type: Schema.String,
  payload: Schema.optional(UnknownRecord),
});
