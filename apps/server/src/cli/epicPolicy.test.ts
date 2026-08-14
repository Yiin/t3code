// @effect-diagnostics preferSchemaOverJson:off
import { DEFAULT_EPIC_STAGE_SUBAGENTS } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  EpicPolicyCliError,
  formatEpicPolicyOutput,
  formatEpicPolicyReport,
  readEpicPolicyReport,
} from "./epicPolicy.ts";

const settingsFile = (policy: unknown) => JSON.stringify({ epicRolePolicy: policy });

const persistedPolicy = {
  tiers: {
    high: {
      label: "High reasoning",
      hops: [
        {
          selection: {
            instanceId: "claude-work",
            model: "claude-opus-5",
            options: [{ id: "effort", value: "max" }],
          },
          skipAboveUtilization: 80,
        },
        { selection: { instanceId: "claude", model: "claude-sonnet-5" } },
      ],
    },
    cheap: {
      hops: [{ selection: { instanceId: "codex", model: "gpt-5.6-sol" } }],
    },
  },
  roles: {
    "iteration-worker": "high",
    "merge-fix": "cheap",
  },
  inSessionRoles: {
    planner: { tier: "high", description: "Plans the child.", prompt: "You plan." },
    reviewer: { description: "Reviews the diff.", prompt: "You review." },
  },
};

const lineOf = (output: string, prefix: string): string =>
  output.split("\n").find((line) => line.startsWith(prefix)) ?? "";

