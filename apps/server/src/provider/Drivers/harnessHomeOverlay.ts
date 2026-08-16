import { type ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";

import { expandHomePath } from "../../pathExpansion.ts";

/** Entry names are single path segments. Drivers declare a top-level parent for nested paths. */
export interface HarnessHomeManifest {
  readonly driverKind: ProviderDriverKind;
  readonly label: string;
  readonly continuationKeyPrefix: string;
  readonly sharedEntries: readonly string[];
  readonly privateEntries: readonly string[];
  readonly credentialEntries: readonly string[];
  readonly shadowLocalEntries: readonly string[];
  readonly replaceableRuntimeDirs: readonly string[];
}

export interface HarnessHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

const Context = {
  sharedHomePath: Schema.String,
  effectiveHomePath: Schema.String,
  label: Schema.String,
};

export class HarnessHomeOverlayFileSystemError extends Schema.TaggedErrorClass<HarnessHomeOverlayFileSystemError>()(
  "HarnessHomeOverlayFileSystemError",
  {
    ...Context,
    operation: Schema.Literals(["readLink", "makeDirectory", "readDirectory", "remove", "symlink"]),
    path: Schema.String,
    targetPath: Schema.optional(Schema.String),
    entryName: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `${this.label} shadow home filesystem operation '${this.operation}' failed for '${this.path}'${this.targetPath === undefined ? "" : ` to '${this.targetPath}'`}.`;
  }
}

export class HarnessHomeOverlayPathConflictError extends Schema.TaggedErrorClass<HarnessHomeOverlayPathConflictError>()(
  "HarnessHomeOverlayPathConflictError",
  Context,
) {
  override get message() {
    return `${this.label} shadow home path '${this.effectiveHomePath}' must be different from the shared home path '${this.sharedHomePath}'.`;
  }
}

export class HarnessHomeOverlayEntryConflictError extends Schema.TaggedErrorClass<HarnessHomeOverlayEntryConflictError>()(
  "HarnessHomeOverlayEntryConflictError",
  { ...Context, entryName: Schema.String, linkPath: Schema.String, targetPath: Schema.String },
) {
  override get message() {
    return `Cannot create ${this.label} shadow home entry '${this.entryName}' because '${this.linkPath}' already exists and is not a symlink.`;
  }
}

export class HarnessHomeOverlayPrivateEntrySymlinkError extends Schema.TaggedErrorClass<HarnessHomeOverlayPrivateEntrySymlinkError>()(
  "HarnessHomeOverlayPrivateEntrySymlinkError",
  { ...Context, entryName: Schema.String, path: Schema.String },
) {
  override get message() {
    return `${this.label} shadow home private entry '${this.entryName}' at '${this.path}' must be a real file, not a symlink.`;
  }
}

export const HarnessHomeOverlayError = Schema.Union([
  HarnessHomeOverlayFileSystemError,
  HarnessHomeOverlayPathConflictError,
  HarnessHomeOverlayEntryConflictError,
  HarnessHomeOverlayPrivateEntrySymlinkError,
]);
export type HarnessHomeOverlayError = typeof HarnessHomeOverlayError.Type;

function resolveHomePath(path: Path.Path, value: string, defaultHomePath: string) {
  return path.resolve(value.trim().length > 0 ? expandHomePath(value) : defaultHomePath);
}

export const resolveHarnessHomeLayout = Effect.fn("resolveHarnessHomeLayout")(function* (
  manifest: HarnessHomeManifest,
  input: {
    readonly homePath: string;
    readonly shadowHomePath: string;
    readonly defaultHomePath: string;
  },
): Effect.fn.Return<HarnessHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const sharedHomePath = resolveHomePath(path, input.homePath, input.defaultHomePath);
  if (input.shadowHomePath.trim().length === 0) {
    return {
      mode: "direct",
      sharedHomePath,
      effectiveHomePath: input.homePath.trim().length > 0 ? sharedHomePath : undefined,
      continuationKey: `${manifest.continuationKeyPrefix}${sharedHomePath}`,
    };
  }
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath: path.resolve(expandHomePath(input.shadowHomePath)),
    continuationKey: `${manifest.continuationKeyPrefix}${sharedHomePath}`,
  };
});

type LinkState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "NotSymlink" }
  | { readonly _tag: "Symlink"; readonly target: string };
type ActiveLayout = HarnessHomeLayout & {
  readonly effectiveHomePath: string;
  readonly label: string;
};
function isNotSymlinkError(error: PlatformError.PlatformError) {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

const readLinkState = Effect.fn("HarnessHomeOverlay.readLinkState")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly layout: ActiveLayout;
  readonly entryName: string;
  readonly linkPath: string;
}): Effect.fn.Return<LinkState, HarnessHomeOverlayError> {
  return yield* input.fileSystem.readLink(input.linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (cause.reason._tag === "NotFound") return Effect.succeed<LinkState>({ _tag: "Missing" });
        if (isNotSymlinkError(cause)) return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
        return new HarnessHomeOverlayFileSystemError({
          ...input.layout,
          operation: "readLink",
          path: input.linkPath,
          entryName: input.entryName,
          cause,
        });
      },
    }),
  );
});

