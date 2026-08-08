// @effect-diagnostics nodeBuiltinImport:off
/**
 * The `node:fs` half of worktree dependency mirroring, for the terminal
 * adapters. The scanning rules it follows — and why a workspace monorepo needs
 * more than the root `node_modules` — live in `../workspaceNodeModules.ts`.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  isScannableDirectory,
  NODE_MODULES,
  WORKSPACE_SCAN_MAX_DEPTH,
} from "../workspaceNodeModules.ts";

/**
 * Materialise `node_modules/` and `node_modules/.pnpm/`, then link each store
 * package whole. Two levels is the least that keeps a worker's install off the
 * shared store; going deeper would mean replicating every file in it.
 */
const ROOT_NODE_MODULES_DEPTH = 2;

/** A package's own node_modules is shallow — scopes and `.bin` at most. */
const PACKAGE_NODE_MODULES_DEPTH = 4;

/**
 * Rebuild a package's `node_modules` as a tree of its own, copying every
 * symlink target verbatim.
 *
 * Linking the directory itself would be wrong: pnpm records workspace
 * dependencies as repo-relative links (`@t3tools/contracts -> ../../../contracts`),
 * and through a directory link those resolve against the SOURCE checkout, so
 * the worktree would typecheck the source copy of its own siblings instead of
 * the branch under test. Copied verbatim into a real directory, the same
 * relative target resolves inside the worktree, while store links
 * (`../../../node_modules/.pnpm/...`) still reach the shared store through the
 * root `node_modules` link.
 */
const replicateLinkTree = async (
  source: string,
  targetDir: string,
  depth: number,
): Promise<void> => {
  await NodeFSP.mkdir(targetDir, { recursive: true });
  const entries = await NodeFSP.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = NodePath.join(source, entry.name);
    const to = NodePath.join(targetDir, entry.name);
    if (await pathExists(to)) continue;
    if (entry.isSymbolicLink()) {
      await NodeFSP.symlink(await NodeFSP.readlink(from), to);
      continue;
    }
    if (entry.isDirectory()) {
      // Past the budget, link the directory whole. Materialising every level
      // of the pnpm store would mean hundreds of thousands of entries.
      if (depth <= 1) {
        await NodeFSP.symlink(from, to, "dir");
        continue;
      }
      await replicateLinkTree(from, to, depth - 1);
      continue;
    }
    await NodeFSP.symlink(from, to);
  }
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await NodeFSP.lstat(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Mirror the source repo's root `node_modules` and every workspace package's
 * `node_modules` into `target` as symlinks, skipping any that already exist.
 *
 * A directory read that fails (permissions, a race with a delete) is treated
 * as "nothing to link there" rather than failing the whole worktree: a missing
 * link surfaces later as a clear dependency-resolution error, while a hard
 * failure here would strand an otherwise usable worktree.
 */
export const linkNodeModulesTree = async (sourceRepo: string, target: string): Promise<void> => {
  const walk = async (relativeDir: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
    if (relativeDir.length >= WORKSPACE_SCAN_MAX_DEPTH) return [];
    const absolute =
      relativeDir.length === 0 ? sourceRepo : NodePath.join(sourceRepo, ...relativeDir);

    let entries: ReadonlyArray<string>;
    try {
      const dirents = await NodeFSP.readdir(absolute, { withFileTypes: true });
      entries = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }

    const found: Array<string> = [];
    for (const entry of entries) {
      if (entry === NODE_MODULES) {
        if (relativeDir.length > 0) found.push(NodePath.join(...relativeDir, NODE_MODULES));
        continue;
      }
      if (!isScannableDirectory(entry)) continue;
      found.push(...(await walk([...relativeDir, entry])));
    }
    return found;
  };

  // The root node_modules is materialised, not linked. Linking it made the
  // worktree share the source's dependency links, so `pnpm install` in a
  // worker wrote straight through and repointed the real checkout at a
  // temporary worktree; pruning that worktree then broke every other worker
  // and the gate with ERR_MODULE_NOT_FOUND. Materialised two levels deep, the
  // worktree owns node_modules/ and node_modules/.pnpm/, and an install or
  // prune there rewrites its own symlinks instead of the shared store.
  const rootSource = NodePath.join(sourceRepo, NODE_MODULES);
  const rootTarget = NodePath.join(target, NODE_MODULES);
  if ((await pathExists(rootSource)) && !(await pathExists(rootTarget))) {
    await replicateLinkTree(rootSource, rootTarget, ROOT_NODE_MODULES_DEPTH);
  }

  for (const relative of await walk([])) {
    const source = NodePath.join(sourceRepo, relative);
    const targetDir = NodePath.join(target, relative);
    if (!(await pathExists(source))) continue;
    // The owning package directory has to exist in this worktree.
    if (!(await pathExists(NodePath.dirname(targetDir)))) continue;
    if (await pathExists(targetDir)) continue;
    await replicateLinkTree(source, targetDir, PACKAGE_NODE_MODULES_DEPTH);
  }
};
