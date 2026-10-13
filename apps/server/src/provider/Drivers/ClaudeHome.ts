import type {
  ClaudeSettings,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/** The default instance uses the CLI login; added accounts start with their own directory. */
export const resolveClaudeInstanceHome = Effect.fn("resolveClaudeInstanceHome")(function* (
  instanceId: ProviderInstanceId,
  config: Pick<ClaudeSettings, "homePath">,
  baseDir: string,
) {
  if (config.homePath.trim() || instanceId === "claudeAgent") return config.homePath;
  const path = yield* Path.Path;
  return path.join(
    baseDir,
    "accounts",
    "claudeAgent",
    `instance-${encodeURIComponent(instanceId)}`,
  );
});

/**
 * User config that every T3 account directory shares with the default Claude
 * home. Logins, account settings, and conversation state stay per account.
 */
export const CLAUDE_SHARED_USER_CONFIG = [
  "CLAUDE.md",
  "settings.json",
  "skills",
  "agents",
  "commands",
  "output-styles",
  "hooks",
  "plugins",
] as const;

/** Account directories that T3 creates and owns. A custom CLAUDE_CONFIG_DIR stays isolated. */
export const isManagedClaudeAccountHome = Effect.fn("isManagedClaudeAccountHome")(function* (
  homePath: string,
  baseDir: string,
) {
  if (!homePath.trim()) return false;
  const path = yield* Path.Path;
  const accountsDir = path.resolve(baseDir, "accounts", "claudeAgent");
  const relative = path.relative(accountsDir, path.resolve(homePath));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
});

/**
 * Link the user config of the shared Claude home into an account directory,
 * so the account loads the same skills, agents, and settings as the CLI. A
 * real entry that the account made before it was linked moves to
 * `.t3-unshared/` instead of being deleted. An existing link is left alone.
 * Failures only log: a missing skill must not stop the account from working.
 */
export const shareClaudeUserConfig = Effect.fn("shareClaudeUserConfig")(
  function* (input: { readonly accountHomePath: string; readonly sharedHomePath: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const accountHomePath = path.resolve(input.accountHomePath);
    const sharedHomePath = path.resolve(input.sharedHomePath);
    if (accountHomePath === sharedHomePath) return;
    yield* fileSystem.makeDirectory(accountHomePath, { recursive: true });
    for (const entry of CLAUDE_SHARED_USER_CONFIG) {
      const targetPath = path.join(sharedHomePath, entry);
      const linkPath = path.join(accountHomePath, entry);
      yield* Effect.gen(function* () {
        if (!(yield* fileSystem.exists(targetPath))) return;
        if (Option.isSome(yield* fileSystem.readLink(linkPath).pipe(Effect.option))) return;
        if (yield* fileSystem.exists(linkPath)) {
          const unsharedDir = path.join(accountHomePath, ".t3-unshared");
          const unsharedPath = path.join(unsharedDir, `${entry}.${yield* Clock.currentTimeMillis}`);
          yield* fileSystem.makeDirectory(unsharedDir, { recursive: true });
          yield* fileSystem.rename(linkPath, unsharedPath);
          yield* Effect.logInfo("Moved account-local Claude config aside to share it", {
            entry,
            unsharedPath,
          });
        }
        yield* fileSystem.symlink(targetPath, linkPath);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not share Claude user config with an account", {
            entry,
            accountHomePath,
            cause,
          }),
        ),
      );
    }
  },
  Effect.catch((cause) =>
    Effect.logWarning("Could not prepare Claude account directory", { cause }),
  ),
);

export function claudeInstanceEnvironment(
  instanceId: ProviderInstanceId,
  environment: ProviderInstanceEnvironment | undefined,
): ProviderInstanceEnvironment {
  if (instanceId === "claudeAgent") return environment ?? [];
  return [
    ...["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].map((name) => ({
      name,
      value: "",
      sensitive: true,
    })),
    ...(environment ?? []),
  ];
}

/**
 * Resolve the Claude config directory the CLI would use: the instance's
 * `homePath` (exported as `CLAUDE_CONFIG_DIR`), then an inherited
 * `CLAUDE_CONFIG_DIR`, then Claude's default `~/.claude`. Empty must not
 * fall back to bare `$HOME` — that leftover from the old HOME override
 * produced a different continuation group than an explicit `~/.claude`.
 */
export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
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
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/**
 * Describe the spawned CLI's environment separately from the login command so
 * paths remain literal on every shell, including relative inherited values.
 */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
