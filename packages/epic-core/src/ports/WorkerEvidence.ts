/**
 * Evidence collection for the liveness state machine.
 *
 * Everything platform-specific in cook-epic's worker supervision lives behind
 * this port: the never-truncated output byte counter, cgroup v2 or /proc
 * resource sampling, the bounded repository probe, the process comm
 * fingerprint, and the locked-down inspector agent. The pure machine in
 * `../workerLiveness.ts` only consumes the evidence and emits decisions.
 *
 * Terminal parity: the COOKEPIC_*_CMD test seams (run-legacy.sh:1197-1199,
 * run-legacy.sh:1281) exist so these operations stay injectable.
 */
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { InspectorLaunchEvidence } from "../inspectorPrompt.ts";
import type { InspectorRunEvidence, WorkerSignalSample } from "../workerLiveness.ts";

export class WorkerEvidenceError extends Schema.TaggedErrorClass<WorkerEvidenceError>()(
  "WorkerEvidenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Everything the dispatching loop knows about a live worker.
 *
 * Passed on every call rather than registered once, so an adapter needs no
 * per-worker state and cannot outlive the run that dispatched the worker.
 */
export interface WorkerRef {
  /** The loop's key for this worker. The server runner uses its thread id. */
  readonly worker: string;
  /**
   * The checkout the worker's commits land in, or `null` when it has none.
   * Without it the repository probe has nowhere to run and reports its
   * timeout marker, which never counts as progress.
   */
  readonly repositoryPath: string | null;
}

export interface WorkerEvidenceShape {
  /**
   * Whether this harness can launch the locked-down inspector at all.
   *
   * Feeds `WorkerLivenessConfig.inspectorSupported`. Codex answers false: it
   * cannot enforce the no-tool contract, so the machine records an uncertain
   * reason instead of launching (run-legacy.sh:1427-1430). The adapter that
   * would run the inspector is the only honest source for this.
   */
  readonly inspectorSupported: boolean;
  /**
   * One tick of activity signals. `outputBytes` is the cumulative counter
   * that survives tail compaction (run-legacy.sh:946-949); `cpuUsec` and
   * `ioBytes` come from cgroup v2 cpu.stat/io.stat or /proc (run-legacy.sh:1195-1222).
   */
  readonly sampleSignals: (
    ref: WorkerRef,
  ) => Effect.Effect<WorkerSignalSample, WorkerEvidenceError>;
  /**
   * The bounded repository probe: git status plus diff checksum plus HEAD,
   * folded to one checksum line. Any timeout yields the literal
   * `hash=probe-timeout` (run-legacy.sh:1224-1240).
   */
  readonly probeRepository: (ref: WorkerRef) => Effect.Effect<string, WorkerEvidenceError>;
  /**
   * sha256 of the process comm histogram with sleep and timeout filtered
   * out, or `unavailable` when no process is live (run-legacy.sh:1302-1315).
   */
  readonly processFingerprint: (ref: WorkerRef) => Effect.Effect<string, WorkerEvidenceError>;
  /** True while a provider fallback is pending; inspections pause (run-legacy.sh:1790). */
  readonly providerFallbackPending: Effect.Effect<boolean, WorkerEvidenceError>;
  /**
   * Launch the read-only inspector agent. Prompt rendering passes only
   * structural evidence — never raw worker text, argv, environment, URLs or
   * file contents (run-legacy.sh:1321-1354). The agent runs with tools denied
   * (run-legacy.sh:1394-1416).
   *
   * Must return once the inspector is running, not once it has finished:
   * `inspectorStatus` reports its progress and `stopInspector` ends it.
   */
  readonly launchInspector: (
    ref: WorkerRef,
    input: {
      readonly timeoutSeconds: number;
      /** The machine's own structural snapshot; the prompt renders from it. */
      readonly evidence: InspectorLaunchEvidence;
    },
  ) => Effect.Effect<void, WorkerEvidenceError>;
  /** Inspector lifecycle state for the current tick. */
  readonly inspectorStatus: (
    ref: WorkerRef,
  ) => Effect.Effect<InspectorRunEvidence, WorkerEvidenceError>;
  /** Kill an inspector that exceeded its timeout (run-legacy.sh:1574-1587). */
  readonly stopInspector: (ref: WorkerRef) => Effect.Effect<void, WorkerEvidenceError>;
}
