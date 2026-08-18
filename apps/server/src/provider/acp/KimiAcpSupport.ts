import { type KimiSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { type AcpToolCallState, findSessionConfigOption } from "./AcpRuntimeModel.ts";

const KIMI_DRIVER_KIND = ProviderDriverKind.make("kimi");
const KIMI_DEFAULT_MODEL = "kimi-code/k3";

type KimiAcpRuntimeKimiSettings = Pick<KimiSettings, "binaryPath">;

export interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildKimiAcpSpawnInput(
  kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kimiSettings?.binaryPath || "kimi",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeKimiAcpRuntime = (
  input: KimiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKimiAcpSpawnInput(input.kimiSettings, input.cwd, input.environment),
        authMethodId: "login",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveKimiAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : KIMI_DEFAULT_MODEL;
  return normalizeModelSlug(base, KIMI_DRIVER_KIND) ?? KIMI_DEFAULT_MODEL;
}

export function currentKimiModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const option = findSessionConfigOption(sessionSetupResult.configOptions, "model");
  if (option?.type !== "select") {
    return undefined;
  }
  return option.currentValue.trim() || undefined;
}

export function applyKimiAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setModel">;
  readonly model: string | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  return input.runtime
    .setModel(resolveKimiAcpBaseModelId(input.model))
    .pipe(Effect.mapError(input.mapError), Effect.asVoid);
}

// --- Subagent detection heuristic (kimi-specific) ---------------------------
//
// Kimi conveys subagent activity over stock ACP tool calls — no vendor
// extension or _meta field is involved. Live-verified against a captured
// session ($stateDir/logs/provider/40a5b1d3-….log:272,294):
//
// Spawn: a `tool_call_update` with kind "other" whose rawInput carries a
// string `subagent_type` (alongside `description`/`prompt`). The title on
// first sighting looks like "Launching explore agent: …" but reverts to the
// generic "Tool" on later streaming updates, so detection gates on rawInput,
// never on title text.
//
// Completion: the terminal update's content text begins with an
// "agent_id/actual_subagent_type/status" header. `actual_subagent_type` is
// the type kimi actually used and is trusted over the spawn-time request.

export const KIMI_SUBAGENT_COMPLETION_PATTERN =
  /^agent_id:\s*(\S+)\nactual_subagent_type:\s*(\S+)\nstatus:\s*(completed|failed)\b/m;

export interface KimiSubagentTaskStart {
  readonly toolCallId: string;
  readonly subagentType: string;
  readonly description?: string;
  readonly prompt?: string;
}

export interface KimiSubagentTaskCompletion {
  readonly toolCallId: string;
  readonly status: "completed" | "failed";
  readonly agentId?: string;
  readonly subagentType?: string;
  readonly summary?: string;
}

export interface KimiSubagentTaskSignals {
  /** True when the tool call has been classified as a subagent spawn. */
  readonly isSubagentToolCall: boolean;
  readonly started?: KimiSubagentTaskStart;
  readonly completed?: KimiSubagentTaskCompletion;
}

export interface KimiSubagentTaskTracker {
  readonly startedToolCallIds: Set<string>;
  readonly completedToolCallIds: Set<string>;
}

export function makeKimiSubagentTaskTracker(): KimiSubagentTaskTracker {
  return { startedToolCallIds: new Set(), completedToolCallIds: new Set() };
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

function detectKimiSubagentSpawnInfo(
  toolCall: AcpToolCallState,
): Omit<KimiSubagentTaskStart, "toolCallId"> | undefined {
  if (toolCall.kind !== "other") {
    return undefined;
  }
  const rawInput = toolCall.data.rawInput;
  if (!isRecord(rawInput)) {
    return undefined;
  }
  const subagentType = nonEmptyString(rawInput.subagent_type);
  if (!subagentType) {
    return undefined;
  }
  const description = nonEmptyString(rawInput.description);
  const prompt = nonEmptyString(rawInput.prompt);
  return {
    subagentType,
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

function extractToolCallText(toolCall: AcpToolCallState): string | undefined {
  const content = toolCall.data.content;
  if (Array.isArray(content)) {
    const chunks: Array<string> = [];
    for (const entry of content) {
      if (!isRecord(entry) || entry.type !== "content") {
        continue;
      }
      const nested = entry.content;
      if (!isRecord(nested) || nested.type !== "text" || typeof nested.text !== "string") {
        continue;
      }
      if (nested.text.length > 0) {
        chunks.push(nested.text);
      }
    }
    if (chunks.length > 0) {
      return chunks.join("\n");
    }
  }
  return toolCall.detail;
}

/**
 * Classifies a (merged) kimi tool-call state and returns at most one
 * `started` and one `completed` signal per toolCallId; the tracker holds the
 * per-session dedupe state. A terminal update whose content matches the
 * completion header is trusted even when the spawn update was never seen
 * (e.g. session replay), in which case a synthetic `started` accompanies it.
 */
export function trackKimiSubagentToolCall(
  tracker: KimiSubagentTaskTracker,
  toolCall: AcpToolCallState,
): KimiSubagentTaskSignals {
  const toolCallId = toolCall.toolCallId;
  const alreadyStarted = tracker.startedToolCallIds.has(toolCallId);
  const spawnInfo = detectKimiSubagentSpawnInfo(toolCall);
  const isTerminal = toolCall.status === "completed" || toolCall.status === "failed";
  const text = isTerminal ? extractToolCallText(toolCall) : undefined;
  const match = text !== undefined ? KIMI_SUBAGENT_COMPLETION_PATTERN.exec(text) : null;
  const matchedAgentId = match ? nonEmptyString(match[1]) : undefined;
  const matchedSubagentType = match ? nonEmptyString(match[2]) : undefined;

  if (!alreadyStarted && spawnInfo === undefined && match === null) {
    return { isSubagentToolCall: false };
  }

  let started: KimiSubagentTaskStart | undefined;
  if (!alreadyStarted) {
    tracker.startedToolCallIds.add(toolCallId);
    started = {
      toolCallId,
      ...(spawnInfo ?? { subagentType: matchedSubagentType ?? "unknown" }),
    };
  }

  let completed: KimiSubagentTaskCompletion | undefined;
  if (isTerminal && !tracker.completedToolCallIds.has(toolCallId)) {
    tracker.completedToolCallIds.add(toolCallId);
    if (match !== null && text !== undefined) {
      const summary = text.slice(match.index + match[0].length).trim();
      completed = {
        toolCallId,
        status: match[3] === "failed" ? "failed" : "completed",
        ...(matchedAgentId ? { agentId: matchedAgentId } : {}),
        ...(matchedSubagentType ? { subagentType: matchedSubagentType } : {}),
        ...(summary.length > 0 ? { summary } : {}),
      };
    } else {
      const summary = text?.trim();
      completed = {
        toolCallId,
        status: toolCall.status === "failed" ? "failed" : "completed",
        ...(summary !== undefined && summary.length > 0 ? { summary } : {}),
      };
    }
  }

  return {
    isSubagentToolCall: true,
    ...(started ? { started } : {}),
    ...(completed ? { completed } : {}),
  };
}
