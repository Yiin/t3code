import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as CodexErrors from "effect-codex-app-server/errors";
import {
  ClaudeSettings,
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { deepMerge } from "@t3tools/shared/Struct";
import { createModelCapabilities } from "@t3tools/shared/model";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

import { checkCodexProviderStatus, type CodexAppServerProviderSnapshot } from "./CodexProvider.ts";
import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
import * as OpenCodeRuntime from "../opencodeRuntime.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderInstanceRegistryHydrationLive } from "./ProviderInstanceRegistryHydration.ts";
import { NoOpProviderInstanceTeardownLive } from "../Services/ProviderInstanceTeardown.ts";
import {
  applyProviderModelCatalog,
  haveProvidersChanged,
  mergeProviderSnapshot,
  mergeProviderSnapshots,
  modelCatalogsFromCachedProviders,
  ProviderRegistryLive,
  selectProvidersByKind,
} from "./ProviderRegistry.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import { ProviderAccountLimitsStore } from "../../persistence/Services/ProviderAccountLimits.ts";
import { ProviderUsageLedgerStore } from "../../persistence/Services/ProviderUsageLedger.ts";
import { readProviderStatusCache, resolveProviderStatusCachePath } from "../providerStatusCache.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
const decodeServerSettings = Schema.decodeSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodeUnknownJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const encodedDefaultServerSettings = encodeServerSettings(DEFAULT_SERVER_SETTINGS);

const defaultClaudeSettings: ClaudeSettings = Schema.decodeSync(ClaudeSettings)({});
const defaultCodexSettings: CodexSettings = Schema.decodeSync(CodexSettings)({});
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const disabledCodexSettings: CodexSettings = Schema.decodeSync(CodexSettings)({
  enabled: false,
});

process.env.T3CODE_CURSOR_ENABLED = "1";

// ── Test helpers ────────────────────────────────────────────────────

const encoder = new TextEncoder();

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const NoOpProviderUsageLedgerStoreLive = Layer.succeed(ProviderUsageLedgerStore, {
  recordSamples: () => Effect.void,
  listForInstance: () => Effect.succeed([]),
  listAll: Effect.succeed([]),
  pruneObservedBefore: () => Effect.void,
});

const NoOpProviderAccountLimitsStoreLive = Layer.succeed(ProviderAccountLimitsStore, {
  recordLimit: () => Effect.void,
  listAll: Effect.succeed([]),
  listForInstance: () => Effect.succeed([]),
  clearForInstance: () => Effect.void,
  clearExpired: () => Effect.void,
});

const TestProviderInstanceRegistryHydrationLive = ProviderInstanceRegistryHydrationLive.pipe(
  Layer.provide(NoOpProviderUsageLedgerStoreLive),
  Layer.provide(NoOpProviderAccountLimitsStoreLive),
);

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  const descriptor = { id, label, type: "select" as const, options: [...options] };
  const defaultOptionId = options.find((option) => option.isDefault)?.id;
  return defaultOptionId ? { ...descriptor, currentValue: defaultOptionId } : descriptor;
}

function booleanDescriptor(id: string, label: string) {
  return {
    id,
    label,
    type: "boolean" as const,
  };
}

type TestClaudeCapabilities = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly usage: ReadonlyArray<never>;
};

function claudeCapabilities(overrides: Partial<TestClaudeCapabilities> = {}) {
  return () =>
    Effect.succeed({
      email: "test@example.com",
      subscriptionType: undefined,
      tokenSource: undefined,
      apiProvider: undefined,
      slashCommands: [],
      skills: [],
      usage: [],
      ...overrides,
    });
}

const noClaudeCapabilities = () => Effect.sync((): TestClaudeCapabilities | undefined => undefined);

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

/** The environment a `StandardCommand` carries, as the spawner contract declares it. */
type CommandEnvironment = ChildProcess.CommandOptions["env"];

function mockSpawnerLayer(
  handler: (
    args: ReadonlyArray<string>,
    environment?: CommandEnvironment,
  ) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) {
        return Effect.die(new Error("mock spawner received a piped command"));
      }
      return Effect.succeed(mockHandle(handler(command.args, command.options.env)));
    }),
  );
}

function recordingMockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  const commands: Array<{
    readonly args: ReadonlyArray<string>;
    readonly env: CommandEnvironment;
  }> = [];
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) {
        return Effect.die(new Error("mock spawner received a piped command"));
      }
      commands.push({ args: command.args, env: command.options.env });
      return Effect.succeed(mockHandle(handler(command.args)));
    }),
  );
  return { layer, commands };
}

function mockCommandSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) {
        return Effect.die(new Error("mock spawner received a piped command"));
      }
      return Effect.succeed(mockHandle(handler(command.command, command.args)));
    }),
  );
}

// Poll an effect with a wall-clock deadline and real sleeps between reads.
// The settings → reconcile → rebuild → reprobe pipeline crosses a real async
// boundary (libuv delivers the ENOENT from the spawned process), so under
// full-suite load a fixed number of `Effect.yieldNow` turns can complete
// before the pipeline does. `TestClock.adjust` moves the test clock only; it
// does not give the event loop real time, so poll on the live clock.
const liveClock = Clock.Clock.defaultValue();

function pollUntil<A>(
  read: Effect.Effect<A>,
  predicate: (value: A) => boolean,
  timeoutMs = 10_000,
): Effect.Effect<A> {
  return Effect.gen(function* () {
    const deadline = liveClock.currentTimeMillisUnsafe() + timeoutMs;
    let value = yield* read;
    while (!predicate(value) && liveClock.currentTimeMillisUnsafe() < deadline) {
      yield* liveClock.sleep(Duration.millis(25));
      value = yield* read;
    }
    return value;
  });
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

function hangingScopedSpawnerLayer(killCalls: Ref.Ref<number>) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Ref.update(killCalls, (current) => current + 1),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.never,
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
        yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
        return handle;
      }),
    ),
  );
}

const codexModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    selectDescriptor("reasoningEffort", "Reasoning", [
      { id: "high", label: "High", isDefault: true },
      { id: "low", label: "Low" },
    ]),
    booleanDescriptor("fastMode", "Fast Mode"),
  ],
}) satisfies NonNullable<ServerProvider["models"][number]["capabilities"]>;

function makeCodexProbeSnapshot(
  input: Partial<CodexAppServerProviderSnapshot> = {},
): CodexAppServerProviderSnapshot {
  return {
    version: "1.0.0",
    account: {
      account: {
        type: "chatgpt",
        email: "test@example.com",
        planType: "pro",
      },
      requiresOpenaiAuth: false,
    },
    models: [
      {
        slug: "gpt-live-codex",
        name: "GPT Live Codex",
        isCustom: false,
        capabilities: codexModelCapabilities,
      },
    ],
    skills: [],
    usage: [],
    limit: null,
    ...input,
  };
}

