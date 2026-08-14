import {
  IsoDateTime,
  ProviderAccountLimit,
  type ProviderAccountLimit as ProviderAccountLimitType,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProviderAccountLimitsStoreError } from "../Errors.ts";

export const RecordProviderAccountLimitInput = ProviderAccountLimit;
export type RecordProviderAccountLimitInput = typeof RecordProviderAccountLimitInput.Type;

export const ListProviderAccountLimitsForInstanceInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
});
export type ListProviderAccountLimitsForInstanceInput =
  typeof ListProviderAccountLimitsForInstanceInput.Type;

export const ClearProviderAccountLimitsForInstanceInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
});
export type ClearProviderAccountLimitsForInstanceInput =
  typeof ClearProviderAccountLimitsForInstanceInput.Type;

export const ClearExpiredProviderAccountLimitsInput = Schema.Struct({
  now: IsoDateTime,
});
export type ClearExpiredProviderAccountLimitsInput =
  typeof ClearExpiredProviderAccountLimitsInput.Type;

export interface ProviderAccountLimitsStoreShape {
  /** Upsert on (instance, kind); a stored row with a newer detectedAt wins. */
  readonly recordLimit: (
    input: RecordProviderAccountLimitInput,
  ) => Effect.Effect<void, ProviderAccountLimitsStoreError>;
  readonly listAll: Effect.Effect<
    ReadonlyArray<ProviderAccountLimitType>,
    ProviderAccountLimitsStoreError
  >;
  readonly listForInstance: (
    input: ListProviderAccountLimitsForInstanceInput,
  ) => Effect.Effect<ReadonlyArray<ProviderAccountLimitType>, ProviderAccountLimitsStoreError>;
  readonly clearForInstance: (
    input: ClearProviderAccountLimitsForInstanceInput,
  ) => Effect.Effect<void, ProviderAccountLimitsStoreError>;
  /** Deletes rows whose resets_at is non-null and at or before now. */
  readonly clearExpired: (
    input: ClearExpiredProviderAccountLimitsInput,
  ) => Effect.Effect<void, ProviderAccountLimitsStoreError>;
}

export class ProviderAccountLimitsStore extends Context.Service<
  ProviderAccountLimitsStore,
  ProviderAccountLimitsStoreShape
>()("t3/persistence/Services/ProviderAccountLimits/ProviderAccountLimitsStore") {}