const removeEntry = Effect.fn("HarnessHomeOverlay.removeEntry")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly layout: ActiveLayout;
  readonly entryName: string;
  readonly recursive?: boolean;
}): Effect.fn.Return<void, HarnessHomeOverlayError, Path.Path> {
  const path = yield* Path.Path;
  const targetPath = path.join(input.layout.effectiveHomePath!, input.entryName);
  const state = yield* readLinkState({ ...input, linkPath: targetPath });
  if (state._tag !== "Symlink") return;
  yield* input.fileSystem
    .remove(targetPath, input.recursive ? { recursive: true } : undefined)
    .pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new HarnessHomeOverlayFileSystemError({
            ...input.layout,
            operation: "remove",
            path: targetPath,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
});

const ensureSymlink = Effect.fn("HarnessHomeOverlay.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly layout: ActiveLayout;
  readonly entryName: string;
  readonly replaceable: boolean;
}): Effect.fn.Return<void, HarnessHomeOverlayError, Path.Path> {
  const path = yield* Path.Path;
  const targetPath = path.join(input.layout.sharedHomePath, input.entryName);
  const linkPath = path.join(input.layout.effectiveHomePath!, input.entryName);
  const state = yield* readLinkState({ ...input, linkPath });
  const create = input.fileSystem.symlink(targetPath, linkPath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new HarnessHomeOverlayFileSystemError({
          ...input.layout,
          operation: "symlink",
          path: linkPath,
          targetPath,
          entryName: input.entryName,
          cause,
        }),
    }),
  );
  if (state._tag === "NotSymlink") {
    if (!input.replaceable)
      return yield* new HarnessHomeOverlayEntryConflictError({
        ...input.layout,
        entryName: input.entryName,
        linkPath,
        targetPath,
      });
    yield* input.fileSystem.remove(linkPath, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new HarnessHomeOverlayFileSystemError({
            ...input.layout,
            operation: "remove",
            path: linkPath,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
    return yield* create;
  }
  if (state._tag === "Missing") return yield* create;
  if (path.resolve(path.dirname(linkPath), state.target) !== targetPath) {
    yield* removeEntry({ ...input, entryName: input.entryName });
    yield* create;
  }
});

export const materializeHarnessHomeOverlay = Effect.fn("materializeHarnessHomeOverlay")(function* (
  manifest: HarnessHomeManifest,
  layout: HarnessHomeLayout,
): Effect.fn.Return<void, HarnessHomeOverlayError, FileSystem.FileSystem | Path.Path> {
  if (layout.mode !== "authOverlay" || !layout.effectiveHomePath) return;
  const activeLayout = { ...layout, label: manifest.label } as ActiveLayout;
  if (activeLayout.sharedHomePath === activeLayout.effectiveHomePath)
    return yield* new HarnessHomeOverlayPathConflictError(activeLayout);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const makeDirectory = (directoryPath: string) =>
    fileSystem.makeDirectory(directoryPath, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new HarnessHomeOverlayFileSystemError({
            ...activeLayout,
            operation: "makeDirectory",
            path: directoryPath,
            cause,
          }),
      }),
    );
  yield* Effect.all(
    [
      makeDirectory(activeLayout.sharedHomePath),
      makeDirectory(activeLayout.effectiveHomePath),
      ...manifest.sharedEntries.map((entry) =>
        makeDirectory(path.join(activeLayout.sharedHomePath, entry)),
      ),
    ],
    { concurrency: "unbounded" },
  );
  const sharedEntries = yield* fileSystem.readDirectory(activeLayout.sharedHomePath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new HarnessHomeOverlayFileSystemError({
          ...activeLayout,
          operation: "readDirectory",
          path: activeLayout.sharedHomePath,
          cause,
        }),
    }),
  );
  const privateEntries = new Set(manifest.privateEntries);
  const credentialEntries = new Set(manifest.credentialEntries);
  const localEntries = new Set(manifest.shadowLocalEntries);
  const entries = new Set([
    ...manifest.sharedEntries,
    ...sharedEntries.filter(
      (entry) =>
        !privateEntries.has(entry) && !credentialEntries.has(entry) && !localEntries.has(entry),
    ),
  ]);
  for (const entryName of manifest.privateEntries.filter(
    (entry) => !manifest.credentialEntries.includes(entry),
  ))
    yield* removeEntry({ fileSystem, layout: activeLayout, entryName });
  for (const entryName of entries)
    yield* ensureSymlink({
      fileSystem,
      layout: activeLayout,
      entryName,
      replaceable: manifest.replaceableRuntimeDirs.includes(entryName),
    });
  for (const entryName of manifest.credentialEntries) {
    const entryPath = path.join(activeLayout.effectiveHomePath, entryName);
    const state = yield* readLinkState({
      fileSystem,
      layout: activeLayout,
      entryName,
      linkPath: entryPath,
    });
    if (state._tag === "Symlink")
      return yield* new HarnessHomeOverlayPrivateEntrySymlinkError({
        ...activeLayout,
        entryName,
        path: entryPath,
      });
  }
});

export function harnessContinuationIdentity(
  manifest: HarnessHomeManifest,
  layout: HarnessHomeLayout,
) {
  return { driverKind: manifest.driverKind, continuationKey: layout.continuationKey };
}
