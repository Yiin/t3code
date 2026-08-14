import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeOpenCodeContinuationGroupKey,
  makeOpenCodeEnvironment,
  openCodeAuthFilePath,
  resolveOpenCodeDataHome,
} from "./OpenCodeHome.ts";

it.layer(NodeServices.layer)("OpenCodeHome", (it) => {
  describe("OpenCode data home resolution", () => {
    it.effect("keeps the base environment unchanged when no override is configured", () =>
      Effect.gen(function* () {
        const baseEnv = { HOME: "/home/test", XDG_DATA_HOME: "/accounts/explicit" };

        expect(yield* makeOpenCodeEnvironment({ dataHomePath: "" }, baseEnv)).toBe(baseEnv);
      }),
    );

    it.effect("sets an absolute XDG data home without overriding HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve("accounts/opencode-work");
        const environment = yield* makeOpenCodeEnvironment(
          { dataHomePath: "./accounts/opencode-work" },
          { HOME: "/home/unchanged", XDG_DATA_HOME: "/accounts/ignored" },
        );

        expect(environment).toEqual({
          HOME: "/home/unchanged",
          XDG_DATA_HOME: resolved,
        });
      }),
    );

    it.effect("appends the OpenCode credential file path", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;

        expect(yield* openCodeAuthFilePath({ dataHomePath: "~/.opencode-work" })).toBe(
          path.join(NodeOS.homedir(), ".opencode-work", "opencode", "auth.json"),
        );
      }),
    );

    it.effect("keeps the same resolved local data home in one continuation group", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve("accounts/opencode-work");

        expect(
          yield* makeOpenCodeContinuationGroupKey(
            { dataHomePath: "", serverUrl: "" },
            { XDG_DATA_HOME: resolved },
          ),
        ).toBe(
          yield* makeOpenCodeContinuationGroupKey(
            { dataHomePath: "", serverUrl: "" },
            { XDG_DATA_HOME: "accounts/opencode-work" },
          ),
        );
      }),
    );

    it.effect("uses normalized external server URLs as continuation groups", () =>
      Effect.gen(function* () {
        expect(
          yield* makeOpenCodeContinuationGroupKey(
            { dataHomePath: "", serverUrl: "  HTTP://OpenCode.Example:80  " },
            { XDG_DATA_HOME: "/accounts/one" },
          ),
        ).toBe(
          yield* makeOpenCodeContinuationGroupKey(
            { dataHomePath: "", serverUrl: "http://opencode.example/" },
            { XDG_DATA_HOME: "/accounts/two" },
          ),
        );
        expect(
          yield* makeOpenCodeContinuationGroupKey(
            { dataHomePath: "", serverUrl: "http://other.example" },
            { XDG_DATA_HOME: "/accounts/one" },
          ),
        ).not.toBe(
          yield* makeOpenCodeContinuationGroupKey(
            { dataHomePath: "", serverUrl: "http://opencode.example" },
            { XDG_DATA_HOME: "/accounts/one" },
          ),
        );
      }),
    );

    it.effect("gives the configured path precedence over the instance environment", () =>
      Effect.gen(function* () {
        const environment = yield* makeOpenCodeEnvironment(
          { dataHomePath: "~/accounts/opencode-configured" },
          { XDG_DATA_HOME: "/accounts/from-instance" },
        );

        expect(environment.XDG_DATA_HOME).toBe(
          yield* resolveOpenCodeDataHome({ dataHomePath: "~/accounts/opencode-configured" }),
        );
      }),
    );

    it.effect("uses the effective environment for default data and credential paths", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fromXdg = { XDG_DATA_HOME: "/accounts/from-xdg", HOME: "/home/ignored" };
        const fromHome = { HOME: "/accounts/from-home" };

        expect(yield* resolveOpenCodeDataHome({ dataHomePath: "" }, fromXdg)).toBe(
          "/accounts/from-xdg",
        );
        expect(yield* openCodeAuthFilePath({ dataHomePath: "" }, fromXdg)).toBe(
          path.join("/accounts/from-xdg", "opencode", "auth.json"),
        );
        expect(
          yield* makeOpenCodeContinuationGroupKey({ dataHomePath: "", serverUrl: "" }, fromHome),
        ).toBe(`opencode:data-home:${path.join("/accounts/from-home", ".local", "share")}`);
      }),
    );
  });
});
