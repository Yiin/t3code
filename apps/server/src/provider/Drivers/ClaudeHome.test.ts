import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ClaudeSettings } from "@t3tools/contracts";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  makeClaudeLegacyContinuationKeys,
  materializeClaudeShadowHome,
  resolveClaudeHomeLayout,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("finds pre-overlay account keys and omits the current shared key", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const accountsDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-accounts-" });
        const managedRoot = path.join(accountsDir, "claudeAgent");
        yield* fs.makeDirectory(path.join(managedRoot, "personal"), { recursive: true });
        yield* fs.makeDirectory(path.join(managedRoot, "work"), { recursive: true });

        const keys = yield* makeClaudeLegacyContinuationKeys({
          config: { homePath: path.join(accountsDir, "shared") },
          accountsDir,
        });

        expect(keys).toEqual([
          `claude:home:${path.resolve(managedRoot, "personal")}`,
          `claude:home:${path.resolve(managedRoot, "work")}`,
        ]);
      }),
    );

    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          `claude:home:${resolved}`,
        );
      }),
    );

    it.effect("shares the continuation key across Claude shadow homes", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "t3code-claude-shared-",
        });
        const first = yield* resolveClaudeHomeLayout(
          decodeClaudeSettings({
            homePath: sharedHome,
            shadowHomePath: path.join(sharedHome, "one"),
          }),
        );
        const second = yield* resolveClaudeHomeLayout(
          decodeClaudeSettings({
            homePath: sharedHome,
            shadowHomePath: path.join(sharedHome, "two"),
          }),
        );
        expect(first.mode).toBe("authOverlay");
        expect(first.continuationKey).toBe(second.continuationKey);
        expect(first.sharedStatePath).toBe(sharedHome);
      }),
    );

    it.effect("materializes shared Claude state while keeping credentials and sessions local", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-claude-shared-",
        });
        const shadowHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-claude-shadow-",
        });
        yield* fileSystem.makeDirectory(path.join(sharedHome, "projects"));
        yield* fileSystem.writeFileString(path.join(sharedHome, "settings.json"), "shared");
        yield* fileSystem.writeFileString(path.join(shadowHome, ".credentials.json"), "private");
        yield* fileSystem.makeDirectory(path.join(shadowHome, "sessions"));
        const layout = yield* resolveClaudeHomeLayout(
          decodeClaudeSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );
        yield* materializeClaudeShadowHome(layout);
        expect(yield* fileSystem.readLink(path.join(shadowHome, "projects"))).toBe(
          path.join(sharedHome, "projects"),
        );
        expect(yield* fileSystem.readFileString(path.join(shadowHome, ".credentials.json"))).toBe(
          "private",
        );
        expect(yield* fileSystem.exists(path.join(shadowHome, "sessions"))).toBe(true);
        expect(yield* fileSystem.readLink(path.join(shadowHome, "settings.json"))).toBe(
          path.join(sharedHome, "settings.json"),
        );
      }),
    );

    it.effect("preserves account runtime state when the shared home also has state", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-state-" });
        const sharedHome = path.join(root, "shared");
        const shadowHome = path.join(root, "account");
        for (const home of [sharedHome, shadowHome]) {
          yield* fileSystem.makeDirectory(path.join(home, "state"), { recursive: true });
        }
        const sharedState = path.join(sharedHome, "state", "mcp-discover-verdicts.json");
        const accountState = path.join(shadowHome, "state", "mcp-discover-verdicts.json");
        yield* fileSystem.writeFileString(sharedState, "shared");
        yield* fileSystem.writeFileString(accountState, "account");
        yield* fileSystem.writeFileString(path.join(shadowHome, ".credentials.json"), "private");
        const layout = yield* resolveClaudeHomeLayout(
          decodeClaudeSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );

        yield* materializeClaudeShadowHome(layout);
        yield* materializeClaudeShadowHome(layout);

        expect(yield* fileSystem.readFileString(accountState)).toBe("account");
        expect(yield* fileSystem.readFileString(sharedState)).toBe("shared");
        expect(yield* fileSystem.readFileString(path.join(shadowHome, ".credentials.json"))).toBe(
          "private",
        );
        expect(yield* fileSystem.readLink(path.join(shadowHome, "projects"))).toBe(
          path.join(sharedHome, "projects"),
        );
      }),
    );

    it.effect("unlinks shared runtime state without removing the shared data", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-state-link-" });
        const sharedHome = path.join(root, "shared");
        const shadowHome = path.join(root, "account");
        const sharedState = path.join(sharedHome, "state");
        const accountState = path.join(shadowHome, "state");
        yield* fileSystem.makeDirectory(sharedState, { recursive: true });
        yield* fileSystem.makeDirectory(shadowHome);
        yield* fileSystem.writeFileString(
          path.join(sharedState, "mcp-discover-verdicts.json"),
          "shared",
        );
        yield* fileSystem.symlink(sharedState, accountState);
        const layout = yield* resolveClaudeHomeLayout(
          decodeClaudeSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );

        yield* materializeClaudeShadowHome(layout);
        expect(yield* fileSystem.exists(accountState)).toBe(false);
        yield* fileSystem.makeDirectory(accountState);
        yield* fileSystem.writeFileString(
          path.join(accountState, "mcp-discover-verdicts.json"),
          "account",
        );
        yield* materializeClaudeShadowHome(layout);

        expect(
          yield* fileSystem.readFileString(path.join(accountState, "mcp-discover-verdicts.json")),
        ).toBe("account");
        expect(
          yield* fileSystem.readFileString(path.join(sharedState, "mcp-discover-verdicts.json")),
        ).toBe("shared");
      }),
    );
  });
});
