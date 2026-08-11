import { assert, describe, it } from "@effect/vitest";

import {
  DEFAULT_SPAWN_POLICY,
  decideSpawn,
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

  it("tells the model to use its built-in Task tool for a disallowed agent type", () => {
    const policy = enabled({ allowedAgentTypes: ["Explore"] });

    const decision = decideSpawn(input({ agentType: "general-purpose", policy }));

    assert.strictEqual(decision._tag, "refused");
    if (decision._tag !== "refused") return;
    assert.strictEqual(decision.reason, "agent-type-not-allowed");
    assert.match(decision.detail, /built-in Task tool/);
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

  it("reports the disabled refusal before the allowlist one", () => {
    const policy: SpawnPolicy = { ...DEFAULT_SPAWN_POLICY, allowedAgentTypes: ["Explore"] };

    const decision = decideSpawn(input({ agentType: "nope", policy }));

    assert.strictEqual(decision._tag === "refused" ? decision.reason : null, "disabled");
  });
});
