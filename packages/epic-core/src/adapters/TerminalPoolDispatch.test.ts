/**
 * The terminal harness refuses a resume, and refuses it without working.
 *
 * A refusal that first spawned a process would be worse than useless: the
 * agent would run with no memory of the interrupted work while the caller was
 * told nothing was picked up.
 */
import { ProviderInstanceId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { AgentDispatchShape } from "../ports/AgentDispatch.ts";
import type { ResumableIteration } from "../ports/PoolDispatch.ts";
import { makeTerminalPoolDispatch } from "./TerminalPoolDispatch.ts";

const resumable = (): ResumableIteration => ({
  ref: "/tmp/artifacts/iteration-3.jsonl",
  runId: "run-1" as ResumableIteration["runId"],
  iterationIndex: 3,
  issueId: "t3code-y5l.8",
  prompt: "Carry on where you left off",
  selection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
  runtimeMode: "full-access",
  policy: {} as ResumableIteration["policy"],
  workspace: {
    cwd: "/tmp/wt",
    worktreePath: "/tmp/wt",
    branch: "epic/t3code-y5l.8",
    siblingWorktrees: [],
    siblingRule: null,
  },
  headBefore: null,
  branchBase: null,
  initialWorktreeFingerprint: null,
});

describe("TerminalPoolDispatch resumeIteration", () => {
  it.effect("refuses on capability and starts nothing", () =>
    Effect.gen(function* () {
      let startIterationCalls = 0;
      const dispatch = makeTerminalPoolDispatch({
        dispatch: {
          capabilities: { lifecycle: { resume: "unsupported" } },
          startIteration: () =>
            Effect.sync(() => {
              startIterationCalls += 1;
              throw new Error("resumeIteration must not start an iteration");
            }),
          runAuxiliary: () => Effect.die(new Error("unused")),
        } as unknown as AgentDispatchShape,
      });

      const outcome = yield* dispatch.resumeIteration(resumable());

      assert.equal(outcome._tag, "unavailable");
      if (outcome._tag === "unavailable") {
        assert.equal(outcome.refusal._tag, "capability");
        // The refusal names the iteration, so a run's log says which child
        // was dropped back to a fresh start.
        assert.match(outcome.refusal.detail, /iteration 3/);
      }
      assert.equal(startIterationCalls, 0);
      // The declaration and the behaviour are the same answer.
      assert.equal(dispatch.capabilities.lifecycle.resume, "unsupported");
    }),
  );
});
