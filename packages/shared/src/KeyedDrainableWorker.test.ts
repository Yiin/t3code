import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeKeyedDrainableWorker } from "./KeyedDrainableWorker.ts";

interface Item {
  readonly key: string;
  readonly value: string;
}

describe("makeKeyedDrainableWorker", () => {
  it.live("processes items with the same key serially in enqueue order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        let active = 0;
        let maxActive = 0;

        const worker = yield* makeKeyedDrainableWorker<string, Item, never, never>({
          key: (item) => item.key,
          process: (item) =>
            Effect.gen(function* () {
              active += 1;
              maxActive = Math.max(maxActive, active);
              yield* Effect.sleep("5 millis");
              processed.push(item.value);
              active -= 1;
            }),
        });

        for (const value of ["1", "2", "3", "4"]) {
          yield* worker.enqueue({ key: "a", value });
        }
        yield* worker.drain;

        expect(processed).toEqual(["1", "2", "3", "4"]);
        expect(maxActive).toBe(1);
      }),
    ),
  );

  it.live("keeps processing other keys while one key is blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const blockedStarted = yield* Deferred.make<void>();
        const releaseBlocked = yield* Deferred.make<void>();
        const otherDone = yield* Deferred.make<void>();

        const worker = yield* makeKeyedDrainableWorker<string, Item, never, never>({
          key: (item) => item.key,
          process: (item) =>
            item.key === "a"
              ? Deferred.succeed(blockedStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseBlocked)),
                )
              : Deferred.succeed(otherDone, undefined).pipe(Effect.asVoid),
        });

        yield* worker.enqueue({ key: "a", value: "slow" });
        yield* Deferred.await(blockedStarted);
        yield* worker.enqueue({ key: "b", value: "fast" });
        yield* Deferred.await(otherDone);

        yield* Deferred.succeed(releaseBlocked, undefined);
        yield* worker.drain;
      }),
    ),
  );

  it.live("drain waits for every key to be empty and idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseA = yield* Deferred.make<void>();
        const releaseB = yield* Deferred.make<void>();

        const worker = yield* makeKeyedDrainableWorker<string, Item, never, never>({
          key: (item) => item.key,
          process: (item) => Deferred.await(item.key === "a" ? releaseA : releaseB),
        });

        yield* worker.drain;

        yield* worker.enqueue({ key: "a", value: "1" });
        yield* worker.enqueue({ key: "b", value: "1" });

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(Effect.tap(() => Deferred.succeed(drained, undefined))),
        );

        yield* Deferred.succeed(releaseA, undefined);
        yield* Effect.sleep("10 millis");
        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseB, undefined);
        yield* Deferred.await(drained);
      }),
    ),
  );

  it.live("keeps the key's lane going after an item fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];

        const worker = yield* makeKeyedDrainableWorker<string, Item, string, never>({
          key: (item) => item.key,
          process: (item) =>
            Effect.gen(function* () {
              processed.push(item.value);
              if (item.value === "fail") {
                return yield* Effect.fail("boom");
              }
              if (item.value === "die") {
                return yield* Effect.die(new Error("boom"));
              }
            }),
        });

        yield* worker.enqueue({ key: "a", value: "fail" });
        yield* worker.enqueue({ key: "a", value: "die" });
        yield* worker.enqueue({ key: "a", value: "after" });
        yield* worker.drain;
        yield* worker.enqueue({ key: "a", value: "later" });
        yield* worker.drain;

        expect(processed).toEqual(["fail", "die", "after", "later"]);
      }),
    ),
  );

  it.live("ends an idle key's lane fiber and starts a new one on the next enqueue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fiberIds: number[] = [];

        const worker = yield* makeKeyedDrainableWorker<string, Item, never, never>({
          key: (item) => item.key,
          process: () =>
            Effect.withFiber((fiber) => {
              fiberIds.push(fiber.id);
              return Effect.void;
            }),
        });

        yield* worker.enqueue({ key: "a", value: "1" });
        yield* worker.drain;
        yield* worker.enqueue({ key: "a", value: "2" });
        yield* worker.drain;

        expect(fiberIds).toHaveLength(2);
        expect(fiberIds[0]).not.toBe(fiberIds[1]);
      }),
    ),
  );
});
