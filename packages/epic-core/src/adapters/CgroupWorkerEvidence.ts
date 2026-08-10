/**
 * The production `WorkerEvidence` port for hosts that give each worker its own
 * cgroup v2 unit.
 *
 * `workerScope.ts` already puts every epic worker in a named systemd scope
 * under `cook-epic.slice`, so `cpu.stat`, `io.stat` and `cgroup.procs` under
 * that scope's cgroup directory are the per-worker activity signals the
 * liveness machine asks for. This is exactly the evidence the 2026-08-09
 * incident was diagnosed from by hand: scope CPU moved 0.8 seconds across 12
 * minutes of wall clock while every process sat in state `Sl`.
 *
 * Every read degrades rather than lies. A missing cgroup, an unreadable file
 * or a git probe that overruns its budget reports the machine's documented
 * "I could not tell" values, never a value that could confirm a stop.
 *
 * The inspector is not wired here. No harness in this repo can currently
 * enforce the inspector's no-tool contract, so `inspectorSupported` is false
 * and the machine records an uncertain reason instead of launching. Raising
 * that ceiling is `t3code-77b`.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type * as ProcessRunner from "../processRunner.ts";
import type {
  WorkerEvidenceError,
  WorkerEvidenceShape,
  WorkerRef,
} from "../ports/WorkerEvidence.ts";
import {
  PROCESS_FINGERPRINT_UNAVAILABLE,
  REPO_PROBE_TIMEOUT_MARKER,
  type InspectorRunEvidence,
  type WorkerSignalSample,
} from "../workerLiveness.ts";

/** Comm names that say nothing about progress (run-legacy.sh:1302-1315). */
const FINGERPRINT_IGNORED_COMMS = new Set(["sleep", "timeout"]);

/**
 * `usage_usec` from a cgroup v2 `cpu.stat`, or `null` when absent.
 *
 * Total CPU time the whole scope has ever consumed. The machine compares
 * successive readings, so only the delta matters.
 */
export const parseCgroupCpuUsec = (cpuStat: string): number | null => {
  for (const line of cpuStat.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key !== "usage_usec" || value === undefined) continue;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * Total bytes read plus written across every device in a cgroup v2 `io.stat`.
 *
 * `io.stat` is empty when the io controller is not delegated, which is the
 * case on the reference host (`workerScope.ts:14-16`). Zero is the honest
 * answer there: it contributes no progress rather than false progress.
 */
export const parseCgroupIoBytes = (ioStat: string): number => {
  let total = 0;
  for (const match of ioStat.matchAll(/\b([rw])bytes=(\d+)/g)) {
    const parsed = Number.parseInt(match[2] ?? "", 10);
    if (Number.isFinite(parsed)) total += parsed;
  }
  return total;
};

/** Process ids from a cgroup v2 `cgroup.procs`. */
export const parseCgroupProcs = (procs: string): ReadonlyArray<string> =>
  procs
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));

/**
 * sha256 of the process comm histogram (run-legacy.sh:1302-1315).
 *
 * A histogram, not a list: the machine only needs to know whether the worker's
 * process shape changed while an inspection ran, and pid churn alone must not
 * read as change. Sorting makes the digest order-independent.
 */
export const processCommFingerprint = (comms: ReadonlyArray<string>): string => {
  const histogram = new Map<string, number>();
  for (const raw of comms) {
    const comm = raw.trim();
    if (comm.length === 0 || FINGERPRINT_IGNORED_COMMS.has(comm)) continue;
    histogram.set(comm, (histogram.get(comm) ?? 0) + 1);
  }
  if (histogram.size === 0) return PROCESS_FINGERPRINT_UNAVAILABLE;
  const canonical = [...histogram.entries()]
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([comm, count]) => `${comm} ${String(count)}`)
    .join("\n");
  return NodeCrypto.createHash("sha256").update(canonical).digest("hex");
};

/** The one line the bounded repository probe folds itself into. */
export const repositoryProbeLine = (input: {
  readonly head: string;
  readonly status: string;
  readonly diff: string;
}): string => {
  const digest = NodeCrypto.createHash("sha256")
    .update(`${input.status}\0${input.diff}`)
    .digest("hex");
  return `${input.head} hash=${digest}`;
};

/** What the probe reports when it could not finish inside its budget. */
export const repositoryProbeTimeoutLine = (): string => `unknown hash=${REPO_PROBE_TIMEOUT_MARKER}`;

const readTextFile = (path: string): Effect.Effect<string | null> =>
  Effect.tryPromise(() => NodeFSP.readFile(path, "utf8")).pipe(Effect.orElseSucceed(() => null));

