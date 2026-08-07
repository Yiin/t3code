/** Fresh provider snapshots used by shared fallback policy. */
import type { ServerProvider } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

export interface ProviderInventoryShape {
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
}
