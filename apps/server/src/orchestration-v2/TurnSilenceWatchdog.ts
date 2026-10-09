import {
  CommandId,
  isOrchestrationV2WorkActive,
  type OrchestrationV2TurnItem,
  type RunAttemptId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * A busy turn whose provider process stays alive but stops sending events
 * keeps its thread "working" until the user presses Stop: no terminal event
 * arrives, and the session is never idle, so idle release never fires. The
 * watchdog stops such a turn through the same `run.interrupt` path as Stop.
 *
 * No provider guarantees a heartbeat, so the default is generous. A tool
 * call (a long test suite, a subagent) can legitimately run silent for much
 * longer, so an open tool call gets its own, longer limit. A turn that waits
 * on the user (an approval or a question) is never stopped.
 */
export const DEFAULT_TURN_SILENCE_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_TURN_SILENCE_TOOL_TIMEOUT_MS = 2 * 60 * 60_000;

export interface TurnSilenceWatchdogOptions {
  /** Silence after which a turn with no open tool call is stopped. 0 or less disables the watchdog. */
  readonly silenceTimeoutMs: number;
  /** Silence after which a turn with an open tool call is stopped. */
  readonly toolSilenceTimeoutMs: number;
}

export const TurnSilenceWatchdogConfig: Config.Config<TurnSilenceWatchdogOptions> = Config.all({
  silenceTimeoutMs: Config.Int("T3CODE_TURN_SILENCE_TIMEOUT_MS").pipe(
    Config.withDefault(DEFAULT_TURN_SILENCE_TIMEOUT_MS),
  ),
  toolSilenceTimeoutMs: Config.Int("T3CODE_TURN_SILENCE_TOOL_TIMEOUT_MS").pipe(
    Config.withDefault(DEFAULT_TURN_SILENCE_TOOL_TIMEOUT_MS),
  ),
});

/** Turn items that wait on the user. While one is open, silence is expected. */
const userRequestItemTypes: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "approval_request",
  "user_input_request",
  "secret_request",
]);

/** Turn items whose work can run silent for a long time. */
const toolItemTypes: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "dynamic_tool",
  "subagent",
  "web_search",
  "file_search",
  "file_change",
]);

export interface TurnActivitySnapshot {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly lastEventAtMs: number;
  readonly waitingOnUser: boolean;
  readonly toolOpen: boolean;
}

export interface TurnActivityShape {
  /**
   * Starts tracking a run attempt whose provider events are being ingested.
   * A newer attempt of the same run replaces the older one.
   */
  readonly begin: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly attemptId: RunAttemptId;
  }) => Effect.Effect<void>;
  /** Records a provider event routed to the attempt. Untracked attempts are ignored. */
  readonly observe: (attemptId: RunAttemptId, event: ProviderAdapterV2Event) => Effect.Effect<void>;
  /** Restarts the attempt's silence clock without an event. */
  readonly touch: (attemptId: RunAttemptId) => Effect.Effect<void>;
  /** Stops tracking the attempt. */
  readonly end: (attemptId: RunAttemptId) => Effect.Effect<void>;
  readonly snapshot: Effect.Effect<ReadonlyArray<TurnActivitySnapshot>>;
}

/**
 * Provider activity of the runs whose turns are open, in memory. The default
 * tracks nothing, so services built without the watchdog pay nothing.
 */
export class TurnActivity extends Context.Reference<TurnActivityShape>(
  "t3/orchestration-v2/TurnSilenceWatchdog/TurnActivity",
  {
    defaultValue: () => ({
      begin: () => Effect.void,
      observe: () => Effect.void,
      touch: () => Effect.void,
      end: () => Effect.void,
      snapshot: Effect.succeed([]),
    }),
  },
) {}

interface TrackedTurn {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  lastEventAtMs: number;
  readonly openUserRequests: Set<string>;
  readonly openTools: Set<string>;
}

const setOpen = (set: Set<string>, key: string, open: boolean) => {
  if (open) set.add(key);
  else set.delete(key);
};

