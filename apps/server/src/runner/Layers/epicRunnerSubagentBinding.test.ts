/**
 * The runner's per-role subagents have to reach the worker's session.
 *
 * `ProviderService` resolves the definitions by thread id when it starts a
 * session, so the binding written here is the only thing standing between the
 * epic role policy and the agents a worker can spawn. A worker session started
 * through the runner must therefore carry a non-empty map whenever the policy
 * configures one, and it must be bound before the thread exists — the session
 * starts lazily on the first turn.
 */
import {
  EpicRunId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type EpicSubagentMap,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";

import type { OrchestrationCommand } from "@t3tools/contracts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { EpicSubagentRegistry } from "../../provider/epicSubagents.ts";
import { makeServerPoolDispatch } from "./PoolDispatch.ts";

const runId = EpicRunId.make("run-subagents-1");
const threadId = ThreadId.make("thread-iteration-1");

const planner: EpicSubagentMap = {
  planner: {
    description: "Plans one child.",
    prompt: "You plan.",
    model: "claude-opus-5",
  },
};

function harness(subagents: EpicSubagentMap, sessionDriver?: string) {
  const dispatched: OrchestrationCommand[] = [];
  const bindings: Array<{
    readonly runId: EpicRunId;
    readonly threadId: ThreadId;
    readonly subagents: EpicSubagentMap;
    /** Commands dispatched before this binding, so ordering is checkable. */
    readonly dispatchedBefore: number;
  }> = [];
  const boundWorkers: ThreadId[] = [];

  const subagentRegistry: EpicSubagentRegistry["Service"] = {
    bindThread: (input) =>
      Effect.sync(() => {
        bindings.push({ ...input, dispatchedBefore: dispatched.length });
      }),
    resolve: () => Effect.succeed(Option.none()),
    releaseRun: () => Effect.void,
  };

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
    workerScopeRegistry: {
      setRunPreparation: () => Effect.void,
      bindWorker: (input: { readonly threadId: ThreadId }) =>
        Effect.sync(() => {
          boundWorkers.push(input.threadId);
        }),
      resolve: () => Effect.succeed(Option.none()),
      releaseRun: () => Effect.void,
    } as never,
    subagentRegistry,
    readIterationSubagents: () => Effect.succeed(subagents),
    readSessionDriverKind: () =>
      Effect.succeed(sessionDriver === undefined ? null : ProviderDriverKind.make(sessionDriver)),
  });

  const createInput = {
    runId,
    iterationIndex: 3,
    threadId,
    projectId: ProjectId.make("project-1"),
    title: "iteration 3",
    selection: { instanceId: "claude-work", model: "claude-opus-5" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    startedAt: "2026-08-13T12:00:00.000Z",
    policy: {},
  } as unknown as Parameters<typeof dispatch.createIteration>[0];

  return { dispatch, dispatched, bindings, boundWorkers, createInput };
}

describe("epic runner subagent binding", () => {
  it.effect("binds the iteration thread to the policy's subagents before the thread exists", () =>
    Effect.gen(function* () {
      const { dispatch, bindings, createInput } = harness(planner);

      yield* dispatch.createIteration(createInput);

      expect(bindings).toEqual([{ runId, threadId, subagents: planner, dispatchedBefore: 0 }]);
    }),
  );

  it.effect("binds nothing when the policy configures no in-session role", () =>
    Effect.gen(function* () {
      const { dispatch, bindings, boundWorkers, createInput } = harness({});

      yield* dispatch.createIteration(createInput);

      expect(bindings).toEqual([]);
      // The worker scope still binds: an empty subagent map is not a reason to
      // change anything else about the iteration.
      expect(boundWorkers).toEqual([threadId]);
    }),
  );

  /**
   * Only the Claude adapter reads the bound map. Every other adapter drops it
   * without a word, so a run on Codex or Kimi silently loses its stage agents
   * and looks exactly like a run that kept them. One log line is the only
   * evidence, and it must not fire on the harness that does honour the map.
   */
  it.effect("says so when the worker's harness will drop the bound map", () =>
    Effect.gen(function* () {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });
      const { dispatch, bindings, createInput } = harness(planner, "codex");

      yield* dispatch
        .createIteration(createInput)
        .pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));

      // The binding still happens: the drop belongs to the adapter, not here.
      expect(bindings).toHaveLength(1);
      expect(
        messages.filter(
          (message) =>
            Array.isArray(message) && message[0] === "epic.runner.subagents-unsupported-harness",
        ),
      ).toHaveLength(1);
    }),
  );

  it.effect("stays quiet on a Claude worker and on an unknown account", () =>
    Effect.gen(function* () {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });
      const claude = harness(planner, "claudeAgent");
      const unknown = harness(planner);

      yield* claude.dispatch
        .createIteration(claude.createInput)
        .pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      yield* unknown.dispatch
        .createIteration(unknown.createInput)
        .pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));

      expect(claude.bindings).toHaveLength(1);
      expect(unknown.bindings).toHaveLength(1);
      expect(
        messages.filter(
          (message) =>
            Array.isArray(message) && message[0] === "epic.runner.subagents-unsupported-harness",
        ),
      ).toEqual([]);
    }),
  );
});
