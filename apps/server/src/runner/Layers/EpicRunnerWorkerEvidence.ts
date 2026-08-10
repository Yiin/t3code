/**
 * The server runner's `WorkerEvidence` port.
 *
 * The server owns no per-iteration process — a provider turn is a thread over
 * the orchestration engine and the provider SDK spawns its own child. What it
 * does own is the systemd scope every worker is launched into
 * (`packages/epic-core/src/workerScope.ts`), and that scope's cgroup carries
 * the per-worker CPU, IO and process-set facts the liveness machine reads.
 *
 * `EpicWorkerScopeRegistry` maps a thread id to its scope, so the loop's
 * worker key — the iteration handle's `ref`, which is the thread id — is
 * enough to find the cgroup. A run whose host gave it no scope (no Linux, no
 * systemd user manager) resolves to `null` and supervision degrades to the
 * repository probe alone.
 */
import { ThreadId } from "@t3tools/contracts";
import { makeCgroupWorkerEvidence } from "@t3tools/epic-core/adapters/CgroupWorkerEvidence";
import type { WorkerEvidenceShape, WorkerRef } from "@t3tools/epic-core/ports/WorkerEvidence";
import type * as ProcessRunner from "@t3tools/epic-core/processRunner";
import { workerScopeUnitName } from "@t3tools/epic-core/workerScope";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { EpicWorkerScopeRegistry } from "../../provider/workerScope.ts";

/** The cgroup v2 mount every delegated controller file hangs off. */
const CGROUP_ROOT = "/sys/fs/cgroup";

const SYSTEMCTL_TIMEOUT = Duration.seconds(5);

export interface ServerWorkerEvidenceOptions {
  readonly workerScopeRegistry: EpicWorkerScopeRegistry["Service"];
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
}

export const makeServerWorkerEvidence = (
  options: ServerWorkerEvidenceOptions,
): WorkerEvidenceShape => {
  /**
   * Unit name to cgroup directory. A scope's cgroup path is fixed for its
   * lifetime, so this spares the supervision tick a `systemctl` spawn every
   * five seconds per worker.
   */
  const cgroupPaths = new Map<string, string | null>();

  const resolveCgroupPath = (ref: WorkerRef): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      const binding = yield* options.workerScopeRegistry.resolve(ThreadId.make(ref.worker));
      if (Option.isNone(binding)) return null;
      const unit = workerScopeUnitName(binding.value.scopeId, binding.value.worker);
      const cached = cgroupPaths.get(unit);
      if (cached !== undefined) return cached;
      const shown = yield* options.processRunner
        .run({
          command: "systemctl",
          args: ["--user", "show", unit, "-p", "ControlGroup", "--value"],
          timeout: SYSTEMCTL_TIMEOUT,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.orElseSucceed(() => null));
      const controlGroup =
        shown === null || shown.timedOut || shown.code !== 0 ? "" : shown.stdout.trim();
      // An inactive or unknown unit shows an empty ControlGroup. Caching that
      // as `null` is wrong — the scope may not have been created yet — so only
      // a real path is remembered.
      if (controlGroup.length === 0) return null;
      const path = `${CGROUP_ROOT}${controlGroup}`;
      cgroupPaths.set(unit, path);
      return path;
    });

  return makeCgroupWorkerEvidence({
    processRunner: options.processRunner,
    cgroupPath: resolveCgroupPath,
    /**
     * The server has no never-truncated output byte counter: a turn's output
     * is projected, not tailed to a file. A constant leaves CPU and IO deltas
     * to carry progress, which is what the 2026-08-09 wedge showed anyway.
     */
    outputBytes: () => Effect.succeed(0),
    /**
     * Provider fallback only gates inspections, and the server has no
     * inspector yet (`t3code-77b`).
     */
    providerFallbackPending: Effect.succeed(false),
  });
};
