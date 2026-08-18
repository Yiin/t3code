import * as NodeOS from "node:os";

import { ProviderDriverKind, type ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";
import {
  type HarnessHomeLayout,
  type HarnessHomeManifest,
  type HarnessHomeOverlayError,
  harnessContinuationIdentity,
  materializeHarnessHomeOverlay,
  resolveHarnessHomeLayout,
} from "./harnessHomeOverlay.ts";

export interface ClaudeHomeLayout extends HarnessHomeLayout {
  readonly sharedStatePath: string;
}

export const CLAUDE_HOME_MANIFEST: HarnessHomeManifest = {
  driverKind: ProviderDriverKind.make("claudeAgent"),
  label: "Claude",
  continuationKeyPrefix: "claude:home:",
  sharedEntries: [
    "projects",
    "session-env",
    "shell-snapshots",
    "todos",
    "statsig",
    "plugins",
    "file-history",
    "memory-backups",
    "cache",
    "downloads",
    "hooks",
    "jobs",
  ],
  privateEntries: [
    ".credentials.json",
    ".claude.json",
    "backups",
    "policy-limits.json",
    "remote-settings.json",
    "stats-cache.json",
  ],
  credentialEntries: [".credentials.json", ".claude.json"],
  shadowLocalEntries: [
    "sessions",
    ".last-cleanup",
    ".last-update-result.json",
    "daemon",
    "daemon.log",
    "debug",
    "paste-cache",
  ],
  replaceableRuntimeDirs: ["shell-snapshots", "session-env", "statsig"],
};

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export const resolveClaudeHomeLayout = Effect.fn("resolveClaudeHomeLayout")(function* (
  config: Pick<ClaudeSettings, "homePath" | "shadowHomePath">,
): Effect.fn.Return<ClaudeHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const sharedHomePath = yield* resolveClaudeHomePath(config);
  const sharedStatePath = path.resolve(
    config.homePath.trim().length > 0
      ? expandHomePath(config.homePath)
      : path.join(NodeOS.homedir(), ".claude"),
  );
  const layout = yield* resolveHarnessHomeLayout(CLAUDE_HOME_MANIFEST, {
    homePath: sharedStatePath,
    shadowHomePath: config.shadowHomePath,
    defaultHomePath: sharedStatePath,
  });
  return { ...layout, sharedHomePath, sharedStatePath };
});

export const materializeClaudeShadowHome = Effect.fn("materializeClaudeShadowHome")(function* (
  layout: ClaudeHomeLayout,
): Effect.fn.Return<void, HarnessHomeOverlayError, FileSystem.FileSystem | Path.Path> {
  if (layout.mode !== "authOverlay") return;
  yield* materializeHarnessHomeOverlay(CLAUDE_HOME_MANIFEST, {
    ...layout,
    sharedHomePath: layout.sharedStatePath,
  });
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (config: Pick<ClaudeSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `claude:home:${resolvedHomePath}`;
  },
);

export function claudeContinuationIdentity(layout: ClaudeHomeLayout) {
  return harnessContinuationIdentity(CLAUDE_HOME_MANIFEST, layout);
}

export const makeClaudeLegacyContinuationKeys = Effect.fn("makeClaudeLegacyContinuationKeys")(
  function* (input: {
    readonly config: Pick<ClaudeSettings, "homePath">;
    readonly accountsDir: string;
  }): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sharedKey = `claude:home:${yield* resolveClaudeHomePath(input.config)}`;
    const managedRoot = path.join(input.accountsDir, "claudeAgent");
    const accountNames = yield* fileSystem
      .readDirectory(managedRoot)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const accountKeys = accountNames.map(
      (name) => `claude:home:${path.resolve(managedRoot, name)}`,
    );
    const defaultKey = `claude:home:${NodeOS.homedir()}`;
    return Array.from(new Set([...accountKeys, ...(sharedKey === defaultKey ? [defaultKey] : [])]))
      .filter((key) => key !== sharedKey)
      .sort();
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);
