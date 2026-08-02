import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("preserves existing attachments when upsert omits attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-preserve-attachments");
      const messageId = MessageId.make("message-preserve-attachments");
      const createdAt = "2026-02-28T19:00:00.000Z";
      const updatedAt = "2026-02-28T19:00:01.000Z";
      const persistedAttachments = [
        {
          type: "image" as const,
          id: "thread-preserve-attachments-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "initial",
        attachments: persistedAttachments,
        isStreaming: false,
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "updated");
      assert.deepEqual(rows[0]?.attachments, persistedAttachments);

      const rowById = yield* repository.getByMessageId({ messageId });
      assert.equal(rowById._tag, "Some");
      if (rowById._tag === "Some") {
        assert.equal(rowById.value.text, "updated");
        assert.deepEqual(rowById.value.attachments, persistedAttachments);
      }
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-clear-attachments");
      const messageId = MessageId.make("message-clear-attachments");
      const createdAt = "2026-02-28T19:10:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "with attachment",
        attachments: [
          {
            type: "image",
            id: "thread-clear-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "cleared",
        attachments: [],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "cleared");
      assert.deepEqual(rows[0]?.attachments, []);
    }),
  );

  it.effect("latestUserMessageAtByThreadId picks the max user message createdAt", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-latest-user-message");

      yield* repository.upsert({
        messageId: MessageId.make("message-latest-user-1"),
        threadId,
        turnId: null,
        role: "user",
        text: "earlier user message",
        isStreaming: false,
        createdAt: "2026-03-01T10:00:00.000Z",
        updatedAt: "2026-03-01T10:00:00.000Z",
      });

      yield* repository.upsert({
        messageId: MessageId.make("message-latest-user-2"),
        threadId,
        turnId: null,
        role: "assistant",
        text: "later assistant message",
        isStreaming: false,
        createdAt: "2026-03-01T10:05:00.000Z",
        updatedAt: "2026-03-01T10:05:00.000Z",
      });

      yield* repository.upsert({
        messageId: MessageId.make("message-latest-user-3"),
        threadId,
        turnId: null,
        role: "user",
        text: "later user message",
        isStreaming: false,
        createdAt: "2026-03-01T10:02:00.000Z",
        updatedAt: "2026-03-01T10:02:00.000Z",
      });

      const latestUserMessageAt = yield* repository.latestUserMessageAtByThreadId({ threadId });
      assert.equal(latestUserMessageAt, "2026-03-01T10:02:00.000Z");
    }),
  );

  it.effect("latestUserMessageAtByThreadId returns null when the thread has no user messages", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-latest-user-message-assistant-only");

      yield* repository.upsert({
        messageId: MessageId.make("message-assistant-only-1"),
        threadId,
        turnId: null,
        role: "assistant",
        text: "assistant only",
        isStreaming: false,
        createdAt: "2026-03-01T11:00:00.000Z",
        updatedAt: "2026-03-01T11:00:00.000Z",
      });

      const latestUserMessageAt = yield* repository.latestUserMessageAtByThreadId({ threadId });
      assert.equal(latestUserMessageAt, null);
    }),
  );

  it.effect("latestUserMessageAtByThreadId returns null for an unknown thread", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-latest-user-message-unknown");

      const latestUserMessageAt = yield* repository.latestUserMessageAtByThreadId({ threadId });
      assert.equal(latestUserMessageAt, null);
    }),
  );
});
