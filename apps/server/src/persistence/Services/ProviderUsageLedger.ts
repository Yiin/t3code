import {
  IsoDateTime,
  ProviderInstanceId,
  ProviderUsageSample,
  type ProviderUsageSample as ProviderUsageSampleType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProviderUsageLedgerStoreError } from "../Errors.ts";

export const RecordProviderUsageSamplesInput = Schema.Struct({
  samples: Schema.Array(ProviderUsageSample),
});
export type RecordProviderUsageSamplesInput = typeof RecordProviderUsageSamplesInput.Type;

export const ListProviderUsageForInstanceInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
});
export type ListProviderUsageForInstanceInput = typeof ListProviderUsageForInstanceInput.Type;

export const PruneProviderUsageObservedBeforeInput = Schema.Struct({
  cutoff: IsoDateTime,
});
export type PruneProviderUsageObservedBeforeInput =
  typeof PruneProviderUsageObservedBeforeInput.Type;

export interface ProviderUsageLedgerStoreShape {
  readonly recordSamples: (
    input: RecordProviderUsageSamplesInput,
  ) => Effect.Effect<void, ProviderUsageLedgerStoreError>;
  readonly listForInstance: (
    input: ListProviderUsageForInstanceInput,
  ) => Effect.Effect<ReadonlyArray<ProviderUsageSampleType>, ProviderUsageLedgerStoreError>;
  readonly listAll: Effect.Effect<
    ReadonlyArray<ProviderUsageSampleType>,
    ProviderUsageLedgerStoreError
  >;
  readonly pruneObservedBefore: (
    input: PruneProviderUsageObservedBeforeInput,
  ) => Effect.Effect<void, ProviderUsageLedgerStoreError>;
}

export class ProviderUsageLedgerStore extends Context.Service<
  ProviderUsageLedgerStore,
  ProviderUsageLedgerStoreShape
>()("t3/persistence/Services/ProviderUsageLedger/ProviderUsageLedgerStore") {}
