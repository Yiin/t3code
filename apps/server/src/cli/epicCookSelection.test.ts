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

import { resolveCookModelSelection } from "./epicCookSelection.ts";

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
      assert.equal(resolved.selection.instanceId, "codex");
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
});
