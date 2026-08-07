/**
 * Optional systemd scope governance for epic workers.
 *
 * Ported from the terminal coordinator (`skills/cook-epic/run-legacy.sh`, resource
 * governance at run-legacy.sh:763-790 and `fleet_run` at run-legacy.sh:792-804), following
 * the supervision research verdict on t3code-06s.20: each worker leaves the
 * coordinator's cgroup for a named scope under the machine-global
 * `cook-epic.slice`, so the interactive session always wins CPU contention.
 * The server unit itself never joins the throttled slice.
 *
 * Only the controllers this host family delegates are set: CPUWeight and
 * MemoryHigh. IOWeight is deliberately not ported — the io controller is not
 * delegated on the reference host, so setting it would be cargo cult.
 *
 * Governance is a nicety, never a precondition: a non-Linux host, a missing
 * systemd user manager, or a set-property failure logs a warning and the
 * spawn proceeds unwrapped. The one fatal case is an identity collision — a
 * pre-existing scope matching this run's identity means a crashed run's
 * workers (or a live identity clash) must be reconciled, mirroring
 * run-legacy.sh:777-781.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { ProcessRunner } from "./processRunner.ts";

/** run-legacy.sh passes `--slice=cook-epic`; systemd resolves it to cook-epic.slice. */
export const WORKER_SCOPE_SLICE = "cook-epic";
export const WORKER_SCOPE_SLICE_UNIT = "cook-epic.slice";
/** Defaults mirror run-legacy.sh `COOKEPIC_CPU_WEIGHT` / `COOKEPIC_MEMORY_HIGH`. */
export const WORKER_SCOPE_CPU_WEIGHT = 50;
export const WORKER_SCOPE_MEMORY_HIGH = "60%";

const COMMAND_TIMEOUT = Duration.seconds(10);

export interface WorkerScopeIdentity {
  readonly repositoryPath: string;
  readonly runDirectory: string;
  readonly epicId: string;
  readonly runId: string;
}

/**
 * The run-identity hash that keeps scope names unique without collapsing
 * distinct repositories or run paths onto a lossy basename. NUL separators
 * make the tuple unambiguous (run-legacy.sh:286-291).
 */
export const deriveWorkerScopeId = (identity: WorkerScopeIdentity): string =>
  NodeCrypto.createHash("sha256")
    .update(
      `${identity.repositoryPath}\0${identity.runDirectory}\0${identity.epicId}\0${identity.runId}\0`,
    )
    .digest("hex")
    .slice(0, 24);

const sanitizeUnitComponent = (worker: string): string =>
  worker.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");

/** run.sh `worker_unit` (run-legacy.sh:1136): `cook-epic-<scopeId>-<worker>.scope`. */
export const workerScopeUnitName = (scopeId: string, worker: string): string =>
  `cook-epic-${scopeId}-${sanitizeUnitComponent(worker)}.scope`;

/** A pre-existing scope already uses this run identity (run-legacy.sh:777-781). */
export class WorkerScopeCollisionError extends Schema.TaggedErrorClass<WorkerScopeCollisionError>()(
  "WorkerScopeCollisionError",
  {
    scopeId: Schema.String,
    detail: Schema.String,
  },
) {}

export interface WorkerScopePreparation {
  readonly scopeId: string;
  /** When false, spawns proceed unwrapped (fail-soft degradation). */
  readonly active: boolean;
}

const INACTIVE = (scopeId: string): WorkerScopePreparation => ({ scopeId, active: false });

/**
 * Probe the systemd user manager, refuse identity collisions, and set the
 * slice limits once for the run. Everything except a collision degrades to an
 * inactive preparation with a warning.
 */
export const prepareWorkerScope = Effect.fn("workerScope.prepare")(function* (
  identity: WorkerScopeIdentity,
) {
  const scopeId = deriveWorkerScopeId(identity);
  const platform = yield* HostProcessPlatform;
  if (platform !== "linux") {
    yield* Effect.logWarning("epic.worker-scope.unsupported-platform", {
      scopeId,
      platform,
      detail: "systemd scope governance requires a Linux systemd user manager",
    });
    return INACTIVE(scopeId);
  }
  const runner = yield* ProcessRunner;

  // The probe mirrors run-legacy.sh:775-776: `systemd-run --user --scope --quiet --
  // true` must succeed, which covers both a missing binary and a missing user
  // manager.
  const probe = yield* runner
    .run({
      command: "systemd-run",
      args: ["--user", "--scope", "--quiet", "--", "true"],
      timeout: COMMAND_TIMEOUT,
    })
    .pipe(Effect.orElseSucceed(() => null));
  if (probe === null || probe.code !== 0) {
    yield* Effect.logWarning("epic.worker-scope.probe-failed", {
      scopeId,
      detail: probe === null ? "systemd-run could not be executed" : probe.stderr.trim(),
    });
    return INACTIVE(scopeId);
  }

  const existing = yield* runner
    .run({
      command: "systemctl",
      args: [
        "--user",
        "list-units",
        "--all",
        "--plain",
        "--no-legend",
        "--no-pager",
        `cook-epic-${scopeId}-*.scope`,
      ],
      timeout: COMMAND_TIMEOUT,
    })
    .pipe(Effect.orElseSucceed(() => null));
  if (existing !== null && existing.code === 0 && existing.stdout.trim() !== "") {
    return yield* new WorkerScopeCollisionError({
      scopeId,
      detail:
        `pre-existing worker or inspector scope uses run identity ${scopeId}: ` +
        `${existing.stdout.trim().split("\n")[0] ?? ""}`,
    });
  }

  // Only the delegated controllers are set (t3code-06s.20 verdict): the io
  // controller is not delegated on the reference host, so IOWeight is not
  // ported. A failure here only warns; scoping continues without limits.
  const properties = yield* runner
    .run({
      command: "systemctl",
      args: [
        "--user",
        "set-property",
        "--runtime",
        WORKER_SCOPE_SLICE_UNIT,
        `CPUWeight=${String(WORKER_SCOPE_CPU_WEIGHT)}`,
        `MemoryHigh=${WORKER_SCOPE_MEMORY_HIGH}`,
      ],
      timeout: COMMAND_TIMEOUT,
    })
    .pipe(Effect.orElseSucceed(() => null));
  if (properties === null || properties.code !== 0) {
    yield* Effect.logWarning("epic.worker-scope.set-property-failed", {
      scopeId,
      slice: WORKER_SCOPE_SLICE_UNIT,
      detail:
        properties === null
          ? "systemctl set-property could not be executed"
          : properties.stderr.trim(),
    });
  }
  return { scopeId, active: true };
});

/**
 * Wrap a worker spawn in its named scope (run.sh `fleet_run`, run-legacy.sh:792-804).
 * The unit name is the ownership seam: it lets a supervisor later ask systemd
 * whether this exact worker is alive and stop it rather than orphan it.
 */
export const wrapWorkerScopeSpawn = (
  preparation: WorkerScopePreparation,
  worker: string,
  command: string,
  args: ReadonlyArray<string>,
): { readonly command: string; readonly args: ReadonlyArray<string> } =>
  preparation.active
    ? {
        command: "systemd-run",
        args: [
          "--user",
          "--scope",
          "--quiet",
          `--slice=${WORKER_SCOPE_SLICE}`,
          `--unit=${workerScopeUnitName(preparation.scopeId, worker)}`,
          "--",
          command,
          ...args,
        ],
      }
    : { command, args };
