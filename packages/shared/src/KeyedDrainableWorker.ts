/**
 * KeyedDrainableWorker - A queue-based worker with one serial lane per key.
 *
 * Items that share a key run one at a time, in enqueue order. Items with
 * different keys run concurrently, so a slow item only holds up its own key.
 * A key's lane fiber exits as soon as its queue is empty, so idle keys hold
 * no fiber and no state. `drain()` resolves when every lane is empty and
 * idle, which lets tests replace timing-sensitive `Effect.sleep` calls.
 *
 * @module KeyedDrainableWorker
 */
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as TxRef from "effect/TxRef";

export interface KeyedDrainableWorker<A> {
  /**
   * Enqueue a work item on its key's lane and track it for `drain()`.
   *
   * Starts a lane fiber when the key has none.
   */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /**
   * Resolves when every key's queue is empty and no item is processing.
   */
  readonly drain: Effect.Effect<void>;
}

interface KeyedDrainableWorkerState<K, A> {
  /** Queued items per key. A key is present while its lane fiber runs. */
  readonly pendingByKey: ReadonlyMap<K, ReadonlyArray<A>>;
  /** Items enqueued but not yet finished, across all keys. */
  readonly outstanding: number;
}

/**
 * Create a keyed drainable worker.
 *
 * Lane fibers are forked into the current scope and are interrupted when the
 * scope closes. A failure in one item is swallowed so the lane goes on with
 * the next item. `process` should log its own failures. Unlike
 * `DrainableWorker`, an interrupt raised from inside `process` ends only that
 * item, not the worker; only closing the scope stops the lanes.
 *
 * @param options.key - The lane an item belongs to.
 * @param options.process - The effect to run for each queued item.
 * @returns A `KeyedDrainableWorker` with `enqueue` and `drain`.
 */
export const makeKeyedDrainableWorker = <K, A, E, R>(options: {
  readonly key: (item: A) => K;
  readonly process: (item: A) => Effect.Effect<void, E, R>;
}): Effect.Effect<KeyedDrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const fibers = yield* FiberSet.make<void, never>();
    const runFork = yield* FiberSet.runtime(fibers)<R>();
    const stateRef = yield* TxRef.make<KeyedDrainableWorkerState<K, A>>({
      pendingByKey: new Map(),
      outstanding: 0,
    });

    // Take the key's next item, or remove the key when its queue is empty.
    // Both happen in one transaction, so an enqueue never lands on a lane
    // that is about to exit.
    const takeNext = (key: K): Effect.Effect<A | undefined> =>
      TxRef.modify(stateRef, (state) => {
        const pending = state.pendingByKey.get(key) ?? [];
        const pendingByKey = new Map(state.pendingByKey);
        const [next, ...rest] = pending;
        if (next === undefined) {
          pendingByKey.delete(key);
          return [undefined, { ...state, pendingByKey }] as const;
        }
        pendingByKey.set(key, rest);
        return [next, { ...state, pendingByKey }] as const;
      }).pipe(Effect.tx);

    const runLane = (key: K): Effect.Effect<void, never, R> =>
      takeNext(key).pipe(
        Effect.flatMap((item) =>
          item === undefined
            ? Effect.void
            : options.process(item).pipe(
                Effect.catchCause(() => Effect.void),
                Effect.ensuring(
                  TxRef.update(stateRef, (state) => ({
                    ...state,
                    outstanding: state.outstanding - 1,
                  })),
                ),
                Effect.flatMap(() => runLane(key)),
              ),
        ),
      );

    const enqueue: KeyedDrainableWorker<A>["enqueue"] = (item) => {
      const key = options.key(item);
      return TxRef.modify(stateRef, (state) => {
        const pending = state.pendingByKey.get(key);
        const pendingByKey = new Map(state.pendingByKey);
        pendingByKey.set(key, [...(pending ?? []), item]);
        return [
          pending === undefined,
          { pendingByKey, outstanding: state.outstanding + 1 },
        ] as const;
      }).pipe(
        Effect.tx,
        Effect.flatMap((startLane) =>
          startLane ? Effect.sync(() => runFork(runLane(key))) : Effect.void,
        ),
        Effect.asVoid,
        Effect.uninterruptible,
      );
    };

    const drain: KeyedDrainableWorker<A>["drain"] = TxRef.get(stateRef).pipe(
      Effect.tap((state) => (state.outstanding > 0 ? Effect.txRetry : Effect.void)),
      Effect.asVoid,
      Effect.tx,
    );

    return { enqueue, drain } satisfies KeyedDrainableWorker<A>;
  });
