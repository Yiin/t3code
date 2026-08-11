import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { KimiSettings } from "@t3tools/contracts";

import { checkKimiProviderStatus, kimiAuthFromCredentialsJson } from "./KimiProvider.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);

const CREDENTIALS_WITH_TOKENS_JSON = '{"access_token":"a","refresh_token":"r","expires_at":0}';

describe("kimiAuthFromCredentialsJson", () => {
  it("is unauthenticated when the file is missing or empty", () => {
    expect(kimiAuthFromCredentialsJson("")).toEqual({ status: "unauthenticated" });
    expect(kimiAuthFromCredentialsJson("   \n")).toEqual({ status: "unauthenticated" });
  });

  it("is unauthenticated when the file is not valid JSON or not an object", () => {
    expect(kimiAuthFromCredentialsJson("not json")).toEqual({ status: "unauthenticated" });
    expect(kimiAuthFromCredentialsJson("[]")).toEqual({ status: "unauthenticated" });
    expect(kimiAuthFromCredentialsJson("null")).toEqual({ status: "unauthenticated" });
  });

  it("is unauthenticated when no tokens are stored", () => {
    expect(kimiAuthFromCredentialsJson("{}")).toEqual({ status: "unauthenticated" });
    expect(kimiAuthFromCredentialsJson('{"access_token":"  ","refresh_token":""}')).toEqual({
      status: "unauthenticated",
    });
  });

  it("is authenticated when a refresh token is stored, even with an expired access token", () => {
    expect(kimiAuthFromCredentialsJson(CREDENTIALS_WITH_TOKENS_JSON)).toEqual({
      status: "authenticated",
      type: "oauth",
      label: "Kimi OAuth",
    });
  });

  it("is authenticated when only an access token is stored", () => {
    expect(kimiAuthFromCredentialsJson('{"access_token":"a"}')).toEqual({
      status: "authenticated",
      type: "oauth",
      label: "Kimi OAuth",
    });
  });
});

describe("checkKimiProviderStatus", () => {
  const makeFakeKimiBinary = Effect.fn("makeFakeKimiBinary")(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectory({
      directory: NodeOS.tmpdir(),
      prefix: "kimi-provider-test-",
    });
    const binaryPath = path.join(dir, "fake-kimi.sh");
    yield* fileSystem.writeFileString(
      binaryPath,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "kimi-code 0.29.0"; exit 0; fi\nexit 1\n',
    );
    yield* fileSystem.chmod(binaryPath, 0o755);
    return binaryPath;
  });

  const checkWithHome = (kimiHome: string | null) =>
    Effect.gen(function* () {
      const binaryPath = yield* makeFakeKimiBinary();
      const settings = decodeKimiSettings({ binaryPath });
      const environment = { ...process.env };
      if (kimiHome !== null) {
        environment.KIMI_CODE_HOME = kimiHome;
      } else {
        delete environment.KIMI_CODE_HOME;
      }
      return yield* checkKimiProviderStatus(settings, environment);
    });

  it.effect("reports authenticated when KIMI_CODE_HOME holds OAuth credentials", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "kimi-home-",
      });
      const credentialsDir = path.join(home, "credentials");
      yield* fileSystem.makeDirectory(credentialsDir);
      yield* fileSystem.writeFileString(
        path.join(credentialsDir, "kimi-code.json"),
        CREDENTIALS_WITH_TOKENS_JSON,
      );
      const snapshot = yield* checkWithHome(home);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("0.29.0");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "oauth",
        label: "Kimi OAuth",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports unauthenticated with a login hint when no credentials exist", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "kimi-home-",
      });
      const snapshot = yield* checkWithHome(home);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toEqual({ status: "unauthenticated" });
      expect(snapshot.message).toContain("kimi login");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
