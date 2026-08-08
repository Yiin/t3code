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
const replicateLinkTree = async (source: string, targetDir: string): Promise<void> => {
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
      await replicateLinkTree(from, to);
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

  // The root node_modules holds no workspace links — only the .pnpm store and
  // the root package's own dependencies — so a directory link is right there.
  const rootSource = NodePath.join(sourceRepo, NODE_MODULES);
  const rootLink = NodePath.join(target, NODE_MODULES);
  if ((await pathExists(rootSource)) && !(await pathExists(rootLink))) {
    await NodeFSP.symlink(rootSource, rootLink, "dir");
  }

  for (const relative of await walk([])) {
    const source = NodePath.join(sourceRepo, relative);
    const targetDir = NodePath.join(target, relative);
    if (!(await pathExists(source))) continue;
    // The owning package directory has to exist in this worktree.
    if (!(await pathExists(NodePath.dirname(targetDir)))) continue;
    if (await pathExists(targetDir)) continue;
    await replicateLinkTree(source, targetDir);
  }
};
