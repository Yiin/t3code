import * as NodeOS from "node:os";

import { ProviderDriverKind, type KimiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";
import {
  harnessContinuationIdentity,
  materializeHarnessHomeOverlay,
  resolveHarnessHomeLayout,
  type HarnessHomeLayout,
  type HarnessHomeManifest,
} from "./harnessHomeOverlay.ts";

const DEFAULT_KIMI_HOME_NAME = ".kimi-code";

export const KIMI_HOME_MANIFEST: HarnessHomeManifest = {
  driverKind: ProviderDriverKind.make("kimi"),
  label: "Kimi",
  continuationKeyPrefix: "kimi:home:",
  sharedEntries: [
    "sessions",
    "search-index",
    "user-history",
    "workspace-trust",
    "cron",
    "cache",
    "logs",
    "updates",
    "bin",
  ],
  sharedFileEntries: [
    "session_index.jsonl",
    "workspaces.json",
    "config.toml",
    "tui.toml",
    "AGENTS.md",
    "migrations-effort.json",
  ],
  privateEntries: ["credentials", "oauth", "device_id", "telemetry"],
  credentialEntries: ["credentials", "oauth", "device_id", "telemetry"],
  shadowLocalEntries: [],
  replaceableRuntimeDirs: [],
};

export type KimiHomeLayout = HarnessHomeLayout;

export const resolveKimiHomeLayout = Effect.fn("resolveKimiHomeLayout")(function* (
  config: Pick<KimiSettings, "homePath"> & { readonly shadowHomePath?: string },
): Effect.fn.Return<KimiHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  return yield* resolveHarnessHomeLayout(KIMI_HOME_MANIFEST, {
    homePath: config.homePath,
    shadowHomePath: config.shadowHomePath ?? "",
    defaultHomePath: path.join(NodeOS.homedir(), DEFAULT_KIMI_HOME_NAME),
  });
});

export const materializeKimiShadowHome = Effect.fn("materializeKimiShadowHome")(function* (
  layout: KimiHomeLayout,
) {
  if (layout.mode === "authOverlay" && layout.effectiveHomePath) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* Effect.forEach(
      ["credentials", "oauth", "telemetry"],
      (entry) =>
        fileSystem.makeDirectory(path.join(layout.effectiveHomePath!, entry), { recursive: true }),
      { discard: true },
    );
  }
  yield* materializeHarnessHomeOverlay(KIMI_HOME_MANIFEST, layout);
});

export const resolveKimiHomePath = Effect.fn("resolveKimiHomePath")(function* (
  config: Pick<KimiSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(
    homePath.length > 0
      ? expandHomePath(homePath)
      : path.join(NodeOS.homedir(), DEFAULT_KIMI_HOME_NAME),
  );
});

export const makeKimiEnvironment = Effect.fn("makeKimiEnvironment")(function* (
  config: Pick<KimiSettings, "homePath"> & { readonly shadowHomePath?: string },
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const layout = yield* resolveKimiHomeLayout(config);
  if (layout.effectiveHomePath === undefined) return resolvedBaseEnv;
  return { ...resolvedBaseEnv, KIMI_CODE_HOME: layout.effectiveHomePath };
});

export const makeKimiContinuationGroupKey = Effect.fn("makeKimiContinuationGroupKey")(function* (
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const configuredHome = environment.KIMI_CODE_HOME?.trim();
  const resolvedHome = path.resolve(
    configuredHome
      ? expandHomePath(configuredHome)
      : path.join(NodeOS.homedir(), DEFAULT_KIMI_HOME_NAME),
  );
  return `kimi:home:${resolvedHome}`;
});

export function kimiContinuationIdentity(layout: KimiHomeLayout) {
  return harnessContinuationIdentity(KIMI_HOME_MANIFEST, layout);
}
