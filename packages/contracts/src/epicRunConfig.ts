import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection, RuntimeMode } from "./orchestration.ts";

const defaultTo = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
  schema.pipe(Schema.withDecodingDefault(Effect.succeed(value)));

const defaultStruct = <S extends Schema.Top>(schema: S) =>
  schema.pipe(Schema.withDecodingDefault(Effect.succeed({} as S["Encoded"])));

const PositiveFiniteNumber = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0));

const RelativePath = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) => {
    if (/^(?:[a-zA-Z]:|[\\/])/.test(value)) {
      return "Expected a repository-relative path.";
    }

    return undefined;
  }),
);

const RepositoryContainedPath = RelativePath.check(
  Schema.makeFilter((value) => {
    let depth = 0;
    for (const segment of value.split(/[\\/]+/)) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        if (depth === 0) return "The path must not escape the repository.";
        depth -= 1;
      } else {
        depth += 1;
      }
    }
    return undefined;
  }),
);

// Shared leaf schemas. Both the complete config and override schemas use these
// definitions so their accepted values cannot drift.
const BudgetUsd = Schema.NullOr(PositiveFiniteNumber);
const GateCommand = Schema.NullOr(TrimmedNonEmptyString);
const GateDisabled = Schema.Boolean;
const IdleThresholdSeconds = PositiveInt;
const InspectorTimeoutSeconds = PositiveInt;
const InspectMaxDelaySeconds = PositiveInt;
const InspectMinDelaySeconds = PositiveInt;
const InspectRetryDelaySeconds = PositiveInt;
const StopGraceSeconds = PositiveInt;
const WorkerTimeoutSeconds = Schema.NullOr(PositiveInt);
const MaxAttemptsPerChild = PositiveInt;
const MaxIterations = PositiveInt;
const ProviderModelSelection = Schema.NullOr(ModelSelection);
const NoPush = Schema.Boolean;
const OrientationFile = Schema.NullOr(RepositoryContainedPath);
const ExecutionSequential = Schema.Boolean;
const ParallelSiblings = Schema.Array(RelativePath).check(Schema.isUnique());
const ParallelWorkers = PositiveInt;
const RuntimeModeSchema = RuntimeMode;
const RateLimitBackoffSeconds = NonNegativeInt;
const LockHeartbeatSeconds = PositiveInt;
const LockStaleSeconds = PositiveInt;
const MaxConsecutiveFailures = PositiveInt;
const MaxNoCommitStreak = PositiveInt;
const InfraFailureBudget = PositiveInt;
const PollIntervalMs = PositiveInt;
const QuietPeriodMs = PositiveInt;
const RetryBaseDelayMs = PositiveInt;
const RetryMaxDelayMs = PositiveInt;
const SubagentGraceTimeoutMs = PositiveInt;
const MaxGraceContinuations = PositiveInt;
const ProviderDegradationTtlMs = NonNegativeInt;

const BudgetConfig = Schema.Struct({
  usd: defaultTo(BudgetUsd, null),
});

const GateConfig = Schema.Struct({
  command: defaultTo(GateCommand, null),
  disabled: defaultTo(GateDisabled, false),
});

const SupervisionConfig = Schema.Struct({
  idleThresholdSeconds: defaultTo(IdleThresholdSeconds, 1_800),
  inspectorTimeoutSeconds: defaultTo(InspectorTimeoutSeconds, 120),
  inspectMaxDelaySeconds: defaultTo(InspectMaxDelaySeconds, 7_200),
  inspectMinDelaySeconds: defaultTo(InspectMinDelaySeconds, 60),
  inspectRetryDelaySeconds: defaultTo(InspectRetryDelaySeconds, 300),
  stopGraceSeconds: defaultTo(StopGraceSeconds, 15),
  workerTimeoutSeconds: defaultTo(WorkerTimeoutSeconds, null),
});

const LimitsConfig = Schema.Struct({
  maxAttemptsPerChild: defaultTo(MaxAttemptsPerChild, 3),
  maxIterations: defaultTo(MaxIterations, 50),
});

const ProviderConfig = Schema.Struct({
  modelSelection: defaultTo(ProviderModelSelection, null),
});

const VcsConfig = Schema.Struct({
  noPush: defaultTo(NoPush, false),
});

const OrientationConfig = Schema.Struct({
  file: defaultTo(OrientationFile, null),
});

const ExecutionConfig = Schema.Struct({
  sequential: defaultTo(ExecutionSequential, false),
});

const ParallelConfig = Schema.Struct({
  siblings: defaultTo(ParallelSiblings, []),
  workers: defaultTo(ParallelWorkers, 3),
});

