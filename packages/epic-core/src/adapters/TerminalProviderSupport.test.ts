// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
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

it.effect("maps Prime to its first-class driver and primary binary without fallbacks", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prime-support-"));
      const binary = NodePath.join(directory, "custom-prime-agent");
      NodeFS.writeFileSync(binary, "#!/bin/sh\nexit 0\n");
      NodeFS.chmodSync(binary, 0o755);
      return { directory, binary };
    }),
    ({ directory, binary }) =>
      Effect.gen(function* () {
        const defaultSupport = makeTerminalProviderSupport({
          harness: "prime",
          selection: { instanceId: ProviderInstanceId.make("prime-work"), model: "default" },
          environment: { PATH: directory },
        });
        assert.deepEqual(defaultSupport.routes, [
          {
            instanceId: ProviderInstanceId.make("prime-work"),
            driver: ProviderDriverKind.make("primeAgent"),
            harness: "prime",
            binary: "prime-agent",
            model: "default",
            primary: true,
          },
        ]);
        assert.isFalse((yield* defaultSupport.inventory.getProviders)[0]?.installed);

        const overrideSupport = makeTerminalProviderSupport({
          harness: "prime",
          selection: { instanceId: ProviderInstanceId.make("prime-work"), model: "prime/model" },
          binary,
          environment: { PATH: directory },
        });
        const provider = (yield* overrideSupport.inventory.getProviders)[0];
        assert.isTrue(provider?.installed);
        assert.equal(provider?.driver, "primeAgent");
        assert.equal(overrideSupport.routes[0]?.binary, binary);
      }),
    ({ directory }) =>
      Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
  ),
);
