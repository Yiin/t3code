import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { ProviderInstanceId } from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";

import {
  claudeSignedOutMessage,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
  resolveClaudeInstanceHome,
  claudeInstanceEnvironment,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("isolates added accounts while preserving default and explicit homes", () =>
      Effect.gen(function* () {
        const defaultId = ProviderInstanceId.make("claudeAgent");
        const firstId = ProviderInstanceId.make("claude-work");
        const secondId = ProviderInstanceId.make("claude-personal");
        expect(yield* resolveClaudeInstanceHome(defaultId, { homePath: "" }, "/data/t3")).toBe("");
        expect(
          yield* resolveClaudeInstanceHome(
            firstId,
            { homePath: "/existing/root-login" },
            "/data/t3",
          ),
        ).toBe("/existing/root-login");
        const first = yield* resolveClaudeInstanceHome(firstId, { homePath: "" }, "/data/t3");
        const second = yield* resolveClaudeInstanceHome(secondId, { homePath: "" }, "/data/t3");
        expect(first).toBe("/data/t3/accounts/claudeAgent/instance-claude-work");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("does not inherit another account's credentials into a named instance", () =>
      Effect.gen(function* () {
        const base = {
          CLAUDE_CODE_OAUTH_TOKEN: "inherited-token",
          ANTHROPIC_API_KEY: "inherited-key",
          PATH: "/bin",
        };
        const isolated = yield* mergeProviderInstanceEnvironment(
          claudeInstanceEnvironment(ProviderInstanceId.make("claude-work"), undefined),
          base,
        );
        expect(isolated.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
        expect(isolated.ANTHROPIC_API_KEY).toBe("");
        expect(isolated.PATH).toBe("/bin");
        const explicit = yield* mergeProviderInstanceEnvironment(
          claudeInstanceEnvironment(ProviderInstanceId.make("claude-work"), [
            { name: "ANTHROPIC_API_KEY", value: "instance-key", sensitive: true },
          ]),
          base,
        );
        expect(explicit.ANTHROPIC_API_KEY).toBe("instance-key");
        expect(
          yield* mergeProviderInstanceEnvironment(
            claudeInstanceEnvironment(ProviderInstanceId.make("claudeAgent"), undefined),
            base,
          ),
        ).toBe(base);
      }),
    );
    it.effect("treats empty, ~/.claude, and the expanded default as the same Claude home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(path.join(NodeOS.homedir(), ".claude"));

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: resolved })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);

        const key = `claude:home:${resolved}`;
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "~/.claude" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: resolved })).toBe(key);
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

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then start a new thread");
    });

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });
});
