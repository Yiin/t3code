import { describe, expect, it } from "@effect/vitest";
import { EpicRunId, ThreadId, type EpicSubagentMap } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { EpicSubagentRegistry } from "./epicSubagents.ts";

const subagents: EpicSubagentMap = {
  reviewer: { description: "Reviews code", prompt: "You are a reviewer", model: "fable" },
};

describe("EpicSubagentRegistry", () => {
  const runId = EpicRunId.make("run-1");
  const threadId = ThreadId.make("thread-1");

  it.effect("resolves nothing for an unbound thread", () =>
    Effect.gen(function* () {
      const registry = yield* EpicSubagentRegistry;
      expect(Option.isNone(yield* registry.resolve(threadId))).toBe(true);
    }).pipe(Effect.provide(EpicSubagentRegistry.layer)),
  );

  it.effect("resolves the definitions bound to a thread", () =>
    Effect.gen(function* () {
      const registry = yield* EpicSubagentRegistry;
      yield* registry.bindThread({ runId, threadId, subagents });
      expect(yield* registry.resolve(threadId)).toEqual(Option.some(subagents));
    }).pipe(Effect.provide(EpicSubagentRegistry.layer)),
  );

  it.effect("resolves nothing for an empty bound map", () =>
    Effect.gen(function* () {
      const registry = yield* EpicSubagentRegistry;
      yield* registry.bindThread({ runId, threadId, subagents: {} });
      expect(Option.isNone(yield* registry.resolve(threadId))).toBe(true);
    }).pipe(Effect.provide(EpicSubagentRegistry.layer)),
  );

  it.effect("keeps other runs' bindings when one run is released", () =>
    Effect.gen(function* () {
      const registry = yield* EpicSubagentRegistry;
      const otherThreadId = ThreadId.make("thread-2");
      yield* registry.bindThread({ runId, threadId, subagents });
      yield* registry.bindThread({
        runId: EpicRunId.make("run-2"),
        threadId: otherThreadId,
        subagents,
      });

      yield* registry.releaseRun(runId);

      expect(Option.isNone(yield* registry.resolve(threadId))).toBe(true);
      expect(yield* registry.resolve(otherThreadId)).toEqual(Option.some(subagents));
    }).pipe(Effect.provide(EpicSubagentRegistry.layer)),
  );
});
