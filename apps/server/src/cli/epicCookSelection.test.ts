import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { RunJournalError } from "@t3tools/epic-core/ports/RunJournal";
import type { ProviderDegradationRecord } from "@t3tools/epic-core/providerDegradation";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { makeTerminalRoleSelection, resolveCookModelSelection } from "./epicCookSelection.ts";

const encodeSettings = Schema.encodeEffect(Schema.UnknownFromJsonString);

const provider = (instanceId: string, driver: string, model: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-13T12:00:00.000Z",
  availability: "available",
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

const inventory = {
  getProviders: Effect.succeed([
    provider("claude", "claudeAgent", "claude-sonnet-5"),
    provider("claude-personal", "claudeAgent", "claude-sonnet-5"),
    provider("codex", "codex", "gpt-5.6-sol"),
  ]),
};

const selection = { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-5" };

const chainPolicy = {
  epicRolePolicy: {
    tiers: {
      worker: {
        hops: [
          { selection: { instanceId: "claude", model: "claude-sonnet-5" } },
          { selection: { instanceId: "claude-personal", model: "claude-sonnet-5" } },
        ],
      },
    },
    roles: { "iteration-worker": "worker" },
  },
};

const degradations = (
  records: Record<string, ProviderDegradationRecord>,
): Effect.Effect<Readonly<Record<string, ProviderDegradationRecord>>, never> =>
  Effect.succeed(records);

const rateLimited = (degradedAt: string): ProviderDegradationRecord => ({
  failureReason: "provider-error:rate-limit",
  degradedAt,
});

// Real time: the cutoff is `now` minus the TTL, and the TestClock's epoch
// would make every recorded timestamp look fresh.
it.layer(NodeServices.layer, { excludeTestServices: true })("epic cook start selection", (it) => {
  const writeSettings = Effect.fn(function* (contents: unknown) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cook-selection-" });
    const settingsPath = path.join(directory, "settings.json");
    yield* fileSystem.writeFileString(settingsPath, yield* encodeSettings(contents));
    return settingsPath;
  });

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const resolveRole = (input: {
    readonly settings: unknown;
    readonly role?: "iteration-worker" | "merge-fix-child";
    readonly records?: Record<string, ProviderDegradationRecord>;
    readonly providerInventory?: typeof inventory;
    readonly degradationRead?: Effect.Effect<
      Readonly<Record<string, ProviderDegradationRecord>>,
      RunJournalError
    >;
  }) =>
    Effect.gen(function* () {
      const adapter = yield* makeTerminalRoleSelection({
        settingsPath: yield* writeSettings(input.settings),
        inventory: input.providerInventory ?? inventory,
        readProviderDegradations: input.degradationRead ?? degradations(input.records ?? {}),
        providerDegradationTtlMs: 3_600_000,
      });
      return yield* adapter.resolve({
        role: input.role ?? "iteration-worker",
        runId: "run",
        issueId: "child",
        issueTitle: "Child",
        fallbackSelection: selection,
      });
    });

  const resolveRoleChain = (input: {
    readonly settings: unknown;
    readonly records?: Record<string, ProviderDegradationRecord>;
    readonly degradationRead?: Effect.Effect<
      Readonly<Record<string, ProviderDegradationRecord>>,
      RunJournalError
    >;
  }) =>
    Effect.gen(function* () {
      const adapter = yield* makeTerminalRoleSelection({
        settingsPath: yield* writeSettings(input.settings),
        inventory,
        readProviderDegradations: input.degradationRead ?? degradations(input.records ?? {}),
        providerDegradationTtlMs: 3_600_000,
      });
      return yield* adapter.chain("iteration-worker");
    });

  it.effect("keeps the configured selection when nothing is recorded", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveCookModelSelection({
        settingsPath: yield* writeSettings(chainPolicy),
        inventory,
        readProviderDegradations: degradations({}),
        selection,
        providerDegradationTtlMs: 3_600_000,
      });
      assert.deepEqual(resolved, { selection, hops: [] });
    }),
  );

  it.effect("starts on the next chain hop after a previous cook degraded this one", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveCookModelSelection({
        settingsPath: yield* writeSettings(chainPolicy),
        inventory,
        readProviderDegradations: degradations({ claude: rateLimited(yield* nowIso) }),
        selection,
        providerDegradationTtlMs: 3_600_000,
      });
      assert.deepEqual(resolved.selection, {
        instanceId: ProviderInstanceId.make("claude-personal"),
        model: "claude-sonnet-5",
      });
      assert.deepEqual(
        resolved.hops.map((hop) => [hop.from.instanceId, hop.to.instanceId, hop.reason]),
        [["claude", "claude-personal", "provider-error:rate-limit"]],
      );
    }),
  );

  it.effect("falls back by driver order when no role policy names a chain", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveCookModelSelection({
        settingsPath: yield* writeSettings({}),
        inventory,
        readProviderDegradations: degradations({ claude: rateLimited(yield* nowIso) }),
        selection,
        providerDegradationTtlMs: 3_600_000,
      });
      assert.equal(resolved.selection.instanceId, "claude-personal");
    }),
  );

  it.effect("ignores a record older than the TTL", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveCookModelSelection({
        settingsPath: yield* writeSettings(chainPolicy),
        inventory,
        readProviderDegradations: degradations({ claude: rateLimited("2020-01-01T00:00:00.000Z") }),
        selection,
        providerDegradationTtlMs: 3_600_000,
      });
      assert.deepEqual(resolved, { selection, hops: [] });
    }),
  );

  it.effect("keeps the configured selection when the degradation file cannot be read", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveCookModelSelection({
        settingsPath: yield* writeSettings(chainPolicy),
        inventory,
        readProviderDegradations: Effect.fail(
          new RunJournalError({ operation: "readProviderDegradations", detail: "unreadable" }),
        ),
        selection,
        providerDegradationTtlMs: 3_600_000,
      });
      assert.deepEqual(resolved, { selection, hops: [] });
    }),
  );

  it.effect("enters the role chain when there are no degradations", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveRole({ settings: chainPolicy });
      assert.equal(resolved.selection.instanceId, "claude");
      assert.equal(resolved.tierId, "worker");
    }),
  );

  it.effect("returns a live fail-soft chain for mid-run fallback", () =>
    Effect.gen(function* () {
      const result = yield* resolveRoleChain({
        settings: chainPolicy,
        records: { claude: rateLimited(yield* nowIso) },
      });
      assert.deepEqual(
        result.chain.map((hop) => hop.instanceId),
        ["claude", "claude-personal"],
      );
      assert.isTrue(result.isInstanceBlocked(ProviderInstanceId.make("claude")));
      assert.isFalse(result.isInstanceBlocked(ProviderInstanceId.make("claude-personal")));

      const failed = yield* resolveRoleChain({
        settings: chainPolicy,
        degradationRead: Effect.fail(
          new RunJournalError({ operation: "readProviderDegradations", detail: "unreadable" }),
        ),
      });
      assert.deepEqual(failed.chain, []);
    }),
  );

  it.effect("uses a policy model that differs from the terminal route snapshot", () =>
    Effect.gen(function* () {
      const settings = {
        epicRolePolicy: {
          tiers: {
            worker: {
              hops: [{ selection: { instanceId: "claude", model: "claude-opus-5" } }],
            },
          },
          roles: { "iteration-worker": "worker" },
        },
      };
      const resolved = yield* resolveRole({ settings });
      assert.deepEqual(resolved.selection, {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-opus-5",
      });
      assert.equal(resolved.tierId, "worker");
    }),
  );

  it.effect("maps merge-fix dispatches and skips a degraded hop", () =>
    Effect.gen(function* () {
      const settings = {
        epicRolePolicy: {
          ...chainPolicy.epicRolePolicy,
          roles: { "merge-fix": "worker" },
        },
      };
      const resolved = yield* resolveRole({
        settings,
        role: "merge-fix-child",
        records: { claude: rateLimited(yield* nowIso) },
      });
      assert.equal(resolved.selection.instanceId, "claude-personal");
      assert.equal(resolved.tierId, "worker");
    }),
  );

  it.effect("falls back when the tier has no route in the terminal inventory", () =>
    Effect.gen(function* () {
      const settings = {
        epicRolePolicy: {
          tiers: {
            worker: {
              hops: [{ selection: { instanceId: "missing", model: "claude-sonnet-5" } }],
            },
          },
          roles: { "iteration-worker": "worker" },
        },
      };
      const resolved = yield* resolveRole({ settings });
      assert.deepEqual(resolved, { selection, tierId: null });
    }),
  );

  it.effect("falls back when a fresh degradation read fails", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveRole({
        settings: chainPolicy,
        degradationRead: Effect.fail(
          new RunJournalError({ operation: "readProviderDegradations", detail: "unreadable" }),
        ),
      });
      assert.deepEqual(resolved, { selection, tierId: null });
    }),
  );
});
