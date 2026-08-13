import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_EPIC_ROLE_POLICY,
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  EpicRunId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type EpicRunPreflightInput,
  type EpicRunPreflightResult,
  type LaunchEpicRunInput,
  type ModelSelection,
} from "@t3tools/contracts";
import type {
  EpicRunConfigSnapshot,
  EpicRunPreflightShape,
} from "@t3tools/epic-core/EpicRunPreflight";
import type { EpicRunLockShape } from "@t3tools/epic-core/ports/EpicRunLock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { EpicRun } from "../../persistence/Services/EpicRuns.ts";
import { makeEpicRunnerLaunch } from "./EpicRunnerLaunch.ts";

const snapshot = (sequential: boolean): EpicRunConfigSnapshot => ({
  fileResult: { _tag: "absent" },
  config: {
    ...DEFAULT_EPIC_RUN_CONFIG,
    execution: { ...DEFAULT_EPIC_RUN_CONFIG.execution, sequential },
  },
  provenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  violations: [],
});

const stubPreflightResult = (
  overrides?: Partial<EpicRunPreflightResult>,
): EpicRunPreflightResult => ({
  ok: true,
  blockers: [],
  warnings: [],
  resolvedConfig: DEFAULT_EPIC_RUN_CONFIG,
  configProvenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  ...overrides,
});

const makeLaunch = (input: {
  readonly onPreflight: (preflightInput: EpicRunPreflightInput) => void;
  readonly preflightResult?: EpicRunPreflightResult;
}) => {
  const preflight: EpicRunPreflightShape = {
    check: (preflightInput) =>
      Effect.sync(() => {
        input.onPreflight(preflightInput);
        return input.preflightResult ?? stubPreflightResult();
      }),
  };
  const runLock: EpicRunLockShape = {
    // @effect-diagnostics-next-line effectSucceedWithVoid:off
    inspect: () => Effect.succeed(undefined),
    acquire: () =>
      Effect.succeed({
        path: "/repo/.beads/run-lock.epic-1.json",
        owner: {
          owner: "t3code",
          host: "host",
          pid: 1,
          pgid: 1,
          runDir: "/repo",
          startedAt: "2026-01-01T00:00:00.000Z",
          heartbeatAt: 1,
        },
        heartbeat: Effect.succeed(true),
        release: Effect.succeed(true),
      }),
  };
  return makeEpicRunnerLaunch({
    store: undefined as never,
    preflight,
    configSource: undefined as never,
    runLock,
    projectionSnapshotQuery: undefined as never,
    providerRegistry: undefined as never,
    crypto: undefined as never,
    enrichRun: undefined as never,
    saveRun: undefined as never,
    leases: new Map(),
    forkLoop: undefined as never,
    releaseLeaseOnFailure: undefined as never,
    providerDegradationTtlMs: 0,
    readEpicRolePolicy: Effect.succeed(DEFAULT_EPIC_ROLE_POLICY),
  });
};

describe("EpicRunnerLaunch acquireLease", () => {
  it.effect("sends mode parallel to preflight for a parallel run", () =>
    Effect.gen(function* () {
      let observed: EpicRunPreflightInput | undefined;
      const launch = makeLaunch({ onPreflight: (preflightInput) => (observed = preflightInput) });
      yield* launch.acquireLease(
        EpicRunId.make("run-1"),
        { cwd: "/repo", epicId: "epic-1" },
        snapshot(false),
      );
      expect(observed?.mode).toBe("parallel");
    }),
  );

  it.effect("sends mode sequential to preflight for a sequential run", () =>
    Effect.gen(function* () {
      let observed: EpicRunPreflightInput | undefined;
      const launch = makeLaunch({ onPreflight: (preflightInput) => (observed = preflightInput) });
      yield* launch.acquireLease(
        EpicRunId.make("run-1"),
        { cwd: "/repo", epicId: "epic-1" },
        snapshot(true),
      );
      expect(observed?.mode).toBe("sequential");
    }),
  );

  it.effect("maps a held run lock to EpicRunLeaseHeld even alongside other blockers", () =>
    Effect.gen(function* () {
      const launch = makeLaunch({
        onPreflight: () => undefined,
        preflightResult: stubPreflightResult({
          ok: false,
          blockers: [
            { _tag: "dirty_tree", paths: ["modified.ts"] },
            {
              _tag: "run_in_progress",
              owner: "terminal",
              runDir: "/tmp/run",
              host: "host",
              pid: 42,
            },
          ],
        }),
      });
      const error = yield* Effect.flip(
        launch.acquireLease(
          EpicRunId.make("run-1"),
          { cwd: "/repo", epicId: "epic-1" },
          snapshot(true),
        ),
      );
      expect(error._tag).toBe("EpicRunLeaseHeld");
    }),
  );
});

const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const projectDefaultSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
};
const primeSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("prime-work"),
  model: "prime/sonnet",
  options: [{ id: "reasoningEffort", value: "high" }],
};

/**
 * A launch harness with no loop behind it: `launchRun` stops at `saveRun`, so
 * the saved row is the whole assertion surface for what a launch resolved.
 */
