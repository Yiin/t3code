import type { ProviderUsageReading } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

export interface ProviderUsageReaderShape {
  /** Never fails. Returns [] when the account has no plan limits or the read failed. */
  readonly readUsage: Effect.Effect<ReadonlyArray<ProviderUsageReading>>;
}
