import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  EPIC_RUN_CONFIG_FIELDS,
  EpicRunConfig,
  EpicRunConfigOverride,
  type EpicRunConfigControl,
} from "./epicRunConfig.ts";

const decodeConfig = Schema.decodeUnknownSync(EpicRunConfig);
const encodeConfig = Schema.encodeSync(EpicRunConfig);
const decodeOverride = Schema.decodeUnknownSync(EpicRunConfigOverride);

const DEFAULT_CONFIG = {
  engine: "core",
  budget: { usd: null },
  gate: { command: null, disabled: false },
  supervision: {
    idleThresholdSeconds: 1_800,
    inspectorTimeoutSeconds: 120,
    inspectMaxDelaySeconds: 7_200,
    inspectMinDelaySeconds: 60,
    inspectRetryDelaySeconds: 300,
    stopGraceSeconds: 15,
    workerTimeoutSeconds: null,
  },
  limits: { maxAttemptsPerChild: 3, maxIterations: 50 },
  provider: { modelSelection: null },
  vcs: { noPush: false },
  orientation: { file: null },
  execution: { sequential: false },
  parallel: { siblings: [], workers: 3 },
  runtime: { mode: "full-access" },
  retry: { rateLimitBackoffSeconds: 120 },
  lock: { heartbeatSeconds: 30, staleSeconds: 300 },
  server: {
    maxConsecutiveFailures: 3,
    maxNoCommitStreak: 2,
    infraFailureBudget: 5,
    pollIntervalMs: 2_000,
    quietPeriodMs: 1_000,
    retryBaseDelayMs: 10_000,
    retryMaxDelayMs: 300_000,
    subagentGraceTimeoutMs: 900_000,
    maxGraceContinuations: 10,
    providerDegradationTtlMs: 3_600_000,
  },
} as const;

const collectLeafPaths = (value: unknown, prefix = ""): string[] => {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    collectLeafPaths(child, prefix === "" ? key : `${prefix}.${key}`),
  );
};

const TERMINAL_ONLY_KEYS = [
  "terminal.binary",
  "terminal.clockCommand",
  "terminal.cpuWeight",
  "terminal.disableSystemd",
  "terminal.foldCommand",
  "terminal.foldTimeoutSeconds",
  "terminal.harness",
  "terminal.inspectorCommand",
  "terminal.inspectorLogBytes",
  "terminal.inspectorResultBytes",
  "terminal.memoryHigh",
  "terminal.processStartTicksCommand",
  "terminal.pushCommand",
  "terminal.repoEvidenceBytes",
  "terminal.repoProbeIntervalSeconds",
  "terminal.repoProbeTimeoutSeconds",
  "terminal.resourceSamplerCommand",
  "terminal.runnerPath",
  "terminal.spawnDelaySeconds",
  "terminal.supervisionTickSeconds",
  "terminal.workerArtifactBytes",
  "terminal.workerCommand",
  "terminal.workersActiveCommand",
  "terminal.workerStopCommand",
] as const;

const PUBLIC_FIELD_SCOPES = {
  engine: "core",
  "budget.usd": "core-partial",
  "gate.command": "core",
  "gate.disabled": "core",
  "supervision.idleThresholdSeconds": "core",
  "supervision.inspectorTimeoutSeconds": "core",
  "supervision.inspectMaxDelaySeconds": "core",
  "supervision.inspectMinDelaySeconds": "core",
  "supervision.inspectRetryDelaySeconds": "core",
  "supervision.stopGraceSeconds": "core",
  "supervision.workerTimeoutSeconds": "core",
  "limits.maxAttemptsPerChild": "core",
  "limits.maxIterations": "core",
  "provider.modelSelection": "core",
  "vcs.noPush": "core",
  "orientation.file": "core",
  "runtime.mode": "core",
  "retry.rateLimitBackoffSeconds": "core",
  "execution.sequential": "core",
  "parallel.siblings": "core",
  "parallel.workers": "core",
  "lock.heartbeatSeconds": "core",
  "lock.staleSeconds": "core",
  "server.maxConsecutiveFailures": "server-only",
  "server.maxNoCommitStreak": "server-only",
  "server.infraFailureBudget": "server-only",
  "server.pollIntervalMs": "server-only",
  "server.quietPeriodMs": "server-only",
  "server.retryBaseDelayMs": "server-only",
  "server.retryMaxDelayMs": "server-only",
  "server.subagentGraceTimeoutMs": "server-only",
  "server.maxGraceContinuations": "server-only",
  "server.providerDegradationTtlMs": "server-only",
} as const;

