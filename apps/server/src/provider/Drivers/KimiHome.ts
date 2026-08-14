import * as NodeOS from "node:os";

import type { KimiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

const DEFAULT_KIMI_HOME_NAME = ".kimi-code";

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
  config: Pick<KimiSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  if (config.homePath.trim().length === 0) return resolvedBaseEnv;

  return {
    ...resolvedBaseEnv,
    // KIMI_CODE_HOME isolates Kimi credentials without moving other tools'
    // home directories or credential stores.
    KIMI_CODE_HOME: yield* resolveKimiHomePath(config),
  };
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
