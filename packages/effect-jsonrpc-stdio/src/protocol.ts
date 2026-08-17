import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

export interface ProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
}

export const logProtocol = (
  event: ProtocolLogEvent,
  options: {
    readonly logIncoming?: boolean;
    readonly logOutgoing?: boolean;
    readonly logger?: (event: ProtocolLogEvent) => Effect.Effect<void, never>;
    readonly label?: string;
  },
) => {
  if (event.direction === "incoming" && !options.logIncoming) return Effect.void;
  if (event.direction === "outgoing" && !options.logOutgoing) return Effect.void;
  return (
    options.logger?.(event) ??
    Effect.logDebug(`${options.label ?? "JSON-RPC"} protocol event`).pipe(
      Effect.annotateLogs({ event }),
    )
  );
};

export interface PendingRequest<E> {
  readonly deferred: Deferred.Deferred<unknown, E>;
  readonly method: string;
}

export const makePendingRequests = <E>() => Ref.make(new Map<string, PendingRequest<E>>());

export const takePending = <E>(
  pending: Ref.Ref<Map<string, PendingRequest<E>>>,
  requestId: string,
) =>
  Ref.modify(pending, (current) => {
    const value = current.get(requestId);
    if (!value) return [undefined, current] as const;
    const next = new Map(current);
    next.delete(requestId);
    return [value, next] as const;
  });

export const failPending = <E>(pending: Ref.Ref<Map<string, PendingRequest<E>>>, error: E) =>
  Ref.getAndSet(pending, new Map()).pipe(
    Effect.flatMap((requests) =>
      Effect.forEach([...requests.values()], ({ deferred }) => Deferred.fail(deferred, error), {
        discard: true,
      }),
    ),
  );

export const makeTerminationLatch = () => Ref.make(false);

export const runOnce = (
  latch: Ref.Ref<boolean>,
  effect: Effect.Effect<void>,
): Effect.Effect<void> =>
  Ref.modify(latch, (handled) => (handled ? [Effect.void, true] : ([effect, true] as const))).pipe(
    Effect.flatten,
  );
