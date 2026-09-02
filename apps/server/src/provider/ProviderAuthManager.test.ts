import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import * as ProviderAuthManager from "./ProviderAuthManager.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid: number;
  readonly killSignals: Array<string | undefined> = [];
  readonly writes: Array<string> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  throwOnKill = false;
  killFailuresRemaining = 0;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string): void {
    this.writes.push(data);
  }
  resize(): void {}

  kill(signal?: string): void {
    this.killSignals.push(signal);
    if (this.killFailuresRemaining > 0) {
      this.killFailuresRemaining -= 1;
      throw new Error("fake first kill failure");
    }
    if (this.throwOnKill) throw new Error("fake kill failure");
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) listener({ exitCode, signal: null });
  }
}

class FakePtyAdapter {
  readonly inputs: PtyAdapter.PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];

  spawn = (input: PtyAdapter.PtySpawnInput): Effect.Effect<PtyAdapter.PtyProcess> => {
    this.inputs.push(input);
    const process = new FakePtyProcess(4_000 + this.processes.length);
    this.processes.push(process);
    return Effect.succeed(process);
  };
}

const waitFor = Effect.fn("ProviderAuthManager.test.waitFor")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean,
): Effect.fn.Return<A, E, R> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = yield* effect;
    if (predicate(value)) return value;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die("condition was not met");
});

const currentState = (
  manager: ProviderAuthManager.ProviderAuthManager["Service"],
  terminalId: string,
) =>
  manager
    .loginStatus(terminalId)
    .pipe(Stream.take(1), Stream.runHead, Effect.map(Option.getOrThrow));

/**
 * The harness home variables the login command table is asserted against.
 *
 * `mergeProviderInstanceEnvironment` builds a login environment on top of
 * `process.env`, which is right in production — a login terminal should inherit
 * the host env. It also means a shell that exports one of these leaks it into
 * every row, so the codex/kimi/opencode rows see the host's `CLAUDE_CONFIG_DIR`
 * where the assertion expects `undefined`. Any t3 Claude agent session with a
 * shadow home is such a shell (t3code-y4l).
 */
const HARNESS_HOME_VARIABLES = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "KIMI_SHARE_DIR",
  "XDG_DATA_HOME",
] as const;

/** Take the harness home variables out of `process.env` for one scope. */
const withoutHostHarnessHomes = Effect.acquireRelease(
  Effect.sync(() => {
    const saved = HARNESS_HOME_VARIABLES.map((name) => [name, process.env[name]] as const);
    for (const name of HARNESS_HOME_VARIABLES) delete process.env[name];
    return saved;
  }),
  (saved) =>
    Effect.sync(() => {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }),
);

const makeHarness = Effect.fn("ProviderAuthManager.test.makeHarness")(function* () {
  yield* withoutHostHarnessHomes;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "provider-auth-" });
  const accountsDir = path.join(baseDir, "accounts");
  yield* fileSystem.makeDirectory(accountsDir, { recursive: true });

  const instanceIds = {
    claudeAgent: ProviderInstanceId.make("claude-work"),
    codex: ProviderInstanceId.make("codex-work"),
    kimi: ProviderInstanceId.make("kimi-work"),
    opencode: ProviderInstanceId.make("opencode-work"),
  } as const;
  const homes = {
    claudeAgent: path.join(accountsDir, "claudeAgent", instanceIds.claudeAgent),
    codex: path.join(accountsDir, "codex", instanceIds.codex),
    kimi: path.join(accountsDir, "kimi", instanceIds.kimi),
    opencode: path.join(accountsDir, "opencode", instanceIds.opencode),
  } as const;
  yield* Effect.forEach(Object.values(homes), (home) =>
    fileSystem.makeDirectory(home, { recursive: true }),
  );

  const providerInstances = {
    [instanceIds.claudeAgent]: {
      driver: "claudeAgent",
      environment: [{ name: "HOME", value: "/unchanged", sensitive: false }],
      config: { binaryPath: "claude-test", shadowHomePath: homes.claudeAgent },
    },
    [instanceIds.codex]: {
      driver: "codex",
      environment: [{ name: "HOME", value: "/unchanged", sensitive: false }],
      config: { binaryPath: "codex-test", shadowHomePath: homes.codex },
    },
    [instanceIds.kimi]: {
      driver: "kimi",
      environment: [{ name: "HOME", value: "/unchanged", sensitive: false }],
      config: { binaryPath: "kimi-test", homePath: homes.kimi },
    },
    [instanceIds.opencode]: {
      driver: "opencode",
      environment: [{ name: "HOME", value: "/unchanged", sensitive: false }],
      config: { binaryPath: "opencode-test", dataHomePath: homes.opencode },
    },
  } as unknown as ProviderInstanceConfigMap;

  const pty = new FakePtyAdapter();
  const refreshes = yield* Ref.make<Array<string>>([]);
  const providers: ReadonlyArray<ServerProvider> = [];
  const registry = Layer.mock(ProviderRegistry)({
    getProviders: Effect.succeed(providers),
    refresh: () => Effect.succeed(providers),
    refreshInstance: (instanceId) =>
      Ref.update(refreshes, (values) => [...values, instanceId]).pipe(Effect.as(providers)),
    getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
    setProviderMaintenanceActionState: () => Effect.succeed(providers),
    recordModelCatalog: () => Effect.succeed(providers),
    streamChanges: Stream.empty,
  });
  const settingsLayer = ServerSettings.layerTest({ providerInstances });
  const managerLayer = ProviderAuthManager.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(PtyAdapter.PtyAdapter, PtyAdapter.PtyAdapter.of({ spawn: pty.spawn })),
        registry,
        settingsLayer,
        ServerConfig.layerTest(process.cwd(), baseDir),
      ),
    ),
  );
  const managerContext = yield* Layer.build(Layer.mergeAll(managerLayer, settingsLayer));
  const manager = Context.get(managerContext, ProviderAuthManager.ProviderAuthManager);
  const settings = Context.get(managerContext, ServerSettings.ServerSettingsService);

  return { manager, settings, pty, refreshes, instanceIds, homes, accountsDir, providerInstances };
});