describe("EpicRunConfig", () => {
  it("decodes every literal default from an empty object", () => {
    expect(decodeConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("fills defaults inside present partial sections", () => {
    expect(
      decodeConfig({
        supervision: { idleThresholdSeconds: 45 },
        parallel: { siblings: ["repos/sibling"] },
        server: { providerDegradationTtlMs: 0 },
      }),
    ).toEqual({
      ...DEFAULT_CONFIG,
      supervision: { ...DEFAULT_CONFIG.supervision, idleThresholdSeconds: 45 },
      parallel: { ...DEFAULT_CONFIG.parallel, siblings: ["repos/sibling"] },
      server: { ...DEFAULT_CONFIG.server, providerDegradationTtlMs: 0 },
    });
  });

  it("round-trips a decoded config through its encoded form", () => {
    const config = decodeConfig({
      budget: { usd: 25.5 },
      gate: { command: "bun run test", disabled: true },
      supervision: { workerTimeoutSeconds: 7_200 },
      provider: {
        modelSelection: { instanceId: "codex", model: "gpt-5.6" },
      },
      orientation: { file: "docs/agent-orientation.md" },
      execution: { sequential: true },
      parallel: { siblings: ["repos/api", "repos/web"], workers: 2 },
      runtime: { mode: "approval-required" },
    });

    expect(decodeConfig(encodeConfig(config))).toEqual(config);
  });

  it("keeps override absence distinct from explicit default values", () => {
    expect(decodeOverride({})).toEqual({});
    expect(
      decodeOverride({
        budget: { usd: null },
        gate: { disabled: false },
        parallel: { workers: 3 },
        supervision: { workerTimeoutSeconds: null },
      }),
    ).toEqual({
      budget: { usd: null },
      gate: { disabled: false },
      parallel: { workers: 3 },
      supervision: { workerTimeoutSeconds: null },
    });
  });

  it("rejects invalid worker and numeric bound values", () => {
    for (const workers of [-1, 0, 1.5]) {
      expect(() => decodeConfig({ parallel: { workers } })).toThrow();
    }
    expect(() => decodeConfig({ retry: { rateLimitBackoffSeconds: -1 } })).toThrow();
    expect(() => decodeConfig({ server: { pollIntervalMs: 0 } })).toThrow();
    expect(() => decodeConfig({ server: { providerDegradationTtlMs: -1 } })).toThrow();
  });

  it("accepts only known epic engines", () => {
    for (const engine of ["legacy", "core", "shadow"] as const) {
      expect(decodeConfig({ engine }).engine).toBe(engine);
      expect(decodeOverride({ engine })).toEqual({ engine });
    }
    expect(() => decodeConfig({ engine: "future" })).toThrow();
    expect(() => decodeOverride({ engine: "future" })).toThrow();
  });

  it("rejects non-positive or non-finite budgets", () => {
    for (const usd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => decodeConfig({ budget: { usd } })).toThrow();
    }
  });

  it("rejects empty commands, unsafe orientation paths, and invalid siblings", () => {
    expect(() => decodeConfig({ gate: { command: "   " } })).toThrow();
    for (const file of [
      "/tmp/card.md",
      "../card.md",
      "docs/../../card.md",
      "C:\\card.md",
      "\\\\server\\card.md",
    ]) {
      expect(() => decodeConfig({ orientation: { file } })).toThrow();
    }
    for (const sibling of ["/tmp/api", "D:\\api", "D:api", "\\\\server\\api"]) {
      expect(() => decodeConfig({ parallel: { siblings: [sibling] } })).toThrow();
    }
    expect(() => decodeConfig({ parallel: { siblings: ["api", "api"] } })).toThrow();
    expect(() => decodeConfig({ parallel: { siblings: ["api", " api "] } })).toThrow();
    expect(() => decodeConfig({ parallel: { siblings: ["api", "   "] } })).toThrow();
  });

  it("accepts contained orientation traversal and relative sibling paths", () => {
    const config = decodeConfig({
      orientation: { file: "docs/../AGENTS.md" },
      parallel: { siblings: ["../api", "repos/../../web"] },
    });

    expect(config.orientation.file).toBe("docs/../AGENTS.md");
    expect(config.parallel.siblings).toEqual(["../api", "repos/../../web"]);
  });
});

describe("EPIC_RUN_CONFIG_FIELDS", () => {
  it("matches every public schema leaf exactly", () => {
    const schemaLeaves = collectLeafPaths(decodeConfig({})).sort();
    const publicRegistryKeys = EPIC_RUN_CONFIG_FIELDS.filter(
      ({ scope }) => scope !== "terminal-only",
    )
      .map(({ key }) => key)
      .sort();

    expect(publicRegistryKeys).toEqual(schemaLeaves);
    expect(
      EPIC_RUN_CONFIG_FIELDS.filter(({ scope }) => scope !== "terminal-only").every(({ key }) =>
        schemaLeaves.includes(key),
      ),
    ).toBe(true);
  });

  it("records the exact scope for every public field", () => {
    expect(
      Object.fromEntries(
        EPIC_RUN_CONFIG_FIELDS.filter(({ scope }) => scope !== "terminal-only").map(
          ({ key, scope }) => [key, scope],
        ),
      ),
    ).toEqual(PUBLIC_FIELD_SCOPES);
  });

  it("matches the complete operator-facing terminal inventory", () => {
    expect(
      EPIC_RUN_CONFIG_FIELDS.filter(({ scope }) => scope === "terminal-only")
        .map(({ key }) => key)
        .sort(),
    ).toEqual([...TERMINAL_ONLY_KEYS].sort());
    expect(EPIC_RUN_CONFIG_FIELDS.some(({ key }) => key.startsWith("internal."))).toBe(false);
    expect(EPIC_RUN_CONFIG_FIELDS.some(({ key }) => key === "terminal.ioWeight")).toBe(false);
    expect(EPIC_RUN_CONFIG_FIELDS.some(({ key }) => key === "run.epicId")).toBe(false);
  });

  it("has unique keys and usable display metadata", () => {
    const keys = EPIC_RUN_CONFIG_FIELDS.map(({ key }) => key);
    const controls = new Set<EpicRunConfigControl>([
      "toggle",
      "number",
      "text",
      "select",
      "string-list",
    ]);

    expect(new Set(keys).size).toBe(keys.length);
    for (const field of EPIC_RUN_CONFIG_FIELDS) {
      expect(field.label.trim().length).toBeGreaterThan(0);
      expect(field.doc.trim().length).toBeGreaterThan(0);
      expect(controls.has(field.control)).toBe(true);
    }
  });

  it("records the budget harness enforcement boundary", () => {
    const budget = EPIC_RUN_CONFIG_FIELDS.find(({ key }) => key === "budget.usd");
    expect(budget).toMatchObject({
      scope: "core-partial",
      enforceableOn: ["claude", "ccx"],
    });
  });
});
