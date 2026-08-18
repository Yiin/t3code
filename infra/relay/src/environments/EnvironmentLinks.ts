import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
  RelayManagedEndpoint,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { and, eq, isNull } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayEnvironmentLinks } from "../persistence/schema.ts";

export interface RelayLinkedEnvironmentRecord extends RelayClientEnvironmentRecord {
  readonly environmentPublicKey: string;
}

export class EnvironmentLinkUpsertPersistenceError extends Schema.TaggedErrorClass<EnvironmentLinkUpsertPersistenceError>()(
  "EnvironmentLinkUpsertPersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    deviceId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist environment link for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkListPersistenceError extends Schema.TaggedErrorClass<EnvironmentLinkListPersistenceError>()(
  "EnvironmentLinkListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list environment links for user '${this.userId}'`;
  }
}

export class EnvironmentLinkLookupPersistenceError extends Schema.TaggedErrorClass<EnvironmentLinkLookupPersistenceError>()(
  "EnvironmentLinkLookupPersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to look up environment link for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinkRevokePersistenceError extends Schema.TaggedErrorClass<EnvironmentLinkRevokePersistenceError>()(
  "EnvironmentLinkRevokePersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to revoke environment link for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class EnvironmentLinks extends Context.Service<
  EnvironmentLinks,
  {
    readonly upsert: (input: {
      readonly userId: string;
      readonly request: RelayEnvironmentLinkRequest;
      readonly proof: RelayEnvironmentLinkProofPayload;
      readonly endpoint: RelayManagedEndpoint;
    }) => Effect.Effect<void, EnvironmentLinkUpsertPersistenceError>;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<
      ReadonlyArray<RelayClientEnvironmentRecord>,
      EnvironmentLinkListPersistenceError
    >;
    readonly getForUser: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<RelayLinkedEnvironmentRecord | null, EnvironmentLinkLookupPersistenceError>;
    readonly revokeForUser: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<boolean, EnvironmentLinkRevokePersistenceError>;
  }
>()("t3code-relay/environments/EnvironmentLinks") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return EnvironmentLinks.of({
    upsert: Effect.fn("relay.environment_links.upsert")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.proof.environmentId,
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      const { request, proof } = input;
      const environmentId = proof.environmentId;
      const { endpoint } = input;
      yield* db
        .insert(relayEnvironmentLinks)
        .values({
          userId: input.userId,
          environmentId,
          environmentLabel: proof.descriptor.label,
          environmentPublicKey: proof.environmentPublicKey,
          endpointHttpBaseUrl: endpoint.httpBaseUrl,
          endpointWsBaseUrl: endpoint.wsBaseUrl,
          endpointProviderKind: endpoint.providerKind,
          notificationsEnabled: request.notificationsEnabled,
          liveActivitiesEnabled: request.liveActivitiesEnabled,
          managedTunnelsEnabled: request.managedTunnelsEnabled,
          createdByDeviceId: request.deviceId ?? null,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [relayEnvironmentLinks.userId, relayEnvironmentLinks.environmentId],
          set: {
            environmentPublicKey: proof.environmentPublicKey,
            environmentLabel: proof.descriptor.label,
            endpointHttpBaseUrl: endpoint.httpBaseUrl,
            endpointWsBaseUrl: endpoint.wsBaseUrl,
            endpointProviderKind: endpoint.providerKind,
            notificationsEnabled: request.notificationsEnabled,
            liveActivitiesEnabled: request.liveActivitiesEnabled,
            managedTunnelsEnabled: request.managedTunnelsEnabled,
            createdByDeviceId: request.deviceId ?? null,
            revokedAt: null,
            updatedAt: now,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkUpsertPersistenceError({
                userId: input.userId,
                environmentId,
                ...(request.deviceId === undefined ? {} : { deviceId: request.deviceId }),
                cause,
              }),
          ),
        );
    }),

    listForUser: Effect.fn("relay.environment_links.list_for_user")(function* (input) {
      return yield* db
        .select({
          environmentId: relayEnvironmentLinks.environmentId,
          environmentLabel: relayEnvironmentLinks.environmentLabel,
          endpointHttpBaseUrl: relayEnvironmentLinks.endpointHttpBaseUrl,
          endpointWsBaseUrl: relayEnvironmentLinks.endpointWsBaseUrl,
          endpointProviderKind: relayEnvironmentLinks.endpointProviderKind,
          createdAt: relayEnvironmentLinks.createdAt,
        })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              environmentId: row.environmentId as RelayClientEnvironmentRecord["environmentId"],
              label:
                row.environmentLabel.trim().length > 0 ? row.environmentLabel : row.environmentId,
              endpoint: {
                httpBaseUrl: row.endpointHttpBaseUrl,
                wsBaseUrl: row.endpointWsBaseUrl,
                providerKind: row.endpointProviderKind,
              },
              linkedAt: row.createdAt,
            })),
          ),
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkListPersistenceError({
                userId: input.userId,
                cause,
              }),
          ),
        );
    }),

    getForUser: Effect.fn("relay.environment_links.get_for_user")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
      });
      return yield* db
        .select({
          environmentId: relayEnvironmentLinks.environmentId,
          environmentLabel: relayEnvironmentLinks.environmentLabel,
          environmentPublicKey: relayEnvironmentLinks.environmentPublicKey,
          endpointHttpBaseUrl: relayEnvironmentLinks.endpointHttpBaseUrl,
          endpointWsBaseUrl: relayEnvironmentLinks.endpointWsBaseUrl,
          endpointProviderKind: relayEnvironmentLinks.endpointProviderKind,
          createdAt: relayEnvironmentLinks.createdAt,
        })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            eq(relayEnvironmentLinks.environmentId, input.environmentId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .limit(1)
        .pipe(
          Effect.map((rows) => {
            const row = rows[0];
            return row
              ? {
                  environmentId: row.environmentId as RelayClientEnvironmentRecord["environmentId"],
                  label:
                    row.environmentLabel.trim().length > 0
                      ? row.environmentLabel
                      : row.environmentId,
                  endpoint: {
                    httpBaseUrl: row.endpointHttpBaseUrl,
                    wsBaseUrl: row.endpointWsBaseUrl,
                    providerKind: row.endpointProviderKind,
                  },
                  environmentPublicKey: row.environmentPublicKey,
                  linkedAt: row.createdAt,
                }
              : null;
          }),
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkLookupPersistenceError({
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),

    revokeForUser: Effect.fn("relay.environment_links.revoke_for_user")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
      });
      const revokedAt = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .update(relayEnvironmentLinks)
        .set({
          revokedAt,
          updatedAt: revokedAt,
        })
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            eq(relayEnvironmentLinks.environmentId, input.environmentId),
            isNull(relayEnvironmentLinks.revokedAt),
          ),
        )
        .returning({ environmentId: relayEnvironmentLinks.environmentId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentLinkRevokePersistenceError({
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
      return rows.length > 0;
    }),
  });
});

export const layer = Layer.effect(EnvironmentLinks, make);
