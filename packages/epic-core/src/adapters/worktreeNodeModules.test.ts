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
  it("provides node_modules for the root and every workspace package", async () => {
    const packages = ["apps/web", "packages/shared", "scripts"];
    const { root, source, target } = await scaffold(packages);

    await linkNodeModulesTree(source, target);

    // The root is a plain directory link into the source checkout.
    expect(await linkedPaths(target)).toStrictEqual(["node_modules"]);
    // Each package gets a real directory instead, so the links inside it
    // resolve against the worktree rather than the source.
    for (const dir of packages) {
      const stat = await NodeFSP.lstat(NodePath.join(target, dir, "node_modules"));
      expect(stat.isDirectory()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
    }
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

  it("resolves a workspace sibling to the worktree's copy, not the source's", async () => {
    // Regression (t3code-b93.18): pnpm records workspace deps as repo-relative
    // links. Linking the package's node_modules directory made them resolve
    // against the source checkout, so a worktree typechecked the source copy
    // of its own siblings instead of the branch under test.
    const { root, source, target } = await scaffold(["packages/app", "packages/lib"]);
    await NodeFSP.mkdir(NodePath.join(source, "packages/app/node_modules/@scope"), {
      recursive: true,
    });
    await NodeFSP.symlink(
      "../../../lib",
      NodePath.join(source, "packages/app/node_modules/@scope/lib"),
    );
    await NodeFSP.writeFile(NodePath.join(source, "packages/lib/marker.txt"), "source");
    await NodeFSP.mkdir(NodePath.join(target, "packages/lib"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(target, "packages/lib/marker.txt"), "branch");

    await linkNodeModulesTree(source, target);

    const seen = await NodeFSP.readFile(
      NodePath.join(target, "packages/app/node_modules/@scope/lib/marker.txt"),
      "utf8",
    );
    expect(seen).toBe("branch");
    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("still reaches the shared store through the root node_modules link", async () => {
    const { root, source, target } = await scaffold(["packages/app"]);
    await NodeFSP.mkdir(NodePath.join(source, "node_modules/.pnpm/dep/node_modules/dep"), {
      recursive: true,
    });
    await NodeFSP.writeFile(
      NodePath.join(source, "node_modules/.pnpm/dep/node_modules/dep/index.js"),
      "module.exports = 1;\n",
    );
    await NodeFSP.symlink(
      "../../../node_modules/.pnpm/dep/node_modules/dep",
      NodePath.join(source, "packages/app/node_modules/dep"),
    );

    await linkNodeModulesTree(source, target);

    const resolved = await NodeFSP.readFile(
      NodePath.join(target, "packages/app/node_modules/dep/index.js"),
      "utf8",
    );
    expect(resolved).toBe("module.exports = 1;\n");
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
