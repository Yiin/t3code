import { ProviderAccountLimit } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type ProviderAccountLimitsStoreError,
} from "../Errors.ts";
import {
  ClearExpiredProviderAccountLimitsInput,
  ClearProviderAccountLimitsForInstanceInput,
  ListProviderAccountLimitsForInstanceInput,
  ProviderAccountLimitsStore,
  type ProviderAccountLimitsStoreShape,
} from "../Services/ProviderAccountLimits.ts";

function toProviderAccountLimitsStoreError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProviderAccountLimitsStoreError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

// SQLite stores resets_at_estimated as 0/1.
const ProviderAccountLimitDbRow = ProviderAccountLimit.mapFields(
  Struct.assign({ resetsAtEstimated: Schema.Number }),
);

function toProviderAccountLimit(
  row: Schema.Schema.Type<typeof ProviderAccountLimitDbRow>,
): ProviderAccountLimit {
  return { ...row, resetsAtEstimated: row.resetsAtEstimated === 1 };
}

const makeProviderAccountLimitsStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProviderAccountLimit = SqlSchema.void({
    Request: ProviderAccountLimit,
    execute: (limit) => sql`
      INSERT INTO provider_account_limits (
        provider_instance_id, kind, driver, detected_at,
        resets_at, resets_at_estimated, source, detail
      ) VALUES (
        ${limit.providerInstanceId}, ${limit.kind}, ${limit.driver}, ${limit.detectedAt},
        ${limit.resetsAt}, ${limit.resetsAtEstimated ? 1 : 0}, ${limit.source}, ${limit.detail}
      )
      ON CONFLICT (provider_instance_id, kind) DO UPDATE SET
        driver = excluded.driver,
        detected_at = excluded.detected_at,
        resets_at = excluded.resets_at,
        resets_at_estimated = excluded.resets_at_estimated,
        source = excluded.source,
        detail = excluded.detail
      WHERE excluded.detected_at >= provider_account_limits.detected_at
    `,
  });

  const providerAccountLimitColumns = sql.literal(`
    provider_instance_id AS "providerInstanceId",
    driver,
    kind,
    detected_at AS "detectedAt",
    resets_at AS "resetsAt",
    resets_at_estimated AS "resetsAtEstimated",
    source,
    detail
  `);

  const listProviderAccountLimitsForInstance = SqlSchema.findAll({
    Request: ListProviderAccountLimitsForInstanceInput,
    Result: ProviderAccountLimitDbRow,
    execute: ({ providerInstanceId }) => sql`
      SELECT ${providerAccountLimitColumns}
      FROM provider_account_limits
      WHERE provider_instance_id = ${providerInstanceId}
      ORDER BY kind ASC
    `,
  });

  const listAllProviderAccountLimits = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderAccountLimitDbRow,
    execute: () => sql`
      SELECT ${providerAccountLimitColumns}
      FROM provider_account_limits
      ORDER BY provider_instance_id ASC, kind ASC
    `,
  });

  const clearProviderAccountLimitsForInstance = SqlSchema.void({
    Request: ClearProviderAccountLimitsForInstanceInput,
    execute: ({ providerInstanceId }) => sql`
      DELETE FROM provider_account_limits
      WHERE provider_instance_id = ${providerInstanceId}
    `,
  });

  const clearExpiredProviderAccountLimits = SqlSchema.void({
    Request: ClearExpiredProviderAccountLimitsInput,
    execute: ({ now }) => sql`
      DELETE FROM provider_account_limits
      WHERE resets_at IS NOT NULL AND resets_at <= ${now}
    `,
  });

  const recordLimit: ProviderAccountLimitsStoreShape["recordLimit"] = (input) =>
    upsertProviderAccountLimit(input).pipe(
      Effect.mapError(
        toProviderAccountLimitsStoreError(
          "ProviderAccountLimitsStore.recordLimit:query",
          "ProviderAccountLimitsStore.recordLimit:encodeRequest",
        ),
      ),
    );

  const listAll: ProviderAccountLimitsStoreShape["listAll"] = listAllProviderAccountLimits().pipe(
    Effect.map((rows) => rows.map(toProviderAccountLimit)),
    Effect.mapError(
      toProviderAccountLimitsStoreError(
        "ProviderAccountLimitsStore.listAll:query",
        "ProviderAccountLimitsStore.listAll:decodeRows",
      ),
    ),
  );

  const listForInstance: ProviderAccountLimitsStoreShape["listForInstance"] = (input) =>
    listProviderAccountLimitsForInstance(input).pipe(
      Effect.map((rows) => rows.map(toProviderAccountLimit)),
      Effect.mapError(
        toProviderAccountLimitsStoreError(
          "ProviderAccountLimitsStore.listForInstance:query",
          "ProviderAccountLimitsStore.listForInstance:decodeRows",
        ),
      ),
    );

  const clearForInstance: ProviderAccountLimitsStoreShape["clearForInstance"] = (input) =>
    clearProviderAccountLimitsForInstance(input).pipe(
      Effect.mapError(
        toProviderAccountLimitsStoreError(
          "ProviderAccountLimitsStore.clearForInstance:query",
          "ProviderAccountLimitsStore.clearForInstance:encodeRequest",
        ),
      ),
    );

  const clearExpired: ProviderAccountLimitsStoreShape["clearExpired"] = (input) =>
    clearExpiredProviderAccountLimits(input).pipe(
      Effect.mapError(
        toProviderAccountLimitsStoreError(
          "ProviderAccountLimitsStore.clearExpired:query",
          "ProviderAccountLimitsStore.clearExpired:encodeRequest",
        ),
      ),
    );

  return {
    recordLimit,
    listAll,
    listForInstance,
    clearForInstance,
    clearExpired,
  } satisfies ProviderAccountLimitsStoreShape;
});

export const ProviderAccountLimitsStoreLive = Layer.effect(
  ProviderAccountLimitsStore,
  makeProviderAccountLimitsStore,
);
