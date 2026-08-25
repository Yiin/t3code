import type { AttachmentUploadResponse, EnvironmentId } from "@t3tools/contracts";
import {
  type AttachmentUploadError,
  uploadAttachment as uploadAttachmentEffect,
} from "@t3tools/client-runtime/attachments";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { readPreparedConnection } from "~/state/session";
import { runtime } from "./runtime";

export type UploadComposerAttachmentResult = Result.Result<
  AttachmentUploadResponse,
  AttachmentUploadError | "not-connected"
>;

/**
 * Streams a composer attachment to `POST /api/attachments` (see
 * `packages/client-runtime/src/attachments/upload.ts`). Resolves the DPoP
 * signer from `runtime` (`apps/web/src/lib/runtime.ts`), the same
 * `ManagedRuntime` the relay client itself uses, so a relay-connected
 * environment authorizes the upload exactly like every other environment
 * request; primary/bearer connections need no signer.
 */
export function uploadComposerAttachment(input: {
  readonly environmentId: EnvironmentId;
  readonly file: Blob;
  readonly fileName: string;
  readonly mimeType: string;
  readonly onProgress?: (progress: { readonly loaded: number; readonly total: number }) => void;
  readonly signal?: AbortSignal;
}): Promise<UploadComposerAttachmentResult> {
  const prepared = readPreparedConnection(input.environmentId);
  if (!prepared) {
    return Promise.resolve(Result.fail("not-connected"));
  }
  return runtime.runPromise(
    Effect.gen(function* () {
      const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
      return yield* uploadAttachmentEffect({
        prepared,
        signer,
        file: input.file,
        fileName: input.fileName,
        mimeType: input.mimeType,
        onProgress: input.onProgress,
        signal: input.signal,
      });
    }).pipe(Effect.result),
  );
}

/** One line of copy for whatever stopped an upload; never technical jargon. */
export function attachmentUploadErrorMessage(
  error: AttachmentUploadError | "not-connected",
): string {
  if (error === "not-connected") {
    return "Not connected to the server.";
  }
  switch (error._tag) {
    case "AttachmentUploadAuthError":
      return "Not authorized to upload this file.";
    case "AttachmentUploadTooLargeError":
      return "This file is too large to upload.";
    case "AttachmentUploadAbortedError":
      return "Upload canceled.";
    case "AttachmentUploadNetworkError":
    case "AttachmentUploadRejectedError":
      return "Upload failed. Try again.";
  }
}

/** Handle for an upload in flight; `abort` cancels it and settles `onFailed`. */
export interface ComposerAttachmentUploadHandle {
  readonly abort: () => void;
}

/**
 * Starts a composer attachment upload and drives one of `onProgress`,
 * `onDone`, or `onFailed` as it goes. Returns an `abort` handle so a caller
 * can cancel it (e.g. the attachment chip's Remove button, or the composer
 * clearing on send).
 */
export function startComposerAttachmentUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly file: File;
  readonly onProgress: (loaded: number, total: number) => void;
  readonly onDone: (uploadId: string) => void;
  readonly onFailed: (message: string) => void;
}): ComposerAttachmentUploadHandle {
  const controller = new AbortController();
  void uploadComposerAttachment({
    environmentId: input.environmentId,
    file: input.file,
    fileName: input.file.name,
    mimeType: input.file.type || "application/octet-stream",
    onProgress: ({ loaded, total }) => input.onProgress(loaded, total),
    signal: controller.signal,
  })
    .then((result) => {
      if (Result.isSuccess(result)) {
        input.onDone(result.success.uploadId);
        return;
      }
      input.onFailed(attachmentUploadErrorMessage(result.failure));
    })
    // A defect (not a typed failure) rejects the promise. Without this the
    // chip would sit at "uploading" forever and keep the send button locked.
    .catch(() => input.onFailed("Upload failed. Try again."));
  return { abort: () => controller.abort() };
}
