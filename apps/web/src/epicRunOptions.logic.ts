import type {
  EpicRunConfig,
  EpicRunConfigOverride,
  EpicRunConfigProvenanceSource,
} from "@t3tools/contracts";

/** Where a resolved config value came from, as a short chip label. */
export const EPIC_RUN_PROVENANCE_CHIP_LABELS: Record<EpicRunConfigProvenanceSource, string> = {
  default: "default",
  file: "from .t3code/epic-run.json",
  environment: "from environment",
  override: "set for this run",
  policy: "from policy",
};

export function epicRunProvenanceChipLabel(
  source: EpicRunConfigProvenanceSource | undefined,
): string {
  return EPIC_RUN_PROVENANCE_CHIP_LABELS[source ?? "default"];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads one dotted registry key (e.g. "gate.command") out of a resolved config. */
export function epicRunEffectiveValue(config: EpicRunConfig, key: string): unknown {
  let node: unknown = config;
  for (const segment of key.split(".")) {
    if (!isPlainRecord(node)) return undefined;
    node = node[segment];
  }
  return node;
}

/**
 * Builds the launch override from the fields the operator actually touched.
 * Dotted keys become nested objects; an untouched form returns `undefined`
 * so the launch input omits `config` entirely.
 */
export function buildEpicRunConfigOverride(
  touched: ReadonlyMap<string, unknown>,
): EpicRunConfigOverride | undefined {
  if (touched.size === 0) return undefined;
  const override: Record<string, unknown> = {};
  for (const [key, value] of touched) {
    const segments = key.split(".");
    let node = override;
    for (const segment of segments.slice(0, -1)) {
      if (!isPlainRecord(node[segment])) node[segment] = {};
      node = node[segment] as Record<string, unknown>;
    }
    node[segments[segments.length - 1] as string] = value;
  }
  return override as EpicRunConfigOverride;
}

/** One config value rendered compactly for read-only rows and the meta table. */
export function formatEpicRunOptionValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.map(String).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
