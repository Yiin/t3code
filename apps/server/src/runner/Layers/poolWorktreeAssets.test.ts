import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveBeadsDirectory, setupWorktreeAssets } from "./poolWorktreeAssets.ts";

const withTempDirectory = <A, E, R>(
  use: (root: string, fileSystem: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pool-assets-test-" });
    return yield* use(root, fileSystem, path);
  });

const testLayer = NodeServices.layer;

describe("pool worktree assets", () => {
  it.effect("resolves a nested relative beads redirect", () =>
    withTempDirectory((root, fileSystem, path) =>
      Effect.gen(function* () {
        const beads = path.join(root, ".beads");
        const target = path.join(root, "shared", "beads");
        yield* fileSystem.makeDirectory(beads, { recursive: true });
        yield* fileSystem.makeDirectory(target, { recursive: true });
        yield* fileSystem.writeFileString(path.join(beads, "redirect"), "shared/beads\n");

        const resolved = yield* resolveBeadsDirectory({ fileSystem, path })(root);
        assert.strictEqual(resolved, target);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("resolves an absolute beads redirect", () =>
    withTempDirectory((root, fileSystem, path) =>
      Effect.scoped(
        Effect.gen(function* () {
          const beads = path.join(root, ".beads");
          const targetRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pool-beads-" });
          yield* fileSystem.makeDirectory(beads, { recursive: true });
          yield* fileSystem.writeFileString(path.join(beads, "redirect"), `${targetRoot}\n`);

          const resolved = yield* resolveBeadsDirectory({ fileSystem, path })(root);
          assert.strictEqual(resolved, targetRoot);
        }),
      ),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("falls back to the worktree beads directory when redirect is missing", () =>
    withTempDirectory((root, fileSystem, path) =>
      Effect.gen(function* () {
        const resolved = yield* resolveBeadsDirectory({ fileSystem, path })(root);
        assert.strictEqual(resolved, path.join(root, ".beads"));
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("stops materialising the dependency tree at its depth budget", () =>
    withTempDirectory((root, fileSystem, path) =>
      Effect.gen(function* () {
        const source = path.join(root, "source");
        const target = path.join(root, "target");
        const deep = path.join(source, "node_modules", ".pnpm", "package");
        yield* fileSystem.makeDirectory(deep, { recursive: true });
        yield* fileSystem.writeFileString(path.join(deep, "package.json"), "{}");

        yield* setupWorktreeAssets({ fileSystem, path }, source, target);

        const copiedPackage = path.join(target, "node_modules", ".pnpm", "package");
        assert.strictEqual(
          yield* fileSystem.readLink(copiedPackage),
          path.join(source, "node_modules", ".pnpm", "package"),
        );
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
