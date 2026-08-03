import { epicRunIterationThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_ACTIVE_TURN_SKIP_CAP_MS,
  DEFAULT_EPIC_RUN_ITERATION_IDLE_THRESHOLD_MS,
  DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS,
  DEFAULT_SETTLED_IDLE_THRESHOLD_MS,
  decideSessionReap,
  minSessionReapThresholdMs,
  sessionReapThreadKind,
  type SessionReapDecision,
  type SessionReapInput,
} from "./sessionReapPolicy.ts";

const INTERACTIVE_THREAD_ID = "thread-interactive";
const ITERATION_THREAD_ID = epicRunIterationThreadId({
  runId: "0f1c9a4e-6b21-4a2c-9f31-7d0c5b8e2a10",
  iterationIndex: 3,
});

const INJECTED_THRESHOLDS = {
  interactiveIdleThresholdMs: 10_000,
  epicRunIterationIdleThresholdMs: 1_000,
  settledIdleThresholdMs: 500,
  activeTurnSkipCapMs: 2_000,
} as const;

const decide = (overrides: Partial<SessionReapInput>): SessionReapDecision =>
  decideSessionReap({
    threadId: INTERACTIVE_THREAD_ID,
    status: "running",
    idleDurationMs: 0,
    settledOverride: null,
    activeTurnId: null,
    ...overrides,
  });

describe("sessionReapThreadKind", () => {
  it("reads the kind off the thread id with no I/O", () => {
    expect(sessionReapThreadKind(INTERACTIVE_THREAD_ID)).toBe("interactive");
    expect(sessionReapThreadKind(ITERATION_THREAD_ID)).toBe("epic-run-iteration");
  });
});

