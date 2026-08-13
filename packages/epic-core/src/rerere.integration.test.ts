// @effect-diagnostics nodeBuiltinImport:off
/**
 * Does a resolution recorded in one worktree really come back in another?
 *
 * The whole point of rerere here is cross-worktree replay: a merge-fix child
 * resolves a conflict in ITS worktree, and the next drain's trial merge — a
 * different worktree of the same repository — gets that resolution for free.
 * Nothing but real git can answer whether that holds, because it turns on two
 * facts no fake reproduces: the rr-cache lives in the shared common git
 * directory, and `git merge` still exits non-zero after rerere stages a full
 * resolution.
 */
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeProcessMergeGit } from "./adapters/ProcessMergeGit.ts";
import * as ProcessRunner from "./processRunner.ts";
import { RERERE_CONFIG_ARGS } from "./rerere.ts";

const git = (cwd: string, args: ReadonlyArray<string>): string => {
  const result = NodeChildProcess.spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
};

const write = (cwd: string, contents: string): void => {
  NodeFS.writeFileSync(NodePath.join(cwd, "conflicted.txt"), contents);
};

const read = (cwd: string): string =>
  NodeFS.readFileSync(NodePath.join(cwd, "conflicted.txt"), "utf8");

const BASE = "one\nBASE\nthree\n";
const CHILD = "one\nCHILD\nthree\n";
const RESOLVED = "one\nBASE and CHILD\nthree\n";

/**
 * A repository whose base branch and `epic/child-1` conflict on one hunk, with
 * `rerere` enabled exactly the way provisioning enables it, plus two
 * integration worktrees that both want to merge the child.
 */
const makeFixture = (configured = true) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-rerere-"));
  const repo = NodePath.join(root, "repo");
  NodeFS.mkdirSync(repo, { recursive: true });
  git(root, ["init", "-q", "-b", "trunk", repo]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  if (configured) for (const args of RERERE_CONFIG_ARGS) git(repo, args);

  write(repo, "one\ntwo\nthree\n");
  git(repo, ["add", "conflicted.txt"]);
  git(repo, ["commit", "-q", "-m", "initial"]);

  git(repo, ["checkout", "-q", "-b", "epic/child-1"]);
  write(repo, CHILD);
  git(repo, ["commit", "-q", "-am", "child work"]);
  git(repo, ["checkout", "-q", "trunk"]);

  // Two independent base branches carrying the SAME conflicting change, so the
  // second merge presents git with a preimage identical to the first.
  const worktrees: Array<string> = [];
  for (const name of ["first", "second"]) {
    const worktree = NodePath.join(root, name);
    git(repo, ["branch", `base/${name}`, "trunk"]);
    git(repo, ["worktree", "add", "-q", worktree, `base/${name}`]);
    write(worktree, BASE);
    git(worktree, ["commit", "-q", "-am", `base work in ${name}`]);
    worktrees.push(worktree);
  }
  return { root, repo, first: worktrees[0]!, second: worktrees[1]! };
};

const withFixture = <A, E, R>(
  configured: boolean,
  use: (fixture: ReturnType<typeof makeFixture>) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireRelease(
    Effect.sync(() => makeFixture(configured)),
    (fixture) => Effect.sync(() => NodeFS.rmSync(fixture.root, { recursive: true, force: true })),
  ).pipe(Effect.flatMap(use), Effect.scoped);

const layer = Layer.provide(ProcessRunner.layer, NodeServices.layer);

// Configured is what provisioning leaves behind; unconfigured is the drift the
// trial merge's own `-c` flags exist to survive. Both must replay.
for (const configured of [true, false]) {
  it.effect(
    `replays a resolution across worktrees and lands it (repository config ${
      configured ? "set" : "unset"
    })`,
    () =>
      withFixture(configured, (fixture) =>
        Effect.gen(function* () {
          const mergeGit = yield* Effect.map(ProcessRunner.ProcessRunner, (processRunner) =>
            makeProcessMergeGit({ processRunner }),
          );

          // A merge-fix child's repair: the first worktree conflicts, a human or
          // an agent resolves it by hand and commits. rerere records it.
          const first = yield* mergeGit.trialMerge({
            cwd: fixture.first,
            branch: "epic/child-1",
            message: "Merge epic/child-1",
          });
          expect(first.merged).toBe(false);
          expect(read(fixture.first)).toContain("<<<<<<<");
          write(fixture.first, RESOLVED);
          git(fixture.first, ["add", "conflicted.txt"]);
          git(fixture.first, ["commit", "-q", "-m", "Merge epic/child-1"]);

          // The next drain, in a different worktree of the same repository.
          const second = yield* mergeGit.trialMerge({
            cwd: fixture.second,
            branch: "epic/child-1",
            message: "Merge epic/child-1 into base/second",
          });

          expect(second.merged).toBe(true);
          expect(read(fixture.second)).toBe(RESOLVED);
          // A real merge commit, not a fast-forward or a half-finished merge.
          expect(git(fixture.second, ["log", "-1", "--format=%P"]).split(" ")).toHaveLength(2);
          // The subject is what `landedSubjects` parses, so `--cleanup=strip`
          // has to have dropped git's `# Conflicts:` block.
          expect(git(fixture.second, ["log", "-1", "--format=%B"])).toBe(
            "Merge epic/child-1 into base/second",
          );
          expect(git(fixture.second, ["status", "--porcelain"])).toBe("");
        }),
      ).pipe(Effect.provide(layer)),
  );
}

it.effect("still parks a conflict rerere has never seen", () =>
  withFixture(true, (fixture) =>
    Effect.gen(function* () {
      const mergeGit = yield* Effect.map(ProcessRunner.ProcessRunner, (processRunner) =>
        makeProcessMergeGit({ processRunner }),
      );

      const trial = yield* mergeGit.trialMerge({
        cwd: fixture.second,
        branch: "epic/child-1",
        message: "Merge epic/child-1 into base/second",
      });

      expect(trial.merged).toBe(false);
      expect(trial.output).toContain("conflict");
      // Left mid-merge for `conflictDetail` to read, exactly as before rerere.
      const detail = yield* mergeGit.conflictDetail({
        cwd: fixture.second,
        maxOutputBytes: 64 * 1024,
      });
      expect(detail?.files).toEqual(["conflicted.txt"]);
    }),
  ).pipe(Effect.provide(layer)),
);
