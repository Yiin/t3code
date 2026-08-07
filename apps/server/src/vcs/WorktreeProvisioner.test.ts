import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  WorktreeProvisioner,
  WorktreeTargetExistsError,
  layer as WorktreeProvisionerLayer,
} from "./WorktreeProvisioner.ts";

const gitResult = (exitCode: number, stdout = ""): GitVcsDriver.ExecuteGitResult => ({
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

interface TestServicesInput {
  readonly execute?: GitVcsDriver.GitVcsDriver["Service"]["execute"];
  readonly createWorktree?: GitWorkflowService.GitWorkflowService["Service"]["createWorktree"];
  readonly fetchRemote?: GitWorkflowService.GitWorkflowService["Service"]["fetchRemote"];
  readonly resolveRemoteTrackingCommit?: GitWorkflowService.GitWorkflowService["Service"]["resolveRemoteTrackingCommit"];
  readonly removeWorktree?: GitWorkflowService.GitWorkflowService["Service"]["removeWorktree"];
  readonly getShellSnapshot?: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]["getShellSnapshot"];
  readonly getThreadShellById?: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]["getThreadShellById"];
  readonly dispatch?: OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"];
  readonly enqueueCommand?: ServerRuntimeStartup.ServerRuntimeStartup["Service"]["enqueueCommand"];
}

const makeTestLayer = (input: TestServicesInput = {}) => {
  const git = {
    execute:
      input.execute ??
      ((request: GitVcsDriver.ExecuteGitInput) =>
        Effect.succeed(request.args[0] === "show-ref" ? gitResult(1) : gitResult(0))),
  } as GitVcsDriver.GitVcsDriver["Service"];
  const gitWorkflow = {
    createWorktree:
      input.createWorktree ??
      ((request) =>
        Effect.succeed({
          worktree: {
            path: request.path ?? "/tmp/default-worktree",
            refName: request.newRefName ?? request.refName,
          },
        })),
    fetchRemote: input.fetchRemote ?? (() => Effect.void),
    resolveRemoteTrackingCommit:
      input.resolveRemoteTrackingCommit ??
      (() => Effect.succeed({ commitSha: "remote-sha", remoteRefName: "origin/main" })),
    removeWorktree: input.removeWorktree ?? (() => Effect.void),
  } as GitWorkflowService.GitWorkflowService["Service"];
  const projection = {
    getShellSnapshot:
      input.getShellSnapshot ??
      (() =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [],
          threads: [],
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
    getThreadShellById: input.getThreadShellById ?? (() => Effect.succeed(Option.none())),
  } as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  const engine = {
    dispatch: input.dispatch ?? (() => Effect.succeed({ sequence: 1 })),
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  } as OrchestrationEngine.OrchestrationEngineService["Service"];
  const startup = {
    awaitCommandReady: Effect.void,
    markHttpListening: Effect.void,
    enqueueCommand: input.enqueueCommand ?? ((effect) => effect),
  } as ServerRuntimeStartup.ServerRuntimeStartup["Service"];

  return WorktreeProvisionerLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(GitVcsDriver.GitVcsDriver, git),
        Layer.succeed(GitWorkflowService.GitWorkflowService, gitWorkflow),
        Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, projection),
        Layer.succeed(OrchestrationEngine.OrchestrationEngineService, engine),
        Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, startup),
      ),
    ),
  );
};

const makeTmpDir = (): Effect.Effect<string, never, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "worktree-provisioner-test-" })
      .pipe(Effect.orDie);
  });

