import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import {
  createUploadId,
  readUploadMeta,
  resolveAttachmentPath,
  resolveUploadPath,
  writeUploadMeta,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  canonicalizeClientCommandTimestamps,
  normalizeDispatchCommand,
  removeNormalizedCommandAttachments,
} from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

type ClientTurnStartCommand = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
type UploadAttachment = ClientTurnStartCommand["message"]["attachments"][number];

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-normalizer-attachments-test-",
});
const testLayer = Layer.mergeAll(configLayer, WorkspacePaths.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const turnStartWith = (
  commandId: string,
  attachment: UploadAttachment,
): ClientTurnStartCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make(commandId),
  threadId: ThreadId.make("thread-attachments"),
  message: {
    messageId: MessageId.make(`message-${commandId}`),
    role: "user",
    text: "Take this",
    attachments: [attachment],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: clientCreatedAt,
});

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

const normalizedAttachments = (command: ClientTurnStartCommand) =>
  Effect.gen(function* () {
    const normalized = yield* normalizeDispatchCommand(command);
    if (normalized.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    return normalized.message.attachments;
  });

describe("normalizeDispatchCommand attachments", () => {
  it.effect("persists a text attachment as a file and writes its bytes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const text = "hello from a log file";

      const attachments = yield* normalizedAttachments(
        turnStartWith("cmd-file", {
          type: "file",
          name: "run.log",
          mimeType: "text/plain",
          sizeBytes: Buffer.byteLength(text, "utf8"),
          dataUrl: `data:text/plain;base64,${base64(text)}`,
        }),
      );

      expect(attachments).toHaveLength(1);
      const attachment = attachments[0];
      if (!attachment) {
        throw new Error("Expected one normalized attachment");
      }
      expect(attachment.type).toBe("file");
      expect(attachment.mimeType).toBe("text/plain");
      expect(attachment.name).toBe("run.log");
      expect(attachment.sizeBytes).toBe(Buffer.byteLength(text, "utf8"));

      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        throw new Error("Expected a resolved attachment path");
      }
      expect(attachmentPath.endsWith(`${attachment.id}.log`)).toBe(true);
      expect(yield* fileSystem.readFileString(attachmentPath)).toBe(text);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps an image data URL persisting as an image", () =>
    Effect.gen(function* () {
      const attachments = yield* normalizedAttachments(
        turnStartWith("cmd-image", {
          type: "image",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 4,
          dataUrl: `data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString("base64")}`,
        }),
      );

      expect(attachments[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("derives the persisted type from the data URL, not the client claim", () =>
    Effect.gen(function* () {
      const attachments = yield* normalizedAttachments(
        turnStartWith("cmd-mismatch", {
          type: "image",
          name: "notes.txt",
          mimeType: "image/png",
          sizeBytes: 5,
          dataUrl: `data:text/plain;base64,${base64("notes")}`,
        }),
      );

      expect(attachments[0]).toMatchObject({ type: "file", mimeType: "text/plain" });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects an oversized file attachment and names the file", () =>
    Effect.gen(function* () {
      // Base64 carries three bytes per four characters, so this payload clears
      // the cap without allocating the decoded buffer first.
      const payloadLength = (Math.floor(PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES / 3) + 1) * 4;
      const error = yield* normalizedAttachments(
        turnStartWith("cmd-oversized", {
          type: "file",
          name: "huge.log",
          mimeType: "text/plain",
          sizeBytes: PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES,
          dataUrl: `data:text/plain;base64,${"A".repeat(payloadLength)}`,
        }),
      ).pipe(Effect.flip);

      expect(error.message).toBe(
        `Attachment 'huge.log' is larger than ${PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES} bytes.`,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a malformed data URL", () =>
    Effect.gen(function* () {
      const error = yield* normalizedAttachments(
        turnStartWith("cmd-malformed", {
          type: "file",
          name: "broken.pdf",
          mimeType: "application/pdf",
          sizeBytes: 3,
          dataUrl: "not-a-data-url",
        }),
      ).pipe(Effect.flip);

      expect(error.message).toBe("Attachment 'broken.pdf' is not a readable data URL.");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes an already-written file when a later attachment fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const good = base64("first file survives only if the turn does");

      const command: ClientTurnStartCommand = {
        ...turnStartWith("cmd-partial", {
          type: "file",
          name: "good.log",
          mimeType: "text/plain",
          sizeBytes: 42,
          dataUrl: `data:text/plain;base64,${good}`,
        }),
        message: {
          messageId: MessageId.make("message-cmd-partial"),
          role: "user",
          text: "Take these",
          attachments: [
            {
              type: "file",
              name: "good.log",
              mimeType: "text/plain",
              sizeBytes: 42,
              dataUrl: `data:text/plain;base64,${good}`,
            },
            {
              type: "file",
              name: "broken.pdf",
              mimeType: "application/pdf",
              sizeBytes: 3,
              dataUrl: "not-a-data-url",
            },
          ],
        },
      };

      yield* normalizeDispatchCommand(command).pipe(Effect.flip);

      const entries = yield* fileSystem
        .readDirectory(config.attachmentsDir)
        .pipe(Effect.orElseSucceed((): Array<string> => []));
      expect(entries).toHaveLength(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removeNormalizedCommandAttachments deletes the files a turn wrote", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;

      const normalized = yield* normalizeDispatchCommand(
        turnStartWith("cmd-cleanup", {
          type: "file",
          name: "run.log",
          mimeType: "text/plain",
          sizeBytes: 5,
          dataUrl: `data:text/plain;base64,${base64("bytes")}`,
        }),
      );
      if (normalized.type !== "thread.turn.start") {
        throw new Error("Expected a thread.turn.start command");
      }
      const attachment = normalized.message.attachments[0];
      if (!attachment) {
        throw new Error("Expected one normalized attachment");
      }
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        throw new Error("Expected a resolved attachment path");
      }
      expect(yield* fileSystem.exists(attachmentPath)).toBe(true);

      yield* removeNormalizedCommandAttachments(normalized);

      expect(yield* fileSystem.exists(attachmentPath)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  const stageUpload = (input: {
    readonly name: string;
    readonly mimeType: string;
    readonly text: string;
    /** Lets a test claim a size the staged bytes do not have. */
    readonly sizeBytesOverride?: number;
  }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const uploadId = createUploadId();
      const binPath = resolveUploadPath({
        attachmentsDir: config.attachmentsDir,
        uploadId,
        extension: "bin",
      });
      if (!binPath) {
        throw new Error("Expected a resolved upload bin path");
      }
      const bytes = Buffer.from(input.text, "utf8");
      yield* fileSystem.makeDirectory(binPath.slice(0, binPath.lastIndexOf("/")), {
        recursive: true,
      });
      yield* fileSystem.writeFile(binPath, bytes);
      writeUploadMeta({
        attachmentsDir: config.attachmentsDir,
        uploadId,
        meta: {
          name: input.name,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytesOverride ?? bytes.byteLength,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });
      return { uploadId, binPath };
    });

  it.effect("persists an uploadId attachment by copying the staged file into place", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const { uploadId, binPath } = yield* stageUpload({
        name: "notes.txt",
        mimeType: "text/plain",
        text: "staged via http upload",
      });

      const attachments = yield* normalizedAttachments(
        turnStartWith("cmd-upload", {
          type: "file",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: Buffer.byteLength("staged via http upload", "utf8"),
          uploadId,
        }),
      );

      expect(attachments).toHaveLength(1);
      const attachment = attachments[0];
      if (!attachment) {
        throw new Error("Expected one normalized attachment");
      }
      expect(attachment.type).toBe("file");
      expect(attachment.mimeType).toBe("text/plain");

      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        throw new Error("Expected a resolved attachment path");
      }
      expect(yield* fileSystem.readFileString(attachmentPath)).toBe("staged via http upload");
      // A committed turn clears both staged files.
      expect(yield* fileSystem.exists(binPath)).toBe(false);
      expect(readUploadMeta({ attachmentsDir: config.attachmentsDir, uploadId })).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports an expired uploadId with a clear, retryable error", () =>
    Effect.gen(function* () {
      const error = yield* normalizedAttachments(
        turnStartWith("cmd-upload-expired", {
          type: "file",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          uploadId: "does-not-exist",
        }),
      ).pipe(Effect.flip);

      expect(error.message).toBe("Attachment 'notes.txt' upload expired, attach it again.");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports a staged upload whose bytes vanished as expired", () =>
    Effect.gen(function* () {
      // The sweep (or a concurrent removeUpload) can delete the `.bin` after
      // the `.json` was read. The user must be told to attach again, not
      // shown a persist failure: the web reset path keys on /upload expired/.
      const fileSystem = yield* FileSystem.FileSystem;
      const { uploadId, binPath } = yield* stageUpload({
        name: "notes.txt",
        mimeType: "text/plain",
        text: "these bytes go away",
      });
      yield* fileSystem.remove(binPath, { force: true });

      const error = yield* normalizedAttachments(
        turnStartWith("cmd-upload-bin-missing", {
          type: "file",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: Buffer.byteLength("these bytes go away", "utf8"),
          uploadId,
        }),
      ).pipe(Effect.flip);

      expect(error.message).toBe("Attachment 'notes.txt' upload expired, attach it again.");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps a consumed upload replayable when a later attachment fails", () =>
    Effect.gen(function* () {
      // The uploadId branch copies rather than moves, so attachment 1's
      // staged files outlive the failure of attachment 2. The rollback
      // deletes only the persisted copy, and the user's retry re-reads the
      // same uploadId instead of having to attach the file again.
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const { uploadId } = yield* stageUpload({
        name: "good.log",
        mimeType: "text/plain",
        text: "first attachment survives only if the turn does",
      });

      const command: ClientTurnStartCommand = {
        ...turnStartWith("cmd-upload-partial", {
          type: "file",
          name: "good.log",
          mimeType: "text/plain",
          sizeBytes: 42,
          uploadId,
        }),
        message: {
          messageId: MessageId.make("message-cmd-upload-partial"),
          role: "user",
          text: "Take these",
          attachments: [
            {
              type: "file",
              name: "good.log",
              mimeType: "text/plain",
              sizeBytes: Buffer.byteLength(
                "first attachment survives only if the turn does",
                "utf8",
              ),
              uploadId,
            },
            {
              type: "file",
              name: "broken.pdf",
              mimeType: "application/pdf",
              sizeBytes: 3,
              dataUrl: "not-a-data-url",
            },
          ],
        },
      };

      yield* normalizeDispatchCommand(command).pipe(Effect.flip);

      // Only the `uploads/` staging directory is left; no persisted
      // attachment file survives the rollback.
      const persistedEntries = yield* fileSystem
        .readDirectory(config.attachmentsDir)
        .pipe(Effect.orElseSucceed((): Array<string> => []));
      expect(persistedEntries).toEqual(["uploads"]);
      // Both staged files survive, so the same uploadId still resolves.
      expect(readUploadMeta({ attachmentsDir: config.attachmentsDir, uploadId })).not.toBeNull();
      const binPath = resolveUploadPath({
        attachmentsDir: config.attachmentsDir,
        uploadId,
        extension: "bin",
      });
      if (!binPath) {
        throw new Error("Expected a resolved upload bin path");
      }
      expect(yield* fileSystem.exists(binPath)).toBe(true);

      // The retry sends the surviving uploadId alone and now succeeds.
      const retried = yield* normalizedAttachments(
        turnStartWith("cmd-upload-partial-retry", {
          type: "file",
          name: "good.log",
          mimeType: "text/plain",
          sizeBytes: Buffer.byteLength("first attachment survives only if the turn does", "utf8"),
          uploadId,
        }),
      );
      expect(retried).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  // Parity guard: the persisted `type` follows the staged mime type, not the
  // `type` the client put on the wire, exactly as the dataUrl branch does.
  it.effect("persists an image uploadId as type image", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const { uploadId } = yield* stageUpload({
        name: "shot.png",
        mimeType: "image/png",
        text: "not really a png, but the mime decides the type",
      });

      const attachments = yield* normalizedAttachments(
        turnStartWith("cmd-upload-image", {
          // The client claims "file"; the staged mime says otherwise.
          type: "file",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 10,
          uploadId,
        }),
      );

      const attachment = attachments[0];
      if (!attachment) {
        throw new Error("Expected one normalized attachment");
      }
      expect(attachment.type).toBe("image");
      expect(attachment.mimeType).toBe("image/png");
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        throw new Error("Expected a resolved attachment path");
      }
      expect(yield* fileSystem.exists(attachmentPath)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects an oversize staged upload by its recorded size", () =>
    Effect.gen(function* () {
      const { uploadId } = yield* stageUpload({
        name: "huge.png",
        mimeType: "image/png",
        text: "x",
        sizeBytesOverride: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
      });

      const error = yield* normalizedAttachments(
        turnStartWith("cmd-upload-oversize", {
          type: "image",
          name: "huge.png",
          mimeType: "image/png",
          sizeBytes: 1,
          uploadId,
        }),
      ).pipe(Effect.flip);

      expect(error.message).toBe(
        `Attachment 'huge.png' is larger than ${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES} bytes.`,
      );
    }).pipe(Effect.provide(testLayer)),
  );
});
