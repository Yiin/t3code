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
 * The inspector is optional and injected. With one, this adapter also supplies
 * its structural summary — an allowlisted process histogram and repository
 * status counts, both from evidence it already reads. Without one,
 * `inspectorSupported` is false and the machine records an uncertain reason
 * instead of launching. What to do when no inspector can run is `t3code-77b`.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type { WorkerStructureSummary } from "../inspectorPrompt.ts";
import type * as ProcessRunner from "../processRunner.ts";
import type {
  WorkerEvidenceError,
  WorkerEvidenceShape,
  WorkerRef,
} from "../ports/WorkerEvidence.ts";
import {
  PROCESS_FINGERPRINT_UNAVAILABLE,
  REPO_PROBE_TIMEOUT_MARKER,
  type WorkerSignalSample,
} from "../workerLiveness.ts";
import { disabledInspector, type InspectorPort } from "./AgentInspector.ts";

/** Comm names that say nothing about progress (run-legacy.sh:1302-1315). */
const FINGERPRINT_IGNORED_COMMS = new Set(["sleep", "timeout"]);

/**
 * Command names the inspector prompt may see by name (run-legacy.sh:1284-1298).
 *
 * An allowlist, so a worker cannot smuggle text to the inspector by naming a
 * process after it. Everything else is counted as `other`.
 */
const SUMMARY_ALLOWED_COMMS = new Set([
  "bash",
  "sh",
  "dash",
  "zsh",
  "fish",
  "git",
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "ruby",
  "rails",
  "go",
  "cargo",
  "rustc",
  "make",
  "cmake",
  "ninja",
  "java",
  "javac",
  "gradle",
  "chromium",
  "chrome",
  "playwright",
  "vite",
  "tsc",
  "eslint",
  "pytest",
  "rspec",
  "sleep",
]);

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

/**
 * The allowlisted `tool=<name> count=<n>` histogram the inspector prompt shows
 * (run-legacy.sh:1284-1298). Sorted, so two identical process sets render the
 * same way.
 */
export const processToolSummary = (comms: ReadonlyArray<string>): ReadonlyArray<string> => {
  const histogram = new Map<string, number>();
  for (const raw of comms) {
    const comm = raw.trim();
    if (comm.length === 0) continue;
    const name = SUMMARY_ALLOWED_COMMS.has(comm) ? comm : "other";
    histogram.set(name, (histogram.get(name) ?? 0) + 1);
  }
  return [...histogram.entries()]
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, count]) => `tool=${name} count=${String(count)}`);
};

/**
 * Repository movement as counts per status class, never as paths
 * (run-legacy.sh:1240-1252). `null` status means the probe could not run.
 */
export const repositoryStatusSummary = (status: string | null): ReadonlyArray<string> => {
  if (status === null) return ["probe-timeout=true"];
  const counts = { modified: 0, added: 0, deleted: 0, renamed: 0, conflicted: 0, untracked: 0 };
  for (const line of status.split("\n")) {
    if (line.trim().length === 0) continue;
    const code = line.slice(0, 2);
    if (code === "??") counts.untracked += 1;
    else if (/U|AA|DD/.test(code)) counts.conflicted += 1;
    else if (code.includes("R")) counts.renamed += 1;
    else if (code.includes("A")) counts.added += 1;
    else if (code.includes("D")) counts.deleted += 1;
    else counts.modified += 1;
  }
  return [
    `tracked-modified=${String(counts.modified)} added=${String(counts.added)} deleted=${String(counts.deleted)}`,
    `renamed=${String(counts.renamed)} conflicted=${String(counts.conflicted)} untracked=${String(counts.untracked)}`,
    "probe-timeout=false",
  ];
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
  /**
   * Whether the worker's own process is still running, for a harness that
   * spawned it and therefore knows. `null` means "cannot tell" and leaves the
   * cgroup's process set as the only answer.
   *
   * A harness that owns the process outranks the cgroup here: it sees the
   * child close, while an unscoped worker has no cgroup of its own to empty.
   */
  readonly isActive?: ((ref: WorkerRef) => Effect.Effect<boolean | null>) | undefined;
  readonly providerFallbackPending: Effect.Effect<boolean>;
  /** Bounds every git call in the probe. Defaults to the machine's 2s. */
  readonly repoProbeTimeoutSeconds?: number | undefined;
  /**
   * The inspector, built over this adapter's own structural summary.
   *
   * A function rather than a ready port because the summary is assembled from
   * the cgroup and git reads configured right here, and the caller has neither.
   * Absent means no inspector: `inspectorSupported` is false and the machine
   * records an uncertain reason instead of launching.
   */
  readonly inspector?:
    | ((
        describeStructure: (ref: WorkerRef) => Effect.Effect<WorkerStructureSummary>,
      ) => InspectorPort)
    | undefined;
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

  /** Every live comm in the worker's cgroup, unfiltered. */
  const workerComms = (ref: WorkerRef): Effect.Effect<ReadonlyArray<string> | null> =>
    Effect.gen(function* () {
      const procs = yield* readCgroupFile(ref, "cgroup.procs");
      if (procs === null) return null;
      const comms = yield* Effect.all(
        parseCgroupProcs(procs).map((pid) => readTextFile(`/proc/${pid}/comm`)),
        { concurrency: 8 },
      );
      return comms.filter((comm): comm is string => comm !== null);
    });

  /**
   * The inspector's host-side view: which allowlisted commands run, and how
   * many paths sit in each repository status class. Counts and names only; no
   * path, no argument and no file content ever reaches the prompt.
   */
  const describeStructure = (ref: WorkerRef): Effect.Effect<WorkerStructureSummary> =>
    Effect.gen(function* () {
      const [comms, status] = yield* Effect.all([
        workerComms(ref),
        git(ref, ["status", "--porcelain=v1", "--untracked-files=all"]),
      ]);
      return {
        processes: comms === null ? [] : processToolSummary(comms),
        repository: repositoryStatusSummary(status),
      };
    });

  const inspector = options.inspector?.(describeStructure) ?? disabledInspector;

  return {
    ...inspector,

    sampleSignals: (ref: WorkerRef): Effect.Effect<WorkerSignalSample, WorkerEvidenceError> =>
      Effect.gen(function* () {
        const [cpuStat, ioStat, procs, outputBytes, ownerIsActive] = yield* Effect.all([
          readCgroupFile(ref, "cpu.stat"),
          readCgroupFile(ref, "io.stat"),
          readCgroupFile(ref, "cgroup.procs"),
          options.outputBytes(ref),
          options.isActive?.(ref) ?? Effect.succeed(null),
        ]);
        return {
          // No cgroup means no evidence of departure either, so the worker is
          // reported active. Rule 1 would otherwise skip supervision entirely
          // for every unsampled host.
          isActive: ownerIsActive ?? (procs === null ? true : parseCgroupProcs(procs).length > 0),
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
        const comms = yield* workerComms(ref);
        return comms === null ? PROCESS_FINGERPRINT_UNAVAILABLE : processCommFingerprint(comms);
      }),

    providerFallbackPending: options.providerFallbackPending.pipe(
      Effect.orElseSucceed(() => false),
    ),
  };
};
