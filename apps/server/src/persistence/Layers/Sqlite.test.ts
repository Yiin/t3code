import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SQLITE_BUSY_TIMEOUT_MS, SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(SqlitePersistenceMemory);

layer("SqlitePersistence", (it) => {
  // t3code-8h3: without a busy timeout, SQLite returns SQLITE_BUSY ("database
  // is locked") the instant a second connection wants the write lock. Every
  // `t3` CLI invocation opens its own connection to the same file as the
  // running server, so a busy server turned any CLI write into a hard failure.
  it.effect("configures a busy timeout so a contended write waits instead of failing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const rows = yield* sql.unsafe<{ readonly timeout: number }>("PRAGMA busy_timeout");

      assert.strictEqual(rows[0]?.timeout, SQLITE_BUSY_TIMEOUT_MS);
      assert.isAbove(SQLITE_BUSY_TIMEOUT_MS, 0);
    }),
  );
});
