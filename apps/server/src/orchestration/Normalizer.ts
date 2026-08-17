import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  type ChatAttachment,
  type ClientOrchestrationCommand,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

// A data URL header carries no parameters past the mime type, so anything
// outside the RFC 6838 token characters means the client sent junk.
const ATTACHMENT_MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand => {
  const canonicalCommand =
    "createdAt" in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command;

  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap?.createThread) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  };
};

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    if (canonicalCommand.type === "project.create") {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          canonicalCommand.workspaceRoot,
          canonicalCommand.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      canonicalCommand.workspaceRoot !== undefined
    ) {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(canonicalCommand.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (canonicalCommand.type !== "thread.turn.start") {
      return canonicalCommand as OrchestrationCommand;
    }

    // Files land on disk before the message-sent event is decided. If a later
    // attachment fails validation, the ones already written would be orphaned,
    // so we track and remove them on any failure of this write pass.
    const writtenAttachmentPaths: Array<string> = [];

    const normalizedAttachments = yield* Effect.forEach(
      canonicalCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !ATTACHMENT_MIME_TYPE_PATTERN.test(parsed.mimeType)) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Attachment '${attachment.name}' is not a readable data URL.`,
            });
          }

          // The persisted type follows the data URL, not the client's claim,
          // so every screenshot keeps decoding as an image for older readers.
          const mimeType = parsed.mimeType.toLowerCase();
          const isImage = mimeType.startsWith("image/");
          const maxBytes = isImage
            ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
            : PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES;

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Attachment '${attachment.name}' is empty.`,
            });
          }
          if (bytes.byteLength > maxBytes) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Attachment '${attachment.name}' is larger than ${maxBytes} bytes.`,
            });
          }

          const attachmentId = createAttachmentId(canonicalCommand.threadId);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment: ChatAttachment = isImage
            ? {
                type: "image",
                id: attachmentId,
                name: attachment.name,
                mimeType,
                sizeBytes: bytes.byteLength,
              }
            : {
                type: "file",
                id: attachmentId,
                name: attachment.name,
                mimeType,
                sizeBytes: bytes.byteLength,
              };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );
          writtenAttachmentPaths.push(attachmentPath);

          return persistedAttachment;
        }),
      { concurrency: 1 },
    ).pipe(
      Effect.onError(() =>
        Effect.forEach(
          writtenAttachmentPaths,
          (attachmentPath) =>
            fileSystem.remove(attachmentPath, { force: true }).pipe(Effect.ignore),
          { concurrency: 1 },
        ),
      ),
    );

    return {
      ...canonicalCommand,
      message: {
        ...canonicalCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });

// Normalization writes attachment files before the message-sent event is
// decided. If the dispatch that follows fails, no event ever references those
// files, so nothing prunes them. Call this on the dispatch error path to remove
// the files a turn.start wrote. Safe to call for any command: it acts only on
// turn.start attachments, and it swallows removal errors so it never masks the
// original failure.
export const removeNormalizedCommandAttachments = (command: OrchestrationCommand) =>
  Effect.gen(function* () {
    if (command.type !== "thread.turn.start") {
      return;
    }
    const attachments = command.message.attachments;
    if (attachments.length === 0) {
      return;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    yield* Effect.forEach(
      attachments,
      (attachment) =>
        Effect.gen(function* () {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return;
          }
          yield* fileSystem.remove(attachmentPath, { force: true }).pipe(Effect.ignore);
        }),
      { concurrency: 1 },
    );
  });
