/**
 * Pure logic for the Providers settings page's account view: rotation-order
 * display sorting, whole-map reorder patches, and per-account limit-state
 * presentation. Rendering stays in `SettingsPanels.tsx` /
 * `ProviderInstanceCard.tsx`.
 *
 * Rotation order within a harness is the settings-author key order of
 * `ServerSettings.providerInstances`: the server's instance catalog spreads
 * that map first and appends synthesized defaults after it
 * (`deriveProviderInstanceConfigMap`), and the sibling rotation walks the
 * resulting provider array in order. Everything here preserves that
 * correspondence.
 *
 * @module providerAccounts.logic
 */
import {
  ProviderInstanceId,
  type ProviderAccountLimit,
  type ProviderAuthRunState,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderLimitKind,
  type ServerProviderAuthStatus,
  type ProviderUsageSample,
  type ProviderUsageWindow,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const SCRIPTABLE_AUTH_DRIVERS = new Set(["claudeAgent", "codex", "kimi", "opencode"]);
const MANUAL_LOGIN_COMMANDS: Readonly<Record<string, string>> = {
  cursor: "agent login",
  grok: "grok login",
};

/** Normalize a display label into the suffix used by provider instance ids. */
export function slugifyProviderInstanceLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

/** Build an instance id from a driver and display label. */
export function deriveProviderInstanceId(driver: ProviderDriverKind, label: string): string {
  const slug = slugifyProviderInstanceLabel(label);
  return slug ? `${driver}_${slug}` : "";
}

/** Return a user-facing validation error for a provider instance id. */
export function validateProviderInstanceId(
  id: string,
  existing: ReadonlySet<string>,
): string | null {
  if (id.length === 0) return "Instance ID is required.";
  if (id.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (existing.has(id)) return `An instance named '${id}' already exists.`;
  return null;
}

export interface ManagedProviderAccountIdentity {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
}

/** Pick the next stable quick-add identity without colliding with any visible or stored row. */
export function nextManagedProviderAccountIdentity(
  driver: ProviderDriverKind,
  occupiedIds: ReadonlySet<string>,
): ManagedProviderAccountIdentity {
  for (let accountNumber = 2; ; accountNumber += 1) {
    const displayName = `Account ${accountNumber}`;
    const candidate = deriveProviderInstanceId(driver, displayName);
    if (!occupiedIds.has(candidate)) {
      return {
        instanceId: ProviderInstanceId.make(candidate),
        displayName,
      };
    }
  }
}

type CredentialHomeField = "homePath" | "shadowHomePath" | "dataHomePath";

function credentialHomeField(driver: ProviderDriverKind): CredentialHomeField | null {
  switch (driver) {
    case "claudeAgent":
    case "kimi":
      return "homePath";
    case "codex":
      return "shadowHomePath";
    case "opencode":
      return "dataHomePath";
    default:
      return null;
  }
}

/** Read the credential home used by a scriptable account driver. */
export function readProviderCredentialHome(instance: ProviderInstanceConfig): string | null {
  const field = credentialHomeField(instance.driver);
  if (field === null || instance.config === null || typeof instance.config !== "object") {
    return null;
  }
  const value = (instance.config as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Store a server-allocated credential home in the field owned by the selected driver. */
export function withProviderCredentialHome(
  instance: ProviderInstanceConfig,
  homePath: string,
): ProviderInstanceConfig | null {
  const field = credentialHomeField(instance.driver);
  if (field === null) return null;
  const config =
    instance.config !== null &&
    typeof instance.config === "object" &&
    !Array.isArray(instance.config)
      ? { ...(instance.config as Record<string, unknown>) }
      : {};
  config[field] = homePath;
  return { ...instance, config };
}

/**
 * Client-only display gate for the destructive home checkbox.
 *
 * The server still validates the real path. This helper only shows the option
 * when the configured path equals the exact account path under `accountsDir`.
 */
export function isManagedProviderAccountHomeForDisplay(input: {
  readonly homePath: string | null;
  readonly accountsDir: string | null | undefined;
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
}): boolean {
  if (input.homePath === null || !input.accountsDir?.trim()) return false;
  const normalizePath = (value: string) =>
    value
      .trim()
      .replaceAll("\\", "/")
      .replace(/\/{2,}/g, "/")
      .replace(/\/+$/g, "");
  const managedPath = `${normalizePath(input.accountsDir)}/${input.driver}/${input.instanceId}`;
  return normalizePath(input.homePath) === managedPath;
}

export type ProviderAccountAuthAction =
  | { readonly kind: "sign-in" }
  | { readonly kind: "sign-out" }
  | { readonly kind: "manual"; readonly command: string | null }
  | { readonly kind: "none" };

function commandFromServerGuidance(message: string | null | undefined): string | null {
  if (!message) return null;
  return message.match(/\bRun `([^`]+)`/u)?.[1] ?? null;
}

/** Choose the account action from driver capability and live authentication state. */
export function resolveProviderAccountAuthAction(input: {
  readonly driver: ProviderDriverKind;
  readonly authStatus: ServerProviderAuthStatus;
  readonly serverMessage?: string | null;
}): ProviderAccountAuthAction {
  if (SCRIPTABLE_AUTH_DRIVERS.has(String(input.driver))) {
    if (input.authStatus === "authenticated") return { kind: "sign-out" };
    if (input.authStatus === "unauthenticated") return { kind: "sign-in" };
    return { kind: "none" };
  }
  if (input.authStatus === "authenticated") return { kind: "none" };
  return {
    kind: "manual",
    command:
      commandFromServerGuidance(input.serverMessage) ??
      MANUAL_LOGIN_COMMANDS[String(input.driver)] ??
      null,
  };
}

const TERMINAL_AUTH_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

/** Merge the direct login-start state before applying later streamed snapshots. */
export function reduceProviderAuthRunState(
  current: ProviderAuthRunState | null,
  incoming: ProviderAuthRunState,
): ProviderAuthRunState {
  if (current === null) return incoming;
  if (TERMINAL_AUTH_STATUSES.has(current.status) && !TERMINAL_AUTH_STATUSES.has(incoming.status)) {
    return current;
  }
  if (incoming.status === "idle" && current.status !== "idle") return current;
  return {
    ...incoming,
    startedAt: incoming.startedAt ?? current.startedAt,
    finishedAt: incoming.finishedAt ?? current.finishedAt,
    message: incoming.message ?? current.message,
    output: incoming.output || current.output,
    verificationUrl: incoming.verificationUrl ?? current.verificationUrl,
    userCode: incoming.userCode ?? current.userCode,
  };
}

export interface ProviderAccountRowLike {
  readonly instanceId: ProviderInstanceId;
  /** True when the live snapshot reports `availability: "unavailable"`. */
  readonly isUnavailable: boolean;
}

/**
 * Sort one harness group's rows into display order: rotation order first
 * (explicit `providerInstances` key order, synthesized entries after), then
 * unavailable shadows demoted below every live account. Both passes are
 * stable, so equal-ranked rows keep the caller's order.
 */
export function orderProviderGroupRows<T extends ProviderAccountRowLike>(
  rows: ReadonlyArray<T>,
  explicitKeyOrder: ReadonlyArray<string>,
): ReadonlyArray<T> {
  const keyIndex = new Map(explicitKeyOrder.map((key, index) => [key, index]));
  const rank = (row: T) => keyIndex.get(String(row.instanceId)) ?? explicitKeyOrder.length;
  const rotation = [...rows].sort((a, b) => rank(a) - rank(b));
  return [
    ...rotation.filter((row) => !row.isUnavailable),
    ...rotation.filter((row) => row.isUnavailable),
  ];
}

/** Move `instanceId` one step within its group; null when the move falls off an end. */
export function moveProviderAccount<T extends ProviderAccountRowLike>(
  rows: ReadonlyArray<T>,
  instanceId: ProviderInstanceId,
  direction: "up" | "down",
): ReadonlyArray<T> | null {
  const from = rows.findIndex((row) => row.instanceId === instanceId);
  if (from === -1) return null;
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= rows.length) return null;
  const next = [...rows];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * Build the settings patch that persists one harness group's account order.
 *
 * `providerInstances` is a whole-value replacement key, so the patch carries
 * the entire map with the group's keys rewritten in the new order. Keys of
 * other harnesses keep their positions: the walk emits the next group member
 * wherever a group member used to sit, and appends members the map did not
 * hold yet (a reorder materializes the synthesized default slot). Mirroring
 * `buildProviderInstanceUpdatePatch`, a newly materialized default resets its
 * legacy `providers.<driver>` mirror so the explicit entry stays the single
 * source of truth.
 */
export function buildProviderGroupReorderPatch(input: {
  readonly settings: Pick<ServerSettings, "providers" | "providerInstances">;
  readonly groupOrder: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
  }>;
}): Partial<UnifiedSettings> {
  const current = input.settings.providerInstances ?? {};
  const groupIds = new Set(input.groupOrder.map((entry) => String(entry.instanceId)));
  const queue = [...input.groupOrder];
  const next: Record<string, ProviderInstanceConfig> = {};

  for (const [id, instance] of Object.entries(current)) {
    if (groupIds.has(id)) {
      const entry = queue.shift();
      if (entry !== undefined) {
        next[String(entry.instanceId)] = entry.instance;
      }
    } else {
      next[id] = instance;
    }
  }

  type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
  const legacyProviderDefaults = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  let providersReset: Record<string, LegacyProviderSettings> | undefined;
  for (const entry of queue) {
    next[String(entry.instanceId)] = entry.instance;
    const legacyDefault = legacyProviderDefaults[String(entry.instance.driver)];
    if (legacyDefault !== undefined) {
      providersReset = {
        ...(providersReset ?? (input.settings.providers as Record<string, LegacyProviderSettings>)),
        [String(entry.instance.driver)]: legacyDefault,
      };
    }
  }

  return {
    providerInstances: next as ServerSettings["providerInstances"],
    ...(providersReset !== undefined
      ? { providers: providersReset as ServerSettings["providers"] }
      : {}),
  };
}

const USAGE_WINDOW_LABELS: Record<ProviderUsageWindow, string> = {
  five_hour: "5h window",
  seven_day: "7d window",
  seven_day_opus: "7d Opus window",
  seven_day_sonnet: "7d Sonnet window",
  overage: "overage",
  primary: "primary window",
  secondary: "secondary window",
};

const LIMIT_KIND_LABELS: Record<ProviderLimitKind, string> = {
  "usage-limit": "Usage limit reached",
  "spend-limit": "Spend limit reached",
  "credits-depleted": "Credits depleted",
  auth: "Sign-in required",
  unavailable: "Account unavailable",
};

export interface ProviderAccountUtilization {
  readonly percent: number;
  readonly windowLabel: string;
  readonly resetsAt: string | null;
}

export interface ProviderAccountBlock {
  readonly label: string;
  readonly resetsAt: string | null;
}

export interface ProviderAccountLimitState {
  readonly utilization: ProviderAccountUtilization | null;
  readonly blocked: ProviderAccountBlock | null;
}

const isLive = (resetsAt: string | null, nowMs: number): boolean =>
  resetsAt === null || Date.parse(resetsAt) > nowMs;

/**
 * Project a snapshot's usage and limit join into what the account card shows.
 *
 * Returns null when there is nothing truthful to say: a driver with no usage
 * reader and no live block renders no block at all rather than a zero. The
 * utilization is the worst still-live window; a sample whose `resetsAt` has
 * passed is dead even if the snapshot is stale. A limit row whose reset time
 * has passed is treated as re-entered and hidden; a null reset time means the
 * harness gave none, so the row stays visible and shows no countdown.
 */
export function deriveProviderAccountLimitState(input: {
  readonly usage: ReadonlyArray<ProviderUsageSample> | undefined;
  readonly limit: ProviderAccountLimit | null | undefined;
  readonly nowMs: number;
}): ProviderAccountLimitState | null {
  let worst: ProviderUsageSample | null = null;
  for (const sample of input.usage ?? []) {
    if (!isLive(sample.resetsAt, input.nowMs)) continue;
    if (worst === null || sample.utilization > worst.utilization) {
      worst = sample;
    }
  }
  const utilization: ProviderAccountUtilization | null = worst
    ? {
        percent: Math.round(Math.max(0, worst.utilization)),
        windowLabel: USAGE_WINDOW_LABELS[worst.window],
        resetsAt: worst.resetsAt,
      }
    : null;

  const limit = input.limit ?? null;
  const blocked: ProviderAccountBlock | null =
    limit !== null && isLive(limit.resetsAt, input.nowMs)
      ? { label: LIMIT_KIND_LABELS[limit.kind], resetsAt: limit.resetsAt }
      : null;

  if (utilization === null && blocked === null) return null;
  return { utilization, blocked };
}

/**
 * Countdown label for a reset timestamp: "3d 4h", "2h 14m", "9m". Rounds up,
 * so a sub-minute remainder shows "1m". Null once the timestamp is in the
 * past or unparsable.
 */
export function formatResetCountdown(resetsAt: string, nowMs: number): string | null {
  const remainingMs = Date.parse(resetsAt) - nowMs;
  if (Number.isNaN(remainingMs) || remainingMs <= 0) return null;
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}
