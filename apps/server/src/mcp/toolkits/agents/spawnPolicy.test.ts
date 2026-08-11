import { assert, describe, it } from "@effect/vitest";

import {
  DEFAULT_SPAWN_POLICY,
  decideSpawn,
  isSubagentChildThreadId,
  makeSubagentChildThreadId,
  resolveSpawnPolicy,
  type SpawnPolicy,
} from "./spawnPolicy.ts";

const enabled = (overrides: Partial<SpawnPolicy> = {}): SpawnPolicy => ({
  ...DEFAULT_SPAWN_POLICY,
  enabled: true,
  ...overrides,
});

const input = (overrides: Partial<Parameters<typeof decideSpawn>[0]> = {}) => ({
  agentType: "Explore",
  parentThreadId: "thread-1",
  parentDepth: 0,
  liveChildCount: 0,
  policy: enabled(),
  ...overrides,
});

describe("decideSpawn", () => {
  it("refuses while thread-backed spawning is off, which is the default", () => {
    assert.strictEqual(DEFAULT_SPAWN_POLICY.enabled, false);
    assert.deepStrictEqual(resolveSpawnPolicy(), DEFAULT_SPAWN_POLICY);

    const decision = decideSpawn(input({ policy: DEFAULT_SPAWN_POLICY }));

    assert.strictEqual(decision._tag, "refused");
    assert.strictEqual(decision._tag === "refused" ? decision.reason : null, "disabled");
  });

  it("allows any agent type when the allowlist is empty", () => {
    assert.deepStrictEqual(decideSpawn(input({ agentType: "anything-at-all" })), {
      _tag: "threadBacked",
    });
  });

  it("matches the allowlist case-insensitively after trimming", () => {
    const policy = enabled({ allowedAgentTypes: ["  Explore  "] });

    assert.deepStrictEqual(decideSpawn(input({ agentType: " explore\n", policy })), {
      _tag: "threadBacked",
    });
  });

  it("names the allowed types and then hands a disallowed one back to the model", () => {
    const policy = enabled({ allowedAgentTypes: ["Explore"] });

    const decision = decideSpawn(input({ agentType: "general-purpose", policy }));

    assert.strictEqual(decision._tag, "refused");
    if (decision._tag !== "refused") return;
    assert.strictEqual(decision.reason, "agent-type-not-allowed");
    assert.match(decision.detail, /Allowed types: Explore\./);
    assert.match(decision.detail, /do this work yourself/);
  });

  it("refuses a grandchild at the default depth cap of 1", () => {
    const decision = decideSpawn(input({ parentDepth: 1 }));

    assert.strictEqual(decision._tag, "refused");
    assert.strictEqual(decision._tag === "refused" ? decision.reason : null, "depth-cap");
  });

  it("refuses at the concurrency cap and names the cap so the model waits", () => {
    const decision = decideSpawn(input({ liveChildCount: 3 }));

    assert.strictEqual(decision._tag, "refused");
    if (decision._tag !== "refused") return;
    assert.strictEqual(decision.reason, "concurrency-cap");
    assert.match(decision.detail, /limit is 3/);
  });

  it("allows one more child just under the concurrency cap", () => {
    assert.deepStrictEqual(decideSpawn(input({ liveChildCount: 2 })), { _tag: "threadBacked" });
  });

  it("never sends an enabled-policy refusal to a tool the session denied", () => {
    // An enabled policy is exactly when Task and Workflow are taken away
    // (SUBAGENT_SPAWN_DISALLOWED_TOOLS), so pointing at them here is advice the
    // model cannot follow. Measured cost in t3code-vzb.23: 8 refused retries in
    // one run, or an escape to Workflow.
    const refusals = [
      decideSpawn(
        input({ agentType: "nope", policy: enabled({ allowedAgentTypes: ["Explore"] }) }),
      ),
      decideSpawn(input({ parentDepth: 1 })),
      decideSpawn(input({ liveChildCount: 3 })),
    ];

    for (const decision of refusals) {
      assert.strictEqual(decision._tag, "refused");
      if (decision._tag !== "refused") continue;
      assert.notMatch(decision.detail, /built-in Task tool|Workflow tool/);
      assert.match(decision.detail, /do this work yourself/i);
    }
  });

  it("still points a policy-off refusal at the built-in tool it left in place", () => {
    // The one refusal reachable with the policy off, so the built-in delegation
    // tools are still on the session and are the honest answer.
    const decision = decideSpawn(input({ policy: DEFAULT_SPAWN_POLICY }));

    assert.strictEqual(decision._tag === "refused" ? decision.reason : null, "disabled");
    assert.match(decision._tag === "refused" ? decision.detail : "", /built-in Task tool/);
  });

  it("reports the disabled refusal before the allowlist one", () => {
    const policy: SpawnPolicy = { ...DEFAULT_SPAWN_POLICY, allowedAgentTypes: ["Explore"] };

    const decision = decideSpawn(input({ agentType: "nope", policy }));

    assert.strictEqual(decision._tag === "refused" ? decision.reason : null, "disabled");
  });
});

describe("resolveSpawnPolicy", () => {
  it("is the shipped default when no settings block exists", () => {
    assert.deepStrictEqual(resolveSpawnPolicy(), DEFAULT_SPAWN_POLICY);
    assert.deepStrictEqual(resolveSpawnPolicy({}), DEFAULT_SPAWN_POLICY);
  });

  it("turns spawning on from the block and keeps every default cap", () => {
    const policy = resolveSpawnPolicy({ enabled: true });

    assert.deepStrictEqual(policy, { ...DEFAULT_SPAWN_POLICY, enabled: true });
    assert.deepStrictEqual(decideSpawn(input({ policy })), { _tag: "threadBacked" });
  });

  it("takes each field from the block on its own", () => {
    const policy = resolveSpawnPolicy({
      enabled: true,
      allowedAgentTypes: ["Explore"],
      maxDepth: 2,
      maxConcurrentChildren: 1,
      spawnWaitTimeoutMs: 120_000,
    });

    assert.deepStrictEqual(policy, {
      enabled: true,
      allowedAgentTypes: ["Explore"],
      maxDepth: 2,
      maxConcurrentChildren: 1,
      spawnWaitTimeoutMs: 120_000,
    });
  });

  it("keeps an explicit false off rather than reading it as absent", () => {
    assert.strictEqual(resolveSpawnPolicy({ enabled: false }).enabled, false);
  });

  it("keeps an explicitly empty allowlist empty, which allows every type", () => {
    const policy = resolveSpawnPolicy({ enabled: true, allowedAgentTypes: [] });

    assert.deepStrictEqual(policy.allowedAgentTypes, []);
    assert.deepStrictEqual(decideSpawn(input({ agentType: "anything", policy })), {
      _tag: "threadBacked",
    });
  });
});

describe("subagent child thread ids", () => {
  it("round-trips: a minted child id reads back as a child", () => {
    const childThreadId = makeSubagentChildThreadId("thread-parent", "0f7c-uuid");

    assert.strictEqual(childThreadId, "subagent-thread-parent-0f7c-uuid");
    assert.strictEqual(isSubagentChildThreadId(childThreadId), true);
  });

  it("does not read an ordinary thread id as a child", () => {
    assert.strictEqual(isSubagentChildThreadId("thread-parent"), false);
    assert.strictEqual(isSubagentChildThreadId("epic-run-1-iteration-2"), false);
  });
});