export interface CgroupWorkerEvidenceOptions {
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  /**
   * The worker's cgroup v2 directory, or `null` when the host gave it no
   * scope. A worker with no cgroup reports no CPU and no IO, so only its
   * output counter and the repository probe can show progress.
   */
  readonly cgroupPath: (ref: WorkerRef) => Effect.Effect<string | null>;
  /**
   * The worker's cumulative output byte count. Must never truncate: the
   * machine reads deltas, so a counter that resets reads as negative
   * progress, which is no progress at all (run-legacy.sh:946-949).
   */
  readonly outputBytes: (ref: WorkerRef) => Effect.Effect<number>;
  readonly providerFallbackPending: Effect.Effect<boolean>;
  /** Bounds every git call in the probe. Defaults to the machine's 2s. */
  readonly repoProbeTimeoutSeconds?: number | undefined;
}

const DEFAULT_REPO_PROBE_TIMEOUT_SECONDS = 2;

export const makeCgroupWorkerEvidence = (
  options: CgroupWorkerEvidenceOptions,
): WorkerEvidenceShape => {
  const probeTimeout = Duration.seconds(
    options.repoProbeTimeoutSeconds ?? DEFAULT_REPO_PROBE_TIMEOUT_SECONDS,
  );

  const readCgroupFile = (ref: WorkerRef, name: string): Effect.Effect<string | null> =>
    options
      .cgroupPath(ref)
      .pipe(
        Effect.flatMap((directory) =>
          directory === null ? Effect.succeed(null) : readTextFile(NodePath.join(directory, name)),
        ),
      );

  /** One `git` read, bounded; `null` on any timeout, failure or missing repo. */
  const git = (ref: WorkerRef, args: ReadonlyArray<string>): Effect.Effect<string | null> =>
    ref.repositoryPath === null
      ? Effect.succeed(null)
      : options.processRunner
          .run({
            command: "git",
            args,
            cwd: ref.repositoryPath,
            timeout: probeTimeout,
            timeoutBehavior: "timedOutResult",
            maxOutputBytes: 1024 * 1024,
            outputMode: "truncate",
          })
          .pipe(
            Effect.map((output) => (output.timedOut || output.code !== 0 ? null : output.stdout)),
            Effect.orElseSucceed(() => null),
          );

  return {
    inspectorSupported: false,

    sampleSignals: (ref: WorkerRef): Effect.Effect<WorkerSignalSample, WorkerEvidenceError> =>
      Effect.gen(function* () {
        const [cpuStat, ioStat, procs, outputBytes] = yield* Effect.all([
          readCgroupFile(ref, "cpu.stat"),
          readCgroupFile(ref, "io.stat"),
          readCgroupFile(ref, "cgroup.procs"),
          options.outputBytes(ref),
        ]);
        return {
          // No cgroup means no evidence of departure either, so the worker is
          // reported active. Rule 1 would otherwise skip supervision entirely
          // for every unsampled host.
          isActive: procs === null ? true : parseCgroupProcs(procs).length > 0,
          outputBytes,
          cpuUsec: cpuStat === null ? 0 : (parseCgroupCpuUsec(cpuStat) ?? 0),
          ioBytes: ioStat === null ? 0 : parseCgroupIoBytes(ioStat),
        };
      }),

    probeRepository: (ref: WorkerRef): Effect.Effect<string, WorkerEvidenceError> =>
      Effect.gen(function* () {
        const [head, status, diff] = yield* Effect.all([
          git(ref, ["rev-parse", "--verify", "-q", "HEAD"]),
          git(ref, ["status", "--porcelain=v1", "--untracked-files=all"]),
          git(ref, ["diff", "--no-color"]),
        ]);
        if (head === null || status === null || diff === null) {
          return repositoryProbeTimeoutLine();
        }
        return repositoryProbeLine({ head: head.trim(), status, diff });
      }),

    processFingerprint: (ref: WorkerRef): Effect.Effect<string, WorkerEvidenceError> =>
      Effect.gen(function* () {
        const procs = yield* readCgroupFile(ref, "cgroup.procs");
        if (procs === null) return PROCESS_FINGERPRINT_UNAVAILABLE;
        const pids = parseCgroupProcs(procs);
        const comms = yield* Effect.all(
          pids.map((pid) => readTextFile(`/proc/${pid}/comm`)),
          { concurrency: 8 },
        );
        return processCommFingerprint(comms.filter((comm): comm is string => comm !== null));
      }),

    providerFallbackPending: options.providerFallbackPending.pipe(
      Effect.orElseSucceed(() => false),
    ),

    // The inspector needs a harness that can deny tools to a subagent. None
    // exists yet, so `inspectorSupported` is false and the machine never asks
    // for one. These stay as honest no-ops until `t3code-77b`.
    launchInspector: (): Effect.Effect<void, WorkerEvidenceError> => Effect.void,
    inspectorStatus: (): Effect.Effect<InspectorRunEvidence, WorkerEvidenceError> =>
      Effect.succeed({ _tag: "none" }),
    stopInspector: (): Effect.Effect<void, WorkerEvidenceError> => Effect.void,
  };
};
