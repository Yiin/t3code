import {
  AuthSessionId,
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  EpicRunId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as AuthPairingLinks from "./AuthPairingLinks.ts";
import * as AuthSessions from "./AuthSessions.ts";
import * as PersistenceErrors from "./Errors.ts";
import { EpicRunStoreLive } from "./Layers/EpicRuns.ts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "./ProviderSessionRuntime.ts";
import { EpicRunStore } from "./Services/EpicRuns.ts";

const issuedAt = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const expiresAt = DateTime.makeUnsafe("2027-06-20T00:00:00.000Z");
const now = DateTime.makeUnsafe("2026-06-21T00:00:00.000Z");
const scopes: ReadonlyArray<AuthEnvironmentScope> = ["access:read"];

const authSessionLayer = AuthSessions.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const authPairingLinkLayer = AuthPairingLinks.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const providerSessionRuntimeLayer = ProviderSessionRuntime.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const epicRunStoreLayer = EpicRunStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

describe("persistence error correlation", () => {
  it.effect("correlates auth session SQL and row-decode failures without sensitive fields", () =>
    Effect.gen(function* () {
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const sql = yield* SqlClient.SqlClient;
      const sessionId = AuthSessionId.make("session-correlation");
      const currentSessionId = AuthSessionId.make("current-session-correlation");
      const subject = "session-subject-secret-sentinel";

      yield* sessions.create({
        sessionId,
        subject,
        scopes,
        method: "browser-session-cookie",
        client: {
          label: null,
          ipAddress: null,
          userAgent: null,
          deviceType: "desktop",
          os: null,
          browser: null,
        },
        issuedAt,
        expiresAt,
      });
      yield* sql`
        UPDATE auth_sessions
        SET scopes = ${"session-scopes-secret-sentinel"}
        WHERE session_id = ${sessionId}
      `;

      const decodeError = yield* Effect.flip(sessions.listActive({ now }));
      assert.instanceOf(decodeError, PersistenceErrors.PersistenceDecodeError);
      assert.deepStrictEqual(decodeError.correlation, { sessionId });
      assert.equal(
        decodeError.message,
        `Decode error in AuthSessionRepository.listActive:decodeRows: ${decodeError.issue}`,
      );
      assert.notInclude(decodeError.issue, subject);
      assert.notInclude(decodeError.issue, "session-scopes-secret-sentinel");
      assert.notInclude(decodeError.message, subject);

      yield* sql`DROP TABLE auth_sessions`;
      const createError = yield* Effect.flip(
        sessions.create({
          sessionId,
          subject,
          scopes,
          method: "browser-session-cookie",
          client: {
            label: null,
            ipAddress: null,
            userAgent: null,
            deviceType: "desktop",
            os: null,
            browser: null,
          },
          issuedAt,
          expiresAt,
        }),
      );
      assert.instanceOf(createError, PersistenceErrors.PersistenceSqlError);
      assert.deepStrictEqual(createError.correlation, { sessionId });
      assert.equal(createError.message, "SQL error in AuthSessionRepository.create:query");
      assert.notInclude(createError.message, subject);
      assert.notInclude(createError.message, DateTime.formatIso(issuedAt));

      const revokeOtherError = yield* Effect.flip(
        sessions.revokeAllExcept({ currentSessionId, revokedAt: now }),
      );
      assert.instanceOf(revokeOtherError, PersistenceErrors.PersistenceSqlError);
      assert.deepStrictEqual(revokeOtherError.correlation, { currentSessionId });
      assert.equal(
        revokeOtherError.message,
        "SQL error in AuthSessionRepository.revokeAllExcept:query",
      );
      assert.notInclude(revokeOtherError.message, DateTime.formatIso(now));
    }).pipe(Effect.provide(authSessionLayer)),
  );

  it.effect("correlates pairing-link create and revoke failures by id only", () =>
    Effect.gen(function* () {
      const pairingLinks = yield* AuthPairingLinks.AuthPairingLinkRepository;
      const sql = yield* SqlClient.SqlClient;
      const id = "pairing-link-correlation";
      const credential = "pairing-credential-secret-sentinel";
      const subject = "pairing-subject-secret-sentinel";
      const scopesPayload = "pairing-scopes-secret-sentinel";

      yield* sql`
        INSERT INTO auth_pairing_links (
          id,
          credential,
          method,
          scopes,
          subject,
          label,
          proof_key_thumbprint,
          created_at,
          expires_at,
          consumed_at,
          revoked_at
        )
        VALUES (
          ${id},
          ${credential},
          ${"one-time-token"},
          ${scopesPayload},
          ${subject},
          NULL,
          NULL,
          ${DateTime.formatIso(issuedAt)},
          ${DateTime.formatIso(expiresAt)},
          NULL,
          NULL
        )
      `;

      const decodeError = yield* Effect.flip(pairingLinks.getByCredential({ credential }));
      assert.instanceOf(decodeError, PersistenceErrors.PersistenceDecodeError);
      assert.deepStrictEqual(decodeError.correlation, { pairingLinkId: id });
      assert.equal(
        decodeError.message,
        `Decode error in AuthPairingLinkRepository.getByCredential:decodeRow: ${decodeError.issue}`,
      );
      assert.notInclude(decodeError.issue, credential);
      assert.notInclude(decodeError.issue, subject);
      assert.notInclude(decodeError.issue, scopesPayload);
      assert.notInclude(decodeError.message, DateTime.formatIso(issuedAt));

      yield* sql`DROP TABLE auth_pairing_links`;
      const createError = yield* Effect.flip(
        pairingLinks.create({
          id,
          credential,
          method: "one-time-token",
          scopes,
          subject,
          label: null,
          proofKeyThumbprint: null,
          createdAt: issuedAt,
          expiresAt,
        }),
      );
      assert.instanceOf(createError, PersistenceErrors.PersistenceSqlError);
      assert.deepStrictEqual(createError.correlation, { pairingLinkId: id });
      assert.notInclude(createError.message, credential);
      assert.notInclude(createError.message, subject);
      assert.notInclude(createError.message, DateTime.formatIso(issuedAt));

      const revokeError = yield* Effect.flip(pairingLinks.revoke({ id, revokedAt: now }));
      assert.instanceOf(revokeError, PersistenceErrors.PersistenceSqlError);
      assert.deepStrictEqual(revokeError.correlation, { pairingLinkId: id });
      assert.notInclude(revokeError.message, credential);
      assert.notInclude(revokeError.message, DateTime.formatIso(now));
    }).pipe(Effect.provide(authPairingLinkLayer)),
  );

  it.effect("skips undecodable provider runtime rows and correlates SQL failures by thread", () =>
    Effect.gen(function* () {
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-correlation");
      const runtimePayload = "runtime-payload-secret-sentinel";
      const lastSeenAt = "2026-06-20T00:00:00.000Z";

      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          ${threadId},
          ${"codex"},
          NULL,
          ${"codex"},
          ${"invalid-runtime-mode"},
          ${"running"},
          ${lastSeenAt},
          NULL,
          ${`{"secret":"${runtimePayload}"}`}
        )
      `;

      const validThreadId = ThreadId.make("thread-valid");
      yield* runtimes.upsert({
        threadId: validThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt,
        resumeCursor: null,
        runtimePayload: null,
      });

      const listed = yield* runtimes.list();
      assert.deepStrictEqual(
        listed.map((runtime) => runtime.threadId),
        [validThreadId],
      );

      yield* sql`DROP TABLE provider_session_runtime`;
      const sqlFailure = yield* Effect.flip(
        runtimes.upsert({
          threadId,
          providerName: "codex",
          providerInstanceId: null,
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt,
          resumeCursor: null,
          runtimePayload: { secret: runtimePayload },
        }),
      );
      assert.instanceOf(sqlFailure, PersistenceErrors.PersistenceSqlError);
      assert.deepStrictEqual(sqlFailure.correlation, { threadId });
      assert.equal(
        sqlFailure.message,
        "SQL error in ProviderSessionRuntimeRepository.upsert:query",
      );
      assert.notInclude(sqlFailure.message, runtimePayload);
      assert.notInclude(sqlFailure.message, lastSeenAt);
    }).pipe(Effect.provide(providerSessionRuntimeLayer)),
  );

  it.effect("correlates epic run row-decode and SQL failures by run id only", () =>
    Effect.gen(function* () {
      const runs = yield* EpicRunStore;
      const sql = yield* SqlClient.SqlClient;
      const runId = EpicRunId.make("run-correlation");
      const prompt = "epic-prompt-secret-sentinel";
      const cwd = "/tmp/epic-cwd-secret-sentinel";
      const createdAt = "2026-06-20T00:00:00.000Z";

      const run = {
        runId,
        epicId: "t3code-vst",
        projectId: ProjectId.make("project-correlation"),
        cwd,
        prompt,
        orientationFile: null,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        config: DEFAULT_EPIC_RUN_CONFIG,
        configProvenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
        originThreadId: null,
        status: "running",
        maxIterations: 5,
        workers: 1,
        iterationsDispatched: 0,
        iterationsCompleted: 0,
        currentThreadId: null,
        currentTurnStartedAt: null,
        consecutiveFailures: 0,
        noCommitStreak: 0,
        infraStreak: 0,
        lastError: null,
        createdAt,
        updatedAt: createdAt,
      } as const;

      yield* runs.upsertRun(run);
      yield* sql`
        UPDATE epic_runs
        SET model_selection_json = ${"epic-model-selection-secret-sentinel"}
        WHERE run_id = ${runId}
      `;

      const decodeError = yield* Effect.flip(runs.getRun({ runId }));
      assert.instanceOf(decodeError, PersistenceErrors.PersistenceDecodeError);
      assert.deepStrictEqual(decodeError.correlation, { runId });
      assert.equal(
        decodeError.message,
        `Decode error in EpicRunStore.getRun:decodeRow: ${decodeError.issue}`,
      );
      assert.notInclude(decodeError.issue, prompt);
      assert.notInclude(decodeError.issue, cwd);
      assert.notInclude(decodeError.issue, "epic-model-selection-secret-sentinel");
      assert.notInclude(decodeError.message, prompt);

      yield* sql`DROP TABLE epic_runs`;
      const upsertError = yield* Effect.flip(runs.upsertRun(run));
      assert.instanceOf(upsertError, PersistenceErrors.PersistenceSqlError);
      assert.deepStrictEqual(upsertError.correlation, { runId });
      assert.equal(upsertError.message, "SQL error in EpicRunStore.upsertRun:query");
      assert.notInclude(upsertError.message, prompt);
      assert.notInclude(upsertError.message, cwd);
      assert.notInclude(upsertError.message, createdAt);
    }).pipe(Effect.provide(epicRunStoreLayer)),
  );
});
