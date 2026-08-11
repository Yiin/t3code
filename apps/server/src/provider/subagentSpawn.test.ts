import { assert, describe, it } from "@effect/vitest";

import { DEFAULT_SPAWN_POLICY, type SpawnPolicy } from "../mcp/toolkits/agents/spawnPolicy.ts";
import {
  readSubagentDefinitionCount,
  resolveSubagentSpawnMode,
  subagentSpawnSystemPromptAppend,
  SPAWN_AGENT_TOOL_NAME,
  SUBAGENT_SPAWN_DISALLOWED_TOOLS,
  type SubagentSpawnModeInput,
} from "./subagentSpawn.ts";

const enabled = (overrides: Partial<SpawnPolicy> = {}): SpawnPolicy => ({
  ...DEFAULT_SPAWN_POLICY,
  enabled: true,
  ...overrides,
});

const input = (overrides: Partial<SubagentSpawnModeInput> = {}): SubagentSpawnModeInput => ({
  threadId: "thread-1",
  hasMcpSession: true,
  subagentDefinitionCount: 0,
  policy: enabled(),
  ...overrides,
});

describe("SUBAGENT_SPAWN_DISALLOWED_TOOLS", () => {
  it("denies both built-in delegation paths, not just Task", () => {
    // t3code-vzb.23, 40 sessions: with Task alone denied the model still escaped
    // through Workflow, which the roster cannot see. Both denied, 6 of 6 routed.
    assert.deepStrictEqual([...SUBAGENT_SPAWN_DISALLOWED_TOOLS], ["Task", "Workflow"]);
  });
});

describe("resolveSubagentSpawnMode", () => {
  it("leaves the built-in tool alone while the policy ships off", () => {
    assert.strictEqual(DEFAULT_SPAWN_POLICY.enabled, false);

    assert.deepStrictEqual(resolveSubagentSpawnMode(input({ policy: DEFAULT_SPAWN_POLICY })), {
      mode: "in-process",
      reason: "policy-disabled",
    });
  });

  it("hands spawning to T3 once the policy is on and an MCP session exists", () => {
    assert.deepStrictEqual(resolveSubagentSpawnMode(input()), {
      mode: "thread-backed",
      reason: "policy-enabled",
    });
  });

  it("keeps the built-in tool when per-role subagent definitions ride on it", () => {
    // t3code-pg7.13 invokes its tiered definitions through the built-in tool,
    // so the guard wins over an enabled policy and over a child thread.
    assert.deepStrictEqual(resolveSubagentSpawnMode(input({ subagentDefinitionCount: 3 })), {
      mode: "in-process",
      reason: "subagent-definitions",
    });
    assert.deepStrictEqual(
      resolveSubagentSpawnMode(
        input({ subagentDefinitionCount: 1, threadId: "subagent-thread-1-abc" }),
      ),
      { mode: "in-process", reason: "subagent-definitions" },
    );
  });

  it("keeps the built-in tool when spawn_agent is unreachable", () => {
    assert.deepStrictEqual(resolveSubagentSpawnMode(input({ hasMcpSession: false })), {
      mode: "in-process",
      reason: "no-mcp-session",
    });
  });

  it("denies delegation inside a thread-backed child, MCP session or not", () => {
    assert.deepStrictEqual(resolveSubagentSpawnMode(input({ threadId: "subagent-thread-1-abc" })), {
      mode: "child-restricted",
      reason: "child-thread",
    });
    assert.deepStrictEqual(
      resolveSubagentSpawnMode(input({ threadId: "subagent-thread-1-abc", hasMcpSession: false })),
      { mode: "child-restricted", reason: "child-thread" },
    );
  });

  it("leaves a child thread alone too while the policy is off", () => {
    assert.deepStrictEqual(
      resolveSubagentSpawnMode(
        input({ threadId: "subagent-thread-1-abc", policy: DEFAULT_SPAWN_POLICY }),
      ),
      { mode: "in-process", reason: "policy-disabled" },
    );
  });
});

describe("readSubagentDefinitionCount", () => {
  it("reads a record, an array, and everything that is not there yet", () => {
    assert.strictEqual(
      readSubagentDefinitionCount({ subagents: { planner: {}, reviewer: {} } }),
      2,
    );
    assert.strictEqual(readSubagentDefinitionCount({ subagents: ["planner"] }), 1);
    assert.strictEqual(readSubagentDefinitionCount({ subagents: {} }), 0);
    assert.strictEqual(readSubagentDefinitionCount({ threadId: "thread-1" }), 0);
    assert.strictEqual(readSubagentDefinitionCount(undefined), 0);
    assert.strictEqual(readSubagentDefinitionCount({ subagents: null }), 0);
  });
});

describe("subagentSpawnSystemPromptAppend", () => {
  it("appends nothing on the in-process path", () => {
    assert.strictEqual(
      subagentSpawnSystemPromptAppend(
        { mode: "in-process", reason: "policy-disabled" },
        DEFAULT_SPAWN_POLICY,
      ),
      undefined,
    );
  });

  it("names the replacement tool and what its result carries", () => {
    const append = subagentSpawnSystemPromptAppend(
      { mode: "thread-backed", reason: "policy-enabled" },
      enabled(),
    );

    assert.include(append ?? "", SPAWN_AGENT_TOOL_NAME);
    // Every denied tool is named, so the model is never told to reach for one
    // the session took away.
    for (const denied of SUBAGENT_SPAWN_DISALLOWED_TOOLS) {
      assert.include(append ?? "", denied);
    }
    // spawn_agent blocks on the child's settle, so the model is told it gets
    // an answer — and told the one case where it does not.
    assert.include(append ?? "", "returns the subagent's final message");
    assert.include(append ?? "", "status: timeout");
    assert.include(append ?? "", "Any agent type is allowed.");
  });

  it("sends a refused spawn to the model's own hands, never to a denied tool", () => {
    const append =
      subagentSpawnSystemPromptAppend(
        { mode: "thread-backed", reason: "policy-enabled" },
        enabled(),
      ) ?? "";

    assert.include(append, "do that work yourself");
    assert.notMatch(append, /fall back to (your |the )?built-in/i);
  });

  it("lists the allowlist when the policy has one", () => {
    const append = subagentSpawnSystemPromptAppend(
      { mode: "thread-backed", reason: "policy-enabled" },
      enabled({ allowedAgentTypes: ["Explore", "Plan"] }),
    );

    assert.include(append ?? "", "Allowed agent types: Explore, Plan.");
  });

  it("tells a child it cannot delegate at all", () => {
    const append = subagentSpawnSystemPromptAppend(
      { mode: "child-restricted", reason: "child-thread" },
      enabled(),
    );

    assert.include(append ?? "", "cannot delegate");
    assert.include(append ?? "", "Do this work yourself.");
    for (const denied of SUBAGENT_SPAWN_DISALLOWED_TOOLS) {
      assert.include(append ?? "", denied);
    }
  });
});