describe("decideSessionReap", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly input: Partial<SessionReapInput>;
    readonly reap: boolean;
    readonly reason: SessionReapDecision["reason"];
    readonly threadKind: SessionReapDecision["threadKind"];
    readonly thresholdMs: number;
  }> = [
    {
      name: "keeps an interactive session idle just under 36 hours",
      input: { idleDurationMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS - 1 },
      reap: false,
      reason: "within_idle_threshold",
      threadKind: "interactive",
      thresholdMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS,
    },
    {
      name: "reaps an interactive session idle for 36 hours",
      input: { idleDurationMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS },
      reap: true,
      reason: "interactive_idle_threshold",
      threadKind: "interactive",
      thresholdMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS,
    },
    {
      name: "keeps an interactive session at the old 30-minute mark",
      input: { idleDurationMs: DEFAULT_EPIC_RUN_ITERATION_IDLE_THRESHOLD_MS },
      reap: false,
      reason: "within_idle_threshold",
      threadKind: "interactive",
      thresholdMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS,
    },
    {
      name: "keeps an iteration session idle just under 30 minutes",
      input: {
        threadId: ITERATION_THREAD_ID,
        idleDurationMs: DEFAULT_EPIC_RUN_ITERATION_IDLE_THRESHOLD_MS - 1,
      },
      reap: false,
      reason: "within_idle_threshold",
      threadKind: "epic-run-iteration",
      thresholdMs: DEFAULT_EPIC_RUN_ITERATION_IDLE_THRESHOLD_MS,
    },
    {
      name: "reaps an iteration session idle for 30 minutes",
      input: {
        threadId: ITERATION_THREAD_ID,
        idleDurationMs: DEFAULT_EPIC_RUN_ITERATION_IDLE_THRESHOLD_MS,
      },
      reap: true,
      reason: "epic_run_iteration_idle_threshold",
      threadKind: "epic-run-iteration",
      thresholdMs: DEFAULT_EPIC_RUN_ITERATION_IDLE_THRESHOLD_MS,
    },
    {
      name: "reaps a settled interactive session on the short threshold",
      input: {
        settledOverride: "settled",
        idleDurationMs: DEFAULT_SETTLED_IDLE_THRESHOLD_MS,
      },
      reap: true,
      reason: "settled_idle_threshold",
      threadKind: "interactive",
      thresholdMs: DEFAULT_SETTLED_IDLE_THRESHOLD_MS,
    },
    {
      name: "keeps a settled interactive session under the short threshold",
      input: {
        settledOverride: "settled",
        idleDurationMs: DEFAULT_SETTLED_IDLE_THRESHOLD_MS - 1,
      },
      reap: false,
      reason: "within_idle_threshold",
      threadKind: "interactive",
      thresholdMs: DEFAULT_SETTLED_IDLE_THRESHOLD_MS,
    },
    {
      name: "keeps a keep-active pinned session inside the 36-hour backstop",
      input: {
        settledOverride: "active",
        idleDurationMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS - 1,
      },
      reap: false,
      reason: "within_idle_threshold",
      threadKind: "interactive",
      thresholdMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS,
    },
    {
      name: "still reaps a keep-active pinned session past the backstop",
      input: {
        settledOverride: "active",
        idleDurationMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS,
      },
      reap: true,
      reason: "active_pin_idle_threshold",
      threadKind: "interactive",
      thresholdMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS,
    },
    {
      name: "gives a pinned iteration thread the long backstop",
      input: {
        threadId: ITERATION_THREAD_ID,
        settledOverride: "active",
        idleDurationMs: DEFAULT_EPIC_RUN_ITERATION_IDLE_THRESHOLD_MS,
      },
      reap: false,
      reason: "within_idle_threshold",
      threadKind: "epic-run-iteration",
      thresholdMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS,
    },
    {
      name: "keeps a session whose binding is already stopped",
      input: { status: "stopped", idleDurationMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS * 10 },
      reap: false,
      reason: "session_stopped",
      threadKind: "interactive",
      thresholdMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS,
    },
    {
      name: "keeps a session running a three-hour render inside one turn",
      input: {
        activeTurnId: "turn-still-running",
        idleDurationMs: 3 * 60 * 60 * 1000,
      },
      reap: false,
      reason: "active_turn",
      threadKind: "interactive",
      thresholdMs: DEFAULT_ACTIVE_TURN_SKIP_CAP_MS,
    },
    {
      name: "keeps a session whose turn is just under the 24-hour skip cap",
      input: {
        activeTurnId: "turn-still-running",
        idleDurationMs: DEFAULT_ACTIVE_TURN_SKIP_CAP_MS - 1,
      },
      reap: false,
      reason: "active_turn",
      threadKind: "interactive",
      thresholdMs: DEFAULT_ACTIVE_TURN_SKIP_CAP_MS,
    },
    {
      name: "reaps a session whose turn outlived the 24-hour skip cap",
      input: {
        activeTurnId: "turn-that-died",
        idleDurationMs: DEFAULT_ACTIVE_TURN_SKIP_CAP_MS,
      },
      reap: true,
      reason: "stale_active_turn",
      threadKind: "interactive",
      thresholdMs: DEFAULT_ACTIVE_TURN_SKIP_CAP_MS,
    },
    {
      name: "reaps an immortal session that is idle far past every threshold",
      input: {
        activeTurnId: "turn-that-died",
        idleDurationMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS * 10,
      },
      reap: true,
      reason: "stale_active_turn",
      threadKind: "interactive",
      thresholdMs: DEFAULT_ACTIVE_TURN_SKIP_CAP_MS,
    },
    {
      name: "keeps a settled session whose turn is inside the skip cap",
      input: {
        settledOverride: "settled",
        activeTurnId: "turn-still-running",
        idleDurationMs: 3 * 60 * 60 * 1000,
      },
      reap: false,
      reason: "active_turn",
      threadKind: "interactive",
      thresholdMs: DEFAULT_ACTIVE_TURN_SKIP_CAP_MS,
    },
    {
      name: "reaps a settled session whose turn outlived the skip cap",
      input: {
        settledOverride: "settled",
        activeTurnId: "turn-that-died",
        idleDurationMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS * 10,
      },
      reap: true,
      reason: "stale_active_turn",
      threadKind: "interactive",
      thresholdMs: DEFAULT_ACTIVE_TURN_SKIP_CAP_MS,
    },
    {
      name: "keeps an iteration session whose turn is inside the skip cap",
      input: {
        threadId: ITERATION_THREAD_ID,
        activeTurnId: "turn-still-running",
        idleDurationMs: 3 * 60 * 60 * 1000,
      },
      reap: false,
      reason: "active_turn",
      threadKind: "epic-run-iteration",
      thresholdMs: DEFAULT_ACTIVE_TURN_SKIP_CAP_MS,
    },
    {
      name: "reaps an iteration session whose turn outlived the skip cap",
      input: {
        threadId: ITERATION_THREAD_ID,
        activeTurnId: "turn-that-died",
        idleDurationMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS * 10,
      },
      reap: true,
      reason: "stale_active_turn",
      threadKind: "epic-run-iteration",
      thresholdMs: DEFAULT_ACTIVE_TURN_SKIP_CAP_MS,
    },
    {
      name: "keeps a turnless interactive session at the same three-hour age",
      input: { idleDurationMs: 3 * 60 * 60 * 1000 },
      reap: false,
      reason: "within_idle_threshold",
      threadKind: "interactive",
      thresholdMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS,
    },
    {
      name: "keeps a turnless interactive session at the same 24-hour age",
      input: { idleDurationMs: DEFAULT_ACTIVE_TURN_SKIP_CAP_MS },
      reap: false,
      reason: "within_idle_threshold",
      threadKind: "interactive",
      thresholdMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS,
    },
    {
      name: "reaps a turnless iteration session at the same 24-hour age",
      input: {
        threadId: ITERATION_THREAD_ID,
        idleDurationMs: DEFAULT_ACTIVE_TURN_SKIP_CAP_MS,
      },
      reap: true,
      reason: "epic_run_iteration_idle_threshold",
      threadKind: "epic-run-iteration",
      thresholdMs: DEFAULT_EPIC_RUN_ITERATION_IDLE_THRESHOLD_MS,
    },
    {
      name: "keeps a stopped binding even when its turn pointer is stale",
      input: {
        status: "stopped",
        activeTurnId: "turn-that-died",
        idleDurationMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS * 10,
      },
      reap: false,
      reason: "session_stopped",
      threadKind: "interactive",
      thresholdMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS,
    },
    {
      name: "keeps a session whose last-seen timestamp is in the future",
      input: { idleDurationMs: -60_000 },
      reap: false,
      reason: "within_idle_threshold",
      threadKind: "interactive",
      thresholdMs: DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decide(testCase.input)).toEqual({
        reap: testCase.reap,
        reason: testCase.reason,
        threadKind: testCase.threadKind,
        thresholdMs: testCase.thresholdMs,
      });
    });
  }

  it("honours injected thresholds instead of the defaults", () => {
    expect(
      decide({
        thresholds: INJECTED_THRESHOLDS,
        idleDurationMs: 5_000,
      }),
    ).toEqual({
      reap: false,
      reason: "within_idle_threshold",
      threadKind: "interactive",
      thresholdMs: 10_000,
    });

    expect(
      decide({
        threadId: ITERATION_THREAD_ID,
        thresholds: INJECTED_THRESHOLDS,
        idleDurationMs: 5_000,
      }),
    ).toEqual({
      reap: true,
      reason: "epic_run_iteration_idle_threshold",
      threadKind: "epic-run-iteration",
      thresholdMs: 1_000,
    });
  });

  it("honours an injected active-turn skip cap so tests do not wait a day", () => {
    expect(
      decide({
        thresholds: INJECTED_THRESHOLDS,
        activeTurnId: "turn-still-running",
        idleDurationMs: 1_999,
      }),
    ).toEqual({
      reap: false,
      reason: "active_turn",
      threadKind: "interactive",
      thresholdMs: 2_000,
    });

    expect(
      decide({
        thresholds: INJECTED_THRESHOLDS,
        activeTurnId: "turn-that-died",
        idleDurationMs: 2_000,
      }),
    ).toEqual({
      reap: true,
      reason: "stale_active_turn",
      threadKind: "interactive",
      thresholdMs: 2_000,
    });
  });

  it("caps the skip below the interactive backstop, not above it", () => {
    // The cap is shorter than the 36-hour interactive threshold, so the active
    // turn must be judged before the idle compare or it never fires.
    const decision = decide({
      activeTurnId: "turn-that-died",
      idleDurationMs: DEFAULT_ACTIVE_TURN_SKIP_CAP_MS + 1,
    });

    expect(DEFAULT_ACTIVE_TURN_SKIP_CAP_MS).toBeLessThan(DEFAULT_INTERACTIVE_IDLE_THRESHOLD_MS);
    expect(decision.reap).toBe(true);
  });
});

