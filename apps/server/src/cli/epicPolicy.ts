// @effect-diagnostics nodeBuiltinImport:off globalProcess:off preferSchemaOverJson:off
/**
 * `t3 epic policy` — a read-only view of the epic role policy.
 *
 * Skills and scripts need to know which tiers exist, which runner role takes
 * which chain, and which stage subagents a worker session carries. Until now
 * the only answers were the Epics settings page and the settings file itself,
 * neither of which a skill can read reliably.
 *
 * This command reads the same `settings.json` the cook CLI reads, through the
 * same two functions, so the three readers can never disagree. There is no
 * write surface here: the settings page owns editing.
 */
import * as NodeOS from "node:os";

import {
  EPIC_ROLE_IDS,
  type EpicRoleId,
  type EpicRolePolicy,
  type EpicTier,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import { readEpicRolePolicy, resolveCookSettingsPath } from "./epicCookSubagents.ts";

const encodeJsonOutput = Schema.encodeSync(Schema.UnknownFromJsonString);

/** Long enough for every shipped description, short enough to stay one row. */
const DESCRIPTION_MAX_CHARS = 160;

export class EpicPolicyCliError extends Schema.TaggedErrorClass<EpicPolicyCliError>()(
  "EpicPolicyCliError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface EpicPolicyHopReport {
  readonly order: number;
  readonly instanceId: string;
  readonly model: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
  readonly skipAboveUtilization: number | null;
}

export interface EpicPolicyTierReport {
  readonly id: string;
  readonly label: string | null;
  readonly hops: ReadonlyArray<EpicPolicyHopReport>;
}

export interface EpicPolicyRunnerRoleReport {
  readonly role: EpicRoleId;
  readonly tier: string | null;
}

export interface EpicPolicySubagentReport {
  readonly name: string;
  readonly tier: string | null;
  readonly description: string;
}

export interface EpicPolicyReport {
  /** Where the policy was looked for, whether or not it was there. */
  readonly settingsPath: string;
  readonly settingsFound: boolean;
  /** The `--tier` filter this report was narrowed by, or `null`. */
  readonly tier: string | null;
  readonly tiers: ReadonlyArray<EpicPolicyTierReport>;
  readonly roles: ReadonlyArray<EpicPolicyRunnerRoleReport>;
  readonly inSessionRoles: ReadonlyArray<EpicPolicySubagentReport>;
}

const describeTier = (id: string, tier: EpicTier): EpicPolicyTierReport => ({
  id,
  label: tier.label ?? null,
  hops: tier.hops.map((hop, index) => ({
    order: index + 1,
    instanceId: hop.selection.instanceId,
    model: hop.selection.model,
    options: hop.selection.options === undefined ? [] : [...hop.selection.options],
    skipAboveUtilization: hop.skipAboveUtilization ?? null,
  })),
});

/**
 * The whole policy as flat rows, or one chain and the roles that take it.
 *
 * `--tier` narrows every section, not just the tier list: the question it
 * answers is "what runs on this chain?", and a role list unchanged by the
 * filter would not answer it.
 */
export const buildEpicPolicyReport = (input: {
  readonly policy: EpicRolePolicy;
  readonly settingsPath: string;
  readonly settingsFound: boolean;
  readonly tier?: string | undefined;
}): Effect.Effect<EpicPolicyReport, EpicPolicyCliError> => {
  const { policy } = input;
  const tierEntries: ReadonlyArray<readonly [string, EpicTier]> = Object.entries(policy.tiers);
  const tierIds = tierEntries.map(([id]) => id);
  const filter = input.tier === undefined || input.tier === "" ? null : input.tier;

  if (filter !== null && !tierIds.includes(filter)) {
    return Effect.fail(
      new EpicPolicyCliError({
        operation: "epicPolicy.tier",
        detail:
          tierIds.length === 0
            ? `No tier '${filter}': the epic role policy has no tiers.`
            : `No tier '${filter}'. Known tiers: ${tierIds.join(", ")}.`,
      }),
    );
  }

  const tiers = tierEntries
    .filter(([id]) => filter === null || id === filter)
    .map(([id, tier]) => describeTier(id, tier));

  const roles = EPIC_ROLE_IDS.map((role) => ({ role, tier: policy.roles[role] ?? null })).filter(
    (row) => filter === null || row.tier === filter,
  );

  const inSessionRoles = Object.entries(policy.inSessionRoles)
    .map(([name, role]) => ({ name, tier: role.tier ?? null, description: role.description }))
    .filter((row) => filter === null || row.tier === filter);

  return Effect.succeed({
    settingsPath: input.settingsPath,
    settingsFound: input.settingsFound,
    tier: filter,
    tiers,
    roles,
    inSessionRoles,
  });
};

/** One row per field, tab separated, so a row never wraps or loses a column. */
const row = (cells: ReadonlyArray<string>): string => `  ${cells.join("\t")}`;

const cell = (value: string | number | null): string =>
  value === null || value === "" ? "-" : String(value);

const formatOptions = (options: EpicPolicyHopReport["options"]): string =>
  options.length === 0 ? "-" : options.map((option) => `${option.id}=${option.value}`).join(";");

const formatDescription = (description: string): string => {
  const flat = description.replace(/\s+/g, " ").trim();
  return flat.length <= DESCRIPTION_MAX_CHARS ? flat : `${flat.slice(0, DESCRIPTION_MAX_CHARS)}...`;
};

const section = (
  header: string,
  fields: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  empty: string,
): ReadonlyArray<string> =>
  rows.length === 0
    ? [`${header}: ${empty}`]
    : [`${header}[${rows.length}]{${fields.join(",")}}:`, ...rows.map(row)];

export const formatEpicPolicyReport = (report: EpicPolicyReport): string => {
  const hops = report.tiers.flatMap((tier) =>
    tier.hops.map((hop) => [
      tier.id,
      String(hop.order),
      hop.instanceId,
      hop.model,
      formatOptions(hop.options),
      cell(hop.skipAboveUtilization),
    ]),
  );

  return [
    report.settingsFound
      ? `settings: ${report.settingsPath}`
      : `settings: ${report.settingsPath} (not found, showing shipped defaults)`,
    ...(report.tier === null ? [] : [`tier: ${report.tier}`]),
    ...section(
      "tiers",
      ["id", "label", "hops"],
      report.tiers.map((tier) => [tier.id, cell(tier.label), String(tier.hops.length)]),
      "0 tiers configured",
    ),
    ...section(
      "hops",
      ["tier", "order", "instanceId", "model", "options", "skipAboveUtilization"],
      hops,
      "0 hops configured",
    ),
    ...section(
      "roles",
      ["role", "tier"],
      report.roles.map((role) => [role.role, cell(role.tier)]),
      report.tier === null ? "0 runner roles assigned" : `0 runner roles on tier ${report.tier}`,
    ),
    ...section(
      "inSessionRoles",
      ["name", "tier", "description"],
      report.inSessionRoles.map((role) => [
        role.name,
        cell(role.tier),
        formatDescription(role.description),
      ]),
      report.tier === null
        ? "0 in-session subagents configured"
        : `0 in-session subagents on tier ${report.tier}`,
    ),
    // A detail view answers itself; only the whole-policy view needs pointers.
    ...(report.tier === null
      ? [
          "help[2]:",
          "  Run `t3 epic policy --tier <id>` to show one chain and what takes it",
          "  Dispatch an in-session role by name and pass no model; a tier-less role inherits the session model",
        ]
      : []),
  ].join("\n");
};

export const formatEpicPolicyOutput = (report: EpicPolicyReport, json: boolean): string =>
  json ? encodeJsonOutput(report) : formatEpicPolicyReport(report);

export const readEpicPolicyReport = (input: {
  readonly settingsPath: string;
  readonly tier?: string | undefined;
}): Effect.Effect<EpicPolicyReport, EpicPolicyCliError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const settingsFound = yield* fileSystem
      .exists(input.settingsPath)
      .pipe(Effect.orElseSucceed(() => false));
    const policy = yield* readEpicRolePolicy(input.settingsPath);
    return yield* buildEpicPolicyReport({
      policy,
      settingsPath: input.settingsPath,
      settingsFound,
      ...(input.tier === undefined ? {} : { tier: input.tier }),
    });
  });

export const policyCommand = Command.make("policy", {
  tier: Flag.string("tier").pipe(
    Flag.withDescription("Show only this tier, and the roles that take it."),
    Flag.optional,
  ),
  json: Flag.boolean("json").pipe(
    Flag.withDescription("Emit stable JSON output."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Show the epic role policy: tiers, runner roles, and stage subagents."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const settingsPath = resolveCookSettingsPath({
        environment: process.env,
        homeDirectory: NodeOS.homedir(),
      });
      const report = yield* readEpicPolicyReport({
        settingsPath,
        ...(Option.isSome(flags.tier) ? { tier: flags.tier.value } : {}),
      });
      yield* Console.log(formatEpicPolicyOutput(report, flags.json));
    }),
  ),
);
