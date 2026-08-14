import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeKimiContinuationGroupKey,
  makeKimiEnvironment,
  resolveKimiHomePath,
} from "./KimiHome.ts";

it.layer(NodeServices.layer)("KimiHome", (it) => {
  describe("Kimi home resolution", () => {
    it.effect("keeps the base environment unchanged when no home override is configured", () =>
      Effect.gen(function* () {
        const baseEnv = { HOME: "/home/test", KIMI_CODE_HOME: "/accounts/explicit" };

        expect(yield* makeKimiEnvironment({ homePath: "" }, baseEnv)).toBe(baseEnv);
      }),
    );

    it.effect("resolves a tilde-prefixed Kimi home without overriding HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir(), ".kimi-code-work");
        const environment = yield* makeKimiEnvironment(
          { homePath: "~/.kimi-code-work" },
          { HOME: "/home/unchanged", KIMI_CODE_HOME: "/accounts/explicit" },
        );

        expect(yield* resolveKimiHomePath({ homePath: "~/.kimi-code-work" })).toBe(resolved);
        expect(environment).toEqual({
          HOME: "/home/unchanged",
          KIMI_CODE_HOME: resolved,
        });
      }),
    );

    it.effect("uses the final effective environment for continuation identity", () =>
      Effect.gen(function* () {
        const explicitEnvironment = { KIMI_CODE_HOME: "./accounts/kimi-work" };
        const configuredEnvironment = yield* makeKimiEnvironment(
          { homePath: "./accounts/kimi-work" },
          { KIMI_CODE_HOME: "/ignored" },
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

        expect(yield* makeKimiContinuationGroupKey({ KIMI_CODE_HOME: resolved })).toBe(
          yield* makeKimiContinuationGroupKey({ KIMI_CODE_HOME: "accounts/kimi-work" }),
        );
      }),
    );
  });
});
