// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { makeRepoWithWorktree } from "./gitWorktreeFixture.ts";

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
  }).trim();

describe("makeRepoWithWorktree", () => {
  it.effect("creates a linked worktree with shared git metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeRepoWithWorktree;

        expect(fixture.root).toBe(NodePath.dirname(fixture.mainRoot));
        expect(git(fixture.mainRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
        expect(git(fixture.worktreeRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
          fixture.worktreeBranch,
        );
        expect(git(fixture.mainRoot, ["rev-parse", "HEAD"])).toBe(fixture.initialHead);
        expect(
          git(fixture.worktreeRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        ).toBe(NodePath.join(fixture.mainRoot, ".git"));
        expect(NodeFS.existsSync(NodePath.join(fixture.mainRoot, ".beads"))).toBe(true);
      }),
    ),
  );
});