describe("ProviderAuthManager", () => {
  it.layer(NodeServices.layer)(
    "login command table isolates every account without changing HOME",
    (it) =>
      it.effect("uses exact argv and home overlays", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const starts = yield* Effect.all([
            harness.manager.loginStart({ instanceId: harness.instanceIds.claudeAgent }),
            harness.manager.loginStart({ instanceId: harness.instanceIds.codex }),
            harness.manager.loginStart({ instanceId: harness.instanceIds.kimi }),
            harness.manager.loginStart({
              instanceId: harness.instanceIds.opencode,
              provider: "anthropic",
              method: "oauth",
            }),
          ]);

          assert.deepEqual(
            harness.pty.inputs.map((input) => [input.shell, input.args]),
            [
              ["claude-test", ["auth", "login"]],
              ["codex-test", ["login", "--device-auth"]],
              ["kimi-test", ["login"]],
              ["opencode-test", ["auth", "login", "--provider", "anthropic", "--method", "oauth"]],
            ],
          );
          assert.deepEqual(
            harness.pty.inputs.map((input) => ({
              HOME: input.env.HOME,
              CLAUDE_CONFIG_DIR: input.env.CLAUDE_CONFIG_DIR,
              CODEX_HOME: input.env.CODEX_HOME,
              KIMI_SHARE_DIR: input.env.KIMI_SHARE_DIR,
              XDG_DATA_HOME: input.env.XDG_DATA_HOME,
            })),
            [
              {
                HOME: "/unchanged",
                CLAUDE_CONFIG_DIR: harness.homes.claudeAgent,
                CODEX_HOME: undefined,
                KIMI_SHARE_DIR: undefined,
                XDG_DATA_HOME: undefined,
              },
              {
                HOME: "/unchanged",
                CLAUDE_CONFIG_DIR: undefined,
                CODEX_HOME: harness.homes.codex,
                KIMI_SHARE_DIR: undefined,
                XDG_DATA_HOME: undefined,
              },
              {
                HOME: "/unchanged",
                CLAUDE_CONFIG_DIR: undefined,
                CODEX_HOME: undefined,
                KIMI_SHARE_DIR: harness.homes.kimi,
                XDG_DATA_HOME: undefined,
              },
              {
                HOME: "/unchanged",
                CLAUDE_CONFIG_DIR: undefined,
                CODEX_HOME: undefined,
                KIMI_SHARE_DIR: undefined,
                XDG_DATA_HOME: harness.homes.opencode,
              },
            ],
          );
          yield* Effect.forEach(starts, (start) =>
            harness.manager.loginCancel({ terminalId: start.terminalId }),
          );
        }),
      ),
  );

  it.layer(NodeServices.layer)("captures output and terminal outcomes", (it) =>
    it.effect(
      "publishes URL, code, byte-capped tail, failure, cancel, and duplicate rejection",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const start = yield* harness.manager.loginStart({
            instanceId: harness.instanceIds.codex,
          });
          const duplicate = yield* Effect.result(
            harness.manager.loginStart({ instanceId: harness.instanceIds.codex }),
          );
          assert.equal(duplicate._tag, "Failure");

          harness.pty.processes[0]!.emitData(
            `Open https://example.test/device and enter code ABCD-1234\n${"🙂".repeat(4_000)}`,
          );
          const running = yield* waitFor(
            currentState(harness.manager, start.terminalId),
            (state) => state.userCode === "ABCD-1234",
          );
          assert.equal(running.verificationUrl, "https://example.test/device");
          assert.equal(running.userCode, "ABCD-1234");
          assert.isAtMost(Buffer.byteLength(running.output, "utf8"), 10_000);

          harness.pty.processes[0]!.emitExit(9);
          const failed = yield* waitFor(
            currentState(harness.manager, start.terminalId),
            (state) => state.status === "failed",
          );
          assert.equal(failed.message, "Provider login exited with code 9.");

          const second = yield* harness.manager.loginStart({
            instanceId: harness.instanceIds.codex,
          });
          const cancelled = yield* harness.manager.loginCancel({ terminalId: second.terminalId });
          assert.equal(cancelled.state.status, "cancelled");
          assert.isAbove(harness.pty.processes[1]!.killSignals.length, 0);
        }),
    ),
  );

  it.layer(NodeServices.layer)("forwards interactive input to the login PTY", (it) => {
    it.effect("writes the submitted code plus a carriage return", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const start = yield* harness.manager.loginStart({
          instanceId: harness.instanceIds.claudeAgent,
        });
        const result = yield* harness.manager.loginRespond({
          terminalId: start.terminalId,
          data: "sk-ant-oat-code-1234",
        });
        assert.equal(result.state.status, "running");
        assert.deepEqual(harness.pty.processes[0]!.writes, ["sk-ant-oat-code-1234\r"]);
        yield* harness.manager.loginCancel({ terminalId: start.terminalId });
      }),
    );

    it.effect("rejects input once the login is no longer running", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const start = yield* harness.manager.loginStart({
          instanceId: harness.instanceIds.claudeAgent,
        });
        yield* harness.manager.loginCancel({ terminalId: start.terminalId });
        const rejected = yield* Effect.result(
          harness.manager.loginRespond({ terminalId: start.terminalId, data: "late" }),
        );
        assert.equal(rejected._tag, "Failure");
        assert.deepEqual(harness.pty.processes[0]!.writes, []);
      }),
    );

    it.effect("unwraps an OSC 8 hyperlink to a single clean URL", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const start = yield* harness.manager.loginStart({
          instanceId: harness.instanceIds.claudeAgent,
        });
        const esc = String.fromCharCode(27);
        const url = "https://example.test/oauth/authorize?code=true&state=abc";
        harness.pty.processes[0]!.emitData(
          `visit: ${esc}]8;;${url}${esc}\\${url}${esc}]8;;${esc}\\\n`,
        );
        const state = yield* waitFor(
          currentState(harness.manager, start.terminalId),
          (value) => value.verificationUrl !== null,
        );
        assert.equal(state.verificationUrl, url);
        yield* harness.manager.loginCancel({ terminalId: start.terminalId });
      }),
    );

    it.effect("never reports Claude's paste prompt as a device code", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const start = yield* harness.manager.loginStart({
          instanceId: harness.instanceIds.claudeAgent,
        });
        const process = harness.pty.processes[0]!;
        process.emitData(
          "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/oauth/authorize\nPaste code here if prompted >\n",
        );
        const state = yield* waitFor(
          currentState(harness.manager, start.terminalId),
          (value) => value.verificationUrl !== null,
        );
        assert.equal(state.userCode, null);
        yield* harness.manager.loginCancel({ terminalId: start.terminalId });
      }),
    );
  });

  it.layer(NodeServices.layer)("orders login events and cleans processes", (it) => {
    it.effect("applies the last raw output before a synchronous exit", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const start = yield* harness.manager.loginStart({ instanceId: harness.instanceIds.codex });
        const process = harness.pty.processes[0]!;
        const raw = "\u001b[31mOpen https://example.test/final and enter code LAST-1234\u001b[0m";
        process.emitData(raw);
        process.emitExit(0);
        const state = yield* waitFor(
          currentState(harness.manager, start.terminalId),
          (value) => value.status === "succeeded",
        );
        assert.include(state.output, raw);
        assert.equal(state.verificationUrl, "https://example.test/final");
        assert.equal(state.userCode, "LAST-1234");
      }),
    );

    it.effect("retries a failed PTY kill during later cleanup", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const start = yield* harness.manager.loginStart({ instanceId: harness.instanceIds.kimi });
        harness.pty.processes[0]!.killFailuresRemaining = 1;
        const result = yield* harness.manager.loginCancel({ terminalId: start.terminalId });
        assert.equal(result.state.status, "cancelled");
        yield* waitFor(
          Effect.sync(() => harness.pty.processes[0]!.killSignals.length),
          (count) => count === 2,
        );
      }),
    );

    it.effect("tries every active login kill when the manager scope closes", () =>
      Effect.gen(function* () {
        const pty = yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeHarness();
            yield* harness.manager.loginStart({ instanceId: harness.instanceIds.kimi });
            yield* harness.manager.loginStart({ instanceId: harness.instanceIds.codex });
            harness.pty.processes[0]!.throwOnKill = true;
            return harness.pty;
          }),
        );
        assert.isAbove(pty.processes[0]!.killSignals.length, 0);
        assert.isAbove(pty.processes[1]!.killSignals.length, 0);
      }),
    );

    it.effect("retries a failed interrupted logout kill during manager finalization", () =>
      Effect.gen(function* () {
        const pty = yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeHarness();
            const logout = yield* harness.manager
              .logout({ instanceId: harness.instanceIds.codex })
              .pipe(Effect.forkScoped);
            yield* waitFor(
              Effect.sync(() => harness.pty.processes.length),
              (count) => count === 1,
            );
            harness.pty.processes[0]!.killFailuresRemaining = 1;
            yield* Fiber.interrupt(logout);
            assert.lengthOf(harness.pty.processes[0]!.killSignals, 1);
            return harness.pty;
          }),
        );
        assert.lengthOf(pty.processes[0]!.killSignals, 2);
      }),
    );
  });

  it.layer(NodeServices.layer)("times out an idle login", (it) =>
    it.effect("kills the PTY after ten minutes without output", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const start = yield* harness.manager.loginStart({ instanceId: harness.instanceIds.kimi });
        yield* TestClock.adjust(Duration.minutes(10));
        const failed = yield* waitFor(
          currentState(harness.manager, start.terminalId),
          (state) => state.status === "failed",
        );
        assert.match(failed.message ?? "", /timed out/);
        assert.isAbove(harness.pty.processes[0]!.killSignals.length, 0);
      }),
    ),
  );

  it.layer(NodeServices.layer)("logout cleans only the selected account", (it) => {
    it.effect("removes Codex credentials and refreshes the instance", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const authPath = path.join(harness.homes.codex, "auth.json");
        yield* fileSystem.writeFileString(authPath, "secret");
        const logout = yield* harness.manager
          .logout({ instanceId: harness.instanceIds.codex })
          .pipe(Effect.forkScoped);
        yield* waitFor(
          Effect.sync(() => harness.pty.processes.length),
          (count) => count === 1,
        );
        harness.pty.processes[0]!.emitExit(0);
        yield* Fiber.join(logout);
        const authExists = yield* Effect.result(fileSystem.stat(authPath));
        assert.equal(authExists._tag, "Failure");
        assert.deepEqual(yield* Ref.get(harness.refreshes), [harness.instanceIds.codex]);
      }),
    );

    it.effect("accepts local credential cleanup when the logout command fails", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const authPath = path.join(harness.homes.codex, "auth.json");
        yield* fileSystem.writeFileString(authPath, "secret");
        const logout = yield* harness.manager
          .logout({ instanceId: harness.instanceIds.codex })
          .pipe(Effect.forkScoped);
        yield* waitFor(
          Effect.sync(() => harness.pty.processes.length),
          (count) => count === 1,
        );
        harness.pty.processes[0]!.emitExit(9);
        yield* Fiber.join(logout);
        assert.equal((yield* Effect.result(fileSystem.stat(authPath)))._tag, "Failure");
      }),
    );

    it.effect("preserves unrelated OpenCode providers", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const authDir = path.join(harness.homes.opencode, "opencode");
        const authPath = path.join(authDir, "auth.json");
        yield* fileSystem.makeDirectory(authDir, { recursive: true });
        yield* fileSystem.writeFileString(
          authPath,
          '{"anthropic":{"type":"oauth"},"openai":{"type":"oauth"}}',
        );
        yield* harness.manager.logout({
          instanceId: harness.instanceIds.opencode,
          provider: "anthropic",
        });
        const remaining = yield* fileSystem.readFileString(authPath);
        assert.notInclude(remaining, "anthropic");
        assert.include(remaining, "openai");
        assert.equal((yield* fileSystem.stat(authPath)).mode & 0o777, 0o600);
      }),
    );
  });

  it.layer(NodeServices.layer)("managed account home deletion", (it) => {
    it.effect("deletes a validated account home", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(path.join(harness.homes.kimi, "credentials"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(harness.homes.kimi, "credentials", "kimi-code.json"),
          "secret",
        );
        yield* fileSystem.writeFileString(path.join(harness.homes.kimi, "other"), "value");
        yield* harness.manager.logout({
          instanceId: harness.instanceIds.kimi,
          deleteAccountHome: true,
        });
        assert.equal((yield* Effect.result(fileSystem.stat(harness.homes.kimi)))._tag, "Failure");
      }),
    );

    it.effect("refuses an outside home before credential mutation or PTY spawn", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = path.join(path.dirname(harness.accountsDir), "outside-codex");
        const authPath = path.join(outside, "auth.json");
        yield* fileSystem.makeDirectory(outside, { recursive: true });
        yield* fileSystem.writeFileString(authPath, "secret");
        const current = yield* harness.settings.getSettings;
        const codex = current.providerInstances[harness.instanceIds.codex]!;
        yield* harness.settings.updateSettings({
          providerInstances: {
            ...current.providerInstances,
            [harness.instanceIds.codex]: {
              ...codex,
              config: { binaryPath: "codex-test", homePath: outside },
            },
          },
        });
        const result = yield* Effect.result(
          harness.manager.logout({
            instanceId: harness.instanceIds.codex,
            deleteAccountHome: true,
          }),
        );
        assert.equal(result._tag, "Failure");
        assert.equal(yield* fileSystem.readFileString(authPath), "secret");
        assert.lengthOf(harness.pty.processes, 0);
      }),
    );

    it.effect("refuses another account's managed home without deleting it", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const authPath = path.join(harness.homes.codex, "credentials", "kimi-code.json");
        const markerPath = path.join(harness.homes.codex, "keep-me");
        yield* fileSystem.makeDirectory(path.dirname(authPath), { recursive: true });
        yield* fileSystem.writeFileString(authPath, "secret");
        yield* fileSystem.writeFileString(markerPath, "other account");
        const current = yield* harness.settings.getSettings;
        const kimi = current.providerInstances[harness.instanceIds.kimi]!;
        yield* harness.settings.updateSettings({
          providerInstances: {
            ...current.providerInstances,
            [harness.instanceIds.kimi]: {
              ...kimi,
              config: { binaryPath: "kimi-test", homePath: harness.homes.codex },
            },
          },
        });
        const result = yield* Effect.result(
          harness.manager.logout({
            instanceId: harness.instanceIds.kimi,
            deleteAccountHome: true,
          }),
        );
        assert.equal(result._tag, "Failure");
        assert.equal(yield* fileSystem.readFileString(authPath), "secret");
        assert.equal(yield* fileSystem.readFileString(markerPath), "other account");
        assert.lengthOf(harness.pty.processes, 0);
      }),
    );

    it.effect("refuses escaping, dangling, and shared-home symbolic links", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = path.join(path.dirname(harness.accountsDir), "outside-kimi");
        yield* fileSystem.makeDirectory(outside, { recursive: true });
        const destinations = [
          outside,
          path.join(outside, "missing"),
          path.join(NodeOS.homedir(), ".codex"),
        ] as const;
        yield* fileSystem.remove(harness.homes.kimi, { recursive: true });
        for (const destination of destinations) {
          yield* fileSystem.symlink(destination, harness.homes.kimi);
          const result = yield* Effect.result(
            harness.manager.logout({
              instanceId: harness.instanceIds.kimi,
              deleteAccountHome: true,
            }),
          );
          assert.equal(result._tag, "Failure");
          assert.equal(yield* fileSystem.readLink(harness.homes.kimi), destination);
          yield* fileSystem.remove(harness.homes.kimi);
        }
        assert.lengthOf(harness.pty.processes, 0);
      }),
    );
  });
});
