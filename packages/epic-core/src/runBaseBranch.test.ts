import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveRunBaseBranch, type ResolveBaseBranchGit } from "./runBaseBranch.ts";

class FakeGitError {
  readonly _tag = "FakeGitError";
  readonly detail: string;
  constructor(detail: string) {
    this.detail = detail;
  }
}

const makeGit = (options: {
  readonly branches?: ReadonlySet<string>;
  readonly currentBranch?: string;
  readonly createFails?: boolean;
  /** Simulate a concurrent creator winning the race: the branch appears once `createBranch` is called. */
  readonly raceWinner?: boolean;
}) => {
  const branches = new Set(options.branches ?? []);
  const calls: string[] = [];
  const git: ResolveBaseBranchGit<FakeGitError> = {
    currentBranch: (cwd) =>
      Effect.sync(() => {
        calls.push(`currentBranch:${cwd}`);
        return options.currentBranch ?? "mine";
      }),
    branchExists: (cwd, branch) =>
      Effect.sync(() => {
        calls.push(`branchExists:${cwd}:${branch}`);
        return branches.has(branch);
      }),
    createBranch: (cwd, branch, startPoint) =>
      Effect.gen(function* () {
        calls.push(`createBranch:${cwd}:${branch}:${startPoint}`);
        if (options.raceWinner === true) branches.add(branch);
        if (options.createFails === true) {
          return yield* Effect.fail(new FakeGitError("already exists"));
        }
        branches.add(branch);
      }),
  };
  return { git, calls, branches };
};

describe("resolveRunBaseBranch", () => {
  it.effect("reads the operator's current branch when the flag is off", () =>
    Effect.gen(function* () {
      const { git, calls } = makeGit({ currentBranch: "mine" });
      const branch = yield* resolveRunBaseBranch(git, {
        cwd: "/repo",
        epicId: "t3code-5m4",
        runOwnedBaseBranch: false,
      });
      expect(branch).toBe("mine");
      expect(calls).toEqual(["currentBranch:/repo"]);
    }),
  );

  it.effect("creates epic/<epicId>/base from the operator's branch on first use", () =>
    Effect.gen(function* () {
      const { git, calls, branches } = makeGit({ currentBranch: "mine" });
      const branch = yield* resolveRunBaseBranch(git, {
        cwd: "/repo",
        epicId: "t3code-5m4",
        runOwnedBaseBranch: true,
      });
      expect(branch).toBe("epic/t3code-5m4/base");
      expect(branches.has("epic/t3code-5m4/base")).toBe(true);
      expect(calls).toEqual([
        "branchExists:/repo:epic/t3code-5m4/base",
        "currentBranch:/repo",
        "createBranch:/repo:epic/t3code-5m4/base:mine",
      ]);
    }),
  );

  it.effect("reuses an existing run branch without reading or moving anything else", () =>
    Effect.gen(function* () {
      const { git, calls } = makeGit({
        branches: new Set(["epic/t3code-5m4/base"]),
        currentBranch: "mine",
      });
      const branch = yield* resolveRunBaseBranch(git, {
        cwd: "/repo",
        epicId: "t3code-5m4",
        runOwnedBaseBranch: true,
      });
      expect(branch).toBe("epic/t3code-5m4/base");
      // Only the existence check ran: no read of the operator's branch, no
      // create — a resumed run must never reset or force-update the branch it
      // finds.
      expect(calls).toEqual(["branchExists:/repo:epic/t3code-5m4/base"]);
    }),
  );

  it.effect("resolving twice against an existing branch never recreates or moves it", () =>
    Effect.gen(function* () {
      const { git, branches } = makeGit({ currentBranch: "mine" });
      const first = yield* resolveRunBaseBranch(git, {
        cwd: "/repo",
        epicId: "t3code-5m4",
        runOwnedBaseBranch: true,
      });
      const second = yield* resolveRunBaseBranch(git, {
        cwd: "/repo",
        epicId: "t3code-5m4",
        runOwnedBaseBranch: true,
      });
      expect(first).toBe(second);
      expect(branches.size).toBe(1);
    }),
  );

  it.effect("recovers when a concurrent caller wins the creation race", () =>
    Effect.gen(function* () {
      const { git } = makeGit({ currentBranch: "mine", createFails: true, raceWinner: true });
      const branch = yield* resolveRunBaseBranch(git, {
        cwd: "/repo",
        epicId: "t3code-5m4",
        runOwnedBaseBranch: true,
      });
      expect(branch).toBe("epic/t3code-5m4/base");
    }),
  );

  it.effect("propagates a create failure the branch's existence does not explain", () =>
    Effect.gen(function* () {
      const { git } = makeGit({ currentBranch: "mine", createFails: true });
      const result = yield* Effect.flip(
        resolveRunBaseBranch(git, {
          cwd: "/repo",
          epicId: "t3code-5m4",
          runOwnedBaseBranch: true,
        }),
      );
      expect(result).toBeInstanceOf(FakeGitError);
    }),
  );
});
