import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  HarnessHomeOverlayPathConflictError,
  HarnessHomeOverlayPrivateEntrySymlinkError,
  type HarnessHomeManifest,
  materializeHarnessHomeOverlay,
  resolveHarnessHomeLayout,
} from "./harnessHomeOverlay.ts";

export function describeHarnessHomeOverlayConformance(input: {
  readonly name: string;
  readonly manifest: HarnessHomeManifest;
  readonly defaultHomePath: string;
  readonly sampleSharedFile: string;
}): void {
  it.layer(NodeServices.layer)(input.name, (it) => {
    it.effect("keeps shared state and credentials separate", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHomePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "shared-" });
        const shadowRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "shadow-" });
        const shadowHomePath = path.join(shadowRoot, "account");
        const otherShadowHomePath = path.join(shadowRoot, "other-account");
        const sharedFilePath = path.join(sharedHomePath, input.sampleSharedFile);
        const sharedEntry = input.manifest.sharedEntries[0];
        const privateEntry = input.manifest.privateEntries[0];
        const credentialEntry = input.manifest.credentialEntries[0];
        const localEntry = input.manifest.shadowLocalEntries[0];
        const runtimeEntry = input.manifest.replaceableRuntimeDirs[0];

        expect(sharedEntry).toBeDefined();
        expect(privateEntry).toBeDefined();
        expect(credentialEntry).toBeDefined();
        expect(localEntry).toBeDefined();
        expect(runtimeEntry).toBeDefined();
        yield* fileSystem.writeFileString(sharedFilePath, "shared");
        yield* fileSystem.makeDirectory(path.join(sharedHomePath, sharedEntry!), {
          recursive: true,
        });
        yield* fileSystem.makeDirectory(path.join(sharedHomePath, localEntry!), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(sharedHomePath, privateEntry!),
          "shared-private",
        );
        yield* fileSystem.makeDirectory(path.join(sharedHomePath, runtimeEntry!), {
          recursive: true,
        });
        yield* fileSystem.makeDirectory(shadowHomePath, { recursive: true });
        yield* fileSystem.writeFileString(path.join(shadowHomePath, credentialEntry!), "account");
        yield* fileSystem.makeDirectory(path.join(shadowHomePath, localEntry!), {
          recursive: true,
        });
        yield* fileSystem.symlink(
          path.join(sharedHomePath, privateEntry!),
          path.join(shadowHomePath, privateEntry!),
        );
        yield* fileSystem.makeDirectory(path.join(shadowHomePath, runtimeEntry!), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(shadowHomePath, `${credentialEntry!}.link`),
          "link",
        );

        const direct = yield* resolveHarnessHomeLayout(input.manifest, {
          homePath: "",
          shadowHomePath: "",
          defaultHomePath: input.defaultHomePath,
        });
        const directExplicit = yield* resolveHarnessHomeLayout(input.manifest, {
          homePath: sharedHomePath,
          shadowHomePath: "",
          defaultHomePath: input.defaultHomePath,
        });
        const overlay = yield* resolveHarnessHomeLayout(input.manifest, {
          homePath: sharedHomePath,
          shadowHomePath,
          defaultHomePath: input.defaultHomePath,
        });
        const otherOverlay = yield* resolveHarnessHomeLayout(input.manifest, {
          homePath: sharedHomePath,
          shadowHomePath: otherShadowHomePath,
          defaultHomePath: input.defaultHomePath,
        });

        expect(direct).toMatchObject({ mode: "direct", effectiveHomePath: undefined });
        expect(directExplicit.effectiveHomePath).toBe(sharedHomePath);
        expect(overlay.continuationKey).toBe(
          `${input.manifest.continuationKeyPrefix}${sharedHomePath}`,
        );
        expect(overlay.continuationKey).toBe(directExplicit.continuationKey);
        expect(otherOverlay.continuationKey).toBe(overlay.continuationKey);
        yield* materializeHarnessHomeOverlay(input.manifest, overlay);

        for (const entryName of input.manifest.sharedEntries) {
          expect(yield* fileSystem.readLink(path.join(shadowHomePath, entryName))).toBe(
            path.join(sharedHomePath, entryName),
          );
        }
        expect(yield* fileSystem.readLink(path.join(shadowHomePath, input.sampleSharedFile))).toBe(
          sharedFilePath,
        );
        expect(yield* fileSystem.readFileString(path.join(shadowHomePath, credentialEntry!))).toBe(
          "account",
        );
        expect(
          yield* fileSystem.readLink(path.join(shadowHomePath, privateEntry!)).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        expect(yield* fileSystem.exists(path.join(shadowHomePath, privateEntry!))).toBe(false);
        expect(
          yield* fileSystem.readLink(path.join(shadowHomePath, localEntry!)).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        expect(yield* fileSystem.readLink(path.join(shadowHomePath, runtimeEntry!))).toBe(
          path.join(sharedHomePath, runtimeEntry!),
        );

        const credentialLinkPath = path.join(shadowHomePath, credentialEntry!);
        yield* fileSystem.remove(credentialLinkPath);
        yield* fileSystem.symlink(sharedFilePath, credentialLinkPath);
        const credentialError = yield* materializeHarnessHomeOverlay(input.manifest, overlay).pipe(
          Effect.flip,
        );
        expect(credentialError).toBeInstanceOf(HarnessHomeOverlayPrivateEntrySymlinkError);

        const conflict = yield* materializeHarnessHomeOverlay(input.manifest, {
          ...overlay,
          effectiveHomePath: sharedHomePath,
        }).pipe(Effect.flip);
        expect(conflict).toBeInstanceOf(HarnessHomeOverlayPathConflictError);
      }),
    );
  });
}
