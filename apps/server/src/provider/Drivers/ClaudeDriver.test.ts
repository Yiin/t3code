import { describe, it, assert } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

import { makeClaudeModelCatalogKey, resolveClaudeModelCatalogKey } from "./ClaudeDriver.ts";

describe("Claude model catalog identity", () => {
  it("keeps POSIX path case distinct", () => {
    assert.notEqual(
      makeClaudeModelCatalogKey("/opt/Claude", "linux"),
      makeClaudeModelCatalogKey("/opt/claude", "linux"),
    );
  });

  it("normalizes Windows path separators and case", () => {
    assert.equal(
      makeClaudeModelCatalogKey("C:\\Tools\\Claude.EXE", "win32"),
      makeClaudeModelCatalogKey("c:/tools/claude.exe", "win32"),
    );
  });

  it.effect("uses the resolved executable and instance environment", () =>
    Effect.gen(function* () {
      const seenEnvironments: NodeJS.ProcessEnv[] = [];
      const resolveForPath = (pathValue: string) =>
        resolveClaudeModelCatalogKey("claude", { PATH: pathValue }).pipe(
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(SpawnExecutableResolution, (_command, _platform, environment) => {
            seenEnvironments.push(environment);
            return `${environment.PATH}/claude`;
          }),
        );

      assert.notEqual(
        yield* resolveForPath("/accounts/personal/bin"),
        yield* resolveForPath("/accounts/work/bin"),
      );
      assert.deepEqual(
        seenEnvironments.map((environment) => environment.PATH),
        ["/accounts/personal/bin", "/accounts/work/bin"],
      );
    }),
  );

  it.effect("falls back to the configured path when resolution fails", () =>
    resolveClaudeModelCatalogKey("CustomClaude", {}).pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(SpawnExecutableResolution, () => {
        throw new Error("resolution failed");
      }),
      Effect.map((key) => assert.equal(key, "claudeAgent:executable:CustomClaude")),
    ),
  );
});