const makeLaunchHarness = (
  threads: Record<
    string,
    { readonly projectId: ProjectId; readonly modelSelection: ModelSelection }
  >,
) => {
  const saved: EpicRun[] = [];
  const launch = makeEpicRunnerLaunch({
    store: {
      listRuns: () => Effect.succeed([]),
    } as unknown as Parameters<typeof makeEpicRunnerLaunch>[0]["store"],
    preflight: {
      check: () => Effect.succeed(stubPreflightResult()),
    } satisfies EpicRunPreflightShape,
    configSource: {
      read: () => Effect.succeed({ _tag: "absent" as const }),
    } as unknown as Parameters<typeof makeEpicRunnerLaunch>[0]["configSource"],
    runLock: {
      // @effect-diagnostics-next-line effectSucceedWithVoid:off
      inspect: () => Effect.succeed(undefined),
      acquire: () =>
        Effect.succeed({
          path: "/repo/.beads/run-lock.epic-1.json",
          owner: {
            owner: "t3code",
            host: "host",
            pid: 1,
            pgid: 1,
            runDir: "/repo",
            startedAt: "2026-01-01T00:00:00.000Z",
            heartbeatAt: 1,
          },
          heartbeat: Effect.succeed(true),
          release: Effect.succeed(true),
        }),
    } satisfies EpicRunLockShape,
    projectionSnapshotQuery: {
      getProjectShellById: (id: ProjectId) =>
        Effect.succeed(
          Option.some({
            id,
            title: "Epic project",
            workspaceRoot: "/repo",
            defaultModelSelection: projectDefaultSelection,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        ),
      getThreadShellById: (threadId: ThreadId) =>
        Effect.succeed(Option.fromNullishOr(threads[threadId])),
    } as unknown as Parameters<typeof makeEpicRunnerLaunch>[0]["projectionSnapshotQuery"],
    // Registry absence keeps the resolved selection exactly as chosen, so a
    // degraded-provider hop cannot be mistaken for inheritance.
    providerRegistry: Option.none(),
    crypto: { randomUUIDv4: Effect.succeed("run-uuid") } as never,
    enrichRun: (run: EpicRun) =>
      Effect.succeed(run as unknown as import("@t3tools/contracts").EpicRun),
    saveRun: (run: EpicRun) =>
      Effect.sync(() => {
        saved.push(run);
      }),
    leases: new Map(),
    forkLoop: () => Effect.void,
    releaseLeaseOnFailure: () => (effect) => effect,
    providerDegradationTtlMs: 60_000,
    readEpicRolePolicy: Effect.succeed(DEFAULT_EPIC_ROLE_POLICY),
  });
  const input = (overrides: Partial<LaunchEpicRunInput>): LaunchEpicRunInput => ({
    epicId: "epic-1",
    projectId,
    cwd: "/repo",
    ...overrides,
  });
  return { launch, saved, input };
};

describe("EpicRunnerLaunch inheritOriginModelSelection", () => {
  it.effect("keeps the project default when the option is absent", () =>
    Effect.gen(function* () {
      const harness = makeLaunchHarness({
        "thread-origin": { projectId, modelSelection: primeSelection },
      });
      yield* harness.launch.launchRun(
        harness.input({ originThreadId: ThreadId.make("thread-origin") }),
      );
      expect(harness.saved[0]?.modelSelection).toEqual(projectDefaultSelection);
    }),
  );

  it.effect("runs on the origin thread's exact instance, model and options", () =>
    Effect.gen(function* () {
      const harness = makeLaunchHarness({
        "thread-origin": { projectId, modelSelection: primeSelection },
      });
      const run = yield* harness.launch.launchRun(
        harness.input({
          originThreadId: ThreadId.make("thread-origin"),
          inheritOriginModelSelection: true,
        }),
      );
      // The persisted row is what every iteration thread is dispatched with.
      expect(harness.saved[0]?.modelSelection).toEqual(primeSelection);
      expect(run.originThreadId).toBe("thread-origin");
    }),
  );

  it.effect("rejects a launch that asks to inherit without an origin thread", () =>
    Effect.gen(function* () {
      const harness = makeLaunchHarness({});
      const error = yield* Effect.flip(
        harness.launch.launchRun(harness.input({ inheritOriginModelSelection: true })),
      );
      expect(error).toMatchObject({
        _tag: "EpicRunLaunchError",
        reason: "origin_thread_required",
      });
      expect(harness.saved).toHaveLength(0);
    }),
  );

  it.effect("rejects an origin thread that is archived or gone", () =>
    Effect.gen(function* () {
      const harness = makeLaunchHarness({});
      const error = yield* Effect.flip(
        harness.launch.launchRun(
          harness.input({
            originThreadId: ThreadId.make("thread-archived"),
            inheritOriginModelSelection: true,
          }),
        ),
      );
      expect(error).toMatchObject({
        _tag: "EpicRunLaunchError",
        reason: "origin_thread_not_found",
      });
      expect(harness.saved).toHaveLength(0);
    }),
  );

  it.effect("rejects an origin thread from another project", () =>
    Effect.gen(function* () {
      const harness = makeLaunchHarness({
        "thread-elsewhere": { projectId: otherProjectId, modelSelection: primeSelection },
      });
      const error = yield* Effect.flip(
        harness.launch.launchRun(
          harness.input({
            originThreadId: ThreadId.make("thread-elsewhere"),
            inheritOriginModelSelection: true,
          }),
        ),
      );
      expect(error).toMatchObject({
        _tag: "EpicRunLaunchError",
        reason: "origin_thread_project_mismatch",
      });
      expect(harness.saved).toHaveLength(0);
    }),
  );
});