const RuntimeConfig = Schema.Struct({
  mode: defaultTo(RuntimeModeSchema, "full-access"),
});

const RetryConfig = Schema.Struct({
  rateLimitBackoffSeconds: defaultTo(RateLimitBackoffSeconds, 120),
});

const LockConfig = Schema.Struct({
  heartbeatSeconds: defaultTo(LockHeartbeatSeconds, 30),
  staleSeconds: defaultTo(LockStaleSeconds, 300),
});

const ServerConfig = Schema.Struct({
  maxConsecutiveFailures: defaultTo(MaxConsecutiveFailures, 3),
  maxNoCommitStreak: defaultTo(MaxNoCommitStreak, 2),
  /**
   * This budget exceeds the ordinary child failure budget so infrastructure
   * faults do not look like child failures. It remains finite to stop bad runs.
   */
  infraFailureBudget: defaultTo(InfraFailureBudget, 5),
  pollIntervalMs: defaultTo(PollIntervalMs, 2_000),
  quietPeriodMs: defaultTo(QuietPeriodMs, 1_000),
  retryBaseDelayMs: defaultTo(RetryBaseDelayMs, 10_000),
  retryMaxDelayMs: defaultTo(RetryMaxDelayMs, 300_000),
  subagentGraceTimeoutMs: defaultTo(SubagentGraceTimeoutMs, 900_000),
  maxGraceContinuations: defaultTo(MaxGraceContinuations, 10),
  providerDegradationTtlMs: defaultTo(ProviderDegradationTtlMs, 3_600_000),
});

export const EpicRunConfig = Schema.Struct({
  budget: defaultStruct(BudgetConfig),
  gate: defaultStruct(GateConfig),
  supervision: defaultStruct(SupervisionConfig),
  limits: defaultStruct(LimitsConfig),
  provider: defaultStruct(ProviderConfig),
  vcs: defaultStruct(VcsConfig),
  orientation: defaultStruct(OrientationConfig),
  execution: defaultStruct(ExecutionConfig),
  parallel: defaultStruct(ParallelConfig),
  runtime: defaultStruct(RuntimeConfig),
  retry: defaultStruct(RetryConfig),
  lock: defaultStruct(LockConfig),
  server: defaultStruct(ServerConfig),
});
export type EpicRunConfig = typeof EpicRunConfig.Type;

export const DEFAULT_EPIC_RUN_CONFIG: EpicRunConfig = Schema.decodeUnknownSync(EpicRunConfig)({});

export const EpicRunConfigOverride = Schema.Struct({
  budget: Schema.optionalKey(
    Schema.Struct({
      usd: Schema.optionalKey(BudgetUsd),
    }),
  ),
  gate: Schema.optionalKey(
    Schema.Struct({
      command: Schema.optionalKey(GateCommand),
      disabled: Schema.optionalKey(GateDisabled),
    }),
  ),
  supervision: Schema.optionalKey(
    Schema.Struct({
      idleThresholdSeconds: Schema.optionalKey(IdleThresholdSeconds),
      inspectorTimeoutSeconds: Schema.optionalKey(InspectorTimeoutSeconds),
      inspectMaxDelaySeconds: Schema.optionalKey(InspectMaxDelaySeconds),
      inspectMinDelaySeconds: Schema.optionalKey(InspectMinDelaySeconds),
      inspectRetryDelaySeconds: Schema.optionalKey(InspectRetryDelaySeconds),
      stopGraceSeconds: Schema.optionalKey(StopGraceSeconds),
      workerTimeoutSeconds: Schema.optionalKey(WorkerTimeoutSeconds),
    }),
  ),
  limits: Schema.optionalKey(
    Schema.Struct({
      maxAttemptsPerChild: Schema.optionalKey(MaxAttemptsPerChild),
      maxIterations: Schema.optionalKey(MaxIterations),
    }),
  ),
  provider: Schema.optionalKey(
    Schema.Struct({
      modelSelection: Schema.optionalKey(ProviderModelSelection),
    }),
  ),
  vcs: Schema.optionalKey(
    Schema.Struct({
      noPush: Schema.optionalKey(NoPush),
    }),
  ),
  orientation: Schema.optionalKey(
    Schema.Struct({
      file: Schema.optionalKey(OrientationFile),
    }),
  ),
  execution: Schema.optionalKey(
    Schema.Struct({
      sequential: Schema.optionalKey(ExecutionSequential),
    }),
  ),
  parallel: Schema.optionalKey(
    Schema.Struct({
      siblings: Schema.optionalKey(ParallelSiblings),
      workers: Schema.optionalKey(ParallelWorkers),
    }),
  ),
  runtime: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(RuntimeModeSchema),
    }),
  ),
  retry: Schema.optionalKey(
    Schema.Struct({
      rateLimitBackoffSeconds: Schema.optionalKey(RateLimitBackoffSeconds),
    }),
  ),
  lock: Schema.optionalKey(
    Schema.Struct({
      heartbeatSeconds: Schema.optionalKey(LockHeartbeatSeconds),
      staleSeconds: Schema.optionalKey(LockStaleSeconds),
    }),
  ),
  server: Schema.optionalKey(
    Schema.Struct({
      maxConsecutiveFailures: Schema.optionalKey(MaxConsecutiveFailures),
      maxNoCommitStreak: Schema.optionalKey(MaxNoCommitStreak),
      infraFailureBudget: Schema.optionalKey(InfraFailureBudget),
      pollIntervalMs: Schema.optionalKey(PollIntervalMs),
      quietPeriodMs: Schema.optionalKey(QuietPeriodMs),
      retryBaseDelayMs: Schema.optionalKey(RetryBaseDelayMs),
      retryMaxDelayMs: Schema.optionalKey(RetryMaxDelayMs),
      subagentGraceTimeoutMs: Schema.optionalKey(SubagentGraceTimeoutMs),
      maxGraceContinuations: Schema.optionalKey(MaxGraceContinuations),
      providerDegradationTtlMs: Schema.optionalKey(ProviderDegradationTtlMs),
    }),
  ),
});
export type EpicRunConfigOverride = typeof EpicRunConfigOverride.Type;

