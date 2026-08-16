import type { GitCommandError, ThreadId } from "@t3tools/contracts";
import { CommandId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { selectThreadsBoundToWorktree } from "./worktreeBoundSessions.ts";

const SESSION_STOP_TIMEOUT = Duration.seconds(15);
const SESSION_STOP_POLL_INTERVAL = Duration.millis(50);

export class WorktreeTargetExistsError extends Schema.TaggedErrorClass<WorktreeTargetExistsError>()(
  "WorktreeTargetExistsError",
  {
    path: Schema.String,
    source: Schema.Literals(["filesystem", "git"]),
  },
) {
  override get message(): string {
    return `Refusing to provision an existing worktree target (${this.source}): ${this.path}`;
  }
}

export interface ProvisionWorktreeInput {
  readonly projectCwd: string;
  readonly branch?: string;
  readonly baseBranch: string;
  readonly startFromOrigin?: boolean;
  readonly path: string | null;
  /** Preserve the existing UI behavior unless a coordinator requests strict refusal. */
  readonly refuseExisting?: boolean;
}

export interface ProvisionedWorktree {
  readonly path: string;
  readonly refName: string;
}

export interface ReleaseWorktreeInput {
  readonly repoCwd: string;
  readonly worktreePath: string;
  readonly force?: boolean;
}

export type WorktreeProvisionError =
  | GitCommandError
  | PlatformError.PlatformError
  | WorktreeTargetExistsError;

export class WorktreeProvisioner extends Context.Service<
  WorktreeProvisioner,
  {
    readonly provision: (
      input: ProvisionWorktreeInput,
    ) => Effect.Effect<ProvisionedWorktree, WorktreeProvisionError>;
    readonly release: (input: ReleaseWorktreeInput) => Effect.Effect<void, GitCommandError>;
  }
>()("t3/vcs/WorktreeProvisioner") {}

type EnqueueCommand = <A, E>(
  effect: Effect.Effect<A, E>,
) => Effect.Effect<A, E | ServerRuntimeStartup.ServerRuntimeStartupError>;

const makeWithEnqueue = (enqueueCommand: EnqueueCommand) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

    const branchExists = Effect.fn("WorktreeProvisioner.branchExists")(function* (
      cwd: string,
      branch: string,
    ) {
      const result = yield* git.execute({
        operation: "WorktreeProvisioner.branchExists",
        cwd,
        args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      });
      return result.exitCode === 0;
    });

    const originRemoteExists = Effect.fn("WorktreeProvisioner.originRemoteExists")(function* (
      cwd: string,
    ) {
      const result = yield* git.execute({
        operation: "WorktreeProvisioner.listRemotes",
        cwd,
        args: ["remote"],
        timeoutMs: 5_000,
      });
      return result.stdout.split(/\r?\n/u).some((line) => line.trim() === "origin");
    });

    const readRegisteredWorktree = Effect.fn("WorktreeProvisioner.readRegisteredWorktree")(
      function* (cwd: string, targetPath: string) {
        const result = yield* git.execute({
          operation: "WorktreeProvisioner.listWorktrees",
          cwd,
          args: ["worktree", "list", "--porcelain"],
          timeoutMs: 5_000,
          maxOutputBytes: 1_000_000,
        });
        const normalizedTarget = path.resolve(targetPath);
        for (const block of result.stdout.split(/\r?\n\r?\n/u)) {
          const lines = block.split(/\r?\n/u);
          const worktree = lines.find((line) => line.startsWith("worktree "));
          if (
            worktree === undefined ||
            path.resolve(worktree.slice("worktree ".length)) !== normalizedTarget
          ) {
            continue;
          }
          const branch = lines.find((line) => line.startsWith("branch refs/heads/"));
          return {
            registered: true,
            branch: branch?.slice("branch refs/heads/".length) ?? null,
          } as const;
        }
        return { registered: false, branch: null } as const;
      },
    );

    const refuseExistingTarget = Effect.fn("WorktreeProvisioner.refuseExistingTarget")(function* (
      cwd: string,
      targetPath: string,
    ) {
      if (yield* fileSystem.exists(targetPath)) {
        return yield* new WorktreeTargetExistsError({ path: targetPath, source: "filesystem" });
      }
      if ((yield* readRegisteredWorktree(cwd, targetPath)).registered) {
        return yield* new WorktreeTargetExistsError({ path: targetPath, source: "git" });
      }
    });

    const provision: WorktreeProvisioner["Service"]["provision"] = Effect.fn(
      "WorktreeProvisioner.provision",
    )(function* (input) {
      if (input.path !== null) {
        if (input.refuseExisting === true) {
          yield* refuseExistingTarget(input.projectCwd, input.path);
        } else {
          const onDisk = yield* fileSystem.exists(input.path);
          const registered = yield* readRegisteredWorktree(input.projectCwd, input.path);
          if (
            onDisk &&
            registered.registered &&
            input.branch !== undefined &&
            registered.branch === input.branch
          ) {
            return { path: input.path, refName: input.branch };
          }
          if (onDisk) {
            return yield* new WorktreeTargetExistsError({
              path: input.path,
              source: "filesystem",
            });
          }
          if (registered.registered) {
            return yield* new WorktreeTargetExistsError({ path: input.path, source: "git" });
          }
        }
      }

      let worktreeBaseRef = input.baseBranch;
      if (input.startFromOrigin) {
        // A remoteless repo (e.g. a local-only dotfiles repo) has nothing to
        // fetch; start from the local base branch instead of failing.
        if (yield* originRemoteExists(input.projectCwd)) {
          yield* gitWorkflow.fetchRemote({ cwd: input.projectCwd, remoteName: "origin" });
          const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
            cwd: input.projectCwd,
            refName: input.baseBranch,
            fallbackRemoteName: "origin",
          });
          worktreeBaseRef = resolvedRemoteBase.commitSha;
        } else {
          yield* Effect.logDebug("skipping origin fetch: repository has no origin remote", {
            projectCwd: input.projectCwd,
          });
        }
      }

      const reuseBranch =
        input.branch === undefined ? false : yield* branchExists(input.projectCwd, input.branch);
      const worktree = yield* gitWorkflow.createWorktree(
        reuseBranch && input.branch !== undefined
          ? {
              cwd: input.projectCwd,
              refName: input.branch,
              path: input.path,
            }
          : input.branch === undefined
            ? {
                cwd: input.projectCwd,
                refName: worktreeBaseRef,
                baseRefName: input.baseBranch,
                path: input.path,
              }
            : {
                cwd: input.projectCwd,
                refName: worktreeBaseRef,
                newRefName: input.branch,
                baseRefName: input.baseBranch,
                path: input.path,
              },
      );
      return worktree.worktree;
    });

    const waitForSessionStopped = (threadId: ThreadId) =>
      projectionSnapshotQuery.getThreadShellById(threadId).pipe(
        Effect.map(
          Option.match({
            onNone: () => false,
            onSome: (thread) => thread.session !== null && thread.session.status !== "stopped",
          }),
        ),
        Effect.repeat({
          while: (running) => running,
          schedule: Schedule.spaced(SESSION_STOP_POLL_INTERVAL),
        }),
        Effect.timeout(SESSION_STOP_TIMEOUT),
        Effect.asVoid,
      );

    const stopSessionAttempt = Effect.fn("WorktreeProvisioner.stopSession")(function* (
      threadId: ThreadId,
      _worktreePath: string,
    ) {
      const uuid = yield* crypto.randomUUIDv4;
      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      // Session-stop has no path or attachment fields to normalize. The current
      // WebSocket path only replaces its timestamp, which this command already
      // takes from the same server clock immediately before dispatch.
      const stopCommand = {
        type: "thread.session.stop",
        commandId: CommandId.make(`server:session-stop-for-worktree-removal:${uuid}`),
        threadId,
        createdAt,
      } as const;

      yield* enqueueCommand(orchestrationEngine.dispatch(stopCommand));
      yield* waitForSessionStopped(threadId);
    });

    const stopSession = (threadId: ThreadId, worktreePath: string) =>
      stopSessionAttempt(threadId, worktreePath).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to stop provider session before worktree removal", {
            threadId,
            worktreePath,
            cause,
          }),
        ),
      );

    const stopBoundSessions = Effect.fn("WorktreeProvisioner.stopBoundSessions")(function* (
      worktreePath: string,
    ) {
      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
      const boundThreadIds = yield* selectThreadsBoundToWorktree(fileSystem, path, {
        worktreePath,
        threads: snapshot.threads,
        projects: snapshot.projects,
      });
      yield* Effect.forEach(boundThreadIds, (threadId) => stopSession(threadId, worktreePath), {
        concurrency: "unbounded",
        discard: true,
      });
    });

    const release: WorktreeProvisioner["Service"]["release"] = Effect.fn(
      "WorktreeProvisioner.release",
    )(function* (input) {
      yield* stopBoundSessions(input.worktreePath).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to release provider sessions before worktree removal", {
            worktreePath: input.worktreePath,
            cause,
          }),
        ),
      );
      yield* gitWorkflow.removeWorktree({
        cwd: input.repoCwd,
        path: input.worktreePath,
        ...(input.force === undefined ? {} : { force: input.force }),
      });
    });

    return WorktreeProvisioner.of({ provision, release });
  });

/** Full UI layer. Session-stop commands wait for server command readiness. */
export const make = Effect.gen(function* () {
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  return yield* makeWithEnqueue(startup.enqueueCommand);
});

/**
 * Coordinator layer used before `ServerRuntimeStartup` exists. EpicRunner only
 * provisions worktrees, so this avoids the Startup -> EpicRunner layer cycle.
 */
export const makeDirect = makeWithEnqueue((effect) => effect);

export const layer = Layer.effect(WorktreeProvisioner, make);
export const layerDirect = Layer.effect(WorktreeProvisioner, makeDirect);
