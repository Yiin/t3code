import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeOpenCodeContinuationGroupKey,
  makeOpenCodeEnvironment,
  openCodeAuthFilePath,
  resolveOpenCodeHomeLayout,
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

    it.effect("shares the database while keeping each account data home private", () =>
      Effect.gen(function* () {
        const first = { dataHomePath: "/accounts/one", sharedDataHomePath: "/shared/opencode" };
        const second = { dataHomePath: "/accounts/two", sharedDataHomePath: "/shared/opencode" };
        const firstLayout = yield* resolveOpenCodeHomeLayout(first);
        const secondLayout = yield* resolveOpenCodeHomeLayout(second);

        expect(firstLayout.mode).toBe("authOverlay");
        expect(firstLayout.continuationKey).toBe("opencode:data-home:/shared/opencode");
        expect(secondLayout.continuationKey).toBe(firstLayout.continuationKey);
        expect(firstLayout.sharedDatabasePath).toBe("/shared/opencode/opencode/opencode.db");
        expect(yield* makeOpenCodeEnvironment(first, { HOME: "/home/test" })).toMatchObject({
          XDG_DATA_HOME: "/accounts/one",
          OPENCODE_DB: "/shared/opencode/opencode/opencode.db",
        });
        expect(yield* openCodeAuthFilePath(first)).toBe("/accounts/one/opencode/auth.json");
      }),
    );

    it.effect("keeps the direct environment and key when sharing is disabled", () =>
      Effect.gen(function* () {
        const baseEnv = { HOME: "/home/test", XDG_DATA_HOME: "/accounts/one" };
        expect(
          yield* makeOpenCodeEnvironment({ dataHomePath: "", sharedDataHomePath: "" }, baseEnv),
        ).toBe(baseEnv);
        expect(
          yield* makeOpenCodeContinuationGroupKey({
            dataHomePath: "/accounts/one",
            sharedDataHomePath: "",
            serverUrl: "",
          }),
        ).toBe("opencode:data-home:/accounts/one");
      }),
    );

    it.effect("does not set a shared database for an external server", () =>
      Effect.gen(function* () {
        const environment = yield* makeOpenCodeEnvironment({
          dataHomePath: "/accounts/one",
          sharedDataHomePath: "/shared/opencode",
          serverUrl: "https://opencode.example",
        });
        expect(
          yield* makeOpenCodeContinuationGroupKey({
            dataHomePath: "/accounts/one",
            sharedDataHomePath: "/shared/opencode",
            serverUrl: "https://opencode.example",
          }),
        ).toBe("opencode:server:https://opencode.example/");
        expect(environment.OPENCODE_DB).toBeUndefined();
      }),
    );
  });
});
