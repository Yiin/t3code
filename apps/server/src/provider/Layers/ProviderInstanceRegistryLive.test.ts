/**
 * Multi-instance validation slices for `ProviderInstanceRegistryLive`.
 *
 * Two axes of the driver/registry refactor are exercised here:
 *
 *  1. **Same driver, many instances** — the "multi-instance codex slice"
 *     describe block below configures two independent `codex` instances and
 *     asserts each gets its own closures and identity. This is the
 *     multi-codex capability the refactor exists to unlock.
 *
 *  1b. **Teardown ordering** — the "reconcile teardown slice" describe block
 *     pins that `reconcile` stops the sessions on a removed or replaced
 *     instance *before* it closes that instance's scope. The order is the
 *     whole point: a scope close writes no binding, and once the instance is
 *     gone `ProviderService.stopSession` can no longer resolve its adapter,
 *     so a stop that runs after the close writes nothing at all (t3code-iad).
 *
 *  2. **Many drivers, one registry** — the "all drivers slice" describe
 *     block below configures one instance of every shipped driver
 *     (`codex`, `claudeAgent`, `cursor`, `grok`, `kimi`, `opencode`,
 *     `primeAgent`) in a single
 *     `ProviderInstanceConfigMap` and asserts the registry boots them all
 *     without cross-contamination. This proves the driver SPI is uniform
 *     across every provider — any driver plugs into the registry through
 *     the same `ProviderDriver` value contract.
 *
 * Every instance in these tests is configured with `enabled: false` so the
 * provider-status checks short-circuit to pending/disabled snapshots
 * without trying to spawn real `codex` / `claude` / `agent` / `grok` / `opencode`
 * binaries. That keeps the assertions focused on registry routing
 * behaviour rather than the runtime details of each provider.
 */
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ClaudeSettings,
  type CodexSettings,
  type CursorSettings,
  type GrokSettings,
  type KimiSettings,
  type OpenCodeSettings,
  type PrimeSettings,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAccountLimitsStore } from "../../persistence/Services/ProviderAccountLimits.ts";
import { ProviderUsageLedgerStore } from "../../persistence/Services/ProviderUsageLedger.ts";
import {
  defaultProviderContinuationIdentity,
  type AnyProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import {
  NoOpProviderInstanceTeardownLive,
  ProviderInstanceTeardown,
} from "../Services/ProviderInstanceTeardown.ts";
import { ClaudeDriver } from "../Drivers/ClaudeDriver.ts";
import { CodexDriver } from "../Drivers/CodexDriver.ts";
import { CursorDriver } from "../Drivers/CursorDriver.ts";
import { GrokDriver } from "../Drivers/GrokDriver.ts";
import { KimiDriver } from "../Drivers/KimiDriver.ts";
import { OpenCodeDriver } from "../Drivers/OpenCodeDriver.ts";
import { PrimeDriver } from "../Drivers/PrimeDriver.ts";
import { OpenCodeRuntimeLive } from "../opencodeRuntime.ts";
import type { BuiltInDriversEnv } from "../builtInDrivers.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

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

const makeCodexConfig = (overrides: Partial<CodexSettings>): CodexSettings => ({
  enabled: false,
  binaryPath: "codex",
  homePath: "",
  shadowHomePath: "",
  launchArgs: "",
  customModels: [],
  ...overrides,
});

const makeClaudeConfig = (overrides: Partial<ClaudeSettings>): ClaudeSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  launchArgs: "",
  ...overrides,
});

const makeCursorConfig = (overrides: Partial<CursorSettings>): CursorSettings => ({
  enabled: false,
  binaryPath: "cursor-agent",
  apiEndpoint: "",
  customModels: [],
  ...overrides,
});

const makeGrokConfig = (overrides: Partial<GrokSettings>): GrokSettings => ({
  enabled: false,
  binaryPath: "grok",
  customModels: [],
  ...overrides,
});

