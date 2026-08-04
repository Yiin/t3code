/**
 * Public Docs: https://cursor.com/docs/cli/acp#cursor-extension-methods
 * Additional reference provided by the Cursor team: https://anysphere.enterprise.slack.com/files/U068SSJE141/F0APT1HSZRP/cursor-acp-extension-method-schemas.md
 */
import type { UserInputQuestion } from "@t3tools/contracts";
import * as AcpSchema from "effect-acp/schema";
import * as Schema from "effect/Schema";

const CursorAskQuestionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});

const CursorAskQuestion = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  options: Schema.Array(CursorAskQuestionOption),
  allowMultiple: Schema.optional(Schema.Boolean),
});

export const CursorAskQuestionRequest = Schema.Struct({
  toolCallId: Schema.String,
  title: Schema.optional(Schema.String),
  questions: Schema.Array(CursorAskQuestion),
});

const CursorTodoStatus = Schema.String;

const CursorTodo = Schema.Struct({
  id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  status: Schema.optional(CursorTodoStatus),
});

const CursorPlanPhase = Schema.Struct({
  name: Schema.String,
  todos: Schema.Array(CursorTodo),
});

export const CursorCreatePlanRequest = Schema.Struct({
  toolCallId: Schema.String,
  name: Schema.optional(Schema.String),
  overview: Schema.optional(Schema.String),
  plan: Schema.String,
  todos: Schema.Array(CursorTodo),
  isProject: Schema.optional(Schema.Boolean),
  phases: Schema.optional(Schema.Array(CursorPlanPhase)),
});

export const CursorUpdateTodosRequest = Schema.Struct({
  toolCallId: Schema.String,
  todos: Schema.Array(CursorTodo),
  merge: Schema.Boolean,
});

const CursorAvailableModel = Schema.Struct({
  value: Schema.String,
  name: Schema.String,
  configOptions: Schema.optional(Schema.Array(AcpSchema.SessionConfigOption)),
});

export const CursorListAvailableModelsResponse = Schema.Struct({
  models: Schema.Array(CursorAvailableModel),
});

export function extractAskQuestions(
  params: typeof CursorAskQuestionRequest.Type,
): ReadonlyArray<UserInputQuestion> {
  return params.questions.map((question) => ({
    id: question.id,
    header: "Question",
    question: question.prompt,
    multiSelect: question.allowMultiple === true,
    options:
      question.options.length > 0
        ? question.options.map((option) => ({
            label: option.label,
            description: option.label,
          }))
        : [{ label: "OK", description: "Continue" }],
  }));
}

export function extractPlanMarkdown(params: typeof CursorCreatePlanRequest.Type): string {
  return params.plan || "# Plan\n\n(Cursor did not supply plan text.)";
}

/**
 * cursor/task — a notification about subagent task activity, per the public
 * docs (fields: toolCallId, description, prompt, subagentType — a string enum
 * or `{ custom }` — plus optional model, agentId, durationMs). No live
 * capture of this method exists yet, so parsing is deliberately
 * schema-tolerant: anything without a usable toolCallId returns undefined
 * and the caller logs and ignores it rather than failing the session.
 */
export interface CursorTaskSignal {
  readonly toolCallId: string;
  readonly subagentType?: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly model?: string;
  readonly agentId?: string;
  readonly durationMs?: number;
  /**
   * True when the notification carries a terminal signal: the docs describe
   * durationMs as "how long the task ran", so its presence (or a terminal
   * status-like field) marks completion.
   */
  readonly terminal: boolean;
  readonly status: "completed" | "failed" | "stopped";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const CURSOR_TASK_FAILED_STATUSES = new Set(["failed", "error", "errored"]);
const CURSOR_TASK_STOPPED_STATUSES = new Set([
  "stopped",
  "cancelled",
  "canceled",
  "aborted",
  "killed",
]);
const CURSOR_TASK_COMPLETED_STATUSES = new Set(["completed", "complete", "success", "done"]);

export function parseCursorTaskNotification(params: unknown): CursorTaskSignal | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const toolCallId = nonEmptyString(params.toolCallId);
  if (!toolCallId) {
    return undefined;
  }
  const subagentTypeRaw = params.subagentType;
  const subagentType =
    nonEmptyString(subagentTypeRaw) ??
    (isRecord(subagentTypeRaw) ? nonEmptyString(subagentTypeRaw.custom) : undefined);
  const description = nonEmptyString(params.description);
  const prompt = nonEmptyString(params.prompt);
  const model = nonEmptyString(params.model);
  const agentId = nonEmptyString(params.agentId);
  const durationMs =
    typeof params.durationMs === "number" && Number.isFinite(params.durationMs)
      ? params.durationMs
      : undefined;
  const statusText = nonEmptyString(params.status)?.toLowerCase();
  const failed = statusText !== undefined && CURSOR_TASK_FAILED_STATUSES.has(statusText);
  const stopped = statusText !== undefined && CURSOR_TASK_STOPPED_STATUSES.has(statusText);
  const completedStatus =
    statusText !== undefined && CURSOR_TASK_COMPLETED_STATUSES.has(statusText);
  return {
    toolCallId,
    ...(subagentType ? { subagentType } : {}),
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    ...(agentId ? { agentId } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    terminal: durationMs !== undefined || failed || stopped || completedStatus,
    status: failed ? "failed" : stopped ? "stopped" : "completed",
  };
}

export function extractTodosAsPlan(params: typeof CursorUpdateTodosRequest.Type): {
  readonly explanation?: string;
  readonly plan: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
} {
  const plan = params.todos.flatMap((todo) => {
    const step = todo.content?.trim() ?? todo.title?.trim() ?? "";
    if (step === "") {
      return [];
    }
    const status: "pending" | "inProgress" | "completed" =
      todo.status === "completed"
        ? "completed"
        : todo.status === "in_progress" || todo.status === "inProgress"
          ? "inProgress"
          : "pending";
    return [{ step, status }];
  });
  return { plan };
}
