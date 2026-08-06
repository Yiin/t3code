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
