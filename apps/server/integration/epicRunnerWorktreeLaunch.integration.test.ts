// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  DEFAULT_EPIC_ROLE_POLICY,
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  EpicRunId,
  ProjectId,
  ProviderInstanceId,
  type LaunchEpicRunInput,
} from "@t3tools/contracts";
import type {
  EpicRunConfigSnapshot,
  EpicRunPreflightShape,
} from "@t3tools/epic-core/EpicRunPreflight";
import { EpicRunLock, type EpicRunLockShape } from "@t3tools/epic-core/ports/EpicRunLock";
import * as lockLive from "@t3tools/epic-core/adapters/NodeEpicRunLock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { makeEpicRunnerLaunch } from "../src/runner/Layers/EpicRunnerLaunch.ts";
import { makeRepoWithWorktree } from "../src/runner/testUtils/gitWorktreeFixture.ts";

const projectId = ProjectId.make("worktree-launch-project");
const selection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

const snapshot: EpicRunConfigSnapshot = {
  fileResult: { _tag: "absent" },
  config: DEFAULT_EPIC_RUN_CONFIG,
  provenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  violations: [],
};

const makeLaunch = (workspaceRoot: string, lock: EpicRunLockShape) =>
  makeEpicRunnerLaunch({
    processRunner: {
      run: () =>
        Effect.succeed({
          stdout: `${workspaceRoot}/.git\n`,
          stderr: "",
          code: 0 as never,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    } as never,
    store: { listRuns: () => Effect.succeed([]) } as never,
    preflight: {
      check: () =>
        Effect.succeed({
          ok: true,
          blockers: [],
          warnings: [],
          resolvedConfig: DEFAULT_EPIC_RUN_CONFIG,
          configProvenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
        }),
    } satisfies EpicRunPreflightShape,
    configSource: { read: () => Effect.succeed({ _tag: "absent" as const }) } as never,
    runLock: lock,
    projectionSnapshotQuery: {
      getProjectShellById: (id: ProjectId) =>
        Effect.succeed(
          Option.some({
            id,
            title: "Worktree launch project",
            workspaceRoot,
            defaultModelSelection: selection,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        ),
    } as never,
    providerRegistry: Option.none(),
    crypto: { randomUUIDv4: Effect.succeed("run-id") } as never,
    enrichRun: (run) => Effect.succeed(run as never),
    saveRun: () => Effect.void,
    leases: new Map(),
    forkLoop: () => Effect.void,
    releaseLeaseOnFailure: () => (effect) => effect,
    providerDegradationTtlMs: 0,
    readEpicRolePolicy: Effect.succeed(DEFAULT_EPIC_ROLE_POLICY),
    readUsageSamples: Effect.succeed([]),
    readAccountLimits: Effect.succeed([]),
  });

const acquire = (launch: ReturnType<typeof makeEpicRunnerLaunch>, cwd: string, epicId: string) =>
  launch.acquireLease(EpicRunId.make(`run-${epicId}`), { cwd, epicId }, snapshot);

describe("EpicRunner worktree launch", () => {
  it.live("shares the lock across checkouts in either launch order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeRepoWithWorktree;
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(fixture.worktreeRoot, ".beads"));
          await NodeFSP.writeFile(
            NodePath.join(fixture.worktreeRoot, ".beads", "redirect"),
            `${fixture.mainRoot}/.beads\n`,
          );
        });
        const lock = yield* EpicRunLock;
        const mainLaunch = makeLaunch(fixture.mainRoot, lock);
        const worktreeLaunch = makeLaunch(fixture.mainRoot, lock);

        for (const first of [fixture.mainRoot, fixture.worktreeRoot]) {
          const second = first === fixture.mainRoot ? fixture.worktreeRoot : fixture.mainRoot;
          const held = yield* lock.acquire({
            workspaceRoot: first,
            epicId: "same-epic",
            owner: "t3code",
            runDir: first,
          });
          const error = yield* Effect.flip(
            acquire(first === fixture.mainRoot ? worktreeLaunch : mainLaunch, second, "same-epic"),
          );
          if (error._tag !== "EpicRunLeaseHeld") throw new Error(`unexpected error: ${error._tag}`);
          expect(error.mappedError.message).toContain("same-epic");
          expect(yield* held.release).toBe(true);
        }
      }).pipe(Effect.provide(lockLive.layer)),
    ),
  );

  it.live("uses one main-checkout lock directory and allows different epics", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeRepoWithWorktree;
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(fixture.worktreeRoot, ".beads"));
          await NodeFSP.writeFile(
            NodePath.join(fixture.worktreeRoot, ".beads", "redirect"),
            `${fixture.mainRoot}/.beads\n`,
          );
        });
        const lock = yield* EpicRunLock;
        const main = yield* lock.acquire({
          workspaceRoot: fixture.mainRoot,
          epicId: "main-epic",
          owner: "t3code",
          runDir: fixture.mainRoot,
        });
        const worktree = yield* lock.acquire({
          workspaceRoot: fixture.worktreeRoot,
          epicId: "worktree-epic",
          owner: "t3code",
          runDir: fixture.worktreeRoot,
        });

        expect(main.path).toBe(`${fixture.mainRoot}/.beads/run-lock.main-epic.json`);
        expect(worktree.path).toBe(`${fixture.mainRoot}/.beads/run-lock.worktree-epic.json`);
        expect(yield* main.release).toBe(true);
        expect(yield* worktree.release).toBe(true);
      }).pipe(Effect.provide(lockLive.layer)),
    ),
  );

  it.live("passes a same-repository worktree cwd through launch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeRepoWithWorktree;
        const lock = yield* EpicRunLock;
        const launch = makeLaunch(fixture.mainRoot, lock);
        const input: LaunchEpicRunInput = {
          epicId: "cwd-gate-epic",
          projectId,
          cwd: fixture.worktreeRoot,
        };

        const run = yield* launch.launchRun(input);
        expect(run.cwd).toBe(fixture.worktreeRoot);
        expect(run.config.vcs.runOwnedBaseBranch).toBe(true);
      }).pipe(Effect.provide(lockLive.layer)),
    ),
  );
});
