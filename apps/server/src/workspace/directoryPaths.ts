/**
 * directoryPaths - Directory comparison that survives path spelling.
 *
 * @module directoryPaths
 */
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

/**
 * Whether two directory spellings name the same location.
 *
 * Raw string equality misreads a trailing slash, a `.`/`..` segment or a
 * symlinked parent (macOS `/tmp` → `/private/tmp`) as two different
 * directories. Lexically equal paths short-circuit; otherwise both sides go
 * through `realPath`, each falling back to its lexical form on failure (deleted
 * directory, external-server path) — so the probe can only widen matches, never
 * split them.
 *
 * Takes the services as arguments so callers can hold them once and keep the
 * comparison itself service-free.
 */
export function isSameDirectory(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  left: string,
  right: string,
): Effect.Effect<boolean> {
  const lexicalLeft = path.resolve(left);
  const lexicalRight = path.resolve(right);
  if (lexicalLeft === lexicalRight) {
    return Effect.succeed(true);
  }
  const canonicalize = (lexical: string) =>
    fileSystem.realPath(lexical).pipe(Effect.orElseSucceed(() => lexical));
  return Effect.zipWith(
    canonicalize(lexicalLeft),
    canonicalize(lexicalRight),
    (canonicalLeft, canonicalRight) => canonicalLeft === canonicalRight,
  );
}
