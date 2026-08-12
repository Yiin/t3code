/**
 * mcpToolCallCeiling - how long each provider client lets ONE t3-code MCP tool
 * call run before it gives up on its own.
 *
 * Every number here was measured against a throwaway MCP server that slept for
 * a requested duration, driven the way each adapter drives the real one
 * (`t3code-vzb.13` for Claude, Codex and OpenCode; `t3code-vzb.43` for Kimi).
 * They are client walls, not server walls: the effect MCP server imposes no
 * timeout of its own.
 *
 * Why it matters: when the client gives up first, the tool result is a
 * transport error and everything the handler was about to say is lost. A
 * `spawn_agent` call that loses its result loses the child thread id with it,
 * so the parent cannot name the subagent it just started. Bounding the server's
 * own wait below this ceiling turns that into a structured timeout result the
 * model can act on.
 *
 * @module mcpToolCallCeiling
 */
import type { ProviderDriverKind } from "@t3tools/contracts";

/**
 * The per-server tool-call timeout T3 asks the Claude Agent SDK for.
 *
 * The SDK's own default is 60 s, and `McpHttpServerConfig.timeout` is the
 * documented way to raise it. It does not raise it without limit: a 240 s call
 * returned its real output, a 300 s call died at ~294 s no matter how high
 * either knob was set. 240 s sits under that hard wall with room to spare.
 *
 * `ClaudeAdapter` sets it on the `t3-code` server entry and the table below
 * reads it back, so the number the client enforces and the number the spawn
 * wait bounds itself by cannot drift apart.
 */
export const CLAUDE_MCP_TOOL_CALL_TIMEOUT_MS = 240_000;

/**
 * The measured ceiling per driver. A driver missing from this table has not
 * been measured, and falls back to {@link UNKNOWN_MCP_TOOL_CALL_CEILING_MS}.
 *
 * `cursor` and `grok` are absent because both need an interactive browser login
 * to drive, so neither was wall-measured. `primeAgent` is absent because it
 * never reads an MCP session at all.
 */
const MEASURED_MCP_TOOL_CALL_CEILING_MS: Readonly<Record<string, number>> = {
  claudeAgent: CLAUDE_MCP_TOOL_CALL_TIMEOUT_MS,
  // codex-cli 0.147.0 default. Raisable with `mcp_servers.<n>.tool_timeout_sec`,
  // which T3 does not set.
  codex: 300_000,
  // Kimi Code 0.34.0 default. Raisable with `KIMI_MCP_TOOL_TIMEOUT_MS`, which
  // T3 does not set.
  kimi: 60_000,
  // opencode 1.18.9 default. Raisable with the per-server `timeout` field, which
  // T3 does not set.
  opencode: 60_000,
};

/**
 * What an unmeasured driver is assumed to allow.
 *
 * 60 s is the MCP SDK's own default and every client measured so far ships with
 * it, so it is the safe guess. Guessing low costs an early structured timeout;
 * guessing high costs the whole result.
 */
export const UNKNOWN_MCP_TOOL_CALL_CEILING_MS = 60_000;

/** How long `driver` lets one t3-code tool call run. */
export const mcpToolCallCeilingMs = (driver: ProviderDriverKind): number =>
  MEASURED_MCP_TOOL_CALL_CEILING_MS[driver] ?? UNKNOWN_MCP_TOOL_CALL_CEILING_MS;
