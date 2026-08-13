import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe } from "vite-plus/test";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  applyPreferredCodexDefaultModel,
  mapCodexModelCapabilities,
  mapCodexRateLimitsResponse,
  probeCodexAppServerProvider,
} from "./CodexProvider.ts";

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeRateLimitsResponse(
  rateLimits: CodexSchema.V2GetAccountRateLimitsResponse["rateLimits"],
): CodexSchema.V2GetAccountRateLimitsResponse {
  return { rateLimits };
}

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

describe("mapCodexRateLimitsResponse", () => {
  it("maps both windows onto readings", () => {
    const readings = mapCodexRateLimitsResponse(
      makeRateLimitsResponse({
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1787207826 },
        secondary: { usedPercent: 87, windowDurationMins: 10080, resetsAt: 1787207826 },
      }),
    );

    assert.deepStrictEqual(readings, [
      {
        window: "primary",
        utilization: 12,
        resetsAt: "2026-08-20T06:37:06.000Z",
        source: "codex.app_server.read",
      },
      {
        window: "secondary",
        utilization: 87,
        resetsAt: "2026-08-20T06:37:06.000Z",
        source: "codex.app_server.read",
      },
    ]);
  });

  it("emits one reading when only the primary window is present", () => {
    const readings = mapCodexRateLimitsResponse(
      makeRateLimitsResponse({
        primary: { usedPercent: 0, resetsAt: 1787207826 },
      }),
    );

    assert.deepStrictEqual(
      readings.map((reading) => reading.window),
      ["primary"],
    );
    assert.deepStrictEqual(readings[0]?.utilization, 0);
  });

  it("emits nothing when the primary window is null and the secondary is absent", () => {
    assert.deepStrictEqual(
      mapCodexRateLimitsResponse(makeRateLimitsResponse({ primary: null })),
      [],
    );
  });

  it("emits a null resetsAt when the field is absent or null", () => {
    const readings = mapCodexRateLimitsResponse(
      makeRateLimitsResponse({
        primary: { usedPercent: 3 },
        secondary: { usedPercent: 4, resetsAt: null },
      }),
    );

    assert.deepStrictEqual(
      readings.map((reading) => reading.resetsAt),
      [null, null],
    );
  });

  it("reads resetsAt as seconds, the unit the live app-server reports", () => {
    const readings = mapCodexRateLimitsResponse(
      makeRateLimitsResponse({ primary: { usedPercent: 1, resetsAt: 1787207826 } }),
    );

    assert.deepStrictEqual(readings[0]?.resetsAt, "2026-08-20T06:37:06.000Z");
  });

  it("reads a resetsAt above the seconds ceiling as milliseconds", () => {
    const readings = mapCodexRateLimitsResponse(
      makeRateLimitsResponse({ primary: { usedPercent: 1, resetsAt: 1787207826123 } }),
    );

    assert.deepStrictEqual(readings[0]?.resetsAt, "2026-08-20T06:37:06.123Z");
  });

  it("emits a null resetsAt for a value that is not a usable date", () => {
    const readings = mapCodexRateLimitsResponse(
      makeRateLimitsResponse({ primary: { usedPercent: 1, resetsAt: 0 } }),
    );

    assert.deepStrictEqual(readings[0]?.resetsAt, null);
  });
});

// `excludeTestServices` keeps the real clock: the probe's own rate-limit
// timeout has to elapse on its own, and a TestClock never advances it.
it.layer(NodeServices.layer, { excludeTestServices: true })(
  "probeCodexAppServerProvider usage",
  (it) => {
    const runProbe = Effect.fn("runCodexAppServerProbe")(function* (scenario: string) {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        directory: NodeOS.tmpdir(),
        prefix: "codex-app-server-probe-",
      });
      const requestLogPath = path.join(tempDir, "requests.jsonl");
      const wrapperPath = path.join(tempDir, "codex-mock.sh");
      const mockPath = yield* path.fromFileUrl(
        new URL("../../../scripts/codex-app-server-mock.ts", import.meta.url),
      );
      yield* fileSystem.writeFileString(
        wrapperPath,
        `#!/bin/sh\nexec ${quoteShellArgument(process.execPath)} ${quoteShellArgument(mockPath)} "$@"\n`,
      );
      yield* fileSystem.chmod(wrapperPath, 0o755);

      const snapshot = yield* probeCodexAppServerProvider({
        binaryPath: wrapperPath,
        cwd: tempDir,
        environment: {
          ...process.env,
          T3_CODEX_APP_SERVER_REQUEST_LOG_PATH: requestLogPath,
          T3_CODEX_APP_SERVER_SCENARIO: scenario,
        },
      });

      const requestLog = yield* fileSystem.readFileString(requestLogPath);
      return {
        snapshot,
        requests: requestLog
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { method: string; params?: unknown }),
      };
    });

    it.effect("reads the rate limit windows on the probe the capability call already spawned", () =>
      Effect.gen(function* () {
        const { snapshot, requests } = yield* runProbe("rate-limits-ok");

        assert.deepStrictEqual(snapshot.usage, [
          {
            window: "primary",
            utilization: 12,
            resetsAt: "2026-08-20T06:37:06.000Z",
            source: "codex.app_server.read",
          },
        ]);
        // `account/rateLimits/read` takes no params, so the payload must be
        // omitted entirely rather than sent as `{}`.
        assert.deepStrictEqual(
          requests.filter((request) => request.method === "account/rateLimits/read"),
          [{ method: "account/rateLimits/read" }],
        );
      }),
    );

    it.effect("keeps the capability snapshot when an older binary lacks the method", () =>
      Effect.gen(function* () {
        const { snapshot } = yield* runProbe("rate-limits-method-not-found");

        assert.deepStrictEqual(snapshot.usage, []);
        assert.deepStrictEqual(snapshot.version, "9.9.9-mock");
        assert.deepStrictEqual(
          snapshot.models.map((model) => model.slug),
          ["gpt-mock"],
        );
        assert.deepStrictEqual(
          snapshot.skills.map((skill) => skill.name),
          ["mock-skill"],
        );
      }),
    );

    it.effect("keeps the capability snapshot when the rate limit read never answers", () =>
      Effect.gen(function* () {
        const { snapshot } = yield* runProbe("rate-limits-hang");

        assert.deepStrictEqual(snapshot.usage, []);
        assert.deepStrictEqual(
          snapshot.models.map((model) => model.slug),
          ["gpt-mock"],
        );
      }),
    );
  },
);
