import { type ProviderInstanceConfig, type ProviderInstanceConfigMap } from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CLAUDE_HOME_MANIFEST } from "./ClaudeHome.ts";

const MARKER = ".t3-managed-home.json";
const CONFLICT_DIR = ".t3-migration-conflicts";
const MANAGED_DRIVERS = new Set(["claudeAgent", "kimi", "opencode", "codex"]);

type EntryClass = "private" | "shadow-local" | "shared" | "other";
export type ManagedAccountMovePlan = {
  readonly instanceId: string;
  readonly driver: string;
  readonly accountPath: string;
  readonly sharedPath: string;
};

const PRIVATE: Record<string, ReadonlySet<string>> = {
  claudeAgent: new Set(CLAUDE_HOME_MANIFEST.privateEntries),
  codex: new Set(["auth.json", "models_cache.json"]),
  kimi: new Set(["credentials.json", "auth.json"]),
  opencode: new Set(["opencode"]),
};
const LOCAL: Record<string, ReadonlySet<string>> = {
  claudeAgent: new Set([...CLAUDE_HOME_MANIFEST.shadowLocalEntries, MARKER, CONFLICT_DIR]),
  codex: new Set(["log", "memories", "tmp"]),
  kimi: new Set([]),
  opencode: new Set([]),
};
const SHARED: Record<string, ReadonlySet<string>> = {
  claudeAgent: new Set(CLAUDE_HOME_MANIFEST.sharedEntries),
  codex: new Set([
    "sessions",
    "archived_sessions",
    "sqlite",
    "shell_snapshots",
    "worktrees",
    "skills",
    "plugins",
    "cache",
    "logs",
    "mcp-oauth-locks",
  ]),
  kimi: new Set(["sessions", "projects", "history", "logs"]),
  opencode: new Set(["opencode.db", "opencode", "snapshot", "repos"]),
};

export function classifyAccountEntry(driver: string, entryName: string): EntryClass {
  if (PRIVATE[driver]?.has(entryName)) return "private";
  if (LOCAL[driver]?.has(entryName)) return "shadow-local";
  if (SHARED[driver]?.has(entryName)) return "shared";
  return "other";
}

