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

import {
  createAttachmentId,
  readUploadMeta,
  removeUpload,
  resolveAttachmentPath,
  resolveUploadPath,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

/**
 * True for an effect `PlatformError` whose `reason` is `NotFound`. Used to
 * tell "the staged upload is gone" apart from a real filesystem failure, so
 * the user is told to attach again rather than shown a persist error.
 */
function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("reason" in error)) {
    return false;
  }
  // `PlatformError.reason` is a `SystemError`/`BadArgument` object, not a
  // string: the normalized tag lives on `reason._tag`.
  // SAFETY: the guard above proved `error` is a non-null object with a
  // `reason` property; the assertion only names that property's type.
  return (error as { reason?: { _tag?: unknown } }).reason?._tag === "NotFound";
}

// A data URL header carries no parameters past the mime type, so anything
// outside the RFC 6838 token characters means the client sent junk. Exported
// so the `POST /api/attachments` upload route (http.ts) rejects the same
// malformed mime types before ever staging bytes to disk.
export const ATTACHMENT_MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

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
      return canonicalCommand satisfies OrchestrationCommand;
    }

    // Files land on disk before the message-sent event is decided. If a later
    // attachment fails validation, the ones already written would be orphaned,
    // so we track and remove them on any failure of this write pass.
    const writtenAttachmentPaths: Array<string> = [];
    // uploadId attachments copy a staged file (attachmentStore.ts) into
    // place, so the staging `.bin` and `.json` are removed only once the
    // whole batch has committed — see the cleanup pass below
    // `normalizedAttachments`. A mid-batch failure therefore leaves every
    // staged upload intact and the user's retry still works.
    const consumedUploadIds: Array<string> = [];

    // Shared by both attachment variants below: validates size, mints an id,
    // resolves the persisted path, and delegates the actual byte transfer to
    // `writeBytes` (a plain buffer write for the dataUrl variant, a copy
    // from the upload staging area for the uploadId variant).
    const finalizePersistedAttachment = (input: {
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
      readonly writeBytes: (
        attachmentPath: string,
      ) => Effect.Effect<void, OrchestrationDispatchCommandError>;
    }) =>
      Effect.gen(function* () {
        // The persisted type follows the resolved mime type, not the
        // client's claimed `type`, so every screenshot keeps decoding as an
        // image for older readers.
        const mimeType = input.mimeType.toLowerCase();
        const isImage = mimeType.startsWith("image/");
        const maxBytes = isImage
          ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
          : PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES;

        if (input.sizeBytes === 0) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Attachment '${input.name}' is empty.`,
          });
        }
        if (input.sizeBytes > maxBytes) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Attachment '${input.name}' is larger than ${maxBytes} bytes.`,
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
              name: input.name,
              mimeType,
              sizeBytes: input.sizeBytes,
            }
          : {
              type: "file",
              id: attachmentId,
              name: input.name,
              mimeType,
              sizeBytes: input.sizeBytes,
            };

        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment: persistedAttachment,
        });
        if (!attachmentPath) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Failed to resolve persisted path for '${input.name}'.`,
          });
        }

        yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
          Effect.mapError(
            () =>
              new OrchestrationDispatchCommandError({
                message: `Failed to create attachment directory for '${input.name}'.`,
              }),
          ),
        );
        yield* input.writeBytes(attachmentPath);
        writtenAttachmentPaths.push(attachmentPath);

        return persistedAttachment;
      });

    const normalizedAttachments = yield* Effect.forEach(
      canonicalCommand.message.attachments,
      (attachment) =>
        "dataUrl" in attachment
          ? Effect.gen(function* () {
              const parsed = parseBase64DataUrl(attachment.dataUrl);
              if (!parsed || !ATTACHMENT_MIME_TYPE_PATTERN.test(parsed.mimeType)) {
                return yield* new OrchestrationDispatchCommandError({
                  message: `Attachment '${attachment.name}' is not a readable data URL.`,
                });
              }
              const bytes = Buffer.from(parsed.base64, "base64");
              return yield* finalizePersistedAttachment({
                name: attachment.name,
                mimeType: parsed.mimeType,
                sizeBytes: bytes.byteLength,
                writeBytes: (attachmentPath) =>
                  fileSystem.writeFile(attachmentPath, bytes).pipe(
                    Effect.mapError(
                      () =>
                        new OrchestrationDispatchCommandError({
                          message: `Failed to persist attachment '${attachment.name}'.`,
                        }),
                    ),
                  ),
              });
            })
          : Effect.gen(function* () {
              const uploadedMeta = readUploadMeta({
                attachmentsDir: serverConfig.attachmentsDir,
                uploadId: attachment.uploadId,
              });
              // Defence in depth: the contract's `UploadId` already enforces
              // the id pattern, so this only fails if that guarantee is lost.
              const binPath = resolveUploadPath({
                attachmentsDir: serverConfig.attachmentsDir,
                uploadId: attachment.uploadId,
                extension: "bin",
              });
              if (
                !uploadedMeta ||
                !binPath ||
                !ATTACHMENT_MIME_TYPE_PATTERN.test(uploadedMeta.mimeType)
              ) {
                return yield* new OrchestrationDispatchCommandError({
                  message: `Attachment '${attachment.name}' upload expired, attach it again.`,
                });
              }

              const persisted = yield* finalizePersistedAttachment({
                name: attachment.name,
                mimeType: uploadedMeta.mimeType,
                sizeBytes: uploadedMeta.sizeBytes,
                // Copy, not rename: the staged `.bin` has to survive until
                // the whole batch commits. If a sibling attachment fails, the
                // rollback below deletes this persisted copy and the user's
                // retry re-reads the same staged upload. The `.bin` is
                // deleted by the post-commit `removeUpload` pass.
                writeBytes: (attachmentPath) =>
                  fileSystem.copyFile(binPath, attachmentPath).pipe(
                    Effect.mapError((error) =>
                      isNotFoundError(error)
                        ? new OrchestrationDispatchCommandError({
                            message: `Attachment '${attachment.name}' upload expired, attach it again.`,
                          })
                        : new OrchestrationDispatchCommandError({
                            message: `Failed to persist attachment '${attachment.name}'.`,
                          }),
                    ),
                  ),
              });
              consumedUploadIds.push(attachment.uploadId);
              return persisted;
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

    // Every attachment in this turn committed, so the staged uploads it
    // consumed are done and both their files can go. Runs after the rollback
    // guard, so a mid-batch failure skips this and leaves the staging area
    // untouched for the retry; the hourly sweep clears it if the user gives
    // up instead.
    yield* Effect.forEach(
      consumedUploadIds,
      (uploadId) =>
        Effect.sync(() =>
          removeUpload({ attachmentsDir: serverConfig.attachmentsDir, uploadId }),
        ).pipe(Effect.ignore),
      { concurrency: 1 },
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
