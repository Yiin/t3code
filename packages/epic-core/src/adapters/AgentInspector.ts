/**
 * The inspector half of `ports/WorkerEvidence.ts`, backed by a tool-denied
 * auxiliary agent.
 *
 * `TerminalAgentDispatch.runAuxiliary` already knows how to launch one: for
 * `prime` it passes `--no-tools --no-skills --no-context-files --no-extensions
 * --no-prompt-templates`, and for `claude`/`ccx` it passes `--tools ''
 * --disable-slash-commands --no-session-persistence`. That is the harness half.
 * This module is the port half: it renders the prompt from structural evidence
 * (`../inspectorPrompt.ts`), launches the agent in the background, and reports
 * its lifecycle back to the liveness machine one tick at a time.
 *
 * Background is the contract, not an optimisation. The machine keeps sampling
 * the worker while an inspection runs, and only accepts a stop when the
 * worker's fingerprints match across the whole inspection. A blocking launch
 * would freeze supervision for the inspector's entire budget and make that
 * comparison vacuous.
 *
 * Nothing here may reach a verdict. A refused launch, a crashed agent, an
 * overrun and an unparseable answer all arrive at the machine as a non-zero rc
 * or an overflowed result, which the machine turns into `uncertain` — never
 * into a stop.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  EMPTY_WORKER_STRUCTURE,
  renderInspectorPrompt,
  type WorkerStructureSummary,
} from "../inspectorPrompt.ts";
import type { AgentDispatchShape, AgentSelection } from "../ports/AgentDispatch.ts";
import type {
  WorkerEvidenceError,
  WorkerEvidenceShape,
  WorkerRef,
} from "../ports/WorkerEvidence.ts";
import { DEFAULT_WORKER_LIVENESS_CONFIG, type InspectorRunEvidence } from "../workerLiveness.ts";
import { inspectorSupportedFor } from "../workerSupervision.ts";

/** The four port members an inspector owns. */
export type InspectorPort = Pick<
  WorkerEvidenceShape,
  "inspectorSupported" | "launchInspector" | "inspectorStatus" | "stopInspector"
>;

/**
 * Harnesses that can run the inspector.
 *
 * Two conditions, both required: the harness must be able to deny a subagent
 * every tool — `inspectorSupportedFor` rules Codex out for exactly this — and
 * `TerminalAgentDispatch.runAuxiliary` must have a launch path for it. Today
 * that intersection is Prime and the two Claude harnesses.
 */
const INSPECTOR_HARNESSES = new Set<string>(["prime", "claude", "ccx"]);

export const harnessSupportsInspector = (harness: string): boolean =>
  inspectorSupportedFor(harness) && INSPECTOR_HARNESSES.has(harness);

/**
 * Grace on top of the machine's own budget before the adapter reaps the agent
 * itself. The machine force-stops at exactly `timeoutSeconds` and scores rc
 * 124, so this backstop only catches an inspector whose supervision fiber is
 * already gone: the worker settled, supervision was interrupted, and nobody is
 * left to call `stopInspector`.
 */
const REAP_GRACE_SECONDS = 15;

/** rc the machine reads as "the inspector process failed" (`workerLiveness.ts`). */
const INSPECTOR_FAILED_RC = 1;
/** rc the machine reads as "the inspector ran out of time". */
const INSPECTOR_TIMEOUT_RC = 124;

interface InspectorSlot {
  fiber: Fiber.Fiber<void> | null;
  status: InspectorRunEvidence;
}

export interface AgentInspectorOptions {
  readonly runAuxiliary: AgentDispatchShape["runAuxiliary"];
  /** Which agent runs the inspection. The run's own selection is correct. */
  readonly selection: AgentSelection;
  /**
   * Where the inspector runs. The coordinator checkout, never the worker's
   * worktree: the inspector reads nothing, and pointing it at the tree under
   * inspection would leave that separation to a flag.
   */
  readonly cwd: string;
  /**
   * Host detail the machine cannot see — allowlisted process names and
   * repository status counts. Absent means the prompt says `unavailable`,
   * which is honest and still leaves the machine's own counters.
   */
  readonly describeStructure?:
    | ((ref: WorkerRef) => Effect.Effect<WorkerStructureSummary>)
    | undefined;
  /** Result cap; over it the machine rejects the answer as overflowed. */
  readonly resultBytes?: number | undefined;
  /** Prompt cap (run-legacy.sh:1348-1352). */
  readonly promptBytes?: number | undefined;
}

