import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

export const makeReadOrientation = (deps: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) => {
  const { fileSystem, path } = deps;
  return (checkoutPath: string, orientationFile: string | null): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      const candidates =
        orientationFile === null ? ["docs/agent-orientation.md", "AGENTS.md"] : [orientationFile];
      for (const candidate of candidates) {
        const contents = yield* fileSystem
          .readFileString(path.join(checkoutPath, candidate))
          .pipe(Effect.option);
        if (Option.isSome(contents)) return contents.value;
      }
      return null;
    });
};
