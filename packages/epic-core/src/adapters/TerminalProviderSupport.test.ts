// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeTerminalProviderSupport } from "./TerminalProviderSupport.ts";

it.effect("reports fresh installed fallbacks and keeps the primary instance", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-support-"));
      for (const command of ["claude", "codex"]) {
        const path = NodePath.join(directory, command);
        NodeFS.writeFileSync(path, "#!/bin/sh\nexit 0\n");
        NodeFS.chmodSync(path, 0o755);
      }
      return directory;
    }),
    (directory) =>
      Effect.gen(function* () {
        const support = makeTerminalProviderSupport({
          harness: "claude",
          selection: { instanceId: ProviderInstanceId.make("claude-work"), model: "sonnet" },
          environment: { PATH: directory },
        });
        const providers = yield* support.inventory.getProviders;
        assert.deepEqual(
          providers.map((provider) => [provider.instanceId, provider.driver, provider.installed]),
          [
            ["claude-work", "claudeAgent", true],
            ["codex", "codex", true],
            ["kimi", "kimi", false],
          ],
        );
        NodeFS.copyFileSync(NodePath.join(directory, "codex"), NodePath.join(directory, "kimi"));
        assert.isTrue((yield* support.inventory.getProviders)[2]?.installed);
      }),
    (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
  ),
);
