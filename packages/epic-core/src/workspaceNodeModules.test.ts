import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  findWorkspaceNodeModules,
  isScannableDirectory,
  WORKSPACE_SCAN_MAX_DEPTH,
} from "./workspaceNodeModules.ts";

const ROOT = "/repo";

/** Posix join is enough here; the walk never sees a Windows path in tests. */
const join = (...segments: ReadonlyArray<string>): string => segments.join("/");

/**
 * Drive the walk from a plain map of directory -> subdirectory names, so the
 * tests describe tree shapes rather than filesystem fixtures.
 */
const readerFor = (tree: Record<string, ReadonlyArray<string>>) => {
  const reads: Array<string> = [];
  const listDirectories = (absolutePath: string) =>
    Effect.sync(() => {
      reads.push(absolutePath);
      return tree[absolutePath] ?? [];
    });
  return { listDirectories, reads };
};

const find = (tree: Record<string, ReadonlyArray<string>>, maxDepth?: number) => {
  const { listDirectories, reads } = readerFor(tree);
  return findWorkspaceNodeModules(listDirectories, ROOT, join, maxDepth).pipe(
    Effect.map((found) => ({ found, reads })),
  );
};

describe("isScannableDirectory", () => {
  it("skips node_modules and dot directories", () => {
    expect(isScannableDirectory("apps")).toBe(true);
    expect(isScannableDirectory("node_modules")).toBe(false);
    expect(isScannableDirectory(".git")).toBe(false);
    expect(isScannableDirectory(".vite-plus")).toBe(false);
  });
});

describe("findWorkspaceNodeModules", () => {
  it.effect("finds per-package node_modules at several depths", () =>
    Effect.gen(function* () {
      const { found } = yield* find({
        "/repo": ["apps", "packages", "scripts", "node_modules", ".git"],
        "/repo/apps": ["web", "server"],
        "/repo/apps/web": ["node_modules", "src"],
        "/repo/apps/server": ["node_modules", "src"],
        "/repo/packages": ["shared"],
        "/repo/packages/shared": ["node_modules"],
        "/repo/scripts": ["node_modules"],
      });

      expect([...found].sort()).toStrictEqual([
        "apps/server/node_modules",
        "apps/web/node_modules",
        "packages/shared/node_modules",
        "scripts/node_modules",
      ]);
    }),
  );

  it.effect("excludes the root node_modules, which callers link themselves", () =>
    Effect.gen(function* () {
      const { found } = yield* find({
        "/repo": ["node_modules"],
      });

      expect(found).toStrictEqual([]);
    }),
  );

  it.effect("never descends into node_modules or dot directories", () =>
    Effect.gen(function* () {
      const { reads } = yield* find({
        "/repo": ["node_modules", ".git", "apps"],
        "/repo/apps": [],
      });

      expect(reads).toStrictEqual(["/repo", "/repo/apps"]);
    }),
  );

  it.effect("stops at the depth budget", () =>
    Effect.gen(function* () {
      const deep = {
        "/repo": ["a"],
        "/repo/a": ["b"],
        "/repo/a/b": ["c"],
        "/repo/a/b/c": ["node_modules"],
      };

      // a/b/c/node_modules sits at depth 4, past the default budget.
      const { found } = yield* find(deep);
      expect(found).toStrictEqual([]);

      const { found: deeper } = yield* find(deep, 4);
      expect(deeper).toStrictEqual(["a/b/c/node_modules"]);
    }),
  );

  it.effect("returns nothing for a repo with no workspace packages", () =>
    Effect.gen(function* () {
      const { found } = yield* find({
        "/repo": ["src", "node_modules"],
        "/repo/src": ["index.ts"],
      });

      expect(found).toStrictEqual([]);
    }),
  );

  it.effect("propagates a read failure instead of silently linking nothing", () =>
    Effect.gen(function* () {
      const boom = new Error("EACCES");
      const caught = yield* findWorkspaceNodeModules(() => Effect.fail(boom), ROOT, join).pipe(
        Effect.flip,
      );

      expect(caught).toBe(boom);
    }),
  );

  it("keeps the default depth budget at 3", () => {
    expect(WORKSPACE_SCAN_MAX_DEPTH).toBe(3);
  });
});
