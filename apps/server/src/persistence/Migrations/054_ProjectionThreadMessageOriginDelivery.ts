/**
 * Message origin and queued-delivery state on projected thread messages.
 *
 * `origin` records who wrote a message: `human` for a person at a composer,
 * `agent` for a parent thread writing into a thread-backed subagent's chat.
 * `delivery_state` records whether the message is still waiting for the target
 * thread's next turn boundary.
 *
 * Both are nullable and every existing row is correctly NULL: a null origin
 * reads as `human`, and a null delivery state means nothing is pending. No
 * backfill.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN origin TEXT`;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN delivery_state TEXT`;
});
