import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ProviderDriverKind } from "@t3tools/contracts";
import {
  HarnessHomeOverlayEntryConflictError,
  HarnessHomeOverlayPathConflictError,
  HarnessHomeOverlayPrivateEntrySymlinkError,
  harnessContinuationIdentity,
  materializeHarnessHomeOverlay,
  resolveHarnessHomeLayout,
  type HarnessHomeManifest,
} from "./harnessHomeOverlay.ts";

const manifest: HarnessHomeManifest = {
  driverKind: ProviderDriverKind.make("codex"),
  label: "Test",
  continuationKeyPrefix: "test:home:",
  sharedEntries: ["sessions", "shared-dir"],
  sharedFileEntries: ["index.jsonl"],
  privateEntries: ["private.json"],
  credentialEntries: ["credential.json"],
  shadowLocalEntries: ["local-dir"],
  replaceableRuntimeDirs: ["replaceable"],
};

const temp = Effect.fn("harnessHomeOverlay.test.temp")(function* (prefix: string) {
  return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix });
});
const write = Effect.fn("harnessHomeOverlay.test.write")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, "test");
});
const setup = Effect.fn("harnessHomeOverlay.test.setup")(function* () {
  const path = yield* Path.Path;
  const shared = yield* temp("harness-shared-");
  const root = yield* temp("harness-shadow-");
  const shadow = path.join(root, "shadow");
  yield* (yield* FileSystem.FileSystem).makeDirectory(shadow, { recursive: true });
  return { shared, shadow };
});

