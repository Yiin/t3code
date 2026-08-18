import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  EPIC_RUN_CONFIG_LEAF_KEY_SET,
  EPIC_RUN_CONFIG_LEAF_KEYS,
  EpicRunConfig,
  hasEpicRunConfigValue,
  type EpicRunConfig as EpicRunConfigValue,
  type EpicRunConfigOverride,
  type EpicRunConfigProvenance,
  type EpicRunConfigProvenanceSource,
  type ExecutionMode,
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

const decodeEpicRunConfig = Schema.decodeUnknownSync(EpicRunConfig);
const DEFAULT_CONFIG = decodeEpicRunConfig({});

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (!Predicate.isObject(value)) return value;
  return cloneRecord(value);
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
    if (EPIC_RUN_CONFIG_LEAF_KEY_SET.has(dottedKey)) {
      target[key] = cloneValue(value);
      provenance[dottedKey] = source;
      continue;
    }
    if (Predicate.isObject(value)) {
      const existing = target[key];
      const child = Predicate.isObject(existing) ? existing : {};
      target[key] = child;
      applyOverride(child, value, source, provenance, dottedKey);
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

/**
 * Resolve all config layers without I/O or Effect services.
 *
 * Run input stays last so an explicit launch can override the committed file
 * and deprecated environment shims. The environment layer remains only for
 * migration from the old terminal settings.
 */
export interface ResolvedEpicRunConfig {
  readonly config: EpicRunConfigValue;
  readonly provenance: EpicRunConfigProvenance;
  readonly violations: readonly EpicRunConfigViolation[];
}

export function resolveEpicRunConfig(input: ResolveEpicRunConfigInput): ResolvedEpicRunConfig {
  const config = cloneRecord(DEFAULT_CONFIG);
  const provenance: Record<string, EpicRunConfigProvenanceSource> = Object.fromEntries(
    EPIC_RUN_CONFIG_LEAF_KEYS.map((key) => [key, "default" as const]),
  );

  const layers = [
    [input.file, "file"],
    [input.environment, "environment"],
    [input.override, "override"],
  ] as const;
  for (const [value, source] of layers) {
    if (value !== null) applyOverride(config, value, source, provenance);
  }

  // Every layer is an override of an already-valid config, so the merged record
  // must satisfy the same schema. Decoding here proves it instead of asserting it.
  const merged = decodeEpicRunConfig(config);
  const violations: EpicRunConfigViolation[] = [];

  // Mode precedence: an explicit `execution.mode` wins. An explicit legacy
  // `execution.sequential` maps onto the mode (true -> "sequential", false ->
  // "parallel"). Neither means "auto".
  const modeSource = provenance["execution.mode"] ?? "default";
  const sequentialSource = provenance["execution.sequential"] ?? "default";
  let mode: ExecutionMode = merged.execution.mode;
  if (modeSource !== "default" && sequentialSource !== "default") {
    const legacyMode = merged.execution.sequential ? "sequential" : "parallel";
    if (legacyMode !== mode) {
      violations.push({
        key: "execution.mode",
        message: "Conflicts with execution.sequential; execution.mode wins.",
      });
    }
  } else if (modeSource === "default" && sequentialSource !== "default") {
    mode = merged.execution.sequential ? "sequential" : "parallel";
    provenance["execution.mode"] = sequentialSource;
  }
  // Keep the legacy boolean coherent for readers that have not moved to mode.
  const sequential = mode === "sequential";
  if (merged.execution.sequential !== sequential) {
    provenance["execution.sequential"] = provenance["execution.mode"] ?? "default";
  }

  if (
    !merged.gate.disabled &&
    merged.gate.command === null &&
    [input.file, input.environment, input.override].some(explicitlyEnablesMissingGate)
  ) {
    violations.push({
      key: "gate.command",
      message: "Gate is enabled, but no gate command is configured.",
    });
  }
  if (merged.budget.usd !== null && input.harness !== "claude" && input.harness !== "ccx") {
    violations.push({
      key: "budget.usd",
      message: "The selected harness cannot enforce the budget limit.",
    });
  }
  let workers = merged.parallel.workers;
  if (mode === "sequential" && workers > 1) {
    const workersWereExplicit = hasEpicRunConfigValue(provenance, "parallel.workers");
    workers = 1;
    provenance["parallel.workers"] = "policy";
    if (workersWereExplicit) {
      violations.push({
        key: "parallel.workers",
        message: "Sequential execution limits parallel workers to 1.",
      });
    }
  }
  if (merged.server.retryMaxDelayMs < merged.server.retryBaseDelayMs) {
    violations.push({
      key: "server.retryMaxDelayMs",
      message: "Maximum retry delay must be at least the base retry delay.",
    });
  }
  if (merged.supervision.inspectMaxDelaySeconds < merged.supervision.inspectMinDelaySeconds) {
    violations.push({
      key: "supervision.inspectMaxDelaySeconds",
      message: "Maximum inspect delay must be at least the minimum inspect delay.",
    });
  }

  const resolved: EpicRunConfigValue = {
    ...merged,
    execution: { ...merged.execution, mode, sequential },
    parallel: { ...merged.parallel, workers },
  };
  return { config: resolved, provenance, violations };
}
