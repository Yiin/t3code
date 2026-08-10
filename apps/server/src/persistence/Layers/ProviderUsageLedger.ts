import { ProviderUsageSample } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type ProviderUsageLedgerStoreError,
} from "../Errors.ts";
import {
  ListProviderUsageForInstanceInput,
  ProviderUsageLedgerStore,
  PruneProviderUsageObservedBeforeInput,
  type ProviderUsageLedgerStoreShape,
} from "../Services/ProviderUsageLedger.ts";

function toProviderUsageLedgerStoreError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProviderUsageLedgerStoreError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

const makeProviderUsageLedgerStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProviderUsageSample = SqlSchema.void({
    Request: ProviderUsageSample,
    execute: (sample) => sql`
      INSERT INTO provider_usage_windows (
        provider_instance_id, window_id, utilization, resets_at, source, observed_at
      ) VALUES (
        ${sample.providerInstanceId}, ${sample.window}, ${sample.utilization},
        ${sample.resetsAt}, ${sample.source}, ${sample.observedAt}
      )
      ON CONFLICT (provider_instance_id, window_id) DO UPDATE SET
        utilization = excluded.utilization,
        resets_at = excluded.resets_at,
        source = excluded.source,
        observed_at = excluded.observed_at
      WHERE excluded.observed_at >= provider_usage_windows.observed_at
    `,
  });

  const providerUsageColumns = sql.literal(`
    provider_instance_id AS "providerInstanceId",
    window_id AS "window",
    utilization,
    resets_at AS "resetsAt",
    source,
    observed_at AS "observedAt"
  `);

  const listProviderUsageForInstance = SqlSchema.findAll({
    Request: ListProviderUsageForInstanceInput,
    Result: ProviderUsageSample,
    execute: ({ providerInstanceId }) => sql`
      SELECT ${providerUsageColumns}
      FROM provider_usage_windows
      WHERE provider_instance_id = ${providerInstanceId}
      ORDER BY window_id ASC
    `,
  });

  const listAllProviderUsage = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderUsageSample,
    execute: () => sql`
      SELECT ${providerUsageColumns}
      FROM provider_usage_windows
      ORDER BY provider_instance_id ASC, window_id ASC
    `,
  });

  const pruneProviderUsageObservedBefore = SqlSchema.void({
    Request: PruneProviderUsageObservedBeforeInput,
    execute: ({ cutoff }) => sql`
      DELETE FROM provider_usage_windows
      WHERE observed_at <= ${cutoff}
    `,
  });

  const recordSamples: ProviderUsageLedgerStoreShape["recordSamples"] = ({ samples }) =>
    Effect.forEach(
      samples,
      (sample) =>
        upsertProviderUsageSample(sample).pipe(
          Effect.mapError(
            toProviderUsageLedgerStoreError(
              "ProviderUsageLedgerStore.recordSamples:query",
              "ProviderUsageLedgerStore.recordSamples:encodeRequest",
            ),
          ),
        ),
      { discard: true },
    );

  const listForInstance: ProviderUsageLedgerStoreShape["listForInstance"] = (input) =>
    listProviderUsageForInstance(input).pipe(
      Effect.mapError(
        toProviderUsageLedgerStoreError(
          "ProviderUsageLedgerStore.listForInstance:query",
          "ProviderUsageLedgerStore.listForInstance:decodeRows",
        ),
      ),
    );

  const listAll: ProviderUsageLedgerStoreShape["listAll"] = listAllProviderUsage().pipe(
    Effect.mapError(
      toProviderUsageLedgerStoreError(
        "ProviderUsageLedgerStore.listAll:query",
        "ProviderUsageLedgerStore.listAll:decodeRows",
      ),
    ),
  );

  const pruneObservedBefore: ProviderUsageLedgerStoreShape["pruneObservedBefore"] = (input) =>
    pruneProviderUsageObservedBefore(input).pipe(
      Effect.mapError(
        toProviderUsageLedgerStoreError(
          "ProviderUsageLedgerStore.pruneObservedBefore:query",
          "ProviderUsageLedgerStore.pruneObservedBefore:encodeRequest",
        ),
      ),
    );

  return {
    recordSamples,
    listForInstance,
    listAll,
    pruneObservedBefore,
  } satisfies ProviderUsageLedgerStoreShape;
});

export const ProviderUsageLedgerStoreLive = Layer.effect(
  ProviderUsageLedgerStore,
  makeProviderUsageLedgerStore,
);