describe("minSessionReapThresholdMs", () => {
  it("is the shortest of the four thresholds", () => {
    expect(minSessionReapThresholdMs()).toBe(DEFAULT_EPIC_RUN_ITERATION_IDLE_THRESHOLD_MS);
    expect(minSessionReapThresholdMs(INJECTED_THRESHOLDS)).toBe(500);
  });

  it("counts the active-turn skip cap when the cap is the shortest", () => {
    expect(
      minSessionReapThresholdMs({
        interactiveIdleThresholdMs: 10_000,
        epicRunIterationIdleThresholdMs: 1_000,
        settledIdleThresholdMs: 500,
        activeTurnSkipCapMs: 100,
      }),
    ).toBe(100);
  });

  it("never exceeds the threshold any single decision can use", () => {
    const minimum = minSessionReapThresholdMs(INJECTED_THRESHOLDS);

    for (const threadId of [INTERACTIVE_THREAD_ID, ITERATION_THREAD_ID]) {
      for (const settledOverride of ["settled", "active", null] as const) {
        for (const activeTurnId of ["turn-still-running", null]) {
          expect(
            decide({
              threadId,
              settledOverride,
              activeTurnId,
              thresholds: INJECTED_THRESHOLDS,
              idleDurationMs: minimum - 1,
            }).reap,
          ).toBe(false);
        }
      }
    }
  });
});
