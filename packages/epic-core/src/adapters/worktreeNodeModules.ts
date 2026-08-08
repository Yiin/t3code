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

  const relatives = [NODE_MODULES, ...(await walk([]))];

  for (const relative of relatives) {
    const source = NodePath.join(sourceRepo, relative);
    const link = NodePath.join(target, relative);
    if (!(await pathExists(source))) continue;
    // The owning package directory has to exist in this worktree.
    if (!(await pathExists(NodePath.dirname(link)))) continue;
    if (await pathExists(link)) continue;
    await NodeFSP.symlink(source, link, "dir");
  }
};
