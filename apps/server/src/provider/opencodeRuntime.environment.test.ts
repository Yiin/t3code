import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import { makeOpenCodeRuntime, makeOpenCodeServerSpawnEnvironment } from "./opencodeRuntime.ts";

describe("makeOpenCodeServerSpawnEnvironment", () => {
  it("keeps the explicit data home beside the injected OpenCode config", () => {
    const options = makeOpenCodeServerSpawnEnvironment({
      PATH: "/bin",
      XDG_DATA_HOME: "/accounts/opencode-work",
    });

    expect(options).toEqual({
      env: {
        PATH: "/bin",
        XDG_DATA_HOME: "/accounts/opencode-work",
        OPENCODE_CONFIG_CONTENT: "{}",
      },
      extendEnv: false,
    });
  });

  it.effect("uses the merged environment in the actual serve spawn", () =>
    Effect.gen(function* () {
      const commands: Array<unknown> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        commands.push(command);
        return Effect.die(new Error("stop after recording spawn"));
      });
      const netService: NetService.NetServiceShape = {
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        reserveLoopbackPort: () => Effect.succeed(4096),
        findAvailablePort: () => Effect.succeed(4096),
      };

      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* makeOpenCodeRuntime;
            return yield* runtime.startOpenCodeServerProcess({
              binaryPath: "opencode",
              environment: {
                PATH: "/bin",
                XDG_DATA_HOME: "/accounts/opencode-work",
              },
              port: 4096,
            });
          }),
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(NetService.NetService, netService),
          Effect.provideService(HostProcessPlatform, "win32"),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(commands).toHaveLength(1);
      const command = commands[0] as {
        readonly options: {
          readonly env: NodeJS.ProcessEnv;
          readonly extendEnv: boolean;
        };
      };
      expect(command.options.env.XDG_DATA_HOME).toBe("/accounts/opencode-work");
      expect(command.options.env.OPENCODE_CONFIG_CONTENT).toBe("{}");
      expect(command.options.extendEnv).toBe(false);
    }),
  );
});
