import { describe, expect, it } from "@effect/vitest";
import { EpicRunId, ProviderWorkerScopeBinding, ThreadId } from "@t3tools/contracts";
import { workerScopeUnitName } from "@t3tools/epic-core/workerScope";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { EpicWorkerScopeRegistry, wrapSpawnWithWorkerScope } from "./workerScope.ts";

const binding = ProviderWorkerScopeBinding.make({ scopeId: "abc123", worker: "iteration-0" });

describe("wrapSpawnWithWorkerScope", () => {
  it("is the identity when no binding is attached", () => {
    expect(wrapSpawnWithWorkerScope(undefined, "codex", ["app-server"])).toEqual({
      command: "codex",
      args: ["app-server"],
    });
  });

  it("rewrites the spawn into the bound systemd scope unit", () => {
    expect(wrapSpawnWithWorkerScope(binding, "codex", ["app-server"])).toEqual({
      command: "systemd-run",
      args: [
        "--user",
        "--scope",
        "--quiet",
        "--slice=cook-epic",
        `--unit=${workerScopeUnitName("abc123", "iteration-0")}`,
        "--",
        "codex",
        "app-server",
      ],
    });
  });
});

describe("EpicWorkerScopeRegistry", () => {
  const runId = EpicRunId.make("run-1");
  const threadId = ThreadId.make("thread-1");

  it.effect("resolves the binding for a bound thread of an active run", () =>
    Effect.gen(function* () {
      const registry = yield* EpicWorkerScopeRegistry;
      yield* registry.setRunPreparation(runId, { scopeId: "abc123", active: true });
      yield* registry.bindWorker({ runId, threadId, worker: "iteration-0" });

      const resolved = yield* registry.resolve(threadId);
      expect(Option.isSome(resolved)).toBe(true);
      expect(Option.getOrNull(resolved)).toEqual({ scopeId: "abc123", worker: "iteration-0" });
    }).pipe(Effect.provide(EpicWorkerScopeRegistry.layer)),
  );

  it.effect("resolves None when the run's preparation is inactive", () =>
    Effect.gen(function* () {
      const registry = yield* EpicWorkerScopeRegistry;
      yield* registry.setRunPreparation(runId, { scopeId: "abc123", active: false });
      yield* registry.bindWorker({ runId, threadId, worker: "iteration-0" });

      expect(Option.isNone(yield* registry.resolve(threadId))).toBe(true);
    }).pipe(Effect.provide(EpicWorkerScopeRegistry.layer)),
  );

  it.effect("resolves None for an unbound thread", () =>
    Effect.gen(function* () {
      const registry = yield* EpicWorkerScopeRegistry;
      yield* registry.setRunPreparation(runId, { scopeId: "abc123", active: true });

      expect(Option.isNone(yield* registry.resolve(threadId))).toBe(true);
    }).pipe(Effect.provide(EpicWorkerScopeRegistry.layer)),
  );

  it.effect("resolves None for a binding whose run has no preparation", () =>
    Effect.gen(function* () {
      const registry = yield* EpicWorkerScopeRegistry;
      yield* registry.bindWorker({ runId, threadId, worker: "iteration-0" });

      expect(Option.isNone(yield* registry.resolve(threadId))).toBe(true);
    }).pipe(Effect.provide(EpicWorkerScopeRegistry.layer)),
  );

  it.effect("releaseRun drops the preparation and every binding of the run", () =>
    Effect.gen(function* () {
      const registry = yield* EpicWorkerScopeRegistry;
      yield* registry.setRunPreparation(runId, { scopeId: "abc123", active: true });
      yield* registry.bindWorker({ runId, threadId, worker: "iteration-0" });
      yield* registry.releaseRun(runId);

      expect(Option.isNone(yield* registry.resolve(threadId))).toBe(true);
    }).pipe(Effect.provide(EpicWorkerScopeRegistry.layer)),
  );
});