export type EpicRunConfigFieldScope = "core" | "core-partial" | "server-only" | "terminal-only";

export type EpicRunConfigControl = "toggle" | "number" | "text" | "select" | "string-list";

export interface EpicRunConfigField {
  readonly key: string;
  readonly scope: EpicRunConfigFieldScope;
  readonly label: string;
  readonly doc: string;
  readonly control: EpicRunConfigControl;
  readonly enforceableOn?: readonly string[];
}

export const EPIC_RUN_CONFIG_FIELDS: readonly EpicRunConfigField[] = [
  {
    key: "budget.usd",
    scope: "core-partial",
    label: "Budget (USD)",
    doc: "Stops new dispatches after the soft cost cap.",
    control: "number",
    enforceableOn: ["claude", "ccx"],
  },
  {
    key: "gate.command",
    scope: "core",
    label: "Gate command",
    doc: "Runs the full integration gate before each landing.",
    control: "text",
  },
  {
    key: "gate.disabled",
    scope: "core",
    label: "Disable gate",
    doc: "Allows unverified landing when the operator explicitly requests it.",
    control: "toggle",
  },
  {
    key: "supervision.idleThresholdSeconds",
    scope: "core",
    label: "Idle threshold",
    doc: "Starts liveness inspection after this many idle seconds.",
    control: "number",
  },
  {
    key: "supervision.inspectorTimeoutSeconds",
    scope: "core",
    label: "Inspector timeout",
    doc: "Limits one inspector invocation in seconds.",
    control: "number",
  },
  {
    key: "supervision.inspectMaxDelaySeconds",
    scope: "core",
    label: "Maximum inspect delay",
    doc: "Sets the upper delay for an inspector-requested next check.",
    control: "number",
  },
  {
    key: "supervision.inspectMinDelaySeconds",
    scope: "core",
    label: "Minimum inspect delay",
    doc: "Sets the lower delay for an inspector-requested next check.",
    control: "number",
  },
  {
    key: "supervision.inspectRetryDelaySeconds",
    scope: "core",
    label: "Inspect retry delay",
    doc: "Delays the next check after an unsuccessful inspection.",
    control: "number",
  },
  {
    key: "supervision.stopGraceSeconds",
    scope: "core",
    label: "Stop grace",
    doc: "Sets the wait after TERM and before KILL in seconds.",
    control: "number",
  },
  {
    key: "supervision.workerTimeoutSeconds",
    scope: "core",
    label: "Worker timeout",
    doc: "Sets the absolute worker or hosted iteration limit in seconds.",
    control: "number",
  },
  {
    key: "limits.maxAttemptsPerChild",
    scope: "core",
    label: "Maximum attempts per child",
    doc: "Blocks one child after this many ordinary failed attempts.",
    control: "number",
  },
  {
    key: "limits.maxIterations",
    scope: "core",
    label: "Maximum iterations",
    doc: "Caps provider dispatch attempts across the full run.",
    control: "number",
  },
  {
    key: "provider.modelSelection",
    scope: "core",
    label: "Model",
    doc: "Selects the primary provider instance and model.",
    control: "select",
  },
  {
    key: "vcs.noPush",
    scope: "core",
    label: "Do not push",
    doc: "Lands changes locally without pushing repositories.",
    control: "toggle",
  },
  {
    key: "orientation.file",
    scope: "core",
    label: "Orientation file",
    doc: "Overrides the repository orientation card search.",
    control: "text",
  },
  {
    key: "runtime.mode",
    scope: "core",
    label: "Runtime mode",
    doc: "Sets the shared runtime permission mode.",
    control: "select",
  },
  {
    key: "retry.rateLimitBackoffSeconds",
    scope: "core",
    label: "Rate limit backoff",
    doc: "Delays a rate-limited child when no fallback remains.",
    control: "number",
  },
  {
    key: "execution.sequential",
    scope: "core",
    label: "Sequential execution",
    doc: "Runs one worker in the base checkout.",
    control: "toggle",
  },
  {
    key: "parallel.siblings",
    scope: "core",
    label: "Sibling repositories",
    doc: "Registers sibling repositories for atomic parallel work.",
    control: "string-list",
  },
  {
    key: "parallel.workers",
    scope: "core",
    label: "Workers",
    doc: "Sets the initial concurrent worker cap.",
    control: "number",
  },
  {
    key: "lock.heartbeatSeconds",
    scope: "core",
    label: "Lock heartbeat",
    doc: "Sets the shared epic lock heartbeat interval.",
    control: "number",
  },
  {
    key: "lock.staleSeconds",
    scope: "core",
    label: "Lock stale threshold",
    doc: "Sets when an unrefreshed local lock becomes stale.",
    control: "number",
  },
  {
    key: "server.maxConsecutiveFailures",
    scope: "server-only",
    label: "Maximum consecutive failures",
    doc: "Fails a hosted run after repeated ordinary child failures.",
    control: "number",
  },
  {
    key: "server.maxNoCommitStreak",
    scope: "server-only",
    label: "Maximum no-commit streak",
    doc: "Fails a hosted run after repeated no-commit outcomes.",
    control: "number",
  },
  {
    key: "server.infraFailureBudget",
    scope: "server-only",
    label: "Infrastructure failure budget",
    doc: "Allows more infrastructure failures than ordinary child failures before the hosted run stops.",
    control: "number",
  },
  {
    key: "server.pollIntervalMs",
    scope: "server-only",
    label: "Poll interval",
    doc: "Sets hosted turn and subagent polling intervals.",
    control: "number",
  },
  {
    key: "server.quietPeriodMs",
    scope: "server-only",
    label: "Quiet period",
    doc: "Waits for projection output before classifying a turn.",
    control: "number",
  },
  {
    key: "server.retryBaseDelayMs",
    scope: "server-only",
    label: "Retry base delay",
    doc: "Sets the first hosted retry delay.",
    control: "number",
  },
  {
    key: "server.retryMaxDelayMs",
    scope: "server-only",
    label: "Retry maximum delay",
    doc: "Caps the hosted exponential retry delay.",
    control: "number",
  },
  {
    key: "server.subagentGraceTimeoutMs",
    scope: "server-only",
    label: "Subagent grace timeout",
    doc: "Limits how long the runner waits for live subagents.",
    control: "number",
  },
  {
    key: "server.maxGraceContinuations",
    scope: "server-only",
    label: "Maximum grace continuations",
    doc: "Caps follow-up turns after subagent grace waits.",
    control: "number",
  },
  {
    key: "server.providerDegradationTtlMs",
    scope: "server-only",
    label: "Provider degradation lifetime",
    doc: "Keeps a degraded provider out of new hosted launches.",
    control: "number",
  },
  {
    key: "terminal.binary",
    scope: "terminal-only",
    label: "Harness binary",
    doc: "Overrides the primary terminal harness executable.",
    control: "text",
  },
  {
    key: "terminal.clockCommand",
    scope: "terminal-only",
    label: "Clock command",
    doc: "Replaces the epoch clock in shell tests.",
    control: "text",
  },
  {
    key: "terminal.cpuWeight",
    scope: "terminal-only",
    label: "CPU weight",
    doc: "Sets CPUWeight on the terminal worker slice.",
    control: "number",
  },
  {
    key: "terminal.disableSystemd",
    scope: "terminal-only",
    label: "Disable systemd",
    doc: "Forces the process-group fallback in shell tests.",
    control: "toggle",
  },
  {
    key: "terminal.foldCommand",
    scope: "terminal-only",
    label: "Fold command",
    doc: "Replaces the fold harness in shell tests.",
    control: "text",
  },
  {
    key: "terminal.foldTimeoutSeconds",
    scope: "terminal-only",
    label: "Fold timeout",
    doc: "Limits one fold invocation in seconds.",
    control: "number",
  },
  {
    key: "terminal.harness",
    scope: "terminal-only",
    label: "Terminal harness",
    doc: "Selects or detects the terminal harness.",
    control: "select",
  },
  {
    key: "terminal.inspectorCommand",
    scope: "terminal-only",
    label: "Inspector command",
    doc: "Replaces the inspector harness in shell tests.",
    control: "text",
  },
  {
    key: "terminal.inspectorLogBytes",
    scope: "terminal-only",
    label: "Inspector log bytes",
    doc: "Caps the rolling raw inspector log.",
    control: "number",
  },
  {
    key: "terminal.inspectorResultBytes",
    scope: "terminal-only",
    label: "Inspector result bytes",
    doc: "Caps one inspector result.",
    control: "number",
  },
  {
    key: "terminal.memoryHigh",
    scope: "terminal-only",
    label: "Memory high",
    doc: "Sets MemoryHigh on the terminal worker slice.",
    control: "text",
  },
  {
    key: "terminal.processStartTicksCommand",
    scope: "terminal-only",
    label: "Process start ticks command",
    doc: "Replaces process start-tick lookup in shell tests.",
    control: "text",
  },
  {
    key: "terminal.pushCommand",
    scope: "terminal-only",
    label: "Push command",
    doc: "Replaces git push in shell tests.",
    control: "text",
  },
  {
    key: "terminal.repoEvidenceBytes",
    scope: "terminal-only",
    label: "Repository evidence bytes",
    doc: "Caps repository evidence supplied to one inspector.",
    control: "number",
  },
  {
    key: "terminal.repoProbeIntervalSeconds",
    scope: "terminal-only",
    label: "Repository probe interval",
    doc: "Limits how often quiet workers trigger a repository probe.",
    control: "number",
  },
  {
    key: "terminal.repoProbeTimeoutSeconds",
    scope: "terminal-only",
    label: "Repository probe timeout",
    doc: "Limits one repository probe in seconds.",
    control: "number",
  },
  {
    key: "terminal.resourceSamplerCommand",
    scope: "terminal-only",
    label: "Resource sampler command",
    doc: "Replaces worker resource sampling in shell tests.",
    control: "text",
  },
  {
    key: "terminal.runnerPath",
    scope: "terminal-only",
    label: "Runner path",
    doc: "Pins the canonical terminal coordinator script.",
    control: "text",
  },
  {
    key: "terminal.spawnDelaySeconds",
    scope: "terminal-only",
    label: "Spawn delay",
    doc: "Spaces terminal worker launches in seconds.",
    control: "number",
  },
  {
    key: "terminal.supervisionTickSeconds",
    scope: "terminal-only",
    label: "Supervision tick",
    doc: "Sets the shell supervisor polling interval.",
    control: "number",
  },
  {
    key: "terminal.workersActiveCommand",
    scope: "terminal-only",
    label: "Workers active command",
    doc: "Replaces worker liveness lookup in shell tests.",
    control: "text",
  },
  {
    key: "terminal.workerArtifactBytes",
    scope: "terminal-only",
    label: "Worker artifact bytes",
    doc: "Caps the rolling worker output tail.",
    control: "number",
  },
  {
    key: "terminal.workerCommand",
    scope: "terminal-only",
    label: "Worker command",
    doc: "Replaces the agent harness in shell tests.",
    control: "text",
  },
  {
    key: "terminal.workerStopCommand",
    scope: "terminal-only",
    label: "Worker stop command",
    doc: "Replaces worker cleanup in shell tests.",
    control: "text",
  },
];

export const EpicRunConfigProvenanceSource = Schema.Literals([
  "default",
  "file",
  "environment",
  "override",
  "policy",
]);
export type EpicRunConfigProvenanceSource = typeof EpicRunConfigProvenanceSource.Type;

export const EpicRunConfigProvenance = Schema.Record(Schema.String, EpicRunConfigProvenanceSource);
export type EpicRunConfigProvenance = typeof EpicRunConfigProvenance.Type;

/** Exhaustive provenance for a run decoded without a persisted config snapshot. */
export const DEFAULT_EPIC_RUN_CONFIG_PROVENANCE: EpicRunConfigProvenance = Object.fromEntries(
  EPIC_RUN_CONFIG_FIELDS.filter((field) => field.scope !== "terminal-only").map((field) => [
    field.key,
    "default" as const,
  ]),
);
