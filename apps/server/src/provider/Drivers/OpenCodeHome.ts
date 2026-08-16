import * as NodeOS from "node:os";

import { ProviderDriverKind, type OpenCodeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";
import { resolveHarnessHomeLayout } from "./harnessHomeOverlay.ts";

const DEFAULT_OPENCODE_DATA_HOME_SEGMENTS = [".local", "share"] as const;

export const resolveOpenCodeDataHome = Effect.fn("resolveOpenCodeDataHome")(function* (
  config: Pick<OpenCodeSettings, "dataHomePath">,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const dataHomePath = config.dataHomePath.trim();
  const environmentDataHome = environment.XDG_DATA_HOME?.trim();
  const environmentHome = environment.HOME?.trim();
  return path.resolve(
    dataHomePath.length > 0
      ? expandHomePath(dataHomePath)
      : environmentDataHome
        ? expandHomePath(environmentDataHome)
        : path.join(
            environmentHome ? expandHomePath(environmentHome) : NodeOS.homedir(),
            ...DEFAULT_OPENCODE_DATA_HOME_SEGMENTS,
          ),
  );
});

export interface OpenCodeHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedDataHomePath: string;
  readonly effectiveDataHomePath: string;
  readonly sharedDatabasePath: string;
  readonly continuationKey: string;
}

const OPEN_CODE_HOME_MANIFEST = {
  driverKind: ProviderDriverKind.make("opencode"),
  label: "OpenCode",
  continuationKeyPrefix: "opencode:data-home:",
  sharedEntries: [],
  privateEntries: [],
  credentialEntries: ["opencode"],
  shadowLocalEntries: [],
  replaceableRuntimeDirs: [],
};

export const resolveOpenCodeHomeLayout = Effect.fn("resolveOpenCodeHomeLayout")(function* (
  config: Pick<OpenCodeSettings, "dataHomePath"> &
    Partial<Pick<OpenCodeSettings, "sharedDataHomePath" | "serverUrl">>,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<OpenCodeHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const effectiveDataHomePath = yield* resolveOpenCodeDataHome(config, environment);
  const shared = config.sharedDataHomePath?.trim() ?? "";
  const layout = yield* resolveHarnessHomeLayout(OPEN_CODE_HOME_MANIFEST, {
    homePath: shared,
    shadowHomePath: shared.length > 0 ? effectiveDataHomePath : "",
    defaultHomePath: effectiveDataHomePath,
  });
  return {
    mode: shared.length > 0 ? "authOverlay" : "direct",
    sharedDataHomePath: layout.sharedHomePath,
    effectiveDataHomePath,
    sharedDatabasePath: path.join(layout.sharedHomePath, "opencode", "opencode.db"),
    continuationKey: layout.continuationKey,
  };
});

export const makeOpenCodeEnvironment = Effect.fn("makeOpenCodeEnvironment")(function* (
  config: Pick<OpenCodeSettings, "dataHomePath"> &
    Partial<Pick<OpenCodeSettings, "sharedDataHomePath" | "serverUrl">>,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  if (config.serverUrl?.trim()) {
    if (config.dataHomePath.trim().length === 0) return resolvedBaseEnv;
    return {
      ...resolvedBaseEnv,
      XDG_DATA_HOME: yield* resolveOpenCodeDataHome(config, resolvedBaseEnv),
    };
  }
  if (
    config.dataHomePath.trim().length === 0 &&
    (config.sharedDataHomePath?.trim() ?? "").length === 0
  )
    return resolvedBaseEnv;
  const environment = {
    ...resolvedBaseEnv,
    XDG_DATA_HOME: yield* resolveOpenCodeDataHome(config, resolvedBaseEnv),
  };
  const layout = yield* resolveOpenCodeHomeLayout(config, environment);
  return layout.mode === "direct"
    ? environment
    : { ...environment, OPENCODE_DB: layout.sharedDatabasePath };
});

export const openCodeAuthFilePath = Effect.fn("openCodeAuthFilePath")(function* (
  config: Pick<OpenCodeSettings, "dataHomePath"> &
    Partial<Pick<OpenCodeSettings, "sharedDataHomePath">>,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  return path.join(yield* resolveOpenCodeDataHome(config, environment), "opencode", "auth.json");
});

function normalizeExternalServerUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  try {
    return new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

export const makeOpenCodeContinuationGroupKey = Effect.fn("makeOpenCodeContinuationGroupKey")(
  function* (
    config: Pick<OpenCodeSettings, "dataHomePath" | "serverUrl"> &
      Partial<Pick<OpenCodeSettings, "sharedDataHomePath">>,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<string, never, Path.Path> {
    if (config.serverUrl.trim().length > 0) {
      return `opencode:server:${normalizeExternalServerUrl(config.serverUrl)}`;
    }

    return (yield* resolveOpenCodeHomeLayout(config, environment)).continuationKey;
  },
);
