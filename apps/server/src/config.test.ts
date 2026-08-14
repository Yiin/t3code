import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { deriveServerPaths, ensureServerDirectories } from "./config.ts";

it.layer(NodeServices.layer)("server paths", (it) => {
  it.effect("creates and repairs the private accounts directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-config-test-" });
      const derivedPaths = yield* deriveServerPaths(baseDir, undefined);

      expect(derivedPaths.accountsDir).toBe(path.join(baseDir, "accounts"));

      yield* ensureServerDirectories(derivedPaths);
      expect((yield* fileSystem.stat(derivedPaths.accountsDir)).mode & 0o777).toBe(0o700);

      yield* fileSystem.chmod(derivedPaths.accountsDir, 0o755);
      yield* ensureServerDirectories(derivedPaths);
      expect((yield* fileSystem.stat(derivedPaths.accountsDir)).mode & 0o777).toBe(0o700);
    }),
  );
});
