/**
 * The terminal runner's `WorkerEvidence` port.
 *
 * The terminal harness owns its worker outright: it spawns the process group,
 * streams its stdout and stderr, and sees it close. So unlike the server it can
 * answer both of the questions a cgroup cannot — the never-truncated output
 * byte counter and whether the worker's own child is still alive — from
 * `TerminalWorkerActivity`. Everything else is the same cgroup v2 sampling and
 * bounded git probe the server uses, so this adapter is a thin resolution layer
 * over `makeCgroupWorkerEvidence`.
 *
 * The cgroup comes from `/proc/<pid>/cgroup` rather than a `systemctl show`
 * spawn, because the terminal already holds the pid. That read is also the
 * safety check: an unwrapped spawn (no systemd user manager, no Linux) inherits
 * the coordinator's own cgroup, whose CPU covers the coordinator and every
 * sibling worker, so attributing it to one worker would manufacture progress.
 * Only a `cook-epic-*.scope` leaf is accepted; anything else reports no cgroup
 * and supervision runs on the output counter and repository probe alone.
 *
 * The inspector is wired here when the harness can deny a subagent every tool.
 * The terminal side has both halves in hand — `TerminalAgentDispatch` spawns
 * the tool-denied auxiliary and this adapter holds the pid and the cgroup — so
 * this is where the inspector lands first. What to do for a harness that has no
 * inspector at all is `t3code-77b`.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";

import type * as ProcessRunner from "../processRunner.ts";
import type { WorkerEvidenceShape, WorkerRef } from "../ports/WorkerEvidence.ts";
import { makeAgentInspector, type AgentInspectorOptions } from "./AgentInspector.ts";
import { makeCgroupWorkerEvidence } from "./CgroupWorkerEvidence.ts";
import type { TerminalWorkerActivity } from "./TerminalWorkerActivity.ts";

/** The cgroup v2 mount every delegated controller file hangs off. */
const CGROUP_ROOT = "/sys/fs/cgroup";

/** `workerScope.ts` names every worker unit `cook-epic-<scopeId>-<worker>.scope`. */
const WORKER_SCOPE_LEAF = /^cook-epic-[^/]+\.scope$/;

/**
 * The worker's own cgroup directory from a `/proc/<pid>/cgroup` body, or `null`
 * when the process is not in a worker scope.
 *
 * Only the cgroup v2 unified line (`0::<path>`) is read; a v1 controller line
 * says nothing about the delegated `cpu.stat` this adapter samples.
 */
export const parseWorkerScopeCgroupPath = (procCgroup: string): string | null => {
  for (const line of procCgroup.split("\n")) {
    const path = line.trim().startsWith("0::") ? line.trim().slice(3) : null;
    if (path === null || !path.startsWith("/")) continue;
    const leaf = path.slice(path.lastIndexOf("/") + 1);
    return WORKER_SCOPE_LEAF.test(leaf) ? `${CGROUP_ROOT}${path}` : null;
  }
  return null;
};

export interface TerminalWorkerEvidenceOptions {
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly activity: TerminalWorkerActivity;
  /** Injectable for tests; defaults to reading `/proc/<pid>/cgroup`. */
  readonly readProcCgroup?: ((pid: number) => Effect.Effect<string | null>) | undefined;
  readonly repoProbeTimeoutSeconds?: number | undefined;
  /**
   * How to launch the locked-down inspector, or absent for a harness that
   * cannot deny a subagent its tools. Use {@link harnessSupportsInspector} to
   * decide; `describeStructure` is supplied by the cgroup layer below.
   */
  readonly inspector?: Omit<AgentInspectorOptions, "describeStructure"> | undefined;
}

const readProcCgroupFile = (pid: number): Effect.Effect<string | null> =>
  Effect.tryPromise(() => NodeFSP.readFile(`/proc/${String(pid)}/cgroup`, "utf8")).pipe(
    Effect.orElseSucceed(() => null),
  );

export const makeTerminalWorkerEvidence = (
  options: TerminalWorkerEvidenceOptions,
): WorkerEvidenceShape => {
  const readProcCgroup = options.readProcCgroup ?? readProcCgroupFile;

  const inspectorOptions = options.inspector;

  return makeCgroupWorkerEvidence({
    processRunner: options.processRunner,
    ...(options.repoProbeTimeoutSeconds === undefined
      ? {}
      : { repoProbeTimeoutSeconds: options.repoProbeTimeoutSeconds }),
    ...(inspectorOptions === undefined
      ? {}
      : {
          inspector: (describeStructure) =>
            makeAgentInspector({ ...inspectorOptions, describeStructure }),
        }),
    /**
     * Re-read every tick rather than cached: the scope does not exist yet at
     * the instant of the spawn, and a continuation replaces the pid with a new
     * process in a new scope.
     */
    cgroupPath: (ref: WorkerRef): Effect.Effect<string | null> =>
      Effect.gen(function* () {
        const pid = options.activity.sample(ref.worker)?.pid ?? null;
        if (pid === null) return null;
        const procCgroup = yield* readProcCgroup(pid);
        return procCgroup === null ? null : parseWorkerScopeCgroupPath(procCgroup);
      }),
    outputBytes: (ref: WorkerRef): Effect.Effect<number> =>
      Effect.sync(() => options.activity.sample(ref.worker)?.outputBytes ?? 0),
    isActive: (ref: WorkerRef): Effect.Effect<boolean | null> =>
      Effect.sync(() => options.activity.sample(ref.worker)?.live ?? null),
    /**
     * Terminal provider fallback happens between iterations, never inside a
     * live worker's turn, so no tick can land while one is pending. Fallback
     * only pauses inspections anyway.
     */
    providerFallbackPending: Effect.succeed(false),
  });
};
