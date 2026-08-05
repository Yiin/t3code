import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canSettle,
  effectiveSettled,
  hasQueuedTurnStart,
  type ChangeRequestStateLike,
} from "./threadSettled.ts";

const NOW = "2026-04-10T00:00:00.000Z";
const FRESH = "2026-04-09T00:00:00.000Z";
const STALE = "2026-04-06T23:59:59.999Z";

function makeShell(input: {
  readonly settledOverride?: "settled" | "active" | null;
  readonly activityAt: string | null;
  readonly sessionStatus?: "starting" | "running";
  readonly pending?: "approval" | "user-input";
  readonly activeSubagentCount?: number;
}): OrchestrationThreadShell {
  const threadId = ThreadId.make("thread-1");
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn:
      input.activityAt === null
        ? null
        : {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: input.activityAt,
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledOverride === "settled" ? NOW : null,
    session:
      input.sessionStatus === undefined
        ? null
        : {
            threadId,
            status: input.sessionStatus,
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
    latestUserMessageAt: null,
    hasPendingApprovals: input.pending === "approval",
    hasPendingUserInput: input.pending === "user-input",
    hasActionableProposedPlan: false,
    activeSubagentCount: input.activeSubagentCount ?? 0,
  };
}

describe("effectiveSettled", () => {
  const overrideCases = [null, "settled", "active"] as const;
  const changeRequestStates = [undefined, "open", "merged"] as const;
  const inactivityCases = [
    ["fresh", FRESH],
    ["stale", STALE],
    ["no-activity", null],
  ] as const;
  const runningCases = [false, true] as const;
  const pendingCases = [undefined, "approval", "user-input"] as const;
  const truthTable = overrideCases.flatMap((settledOverride) =>
    changeRequestStates.flatMap((changeRequestState) =>
      inactivityCases.flatMap(([inactivity, activityAt]) =>
        runningCases.flatMap((running) =>
          pendingCases.map((pending) => ({
            settledOverride,
            changeRequestState,
            inactivity,
            activityAt,
            running,
            pending,
            // Settled iff nothing blocks (pending work / live session) AND
            // the override says settled, or (with no override) a merged PR
            // auto-settles. The "active" pin suppresses the PR signal.
            //
            // `inactivity` is deliberately a free dimension with no effect on
            // the expectation: idle auto-settle is the server's, and a stale
            // thread that the server has NOT settled must render as active.
            expected:
              pending === undefined &&
              !running &&
              (settledOverride === "settled" ||
                (settledOverride === null && changeRequestState === "merged")),
          })),
        ),
      ),
    ),
  );

  it.each(truthTable)(
    "override=$settledOverride pr=$changeRequestState inactivity=$inactivity running=$running pending=$pending",
    ({ settledOverride, changeRequestState, activityAt, running, pending, expected }) => {
      const shell = makeShell({
        settledOverride,
        activityAt,
        ...(running ? { sessionStatus: "running" as const } : {}),
        ...(pending === undefined ? {} : { pending }),
      });
      const changeRequestOptions =
        changeRequestState === undefined
          ? {}
          : { changeRequestState: changeRequestState as ChangeRequestStateLike };

      expect(
        effectiveSettled(shell, {
          now: NOW,
          ...changeRequestOptions,
        }),
      ).toBe(expected);
    },
  );

  it("treats closed change requests like merged ones", () => {
    const shell = makeShell({ activityAt: null });
    expect(
      effectiveSettled(shell, {
        now: NOW,
        changeRequestState: "closed",
      }),
    ).toBe(true);
  });

  it("never settles a starting session, even with a settled override", () => {
    const shell = makeShell({
      settledOverride: "settled",
      activityAt: STALE,
      sessionStatus: "starting",
    });
    expect(
      effectiveSettled(shell, {
        now: NOW,
        changeRequestState: "merged",
      }),
    ).toBe(false);
  });

  it("keeps a new turn active from queued through starting and running", () => {
    const requestedAt = "2026-04-09T12:00:00.000Z";
    const transitionNow = "2026-04-09T12:00:30.000Z";
    const base = makeShell({
      settledOverride: null,
      activityAt: STALE,
    });
    const queued: OrchestrationThreadShell = {
      ...base,
      latestUserMessageAt: requestedAt,
      latestTurn: null,
      session: null,
    };
    const starting: OrchestrationThreadShell = {
      ...queued,
      session: {
        threadId: queued.id,
        status: "starting",
        providerName: "Codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: requestedAt,
      },
    };
    const running: OrchestrationThreadShell = {
      ...starting,
      session: {
        ...starting.session!,
        status: "running",
        activeTurnId: TurnId.make("turn-new"),
      },
    };

    for (const shell of [queued, starting, running]) {
      expect(
        effectiveSettled(shell, {
          now: transitionNow,
          changeRequestState: "merged",
        }),
      ).toBe(false);
    }
  });

  it("never settles on inactivity alone, however old the thread is", () => {
    // Idle auto-settle lives on the server (ThreadAutoSettleSweeper), which
    // emits a real thread.settled event and stops the provider session. A
    // client that re-derived the rule would paint rows settled while their
    // sessions are still alive — exactly the divergence this removal killed.
    const ancient = makeShell({ activityAt: "2020-01-01T00:00:00.000Z" });
    const stale = makeShell({ activityAt: STALE });
    const noActivity = makeShell({ activityAt: null });

    for (const shell of [ancient, stale, noActivity]) {
      expect(effectiveSettled(shell, { now: NOW })).toBe(false);
    }

    // ...and the server's ruling on that same thread does settle it.
    expect(
      effectiveSettled({ ...ancient, settledOverride: "settled", settledAt: NOW }, { now: NOW }),
    ).toBe(true);
  });
});

describe("hasQueuedTurnStart", () => {
  const QUEUED_AT = "2026-04-09T12:00:00.000Z";
  // Within the adoption grace window of the queued message.
  const JUST_AFTER = { now: "2026-04-09T12:00:30.000Z" };

  it("flags a user message no turn has picked up, within the grace window", () => {
    const noTurn = { latestUserMessageAt: QUEUED_AT, latestTurn: null, session: null };
    expect(hasQueuedTurnStart(noTurn, JUST_AFTER)).toBe(true);

    const staleTurn = {
      ...makeShell({ activityAt: FRESH }),
      latestUserMessageAt: QUEUED_AT,
    };
    expect(hasQueuedTurnStart(staleTurn, JUST_AFTER)).toBe(true);
  });

  it("expires after the grace window: an unadopted message is a failed start, not queued work", () => {
    const noTurn = { latestUserMessageAt: QUEUED_AT, latestTurn: null, session: null };
    expect(hasQueuedTurnStart(noTurn, { now: "2026-04-09T12:03:00.000Z" })).toBe(false);
    // Historical shells (e.g. from servers that never carried latestTurn)
    // must never read as queued.
    expect(hasQueuedTurnStart(noTurn, { now: NOW })).toBe(false);
  });

  it("clears once a turn adopts the message or the start fails", () => {
    const adopted = {
      ...makeShell({ activityAt: QUEUED_AT }),
      latestUserMessageAt: QUEUED_AT,
    };
    expect(hasQueuedTurnStart(adopted, JUST_AFTER)).toBe(false);

    const failed = makeShell({ activityAt: FRESH });
    const failedShell = {
      ...failed,
      latestUserMessageAt: QUEUED_AT,
      session: {
        threadId: failed.id,
        status: "error" as const,
        providerName: "Codex",
        runtimeMode: "full-access" as const,
        activeTurnId: null,
        lastError: "boom",
        updatedAt: NOW,
      },
    };
    expect(hasQueuedTurnStart(failedShell, JUST_AFTER)).toBe(false);
  });

  it("is quiet without user messages", () => {
    expect(hasQueuedTurnStart(makeShell({ activityAt: FRESH }), JUST_AFTER)).toBe(false);
  });

  it("bounds the grace window in both directions: a future-stamped message is skew, not queued work", () => {
    // Message timestamps originate on other devices; a clock an hour ahead
    // must not hold the queued state for the whole skew.
    const skewed = {
      latestUserMessageAt: "2026-04-09T13:00:00.000Z",
      latestTurn: null,
      session: null,
    };
    expect(hasQueuedTurnStart(skewed, { now: "2026-04-09T12:00:00.000Z" })).toBe(false);
    // A small negative age (within the grace window) still reads as queued.
    const slightlyAhead = {
      latestUserMessageAt: "2026-04-09T12:00:30.000Z",
      latestTurn: null,
      session: null,
    };
    expect(hasQueuedTurnStart(slightlyAhead, { now: "2026-04-09T12:00:00.000Z" })).toBe(true);
  });
});

describe("canSettle", () => {
  it("blocks every state effectiveSettled refuses to classify as settled", () => {
    expect(canSettle(makeShell({ activityAt: FRESH }), { now: NOW })).toBe(true);
    expect(
      canSettle(makeShell({ activityAt: FRESH, sessionStatus: "starting" }), { now: NOW }),
    ).toBe(false);
    expect(
      canSettle(makeShell({ activityAt: FRESH, sessionStatus: "running" }), { now: NOW }),
    ).toBe(false);
    expect(canSettle(makeShell({ activityAt: FRESH, pending: "approval" }), { now: NOW })).toBe(
      false,
    );
    expect(canSettle(makeShell({ activityAt: FRESH, pending: "user-input" }), { now: NOW })).toBe(
      false,
    );
    // Running subagents are in-flight work even after the main turn ends —
    // the server's decider refuses the settle, so the UI must not offer it.
    expect(canSettle(makeShell({ activityAt: FRESH, activeSubagentCount: 1 }), { now: NOW })).toBe(
      false,
    );
  });

  it("blocks settling a queued turn start, only within the grace window", () => {
    const queued = {
      ...makeShell({ activityAt: FRESH }),
      latestUserMessageAt: "2026-04-09T12:00:00.000Z",
    };
    const justAfter = "2026-04-09T12:00:30.000Z";
    expect(canSettle(queued, { now: justAfter })).toBe(false);
    // effectiveSettled must agree: queued work never auto-settles either,
    // even with a merged PR.
    expect(
      effectiveSettled(queued, {
        now: justAfter,
        changeRequestState: "merged",
      }),
    ).toBe(false);
    // Past the window the message is a failed/stale start: settleable again.
    expect(canSettle(queued, { now: NOW })).toBe(true);
  });

  it("lets a server-accepted settle overrule the clock-derived queued blocker", () => {
    // The settle action ran with wall-clock `now` (past the grace window);
    // the list partition re-evaluates with an earlier `now` that is still
    // INSIDE the window — a lagging or skewed clock, or an injected one.
    // settledAt >= message time proves the server already adjudicated this
    // exact message, so the row must not snap back to active meanwhile.
    const messageAt = "2026-04-09T12:00:00.000Z";
    const flooredNow = "2026-04-09T12:01:00.000Z";
    const base = makeShell({ settledOverride: "settled", activityAt: null });
    const settledAfterMessage = {
      ...base,
      latestUserMessageAt: messageAt,
      settledAt: "2026-04-09T12:02:10.000Z",
    };
    expect(hasQueuedTurnStart(settledAfterMessage, { now: flooredNow })).toBe(true);
    expect(effectiveSettled(settledAfterMessage, { now: flooredNow })).toBe(true);

    // A message NEWER than settledAt is genuinely new work: still blocked
    // until the server's auto-unsettle lands.
    const messageAfterSettle = {
      ...base,
      latestUserMessageAt: "2026-04-09T12:03:00.000Z",
      settledAt: "2026-04-09T12:02:10.000Z",
    };
    expect(
      effectiveSettled(messageAfterSettle, {
        now: "2026-04-09T12:03:30.000Z",
      }),
    ).toBe(false);
  });

  it("agrees with effectiveSettled's blockers for explicitly settled shells", () => {
    // Anything canSettle rejects must render as active even when the user
    // settled it earlier.
    const blocked = makeShell({
      settledOverride: "settled",
      activityAt: FRESH,
      pending: "user-input",
    });
    expect(canSettle(blocked, { now: NOW })).toBe(false);
    expect(effectiveSettled(blocked, { now: NOW })).toBe(false);
  });
});
