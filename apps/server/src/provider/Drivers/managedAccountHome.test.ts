import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ensureManagedAccountHome, managedAccountHomePath } from "./managedAccountHome.ts";

it.layer(NodeServices.layer)("managed account home", (it) => {
  it.effect("creates the exact private account path and repairs its mode", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-managed-account-test-",
      });
      const input = {
        accountsDir: path.join(baseDir, "accounts"),
        driverKind: ProviderDriverKind.make("codex"),
        instanceId: ProviderInstanceId.make("codex_work"),
      };
      const expected = path.join(baseDir, "accounts", "codex", "codex_work");

      expect(yield* managedAccountHomePath(input)).toBe(expected);
      expect(yield* ensureManagedAccountHome(input)).toBe(expected);
      expect((yield* fileSystem.stat(expected)).mode & 0o777).toBe(0o700);

      yield* fileSystem.chmod(expected, 0o755);
      expect(yield* ensureManagedAccountHome(input)).toBe(expected);
      expect((yield* fileSystem.stat(expected)).mode & 0o777).toBe(0o700);
    }),
  );
});
