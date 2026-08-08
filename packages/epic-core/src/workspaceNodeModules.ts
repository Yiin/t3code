import * as Effect from "effect/Effect";

/**
 * Worktree dependency mirroring for workspace monorepos.
 *
 * `setup_worktree_assets` symlinks the source repo's root `node_modules` into a
 * fresh worktree. That is enough for a single-package repo, but not for a
 * workspace one. Under pnpm the root `node_modules` holds only the root
 * package's own dependencies plus the `.pnpm` store; everything each workspace
 * package actually imports lives in that package's own `node_modules`, as
 * symlinks into the store. Those per-package directories are gitignored, so a
 * fresh worktree has none of them and any build, typecheck, or test run there
 * fails to resolve its dependencies.
 *
 * Mirroring the per-package directories as symlinks is enough to fix it. Each
 * one contains relative links back into the store (`../../../node_modules/.pnpm/...`),
 * and those resolve against the link's *target* directory in the source repo,
 * so they keep pointing at the same store.
 */

export const NODE_MODULES = "node_modules";

/**
 * How far below the repo root to look for workspace packages. Depth 3 covers
 * the usual `apps/<name>`, `packages/<name>`, and top-level `<name>` layouts
 * without walking the whole tree.
 */
export const WORKSPACE_SCAN_MAX_DEPTH = 3;

/**
 * Directories never worth descending into: `node_modules` itself (its contents
 * are dependencies, not workspace packages) and anything dot-prefixed (`.git`,
 * `.vite-plus`, caches).
 */
export const isScannableDirectory = (name: string): boolean =>
  name !== NODE_MODULES && !name.startsWith(".");

/**
 * Find every per-package `node_modules` directory in `sourceRepo`, as paths
 * relative to the repo root (for example `apps/web/node_modules`).
 *
 * The root `node_modules` is excluded — callers already link that one.
 *
 * Generic over the effect's error and context so both the Effect-platform
 * filesystem (server) and a promise-wrapped `node:fs` (terminal) can drive it.
 * `listDirectories` returns the subdirectory names of one absolute path.
 */
export const findWorkspaceNodeModules = <E, R>(
  listDirectories: (absolutePath: string) => Effect.Effect<ReadonlyArray<string>, E, R>,
  sourceRepo: string,
  join: (...segments: ReadonlyArray<string>) => string,
  maxDepth: number = WORKSPACE_SCAN_MAX_DEPTH,
): Effect.Effect<ReadonlyArray<string>, E, R> => {
  const walk = (relativeDir: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<string>, E, R> =>
    Effect.gen(function* () {
      // A node_modules directory sits one level below the package that owns it,
      // so there is nothing to find at the very bottom of the budget.
      if (relativeDir.length >= maxDepth) return [];

      const absolute = relativeDir.length === 0 ? sourceRepo : join(sourceRepo, ...relativeDir);
      const entries = yield* listDirectories(absolute);

      const found: Array<string> = [];
      for (const entry of entries) {
        if (entry === NODE_MODULES) {
          // Skip the root one; callers link it themselves.
          if (relativeDir.length > 0) found.push(join(...relativeDir, NODE_MODULES));
          continue;
        }
        if (!isScannableDirectory(entry)) continue;
        found.push(...(yield* walk([...relativeDir, entry])));
      }
      return found;
    });

  return walk([]);
};
