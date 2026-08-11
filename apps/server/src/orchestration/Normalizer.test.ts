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
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";

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
});