function makeMutableServerSettingsService(
  initial: ContractServerSettings = DEFAULT_SERVER_SETTINGS,
) {
  return Effect.gen(function* () {
    const settingsRef = yield* Ref.make(initial);
    const changes = yield* PubSub.unbounded<ContractServerSettings>();

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const next = applyServerSettingsPatch(current, patch);
          encodeServerSettings(next);
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
    } satisfies ServerSettingsModule.ServerSettingsService["Service"];
  });
}

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("checkCodexProviderStatus", () => {
      it.effect("uses the app-server account and model list for provider status", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                skills: [
                  {
                    name: "github:gh-fix-ci",
                    path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
                    enabled: true,
                    displayName: "CI Debug",
                    shortDescription: "Debug failing GitHub Actions checks",
                  },
                ],
              }),
            ),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.version, "1.0.0");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "chatgpt");
          assert.strictEqual(status.auth.label, "ChatGPT Pro 20x Subscription");
          assert.strictEqual(status.auth.email, "test@example.com");
          assert.deepStrictEqual(status.models, [
            {
              slug: "gpt-live-codex",
              name: "GPT Live Codex",
              isCustom: false,
              capabilities: codexModelCapabilities,
            },
          ]);
          assert.deepStrictEqual(status.skills, [
            {
              name: "github:gh-fix-ci",
              path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
              enabled: true,
              displayName: "CI Debug",
              shortDescription: "Debug failing GitHub Actions checks",
            },
          ]);
        }),
      );

      it.effect("keeps Codex identities separate across two home paths", () =>
        Effect.gen(function* () {
          const seenHomes: Array<string | undefined> = [];
          const probe = (input: { readonly homePath?: string }) => {
            seenHomes.push(input.homePath);
            const email = input.homePath?.includes("work")
              ? "work@example.com"
              : "personal@example.com";
            return Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: { type: "chatgpt", email, planType: "pro" },
                  requiresOpenaiAuth: false,
                },
              }),
            );
          };
          const [personal, work] = yield* Effect.all([
            checkCodexProviderStatus(
              { ...defaultCodexSettings, homePath: "/accounts/personal" },
              probe,
            ),
            checkCodexProviderStatus(
              { ...defaultCodexSettings, homePath: "/accounts/work" },
              probe,
            ),
          ]);

          assert.deepStrictEqual(seenHomes.toSorted(), ["/accounts/personal", "/accounts/work"]);
          assert.strictEqual(personal.auth.email, "personal@example.com");
          assert.strictEqual(work.auth.email, "work@example.com");
        }),
      );

      it.effect("passes configured launch args to the Codex provider probe", () =>
        Effect.gen(function* () {
          let observedLaunchArgs: string | undefined;
          const settings = decodeCodexSettings({ launchArgs: "--strict-config --enable foo" });

          const status = yield* checkCodexProviderStatus(settings, (input) => {
            observedLaunchArgs = input.launchArgs;
            return Effect.succeed(makeCodexProbeSnapshot());
          });

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(observedLaunchArgs, "--strict-config --enable foo");
        }),
      );

      it.effect("returns unauthenticated when app-server requires OpenAI auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: null,
                  requiresOpenaiAuth: true,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.auth.status, "unauthenticated");
          assert.strictEqual(
            status.message,
            "Codex CLI is not authenticated. Run `codex login` and try again.",
          );
        }),
      );

      it.effect(
        "returns ready with unknown auth when app-server does not require OpenAI auth",
        () =>
          Effect.gen(function* () {
            const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
              Effect.succeed(
                makeCodexProbeSnapshot({
                  account: {
                    account: null,
                    requiresOpenaiAuth: false,
                  },
                }),
              ),
            );

            assert.strictEqual(status.status, "ready");
            assert.strictEqual(status.auth.status, "unknown");
          }),
      );

      it.effect("returns an api key label for codex api key auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: { type: "apiKey" },
                  requiresOpenaiAuth: false,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "apiKey");
          assert.strictEqual(status.auth.label, "OpenAI API Key");
        }),
      );

      it.effect("returns an Amazon Bedrock label for codex Bedrock auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: { type: "amazonBedrock" },
                  requiresOpenaiAuth: false,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "amazonBedrock");
          assert.strictEqual(status.auth.label, "Amazon Bedrock");
        }),
      );

      it.effect("returns unavailable when codex is missing", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.fail(
              new CodexErrors.CodexAppServerSpawnError({
                command: "codex app-server",
                cause: new Error("spawn codex ENOENT"),
              }),
            ),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Codex CLI (`codex`) is not installed or not on PATH.",
          );
        }),
      );

      it.effect("closes the app-server probe scope when provider status times out", () =>
        Effect.gen(function* () {
          const killCalls = yield* Ref.make(0);
          const statusFiber = yield* checkCodexProviderStatus(defaultCodexSettings).pipe(
            Effect.provide(hangingScopedSpawnerLayer(killCalls)),
            Effect.forkChild,
          );

          yield* Effect.yieldNow;
          yield* TestClock.adjust("11 seconds");
          yield* Effect.yieldNow;

          const status = yield* Fiber.join(statusFiber);
          assert.strictEqual(status.status, "error");
          assert.strictEqual(
            status.message,
            "Timed out while checking Codex app-server provider status.",
          );
          assert.strictEqual(yield* Ref.get(killCalls), 1);
        }),
      );
    });

    describe("ProviderRegistryLive", () => {
      it("treats equal provider snapshots as unchanged", () => {
        const providers = [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
          {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: ProviderDriverKind.make("claudeAgent"),
            status: "warning",
            enabled: true,
            installed: true,
            auth: { status: "unknown" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ] as const satisfies ReadonlyArray<ServerProvider>;

        assert.strictEqual(haveProvidersChanged(providers, [...providers]), false);
      });

      it("preserves previously discovered provider models when a refresh returns none", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [
                  selectDescriptor("reasoning", "Reasoning", [
                    { id: "high", label: "High", isDefault: true },
                  ]),
                  booleanDescriptor("fastMode", "Fast Mode"),
                  booleanDescriptor("thinking", "Thinking"),
                ],
              }),
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
      });

      it("drops stale OpenCode models missing from a successful refresh", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("opencode"),
          driver: ProviderDriverKind.make("opencode"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-07-17T00:00:00.000Z",
          version: "1.0.0",
          models: [
            {
              slug: "github/gpt-5",
              name: "GPT-5",
              subProvider: "GitHub",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "removed-plugin/model",
              name: "Removed Plugin Model",
              subProvider: "Removed Plugin",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-07-17T00:01:00.000Z",
          models: [
            {
              slug: "github/gpt-5",
              name: "GPT-5",
              subProvider: "GitHub",
              isCustom: false,
              capabilities: null,
            },
          ],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...refreshedProvider.models,
        ]);
      });

      it("retains stale OpenCode models when a refresh fails", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("opencode"),
          driver: ProviderDriverKind.make("opencode"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-07-17T00:00:00.000Z",
          version: "1.0.0",
          models: [
            {
              slug: "github/gpt-5",
              name: "GPT-5",
              subProvider: "GitHub",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          status: "error",
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:01:00.000Z",
          models: [],
          message: "Failed to refresh OpenCode models.",
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
      });

      it("classifies pending, logout, uninstall, and reconnect OpenCode inventories", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("opencode"),
          driver: ProviderDriverKind.make("opencode"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-07-17T00:00:00.000Z",
          version: "1.0.0",
          models: [
            {
              slug: "github/gpt-5",
              name: "GPT-5",
              subProvider: "GitHub",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "removed-plugin/model",
              name: "Removed Plugin Model",
              subProvider: "Removed Plugin",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const pendingProvider = {
          ...previousProvider,
          status: "warning",
          installed: false,
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:01:00.000Z",
          version: null,
          models: [],
          message: "OpenCode provider status has not been checked in this session yet.",
        } satisfies ServerProvider;
        const loggedOutProvider = {
          ...previousProvider,
          status: "warning",
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:02:00.000Z",
          models: [],
          message: "OpenCode is available, but it did not report any connected upstream providers.",
        } satisfies ServerProvider;
        const missingProvider = {
          ...previousProvider,
          status: "error",
          installed: false,
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:03:00.000Z",
          version: null,
          models: [],
          message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
        } satisfies ServerProvider;
        const authoritativeProvider = {
          ...previousProvider,
          checkedAt: "2026-07-17T00:04:00.000Z",
          models: [previousProvider.models[0]!],
        } satisfies ServerProvider;
        const failedProvider = {
          ...authoritativeProvider,
          status: "error",
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:05:00.000Z",
          models: [],
          message: "Failed to refresh OpenCode models.",
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, pendingProvider).models, [
          ...previousProvider.models,
        ]);
        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, loggedOutProvider).models,
          [],
        );
        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, missingProvider).models, []);

        const afterRemoval = mergeProviderSnapshot(previousProvider, authoritativeProvider);
        const afterFailure = mergeProviderSnapshot(afterRemoval, failedProvider);

        assert.deepStrictEqual(afterFailure.models, [authoritativeProvider.models[0]!]);
      });

      it("fills missing capabilities from the previous provider snapshot", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [
                  selectDescriptor("reasoning", "Reasoning", [
                    { id: "high", label: "High", isDefault: true },
                  ]),
                  booleanDescriptor("fastMode", "Fast Mode"),
                  booleanDescriptor("thinking", "Thinking"),
                ],
              }),
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [],
              }),
            },
          ],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
      });

      it.effect("does not run provider probes during layer construction", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const initialProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
            status: "warning",
            enabled: true,
            installed: false,
            auth: { status: "unknown" },
            checkedAt: "2026-06-10T00:00:00.000Z",
            version: null,
            message: "Checking Codex provider status.",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const refreshCalls = yield* Ref.make(0);
          const instance = {
            instanceId: codexInstanceId,
            driverKind: codexDriver,
            continuationIdentity: {
              driverKind: codexDriver,
              continuationKey: "codex:instance:codex",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: codexDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(initialProvider),
              refresh: Ref.update(refreshCalls, (count) => count + 1).pipe(
                Effect.andThen(Effect.never),
              ),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === codexInstanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-background-refresh-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));
          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            assert.deepStrictEqual(yield* registry.getProviders, [initialProvider]);
            assert.strictEqual(yield* Ref.get(refreshCalls), 0);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("shares discovered model catalogs by harness executable", () =>
        Effect.gen(function* () {
          const claudeDriver = ProviderDriverKind.make("claudeAgent");
          const codexDriver = ProviderDriverKind.make("codex");
          const sharedCatalogKey = "claudeAgent:executable:/opt/claude";
          const otherCatalogKey = "claudeAgent:executable:/usr/bin/claude";
          const accountAId = ProviderInstanceId.make("claude_personal");
          const accountBId = ProviderInstanceId.make("claude_work");
          const otherBinaryId = ProviderInstanceId.make("claude_other_binary");
          const codexId = ProviderInstanceId.make("codex");
          const provider = (
            instanceId: ProviderInstanceId,
            driver: ProviderDriverKind,
            customSlug: string,
          ): ServerProvider => ({
            instanceId,
            driver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-09-02T00:00:00.000Z",
            version: "2.1.258",
            models: [
              {
                slug: "stale-built-in",
                name: "Stale Built-in",
                isCustom: false,
                capabilities: null,
              },
              {
                slug: customSlug,
                name: customSlug,
                isCustom: true,
                capabilities: null,
              },
            ],
            slashCommands: [],
            skills: [],
          });
          const accountABaseProvider = provider(accountAId, claudeDriver, "custom-a");
          const accountAProvider = {
            ...accountABaseProvider,
            models: [
              ...accountABaseProvider.models,
              {
                slug: "claude-opus-5",
                name: "Custom Opus Collision",
                isCustom: true,
                capabilities: null,
              },
            ],
          } satisfies ServerProvider;
          const accountBProvider = provider(accountBId, claudeDriver, "custom-b");
          const otherBinaryProvider = provider(otherBinaryId, claudeDriver, "custom-other-binary");
          const codexProvider = provider(codexId, codexDriver, "custom-codex");

          const makeInstance = (
            snapshot: ServerProvider,
            snapshotRef: Ref.Ref<ServerProvider>,
            modelCatalogKey: string,
            snapshotChanges: PubSub.PubSub<ServerProvider>,
            refresh: Effect.Effect<ServerProvider> = Ref.get(snapshotRef),
          ): ProviderInstance => {
            return {
              instanceId: snapshot.instanceId,
              driverKind: snapshot.driver,
              modelCatalogKey,
              continuationIdentity: {
                driverKind: snapshot.driver,
                continuationKey: `${snapshot.driver}:instance:${snapshot.instanceId}`,
              },
              displayName: undefined,
              enabled: true,
              snapshot: {
                maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                  provider: snapshot.driver,
                  packageName: null,
                }),
                getSnapshot: Ref.get(snapshotRef),
                refresh,
                streamChanges: Stream.fromPubSub(snapshotChanges),
              },
              // SAFETY: This registry test never calls the adapter.
              adapter: {} as ProviderInstance["adapter"],
              // SAFETY: This registry test never calls text generation.
              textGeneration: {} as ProviderInstance["textGeneration"],
            };
          };

          const accountARef = yield* Ref.make<ServerProvider>(accountAProvider);
          const accountBRef = yield* Ref.make<ServerProvider>(accountBProvider);
          const otherBinaryRef = yield* Ref.make<ServerProvider>(otherBinaryProvider);
          const codexRef = yield* Ref.make<ServerProvider>(codexProvider);
          const accountAChanges = yield* PubSub.unbounded<ServerProvider>();
          const accountBChanges = yield* PubSub.unbounded<ServerProvider>();
          const otherBinaryChanges = yield* PubSub.unbounded<ServerProvider>();
          const codexChanges = yield* PubSub.unbounded<ServerProvider>();
          const oldRefreshStarted = yield* Deferred.make<void>();
          const oldRefreshRelease = yield* Deferred.make<ServerProvider>();
          const accountA = makeInstance(
            accountAProvider,
            accountARef,
            sharedCatalogKey,
            accountAChanges,
            Deferred.succeed(oldRefreshStarted, undefined).pipe(
              Effect.andThen(Deferred.await(oldRefreshRelease)),
            ),
          );
          const accountB = makeInstance(
            accountBProvider,
            accountBRef,
            sharedCatalogKey,
            accountBChanges,
          );
          const otherBinary = makeInstance(
            otherBinaryProvider,
            otherBinaryRef,
            otherCatalogKey,
            otherBinaryChanges,
          );
          const codex = makeInstance(
            codexProvider,
            codexRef,
            "codex:executable:/opt/claude",
            codexChanges,
          );
          const instancesRef = yield* Ref.make<ReadonlyArray<ProviderInstance>>([
            accountA,
            accountB,
            otherBinary,
            codex,
          ]);
          const instanceChanges = yield* PubSub.unbounded<void>();
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Ref.get(instancesRef).pipe(
                  Effect.map((instances) =>
                    instances.find((instance) => instance.instanceId === instanceId),
                  ),
                ),
              listInstances: Ref.get(instancesRef),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.fromPubSub(instanceChanges),
              subscribeChanges: PubSub.subscribe(instanceChanges),
            },
          );
          const catalog = [
            {
              slug: "claude-opus-5",
              name: "Claude Opus 5",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
            {
              slug: "claude-fable-5-1",
              name: "Claude Fable 5.1",
              isCustom: false,
              capabilities: null,
            },
          ] as const;

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            yield* registry.recordModelCatalog({ catalogKey: sharedCatalogKey, models: catalog });

            const afterDiscovery = yield* registry.getProviders;
            const modelsFor = (instanceId: ProviderInstanceId) =>
              afterDiscovery.find((entry) => entry.instanceId === instanceId)?.models ?? [];
            assert.deepEqual(
              modelsFor(accountAId).map((model) => model.slug),
              ["claude-opus-5", "claude-fable-5-1", "custom-a"],
            );
            assert.deepEqual(
              modelsFor(accountBId).map((model) => model.slug),
              ["claude-opus-5", "claude-fable-5-1", "custom-b"],
            );
            assert.deepEqual(
              modelsFor(otherBinaryId).map((model) => model.slug),
              ["stale-built-in", "custom-other-binary"],
            );
            assert.deepEqual(
              modelsFor(codexId).map((model) => model.slug),
              ["stale-built-in", "custom-codex"],
            );

            const periodicAccountAProvider = {
              ...accountAProvider,
              checkedAt: "2026-09-02T00:01:00.000Z",
            } satisfies ServerProvider;
            yield* Ref.set(accountARef, periodicAccountAProvider);
            yield* PubSub.publish(accountAChanges, periodicAccountAProvider);
            for (let index = 0; index < 8; index += 1) yield* Effect.yieldNow;
            assert.deepEqual(
              (yield* registry.getProviders)
                .find((entry) => entry.instanceId === accountAId)
                ?.models.map((model) => model.slug),
              ["claude-opus-5", "claude-fable-5-1", "custom-a"],
            );

            const accountCId = ProviderInstanceId.make("claude_new");
            const accountCProvider = provider(accountCId, claudeDriver, "custom-c");
            const accountCRef = yield* Ref.make<ServerProvider>(accountCProvider);
            const accountCChanges = yield* PubSub.unbounded<ServerProvider>();
            const accountC = makeInstance(
              accountCProvider,
              accountCRef,
              sharedCatalogKey,
              accountCChanges,
            );
            yield* Ref.update(instancesRef, (instances) => [...instances, accountC]);
            const accountCUpdate = yield* registry.streamChanges.pipe(
              Stream.filter((providers) =>
                providers.some((entry) => entry.instanceId === accountCId),
              ),
              Stream.runHead,
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            yield* PubSub.publish(instanceChanges, undefined);
            yield* Fiber.join(accountCUpdate);
            assert.deepEqual(
              (yield* registry.getProviders)
                .find((entry) => entry.instanceId === accountCId)
                ?.models.map((model) => model.slug),
              ["claude-opus-5", "claude-fable-5-1", "custom-c"],
            );

            const staleRefresh = yield* registry.refreshInstance(accountAId).pipe(Effect.forkChild);
            yield* Deferred.await(oldRefreshStarted);

            const replacementProvider = provider(accountAId, claudeDriver, "custom-a-new-binary");
            const replacementRef = yield* Ref.make<ServerProvider>(replacementProvider);
            const replacementChanges = yield* PubSub.unbounded<ServerProvider>();
            const replacement = makeInstance(
              replacementProvider,
              replacementRef,
              otherCatalogKey,
              replacementChanges,
            );
            yield* Ref.update(instancesRef, (instances) =>
              instances.map((instance) =>
                instance.instanceId === accountAId ? replacement : instance,
              ),
            );
            const replacementUpdate = yield* registry.streamChanges.pipe(
              Stream.filter((providers) =>
                providers.some(
                  (entry) =>
                    entry.instanceId === accountAId &&
                    entry.models.some((model) => model.slug === "custom-a-new-binary"),
                ),
              ),
              Stream.runHead,
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            yield* PubSub.publish(instanceChanges, undefined);
            yield* Fiber.join(replacementUpdate);
            const replacementModels = (yield* registry.getProviders).find(
              (entry) => entry.instanceId === accountAId,
            )?.models;
            assert.deepEqual(
              replacementModels?.map((model) => model.slug),
              ["stale-built-in", "custom-a-new-binary"],
            );
            yield* Deferred.succeed(oldRefreshRelease, {
              ...accountAProvider,
              checkedAt: "2026-09-02T00:02:00.000Z",
              models: [
                {
                  slug: "late-old-model",
                  name: "Late Old Model",
                  isCustom: false,
                  capabilities: null,
                },
              ],
            });
            yield* Fiber.join(staleRefresh);
            assert.deepEqual(
              (yield* registry.getProviders)
                .find((entry) => entry.instanceId === accountAId)
                ?.models.map((model) => model.slug),
              ["stale-built-in", "custom-a-new-binary"],
            );
          }).pipe(
            Effect.provide(
              ProviderRegistryLive.pipe(
                Layer.provideMerge(instanceRegistryLayer),
                Layer.provideMerge(
                  ServerConfig.layerTest(process.cwd(), {
                    prefix: "t3-provider-registry-model-catalog-",
                  }),
                ),
                Layer.provideMerge(NodeServices.layer),
              ),
            ),
          );
        }),
      );

      it("seeds the newest cached harness catalog for sibling accounts", () => {
        const driver = ProviderDriverKind.make("claudeAgent");
        const catalogKey = "claudeAgent:executable:/opt/claude";
        const accountAId = ProviderInstanceId.make("claude_cached_personal");
        const accountBId = ProviderInstanceId.make("claude_cached_work");
        const bootInstances = [
          { instanceId: accountAId, modelCatalogKey: catalogKey },
          { instanceId: accountBId, modelCatalogKey: catalogKey },
        ] as unknown as ReadonlyArray<ProviderInstance>;
        const provider = (
          instanceId: ProviderInstanceId,
          checkedAt: string,
          builtInSlug: string,
          customSlug: string,
        ): ServerProvider => ({
          instanceId,
          driver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt,
          version: "2.1.258",
          models: [
            { slug: builtInSlug, name: builtInSlug, isCustom: false, capabilities: null },
            { slug: customSlug, name: customSlug, isCustom: true, capabilities: null },
          ],
          slashCommands: [],
          skills: [],
        });
        const olderSiblingCache = provider(
          accountBId,
          "2026-09-01T00:00:00.000Z",
          "older-static",
          "cached-custom-b",
        );
        const discoveredAccountCache = provider(
          accountAId,
          "2026-09-02T00:00:00.000Z",
          "claude-fable-5-1",
          "cached-custom-a",
        );
        const catalogs = modelCatalogsFromCachedProviders(bootInstances, [
          olderSiblingCache,
          discoveredAccountCache,
        ]);
        const currentSibling = provider(
          accountBId,
          "2026-09-03T00:00:00.000Z",
          "stale-built-in",
          "current-custom-b",
        );

        assert.deepEqual(
          catalogs.get(catalogKey)?.map((model) => model.slug),
          ["claude-fable-5-1"],
        );
        assert.deepEqual(
          applyProviderModelCatalog(currentSibling, catalogs.get(catalogKey)!).models.map(
            (model) => model.slug,
          ),
          ["claude-fable-5-1", "current-custom-b"],
        );
      });

      it.effect(
        "commits concurrent model catalogs through persistence and publication in order",
        () =>
          Effect.gen(function* () {
            const driver = ProviderDriverKind.make("claudeAgent");
            const instanceId = ProviderInstanceId.make("claude_ordered_catalog");
            const catalogKey = "claudeAgent:executable:/opt/ordered-claude";
            const initialProvider = {
              instanceId,
              driver,
              status: "ready",
              enabled: true,
              installed: true,
              auth: { status: "authenticated" },
              checkedAt: "2026-09-02T00:00:00.000Z",
              version: "2.1.258",
              models: [
                {
                  slug: "static-model",
                  name: "Static Model",
                  isCustom: false,
                  capabilities: null,
                },
                {
                  slug: "custom-model",
                  name: "Custom Model",
                  isCustom: true,
                  capabilities: null,
                },
              ],
              slashCommands: [],
              skills: [],
            } satisfies ServerProvider;
            const instance = {
              instanceId,
              driverKind: driver,
              modelCatalogKey: catalogKey,
              continuationIdentity: {
                driverKind: driver,
                continuationKey: `${driver}:instance:${instanceId}`,
              },
              displayName: undefined,
              enabled: true,
              snapshot: {
                maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                  provider: driver,
                  packageName: null,
                }),
                getSnapshot: Effect.succeed(initialProvider),
                refresh: Effect.succeed(initialProvider),
                streamChanges: Stream.empty,
              },
              adapter: {} as ProviderInstance["adapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            } satisfies ProviderInstance;
            const instanceRegistryLayer = Layer.succeed(
              ProviderInstanceRegistry.ProviderInstanceRegistry,
              {
                getInstance: (candidateId) =>
                  Effect.succeed(candidateId === instanceId ? instance : undefined),
                listInstances: Effect.succeed([instance]),
                listUnavailable: Effect.succeed([]),
                streamChanges: Stream.empty,
                subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
              },
            );
            const delayedUpdateEntered = yield* Deferred.make<void>();
            const releaseDelayedUpdate = yield* Deferred.make<void>();
            let delayNextRead = false;
            let didDelayRead = false;
            const controlledUsageLayer = Layer.succeed(ProviderUsageLedgerStore, {
              recordSamples: () => Effect.void,
              listForInstance: () =>
                delayNextRead && !didDelayRead
                  ? Effect.sync(() => {
                      didDelayRead = true;
                    }).pipe(
                      Effect.andThen(Deferred.succeed(delayedUpdateEntered, undefined)),
                      Effect.andThen(Deferred.await(releaseDelayedUpdate)),
                      Effect.as([]),
                    )
                  : Effect.succeed([]),
              listAll: Effect.succeed([]),
              pruneObservedBefore: () => Effect.void,
            });
            const catalogA = [
              {
                slug: "catalog-a",
                name: "Catalog A",
                isCustom: false,
                capabilities: null,
              },
            ] as const;
            const catalogB = [
              {
                slug: "catalog-b",
                name: "Catalog B",
                isCustom: false,
                capabilities: null,
              },
            ] as const;

            yield* Effect.gen(function* () {
              const registry = yield* ProviderRegistry.ProviderRegistry;
              const config = yield* ServerConfig.ServerConfig;
              const emissionsFiber = yield* registry.streamChanges.pipe(
                Stream.take(2),
                Stream.runCollect,
                Effect.forkChild,
              );
              yield* Effect.yieldNow;
              delayNextRead = true;
              const catalogAFiber = yield* registry
                .recordModelCatalog({ catalogKey, models: catalogA })
                .pipe(Effect.forkChild);
              yield* Deferred.await(delayedUpdateEntered);
              const catalogBFiber = yield* registry
                .recordModelCatalog({ catalogKey, models: catalogB })
                .pipe(Effect.forkChild);
              yield* Effect.yieldNow;
              yield* Deferred.succeed(releaseDelayedUpdate, undefined);
              yield* Fiber.join(catalogAFiber);
              yield* Fiber.join(catalogBFiber);
              const emissions = Array.from(yield* Fiber.join(emissionsFiber));
              const filePath = yield* resolveProviderStatusCachePath({
                cacheDir: config.providerStatusCacheDir,
                instanceId,
              });
              const persisted = yield* readProviderStatusCache(filePath);
              const slugs = (provider: ServerProvider | undefined) =>
                provider?.models.map((model) => model.slug);

              assert.deepEqual(
                slugs(
                  (yield* registry.getProviders).find(
                    (provider) => provider.instanceId === instanceId,
                  ),
                ),
                ["catalog-b", "custom-model"],
              );
              assert.deepEqual(slugs(persisted), ["catalog-b", "custom-model"]);
              assert.deepEqual(
                slugs(emissions.at(-1)?.find((provider) => provider.instanceId === instanceId)),
                ["catalog-b", "custom-model"],
              );
            }).pipe(
              Effect.provide(
                ProviderRegistryLive.pipe(
                  Layer.provideMerge(instanceRegistryLayer),
                  Layer.provideMerge(controlledUsageLayer),
                  Layer.provideMerge(
                    ServerConfig.layerTest(process.cwd(), {
                      prefix: "t3-provider-registry-ordered-catalog-",
                    }),
                  ),
                  Layer.provideMerge(NodeServices.layer),
                ),
              ),
            );
          }),
      );

      it.effect("joins live usage windows and the current limit onto assembled snapshots", () =>
        Effect.gen(function* () {
          const claudeDriver = ProviderDriverKind.make("claudeAgent");
          const claudeInstanceId = ProviderInstanceId.make("claude_personal");
          const kimiDriver = ProviderDriverKind.make("kimi");
          const kimiInstanceId = ProviderInstanceId.make("kimi");
          const claudeProvider = {
            instanceId: claudeInstanceId,
            driver: claudeDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-10T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const kimiProvider = {
            ...claudeProvider,
            instanceId: kimiInstanceId,
            driver: kimiDriver,
          } satisfies ServerProvider;
          const liveFiveHour = {
            providerInstanceId: claudeInstanceId,
            window: "five_hour",
            utilization: 62,
            resetsAt: "2099-01-01T00:00:00.000Z",
            source: "claude.sdk.get_usage",
            observedAt: "2026-04-10T00:00:00.000Z",
          } as const;
          const liveSevenDay = {
            ...liveFiveHour,
            window: "seven_day",
            utilization: 18,
            resetsAt: "2099-01-02T00:00:00.000Z",
          } as const;
          // The test clock starts at the epoch, so "expired" means before
          // 1970 here.
          const expiredWindow = {
            ...liveFiveHour,
            window: "seven_day_opus",
            utilization: 99,
            resetsAt: "1969-06-01T00:00:00.000Z",
          } as const;
          const usageLedgerLayer = Layer.succeed(ProviderUsageLedgerStore, {
            recordSamples: () => Effect.void,
            listForInstance: (input) =>
              Effect.succeed(
                input.providerInstanceId === claudeInstanceId
                  ? [liveFiveHour, liveSevenDay, expiredWindow]
                  : [],
              ),
            listAll: Effect.succeed([]),
            pruneObservedBefore: () => Effect.void,
          });
          const accountLimitsLayer = Layer.succeed(ProviderAccountLimitsStore, {
            recordLimit: () => Effect.void,
            listAll: Effect.succeed([]),
            listForInstance: () => Effect.succeed([]),
            clearForInstance: () => Effect.void,
            clearExpired: () => Effect.void,
          });
          const makeInstance = (provider: ServerProvider): ProviderInstance => ({
            instanceId: provider.instanceId,
            driverKind: provider.driver,
            continuationIdentity: {
              driverKind: provider.driver,
              continuationKey: `${provider.driver}:instance:${provider.instanceId}`,
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: provider.driver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(provider),
              refresh: Effect.succeed(provider),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          });
          const claudeInstance = makeInstance(claudeProvider);
          const kimiInstance = makeInstance(kimiProvider);
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(
                  [claudeInstance, kimiInstance].find(
                    (instance) => instance.instanceId === instanceId,
                  ),
                ),
              listInstances: Effect.succeed([claudeInstance, kimiInstance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
                PubSub.subscribe(pubsub),
              ),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provide(usageLedgerLayer),
              Layer.provide(accountLimitsLayer),
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-account-state-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const providers = yield* registry.getProviders;
            const claudeSnapshot = providers.find(
              (candidate) => candidate.instanceId === claudeInstanceId,
            );
            const kimiSnapshot = providers.find(
              (candidate) => candidate.instanceId === kimiInstanceId,
            );

            // Both live windows land, the expired one is dropped, and the
            // limits store answering "no rows" reads as an explicit null.
            assert.deepStrictEqual(claudeSnapshot?.usage, [liveFiveHour, liveSevenDay]);
            assert.strictEqual(claudeSnapshot?.limit, null);
            // A driver with no usage reader records no samples, so the field
            // is absent — never an empty array a UI would read as zero usage.
            assert.strictEqual(kimiSnapshot !== undefined && "usage" in kimiSnapshot, false);
            assert.strictEqual(kimiSnapshot?.limit, null);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it("persists merged provider snapshots for the providers that were refreshed", () => {
        const previousProviders = [
          {
            instanceId: ProviderInstanceId.make("cursor"),
            driver: ProviderDriverKind.make("cursor"),
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-14T00:00:00.000Z",
            version: "2026.04.09-f2b0fcd",
            models: [
              {
                slug: "claude-opus-4-6",
                name: "Opus 4.6",
                isCustom: false,
                capabilities: createModelCapabilities({
                  optionDescriptors: [
                    selectDescriptor("reasoning", "Reasoning", [
                      { id: "high", label: "High", isDefault: true },
                    ]),
                    booleanDescriptor("fastMode", "Fast Mode"),
                    booleanDescriptor("thinking", "Thinking"),
                  ],
                }),
              },
            ],
            slashCommands: [],
            skills: [],
          },
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-14T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ] as const satisfies ReadonlyArray<ServerProvider>;
        const refreshedCursor = {
          ...previousProviders[0],
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;

        const mergedProviders = mergeProviderSnapshots(previousProviders, [refreshedCursor]);
        const persistedProviders = selectProvidersByKind(
          mergedProviders,
          new Set([ProviderDriverKind.make("cursor")]),
        );

        assert.deepStrictEqual(persistedProviders, [
          {
            ...refreshedCursor,
            models: [...previousProviders[0].models],
          },
        ]);
      });

      it.effect("persists the merged snapshot when a live update has empty models", () =>
        Effect.gen(function* () {
          const cursorDriver = ProviderDriverKind.make("cursor");
          const cursorInstanceId = ProviderInstanceId.make("cursor");
          const initialProvider = {
            instanceId: cursorInstanceId,
            driver: cursorDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-14T00:00:00.000Z",
            version: "2026.04.09-f2b0fcd",
            models: [
              {
                slug: "claude-opus-4-6",
                name: "Opus 4.6",
                isCustom: false,
                capabilities: createModelCapabilities({
                  optionDescriptors: [
                    selectDescriptor("reasoning", "Reasoning", [
                      { id: "high", label: "High", isDefault: true },
                    ]),
                  ],
                }),
              },
            ],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const refreshedProvider = {
            ...initialProvider,
            checkedAt: "2026-04-14T00:01:00.000Z",
            models: [],
          } satisfies ServerProvider;
          const changes = yield* PubSub.unbounded<ServerProvider>();
          const instance = {
            instanceId: cursorInstanceId,
            driverKind: cursorDriver,
            continuationIdentity: {
              driverKind: cursorDriver,
              continuationKey: "cursor:instance:cursor",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: cursorDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(initialProvider),
              refresh: Effect.succeed(refreshedProvider),
              streamChanges: Stream.fromPubSub(changes),
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === cursorInstanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
                PubSub.subscribe(pubsub),
              ),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-merged-persist-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const config = yield* ServerConfig.ServerConfig;
            const filePath = yield* resolveProviderStatusCachePath({
              cacheDir: config.providerStatusCacheDir,
              instanceId: cursorInstanceId,
            });

            assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, [
              ...initialProvider.models,
            ]);
            yield* PubSub.publish(changes, refreshedProvider);

            let cachedProvider = yield* readProviderStatusCache(filePath);
            for (
              let attempt = 0;
              attempt < 50 && cachedProvider?.checkedAt !== refreshedProvider.checkedAt;
              attempt += 1
            ) {
              yield* TestClock.adjust("10 millis");
              yield* Effect.yieldNow;
              cachedProvider = yield* readProviderStatusCache(filePath);
            }

            assert.deepStrictEqual(cachedProvider, {
              ...refreshedProvider,
              models: [...initialProvider.models],
            });
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect(
        "persists authoritative OpenCode removals without resurrecting them on a failed live refresh",
        () =>
          Effect.gen(function* () {
            const openCodeDriver = ProviderDriverKind.make("opencode");
            const openCodeInstanceId = ProviderInstanceId.make("opencode");
            const initialProvider = {
              instanceId: openCodeInstanceId,
              driver: openCodeDriver,
              status: "ready",
              enabled: true,
              installed: true,
              auth: { status: "authenticated" },
              checkedAt: "2026-07-17T00:00:00.000Z",
              version: "1.0.0",
              models: [
                {
                  slug: "github/gpt-5",
                  name: "GPT-5",
                  subProvider: "GitHub",
                  isCustom: false,
                  capabilities: null,
                },
                {
                  slug: "removed-plugin/model",
                  name: "Removed Plugin Model",
                  subProvider: "Removed Plugin",
                  isCustom: false,
                  capabilities: null,
                },
              ],
              slashCommands: [],
              skills: [],
            } as const satisfies ServerProvider;
            const authoritativeProvider = {
              ...initialProvider,
              checkedAt: "2026-07-17T00:01:00.000Z",
              models: [initialProvider.models[0]!],
            } satisfies ServerProvider;
            const failedProvider = {
              ...authoritativeProvider,
              status: "error",
              auth: { status: "unknown" },
              checkedAt: "2026-07-17T00:02:00.000Z",
              models: [],
              message: "Failed to refresh OpenCode models.",
            } satisfies ServerProvider;
            const changes = yield* PubSub.unbounded<ServerProvider>();
            const instance = {
              instanceId: openCodeInstanceId,
              driverKind: openCodeDriver,
              continuationIdentity: {
                driverKind: openCodeDriver,
                continuationKey: "opencode:instance:opencode",
              },
              displayName: undefined,
              enabled: true,
              snapshot: {
                maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                  provider: openCodeDriver,
                  packageName: null,
                }),
                getSnapshot: Effect.succeed(initialProvider),
                refresh: Effect.succeed(authoritativeProvider),
                streamChanges: Stream.fromPubSub(changes),
              },
              adapter: {} as ProviderInstance["adapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            } satisfies ProviderInstance;
            const instanceRegistryLayer = Layer.succeed(
              ProviderInstanceRegistry.ProviderInstanceRegistry,
              {
                getInstance: (instanceId) =>
                  Effect.succeed(instanceId === openCodeInstanceId ? instance : undefined),
                listInstances: Effect.succeed([instance]),
                listUnavailable: Effect.succeed([]),
                streamChanges: Stream.empty,
                subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
                  PubSub.subscribe(pubsub),
                ),
              },
            );
            const scope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
            const runtimeServices = yield* Layer.build(
              ProviderRegistryLive.pipe(
                Layer.provideMerge(instanceRegistryLayer),
                Layer.provideMerge(
                  ServerConfig.layerTest(process.cwd(), {
                    prefix: "t3-provider-registry-opencode-authoritative-persist-",
                  }),
                ),
                Layer.provideMerge(NodeServices.layer),
              ),
            ).pipe(Scope.provide(scope));

            yield* Effect.gen(function* () {
              const registry = yield* ProviderRegistry.ProviderRegistry;
              const config = yield* ServerConfig.ServerConfig;
              const filePath = yield* resolveProviderStatusCachePath({
                cacheDir: config.providerStatusCacheDir,
                instanceId: openCodeInstanceId,
              });

              yield* PubSub.publish(changes, authoritativeProvider);

              let cachedProvider = yield* readProviderStatusCache(filePath);
              for (
                let attempt = 0;
                attempt < 50 && cachedProvider?.checkedAt !== authoritativeProvider.checkedAt;
                attempt += 1
              ) {
                yield* TestClock.adjust("10 millis");
                yield* Effect.yieldNow;
                cachedProvider = yield* readProviderStatusCache(filePath);
              }

              assert.deepStrictEqual(cachedProvider?.models, [authoritativeProvider.models[0]!]);

              yield* PubSub.publish(changes, failedProvider);
              for (
                let attempt = 0;
                attempt < 50 && cachedProvider?.checkedAt !== failedProvider.checkedAt;
                attempt += 1
              ) {
                yield* TestClock.adjust("10 millis");
                yield* Effect.yieldNow;
                cachedProvider = yield* readProviderStatusCache(filePath);
              }

              assert.deepStrictEqual(cachedProvider?.models, [authoritativeProvider.models[0]!]);
              assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, [
                authoritativeProvider.models[0]!,
              ]);
            }).pipe(Effect.provide(runtimeServices));
          }),
      );

      it.effect("returns the cached provider list when a manual refresh fails", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const cachedProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const instance = {
            instanceId: codexInstanceId,
            driverKind: codexDriver,
            continuationIdentity: {
              driverKind: codexDriver,
              continuationKey: "codex:instance:codex",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: codexDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(cachedProvider),
              refresh: Effect.die(new Error("simulated refresh failure")),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === codexInstanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
                PubSub.subscribe(pubsub),
              ),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-refresh-failure-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;

            assert.deepStrictEqual(yield* registry.getProviders, [cachedProvider]);
            assert.deepStrictEqual(yield* registry.refresh(codexDriver), [cachedProvider]);
            assert.deepStrictEqual(yield* registry.refreshInstance(codexInstanceId), [
              cachedProvider,
            ]);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("keeps consuming registry changes after one sync fails", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const claudeDriver = ProviderDriverKind.make("claudeAgent");
          const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
          const codexProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const claudeProvider = {
            instanceId: claudeInstanceId,
            driver: claudeDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:01:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const makeInstance = (provider: ServerProvider): ProviderInstance => ({
            instanceId: provider.instanceId,
            driverKind: provider.driver,
            continuationIdentity: {
              driverKind: provider.driver,
              continuationKey: `${provider.driver}:instance:${provider.instanceId}`,
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: provider.driver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(provider),
              refresh: Effect.succeed(provider),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          });
          const codexInstance = makeInstance(codexProvider);
          const claudeInstance = makeInstance(claudeProvider);
          const changes = yield* PubSub.unbounded<void>();
          const instancesRef = yield* Ref.make<ReadonlyArray<ProviderInstance>>([codexInstance]);
          const failNextList = yield* Ref.make(false);
          const wait = () => Effect.yieldNow;
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Ref.get(instancesRef).pipe(
                  Effect.map((instances) =>
                    instances.find((instance) => instance.instanceId === instanceId),
                  ),
                ),
              listInstances: Effect.gen(function* () {
                const shouldFail = yield* Ref.get(failNextList);
                if (shouldFail) {
                  yield* Ref.set(failNextList, false);
                  return yield* Effect.die(new Error("simulated registry list failure"));
                }
                return yield* Ref.get(instancesRef);
              }),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.fromPubSub(changes),
              subscribeChanges: PubSub.subscribe(changes),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-sync-failure-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            assert.deepStrictEqual(yield* registry.getProviders, [codexProvider]);

            yield* Ref.set(failNextList, true);
            yield* PubSub.publish(changes, undefined);

            yield* Ref.set(instancesRef, [codexInstance, claudeInstance]);
            yield* PubSub.publish(changes, undefined);

            let providers = yield* registry.getProviders;
            for (
              let attempt = 0;
              attempt < 50 &&
              !providers.some((provider) => provider.instanceId === claudeInstanceId);
              attempt += 1
            ) {
              yield* wait();
              providers = yield* registry.getProviders;
            }

            assert.deepStrictEqual(
              providers.map((provider) => provider.instanceId).toSorted(),
              [codexInstanceId, claudeInstanceId].toSorted(),
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      // This test intentionally avoids `mockCommandSpawnerLayer` so the real
      // `probeCodexAppServerProvider` path runs — including the full
      // `codex app-server` RPC handshake via `CodexClient.layerChildProcess`.
      // We point `binaryPath` at a name that cannot exist on any machine so
      // the real `ChildProcessSpawner` deterministically returns ENOENT; the
      // probe wraps that as `CodexAppServerSpawnError` and
      // `checkCodexProviderStatus` turns it into the user-visible "not
      // installed" error snapshot. If the aggregator's `syncLiveSources`
      // breaks — the `codex_personal`-never-probes bug we are guarding
      // against — that snapshot never lands in `getProviders` and the
      // assertions below fail.
      it.effect("propagates real Codex probe failures to the aggregator at boot", () =>
        Effect.gen(function* () {
          const missingBinary = `t3code_codex_missing_`;
          const serverSettings = yield* makeMutableServerSettingsService(
            decodeServerSettings(
              deepMerge(encodedDefaultServerSettings, {
                providers: {
                  // Disable every built-in probe that would otherwise spawn
                  // on the CI host. `enabled: false` short-circuits each
                  // driver's probe *before* it touches the spawner, so the
                  // test environment stays isolated from the dev
                  // machine's PATH.
                  codex: { enabled: false },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  grok: { enabled: false },
                  kimi: { enabled: false },
                  opencode: { enabled: false },
                },
                // `providerInstances` keys are branded `ProviderInstanceId`;
                // the branded index signature rejects plain string literals
                // at the TS level even though the runtime schema happily
                // accepts + decodes them. Cast the patch to `unknown` so
                // the `Schema.decodeSync` below does the real validation.
                providerInstances: {
                  // Matches the shape the user had in `.t3/dev/settings.json`
                  // when the bug was reported: a custom enabled Codex instance
                  // pointing at a binary the server has to actually spawn.
                  codex_personal: {
                    driver: "codex",
                    displayName: "Codex Personal",
                    enabled: true,
                    config: {
                      binaryPath: missingBinary,
                      homePath: `/tmp/${missingBinary}_home`,
                    },
                  },
                } as unknown as ContractServerSettings["providerInstances"],
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(TestProviderInstanceRegistryHydrationLive),
            Layer.provideMerge(NoOpProviderInstanceTeardownLive),
            Layer.provideMerge(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-",
              }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
            Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
            // NO spawner mock — `ChildProcessSpawner` is supplied by the
            // outer `NodeServices.layer` on `it.layer(...)` and will
            // genuinely spawn a subprocess. The missing-binary ENOENT is
            // what exercises the same failure mode as a misconfigured
            // production `binaryPath`.
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            let providers = yield* registry.getProviders;
            for (
              let attempts = 0;
              attempts < 50 &&
              providers.find((provider) => provider.instanceId === "codex_personal")?.status !==
                "error";
              attempts += 1
            ) {
              yield* Effect.yieldNow;
              providers = yield* registry.getProviders;
            }
            const codexPersonal = providers.find(
              (provider) => provider.instanceId === "codex_personal",
            );
            assert.notStrictEqual(
              codexPersonal,
              undefined,
              `Expected the aggregator to know about codex_personal; instead saw: ${providers
                .map((provider) => provider.instanceId)
                .join(", ")}`,
            );
            assert.strictEqual(
              codexPersonal?.status,
              "error",
              "Real Codex probe against a missing binary should surface as 'error' in the aggregator",
            );
            assert.strictEqual(codexPersonal?.installed, false);
            assert.strictEqual(
              codexPersonal?.message,
              "Codex CLI (`codex`) is not installed or not on PATH.",
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      // Guards the second half of the reported bug: changing
      // `providers.codex.binaryPath` in settings must tear down the live
      // instance and rebuild it so a fresh probe runs with the new binary.
      // This test drives the real settings stream → registry reconcile →
      // aggregator sync pipeline and asserts that `getProviders` reflects
      // the new background probe's outcome.
      //
      it.effect("re-probes when settings change the codex binaryPath", () =>
        Effect.gen(function* () {
          const firstMissing = `t3code_codex_first_`;
          const secondMissing = `t3code_codex_second_`;
          const spawnedCommands: Array<string> = [];
          const serverSettings = yield* makeMutableServerSettingsService(
            decodeServerSettings(
              deepMerge(encodedDefaultServerSettings, {
                providers: {
                  codex: { enabled: true, binaryPath: firstMissing },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  grok: { enabled: false },
                  kimi: { enabled: false },
                  opencode: { enabled: false },
                },
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(TestProviderInstanceRegistryHydrationLive),
            Layer.provideMerge(NoOpProviderInstanceTeardownLive),
            Layer.provideMerge(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-",
              }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
            Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
            Layer.updateService(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
              ChildProcessSpawner.make((command) => {
                spawnedCommands.push((command as { readonly command: string }).command);
                return spawner.spawn(command);
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            // Boot-time probe: the default codex instance is enabled with
            // `firstMissing`, so the real spawner yields ENOENT and the
            // snapshot should be `status: "error"`.
            const initialProviders = yield* pollUntil(
              registry.getProviders,
              (providers) =>
                providers.find((provider) => provider.instanceId === "codex")?.status === "error",
            );
            const initialCodex = initialProviders.find(
              (provider) => provider.instanceId === "codex",
            );
            assert.strictEqual(initialCodex?.status, "error");
            assert.strictEqual(initialCodex?.installed, false);
            assert.deepStrictEqual(
              spawnedCommands.filter((command) => command !== "prime-agent"),
              [firstMissing],
            );

            // Drive a settings change. The Hydration layer's
            // `SettingsWatcherLive` consumes this via `streamChanges`,
            // calls `reconcile`, which rebuilds the codex instance (the
            // envelope changed because `binaryPath` differs → `entryEqual`
            // is false). The registry's `Stream.runForEach(
            // instanceRegistry.streamChanges, () => syncLiveSources)`
            // fires `syncLiveSources`, which subscribes and launches a fresh
            // background refresh on the rebuilt instance.
            yield* serverSettings.updateSettings({
              providers: {
                codex: { enabled: true, binaryPath: secondMissing },
              },
            });

            // Poll until the injected process boundary observes the new
            // executable. This verifies the public settings-to-probe behavior
            // on wall-clock time, so full-suite load cannot outrun the fixed
            // iteration budget.
            const refreshed = yield* pollUntil(registry.getProviders, (providers) => {
              const codex = providers.find((provider) => provider.instanceId === "codex");
              return (
                codex !== undefined &&
                codex.status === "error" &&
                spawnedCommands.includes(secondMissing)
              );
            });

            const reprobedCodex = refreshed.find((provider) => provider.instanceId === "codex");
            assert.deepStrictEqual(
              spawnedCommands.filter((command) => command !== "prime-agent"),
              [firstMissing, secondMissing],
            );
            assert.strictEqual(reprobedCodex?.status, "error");
            assert.strictEqual(reprobedCodex?.installed, false);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("includes unavailable instance snapshots in getProviders", () =>
        Effect.gen(function* () {
          const serverSettings = yield* makeMutableServerSettingsService(
            decodeServerSettings(
              deepMerge(encodedDefaultServerSettings, {
                providers: {
                  codex: { enabled: false },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  grok: { enabled: false },
                  kimi: { enabled: false },
                  opencode: { enabled: false },
                },
                providerInstances: {
                  ghost_main: {
                    driver: "ghostDriver",
                    displayName: "A fork-only driver we don't ship",
                    enabled: false,
                    config: { arbitrary: "payload" },
                  },
                } as unknown as ContractServerSettings["providerInstances"],
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(TestProviderInstanceRegistryHydrationLive),
            Layer.provideMerge(NoOpProviderInstanceTeardownLive),
            Layer.provideMerge(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-",
              }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
            Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
            Layer.provideMerge(NodeServices.layer),
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const providers = yield* registry.getProviders;
            const ghost = providers.find((provider) => provider.instanceId === "ghost_main");

            assert.notStrictEqual(ghost, undefined);
            assert.strictEqual(ghost?.driver, "ghostDriver");
            assert.strictEqual(ghost?.availability, "unavailable");
            assert.match(ghost?.unavailableReason ?? "", /ghostDriver/);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect(
        "keeps cursor disabled and skips probing when the provider setting is disabled",
        () =>
          Effect.gen(function* () {
            const serverSettings = yield* makeMutableServerSettingsService(
              decodeServerSettings(
                deepMerge(encodedDefaultServerSettings, {
                  providers: {
                    codex: {
                      enabled: false,
                    },
                    cursor: {
                      enabled: false,
                    },
                    grok: {
                      enabled: false,
                    },
                    primeAgent: {
                      enabled: false,
                    },
                  },
                }),
              ),
            );
            const scope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
            const providerRegistryLayer = ProviderRegistryLive.pipe(
              Layer.provideMerge(TestProviderInstanceRegistryHydrationLive),
              Layer.provideMerge(NoOpProviderInstanceTeardownLive),
              Layer.provideMerge(
                Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
              ),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-",
                }),
              ),
              Layer.provideMerge(TestHttpClientLive),
              Layer.provideMerge(
                Layer.succeed(
                  ProviderEventLoggers.ProviderEventLoggers,
                  ProviderEventLoggers.NoOpProviderEventLoggers,
                ),
              ),
              Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
              Layer.provideMerge(
                mockCommandSpawnerLayer((command, args) => {
                  const joined = args.join(" ");
                  if (joined === "--version") {
                    return {
                      stdout: `${command} 1.0.0\n`,
                      stderr: "",
                      code: 0,
                    };
                  }
                  if (joined === "auth status") {
                    return {
                      stdout: '{"authenticated":true}\n',
                      stderr: "",
                      code: 0,
                    };
                  }
                  throw new Error(`Unexpected args: ${command} ${joined}`);
                }),
              ),
            );
            const runtimeServices = yield* Layer.build(
              Layer.mergeAll(
                Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
                providerRegistryLayer,
              ),
            ).pipe(Scope.provide(scope));

            yield* Effect.gen(function* () {
              const registry = yield* ProviderRegistry.ProviderRegistry;
              const providers = yield* registry.getProviders;
              const cursorProvider = providers.find(
                (provider) => provider.instanceId === ProviderInstanceId.make("cursor"),
              );
              const primeProvider = providers.find(
                (provider) => provider.instanceId === ProviderInstanceId.make("primeAgent"),
              );

              assert.deepStrictEqual(providers.map((provider) => provider.instanceId).toSorted(), [
                "claudeAgent",
                "codex",
                "cursor",
                "grok",
                "kimi",
                "opencode",
                "primeAgent",
              ]);
              assert.strictEqual(cursorProvider?.enabled, false);
              assert.strictEqual(cursorProvider?.status, "disabled");
              assert.strictEqual(
                cursorProvider?.message,
                "Cursor is disabled in T3 Code settings.",
              );
              assert.strictEqual(primeProvider?.enabled, false);
              assert.strictEqual(primeProvider?.status, "disabled");
              assert.strictEqual(
                primeProvider?.message,
                "Prime Agent is disabled in T3 Code settings.",
              );
            }).pipe(Effect.provide(runtimeServices));
          }),
      );

      it.effect("skips codex probes entirely when the provider is disabled", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(disabledCodexSettings).pipe(
            Effect.provide(failingSpawnerLayer("spawn codex ENOENT")),
          );
          assert.strictEqual(status.enabled, false);
          assert.strictEqual(status.status, "disabled");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.message, "Codex is disabled in T3 Code settings.");
        }),
      );
    });

    // ── checkClaudeProviderStatus tests ──────────────────────────

    describe("checkClaudeProviderStatus", () => {
      it.effect("returns ready when claude is installed and authenticated", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "authenticated");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns ready and labels Bedrock-backed Claude as authenticated", () =>
        Effect.gen(function* () {
          // Bedrock authenticates via external AWS credentials, so the SDK init
          // reports only `apiProvider` with no subscription or token.
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ apiProvider: "bedrock" }),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "bedrock");
          assert.strictEqual(status.auth.label, "Amazon Bedrock");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("does not treat a firstParty apiProvider alone as an account", () =>
        Effect.gen(function* () {
          // The CLI reports apiProvider "firstParty" even when nobody is
          // logged in, so this probe must fall through to `auth status`,
          // which reports the truth (t3code-mjd).
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              email: undefined,
              tokenSource: "none",
              apiProvider: "firstParty",
            }),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.auth.status, "unauthenticated");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status --json")
                return {
                  stdout: '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("labels every external Claude API provider", () =>
        Effect.gen(function* () {
          const cases = [
            ["vertex", "Google Vertex AI"],
            ["foundry", "Azure AI Foundry"],
            ["anthropicAws", "Anthropic on AWS"],
            ["mantle", "Mantle"],
            ["gateway", "Anthropic Gateway"],
          ] as const;
          for (const [apiProvider, label] of cases) {
            const status = yield* checkClaudeProviderStatus(
              defaultClaudeSettings,
              claudeCapabilities({ email: undefined, apiProvider }),
            );
            assert.strictEqual(status.auth.type, apiProvider);
            assert.strictEqual(status.auth.label, label);
          }
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("includes Claude Fable 5 on supported Claude Code versions", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          const fable5 = status.models.find((model) => model.slug === "claude-fable-5");
          assert.strictEqual(fable5?.name, "Claude Fable 5");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.169\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("gates Claude Fable 5.1 at Claude Code 2.1.258", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(
            status.models.find((model) => model.slug === "claude-fable-5-1")?.name,
            "Claude Fable 5.1",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.258\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("hides Claude Fable 5.1 before Claude Code 2.1.258", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(
            status.models.some((model) => model.slug === "claude-fable-5-1"),
            false,
          );
          assert.strictEqual(
            status.message,
            "Claude Code v2.1.257 is too old for Claude Fable 5.1. Upgrade to v2.1.258 or newer to access it.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.257\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("hides Claude Fable 5 on older Claude Code versions", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(
            status.models.some((model) => model.slug === "claude-fable-5"),
            false,
          );
          assert.strictEqual(
            status.message,
            "Claude Code v2.1.168 is too old for Claude Fable 5. Upgrade to v2.1.169 or newer to access it.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.168\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect(
        "includes Claude Opus 4.7 with xhigh as the default effort on supported versions",
        () =>
          Effect.gen(function* () {
            const status = yield* checkClaudeProviderStatus(
              defaultClaudeSettings,
              claudeCapabilities(),
            );
            const opus47 = status.models.find((model) => model.slug === "claude-opus-4-7");
            if (!opus47) {
              assert.fail("Expected Claude Opus 4.7 to be present for Claude Code v2.1.111.");
            }
            if (!opus47.capabilities) {
              assert.fail(
                "Expected Claude Opus 4.7 capabilities to be present for Claude Code v2.1.111.",
              );
            }
            const effortDescriptor = opus47.capabilities.optionDescriptors?.find(
              (descriptor) => descriptor.type === "select" && descriptor.id === "effort",
            );
            assert.deepStrictEqual(
              effortDescriptor?.type === "select"
                ? effortDescriptor.options.find((option) => option.isDefault)
                : undefined,
              { id: "xhigh", label: "Extra High", isDefault: true },
            );
          }).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") return { stdout: "2.1.111\n", stderr: "", code: 0 };
                if (joined === "auth status")
                  return {
                    stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                    stderr: "",
                    code: 0,
                  };
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          ),
      );

      it.effect("hides Claude Opus 4.7 on older Claude Code versions", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(
            status.models.some((model) => model.slug === "claude-opus-4-7"),
            false,
          );
          assert.strictEqual(
            status.message,
            "Claude Code v2.1.110 is too old for Claude Opus 4.7. Upgrade to v2.1.111 or newer to access it.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.110\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns a display label for claude subscription types", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ subscriptionType: "maxplan" }),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "maxplan");
          assert.strictEqual(status.auth.label, "Claude Max Subscription");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("does not duplicate Claude in full subscription labels", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "Claude Max Subscription",
            }),
          );
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "Claude Max Subscription");
          assert.strictEqual(status.auth.label, "Claude Max Subscription");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("does not duplicate Claude in provider-prefixed subscription names", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "Claude Max",
            }),
          );
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "Claude Max");
          assert.strictEqual(status.auth.label, "Claude Max Subscription");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns claude auth email from initialization result", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ email: "claude@example.com" }),
          );
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.email, "claude@example.com");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout:
                    '{"loggedIn":true,"authMethod":"claude.ai","account":{"email":"claude@example.com"}}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("runs Claude status probes with the configured CLAUDE_CONFIG_DIR", () => {
        const claudeConfigDir = "/tmp/t3code-claude-home";
        const recorded = recordingMockSpawnerLayer((args) => {
          const joined = args.join(" ");
          if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
          if (joined === "auth status")
            return {
              stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
              stderr: "",
              code: 0,
            };
          throw new Error(`Unexpected args: ${joined}`);
        });

        return Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            {
              ...defaultClaudeSettings,
              homePath: claudeConfigDir,
            },
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "ready");
          assert.deepStrictEqual(
            recorded.commands.map((command) => command.env?.CLAUDE_CONFIG_DIR),
            [claudeConfigDir],
          );
        }).pipe(Effect.provide(recorded.layer));
      });

      it.effect("includes probed claude slash commands in the provider snapshot", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "maxplan",
              slashCommands: [
                {
                  name: "review",
                  description: "Review a pull request",
                  input: { hint: "pr-or-branch" },
                },
              ],
            }),
          );

          assert.deepStrictEqual(status.slashCommands, [
            {
              name: "review",
              description: "Review a pull request",
              input: { hint: "pr-or-branch" },
            },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("deduplicates probed claude slash commands by name", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "maxplan",
              slashCommands: [
                {
                  name: "ui",
                  description: "Explore and refine UI",
                },
                {
                  name: "ui",
                  input: { hint: "component-or-screen" },
                },
              ],
            }),
          );

          assert.deepStrictEqual(status.slashCommands, [
            {
              name: "ui",
              description: "Explore and refine UI",
              input: { hint: "component-or-screen" },
            },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns an api key label for claude api key auth", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ tokenSource: "ANTHROPIC_AUTH_TOKEN" }),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "apiKey");
          assert.strictEqual(status.auth.label, "Claude API Key");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"api-key"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns unavailable when claude is missing", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Claude Agent CLI (`claude`) is not installed or not on PATH.",
          );
        }).pipe(Effect.provide(failingSpawnerLayer("spawn claude ENOENT"))),
      );

      it.effect("returns error when version check fails with non-zero exit code", () => {
        const secretStderr = "Something went wrong: secret-token-value";
        return Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.message, "Claude Agent CLI is installed but failed to run.");
          assert.ok(!(status.message ?? "").includes(secretStderr));
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version")
                return {
                  stdout: "",
                  stderr: secretStderr,
                  code: 1,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        );
      });

      it.effect("uses the CLI fallback when the Claude initialization result is unavailable", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            noClaudeCapabilities,
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unauthenticated");
          assert.strictEqual(
            status.message,
            "Claude is not authenticated. Run `claude auth login` and try again.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status --json")
                return {
                  stdout: '{"loggedIn":false}\n',
                  stderr: "",
                  code: 1,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("uses the CLI fallback when SDK account metadata is empty", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              email: undefined,
              slashCommands: [{ name: "review", description: "Review changes" }],
              skills: [{ name: "pdf", enabled: true, description: "Work with PDFs" }],
            }),
          );
          assert.deepStrictEqual(status.auth, {
            status: "authenticated",
            type: "claude.ai",
            label: "Claude OAuth",
            email: "fallback@example.com",
          });
          assert.deepStrictEqual(status.slashCommands, [
            { name: "review", description: "Review changes" },
          ]);
          assert.deepStrictEqual(status.skills, [
            { name: "pdf", enabled: true, description: "Work with PDFs" },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status --json")
                return {
                  stdout: encodeUnknownJson({
                    loggedIn: true,
                    authMethod: "claude.ai",
                    email: "fallback@example.com",
                  }),
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("prefers external Claude provider identity in the CLI fallback", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            noClaudeCapabilities,
          );
          assert.deepStrictEqual(status.auth, {
            status: "authenticated",
            type: "bedrock",
            label: "Amazon Bedrock",
          });
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status --json")
                return {
                  stdout: encodeUnknownJson({
                    loggedIn: true,
                    authMethod: "external",
                    apiProvider: "bedrock",
                  }),
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("projects safe Claude identity fields from the CLI fallback", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            noClaudeCapabilities,
          );
          assert.deepStrictEqual(status.auth, {
            status: "authenticated",
            type: "pro",
            label: "Claude Pro Subscription",
            email: "claude@example.com",
          });
          assert.ok(!encodeUnknownJson(status).includes("secret-token"));
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status --json")
                return {
                  stdout: encodeUnknownJson({
                    loggedIn: true,
                    authMethod: "claude.ai",
                    apiProvider: "firstParty",
                    email: "claude@example.com",
                    orgId: "org-safe-id",
                    orgName: "Example Org",
                    subscriptionType: "pro",
                    accessToken: "secret-token",
                  }),
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("keeps Claude CLI fallback identities separate across two homes", () =>
        Effect.gen(function* () {
          const [personal, work] = yield* Effect.all([
            checkClaudeProviderStatus(
              { ...defaultClaudeSettings, homePath: "/accounts/claude-personal" },
              noClaudeCapabilities,
            ),
            checkClaudeProviderStatus(
              { ...defaultClaudeSettings, homePath: "/accounts/claude-work" },
              noClaudeCapabilities,
            ),
          ]);

          assert.strictEqual(personal.auth.email, "personal@example.com");
          assert.strictEqual(work.auth.email, "work@example.com");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args, environment) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status --json") {
                const isWork = environment?.CLAUDE_CONFIG_DIR?.includes("work") ?? false;
                return {
                  stdout: encodeUnknownJson({
                    loggedIn: true,
                    authMethod: "claude.ai",
                    email: isWork ? "work@example.com" : "personal@example.com",
                    subscriptionType: "pro",
                  }),
                  stderr: "",
                  code: 0,
                };
              }
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("handles truncated Claude auth JSON without exposing it", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            noClaudeCapabilities,
          );
          assert.strictEqual(status.status, "warning");
          assert.deepStrictEqual(status.auth, { status: "unknown" });
          assert.strictEqual(status.message, "Could not verify Claude authentication status.");
          assert.ok(!encodeUnknownJson(status).includes("secret-token"));
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status --json")
                return { stdout: '{"loggedIn":true,"token":"secret-token"', stderr: "", code: 1 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );
    });
  },
);
