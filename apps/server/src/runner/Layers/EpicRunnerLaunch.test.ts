import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  EpicRunId,
  type EpicRunPreflightInput,
  type EpicRunPreflightResult,
} from "@t3tools/contracts";
import type {
  EpicRunConfigSnapshot,
  EpicRunPreflightShape,
} from "@t3tools/epic-core/EpicRunPreflight";
import type { EpicRunLockShape } from "@t3tools/epic-core/ports/EpicRunLock";
import * as Effect from "effect/Effect";

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
