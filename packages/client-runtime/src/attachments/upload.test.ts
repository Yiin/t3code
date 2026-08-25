import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { beforeEach, describe } from "vite-plus/test";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import {
  AttachmentUploadAbortedError,
  AttachmentUploadAuthError,
  AttachmentUploadNetworkError,
  AttachmentUploadRejectedError,
  AttachmentUploadTooLargeError,
  uploadAttachment,
} from "./upload.ts";

type ProgressListener = (event: {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;
}) => void;

class FakeXhr {
  static instances: Array<FakeXhr> = [];

  method = "";
  url = "";
  withCredentials = false;
  status = 0;
  responseText = "";
  requestHeaders: Record<string, string> = {};
  sentBody: unknown;
  aborted = false;
  upload: { onprogress: ProgressListener | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name.toLowerCase()] = value;
  }

  send(body: unknown): void {
    this.sentBody = body;
    FakeXhr.instances.push(this);
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  respond(status: number, responseText: string): void {
    this.status = status;
    this.responseText = responseText;
    this.onload?.();
  }

  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }

  networkError(): void {
    this.onerror?.();
  }
}

const preparedConnection: PreparedConnection = {
  environmentId: EnvironmentId.make("env-1"),
  label: "Test environment",
  httpBaseUrl: "http://127.0.0.1:3773",
  socketUrl: "ws://127.0.0.1:3773",
  httpAuthorization: null,
  target: PrimaryConnectionTarget.make({
    environmentId: EnvironmentId.make("env-1"),
    label: "Test environment",
    httpBaseUrl: "http://127.0.0.1:3773",
    wsBaseUrl: "ws://127.0.0.1:3773",
  }),
};

const runUpload = (input?: {
  readonly onProgress?: (progress: { readonly loaded: number; readonly total: number }) => void;
  readonly signal?: AbortSignal;
  readonly prepared?: PreparedConnection;
  readonly fileName?: string;
}) =>
  Effect.forkChild(
    uploadAttachment({
      prepared: input?.prepared ?? preparedConnection,
      signer: Option.none(),
      file: new Blob(["hello"]),
      fileName: input?.fileName ?? "notes.txt",
      mimeType: "text/plain",
      onProgress: input?.onProgress,
      signal: input?.signal,
    }),
  );

describe("uploadAttachment", () => {
  beforeEach(() => {
    FakeXhr.instances = [];
    (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
  });

  it.effect("resolves with the parsed response on a 201 and forwards progress", () =>
    Effect.gen(function* () {
      const progressEvents: Array<{ readonly loaded: number; readonly total: number }> = [];
      const fiber = yield* runUpload({ onProgress: (progress) => progressEvents.push(progress) });
      yield* Effect.yieldNow;

      const xhr = FakeXhr.instances[0];
      assert.exists(xhr);
      assert.strictEqual(xhr?.method, "POST");
      assert.strictEqual(xhr?.requestHeaders["x-attachment-name"], "notes.txt");
      assert.strictEqual(xhr?.requestHeaders["content-type"], "text/plain");
      assert.strictEqual(xhr?.withCredentials, true);

      xhr?.progress(2, 5);
      xhr?.respond(
        201,
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fakes the raw HTTP response body a real server would send.
        JSON.stringify({
          uploadId: "upload-1",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
        }),
      );

      const result = yield* Fiber.join(fiber);
      assert.deepStrictEqual(result, {
        uploadId: "upload-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      });
      assert.deepStrictEqual(progressEvents, [{ loaded: 2, total: 5 }]);
    }),
  );

  it.effect("maps a 401 to AttachmentUploadAuthError", () =>
    Effect.gen(function* () {
      const fiber = yield* runUpload();
      yield* Effect.yieldNow;
      FakeXhr.instances[0]?.respond(401, "");

      const result = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.instanceOf(result, AttachmentUploadAuthError);
    }),
  );

  it.effect("maps a 413 to AttachmentUploadTooLargeError", () =>
    Effect.gen(function* () {
      const fiber = yield* runUpload();
      yield* Effect.yieldNow;
      FakeXhr.instances[0]?.respond(413, "");

      const result = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.instanceOf(result, AttachmentUploadTooLargeError);
    }),
  );

  it.effect("maps a network error to AttachmentUploadNetworkError", () =>
    Effect.gen(function* () {
      const fiber = yield* runUpload();
      yield* Effect.yieldNow;
      FakeXhr.instances[0]?.networkError();

      const result = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.instanceOf(result, AttachmentUploadNetworkError);
    }),
  );

  it.effect("aborts the upload when the caller's signal aborts", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const fiber = yield* runUpload({ signal: controller.signal });
      yield* Effect.yieldNow;
      controller.abort();

      const result = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.instanceOf(result, AttachmentUploadAbortedError);
      assert.strictEqual(FakeXhr.instances[0]?.aborted, true);
    }),
  );

  // The credential rule mirrors `withEnvironmentCredentials`: a bearer
  // connection sends the header and must not opt into cookies.
  it.effect("sends a bearer Authorization header without cookie credentials", () =>
    Effect.gen(function* () {
      const fiber = yield* runUpload({
        prepared: {
          ...preparedConnection,
          httpAuthorization: { _tag: "Bearer", token: "test-token" },
        },
      });
      yield* Effect.yieldNow;

      const xhr = FakeXhr.instances[0];
      assert.strictEqual(xhr?.requestHeaders["authorization"], "Bearer test-token");
      assert.strictEqual(xhr?.withCredentials, false);

      yield* Fiber.interrupt(fiber);
    }),
  );

  // `setRequestHeader` takes a ByteString, so the name is percent-encoded
  // rather than sent raw. Without that the call throws a TypeError and the
  // caller's chip is stuck at "uploading" forever.
  it.effect("percent-encodes a non-Latin-1 attachment name", () =>
    Effect.gen(function* () {
      const fiber = yield* runUpload({ fileName: "ataskaita_ž.pdf" });
      yield* Effect.yieldNow;

      assert.strictEqual(
        FakeXhr.instances[0]?.requestHeaders["x-attachment-name"],
        encodeURIComponent("ataskaita_ž.pdf"),
      );

      yield* Fiber.interrupt(fiber);
    }),
  );

  // A synchronous throw inside the callback would otherwise escape as a
  // defect and never reach the caller's failure handler.
  it.effect("maps a synchronous XHR throw to AttachmentUploadRejectedError", () =>
    Effect.gen(function* () {
      class ThrowingXhr extends FakeXhr {
        override setRequestHeader(): void {
          throw new TypeError("bad header");
        }
      }
      (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = ThrowingXhr;

      const fiber = yield* runUpload();
      const result = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.instanceOf(result, AttachmentUploadRejectedError);
    }),
  );
});
