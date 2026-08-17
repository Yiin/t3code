import { findWorkspaceNodeModules, NODE_MODULES } from "@t3tools/epic-core/workspaceNodeModules";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

const ROOT_NODE_MODULES_DEPTH = 2;
const PACKAGE_NODE_MODULES_DEPTH = 4;

const WORKTREE_ASSET_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.test",
] as const;

export const setupWorktreeAssets = (
  deps: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  },
  sourceRepo: string,
  target: string,
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const replicateLinkTree = (
      source: string,
      targetDir: string,
      depth: number,
    ): Effect.Effect<void, PlatformError.PlatformError> =>
      Effect.gen(function* () {
        yield* deps.fileSystem.makeDirectory(targetDir, { recursive: true });
        const entries = yield* deps.fileSystem.readDirectory(source);
        for (const entry of entries) {
          const from = deps.path.join(source, entry);
          const to = deps.path.join(targetDir, entry);
          if (yield* deps.fileSystem.exists(to)) continue;
          const linkTarget = yield* deps.fileSystem
            .readLink(from)
            .pipe(Effect.catchCause(() => Effect.succeed(null)));
          if (linkTarget !== null) {
            yield* deps.fileSystem.symlink(linkTarget, to);
            continue;
          }
          const info = yield* deps.fileSystem.stat(from);
          if (info.type === "Directory") {
            if (depth <= 1) {
              yield* deps.fileSystem.symlink(from, to);
              continue;
            }
            yield* replicateLinkTree(from, to, depth - 1);
            continue;
          }
          yield* deps.fileSystem.symlink(from, to);
        }
      });

    const rootSource = deps.path.join(sourceRepo, NODE_MODULES);
    const rootTarget = deps.path.join(target, NODE_MODULES);
    if (
      (yield* deps.fileSystem.exists(rootSource)) &&
      !(yield* deps.fileSystem.exists(rootTarget))
    ) {
      yield* replicateLinkTree(rootSource, rootTarget, ROOT_NODE_MODULES_DEPTH);
    }

    const listDirectories = (absolutePath: string) =>
      Effect.gen(function* () {
        const entries = yield* deps.fileSystem.readDirectory(absolutePath);
        const directories: Array<string> = [];
        for (const entry of entries) {
          const info = yield* deps.fileSystem
            .stat(deps.path.join(absolutePath, entry))
            .pipe(Effect.catchCause(() => Effect.succeed(null)));
          if (info !== null && info.type === "Directory") directories.push(entry);
        }
        return directories;
      }).pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<string>>([])));

    const workspaceNodeModules = yield* findWorkspaceNodeModules(
      listDirectories,
      sourceRepo,
      (...segments) => deps.path.join(...segments),
    );
    for (const relative of workspaceNodeModules) {
      const source = deps.path.join(sourceRepo, relative);
      const targetDir = deps.path.join(target, relative);
      const targetParent = deps.path.dirname(targetDir);
      if (
        (yield* deps.fileSystem.exists(source)) &&
        (yield* deps.fileSystem.exists(targetParent)) &&
        !(yield* deps.fileSystem.exists(targetDir))
      ) {
        yield* replicateLinkTree(source, targetDir, PACKAGE_NODE_MODULES_DEPTH);
      }
    }

    for (const name of WORKTREE_ASSET_ENV_FILES) {
      const source = deps.path.join(sourceRepo, name);
      const targetFile = deps.path.join(target, name);
      if ((yield* deps.fileSystem.exists(source)) && !(yield* deps.fileSystem.exists(targetFile))) {
        yield* deps.fileSystem.copyFile(source, targetFile);
      }
    }
  });

export const resolveBeadsDirectory =
  (deps: { readonly fileSystem: FileSystem.FileSystem; readonly path: Path.Path }) =>
  (cwd: string) =>
    Effect.gen(function* () {
      const beadsDirectory = deps.path.join(cwd, ".beads");
      const canonicalBeads = yield* deps.fileSystem
        .realPath(beadsDirectory)
        .pipe(Effect.orElseSucceed(() => beadsDirectory));
      const redirect = yield* deps.fileSystem
        .readFileString(deps.path.join(canonicalBeads, "redirect"))
        .pipe(
          Effect.map((contents) => contents.trim()),
          Effect.orElseSucceed(() => ""),
        );
      const target =
        redirect.length === 0
          ? canonicalBeads
          : deps.path.isAbsolute(redirect)
            ? redirect
            : deps.path.resolve(cwd, redirect);
      return yield* deps.fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));
    });

export const writeBeadsRedirect =
  (deps: { readonly fileSystem: FileSystem.FileSystem; readonly path: Path.Path }) =>
  (runCwd: string, worktreeCwd: string) =>
    Effect.gen(function* () {
      const targetBeads = yield* resolveBeadsDirectory(deps)(runCwd);
      const worktreeBeads = deps.path.join(worktreeCwd, ".beads");
      yield* deps.fileSystem.makeDirectory(worktreeBeads, { recursive: true });
      yield* deps.fileSystem.writeFileString(
        deps.path.join(worktreeBeads, "redirect"),
        deps.path.relative(worktreeCwd, targetBeads),
      );
    });