export const makeTurnActivity = Effect.sync((): TurnActivityShape => {
  const turns = new Map<RunAttemptId, TrackedTurn>();
  return {
    begin: ({ threadId, runId, attemptId }) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          for (const turn of turns.values()) {
            if (turn.runId === runId) turns.delete(turn.attemptId);
          }
          turns.set(attemptId, {
            threadId,
            runId,
            attemptId,
            lastEventAtMs: now,
            openUserRequests: new Set(),
            openTools: new Set(),
          });
        }),
      ),
    observe: (attemptId, event) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const turn = turns.get(attemptId);
          if (turn === undefined) return;
          turn.lastEventAtMs = now;
          switch (event.type) {
            case "runtime_request.updated":
              setOpen(
                turn.openUserRequests,
                `request:${event.runtimeRequest.id}`,
                event.runtimeRequest.status === "pending",
              );
              return;
            case "turn_item.updated": {
              const item = event.turnItem;
              const open = isOrchestrationV2WorkActive(item.status);
              if (userRequestItemTypes.has(item.type)) {
                setOpen(turn.openUserRequests, `item:${item.id}`, open);
              } else if (toolItemTypes.has(item.type)) {
                setOpen(turn.openTools, `item:${item.id}`, open);
              }
              return;
            }
            case "subagent.updated":
              setOpen(
                turn.openTools,
                `subagent:${event.subagent.id}`,
                isOrchestrationV2WorkActive(event.subagent.status),
              );
              return;
          }
        }),
      ),
    touch: (attemptId) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const turn = turns.get(attemptId);
          if (turn !== undefined) turn.lastEventAtMs = now;
        }),
      ),
    end: (attemptId) =>
      Effect.sync(() => {
        turns.delete(attemptId);
      }),
    snapshot: Effect.sync(() =>
      Array.from(turns.values(), (turn) => ({
        threadId: turn.threadId,
        runId: turn.runId,
        attemptId: turn.attemptId,
        lastEventAtMs: turn.lastEventAtMs,
        waitingOnUser: turn.openUserRequests.size > 0,
        toolOpen: turn.openTools.size > 0,
      })),
    ),
  };
});

export const layerTurnActivity = Layer.effect(TurnActivity, makeTurnActivity);

/** "30 minutes", "2 hours", "90 seconds". */
export function formatSilence(ms: number): string {
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (ms % 3_600_000 === 0) return plural(ms / 3_600_000, "hour");
  if (ms % 60_000 === 0) return plural(ms / 60_000, "minute");
  return plural(Math.round(ms / 1_000), "second");
}

/** The silence limit a turn has crossed, or null while it may still be working. */
export function silenceLimitCrossed(
  turn: TurnActivitySnapshot,
  nowMs: number,
  options: TurnSilenceWatchdogOptions,
): number | null {
  if (turn.waitingOnUser) return null;
  const limitMs = turn.toolOpen ? options.toolSilenceTimeoutMs : options.silenceTimeoutMs;
  return nowMs - turn.lastEventAtMs >= limitMs ? limitMs : null;
}

export const makeSweep = (options: TurnSilenceWatchdogOptions) =>
  Effect.gen(function* () {
    const activity = yield* TurnActivity;
    const threads = yield* ThreadManagement.ThreadManagementService;
    return Effect.fn("TurnSilenceWatchdog.sweep")(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      for (const turn of yield* activity.snapshot) {
        const limitMs = silenceLimitCrossed(turn, nowMs, options);
        if (limitMs === null) continue;
        const reason = `Turn stopped: no provider activity for ${formatSilence(limitMs)}${
          turn.toolOpen ? " while a tool call was open" : ""
        }`;
        yield* Effect.logWarning("orchestration-v2.turn-silence-watchdog.stopping-turn", {
          threadId: turn.threadId,
          runId: turn.runId,
          silentForMs: nowMs - turn.lastEventAtMs,
        });
        yield* threads
          .dispatch({
            type: "run.interrupt",
            commandId: CommandId.make(
              `turn-silence-watchdog:${turn.attemptId}:${turn.lastEventAtMs}`,
            ),
            threadId: turn.threadId,
            runId: turn.runId,
            reason,
          })
          .pipe(
            Effect.andThen(activity.end(turn.attemptId)),
            // Try again after another silent window, not on every tick.
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.turn-silence-watchdog.interrupt-failed", {
                threadId: turn.threadId,
                runId: turn.runId,
                cause,
              }).pipe(Effect.andThen(activity.touch(turn.attemptId))),
            ),
          );
      }
    });
  });

/** Checks open turns on the shared scheduler tick. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const options = yield* TurnSilenceWatchdogConfig.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Invalid turn silence watchdog config; using defaults", { error }).pipe(
          Effect.as({
            silenceTimeoutMs: DEFAULT_TURN_SILENCE_TIMEOUT_MS,
            toolSilenceTimeoutMs: DEFAULT_TURN_SILENCE_TOOL_TIMEOUT_MS,
          }),
        ),
      ),
    );
    if (options.silenceTimeoutMs <= 0) return;
    const sweep = yield* makeSweep(options);
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("turn-silence-watchdog", sweep());
  }),
);