const makeOpenCodeConfig = (overrides: Partial<OpenCodeSettings>): OpenCodeSettings => ({
  enabled: false,
  binaryPath: "opencode",
  serverUrl: "",
  serverPassword: "",
  customModels: [],
  ...overrides,
});

const makeKimiConfig = (overrides: Partial<KimiSettings>): KimiSettings => ({
  enabled: false,
  binaryPath: "kimi",
  homePath: "",
  customModels: [],
  ...overrides,
});

const makePrimeConfig = (overrides: Partial<PrimeSettings>): PrimeSettings => ({
  enabled: false,
  binaryPath: "prime-agent",
  launchArgs: [],
  ...overrides,
});

describe("ProviderInstanceRegistryLive — multi-instance codex slice", () => {
  // `ServerConfig.layerTest` needs `FileSystem` to materialize its scratch
  // directory. `Layer.merge` just unions requirements, so we have to push
  // `NodeServices.layer` through `Layer.provideMerge` to satisfy that
  // dependency while still surfacing NodeServices to the test body (the
  // codex driver's `create` yields `ChildProcessSpawner` directly).
  const testLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-test",
  }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(TestHttpClientLive),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    Layer.provideMerge(NoOpProviderUsageLedgerStoreLive),
    Layer.provideMerge(NoOpProviderAccountLimitsStoreLive),
    Layer.provideMerge(NoOpProviderInstanceTeardownLive),
  );

  it.live("boots two independent codex instances from a ProviderInstanceConfigMap", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const workId = ProviderInstanceId.make("codex_work");
      const codexDriverKind = ProviderDriverKind.make("codex");

      const configMap: ProviderInstanceConfigMap = {
        [personalId]: {
          driver: codexDriverKind,
          displayName: "Codex (personal)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-personal/bin/codex",
            homePath: "/home/julius/.codex_personal",
            customModels: ["personal-preview"],
          }),
        },
        [workId]: {
          driver: codexDriverKind,
          displayName: "Codex (work)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-work/bin/codex",
            homePath: "/home/julius/.codex",
            customModels: ["work-preview"],
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
      });

      const instances = yield* registry.listInstances;
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [personalId, workId].toSorted(),
      );
      expect(instances.every((instance) => instance.driverKind === codexDriverKind)).toBe(true);
      expect(instances.map((instance) => instance.displayName).toSorted()).toEqual(
        ["Codex (personal)", "Codex (work)"].toSorted(),
      );

      // Each instance must be retrievable by id and carry its *own* closures.
      const personal = yield* registry.getInstance(personalId);
      const work = yield* registry.getInstance(workId);
      expect(personal).toBeDefined();
      expect(work).toBeDefined();
      expect(personal!.adapter).not.toBe(work!.adapter);
      expect(personal!.textGeneration).not.toBe(work!.textGeneration);
      expect(personal!.snapshot).not.toBe(work!.snapshot);

      // Snapshots identify themselves by instanceId + driver — this is
      // what makes per-instance routing distinguishable downstream.
      const personalSnapshot = yield* personal!.snapshot.getSnapshot;
      expect(personalSnapshot.instanceId).toBe(personalId);
      expect(personalSnapshot.driver).toBe(codexDriverKind);
      expect(personalSnapshot.enabled).toBe(false);
      expect(personalSnapshot.continuation?.groupKey).toBe(
        "codex:home:/home/julius/.codex_personal",
      );

      const workSnapshot = yield* work!.snapshot.getSnapshot;
      expect(workSnapshot.instanceId).toBe(workId);
      expect(workSnapshot.driver).toBe(codexDriverKind);
      expect(workSnapshot.enabled).toBe(false);
      expect(workSnapshot.continuation?.groupKey).toBe("codex:home:/home/julius/.codex");

      // Nothing goes to the unavailable bucket — both drivers are registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "shadows instances whose driver is not registered in this build without failing boot",
    () =>
      Effect.gen(function* () {
        const codexId = ProviderInstanceId.make("codex_main");
        const ghostId = ProviderInstanceId.make("ghost_main");

        const configMap: ProviderInstanceConfigMap = {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: makeCodexConfig({}),
          },
          [ghostId]: {
            driver: ProviderDriverKind.make("ghostDriver"),
            displayName: "A fork-only driver we don't ship",
            enabled: false,
            config: { arbitrary: "payload", preserved: true },
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: [CodexDriver],
          configMap,
        });

        const instances = yield* registry.listInstances;
        expect(instances).toHaveLength(1);
        expect(instances[0]!.instanceId).toBe(codexId);

        const unavailable = yield* registry.listUnavailable;
        expect(unavailable).toHaveLength(1);
        const ghost = unavailable[0]!;
        expect(ghost.instanceId).toBe(ghostId);
        expect(ghost.driver).toBe("ghostDriver");
        expect(ghost.availability).toBe("unavailable");
        expect(ghost.unavailableReason).toMatch(/ghostDriver/);
      }).pipe(Effect.provide(testLayer)),
  );
});

