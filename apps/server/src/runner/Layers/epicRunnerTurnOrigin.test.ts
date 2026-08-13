/**
 * The epic runner writes its own prompts, so they must say so.
 *
 * An iteration prompt and every continuation land as `role: "user"` rows on
 * the iteration thread, the same role a human's message uses. The web timeline
 * labels an agent-authored row "Parent" and leaves a human's unlabelled, so a
 * missing `origin` makes an epic thread read as if a person typed it.
 */
import type { OrchestrationCommand } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeServerPoolDispatch } from "./EpicRunnerPoolPorts.ts";

const threadId = ThreadId.make("thread-iteration-1");

function harness() {
  const dispatched: OrchestrationCommand[] = [];
  const dispatch = makeServerPoolDispatch({
    engine: {
      dispatch: (command: OrchestrationCommand) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: dispatched.length });
      },
    } as unknown as OrchestrationEngineShape,
    projectionSnapshotQuery: {} as unknown as ProjectionSnapshotQueryShape,
    processRunner: {} as never,
    projectSetupScriptRunner: {} as never,
    crypto: { randomUUIDv4: Effect.succeed("uuid-1") } as never,
    workerScopeRegistry: {} as never,
    subagentRegistry: {} as never,
    readIterationSubagents: () => Effect.succeed({}),
  });

  const beginTurnInput = {
    threadId,
    prompt: "Cook the next child",
    policy: {},
    iterationIndex: 1,
    headBefore: null,
    branchBase: null,
    initialWorktreeFingerprint: null,
  } as unknown as Parameters<typeof dispatch.beginTurn>[0];

  return { dispatched, dispatch, beginTurnInput };
}

function turnStarts(commands: ReadonlyArray<OrchestrationCommand>) {
  return commands.filter((command) => command.type === "thread.turn.start");
}

describe("epic runner turn origin", () => {
  it.effect("stamps the iteration prompt and its continuations as agent-authored", () =>
    Effect.gen(function* () {
      const { dispatched, dispatch, beginTurnInput } = harness();

      const handle = yield* dispatch.beginTurn(beginTurnInput);
      yield* handle.continueTurn("Keep going");

      const starts = turnStarts(dispatched);
      expect(starts).toHaveLength(2);
      for (const start of starts) {
        expect(start).toMatchObject({ origin: "agent", message: { role: "user" } });
      }
    }),
  );

  it.effect("declares adopt-ref resume before any iteration exists", () =>
    Effect.gen(function* () {
      const { dispatch, beginTurnInput } = harness();

      // Restart reconciliation reads this with no handle in hand: an
      // iteration's ref is its thread id, which outlives the process.
      expect(dispatch.capabilities.lifecycle.resume).toBe("adopt-ref");

      const handle = yield* dispatch.beginTurn(beginTurnInput);
      expect(handle.capabilities).toEqual(dispatch.capabilities);
    }),
  );
});
