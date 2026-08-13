// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ProcessRunner,
  layer as processRunnerLayer,
  type ProcessRunInput,
  type ProcessRunOutput,
} from "../processRunner.ts";
import { makeProcessPoolVcs } from "./ProcessPoolVcs.ts";

const output = (stdout: string, code = 0): ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code as ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

/**
 * A runner that answers per git subcommand; `null` means the command fails.
 * An answer may carry its own exit code, for the probes that read one.
 */
const runner = (
  answers: Record<string, string | null | { readonly stdout: string; readonly code: number }>,
  calls: ProcessRunInput[] = [],
) =>
  ProcessRunner.of({
    run: (command) =>
      Effect.suspend(() => {
        calls.push(command);
        const key = command.args.join(" ");
        const answer = answers[key];
        if (answer === undefined || answer === null) {
          return Effect.die(new Error(`git ${key} failed`));
        }
        return typeof answer === "string"
          ? Effect.succeed(output(answer))
          : Effect.succeed(output(answer.stdout, answer.code));
      }),
  });

describe("ProcessPoolVcs.worktreeEvidence", () => {
  it.effect("bounds each probe and marks what it cut", () =>
    Effect.gen(function* () {
      const vcs = makeProcessPoolVcs(
        runner({
          "status --porcelain=v1": " M src/a.ts\n",
          "diff --stat": `${"x".repeat(20_000)}\n`,
        }),
      );

      const evidence = yield* vcs.worktreeEvidence("/wt/child");

      expect(evidence).not.toBeNull();
      expect(evidence).toContain(" M src/a.ts");
      expect(evidence).toContain("… (truncated)");
      // Two 4000-character ceilings plus the framing, never the raw 20000.
      expect((evidence ?? "").length).toBeLessThan(9_000);
    }),
  );

  it.effect("reports a clean tree rather than nothing", () =>
    Effect.gen(function* () {
      const vcs = makeProcessPoolVcs(runner({ "status --porcelain=v1": "", "diff --stat": "" }));

      const evidence = yield* vcs.worktreeEvidence("/wt/child");

      expect(evidence).not.toBeNull();
      expect(evidence).toContain("(nothing)");
      expect(evidence).not.toContain("(unavailable)");
    }),
  );

  it.effect("keeps the probe that worked when the other fails", () =>
    Effect.gen(function* () {
      const vcs = makeProcessPoolVcs(
        runner({ "status --porcelain=v1": " M src/a.ts\n", "diff --stat": null }),
      );

      const evidence = yield* vcs.worktreeEvidence("/wt/child");

      expect(evidence).toContain(" M src/a.ts");
      expect(evidence).toContain("(unavailable)");
    }),
  );

  it.effect("returns null when git tells it nothing at all", () =>
    Effect.gen(function* () {
      const calls: ProcessRunInput[] = [];
      const vcs = makeProcessPoolVcs(runner({}, calls));

      expect(yield* vcs.worktreeEvidence("/wt/child")).toBeNull();
      // Both probes are still attempted, and neither is allowed to fail the resume.
      expect(calls.map((call) => call.args.join(" "))).toEqual([
        "status --porcelain=v1",
        "diff --stat",
      ]);
      expect(calls.every((call) => call.cwd === "/wt/child")).toBe(true);
    }),
  );
});

/** Real `git merge-tree --write-tree` output, tree OID and messages included. */
const MERGE_TREE_CONFLICT = [
  "cd78a500aeb73e8cbcd594cb373cc7ae6cb17d28",
  "100644 4cb29ea38f70d7c61b2a3a25b02e3bdf44905402 1\tpackages/epic-core/src/MergeQueue.ts",
  "100644 59cb04ec4650390a3e0e5eb12eb2fd8f09f2d534 2\tpackages/epic-core/src/MergeQueue.ts",
  "100644 d5a3379494aeeba6327035831cdbd9c1aa8522bf 3\tpackages/epic-core/src/MergeQueue.ts",
  "100644 f70f10e4db19068f79bc43844b49f3eece45c4e8 2\tdocs/epic-runs.md",
  "100644 223b7836fb19fdf64ba2d3cd6173c6a283141f78 3\tdocs/epic-runs.md",
  "",
  "Auto-merging packages/epic-core/src/MergeQueue.ts",
  "CONFLICT (content): Merge conflict in packages/epic-core/src/MergeQueue.ts",
  "",
].join("\n");

const PROBE = "merge-tree --write-tree main epic/child";

