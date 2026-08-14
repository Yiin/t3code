import * as NodeOS from "node:os";

import type { OpenCodeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

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

/**
 * XDG_DATA_HOME also moves opencode.db, snapshot, and repos. Separate account
 * data homes therefore have separate OpenCode session history.
 */
export const makeOpenCodeEnvironment = Effect.fn("makeOpenCodeEnvironment")(function* (
  config: Pick<OpenCodeSettings, "dataHomePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  if (config.dataHomePath.trim().length === 0) return resolvedBaseEnv;

  return {
    ...resolvedBaseEnv,
    XDG_DATA_HOME: yield* resolveOpenCodeDataHome(config, resolvedBaseEnv),
  };
});

export const openCodeAuthFilePath = Effect.fn("openCodeAuthFilePath")(function* (
  config: Pick<OpenCodeSettings, "dataHomePath">,
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
    config: Pick<OpenCodeSettings, "dataHomePath" | "serverUrl">,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<string, never, Path.Path> {
    if (config.serverUrl.trim().length > 0) {
      return `opencode:server:${normalizeExternalServerUrl(config.serverUrl)}`;
    }

    const resolvedDataHome = yield* resolveOpenCodeDataHome(config, environment);
    return `opencode:data-home:${resolvedDataHome}`;
  },
);
