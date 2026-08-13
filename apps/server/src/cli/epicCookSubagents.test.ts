import * as NodeOS from "node:os";

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { deriveServerPaths } from "../config.ts";
import {
  readCookSubagents,
  readEpicRolePolicy,
  resolveCookSettingsPath,
} from "./epicCookSubagents.ts";

const claude = (instanceId: string, models: ReadonlyArray<string>): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-13T12:00:00.000Z",
  availability: "available",
  models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
});

const settingsFile = (policy: unknown) => JSON.stringify({ epicRolePolicy: policy });

const tieredPolicy = {
  tiers: {
    high: {
      hops: [
        { selection: { instanceId: "claude-work", model: "claude-opus-5" } },
        { selection: { instanceId: "claude", model: "claude-sonnet-5" } },
      ],
    },
  },
  inSessionRoles: {
    planner: { tier: "high", description: "Plans the child.", prompt: "You plan." },
    reviewer: { description: "Reviews the diff.", prompt: "You review." },
  },
};

const inventoryOf = (providers: ReadonlyArray<ServerProvider>) => {
  let probes = 0;
  return {
    inventory: {
      getProviders: Effect.sync(() => {
        probes += 1;
        return providers;
      }),
    },
    probeCount: () => probes,
  };
};

const selection = { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-5" };

it.layer(NodeServices.layer)("epic cook subagents", (it) => {
  const writeSettings = Effect.fn(function* (contents: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cook-settings-" });
    const settingsPath = path.join(directory, "settings.json");
    yield* fileSystem.writeFileString(settingsPath, contents);
    return settingsPath;
  });

  it.effect("derives the same settings path the server does", () =>
    Effect.gen(function* () {
      const home = NodeOS.homedir();
      const implicit = yield* deriveServerPaths(`${home}/.t3`, undefined);
      assert.equal(
        resolveCookSettingsPath({ environment: {}, homeDirectory: home }),
        implicit.settingsPath,
      );

      const explicit = yield* deriveServerPaths("/tmp/t3-cook-home", undefined, {
        baseDirIsExplicit: true,
      });
      assert.equal(
        resolveCookSettingsPath({
          environment: { T3CODE_HOME: "/tmp/t3-cook-home" },
          homeDirectory: home,
        }),
        explicit.settingsPath,
      );

      // A dev server writes under `dev`, but only when the base directory is
      // not pinned — the same rule `deriveServerPaths` applies.
      const dev = yield* deriveServerPaths(`${home}/.t3`, new URL("http://127.0.0.1:5173"));
      assert.equal(
        resolveCookSettingsPath({
          environment: { VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" },
          homeDirectory: home,
        }),
        dev.settingsPath,
      );
      assert.equal(
        resolveCookSettingsPath({
          environment: {
            VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
            T3CODE_HOME: "/tmp/t3-cook-home",
          },
          homeDirectory: home,
        }),
        explicit.settingsPath,
      );
    }),
  );

  it.effect("expands a home-relative base directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.equal(
        resolveCookSettingsPath({ environment: { T3CODE_HOME: "~/nested" }, homeDirectory: "/h" }),
        path.join("/h", "nested", "userdata", "settings.json"),
      );
    }),
  );

  it.effect("reads the empty policy when the settings file is missing", () =>
    Effect.gen(function* () {
      const policy = yield* readEpicRolePolicy("/nonexistent/t3-cook/settings.json");
      assert.deepEqual(policy, { tiers: {}, roles: {}, inSessionRoles: {} });
    }),
  );

  it.effect("reads the persisted policy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsPath = yield* writeSettings(settingsFile(tieredPolicy));
        const policy = yield* readEpicRolePolicy(settingsPath);
        assert.deepEqual(Object.keys(policy.inSessionRoles), ["planner", "reviewer"]);
      }),
    ),
  );

  it.effect("resolves each role's model from its tier", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsPath = yield* writeSettings(settingsFile(tieredPolicy));
        const providers = inventoryOf([claude("claude", ["claude-sonnet-5"])]);
        const subagents = yield* readCookSubagents({
          settingsPath,
          inventory: providers.inventory,
          sessionSelection: selection,
        });

        // The first hop names an account this terminal run does not have, so the
        // chain walks on to the one it does.
        assert.deepEqual(subagents, {
          planner: {
            description: "Plans the child.",
            prompt: "You plan.",
            model: "claude-sonnet-5",
          },
          reviewer: { description: "Reviews the diff.", prompt: "You review." },
        });
        assert.equal(providers.probeCount(), 1);
      }),
    ),
  );

  it.effect("ships a role without a model when no hop can run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsPath = yield* writeSettings(settingsFile(tieredPolicy));
        const providers = inventoryOf([claude("claude", ["claude-haiku-4-5"])]);
        const subagents = yield* readCookSubagents({
          settingsPath,
          inventory: providers.inventory,
          sessionSelection: selection,
        });

        assert.deepEqual(subagents.planner, {
          description: "Plans the child.",
          prompt: "You plan.",
        });
      }),
    ),
  );

  it.effect("resolves nothing, and probes nothing, without an in-session role", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsPath = yield* writeSettings(settingsFile({ tiers: {}, inSessionRoles: {} }));
        const providers = inventoryOf([claude("claude", ["claude-sonnet-5"])]);
        const subagents = yield* readCookSubagents({
          settingsPath,
          inventory: providers.inventory,
          sessionSelection: selection,
        });

        assert.deepEqual(subagents, {});
        assert.equal(providers.probeCount(), 0);
      }),
    ),
  );

  it.effect("resolves nothing when the settings file is unreadable", () =>
    Effect.gen(function* () {
      const providers = inventoryOf([claude("claude", ["claude-sonnet-5"])]);
      const subagents = yield* readCookSubagents({
        settingsPath: "/nonexistent/t3-cook/settings.json",
        inventory: providers.inventory,
        sessionSelection: selection,
      });

      assert.deepEqual(subagents, {});
      assert.equal(providers.probeCount(), 0);
    }),
  );
});
