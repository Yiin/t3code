import {
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  EPIC_RUN_CONFIG_FIELDS,
  EpicRunEngine,
  ExecutionMode,
  RuntimeMode,
  type EnvironmentId,
  type EpicRunConfig,
  type EpicRunConfigField,
  type EpicRunConfigProvenance,
  type EpicRunConfigProvenanceSource,
} from "@t3tools/contracts";
import { LoaderIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { epicRunPreflightModeForConfig } from "../epicRunLaunch";
import {
  buildEpicRunConfigOverride,
  epicRunEffectiveValue,
  epicRunProvenanceChipLabel,
  formatEpicRunOptionValue,
} from "../epicRunOptions.logic";
import { epicsEnvironment } from "../state/epics";
import { useAtomCommand } from "../state/use-atom-command";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

const TERMINAL_ONLY_REASON = "Applies to the terminal coordinator only; server runs ignore this.";

export function EpicRunProvenanceChip(props: {
  readonly source: EpicRunConfigProvenanceSource | undefined;
}) {
  return (
    <Badge variant="outline" size="sm" className="font-normal text-muted-foreground">
      {epicRunProvenanceChipLabel(props.source)}
    </Badge>
  );
}

/** Select option sets for the registry keys whose schema is a literal union. */
function selectOptionsFor(key: string): readonly string[] | null {
  if (key === "engine") return EpicRunEngine.literals;
  if (key === "execution.mode") return ExecutionMode.literals;
  if (key === "runtime.mode") return RuntimeMode.literals;
  return null;
}

function EpicRunOptionControl(props: {
  readonly field: EpicRunConfigField;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly onChange: (value: unknown) => void;
  readonly onClear: () => void;
}) {
  const { field, value, disabled } = props;
  switch (field.control) {
    case "toggle":
      return (
        <Switch
          aria-label={field.label}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => props.onChange(Boolean(checked))}
        />
      );
    case "number":
      return (
        <Input
          nativeInput
          type="number"
          inputMode="numeric"
          size="sm"
          aria-label={field.label}
          disabled={disabled}
          className="w-28 tabular-nums"
          value={typeof value === "number" ? String(value) : ""}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === "") {
              // Clearing a number reverts it to the resolved value.
              props.onClear();
              return;
            }
            const parsed = Number(raw);
            if (!Number.isNaN(parsed)) props.onChange(parsed);
          }}
        />
      );
    case "text":
      return (
        <Input
          nativeInput
          type="text"
          size="sm"
          aria-label={field.label}
          disabled={disabled}
          className="w-56"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === "") props.onClear();
            else props.onChange(raw);
          }}
        />
      );
    case "string-list":
      return (
        <Input
          nativeInput
          type="text"
          size="sm"
          aria-label={field.label}
          disabled={disabled}
          placeholder="comma-separated"
          className="w-56"
          value={Array.isArray(value) ? value.map(String).join(", ") : ""}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw.trim() === "") props.onClear();
            else
              props.onChange(
                raw
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter((entry) => entry.length > 0),
              );
          }}
        />
      );
    case "select": {
      const options = selectOptionsFor(field.key);
      if (options === null || typeof value !== "string") {
        // Structured selects (provider.modelSelection) and selects without a
        // known option set stay read-only; editing them is a config-file job.
        return (
          <span className="text-xs text-muted-foreground">
            <span className="font-mono">{formatEpicRunOptionValue(value)}</span>
            {" · Edit in .t3code/epic-run.json"}
          </span>
        );
      }
      return (
        <Select value={value} disabled={disabled} onValueChange={(next) => props.onChange(next)}>
          <SelectTrigger size="xs" aria-label={field.label} className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false} matchTriggerWidth={false}>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      );
    }
  }
}

