// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

export interface RepoWithWorktree {
  readonly root: string;
  readonly mainRoot: string;
  readonly worktreeRoot: string;
  readonly worktreeBranch: string;
  readonly initialHead: string;
}

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
  }).trim();

const realPath = (path: string): Promise<string> => NodeFSP.realpath(path);

export const makeRepoWithWorktree = Effect.acquireRelease(
  Effect.promise(async (): Promise<RepoWithWorktree> => {
    const root = await realPath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-git-worktree-")),
    );
    const mainRoot = NodePath.join(root, "repo");
    const worktreeRoot = NodePath.join(root, "worktree");
    const worktreeBranch = "fixture-worktree";

    await NodeFSP.mkdir(mainRoot);
    git(mainRoot, ["init", "-q", "-b", "main"]);
    git(mainRoot, ["config", "user.name", "T3 Code fixture"]);
    git(mainRoot, ["config", "user.email", "fixture@example.invalid"]);
    await NodeFSP.writeFile(NodePath.join(mainRoot, "base.txt"), "base\n");
    git(mainRoot, ["add", "base.txt"]);
    git(mainRoot, ["commit", "-qm", "base"]);
    await NodeFSP.mkdir(NodePath.join(mainRoot, ".beads"));
    git(mainRoot, ["worktree", "add", "-q", worktreeRoot, "-b", worktreeBranch]);

    return {
      root,
      mainRoot: await realPath(mainRoot),
      worktreeRoot: await realPath(worktreeRoot),
      worktreeBranch,
      initialHead: git(mainRoot, ["rev-parse", "HEAD"]),
    };
  }),
  ({ root }) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);
