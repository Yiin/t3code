/**
 * Evidence collection for the liveness state machine.
 *
 * Everything platform-specific in cook-epic's worker supervision lives behind
 * this port: the never-truncated output byte counter, cgroup v2 or /proc
 * resource sampling, the bounded repository probe, the process comm
 * fingerprint, and the locked-down inspector agent. The pure machine in
 * `../workerLiveness.ts` only consumes the evidence and emits decisions.
 *
 * Terminal parity: the COOKEPIC_*_CMD test seams (run.sh:1363-1365,
 * run.sh:1447) exist so these operations stay injectable.
 */
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { InspectorRunEvidence, WorkerSignalSample } from "../workerLiveness.ts";

export class WorkerEvidenceError extends Schema.TaggedErrorClass<WorkerEvidenceError>()(
  "WorkerEvidenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface WorkerEvidenceShape {
  /**
   * One tick of activity signals. `outputBytes` is the cumulative counter
   * that survives tail compaction (run.sh:1112-1115); `cpuUsec` and
   * `ioBytes` come from cgroup v2 cpu.stat/io.stat or /proc (run.sh:1361-1388).
   */
  readonly sampleSignals: (
    worker: string,
  ) => Effect.Effect<WorkerSignalSample, WorkerEvidenceError>;
  /**
   * The bounded repository probe: git status plus diff checksum plus HEAD,
   * folded to one checksum line. Any timeout yields the literal
   * `hash=probe-timeout` (run.sh:1390-1406).
   */
  readonly probeRepository: (worker: string) => Effect.Effect<string, WorkerEvidenceError>;
  /**
   * sha256 of the process comm histogram with sleep and timeout filtered
   * out, or `unavailable` when no process is live (run.sh:1468-1481).
   */
  readonly processFingerprint: (worker: string) => Effect.Effect<string, WorkerEvidenceError>;
  /** True while a provider fallback is pending; inspections pause (run.sh:1956). */
  readonly providerFallbackPending: Effect.Effect<boolean, WorkerEvidenceError>;
  /**
   * Launch the read-only inspector agent. Prompt rendering passes only
   * structural evidence — never raw worker text, argv, environment, URLs or
   * file contents (run.sh:1487-1520). The agent runs with tools denied
   * (run.sh:1560-1582).
   */
  readonly launchInspector: (
    worker: string,
    input: { readonly timeoutSeconds: number },
  ) => Effect.Effect<void, WorkerEvidenceError>;
  /** Inspector lifecycle state for the current tick. */
  readonly inspectorStatus: (
    worker: string,
  ) => Effect.Effect<InspectorRunEvidence, WorkerEvidenceError>;
  /** Kill an inspector that exceeded its timeout (run.sh:1740-1753). */
  readonly stopInspector: (worker: string) => Effect.Effect<void, WorkerEvidenceError>;
}
