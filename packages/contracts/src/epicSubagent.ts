import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * One injected subagent definition. A structural subset of the Claude Agent
 * SDK's `AgentDefinition` (`@anthropic-ai/claude-agent-sdk` sdk.d.ts:38-92):
 * only the fields the epic runner sets. `model` carries the role's tier hop,
 * and omitting it makes the subagent inherit the session model.
 */
export const EpicSubagentDefinition = Schema.Struct({
  description: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  model: Schema.optional(TrimmedNonEmptyString),
  tools: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type EpicSubagentDefinition = typeof EpicSubagentDefinition.Type;

/** Agent name to definition, matching the SDK's `agents` option keying. */
export const EpicSubagentMap = Schema.Record(TrimmedNonEmptyString, EpicSubagentDefinition);
export type EpicSubagentMap = typeof EpicSubagentMap.Type;
