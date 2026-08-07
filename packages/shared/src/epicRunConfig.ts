import * as Schema from "effect/Schema";

import {
  EPIC_RUN_CONFIG_FIELDS,
  EpicRunConfig,
  type EpicRunConfig as EpicRunConfigValue,
  type EpicRunConfigOverride,
  type EpicRunConfigProvenance,
  type EpicRunConfigProvenanceSource,
} from "@t3tools/contracts";

export type { EpicRunConfigProvenance, EpicRunConfigProvenanceSource };

export interface EpicRunConfigViolation {
  readonly key: string;
  readonly message: string;
}

export interface ResolveEpicRunConfigInput {
  readonly file: EpicRunConfigOverride | null;
  readonly environment: EpicRunConfigOverride | null;
  readonly override: EpicRunConfigOverride | null;
  readonly harness: string | null;
}

const DEFAULT_CONFIG = Schema.decodeUnknownSync(EpicRunConfig)({});
const LEAF_KEYS = EPIC_RUN_CONFIG_FIELDS.filter((field) => field.scope !== "terminal-only").map(
  (field) => field.key,
);
const LEAF_KEY_SET = new Set(LEAF_KEYS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
}

function applyOverride(
  target: Record<string, unknown>,
  input: Record<string, unknown>,
  source: EpicRunConfigProvenanceSource,
  provenance: Record<string, EpicRunConfigProvenanceSource>,
  prefix = "",
): void {
  for (const [key, value] of Object.entries(input)) {
    const dottedKey = prefix === "" ? key : `${prefix}.${key}`;
    if (LEAF_KEY_SET.has(dottedKey)) {
      target[key] = cloneValue(value);
      provenance[dottedKey] = source;
      continue;
    }
    if (isRecord(value)) {
      const existing = target[key];
      if (!isRecord(existing)) target[key] = {};
      applyOverride(target[key] as Record<string, unknown>, value, source, provenance, dottedKey);
      continue;
    }
    target[key] = cloneValue(value);
    provenance[dottedKey] = source;
  }
}

function explicitlyEnablesMissingGate(input: EpicRunConfigOverride | null): boolean {
  if (input?.gate === undefined) return false;
  return input.gate.disabled === false || input.gate.command === null;
}

/** Resolve all config layers without I/O or Effect services. */
export function resolveEpicRunConfig(input: ResolveEpicRunConfigInput): {
  readonly config: EpicRunConfigValue;
  readonly provenance: EpicRunConfigProvenance;
  readonly violations: readonly EpicRunConfigViolation[];
} {
  const config = cloneValue(DEFAULT_CONFIG) as Record<string, unknown>;
  const provenance: Record<string, EpicRunConfigProvenanceSource> = Object.fromEntries(
    LEAF_KEYS.map((key) => [key, "default" as const]),
  );

  const layers = [
    [input.file, "file"],
    [input.environment, "environment"],
    [input.override, "override"],
  ] as const;
  for (const [value, source] of layers) {
    if (value !== null) applyOverride(config, value, source, provenance);
  }

  const resolved = config as unknown as EpicRunConfigValue;
  const violations: EpicRunConfigViolation[] = [];
  if (
    !resolved.gate.disabled &&
    resolved.gate.command === null &&
    [input.file, input.environment, input.override].some(explicitlyEnablesMissingGate)
  ) {
    violations.push({
      key: "gate.command",
      message: "Gate is enabled, but no gate command is configured.",
    });
  }
  if (resolved.budget.usd !== null && input.harness !== "claude" && input.harness !== "ccx") {
    violations.push({
      key: "budget.usd",
      message: "The selected harness cannot enforce the budget limit.",
    });
  }
  if (resolved.execution.sequential && resolved.parallel.workers > 1) {
    const workersWereExplicit = provenance["parallel.workers"] !== "default";
    (resolved.parallel as { workers: number }).workers = 1;
    provenance["parallel.workers"] = "policy";
    if (workersWereExplicit) {
      violations.push({
        key: "parallel.workers",
        message: "Sequential execution limits parallel workers to 1.",
      });
    }
  }
  if (resolved.server.retryMaxDelayMs < resolved.server.retryBaseDelayMs) {
    violations.push({
      key: "server.retryMaxDelayMs",
      message: "Maximum retry delay must be at least the base retry delay.",
    });
  }
  if (resolved.supervision.inspectMaxDelaySeconds < resolved.supervision.inspectMinDelaySeconds) {
    violations.push({
      key: "supervision.inspectMaxDelaySeconds",
      message: "Maximum inspect delay must be at least the minimum inspect delay.",
    });
  }

  return { config: resolved, provenance, violations };
}
