/**
 * EpicRunner - Server-owned unattended execution of an epic backlog.
 *
 * A "run" is the ralph pattern hosted inside t3code: repeatedly hand the same
 * prompt to a *fresh* agent context until the backlog is empty. The loop lives
 * in the server, not in a client and not in a shelled-out CLI, so a run keeps
 * going after the user closes every window.
 *
 * ## Why iterations are orchestration turns
 *
 * A fresh orchestration thread already *is* a fresh context, so each iteration
 * is dispatched as `thread.create` + `thread.turn.start` through the normal
 * command path. Three things fall out of that for free: every provider t3code
 * supports can drive a run (the loop only speaks `ModelSelection`), each
 * iteration shows up in the UI as an ordinary thread the user can open and
 * read, and the run inherits the existing persistence, projection, and
 * approval machinery rather than reimplementing it.
 *
 * Iterations report completion in-band, in the text of their final assistant
 * message. See `@t3tools/epic-core/ralphProtocol` for that contract. Beads and git remain
 * the only shared ground truth between a t3code-hosted run and a terminal one.
 *
 * ## What lives elsewhere
 *
 * Durable run state is `EpicRunStore` (`persistence/Services/EpicRuns.ts`); this
 * service owns only the loop and reads/writes through that store, so a restart
 * loses no run. The WS/HTTP surface, the run-lock shared with terminal ralph,
 * and lease-based reconnect semantics are separate issues.
 *
 * @module EpicRunner
 */
import type {
  EpicRun,
  EpicRunRef,
  LaunchEpicRunInput,
  ListEpicRunsInput,
  StartEpicRunInput,
  SetEpicRunWorkersInput,
} from "@t3tools/contracts";
import type { EpicRunnerError } from "@t3tools/epic-core/Errors";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Stream from "effect/Stream";

export type { EpicRunRef, StartEpicRunInput };
export type ListEpicRunsFilter = ListEpicRunsInput;

/**
 * EpicRunnerShape - Service API for unattended epic runs.
 */
export interface EpicRunnerShape {
  /**
   * Bring the runner up.
   *
   * Reconciles state left behind by a crash or restart: an iteration still
   * recorded as `running` cannot be running (the provider subprocess died with
   * the old server and nothing re-attaches), so it is flipped to `abandoned`
   * and its run's loop is relaunched from the next index.
   */
  readonly start: () => Effect.Effect<void>;

  /**
   * Create a run and start its loop. Returns as soon as the run is persisted;
   * the loop itself runs in the background for the lifetime of the server.
   */
  readonly startRun: (input: StartEpicRunInput) => Effect.Effect<EpicRun, EpicRunnerError>;
  readonly launchRun: (input: LaunchEpicRunInput) => Effect.Effect<EpicRun, EpicRunnerError>;

  /**
   * Ask a running loop to stop after its current iteration finishes.
   *
   * Pausing deliberately does not interrupt the turn in flight: an agent
   * halfway through a unit of work would leave the repo and the backlog in an
   * inconsistent state. Use `cancelRun` to stop immediately.
   */
  readonly pauseRun: (input: EpicRunRef) => Effect.Effect<EpicRun, EpicRunnerError>;

  /**
   * Restart a paused run's loop from its next iteration index.
   */
  readonly resumeRun: (input: EpicRunRef) => Effect.Effect<EpicRun, EpicRunnerError>;

  /**
   * Stop a run now, interrupting any turn in flight.
   */
  readonly cancelRun: (input: EpicRunRef) => Effect.Effect<EpicRun, EpicRunnerError>;

  /** Change the durable dispatch cap without interrupting active workers. */
  readonly setWorkers: (input: SetEpicRunWorkersInput) => Effect.Effect<EpicRun, EpicRunnerError>;

  readonly listRuns: (
    input?: ListEpicRunsFilter,
  ) => Effect.Effect<ReadonlyArray<EpicRun>, EpicRunnerError>;

  readonly getRun: (input: EpicRunRef) => Effect.Effect<Option.Option<EpicRun>, EpicRunnerError>;

  /**
   * Hot stream of run rows, emitted whenever a run's persisted state changes.
   *
   * New-state-only: subscribers that need the current set read `listRuns`
   * first. Intended for the WS subscription that drives the run UI.
   */
  readonly streamRuns: Stream.Stream<EpicRun>;
}

/**
 * EpicRunner - Service tag for unattended epic run execution.
 */
export class EpicRunner extends Context.Service<EpicRunner, EpicRunnerShape>()(
  "t3/runner/Services/EpicRunner",
) {}
