import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";

import type { PrimeRpcMappableEvent } from "./PrimeRpcEvents.ts";

export interface PrimeEventMapperContext {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly createdAt: string;
  readonly sequence: number;
  readonly rawEvent?: unknown;
}

export interface PrimeEventMapperState {
  readonly activeMessageId?: string;
  readonly activeCompactionId?: string;
  readonly terminalTurn: boolean;
  readonly completedItems: ReadonlySet<string>;
  readonly pendingRequestIds: ReadonlySet<string>;
  readonly pendingTerminal?:
    | {
        readonly reason: "aborted" | "error";
        readonly message: string;
        readonly emittedError: boolean;
      }
    | undefined;
}

export interface PrimeEventMapperResult {
  readonly state: PrimeEventMapperState;
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
}

export const initialPrimeEventMapperState = (): PrimeEventMapperState => ({
  terminalTurn: false,
  completedItems: new Set(),
  pendingRequestIds: new Set(),
});

/** Settle requests when the adapter interrupts, stops, or loses the Prime process. */
export function settlePrimePermissionRequests(
  state: PrimeEventMapperState,
  context: PrimeEventMapperContext,
  reason: "interrupt" | "stop" | "crash",
): PrimeEventMapperResult {
  const decision = reason === "crash" ? "decline" : "cancel";
  const events = Array.from(
    state.pendingRequestIds,
    (requestId, index): ProviderRuntimeEvent => ({
      eventId: EventId.make(`prime:${context.turnId}:${context.sequence}:settle:${index}`),
      provider: ProviderDriverKind.make("primeAgent"),
      ...(context.providerInstanceId ? { providerInstanceId: context.providerInstanceId } : {}),
      threadId: context.threadId,
      turnId: context.turnId,
      createdAt: context.createdAt,
      type: "request.resolved",
      requestId: RuntimeRequestId.make(requestId),
      providerRefs: { providerRequestId: requestId },
      raw: {
        source: "prime.rpc",
        messageType: "t3.permission.settle",
        payload: { reason },
      },
      payload: { requestType: "command_execution_approval", decision },
    }),
  );
  return { state: { ...state, pendingRequestIds: new Set() }, events };
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const textFromResult = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const content = "content" in value ? value.content : undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const candidate = "text" in part ? part.text : undefined;
    return typeof candidate === "string" ? [candidate] : [];
  });
  return text.length > 0 ? text.join("\n") : undefined;
};

const itemTypeForTool = (
  toolName: string,
): "command_execution" | "file_change" | "dynamic_tool_call" => {
  if (["bash", "python", "ipython"].includes(toolName)) return "command_execution";
  if (["edit", "write", "apply_patch"].includes(toolName)) return "file_change";
  return "dynamic_tool_call";
};