function configuredHome(driver: string, config: Record<string, unknown>): string | undefined {
  const key = driver === "opencode" ? "dataHomePath" : "homePath";
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function privateHomeKey(driver: string): "shadowHomePath" | "sharedDataHomePath" {
  return driver === "opencode" ? "sharedDataHomePath" : "shadowHomePath";
}

export function planManagedAccountHomeMigration(
  providerInstances: ProviderInstanceConfigMap,
  accountsDir: string,
  resolvePath: (value: string) => string,
  sharedHomeFor: (driver: string, config: Record<string, unknown>) => string,
) {
  const rewritten: Record<string, ProviderInstanceConfig> = { ...providerInstances };
  const moves: ManagedAccountMovePlan[] = [];
  for (const [instanceId, instance] of Object.entries(providerInstances)) {
    const driver = String(instance.driver);
    if (!MANAGED_DRIVERS.has(driver)) continue;
    const config = (instance.config ?? {}) as Record<string, unknown>;
    const configured = configuredHome(driver, config);
    if (configured === undefined) continue;
    const accountPath = resolvePath(configured);
    const accountRoot = resolvePath(accountsDir);
    if (!accountPath.startsWith(`${accountRoot}/`)) continue;
    if (
      typeof config[privateHomeKey(driver)] === "string" &&
      String(config[privateHomeKey(driver)]).trim()
    )
      continue;
    const nextConfig = {
      ...config,
      [privateHomeKey(driver)]: driver === "opencode" ? sharedHomeFor(driver, config) : accountPath,
    };
    if (driver !== "opencode") {
      delete nextConfig.homePath;
      delete nextConfig.dataHomePath;
    }
    rewritten[instanceId] = { ...instance, config: nextConfig };
    moves.push({ instanceId, driver, accountPath, sharedPath: sharedHomeFor(driver, config) });
  }
  return { providerInstances: rewritten as ProviderInstanceConfigMap, moves };
}

const exists = (fs: FileSystem.FileSystem, path: string) =>
  fs.stat(path).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

function mergeTree(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  source: string,
  destination: string,
  conflictRoot: string,
): Effect.Effect<void, PlatformError.PlatformError> {
  return Effect.gen(function* () {
    const sourceStat = yield* fs.stat(source);
    const destinationExists = yield* exists(fs, destination);
    if (sourceStat.type === "Directory") {
      yield* fs.makeDirectory(destination, { recursive: true });
      for (const child of yield* fs.readDirectory(source)) {
        yield* mergeTree(
          fs,
          path,
          path.join(source, child),
          path.join(destination, child),
          path.join(conflictRoot, child),
        );
      }
      yield* fs.remove(source, { recursive: false });
      return;
    }
    if (!destinationExists) {
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.rename(source, destination);
      return;
    }
    const destinationStat = yield* fs.stat(destination);
    if (sourceStat.type === "File" && destinationStat.type === "File") {
      const sourceBytes = yield* fs.readFile(source);
      const destinationBytes = yield* fs.readFile(destination);
      if (sourceBytes.length > destinationBytes.length) {
        yield* fs.makeDirectory(path.dirname(conflictRoot), { recursive: true });
        yield* fs.rename(destination, conflictRoot);
        yield* fs.rename(source, destination);
      } else {
        yield* fs.makeDirectory(path.dirname(conflictRoot), { recursive: true });
        yield* fs.rename(source, conflictRoot);
      }
      return;
    }
    yield* fs.makeDirectory(path.dirname(conflictRoot), { recursive: true });
    yield* fs.rename(source, conflictRoot);
  });
}

function migrateOne(plan: ManagedAccountMovePlan, fs: FileSystem.FileSystem, path: Path.Path) {
  return Effect.gen(function* () {
    const markerPath = path.join(plan.accountPath, MARKER);
    const marker = yield* fs.readFileString(markerPath).pipe(Effect.orElseSucceed(() => ""));
    if (marker.includes('"version":1') && marker.includes(`"sharedHomePath":"${plan.sharedPath}"`))
      return false;
    yield* fs.makeDirectory(plan.accountPath, { recursive: true });
    yield* fs.makeDirectory(plan.sharedPath, { recursive: true });
    for (const entry of yield* fs.readDirectory(plan.accountPath)) {
      const entryClass = classifyAccountEntry(plan.driver, entry);
      const moveKnownShared = entryClass === "shared";
      const moveMatchingShared =
        entryClass === "other" && (yield* exists(fs, path.join(plan.sharedPath, entry)));
      if (!moveKnownShared && !moveMatchingShared) continue;
      yield* mergeTree(
        fs,
        path,
        path.join(plan.accountPath, entry),
        path.join(plan.sharedPath, entry),
        path.join(plan.accountPath, CONFLICT_DIR, entry),
      );
    }
    return true;
  });
}

export const runManagedAccountHomeMigration = Effect.fn("runManagedAccountHomeMigration")(
  function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const current = yield* settings.getSettings;
    let activeProviderInstances = current.providerInstances;
    const resolve = (value: string) => path.resolve(value);
    const plan = planManagedAccountHomeMigration(
      current.providerInstances,
      config.accountsDir,
      resolve,
      (driver, _values) =>
        driver === "claudeAgent"
          ? path.join(NodeOS.homedir(), ".claude")
          : driver === "codex"
            ? path.join(NodeOS.homedir(), ".codex")
            : driver === "kimi"
              ? path.join(NodeOS.homedir(), ".kimi-code")
              : path.join(NodeOS.homedir(), ".local", "share"),
    );
    for (const move of plan.moves) {
      const rewrittenForAccount = {
        ...activeProviderInstances,
        [move.instanceId]: (plan.providerInstances as Record<string, ProviderInstanceConfig>)[
          move.instanceId
        ],
      } as ProviderInstanceConfigMap;
      const migrated = yield* migrateOne(move, fs, path).pipe(
        Effect.flatMap((didMigrate) =>
          didMigrate
            ? settings
                .updateSettings({ providerInstances: rewrittenForAccount })
                .pipe(
                  Effect.andThen(
                    fs.writeFileString(
                      path.join(move.accountPath, MARKER),
                      `{"version":1,"migratedAt":"migration","sharedHomePath":"${move.sharedPath}"}`,
                    ),
                  ),
                  Effect.as(true),
                )
            : Effect.succeed(false),
        ),
        Effect.catchCause((cause) =>
          Effect.logError("Managed provider home migration failed", {
            instanceId: move.instanceId,
            path: move.accountPath,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (migrated) activeProviderInstances = rewrittenForAccount;
    }
  },
);
