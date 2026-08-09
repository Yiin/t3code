import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { heavyGateLockPath } from "./ProcessGate.ts";
import type { ProcessRunner, ProcessRunOutput } from "../processRunner.ts";
import { MergeQueuePortError, type MergeRepairShape } from "../ports/MergeQueue.ts";

/**
 * The repair itself: a plain workspace install, run inside the integration
 * worktree. Verified against the real repo — it restores a deleted workspace
 * `node_modules` in ~2s and leaves the source checkout's links byte-identical.
 *
 * Every flag is load-bearing:
 *
 * - `vp`, not `pnpm`. `pnpm` resolves through a mise shim, and mise refuses to
 *   read the `mise.toml` of an untrusted directory — which every fresh
 *   worktree is. The shim exits before pnpm ever starts.
 * - `--frozen-lockfile` keeps the repair mechanical: it installs what the
 *   branch's lockfile already says, and fails loudly rather than rewriting it.
 * - `--ignore-scripts` keeps the repair inside the worktree. A worktree owns
 *   its `node_modules` (t3code-b93.22) but each store package below it is
 *   still a link into the source, so a lifecycle script that patches a
 *   package — this repo's `prepare` patches the tsgo binary — writes straight
 *   through into the shared store. Nothing a dependency repair needs runs
 *   there anyway; the store packages are already built.
 */
const INSTALL_COMMAND = "vp install --frozen-lockfile --ignore-scripts";

/** An install is heavy enough to be worth an hour and no longer. */
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1_000;

const cleanEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) =>
        value !== undefined && !name.startsWith("COOKEPIC_") && name !== "FLEET_UNIT",
    ),
  );

const outputDetail = (output: ProcessRunOutput): string =>
  [output.stdout, output.stderr]
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();

/** The last line worth reading, so one worktree's failure fits one line. */
const lastLine = (detail: string): string => {
  const lines = detail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const chosen = lines.at(-1) ?? "no install output";
  return chosen.length > 200 ? `${chosen.slice(0, 200)}…` : chosen;
};

/**
 * Restore an integration worktree's dependencies with a workspace install.
 *
 * Safe against the source checkout only because a worktree owns its
 * `node_modules` (t3code-b93.22): the install rewrites the worktree's own
 * links and never reaches the shared store. It takes the same heavy lock as
 * the gate, so a repair never runs beside a worker's gate.
 */
export const makeProcessMergeRepair = (input: {
  readonly processRunner: ProcessRunner["Service"];
  readonly environment: NodeJS.ProcessEnv;
  readonly uid: number;
  readonly timeoutMs?: number;
}): MergeRepairShape => {
  const restoreDependencies: MergeRepairShape["restoreDependencies"] = Effect.fn(
    "ProcessMergeRepair.restoreDependencies",
  )(function* ({ worktrees }) {
    const env = cleanEnvironment(input.environment);
    const lockPath = heavyGateLockPath({ environment: input.environment, uid: input.uid });
    const failures: Array<string> = [];

    for (const worktree of worktrees) {
      const output = yield* input.processRunner
        .run({
          command: "flock",
          args: [lockPath, "bash", "-c", INSTALL_COMMAND],
          cwd: worktree,
          env,
          extendEnv: false,
          maxOutputBytes: 1024 * 1024,
          outputMode: "truncate",
          truncatedMarker: "",
          timeout: Duration.millis(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new MergeQueuePortError({
                operation: "restoreDependencies",
                detail: `Could not run '${INSTALL_COMMAND}' in ${worktree}`,
                cause,
              }),
          ),
        );
      if (output.code !== 0) {
        failures.push(`${worktree}: ${lastLine(outputDetail(output))}`);
      }
    }

    if (failures.length > 0) {
      return { restored: false, detail: `'${INSTALL_COMMAND}' failed — ${failures.join("; ")}` };
    }
    return {
      restored: true,
      detail: `'${INSTALL_COMMAND}' completed in ${String(worktrees.length)} integration worktree(s)`,
    };
  });

  return { restoreDependencies };
};