/** The port an adapter installs when no inspector can run here. */
export const disabledInspector: InspectorPort = {
  inspectorSupported: false,
  launchInspector: (): Effect.Effect<void, WorkerEvidenceError> => Effect.void,
  inspectorStatus: (): Effect.Effect<InspectorRunEvidence, WorkerEvidenceError> =>
    Effect.succeed({ _tag: "none" }),
  stopInspector: (): Effect.Effect<void, WorkerEvidenceError> => Effect.void,
};

export const makeAgentInspector = (options: AgentInspectorOptions): InspectorPort => {
  const resultBytes = options.resultBytes ?? DEFAULT_WORKER_LIVENESS_CONFIG.inspectorResultBytes;
  const promptBytes =
    options.promptBytes ?? DEFAULT_WORKER_LIVENESS_CONFIG.repoEvidenceBytes + 8192;
  const slots = new Map<string, InspectorSlot>();

  /** The agent's answer, bounded exactly the way the machine expects it. */
  const finished = (rc: number, output: string): InspectorRunEvidence => {
    const byteSize = Buffer.byteLength(output);
    const overflowed = byteSize > resultBytes;
    return {
      _tag: "finished",
      rc,
      result: {
        text: overflowed ? Buffer.from(output).subarray(0, resultBytes).toString() : output,
        byteSize,
        overflowed,
      },
    };
  };

  /**
   * Forget this worker's inspector and interrupt its fiber.
   *
   * Interrupting the fiber does not signal the agent process: the dispatch
   * owns that, which is why the launch hands it `timeoutSeconds`. A stopped
   * inspector therefore exits on its own budget, and its answer is dropped
   * rather than delivered late to a machine that stopped waiting for it.
   */
  const stop = (worker: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const slot = slots.get(worker);
      if (slot === undefined) return Effect.void;
      slots.delete(worker);
      return slot.fiber === null ? Effect.void : Fiber.interrupt(slot.fiber);
    });

  return {
    inspectorSupported: true,

    launchInspector: (ref, input): Effect.Effect<void, WorkerEvidenceError> =>
      Effect.gen(function* () {
        // One inspector per worker. The machine never launches a second while
        // one is in flight, so this only clears a slot a reaped tick left.
        yield* stop(ref.worker);
        const structure = yield* (
          options.describeStructure?.(ref) ?? Effect.succeed(EMPTY_WORKER_STRUCTURE)
        );
        const prompt = renderInspectorPrompt({
          evidence: input.evidence,
          structure,
          maxBytes: promptBytes,
        });
        const slot: InspectorSlot = { fiber: null, status: { _tag: "running" } };
        slots.set(ref.worker, slot);
        const run = options
          .runAuxiliary({
            purpose: "idle-inspection",
            cwd: options.cwd,
            prompt,
            selection: options.selection,
            timeoutSeconds: input.timeoutSeconds,
          })
          .pipe(
            Effect.map((result) =>
              result.succeeded ? finished(0, result.output) : finished(INSPECTOR_FAILED_RC, ""),
            ),
            // A dispatch that refused to launch is an inspector that failed,
            // never an inspector that answered.
            Effect.catch(() => Effect.succeed(finished(INSPECTOR_FAILED_RC, ""))),
            Effect.timeoutOrElse({
              duration: Duration.seconds(input.timeoutSeconds + REAP_GRACE_SECONDS),
              orElse: () => Effect.succeed(finished(INSPECTOR_TIMEOUT_RC, "")),
            }),
            Effect.flatMap((evidence) =>
              Effect.sync(() => {
                slot.status = evidence;
              }),
            ),
          );
        /**
         * Detached, so the fiber outlives the supervision tick that launched
         * it. Its own timeout bounds it, so an interrupted supervision loop
         * cannot leave one running past the inspector budget.
         *
         * `startImmediately` makes the launch mean what the machine assumes:
         * the inspection is under way by the time supervision samples the
         * worker again, not queued behind the rest of this tick.
         */
        slot.fiber = yield* Effect.forkDetach(run, { startImmediately: true });
      }),

    inspectorStatus: (ref): Effect.Effect<InspectorRunEvidence, WorkerEvidenceError> =>
      Effect.sync(() => slots.get(ref.worker)?.status ?? { _tag: "none" }),

    stopInspector: (ref): Effect.Effect<void, WorkerEvidenceError> => stop(ref.worker),
  };
};