describe("ProviderInstanceRegistryLive — reconcile teardown slice", () => {
  const recordingDriverKind = ProviderDriverKind.make("recordingDriver");

  /**
   * A driver with no process behind it. `create` only registers a scope
   * finalizer, so the trace below shows exactly when the registry closed each
   * instance — which is the thing this slice is about.
   */
  const makeRecordingDriver = (trace: Array<string>): AnyProviderDriver<never> => ({
    driverKind: recordingDriverKind,
    metadata: { displayName: "Recording" },
    configSchema: Schema.Unknown,
    defaultConfig: () => ({}),
    create: (input) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            trace.push(`scope-closed:${input.instanceId}`);
          }),
        );
        return {
          instanceId: input.instanceId,
          driverKind: recordingDriverKind,
          continuationIdentity: defaultProviderContinuationIdentity({
            driverKind: recordingDriverKind,
            instanceId: input.instanceId,
          }),
          displayName: input.displayName,
          enabled: input.enabled,
          // Nothing in this slice reads the three closures; the registry only
          // stores them.
          snapshot: {} as ProviderInstance["snapshot"],
          adapter: {} as ProviderInstance["adapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
      }),
  });

  const recordingTeardownLayer = (trace: Array<string>) =>
    Layer.succeed(ProviderInstanceTeardown, {
      stopSessionsOnInstances: (instanceIds) =>
        Effect.sync(() => {
          trace.push(`stop-sessions:${[...instanceIds].sort().join(",")}`);
        }),
    });

  // Held as consts so the kept entry is the *same* envelope on the second
  // reconcile — a fresh literal would read as a config change and rebuild it.
  const keptConfig = { driver: recordingDriverKind, displayName: "Kept", config: {} };
  const removedConfig = { driver: recordingDriverKind, displayName: "Removed", config: {} };

  it.live("stops the sessions on a removed instance before closing its scope", () =>
    Effect.gen(function* () {
      const keptId = ProviderInstanceId.make("recording_kept");
      const removedId = ProviderInstanceId.make("recording_removed");
      const trace: Array<string> = [];

      const { mutator } = yield* makeProviderInstanceRegistry({
        drivers: [makeRecordingDriver(trace)],
        configMap: {
          [keptId]: keptConfig,
          [removedId]: removedConfig,
        } as ProviderInstanceConfigMap,
      }).pipe(Effect.provide(recordingTeardownLayer(trace)));

      // Booting builds instances; it tears nothing down.
      expect(trace).toEqual([]);

      yield* mutator.reconcile({ [keptId]: keptConfig } as ProviderInstanceConfigMap);

      // The order is the fix. Reversed, the stop would run against an
      // instance the adapter registry can no longer resolve, and the thread
      // would keep a "running" binding with no process behind it.
      expect(trace).toEqual([`stop-sessions:${removedId}`, `scope-closed:${removedId}`]);
    }),
  );

  it.live("stops the sessions on a replaced instance before closing its scope", () =>
    Effect.gen(function* () {
      const keptId = ProviderInstanceId.make("recording_kept");
      const replacedId = ProviderInstanceId.make("recording_replaced");
      const trace: Array<string> = [];

      const { mutator, registry } = yield* makeProviderInstanceRegistry({
        drivers: [makeRecordingDriver(trace)],
        configMap: {
          [keptId]: keptConfig,
          [replacedId]: { driver: recordingDriverKind, displayName: "Before", config: {} },
        } as ProviderInstanceConfigMap,
      }).pipe(Effect.provide(recordingTeardownLayer(trace)));

      yield* mutator.reconcile({
        [keptId]: keptConfig,
        [replacedId]: { driver: recordingDriverKind, displayName: "After", config: {} },
      } as ProviderInstanceConfigMap);

      expect(trace).toEqual([`stop-sessions:${replacedId}`, `scope-closed:${replacedId}`]);

      // The replacement is live, and the untouched instance was never closed.
      const replaced = yield* registry.getInstance(replacedId);
      expect(replaced?.displayName).toBe("After");
      const kept = yield* registry.getInstance(keptId);
      expect(kept).toBeDefined();
    }),
  );

  it.live("does not call the teardown hook when nothing is removed or replaced", () =>
    Effect.gen(function* () {
      const keptId = ProviderInstanceId.make("recording_kept");
      const trace: Array<string> = [];

      const { mutator } = yield* makeProviderInstanceRegistry({
        drivers: [makeRecordingDriver(trace)],
        configMap: { [keptId]: keptConfig } as ProviderInstanceConfigMap,
      }).pipe(Effect.provide(recordingTeardownLayer(trace)));

      yield* mutator.reconcile({ [keptId]: keptConfig } as ProviderInstanceConfigMap);

      expect(trace).toEqual([]);
    }),
  );
});

