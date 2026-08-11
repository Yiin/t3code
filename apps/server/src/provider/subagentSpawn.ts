/**
 * subagentSpawn - decides how one provider session delegates subagent work.
 *
 * A session either keeps the provider's built-in in-process subagent tool
 * (Claude's `Task`) or hands subagent spawning to T3's `mcp__t3-code__spawn_agent`,
 * which creates a real child thread. Both kinds coexist by design, so this
 * module never turns one into the other: it only says which one this session
 * gets, and the adapter wires the SDK options from that answer.
 *
 * The decision is deliberately taken once at session start. The alternative, a
 * per-call `canUseTool` denial, sits below `canUseToolEffect`'s early
 * `{behavior:"allow"}` return for `runtimeMode === "full-access"`, which is the
 * common mode and the epic-worker mode, so it would silently do nothing in
 * production while passing a naive test.
 *
 * Pure functions only: no Effect services, no I/O, no clock.
 *
 * @module subagentSpawn
 */
import { isSubagentChildThreadId, type SpawnPolicy } from "../mcp/toolkits/agents/spawnPolicy.ts";

/**
 * Tools denied on the SDK query whenever T3 owns subagent spawning.
 *
 * `disallowedTools` is preferred over `toolAliases` here because the model must
 * know its own tool surface: an alias would keep advertising `Task` while the
 * call landed somewhere with a different input shape.
 *
 * Both built-in delegation paths must go, not just `Task`. Measured over 40
 * sessions in t3code-vzb.23 (SDK 0.3.170): with `Task` alone denied, 1 run in 10
 * escaped through `Workflow` even with the prompt append, and 6 in 10 without
 * it; with both denied, 6 of 6 runs routed every delegation to `spawn_agent` and
 * none collapsed to inline work. A `Workflow` escape is also the worst kind: it
 * emits one `task_started` for the whole workflow however many agents it runs,
 * so the roster cannot see it, and it cost 1.10-4.22 USD per run against
 * 0.44-0.80 for a routed one.
 */
export const SUBAGENT_SPAWN_DISALLOWED_TOOLS: ReadonlyArray<string> = ["Task", "Workflow"];

/** The denied tools as prose for a system prompt, e.g. "Task and Workflow". */
const disallowedToolsSentenceFragment = (): string => {
  const names = SUBAGENT_SPAWN_DISALLOWED_TOOLS.map((name) => `\`${name}\``);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
};

/** The T3 tool that replaces the built-in in-process subagent tool. */
export const SPAWN_AGENT_TOOL_NAME = "mcp__t3-code__spawn_agent";

export type SubagentSpawnMode =
  /** Leave the provider's built-in subagent tool exactly as it is today. */
  | "in-process"
  /** Deny the built-in tool and point the model at `spawn_agent`. */
  | "thread-backed"
  /** This session *is* a subagent: deny the built-in tool, offer nothing. */
  | "child-restricted";

export type SubagentSpawnReason =
  /**
   * The session ships per-role subagent definitions, which the SDK invokes
   * through the built-in tool. Denying it would destroy the whole tier chain,
   * so this wins over every other rule. See t3code-pg7.13.
   */
  | "subagent-definitions"
  /** Thread-backed spawning is off, so nothing changes at all. */
  | "policy-disabled"
  /** No T3 MCP session, so `spawn_agent` is unreachable from this session. */
  | "no-mcp-session"
  /** This thread is itself a thread-backed child; the depth cap is 1. */
  | "child-thread"
  /** Thread-backed spawning applies. */
  | "policy-enabled";

export interface SubagentSpawnDecision {
  readonly mode: SubagentSpawnMode;
  readonly reason: SubagentSpawnReason;
}

export interface SubagentSpawnModeInput {
  /** The thread this provider session belongs to. */
  readonly threadId: string;
  /** True when the session carries a T3 MCP session, so `spawn_agent` exists. */
  readonly hasMcpSession: boolean;
  /** How many per-role subagent definitions the session ships (t3code-pg7.13). */
  readonly subagentDefinitionCount: number;
  readonly policy: SpawnPolicy;
}

/**
 * Count the per-role subagent definitions on a provider session start input.
 *
 * t3code-pg7.12 and t3code-pg7.13 add tiered planner/implementer/reviewer
 * definitions that the SDK invokes through the built-in subagent tool. The
 * field is not on `ProviderSessionStartInput` yet, so read it structurally: the
 * guard costs nothing today and is already correct when pg7.13 lands.
 */
export const readSubagentDefinitionCount = (input: unknown): number => {
  const candidate = (input as { readonly subagents?: unknown } | null | undefined)?.subagents;
  if (Array.isArray(candidate)) return candidate.length;
  if (candidate !== null && typeof candidate === "object") return Object.keys(candidate).length;
  return 0;
};

/** Decide how one provider session delegates subagent work. */
export const resolveSubagentSpawnMode = (input: SubagentSpawnModeInput): SubagentSpawnDecision => {
  if (input.subagentDefinitionCount > 0) {
    return { mode: "in-process", reason: "subagent-definitions" };
  }
  if (!input.policy.enabled) {
    return { mode: "in-process", reason: "policy-disabled" };
  }
  if (isSubagentChildThreadId(input.threadId)) {
    // Cheap enforcement of the depth cap: a child that cannot call the built-in
    // tool cannot grow a grandchild behind the policy's back. `spawn_agent`
    // refuses it too, so the child is left with no delegation at all.
    return { mode: "child-restricted", reason: "child-thread" };
  }
  if (!input.hasMcpSession) {
    // Denying the built-in tool with no `spawn_agent` to replace it would leave
    // the session unable to delegate at all.
    return { mode: "in-process", reason: "no-mcp-session" };
  }
  return { mode: "thread-backed", reason: "policy-enabled" };
};

const allowedAgentTypesSentence = (policy: SpawnPolicy): string =>
  policy.allowedAgentTypes.length === 0
    ? "Any agent type is allowed."
    : `Allowed agent types: ${policy.allowedAgentTypes.join(", ")}.`;

/**
 * The paragraph appended to the Claude Code system prompt preset.
 *
 * It states only what is true today: `spawn_agent` waits for the subagent and
 * returns its final message, and it names the one case where it comes back
 * without an answer — a subagent that outran the server's wait bound.
 */
export const subagentSpawnSystemPromptAppend = (
  decision: SubagentSpawnDecision,
  policy: SpawnPolicy,
): string | undefined => {
  switch (decision.mode) {
    case "in-process":
      return undefined;
    case "thread-backed":
      return [
        `Subagent delegation on this server runs through the \`${SPAWN_AGENT_TOOL_NAME}\` tool.`,
        `Your built-in ${disallowedToolsSentenceFragment()} tools are turned off for this session; call that tool instead, with an agent_type, a short description, and the full prompt.`,
        "It runs the subagent in its own thread, waits for it, and returns the subagent's final message.",
        "If it returns status: timeout, the subagent outran the server's wait bound and is still running: use whatever partial text came back and carry on.",
        "If it returns spawned: false, read the detail it gives you and do that work yourself: no built-in delegation tool is left to fall back to.",
        allowedAgentTypesSentence(policy),
      ].join(" ");
    case "child-restricted":
      return [
        "You are a T3 subagent running in your own thread.",
        `You cannot delegate any further: your built-in ${disallowedToolsSentenceFragment()} tools are turned off, and \`${SPAWN_AGENT_TOOL_NAME}\` refuses a nested spawn.`,
        "Do this work yourself.",
      ].join(" ");
  }
};
