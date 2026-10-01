/**
 * InterruptedTurnNudger - restart the conversation a server restart cut off.
 *
 * A restart kills every harness process. Threads that were mid-turn lose the
 * work in flight and then sit stopped until a human types the next message,
 * which is how a deploy can silently abandon a report an agent was two minutes
 * from sending (t3code-6wa).
 *
 * This is the boot step that picks them back up: it resumes the provider
 * session and, only once the provider proves the conversation continued, sends
 * one turn telling the agent what happened and what to re-verify.
 *
 * An idle thread is picked up too when its session was live and it had
 * background tasks open, because a restart kills those tasks and Monitors and
 * nothing else would wake an agent that was waiting on one.
 *
 * Deliberately two calls rather than one `start()`. The signal it reads —
 * a projected session still mid-turn — is destroyed by the very reconciliation
 * that has to run before a resume is safe, and after that pass an interrupted
 * turn is indistinguishable from one a human pressed Stop on. So `collect`
 * runs BEFORE any reactor, while the projection still holds what the dead
 * process left, and `nudge` runs LAST, once the reaper and the epic runner
 * have settled their own state. `startBootReactors` (serverRuntimeStartup.ts)
 * owns that ordering and `serverRuntimeStartup.test.ts` asserts it.
 *
 * A restart is not the only way to lose a process. A Claude Code process can
 * also exit under a server that keeps running, and then a mid-turn thread sits
 * stopped in exactly the same way, with its background tasks and Monitors dead
 * alongside it and nothing to say so. `watchProcessExits` covers that: it
 * listens for the adapter's error `session.exited`, which carries whether a
 * turn was in flight and which tasks died, and runs the same resume handshake
 * with a prompt that names what was lost. The two triggers never see the same
 * death: only a process this server started can emit an exit, and the boot
 * pass handles only the processes the previous server left behind.
 *
 * @module InterruptedTurnNudger
 */
import type { RuntimeOrphanedTask, ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * One interactive thread the dead process left mid-turn, or idle with
 * background tasks still open.
 *
 * `latestTurnId` is the turn on the thread at collect time (for a mid-turn
 * thread, the turn that died), kept so the nudge can tell "nothing has
 * happened here since the restart" from "something else already drove this
 * thread while I was resuming an earlier one".
 *
 * `idle` marks a thread that was not mid-turn. It is collected only because
 * a restart killed its background tasks and Monitors, so its prompt must not
 * talk about a cut-off turn. Absent means mid-turn.
 *
 * `orphanedTasks` lists the background tasks and Monitors the thread started
 * and never saw complete, read from the projected `task.started` rows. The
 * restart killed all of them, and the prompt names them so the agent can
 * re-arm the ones it still needs.
 */
export interface InterruptedThreadCandidate {
  readonly threadId: ThreadId;
  readonly latestTurnId: TurnId | null;
  readonly idle?: boolean;
  readonly orphanedTasks?: ReadonlyArray<RuntimeOrphanedTask>;
}

export interface InterruptedTurnNudgerShape {
  /**
   * Read the threads that were mid-turn when the last process died, plus the
   * idle threads whose session was live and had background tasks open.
   *
   * Must be called before anything reconciles the projection. Never fails: a
   * projection read that breaks leaves every thread exactly where the restart
   * left it, which is the status quo this feature improves on.
   */
  readonly collect: () => Effect.Effect<ReadonlyArray<InterruptedThreadCandidate>>;

  /**
   * Resume each collected thread and, on proved continuity, send it one nudge
   * turn.
   *
   * Forks: a resume settles in a provider session start, and startup must not
   * wait on a provider. The returned effect needs a scope so the fiber is
   * finalized on shutdown.
   */
  readonly nudge: (
    candidates: ReadonlyArray<InterruptedThreadCandidate>,
  ) => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Watch for harness processes that exit with an error and nudge the threads
   * they left mid-turn or with orphaned background tasks.
   *
   * Forks one long-lived fiber over `ProviderService.streamEvents`, plus one
   * short-lived fiber per exit, all finalized with the given scope. Never
   * fails: a nudge that breaks is logged and the watcher keeps running. A
   * thread is nudged at most once per ten minutes, so a process that crashes
   * on every resume stops being resumed.
   */
  readonly watchProcessExits: () => Effect.Effect<void, never, Scope.Scope>;
}

export class InterruptedTurnNudger extends Context.Service<
  InterruptedTurnNudger,
  InterruptedTurnNudgerShape
>()("t3/provider/Services/InterruptedTurnNudger") {}