describe("ProviderInstanceRegistryLive — all drivers slice", () => {
  // All drivers need `NodeServices` (ChildProcessSpawner + FileSystem +
  // Path). `OpenCodeDriver.create` additionally yields `OpenCodeRuntime`
  // at construction time, so we wire `OpenCodeRuntimeLive` into the stack.
  // `OpenCodeRuntimeLive` bundles its own `NetService.layer` via
  // `Layer.provide`, so the only external requirement it still exposes is
  // `ChildProcessSpawner` — resolved here by piping it through
  // `provideMerge(NodeServices.layer)`.
  //
  // The nested `provideMerge`s read bottom-up: `NodeServices.layer`
  // provides `OpenCodeRuntimeLive`'s deps while keeping its own outputs
  // surfaced; that merged layer then provides `ServerConfig.layerTest`'s
  // `FileSystem` dep while keeping everything else surfaced to the test.
  const infraLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));
  const testLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-all-drivers-test",
  }).pipe(
    Layer.provideMerge(infraLayer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(TestHttpClientLive),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    Layer.provideMerge(NoOpProviderUsageLedgerStoreLive),
    Layer.provideMerge(NoOpProviderAccountLimitsStoreLive),
    Layer.provideMerge(NoOpProviderInstanceTeardownLive),
  );

  it.live("boots one instance of every shipped driver from a single config map", () =>
    Effect.gen(function* () {
      const codexId = ProviderInstanceId.make("codex_default");
      const claudeId = ProviderInstanceId.make("claude_default");
      const cursorId = ProviderInstanceId.make("cursor_default");
      const grokId = ProviderInstanceId.make("grok_default");
      const kimiId = ProviderInstanceId.make("kimi_default");
      const openCodeId = ProviderInstanceId.make("opencode_default");
      const primeId = ProviderInstanceId.make("prime_default");

      const codexDriverKind = ProviderDriverKind.make("codex");
      const claudeDriverKind = ProviderDriverKind.make("claudeAgent");
      const cursorDriverKind = ProviderDriverKind.make("cursor");
      const grokDriverKind = ProviderDriverKind.make("grok");
      const kimiDriverKind = ProviderDriverKind.make("kimi");
      const openCodeDriverKind = ProviderDriverKind.make("opencode");
      const primeDriverKind = ProviderDriverKind.make("primeAgent");

      const configMap: ProviderInstanceConfigMap = {
        [codexId]: {
          driver: codexDriverKind,
          displayName: "Codex",
          enabled: false,
          config: makeCodexConfig({ homePath: "/home/julius/.codex" }),
        },
        [claudeId]: {
          driver: claudeDriverKind,
          displayName: "Claude",
          enabled: false,
          config: makeClaudeConfig({
            homePath: "/home/julius/.claude-work",
            launchArgs: "--verbose",
          }),
        },
        [cursorId]: {
          driver: cursorDriverKind,
          displayName: "Cursor",
          enabled: false,
          config: makeCursorConfig({}),
        },
        [grokId]: {
          driver: grokDriverKind,
          displayName: "Grok",
          enabled: false,
          config: makeGrokConfig({}),
        },
        [kimiId]: {
          driver: kimiDriverKind,
          displayName: "Kimi",
          enabled: false,
          environment: [
            {
              name: "KIMI_CODE_HOME",
              value: "/home/julius/.kimi-explicit",
              sensitive: false,
            },
          ],
          config: makeKimiConfig({ homePath: "/home/julius/.kimi-work" }),
        },
        [openCodeId]: {
          driver: openCodeDriverKind,
          displayName: "OpenCode",
          enabled: false,
          config: makeOpenCodeConfig({}),
        },
        [primeId]: {
          driver: primeDriverKind,
          displayName: "Prime",
          enabled: false,
          config: makePrimeConfig({}),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [
          CodexDriver,
          ClaudeDriver,
          CursorDriver,
          GrokDriver,
          KimiDriver,
          OpenCodeDriver,
          PrimeDriver,
        ] as ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>>,
        configMap,
      });

      // Every configured instance must materialize — none downgraded to a
      // shadow snapshot, because every driver in the map is registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);

      const instances = yield* registry.listInstances;
      expect(instances).toHaveLength(7);
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [codexId, claudeId, cursorId, grokId, kimiId, openCodeId, primeId].toSorted(),
      );

      // Instance lookup by id resolves each instance to its own bundle —
      // this is how rest-of-server routes turn/session calls in the new
      // model. Each driver's bundle carries its advertised `driverKind`.
      const codex = yield* registry.getInstance(codexId);
      const claude = yield* registry.getInstance(claudeId);
      const cursor = yield* registry.getInstance(cursorId);
      const grok = yield* registry.getInstance(grokId);
      const kimi = yield* registry.getInstance(kimiId);
      const openCode = yield* registry.getInstance(openCodeId);
      const prime = yield* registry.getInstance(primeId);
      expect(codex?.driverKind).toBe(codexDriverKind);
      expect(claude?.driverKind).toBe(claudeDriverKind);
      expect(cursor?.driverKind).toBe(cursorDriverKind);
      expect(grok?.driverKind).toBe(grokDriverKind);
      expect(kimi?.driverKind).toBe(kimiDriverKind);
      expect(openCode?.driverKind).toBe(openCodeDriverKind);
      expect(prime?.driverKind).toBe(primeDriverKind);
      expect(codex?.displayName).toBe("Codex");
      expect(claude?.displayName).toBe("Claude");
      expect(cursor?.displayName).toBe("Cursor");
      expect(grok?.displayName).toBe("Grok");
      expect(kimi?.displayName).toBe("Kimi");
      expect(openCode?.displayName).toBe("OpenCode");
      expect(prime?.displayName).toBe("Prime");

      // Every instance owns its own set of closures — no sharing across
      // drivers. `adapter` / `textGeneration` / `snapshot` are all
      // distinct references even when two instances happen to share a
      // trait (e.g. Cursor + others all use a stub-or-real
      // `textGeneration`; they must still be different object values).
      const adapters = [
        codex!.adapter,
        claude!.adapter,
        cursor!.adapter,
        grok!.adapter,
        kimi!.adapter,
        openCode!.adapter,
        prime!.adapter,
      ];
      expect(new Set(adapters).size).toBe(adapters.length);
      const textGenerations = [
        codex!.textGeneration,
        claude!.textGeneration,
        cursor!.textGeneration,
        grok!.textGeneration,
        kimi!.textGeneration,
        openCode!.textGeneration,
        prime!.textGeneration,
      ];
      expect(new Set(textGenerations).size).toBe(textGenerations.length);
      const snapshots = [
        codex!.snapshot,
        claude!.snapshot,
        cursor!.snapshot,
        grok!.snapshot,
        kimi!.snapshot,
        openCode!.snapshot,
        prime!.snapshot,
      ];
      expect(new Set(snapshots).size).toBe(snapshots.length);

      // Snapshots identify themselves by `instanceId` + `driver` so
      // downstream aggregation in `ProviderRegistry` can tell instances
      // apart even when two share a driver. With `enabled: false`, the
      // check short-circuits and we get a disabled/pending snapshot back
      // — that's enough signal to validate the stamping wrapper without
      // spawning real binaries.
      const codexSnapshot = yield* codex!.snapshot.getSnapshot;
      expect(codexSnapshot.instanceId).toBe(codexId);
      expect(codexSnapshot.driver).toBe(codexDriverKind);
      expect(codexSnapshot.enabled).toBe(false);
      expect(codexSnapshot.continuation?.groupKey).toBe("codex:home:/home/julius/.codex");

      const claudeSnapshot = yield* claude!.snapshot.getSnapshot;
      expect(claudeSnapshot.instanceId).toBe(claudeId);
      expect(claudeSnapshot.driver).toBe(claudeDriverKind);
      expect(claudeSnapshot.enabled).toBe(false);
      expect(claudeSnapshot.continuation?.groupKey).toBe("claude:home:/home/julius/.claude-work");

      const cursorSnapshot = yield* cursor!.snapshot.getSnapshot;
      expect(cursorSnapshot.instanceId).toBe(cursorId);
      expect(cursorSnapshot.driver).toBe(cursorDriverKind);
      expect(cursorSnapshot.enabled).toBe(false);
      expect(cursorSnapshot.continuation?.groupKey).toBe(
        `${cursorDriverKind}:instance:${cursorId}`,
      );

      const grokSnapshot = yield* grok!.snapshot.getSnapshot;
      expect(grokSnapshot.instanceId).toBe(grokId);
      expect(grokSnapshot.driver).toBe(grokDriverKind);
      expect(grokSnapshot.enabled).toBe(false);
      expect(grokSnapshot.continuation?.groupKey).toBe(`${grokDriverKind}:instance:${grokId}`);

      const kimiSnapshot = yield* kimi!.snapshot.getSnapshot;
      expect(kimiSnapshot.instanceId).toBe(kimiId);
      expect(kimiSnapshot.driver).toBe(kimiDriverKind);
      expect(kimiSnapshot.enabled).toBe(false);
      expect(kimiSnapshot.continuation?.groupKey).toBe("kimi:home:/home/julius/.kimi-work");

      const openCodeSnapshot = yield* openCode!.snapshot.getSnapshot;
      expect(openCodeSnapshot.instanceId).toBe(openCodeId);
      expect(openCodeSnapshot.driver).toBe(openCodeDriverKind);
      expect(openCodeSnapshot.enabled).toBe(false);
      expect(openCodeSnapshot.continuation?.groupKey).toBe(
        `${openCodeDriverKind}:instance:${openCodeId}`,
      );

      const primeSnapshot = yield* prime!.snapshot.getSnapshot;
      expect(primeSnapshot.instanceId).toBe(primeId);
      expect(primeSnapshot.driver).toBe(primeDriverKind);
      expect(primeSnapshot.enabled).toBe(false);
      expect(primeSnapshot.continuation?.groupKey).toBe(`${primeDriverKind}:instance:${primeId}`);
    }).pipe(Effect.provide(testLayer)),
  );
});