export function mapPrimeRpcEvent(
  state: PrimeEventMapperState,
  event: PrimeRpcMappableEvent,
  context: PrimeEventMapperContext,
): PrimeEventMapperResult {
  const base = {
    provider: ProviderDriverKind.make("primeAgent"),
    ...(context.providerInstanceId ? { providerInstanceId: context.providerInstanceId } : {}),
    threadId: context.threadId,
    turnId: context.turnId,
    createdAt: context.createdAt,
    raw: {
      source: "prime.rpc" as const,
      messageType: event.type,
      payload: context.rawEvent ?? event,
    },
  };
  let ordinal = 0;
  const emit = <T extends Omit<ProviderRuntimeEvent, "eventId">>(mapped: T) =>
    ({
      ...mapped,
      eventId: EventId.make(`prime:${context.turnId}:${context.sequence}:${ordinal++}`),
    }) as ProviderRuntimeEvent;
  const result = (next: PrimeEventMapperState, ...events: ProviderRuntimeEvent[]) => ({
    state: next,
    events,
  });
  const unchanged = (...events: ProviderRuntimeEvent[]) => result(state, ...events);
  const settlePendingRequests = (decision: "cancel" | "decline") =>
    Array.from(state.pendingRequestIds, (requestId) =>
      emit({
        ...base,
        type: "request.resolved",
        requestId: RuntimeRequestId.make(requestId),
        providerRefs: { providerRequestId: requestId },
        payload: { requestType: "command_execution_approval", decision },
      }),
    );

  switch (event.type) {
    case "agent_start":
      return state.terminalTurn
        ? unchanged()
        : unchanged(emit({ ...base, type: "turn.started", payload: {} }));
    case "agent_settled":
      if (state.terminalTurn) return unchanged();
      if (state.pendingTerminal?.reason === "aborted") {
        return result(
          { ...state, terminalTurn: true, pendingRequestIds: new Set() },
          ...settlePendingRequests("cancel"),
          emit({
            ...base,
            type: "turn.aborted",
            payload: { reason: state.pendingTerminal.message },
          }),
        );
      }
      if (state.pendingTerminal?.reason === "error") {
        return result(
          { ...state, terminalTurn: true, pendingRequestIds: new Set() },
          ...settlePendingRequests("cancel"),
          ...(state.pendingTerminal.emittedError
            ? []
            : [
                emit({
                  ...base,
                  type: "runtime.error",
                  payload: {
                    message: state.pendingTerminal.message,
                    class: "provider_error",
                  },
                }),
              ]),
          emit({
            ...base,
            type: "turn.completed",
            payload: { state: "failed", errorMessage: state.pendingTerminal.message },
          }),
        );
      }
      return result(
        { ...state, terminalTurn: true, pendingRequestIds: new Set() },
        ...settlePendingRequests("cancel"),
        emit({ ...base, type: "turn.completed", payload: { state: "completed" } }),
      );
    case "message_start": {
      if (event.message.role !== "assistant") return unchanged();
      const id = nonEmpty(event.message.id) ?? `message-${context.sequence}`;
      return result(
        { ...state, activeMessageId: id },
        emit({
          ...base,
          type: "item.started",
          itemId: RuntimeItemId.make(id),
          providerRefs: { providerItemId: ProviderItemId.make(id) },
          payload: { itemType: "assistant_message", status: "inProgress" },
        }),
      );
    }
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (event.message.role !== "assistant") return unchanged();
      if ((update.type === "text_delta" || update.type === "thinking_delta") && update.delta) {
        const id =
          nonEmpty(event.message.id) ?? state.activeMessageId ?? `message-${context.sequence}`;
        return unchanged(
          emit({
            ...base,
            type: "content.delta",
            itemId: RuntimeItemId.make(id),
            providerRefs: { providerItemId: ProviderItemId.make(id) },
            payload: {
              streamKind: update.type === "text_delta" ? "assistant_text" : "reasoning_text",
              delta: update.delta,
              ...(update.contentIndex === undefined ? {} : { contentIndex: update.contentIndex }),
            },
          }),
        );
      }
      if (update.type === "error") {
        const reason = nonEmpty(update.reason) ?? "error";
        const message =
          nonEmpty(update.error?.errorMessage) ?? nonEmpty(event.message.errorMessage) ?? reason;
        return state.terminalTurn
          ? unchanged()
          : result({
              ...state,
              pendingTerminal: {
                reason: reason === "aborted" ? "aborted" : "error",
                message,
                emittedError: false,
              },
            });
      }
      return unchanged();
    }
    case "message_end": {
      if (event.message.role !== "assistant") return unchanged();
      const id =
        nonEmpty(event.message.id) ?? state.activeMessageId ?? `message-${context.sequence}`;
      if (state.completedItems.has(id)) return unchanged();
      const completedItems = new Set(state.completedItems).add(id);
      const { activeMessageId: _activeMessageId, ...stateWithoutMessage } = state;
      return result(
        { ...stateWithoutMessage, completedItems },
        emit({
          ...base,
          type: "item.completed",
          itemId: RuntimeItemId.make(id),
          providerRefs: { providerItemId: ProviderItemId.make(id) },
          payload: { itemType: "assistant_message", status: "completed" },
        }),
      );
    }
    case "tool_execution_start":
      return unchanged(
        emit({
          ...base,
          type: "item.started",
          itemId: RuntimeItemId.make(event.toolCallId),
          providerRefs: { providerItemId: ProviderItemId.make(event.toolCallId) },
          payload: {
            itemType: itemTypeForTool(event.toolName),
            status: "inProgress",
            title: event.toolName,
            data: { args: event.args },
          },
        }),
      );
    case "bash_execution_update":
      return unchanged(
        emit({
          ...base,
          type: "content.delta",
          itemId: RuntimeItemId.make(event.id ?? `prime-bash:${context.turnId}:direct`),
          payload: { streamKind: "command_output", delta: event.delta },
        }),
      );
    case "tool_execution_update":
      return unchanged(
        emit({
          ...base,
          type: "item.updated",
          itemId: RuntimeItemId.make(event.toolCallId),
          providerRefs: { providerItemId: ProviderItemId.make(event.toolCallId) },
          payload: {
            itemType: itemTypeForTool(event.toolName),
            status: "inProgress",
            title: event.toolName,
            data: event.partialResult,
          },
        }),
      );
    case "tool_execution_end": {
      if (state.completedItems.has(event.toolCallId)) return unchanged();
      const completedItems = new Set(state.completedItems).add(event.toolCallId);
      return result(
        { ...state, completedItems },
        emit({
          ...base,
          type: "item.completed",
          itemId: RuntimeItemId.make(event.toolCallId),
          providerRefs: { providerItemId: ProviderItemId.make(event.toolCallId) },
          payload: {
            itemType: itemTypeForTool(event.toolName),
            status: event.isError ? "failed" : "completed",
            title: event.toolName,
            ...(textFromResult(event.result) ? { detail: textFromResult(event.result) } : {}),
            data: event.result,
          },
        }),
      );
    }
    case "compaction_start": {
      const id = `compaction-${context.sequence}`;
      return result(
        { ...state, activeCompactionId: id },
        emit({
          ...base,
          type: "item.started",
          itemId: RuntimeItemId.make(id),
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            detail: event.reason,
          },
        }),
      );
    }
    case "compaction_end": {
      const id = state.activeCompactionId ?? `compaction-${context.sequence}`;
      const failed = event.aborted || (!event.result && Boolean(event.errorMessage));
      const { activeCompactionId: _activeCompactionId, ...stateWithoutCompaction } = state;
      return result(
        stateWithoutCompaction,
        emit({
          ...base,
          type: "item.completed",
          itemId: RuntimeItemId.make(id),
          payload: {
            itemType: "context_compaction",
            status: failed ? "failed" : "completed",
            detail: event.errorMessage ?? event.reason,
            data: event.result,
          },
        }),
        emit({
          ...base,
          type: "thread.state.changed",
          payload: { state: failed ? "active" : "compacted", detail: event },
        }),
      );
    }
    case "auto_retry_start":
      return result(
        { ...state, pendingTerminal: undefined },
        emit({
          ...base,
          type: "runtime.warning",
          payload: {
            message: `Prime retry ${event.attempt}/${event.maxAttempts}`,
            detail: event,
          },
        }),
      );
    case "auto_retry_end":
      return event.success
        ? result({ ...state, pendingTerminal: undefined })
        : result(
            {
              ...state,
              pendingTerminal: {
                reason: "error",
                message: event.finalError ?? `Prime retry ${event.attempt} failed`,
                emittedError: true,
              },
            },
            emit({
              ...base,
              type: "runtime.error",
              payload: {
                message: event.finalError ?? `Prime retry ${event.attempt} failed`,
                class: "provider_error",
                detail: event,
              },
            }),
          );
    case "queue_update":
      return unchanged(
        emit({
          ...base,
          type: "thread.state.changed",
          payload: {
            state: event.steering.length + event.followUp.length > 0 ? "active" : "idle",
            detail: event,
          },
        }),
      );
    case "summarization_retry_scheduled":
      return unchanged(
        emit({
          ...base,
          type: "runtime.warning",
          payload: {
            message: `Prime summarization retry ${event.attempt}/${event.maxAttempts}`,
            detail: event,
          },
        }),
      );
    case "summarization_retry_attempt_start":
      return unchanged(
        emit({
          ...base,
          type: "item.updated",
          itemId: RuntimeItemId.make(state.activeCompactionId ?? "prime-summarization"),
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            detail: event.reason ?? event.source,
          },
        }),
      );
    case "summarization_retry_finished":
      return unchanged(
        emit({
          ...base,
          type: "runtime.warning",
          payload: { message: "Prime summarization retry finished", detail: event },
        }),
      );
    case "extension_error":
      return result(
        { ...state, pendingRequestIds: new Set() },
        ...settlePendingRequests("decline"),
        emit({
          ...base,
          type: "runtime.error",
          payload: { message: event.error, class: "provider_error", detail: event },
        }),
      );
    case "extension_ui_request": {
      const pendingRequestIds = new Set(state.pendingRequestIds).add(event.id);
      return result(
        { ...state, pendingRequestIds },
        emit({
          ...base,
          type: "request.opened",
          requestId: RuntimeRequestId.make(event.id),
          providerRefs: { providerRequestId: event.id },
          payload: {
            requestType: "command_execution_approval",
            detail: event.title,
            args: event,
          },
        }),
      );
    }
    case "extension_ui_response": {
      if (!state.pendingRequestIds.has(event.id)) return unchanged();
      const pendingRequestIds = new Set(state.pendingRequestIds);
      pendingRequestIds.delete(event.id);
      return result(
        { ...state, pendingRequestIds },
        emit({
          ...base,
          type: "request.resolved",
          requestId: RuntimeRequestId.make(event.id),
          providerRefs: { providerRequestId: event.id },
          payload: {
            requestType: "command_execution_approval",
            decision: event.cancelled
              ? "cancel"
              : (event.value ?? String(event.confirmed ?? false)),
            resolution: event,
          },
        }),
      );
    }
    case "subagent_start":
      return unchanged(
        emit({
          ...base,
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.make(event.taskId),
            ...(event.description ? { description: event.description } : {}),
            ...(event.agentType ? { taskType: event.agentType } : {}),
          },
        }),
      );
    case "subagent_update":
      return unchanged(
        emit({
          ...base,
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.make(event.taskId),
            description: event.description,
            ...(event.summary ? { summary: event.summary } : {}),
          },
        }),
      );
    case "subagent_end":
      return unchanged(
        emit({
          ...base,
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.make(event.taskId),
            status: event.status,
            ...(event.summary ? { summary: event.summary } : {}),
          },
        }),
      );
    case "agent_end":
    case "turn_start":
    case "turn_end":
      return unchanged();
  }
}
