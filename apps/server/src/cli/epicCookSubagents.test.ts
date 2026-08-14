import * as NodeOS from "node:os";

import {
  DEFAULT_EPIC_ROLE_POLICY,
  DEFAULT_EPIC_STAGE_SUBAGENTS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { parsePersistedEpicRolePolicy } from "@t3tools/shared/serverSettings";
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
  widenInventoryWithPolicyModels,
} from "./epicCookSubagents.ts";

const providerOf = (
  driver: string,
  instanceId: string,
  models: ReadonlyArray<string>,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
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

const claude = (instanceId: string, models: ReadonlyArray<string>): ServerProvider =>
  providerOf("claudeAgent", instanceId, models);

const codex = (instanceId: string, models: ReadonlyArray<string>): ServerProvider =>
  providerOf("codex", instanceId, models);

const settingsFile = (policy: unknown) => JSON.stringify({ epicRolePolicy: policy });

const DEFAULT_STAGE_SUBAGENT_NAMES = Object.keys(DEFAULT_EPIC_STAGE_SUBAGENTS);

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

/** Every hop names an account this terminal run does not have. */
const absentAccountPolicy = {
  tiers: {
    high: {
      hops: [{ selection: { instanceId: "claude-work", model: "claude-opus-5" } }],
    },
  },
  inSessionRoles: {
    planner: { tier: "high", description: "Plans the child.", prompt: "You plan." },
  },
};

/** One hop, on the account the session itself runs on, at another model. */
const sameAccountPolicy = {
  tiers: {
    high: {
      hops: [{ selection: { instanceId: "claude", model: "claude-opus-5" } }],
    },
  },
  inSessionRoles: {
    planner: { tier: "high", description: "Plans the child.", prompt: "You plan." },
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

  it.effect("reads the default policy when the settings file is missing", () =>
    Effect.gen(function* () {
      const policy = yield* readEpicRolePolicy("/nonexistent/t3-cook/settings.json");
      assert.deepEqual(policy, DEFAULT_EPIC_ROLE_POLICY);
      assert.deepEqual(Object.keys(policy.inSessionRoles), DEFAULT_STAGE_SUBAGENT_NAMES);
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

  it.effect("resolves a hop on the session's own account at another model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsPath = yield* writeSettings(settingsFile(sameAccountPolicy));
        // The terminal inventory gives each route one model slug, the session's
        // own. The hop names the same account at a model the same binary serves,
        // so widening lets it resolve instead of stripping the role's model.
        const providers = inventoryOf([claude("claude", ["claude-sonnet-5"])]);
        const subagents = yield* readCookSubagents({
          settingsPath,
          inventory: providers.inventory,
          sessionSelection: selection,
        });

        assert.deepEqual(subagents.planner, {
          description: "Plans the child.",
          prompt: "You plan.",
          model: "claude-opus-5",
        });
      }),
    ),
  );

  it.effect("ships a role without a model when every hop names an absent account", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsPath = yield* writeSettings(settingsFile(absentAccountPolicy));
        const providers = inventoryOf([claude("claude", ["claude-sonnet-5"])]);
        const subagents = yield* readCookSubagents({
          settingsPath,
          inventory: providers.inventory,
          sessionSelection: selection,
        });

        // Widening teaches an account its own hops' models. It never invents the
        // account, so a hop this run cannot route to still costs the role its
        // model.
        assert.deepEqual(subagents.planner, {
          description: "Plans the child.",
          prompt: "You plan.",
        });
      }),
    ),
  );

  it.effect("widens only the account a hop names", () =>
    Effect.sync(() => {
      const policy = parsePersistedEpicRolePolicy(settingsFile(sameAccountPolicy));
      const widened = widenInventoryWithPolicyModels(
        [claude("claude", ["claude-sonnet-5"]), codex("codex", ["gpt-5.6-sol"])],
        policy,
      );

      assert.deepEqual(
        widened.map((provider) => [provider.instanceId, provider.models.map((m) => m.slug)]),
        [
          ["claude", ["claude-sonnet-5", "claude-opus-5"]],
          // An instance id is the routing identity, so a claude hop can never
          // teach a codex route a model it cannot run.
          ["codex", ["gpt-5.6-sol"]],
        ],
      );
    }),
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

  it.effect("falls back to the shipped stage subagents when the settings file is unreadable", () =>
    Effect.gen(function* () {
      const providers = inventoryOf([claude("claude", ["claude-sonnet-5"])]);
      const subagents = yield* readCookSubagents({
        settingsPath: "/nonexistent/t3-cook/settings.json",
        inventory: providers.inventory,
        sessionSelection: selection,
      });

      // A fresh install has no settings file, so the cook CLI resolves the same
      // six stage subagents the server injects. They ship tier-less, so every
      // one arrives without a model and inherits the session's.
      assert.deepEqual(Object.keys(subagents), DEFAULT_STAGE_SUBAGENT_NAMES);
      for (const definition of Object.values(subagents)) {
        assert.equal(definition.model, undefined);
      }
    }),
  );
});
