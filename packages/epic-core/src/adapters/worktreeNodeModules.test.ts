// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { linkNodeModulesTree } from "./worktreeNodeModules.ts";

/** Build a source repo and an empty worktree, and return both paths. */
const scaffold = async (packageDirs: ReadonlyArray<string>) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "worktree-nm-"));
  const source = NodePath.join(root, "source");
  const target = NodePath.join(root, "worktree");

  await NodeFSP.mkdir(NodePath.join(source, "node_modules"), { recursive: true });
  await NodeFSP.mkdir(target, { recursive: true });
  for (const dir of packageDirs) {
    await NodeFSP.mkdir(NodePath.join(source, dir, "node_modules"), { recursive: true });
    // The worktree has the package's tracked files but not its node_modules.
    await NodeFSP.mkdir(NodePath.join(target, dir), { recursive: true });
  }
  return { root, source, target };
};

const linkedPaths = async (target: string): Promise<ReadonlyArray<string>> => {
  const found: Array<string> = [];
  const walk = async (relative: ReadonlyArray<string>) => {
    const absolute = NodePath.join(target, ...relative);
    for (const entry of await NodeFSP.readdir(absolute, { withFileTypes: true })) {
      const next = [...relative, entry.name];
      if (entry.isSymbolicLink()) {
        found.push(next.join("/"));
        continue;
      }
      if (entry.isDirectory()) await walk(next);
    }
  };
  await walk([]);
  return found.sort();
};

describe("linkNodeModulesTree", () => {
  it("links the root and every workspace package node_modules", async () => {
    const { root, source, target } = await scaffold(["apps/web", "packages/shared", "scripts"]);

    await linkNodeModulesTree(source, target);

    expect(await linkedPaths(target)).toStrictEqual([
      "apps/web/node_modules",
      "node_modules",
      "packages/shared/node_modules",
      "scripts/node_modules",
    ]);
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("resolves a dependency through the linked package directory", async () => {
    const { root, source, target } = await scaffold(["apps/web"]);
    await NodeFSP.writeFile(
      NodePath.join(source, "apps/web/node_modules", "marker.txt"),
      "resolved",
    );

    await linkNodeModulesTree(source, target);

    const throughLink = await NodeFSP.readFile(
      NodePath.join(target, "apps/web/node_modules", "marker.txt"),
      "utf8",
    );
    expect(throughLink).toBe("resolved");
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("leaves an existing node_modules alone", async () => {
    const { root, source, target } = await scaffold(["apps/web"]);
    const existing = NodePath.join(target, "apps/web/node_modules");
    await NodeFSP.mkdir(existing, { recursive: true });

    await linkNodeModulesTree(source, target);

    expect((await NodeFSP.lstat(existing)).isSymbolicLink()).toBe(false);
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("skips a package the worktree does not have", async () => {
    const { root, source, target } = await scaffold(["apps/web"]);
    // Present in the source repo, absent from this branch's worktree.
    await NodeFSP.rm(NodePath.join(target, "apps/web"), { recursive: true, force: true });

    await linkNodeModulesTree(source, target);

    expect(await linkedPaths(target)).toStrictEqual(["node_modules"]);
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("does not fail when the source repo cannot be read", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "worktree-nm-"));
    const target = NodePath.join(root, "worktree");
    await NodeFSP.mkdir(target, { recursive: true });

    await linkNodeModulesTree(NodePath.join(root, "does-not-exist"), target);

    expect(await linkedPaths(target)).toStrictEqual([]);
    await NodeFSP.rm(root, { recursive: true, force: true });
  });
});
