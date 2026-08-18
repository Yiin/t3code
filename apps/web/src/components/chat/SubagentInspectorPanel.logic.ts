import {
  decodeSubagentTranscriptActivityPayload,
  SUBAGENT_TEXT_ACTIVITY_KIND,
  SUBAGENT_THINKING_ACTIVITY_KIND,
  type OrchestrationThreadActivity,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { mergeSubagentActivities } from "@t3tools/client-runtime/state/subagent-activity";
import * as Option from "effect/Option";

import { getProviderDisplayName } from "../../providerModels";
import { deriveWorkLogEntries, type WorkLogEntry } from "../../session-logic";

export function selectSubagentTranscriptEntries(input: {
  readonly backfillPages: ReadonlyArray<ReadonlyArray<OrchestrationThreadActivity>> | null;
  readonly liveTail: ReadonlyArray<OrchestrationThreadActivity>;
  readonly fallbackEntries: ReadonlyArray<WorkLogEntry>;
}): ReadonlyArray<WorkLogEntry> {
  if (input.backfillPages === null) return input.fallbackEntries;

  return deriveWorkLogEntries(mergeSubagentActivities(input.backfillPages, input.liveTail));
}

export function selectSubagentInspectorPlaceholder(input: {
  readonly entryCount: number;
  readonly isPending: boolean;
  readonly prompt: string | null;
  readonly resultText: string | null;
}): "loading" | "unavailable" | null {
  if (input.entryCount > 0 || input.prompt !== null || input.resultText !== null) {
    return null;
  }
  return input.isPending ? "loading" : "unavailable";
}

export interface SubagentTranscriptRow {
  kind: "text" | "thinking";
  text: string;
  truncated: boolean;
}

export function decodeSubagentTranscriptRow(entry: WorkLogEntry): SubagentTranscriptRow | null {
  if (
    entry.sourceActivityKind !== SUBAGENT_TEXT_ACTIVITY_KIND &&
    entry.sourceActivityKind !== SUBAGENT_THINKING_ACTIVITY_KIND
  ) {
    return null;
  }

  const payload = Option.getOrUndefined(
    decodeSubagentTranscriptActivityPayload(entry.sourceActivityPayload),
  );
  if (!payload) return null;

  return {
    kind: entry.sourceActivityKind === SUBAGENT_TEXT_ACTIVITY_KIND ? "text" : "thinking",
    text: payload.text,
    truncated: payload.truncated === true,
  };
}

export interface SubagentUsageSummary {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

function numericField(record: Record<string, unknown>, snakeCase: string, camelCase: string) {
  for (const value of [record[snakeCase], record[camelCase]]) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

export function summarizeSubagentUsage(usage: unknown): SubagentUsageSummary {
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return { inputTokens: null, outputTokens: null, totalTokens: null };
  }

  const record = usage as Record<string, unknown>;
  const input = numericField(record, "input_tokens", "inputTokens");
  const cacheRead = numericField(record, "cache_read_input_tokens", "cacheReadInputTokens");
  const cacheCreation = numericField(
    record,
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
  );
  const inputParts = [input, cacheRead, cacheCreation].filter(
    (value): value is number => value !== null,
  );
  const inputTokens =
    inputParts.length > 0 ? inputParts.reduce((sum, value) => sum + value, 0) : null;
  const outputTokens = numericField(record, "output_tokens", "outputTokens");
  const totalTokens =
    inputTokens === null && outputTokens === null ? null : (inputTokens ?? 0) + (outputTokens ?? 0);

  return { inputTokens, outputTokens, totalTokens };
}

/**
 * Which driver will carry an attachment the drawer sends to a child thread.
 *
 * The child's own session names the instance; the provider snapshot list turns
 * that into a driver kind. A child whose session has not reported an instance
 * yet resolves to `null`, and a null driver skips the capability gate rather
 * than refusing a file on a guess.
 */
type ChildThreadAttachmentProvider = {
  readonly driver: ProviderDriverKind | null;
  readonly label: string;
};

export function resolveChildThreadAttachmentProvider(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId | undefined,
): ChildThreadAttachmentProvider {
  const match =
    instanceId === undefined
      ? undefined
      : providers.find((provider) => provider.instanceId === instanceId);
  if (match === undefined) return { driver: null, label: "This subagent's provider" };
  return { driver: match.driver, label: getProviderDisplayName(providers, match.driver) };
}