const rowsOf = (output: string, header: string): ReadonlyArray<ReadonlyArray<string>> => {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${header}[`));
  if (start === -1) return [];
  const rows: Array<ReadonlyArray<string>> = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  ")) break;
    rows.push(line.slice(2).split("\t"));
  }
  return rows;
};

const MISSING_SETTINGS_PATH = "/nonexistent/t3-epic-policy/settings.json";

it.layer(NodeServices.layer)("epic policy", (it) => {
  const writeSettings = Effect.fn(function* (contents: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-epic-policy-" });
    const settingsPath = path.join(directory, "settings.json");
    yield* fileSystem.writeFileString(settingsPath, contents);
    return settingsPath;
  });

  it.effect("prints the persisted policy with every hop in order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsPath = yield* writeSettings(settingsFile(persistedPolicy));
        const report = yield* readEpicPolicyReport({ settingsPath });

        assert.equal(report.settingsPath, settingsPath);
        assert.isTrue(report.settingsFound);
        assert.equal(report.tier, null);
        assert.deepEqual(report.tiers[0], {
          id: "high",
          label: "High reasoning",
          hops: [
            {
              order: 1,
              instanceId: "claude-work",
              model: "claude-opus-5",
              options: [{ id: "effort", value: "max" }],
              skipAboveUtilization: 80,
            },
            {
              order: 2,
              instanceId: "claude",
              model: "claude-sonnet-5",
              options: [],
              skipAboveUtilization: null,
            },
          ],
        });
        // Every runner role is listed, assigned or not, so an absent
        // assignment reads as an answer instead of a missing row.
        assert.deepEqual(report.roles, [
          { role: "iteration-worker", tier: "high" },
          { role: "idle-inspection", tier: null },
          { role: "epic-note-fold", tier: null },
          { role: "merge-fix", tier: "cheap" },
        ]);
        assert.deepEqual(report.inSessionRoles, [
          { name: "planner", tier: "high", description: "Plans the child." },
          { name: "reviewer", tier: null, description: "Reviews the diff." },
        ]);

        const text = formatEpicPolicyReport(report);
        assert.deepEqual(rowsOf(text, "hops"), [
          ["high", "1", "claude-work", "claude-opus-5", "effort=max", "80"],
          ["high", "2", "claude", "claude-sonnet-5", "-", "-"],
          ["cheap", "1", "codex", "gpt-5.6-sol", "-", "-"],
        ]);
        assert.deepEqual(rowsOf(text, "tiers"), [
          ["high", "High reasoning", "2"],
          ["cheap", "-", "1"],
        ]);
        assert.equal(lineOf(text, "settings:"), `settings: ${settingsPath}`);

        const json: unknown = JSON.parse(formatEpicPolicyOutput(report, true));
        assert.deepEqual(json, report);
      }),
    ),
  );

  it.effect("narrows every section to one chain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsPath = yield* writeSettings(settingsFile(persistedPolicy));
        const report = yield* readEpicPolicyReport({ settingsPath, tier: "high" });

        assert.equal(report.tier, "high");
        assert.deepEqual(
          report.tiers.map((tier) => tier.id),
          ["high"],
        );
        // The filter answers "what runs on this chain?", so the role lists
        // narrow with it.
        assert.deepEqual(report.roles, [{ role: "iteration-worker", tier: "high" }]);
        assert.deepEqual(
          report.inSessionRoles.map((role) => role.name),
          ["planner"],
        );

        const text = formatEpicPolicyReport(report);
        assert.equal(lineOf(text, "tier:"), "tier: high");
        assert.deepEqual(rowsOf(text, "hops"), [
          ["high", "1", "claude-work", "claude-opus-5", "effort=max", "80"],
          ["high", "2", "claude", "claude-sonnet-5", "-", "-"],
        ]);
        // A detail view answers itself, so it carries no next-step hints.
        assert.notInclude(text, "help[");
      }),
    ),
  );

  it.effect("states the zero when a tier carries nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsPath = yield* writeSettings(settingsFile(persistedPolicy));
        const report = yield* readEpicPolicyReport({ settingsPath, tier: "cheap" });
        const text = formatEpicPolicyReport(report);

        assert.equal(
          lineOf(text, "inSessionRoles:"),
          "inSessionRoles: 0 in-session subagents on tier cheap",
        );
      }),
    ),
  );

  it.effect("names the known tiers when the filter matches none", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsPath = yield* writeSettings(settingsFile(persistedPolicy));
        const result = yield* Effect.result(readEpicPolicyReport({ settingsPath, tier: "medium" }));

        assert.equal(result._tag, "Failure");
        const failure = result._tag === "Failure" ? result.failure : null;
        assert.instanceOf(failure, EpicPolicyCliError);
        assert.equal(
          (failure as EpicPolicyCliError).detail,
          "No tier 'medium'. Known tiers: high, cheap.",
        );
      }),
    ),
  );

  it.effect("prints the shipped defaults when the settings file is missing", () =>
    Effect.gen(function* () {
      const report = yield* readEpicPolicyReport({ settingsPath: MISSING_SETTINGS_PATH });

      assert.isFalse(report.settingsFound);
      assert.deepEqual(report.tiers, []);
      // The shipped stage subagents are tier-less on purpose: a shipped hop
      // would name a provider instance only the author has.
      assert.deepEqual(
        report.inSessionRoles.map((role) => role.name),
        Object.keys(DEFAULT_EPIC_STAGE_SUBAGENTS),
      );
      assert.deepEqual(
        report.inSessionRoles.map((role) => role.tier),
        report.inSessionRoles.map(() => null),
      );
      assert.deepEqual(
        report.roles.map((role) => role.tier),
        report.roles.map(() => null),
      );

      const text = formatEpicPolicyReport(report);
      assert.equal(
        lineOf(text, "settings:"),
        `settings: ${MISSING_SETTINGS_PATH} (not found, showing shipped defaults)`,
      );
      assert.equal(lineOf(text, "tiers:"), "tiers: 0 tiers configured");
      assert.equal(lineOf(text, "hops:"), "hops: 0 hops configured");
      assert.equal(rowsOf(text, "inSessionRoles").length, 6);
      assert.include(text, "help[2]:");
    }),
  );

  it.effect("rejects a tier filter against a policy with no tiers", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        readEpicPolicyReport({ settingsPath: MISSING_SETTINGS_PATH, tier: "high" }),
      );

      assert.equal(result._tag, "Failure");
      assert.equal(
        result._tag === "Failure" ? (result.failure as EpicPolicyCliError).detail : "",
        "No tier 'high': the epic role policy has no tiers.",
      );
    }),
  );
});