describe("WorktreeProvisioner", () => {
  it.effect("provisions a new branch from the fetched origin base", () => {
    const operations: string[] = [];
    let createInput:
      | Parameters<GitWorkflowService.GitWorkflowService["Service"]["createWorktree"]>[0]
      | null = null;
    return Effect.gen(function* () {
      const provisioner = yield* WorktreeProvisioner;
      const result = yield* provisioner.provision({
        projectCwd: "/repo",
        branch: "epic/child",
        baseBranch: "main",
        startFromOrigin: true,
        path: "/worktrees/child",
      });

      assert.deepEqual(operations, ["list", "fetch", "resolve", "branch-exists", "create"]);
      assert.deepInclude(createInput, {
        cwd: "/repo",
        refName: "fetched-sha",
        newRefName: "epic/child",
        baseRefName: "main",
        path: "/worktrees/child",
      });
      assert.deepEqual(result, { path: "/worktrees/child", refName: "epic/child" });
    }).pipe(
      Effect.provide(
        makeTestLayer({
          execute: (request) =>
            Effect.sync(() => {
              if (request.args[0] === "worktree") {
                operations.push("list");
                return gitResult(0);
              }
              operations.push("branch-exists");
              return gitResult(1);
            }),
          fetchRemote: () =>
            Effect.sync(() => {
              operations.push("fetch");
            }),
          resolveRemoteTrackingCommit: () =>
            Effect.sync(() => {
              operations.push("resolve");
              return { commitSha: "fetched-sha", remoteRefName: "origin/main" };
            }),
          createWorktree: (request) =>
            Effect.sync(() => {
              operations.push("create");
              createInput = request;
              return {
                worktree: {
                  path: request.path ?? "/tmp/default-worktree",
                  refName: request.newRefName ?? request.refName,
                },
              };
            }),
        }),
      ),
    );
  });

  it.effect("reuses an existing branch without passing -b inputs", () => {
    let createInput:
      | Parameters<GitWorkflowService.GitWorkflowService["Service"]["createWorktree"]>[0]
      | null = null;
    return Effect.gen(function* () {
      const provisioner = yield* WorktreeProvisioner;
      yield* provisioner.provision({
        projectCwd: "/repo",
        branch: "epic/existing",
        baseBranch: "main",
        startFromOrigin: false,
        path: "/worktrees/existing",
      });

      assert.deepEqual(createInput, {
        cwd: "/repo",
        refName: "epic/existing",
        path: "/worktrees/existing",
      });
    }).pipe(
      Effect.provide(
        makeTestLayer({
          execute: () => Effect.succeed(gitResult(0)),
          createWorktree: (request) =>
            Effect.sync(() => {
              createInput = request;
              return {
                worktree: { path: request.path ?? "/tmp/default", refName: request.refName },
              };
            }),
        }),
      ),
    );
  });

  it.effect("reuses the matching registered worktree on an iteration retry", () => {
    let existingPath = "";
    return Effect.scoped(
      Effect.gen(function* () {
        existingPath = yield* makeTmpDir();
        const provisioner = yield* WorktreeProvisioner;
        const result = yield* provisioner.provision({
          projectCwd: "/repo",
          branch: "epic/retry",
          baseBranch: "main",
          path: existingPath,
        });

        assert.deepStrictEqual(result, { path: existingPath, refName: "epic/retry" });
      }).pipe(
        Effect.provide(
          makeTestLayer({
            execute: (request) =>
              request.args[0] === "worktree"
                ? Effect.succeed(
                    gitResult(
                      0,
                      `worktree ${existingPath}\nHEAD abc\nbranch refs/heads/epic/retry\n`,
                    ),
                  )
                : Effect.die("branch lookup must not run for a registered retry"),
            createWorktree: () => Effect.die("registered retry must not create a worktree"),
          }),
        ),
      ),
    ).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("refuses an existing filesystem target", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const existingPath = yield* makeTmpDir();
        const provisioner = yield* WorktreeProvisioner;
        const error = yield* provisioner
          .provision({
            projectCwd: "/repo",
            branch: "epic/existing-path",
            baseBranch: "main",
            startFromOrigin: false,
            path: existingPath,
            refuseExisting: true,
          })
          .pipe(Effect.flip, Effect.orDie);

        assert.instanceOf(error, WorktreeTargetExistsError);
        assert.deepInclude(error, { source: "filesystem", path: existingPath });
      }).pipe(Effect.provide(makeTestLayer())),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a registered target whose directory is missing", () => {
    const registeredPath = "/worktrees/registered-but-missing";
    return Effect.gen(function* () {
      const provisioner = yield* WorktreeProvisioner;
      const error = yield* provisioner
        .provision({
          projectCwd: "/repo",
          branch: "epic/registered",
          baseBranch: "main",
          startFromOrigin: false,
          path: registeredPath,
          refuseExisting: true,
        })
        .pipe(Effect.flip, Effect.orDie);

      assert.instanceOf(error, WorktreeTargetExistsError);
      assert.deepInclude(error, { source: "git", path: registeredPath });
    }).pipe(
      Effect.provide(
        makeTestLayer({
          execute: (request) =>
            Effect.succeed(
              request.args[0] === "worktree"
                ? gitResult(0, `worktree ${registeredPath}\nHEAD abc\nbranch refs/heads/main\n`)
                : gitResult(1),
            ),
        }),
      ),
    );
  });

  it.effect("refuses a missing registered target during a normal retry", () => {
    const registeredPath = "/worktrees/registered-retry-missing";
    return Effect.gen(function* () {
      const provisioner = yield* WorktreeProvisioner;
      const error = yield* provisioner
        .provision({
          projectCwd: "/repo",
          branch: "epic/retry-missing",
          baseBranch: "main",
          path: registeredPath,
        })
        .pipe(Effect.flip, Effect.orDie);

      assert.instanceOf(error, WorktreeTargetExistsError);
      assert.deepInclude(error, { source: "git", path: registeredPath });
    }).pipe(
      Effect.provide(
        makeTestLayer({
          execute: (request) =>
            Effect.succeed(
              request.args[0] === "worktree"
                ? gitResult(
                    0,
                    `worktree ${registeredPath}\nHEAD abc\nbranch refs/heads/epic/retry-missing\n`,
                  )
                : gitResult(1),
            ),
          createWorktree: () => Effect.die("a missing registered target must not be reused"),
        }),
      ),
    );
  });

  it.effect("stops a bound session through the startup gate before removal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const worktreePath = yield* makeTmpDir();
        const path = yield* Path.Path;
        const repoCwd = path.dirname(worktreePath);
        const threadId = ThreadId.make("thread-bound");
        const projectId = ProjectId.make("project-bound");
        const effects: string[] = [];
        let stopped = false;
        const thread = {
          id: threadId,
          projectId,
          worktreePath,
          session: { status: "ready" },
        } as OrchestrationThreadShell;
        const project = { id: projectId, workspaceRoot: repoCwd } as OrchestrationProjectShell;

        const program = Effect.gen(function* () {
          const provisioner = yield* WorktreeProvisioner;
          yield* provisioner.release({ repoCwd, worktreePath, force: true });
          assert.deepEqual(effects, [
            "enqueue",
            "dispatch:thread.session.stop",
            "query:stopped",
            "remove:true",
          ]);
        });

        yield* program.pipe(
          Effect.provide(
            makeTestLayer({
              getShellSnapshot: () =>
                Effect.succeed({
                  snapshotSequence: 1,
                  projects: [project],
                  threads: [thread],
                  updatedAt: "2026-01-01T00:00:00.000Z",
                }),
              getThreadShellById: () =>
                Effect.sync(() => {
                  effects.push(`query:${stopped ? "stopped" : "ready"}`);
                  return Option.some({
                    ...thread,
                    session: { status: stopped ? "stopped" : "ready" },
                  } as OrchestrationThreadShell);
                }),
              enqueueCommand: (effect) =>
                Effect.sync(() => effects.push("enqueue")).pipe(Effect.andThen(effect)),
              dispatch: (command) =>
                Effect.sync(() => {
                  effects.push(`dispatch:${command.type}`);
                  stopped = true;
                  return { sequence: 1 };
                }),
              removeWorktree: (request) =>
                Effect.sync(() => {
                  effects.push(`remove:${String(request.force)}`);
                }),
            }),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
