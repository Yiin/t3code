/**
 * worktreeBoundSessions - Find the threads whose live provider session runs
 * inside a worktree.
 *
 * A provider session is started with its thread's worktree as the subprocess
 * cwd (`ProviderCommandReactor` resolves it through `resolveThreadWorkspaceCwd`
 * and the binding persists it), so a resident session pins the directory.
 * Anything that removes a worktree has to stop those sessions first, and the
 * only way to know which ones they are is to match each thread's effective
 * workspace cwd against the removal target.
 *
 * @module worktreeBoundSessions
 */
import type {
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { isSameDirectory } from "../workspace/directoryPaths.ts";

/**
 * The threads that hold a session worth stopping before `worktreePath` is
 * removed.
 *
 * A thread qualifies when it has a session that is not already stopped **and**
 * its effective workspace cwd is the target directory. Threads without a live
 * session are filtered out first, so a large thread list costs no `realPath`
 * calls for sessions that are already gone.
 */
export function selectThreadsBoundToWorktree(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly worktreePath: string;
    readonly threads: ReadonlyArray<OrchestrationThreadShell>;
    readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  },
): Effect.Effect<ReadonlyArray<ThreadId>> {
  const liveThreads = input.threads.filter(
    (thread) => thread.session !== null && thread.session.status !== "stopped",
  );
  if (liveThreads.length === 0) {
    return Effect.succeed([]);
  }

  return Effect.forEach(
    liveThreads,
    (thread) => {
      const effectiveCwd = resolveThreadWorkspaceCwd({
        thread: { projectId: thread.projectId, worktreePath: thread.worktreePath },
        projects: input.projects,
      });
      if (effectiveCwd === undefined) {
        return Effect.succeed(null);
      }
      return isSameDirectory(fileSystem, path, effectiveCwd, input.worktreePath).pipe(
        Effect.map((matches) => (matches ? thread.id : null)),
      );
    },
    { concurrency: "unbounded" },
  ).pipe(Effect.map((ids) => ids.filter((id): id is ThreadId => id !== null)));
}
