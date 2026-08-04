import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  type OrchestrationProjectShell,
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { selectThreadsBoundToWorktree } from "./worktreeBoundSessions.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "sonnet",
} as const;

const makeProject = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: projectId,
  title: "Project",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
});

const makeThread = (input: {
  readonly id: string;
  readonly worktreePath: string | null;
  readonly sessionStatus: OrchestrationSessionStatus | null;
}): OrchestrationThreadShell => {
  const id = ThreadId.make(input.id);
  return {
    id,
    projectId,
    title: input.id,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session:
      input.sessionStatus === null
        ? null
        : {
            threadId: id,
            status: input.sessionStatus,
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    activeSubagentCount: 0,
  };
};

describe("selectThreadsBoundToWorktree", () => {
  it.effect("matches a bound live session across path spellings", () =>
    Effect.gen(function* () {
      const threads = [
        makeThread({ id: "thread-exact", worktreePath: "/repo/wt", sessionStatus: "ready" }),
        makeThread({ id: "thread-slash", worktreePath: "/repo/wt/", sessionStatus: "running" }),
        makeThread({
          id: "thread-dots",
          worktreePath: "/repo/nested/../wt",
          sessionStatus: "starting",
        }),
        makeThread({ id: "thread-other", worktreePath: "/repo/other", sessionStatus: "ready" }),
      ];

      const bound = yield* selectThreadsBoundToWorktree(
        yield* FileSystem.FileSystem,
        yield* Path.Path,
        { worktreePath: "/repo/wt", threads, projects: [makeProject("/repo")] },
      );

      assert.deepEqual(bound, [
        ThreadId.make("thread-exact"),
        ThreadId.make("thread-slash"),
        ThreadId.make("thread-dots"),
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("matches a symlinked worktree path against the directory it points at", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-worktree-bound-" });
      const real = path.join(base, "real");
      const link = path.join(base, "link");
      yield* fileSystem.makeDirectory(real);
      yield* fileSystem.symlink(real, link);

      const threads = [
        makeThread({ id: "thread-linked", worktreePath: link, sessionStatus: "ready" }),
        makeThread({
          id: "thread-sibling",
          worktreePath: path.join(base, "sibling"),
          sessionStatus: "ready",
        }),
      ];

      const bound = yield* selectThreadsBoundToWorktree(fileSystem, path, {
        worktreePath: real,
        threads,
        projects: [makeProject(base)],
      });

      assert.deepEqual(bound, [ThreadId.make("thread-linked")]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores threads without a session and threads already stopped", () =>
    Effect.gen(function* () {
      const threads = [
        makeThread({ id: "thread-none", worktreePath: "/repo/wt", sessionStatus: null }),
        makeThread({ id: "thread-stopped", worktreePath: "/repo/wt", sessionStatus: "stopped" }),
      ];

      const bound = yield* selectThreadsBoundToWorktree(
        yield* FileSystem.FileSystem,
        yield* Path.Path,
        { worktreePath: "/repo/wt", threads, projects: [makeProject("/repo")] },
      );

      assert.deepEqual(bound, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to the project workspace root when a thread has no worktree", () =>
    Effect.gen(function* () {
      const threads = [
        makeThread({ id: "thread-root", worktreePath: null, sessionStatus: "ready" }),
      ];

      const bound = yield* selectThreadsBoundToWorktree(
        yield* FileSystem.FileSystem,
        yield* Path.Path,
        { worktreePath: "/repo", threads, projects: [makeProject("/repo")] },
      );

      assert.deepEqual(bound, [ThreadId.make("thread-root")]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("skips a worktree-less thread whose project is missing", () =>
    Effect.gen(function* () {
      const threads = [
        makeThread({ id: "thread-orphan", worktreePath: null, sessionStatus: "ready" }),
      ];

      const bound = yield* selectThreadsBoundToWorktree(
        yield* FileSystem.FileSystem,
        yield* Path.Path,
        { worktreePath: "/repo", threads, projects: [] },
      );

      assert.deepEqual(bound, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