function EpicRunOptionRow(props: {
  readonly field: EpicRunConfigField;
  readonly value: unknown;
  readonly provenance: EpicRunConfigProvenanceSource | undefined;
  readonly onChange: (value: unknown) => void;
  readonly onClear: () => void;
}) {
  const { field } = props;
  const terminalOnly = field.scope === "terminal-only";
  const control = (
    <EpicRunOptionControl
      field={field}
      value={props.value}
      disabled={terminalOnly}
      onChange={props.onChange}
      onClear={props.onClear}
    />
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5" title={field.doc}>
      <div className="min-w-40 flex-1">
        <div className="text-sm">{field.label}</div>
        {field.enforceableOn !== undefined ? (
          <div className="text-xs text-muted-foreground">
            Enforced on {field.enforceableOn.join("/")} only; not enforced on other providers.
          </div>
        ) : null}
      </div>
      {terminalOnly ? (
        <Tooltip>
          <TooltipTrigger
            render={<span className="inline-flex cursor-not-allowed" />}
            aria-label={TERMINAL_ONLY_REASON}
          >
            {control}
          </TooltipTrigger>
          <TooltipPopup>{TERMINAL_ONLY_REASON}</TooltipPopup>
        </Tooltip>
      ) : (
        control
      )}
      <EpicRunProvenanceChip source={props.provenance} />
    </div>
  );
}

const SCOPE_SECTION_LABELS: Partial<Record<EpicRunConfigField["scope"], string>> = {
  "server-only": "Hosted server",
  "terminal-only": "Terminal coordinator",
};

/**
 * The registry-driven run-options form. Every row comes from
 * EPIC_RUN_CONFIG_FIELDS, so a new registry knob appears here with no UI
 * change. Values prefill from the launch preflight's resolved config; fields
 * the operator touches are tracked by the parent and sent as the launch
 * override.
 */
export function EpicRunOptionsForm(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly epicId: string;
  readonly touched: ReadonlyMap<string, unknown>;
  readonly onFieldChange: (key: string, value: unknown) => void;
  readonly onFieldClear: (key: string) => void;
  readonly onReset: () => void;
}) {
  const preflightRun = useAtomCommand(epicsEnvironment.preflightRun, { reportFailure: false });
  const [resolved, setResolved] = useState<{
    readonly config: EpicRunConfig;
    readonly provenance: EpicRunConfigProvenance;
  } | null>(null);

  // A string, so the effect refetches when the operator flips the run between
  // sequential and parallel, not on every other field they touch.
  const preflightMode = epicRunPreflightModeForConfig(buildEpicRunConfigOverride(props.touched));

  useEffect(() => {
    let cancelled = false;
    void preflightRun({
      environmentId: props.environmentId,
      input: {
        workspaceRoot: props.workspaceRoot,
        epicId: props.epicId,
        mode: preflightMode,
      },
    }).then((result) => {
      if (cancelled) return;
      // A failed preflight still leaves a working form: it falls back to the
      // repo defaults rather than blocking the operator.
      setResolved(
        result._tag === "Success"
          ? { config: result.value.resolvedConfig, provenance: result.value.configProvenance }
          : { config: DEFAULT_EPIC_RUN_CONFIG, provenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [preflightRun, props.environmentId, props.workspaceRoot, props.epicId, preflightMode]);

  if (resolved === null) {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
        <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
        Loading run options…
      </div>
    );
  }

  let previousScope: EpicRunConfigField["scope"] | null = null;
  return (
    <TooltipProvider>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Effective launch configuration. Changes apply to the next run only.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={props.touched.size === 0}
          onClick={props.onReset}
        >
          Reset to repo defaults
        </Button>
      </div>
      <div className="divide-y divide-border/60">
        {EPIC_RUN_CONFIG_FIELDS.map((field) => {
          const section =
            field.scope !== previousScope ? SCOPE_SECTION_LABELS[field.scope] : undefined;
          previousScope = field.scope;
          const touched = props.touched.has(field.key);
          const value = touched
            ? props.touched.get(field.key)
            : epicRunEffectiveValue(resolved.config, field.key);
          return (
            <div key={field.key}>
              {section !== undefined ? (
                <div className="pt-3 pb-1 text-xs font-medium text-muted-foreground">{section}</div>
              ) : null}
              <EpicRunOptionRow
                field={field}
                value={value}
                provenance={touched ? "override" : resolved.provenance[field.key]}
                onChange={(next) => props.onFieldChange(field.key, next)}
                onClear={() => props.onFieldClear(field.key)}
              />
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