it.layer(NodeServices.layer)("harnessHomeOverlay", (it) => {
  describe("resolveHarnessHomeLayout", () => {
    it.effect("uses direct mode with an undefined effective home", () =>
      Effect.gen(function* () {
        const layout = yield* resolveHarnessHomeLayout(manifest, {
          homePath: "",
          shadowHomePath: "",
          defaultHomePath: "/default",
        });
        expect(layout).toMatchObject({
          mode: "direct",
          effectiveHomePath: undefined,
          sharedHomePath: "/default",
          continuationKey: "test:home:/default",
        });
      }),
    );
    it.effect("uses a configured direct home", () =>
      Effect.gen(function* () {
        const home = yield* temp("direct-");
        expect(
          yield* resolveHarnessHomeLayout(manifest, {
            homePath: home,
            shadowHomePath: "",
            defaultHomePath: "/default",
          }),
        ).toMatchObject({ mode: "direct", effectiveHomePath: home, sharedHomePath: home });
      }),
    );
    it.effect("uses the shared home in overlay identities", () =>
      Effect.gen(function* () {
        const { shared, shadow } = yield* setup();
        const layout = yield* resolveHarnessHomeLayout(manifest, {
          homePath: shared,
          shadowHomePath: shadow,
          defaultHomePath: "/default",
        });
        expect(harnessContinuationIdentity(manifest, layout)).toEqual({
          driverKind: manifest.driverKind,
          continuationKey: `test:home:${shared}`,
        });
      }),
    );
  });

  describe("materializeHarnessHomeOverlay", () => {
    it.effect("links declared and discovered shared entries", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { shared, shadow } = yield* setup();
        yield* write(path.join(shared, "private.json"));
        yield* write(path.join(shared, "discovered.txt"));
        const layout = yield* resolveHarnessHomeLayout(manifest, {
          homePath: shared,
          shadowHomePath: shadow,
          defaultHomePath: "/default",
        });
        yield* materializeHarnessHomeOverlay(manifest, layout);
        expect(yield* fs.readLink(path.join(shadow, "sessions"))).toBe(
          path.join(shared, "sessions"),
        );
        expect(yield* fs.readLink(path.join(shadow, "discovered.txt"))).toBe(
          path.join(shared, "discovered.txt"),
        );
      }),
    );
    it.effect("removes stale private symlinks", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { shared, shadow } = yield* setup();
        yield* write(path.join(shared, "private.json"));
        yield* fs.symlink(path.join(shared, "private.json"), path.join(shadow, "private.json"));
        const layout = yield* resolveHarnessHomeLayout(manifest, {
          homePath: shared,
          shadowHomePath: shadow,
          defaultHomePath: "/default",
        });
        yield* materializeHarnessHomeOverlay(manifest, layout);
        expect(yield* fs.exists(path.join(shadow, "private.json"))).toBe(false);
      }),
    );
    it.effect("rejects credential symlinks", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { shared, shadow } = yield* setup();
        yield* write(path.join(shared, "credential.json"));
        yield* fs.symlink(
          path.join(shared, "credential.json"),
          path.join(shadow, "credential.json"),
        );
        const layout = yield* resolveHarnessHomeLayout(manifest, {
          homePath: shared,
          shadowHomePath: shadow,
          defaultHomePath: "/default",
        });
        const error = yield* materializeHarnessHomeOverlay(manifest, layout).pipe(Effect.flip);
        expect(error).toBeInstanceOf(HarnessHomeOverlayPrivateEntrySymlinkError);
      }),
    );
    it.effect("accepts real credential files", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { shared, shadow } = yield* setup();
        yield* write(path.join(shadow, "credential.json"));
        const layout = yield* resolveHarnessHomeLayout(manifest, {
          homePath: shared,
          shadowHomePath: shadow,
          defaultHomePath: "/default",
        });
        yield* materializeHarnessHomeOverlay(manifest, layout);
      }),
    );
    it.effect("leaves shadow-local directories real", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { shared, shadow } = yield* setup();
        yield* fs.makeDirectory(path.join(shadow, "local-dir"), { recursive: true });
        const layout = yield* resolveHarnessHomeLayout(manifest, {
          homePath: shared,
          shadowHomePath: shadow,
          defaultHomePath: "/default",
        });
        yield* materializeHarnessHomeOverlay(manifest, layout);
        expect(yield* fs.exists(path.join(shadow, "local-dir"))).toBe(true);
      }),
    );
    it.effect("replaces replaceable runtime directories", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { shared, shadow } = yield* setup();
        yield* fs.makeDirectory(path.join(shadow, "replaceable"), { recursive: true });
        const layout = yield* resolveHarnessHomeLayout(manifest, {
          homePath: shared,
          shadowHomePath: shadow,
          defaultHomePath: "/default",
        });
        yield* materializeHarnessHomeOverlay(
          { ...manifest, sharedEntries: [...manifest.sharedEntries, "replaceable"] },
          layout,
        );
        expect(yield* fs.readLink(path.join(shadow, "replaceable"))).toBe(
          path.join(shared, "replaceable"),
        );
      }),
    );
    it.effect("rejects non-replaceable files", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { shared, shadow } = yield* setup();
        yield* write(path.join(shadow, "sessions"));
        const layout = yield* resolveHarnessHomeLayout(manifest, {
          homePath: shared,
          shadowHomePath: shadow,
          defaultHomePath: "/default",
        });
        const error = yield* materializeHarnessHomeOverlay(manifest, layout).pipe(Effect.flip);
        expect(error).toBeInstanceOf(HarnessHomeOverlayEntryConflictError);
      }),
    );
    it.effect("rejects equal shared and shadow paths", () =>
      Effect.gen(function* () {
        const shared = yield* temp("same-");
        const layout = yield* resolveHarnessHomeLayout(manifest, {
          homePath: shared,
          shadowHomePath: shared,
          defaultHomePath: "/default",
        });
        const error = yield* materializeHarnessHomeOverlay(manifest, layout).pipe(Effect.flip);
        expect(error).toBeInstanceOf(HarnessHomeOverlayPathConflictError);
      }),
    );
    it.effect("keeps a correct relative symlink", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { shared, shadow } = yield* setup();
        yield* fs.makeDirectory(path.join(shared, "sessions"));
        yield* fs.symlink(
          path.relative(shadow, path.join(shared, "sessions")),
          path.join(shadow, "sessions"),
        );
        const layout = yield* resolveHarnessHomeLayout(manifest, {
          homePath: shared,
          shadowHomePath: shadow,
          defaultHomePath: "/default",
        });
        yield* materializeHarnessHomeOverlay(manifest, layout);
        expect(yield* fs.readLink(path.join(shadow, "sessions"))).toBe(
          path.relative(shadow, path.join(shared, "sessions")),
        );
      }),
    );
    it.effect("relinks a wrong symlink", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { shared, shadow } = yield* setup();
        const wrong = yield* temp("wrong-");
        yield* fs.makeDirectory(path.join(shared, "sessions"));
        yield* fs.symlink(wrong, path.join(shadow, "sessions"));
        const layout = yield* resolveHarnessHomeLayout(manifest, {
          homePath: shared,
          shadowHomePath: shadow,
          defaultHomePath: "/default",
        });
        yield* materializeHarnessHomeOverlay(manifest, layout);
        expect(yield* fs.readLink(path.join(shadow, "sessions"))).toBe(
          path.join(shared, "sessions"),
        );
      }),
    );
    it.effect("creates missing shared directories", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { shared, shadow } = yield* setup();
        const layout = yield* resolveHarnessHomeLayout(manifest, {
          homePath: shared,
          shadowHomePath: shadow,
          defaultHomePath: "/default",
        });
        yield* materializeHarnessHomeOverlay(manifest, layout);
        expect(yield* fs.exists(path.join(shared, "shared-dir"))).toBe(true);
      }),
    );
  });
});
