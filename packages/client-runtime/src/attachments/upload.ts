import type { AttachmentUploadResponse } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { buildEnvironmentAuthHeaders } from "../state/environmentHttpAuth.ts";

/**
 * Streams one attachment to `POST /api/attachments` ahead of the turn that
 * references it, so a multi-hundred-MB file never rides the WebSocket
 * send-turn frame as a base64 data URL (see the server's http.ts route and
 * attachmentStore.ts staging area). Uses `XMLHttpRequest` rather than
 * `fetch` because only `XMLHttpRequest` exposes upload progress events.
 */

export class AttachmentUploadAuthError extends Data.TaggedError("AttachmentUploadAuthError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class AttachmentUploadTooLargeError extends Data.TaggedError(
  "AttachmentUploadTooLargeError",
)<{
  readonly message: string;
}> {}

export class AttachmentUploadRejectedError extends Data.TaggedError(
  "AttachmentUploadRejectedError",
)<{
  readonly status: number;
  readonly message: string;
}> {}

export class AttachmentUploadNetworkError extends Data.TaggedError("AttachmentUploadNetworkError")<{
  readonly message: string;
}> {}

export class AttachmentUploadAbortedError extends Data.TaggedError(
  "AttachmentUploadAbortedError",
)<{}> {}

export type AttachmentUploadError =
  | AttachmentUploadAuthError
  | AttachmentUploadTooLargeError
  | AttachmentUploadRejectedError
  | AttachmentUploadNetworkError
  | AttachmentUploadAbortedError;

export interface AttachmentUploadProgress {
  readonly loaded: number;
  readonly total: number;
}

export const uploadAttachment = (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly file: Blob;
  readonly fileName: string;
  readonly mimeType: string;
  readonly onProgress?: ((progress: AttachmentUploadProgress) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}): Effect.Effect<AttachmentUploadResponse, AttachmentUploadError> =>
  Effect.gen(function* () {
    const url = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/attachments");
    const headers = yield* buildEnvironmentAuthHeaders(
      input.prepared.httpAuthorization,
      "POST",
      url,
      input.signer,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new AttachmentUploadAuthError({
            message: "Could not authorize the attachment upload.",
            cause,
          }),
      ),
    );

    return yield* Effect.callback<AttachmentUploadResponse, AttachmentUploadError>((resume) => {
      const xhr = new XMLHttpRequest();
      let externalAbortListener: (() => void) | null = null;
      const detachExternalAbort = () => {
        if (externalAbortListener && input.signal) {
          input.signal.removeEventListener("abort", externalAbortListener);
          externalAbortListener = null;
        }
      };
      try {
        xhr.open("POST", url, true);
        // Credential rules mirror `withEnvironmentCredentials`: primary/local
        // connections (no bearer/DPoP header) authenticate via the session
        // cookie, which a cross-origin XHR only sends when opted in.
        xhr.withCredentials = input.prepared.httpAuthorization === null;
        if (headers.authorization) {
          xhr.setRequestHeader("Authorization", headers.authorization);
        }
        if (headers.dpop) {
          xhr.setRequestHeader("DPoP", headers.dpop);
        }
        // A request header is a ByteString, so `setRequestHeader` throws a
        // TypeError on any code point above 0xFF (`ataskaita_ž.pdf`). The
        // server decodes this with `decodeURIComponent`.
        xhr.setRequestHeader("X-Attachment-Name", encodeURIComponent(input.fileName));
        xhr.setRequestHeader("Content-Type", input.mimeType);

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            input.onProgress?.({ loaded: event.loaded, total: event.total });
          }
        };

        xhr.onloadend = () => {
          detachExternalAbort();
        };

        xhr.onload = () => {
          if (xhr.status === 201) {
            try {
              resume(Effect.succeed(JSON.parse(xhr.responseText) as AttachmentUploadResponse));
            } catch {
              resume(
                Effect.fail(
                  new AttachmentUploadRejectedError({
                    status: xhr.status,
                    message: "The server returned a malformed upload response.",
                  }),
                ),
              );
            }
            return;
          }
          if (xhr.status === 401) {
            resume(
              Effect.fail(
                new AttachmentUploadAuthError({
                  message: "Not authorized to upload attachments.",
                }),
              ),
            );
            return;
          }
          if (xhr.status === 413) {
            resume(
              Effect.fail(
                new AttachmentUploadTooLargeError({
                  message: "This attachment is too large to upload.",
                }),
              ),
            );
            return;
          }
          resume(
            Effect.fail(
              new AttachmentUploadRejectedError({
                status: xhr.status,
                message: xhr.responseText || `The upload failed with status ${xhr.status}.`,
              }),
            ),
          );
        };
        xhr.onerror = () => {
          resume(
            Effect.fail(
              new AttachmentUploadNetworkError({ message: "The attachment upload failed." }),
            ),
          );
        };
        xhr.onabort = () => {
          resume(Effect.fail(new AttachmentUploadAbortedError()));
        };

        if (input.signal) {
          if (input.signal.aborted) {
            xhr.abort();
          } else {
            externalAbortListener = () => xhr.abort();
            input.signal.addEventListener("abort", externalAbortListener, { once: true });
          }
        }

        xhr.send(input.file);
      } catch (cause) {
        // `open`, `setRequestHeader` and `send` all throw synchronously on
        // bad input. Without this the throw escapes as a defect, the caller's
        // `runPromise` rejects, and the chip is stuck at "uploading" forever.
        detachExternalAbort();
        resume(
          Effect.fail(
            new AttachmentUploadRejectedError({
              status: 0,
              message: cause instanceof Error ? cause.message : "The attachment upload failed.",
            }),
          ),
        );
      }

      // Interrupting the fiber (e.g. the composer unmounts) aborts the XHR
      // the same way an external `signal` does.
      return Effect.sync(() => {
        detachExternalAbort();
        xhr.abort();
      });
    });
  });