describe("ProcessPoolVcs.mergeTreeConflicts", () => {
  it.effect("reads a clean merge as an empty list, touching no worktree", () =>
    Effect.gen(function* () {
      const calls: ProcessRunInput[] = [];
      const vcs = makeProcessPoolVcs(
        runner({ [PROBE]: "105796372a141d43505a42ced3650f9a02765842\n" }, calls),
      );

      expect(
        yield* vcs.mergeTreeConflicts({ cwd: "/repo", base: "main", branch: "epic/child" }),
      ).toEqual([]);
      // The whole argv, so the probe can never grow a worktree or index write.
      expect(calls.map((call) => call.args)).toEqual([
        ["merge-tree", "--write-tree", "main", "epic/child"],
      ]);
      expect(calls[0]?.cwd).toBe("/repo");
    }),
  );

  it.effect("names each conflicted path once, ignoring the message section", () =>
    Effect.gen(function* () {
      const vcs = makeProcessPoolVcs(runner({ [PROBE]: { stdout: MERGE_TREE_CONFLICT, code: 1 } }));

      const conflicts = yield* vcs.mergeTreeConflicts({
        cwd: "/repo",
        base: "main",
        branch: "epic/child",
      });

      // Three stages of one path collapse to one entry, in git's own order.
      expect(conflicts).toEqual(["packages/epic-core/src/MergeQueue.ts", "docs/epic-runs.md"]);
    }),
  );

  it.effect("returns null when git refuses the refs or the directory", () =>
    Effect.gen(function* () {
      const vcs = makeProcessPoolVcs(runner({ [PROBE]: { stdout: "", code: 128 } }));

      expect(
        yield* vcs.mergeTreeConflicts({ cwd: "/not-a-repo", base: "main", branch: "epic/child" }),
      ).toBeNull();
    }),
  );

  it.effect("returns null for a conflict git would not name", () =>
    Effect.gen(function* () {
      const vcs = makeProcessPoolVcs(
        runner({ [PROBE]: { stdout: "cd78a500aeb73e8cbcd594cb373cc7ae6cb17d28\n", code: 1 } }),
      );

      expect(
        yield* vcs.mergeTreeConflicts({ cwd: "/repo", base: "main", branch: "epic/child" }),
      ).toBeNull();
    }),
  );

  it.effect("never throws when the process itself dies", () =>
    Effect.gen(function* () {
      const vcs = makeProcessPoolVcs(runner({}));

      expect(
        yield* vcs.mergeTreeConflicts({ cwd: "/repo", base: "main", branch: "epic/child" }),
      ).toBeNull();
    }),
  );
});

const git = (args: ReadonlyArray<string>, cwd: string) =>
  new Promise<void>((resolve, reject) => {
    NodeChildProcess.execFile("git", [...args], { cwd }, (error) =>
      error ? reject(error) : resolve(),
    );
  });

/** A repo whose `epic/child` branch conflicts with `main` in one file. */
const makeConflictingRepo = async (): Promise<string> => {
  const repo = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pool-vcs-merge-tree-"));
  await git(["init", "-q", "-b", "main"], repo);
  await git(["config", "user.email", "runner@example.com"], repo);
  await git(["config", "user.name", "Runner"], repo);
  await NodeFSP.writeFile(NodePath.join(repo, "queue.ts"), "one\ntwo\nthree\n");
  await NodeFSP.writeFile(NodePath.join(repo, "docs.md"), "docs\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-qm", "base"], repo);
  await git(["checkout", "-qb", "epic/child"], repo);
  await NodeFSP.writeFile(NodePath.join(repo, "queue.ts"), "CHILD\ntwo\nthree\n");
  await git(["commit", "-qam", "child"], repo);
  await git(["checkout", "-qb", "epic/clean", "main"], repo);
  await NodeFSP.writeFile(NodePath.join(repo, "docs.md"), "docs, revised\n");
  await git(["commit", "-qam", "clean"], repo);
  await git(["checkout", "-q", "main"], repo);
  await NodeFSP.writeFile(NodePath.join(repo, "queue.ts"), "MAIN\ntwo\nthree\n");
  await git(["commit", "-qam", "main moves"], repo);
  return repo;
};

// Real git, because the parse is written against one exact output format and a
// fake that echoes it back cannot notice when git stops producing it.
describe("ProcessPoolVcs.mergeTreeConflicts against real git", () => {
  it.effect(
    "reports the conflicted file, and nothing for a branch that still merges",
    () =>
      Effect.gen(function* () {
        const repo = yield* Effect.promise(() => makeConflictingRepo());
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(repo, { recursive: true, force: true })),
        );
        const vcs = makeProcessPoolVcs(yield* ProcessRunner);

        expect(
          yield* vcs.mergeTreeConflicts({ cwd: repo, base: "main", branch: "epic/child" }),
        ).toEqual(["queue.ts"]);
        expect(
          yield* vcs.mergeTreeConflicts({ cwd: repo, base: "main", branch: "epic/clean" }),
        ).toEqual([]);
        expect(
          yield* vcs.mergeTreeConflicts({ cwd: repo, base: "main", branch: "epic/absent" }),
        ).toBeNull();
        // The probe left the checkout alone: no merge in progress, nothing staged.
        expect(yield* vcs.worktreeFingerprint(repo)).toBe("");
      }).pipe(
        Effect.scoped,
        Effect.provide(processRunnerLayer.pipe(Layer.provide(NodeServices.layer))),
      ),
    { timeout: 30_000 },
  );
});
