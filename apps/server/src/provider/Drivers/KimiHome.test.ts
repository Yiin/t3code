import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  makeKimiContinuationGroupKey,
  makeKimiEnvironment,
  materializeKimiShadowHome,
  resolveKimiHomePath,
  resolveKimiHomeLayout,
} from "./KimiHome.ts";

it.layer(NodeServices.layer)("KimiHome", (it) => {
  describe("Kimi home resolution", () => {
    it.effect("shares continuation identity while isolating the shadow home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHomePath = path.resolve("kimi-shared");
        const first = yield* resolveKimiHomeLayout({
          homePath: sharedHomePath,
          shadowHomePath: "kimi-first",
        });
        const second = yield* resolveKimiHomeLayout({
          homePath: sharedHomePath,
          shadowHomePath: "kimi-second",
        });

        expect(first.mode).toBe("authOverlay");
        expect(first.effectiveHomePath).not.toBe(first.sharedHomePath);
        expect(first.continuationKey).toBe(second.continuationKey);
        expect(first.continuationKey).toBe(`kimi:home:${sharedHomePath}`);
      }),
    );

    it.effect("materializes shared files and directories as shadow symlinks", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHomePath = yield* fileSystem.makeTempDirectory({ prefix: "kimi-shared-" });
        const shadowHomePath = yield* fileSystem.makeTempDirectory({ prefix: "kimi-shadow-" });
        const sharedSessions = path.join(sharedHomePath, "sessions");
        yield* fileSystem.makeDirectory(sharedSessions);
        yield* fileSystem.writeFileString(path.join(sharedHomePath, "session_index.jsonl"), "");
        const layout = yield* resolveKimiHomeLayout({ homePath: sharedHomePath, shadowHomePath });
        yield* materializeKimiShadowHome(layout);

        expect(yield* fileSystem.readLink(path.join(shadowHomePath, "sessions"))).toBe(
          sharedSessions,
        );
        expect(yield* fileSystem.readLink(path.join(shadowHomePath, "session_index.jsonl"))).toBe(
          path.join(sharedHomePath, "session_index.jsonl"),
        );
        expect((yield* fileSystem.stat(path.join(shadowHomePath, "credentials"))).type).toBe(
          "Directory",
        );
      }),
    );

    it.effect("keeps the base environment unchanged when no home override is configured", () =>
      Effect.gen(function* () {
        const baseEnv = { HOME: "/home/test", KIMI_SHARE_DIR: "/accounts/explicit" };

        expect(yield* makeKimiEnvironment({ homePath: "" }, baseEnv)).toBe(baseEnv);
      }),
    );

    it.effect("resolves a tilde-prefixed Kimi home without overriding HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir(), ".kimi-code-work");
        const environment = yield* makeKimiEnvironment(
          { homePath: "~/.kimi-code-work" },
          { HOME: "/home/unchanged", KIMI_SHARE_DIR: "/accounts/explicit" },
        );

        expect(yield* resolveKimiHomePath({ homePath: "~/.kimi-code-work" })).toBe(resolved);
        expect(environment).toEqual({
          HOME: "/home/unchanged",
          KIMI_SHARE_DIR: resolved,
        });
      }),
    );

    it.effect("uses the final effective environment for continuation identity", () =>
      Effect.gen(function* () {
        const explicitEnvironment = { KIMI_SHARE_DIR: "./accounts/kimi-work" };
        const configuredEnvironment = yield* makeKimiEnvironment(
          { homePath: "./accounts/kimi-work" },
          { KIMI_SHARE_DIR: "/ignored" },
        );

        expect(yield* makeKimiContinuationGroupKey(explicitEnvironment)).toBe(
          yield* makeKimiContinuationGroupKey(configuredEnvironment),
        );
      }),
    );

    it.effect("keeps instances with the same resolved runtime home in one continuation group", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve("accounts/kimi-work");

        expect(yield* makeKimiContinuationGroupKey({ KIMI_SHARE_DIR: resolved })).toBe(
          yield* makeKimiContinuationGroupKey({ KIMI_SHARE_DIR: "accounts/kimi-work" }),
        );
      }),
    );
  });
});
