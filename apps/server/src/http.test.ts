import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  AttachmentUploadTooLargeError,
  capAttachmentUploadStream,
  decodeAttachmentNameHeader,
  isLoopbackHostname,
  resolveDevRedirectUrl,
} from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("capAttachmentUploadStream", () => {
  const chunks = (...sizes: ReadonlyArray<number>) =>
    Stream.fromArray(sizes.map((size) => new Uint8Array(size)));

  effectIt.effect("passes a stream that stays inside the cap and reports the running count", () =>
    Effect.gen(function* () {
      const counts: Array<number> = [];
      const collected = yield* Stream.runCollect(
        capAttachmentUploadStream(chunks(4, 4, 2), 10, (n) => counts.push(n)),
      );

      expect(collected.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(10);
      expect(counts).toEqual([4, 8, 10]);
    }),
  );

  // Content-Length is not consulted here: this is what stops a lying or
  // absent header from writing an unbounded file to disk.
  effectIt.effect("fails mid-stream on the chunk that crosses the cap", () =>
    Effect.gen(function* () {
      const counts: Array<number> = [];
      const error = yield* Stream.runDrain(
        capAttachmentUploadStream(chunks(4, 4, 4), 6, (n) => counts.push(n)),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(AttachmentUploadTooLargeError);
      // Stopped on the second chunk; the third was never pulled.
      expect(counts).toEqual([4, 8]);
    }),
  );
});

describe("decodeAttachmentNameHeader", () => {
  it("decodes a percent-encoded non-Latin-1 name", () => {
    expect(decodeAttachmentNameHeader(encodeURIComponent("ataskaita_ž.pdf"))).toBe(
      "ataskaita_ž.pdf",
    );
  });

  it("returns undefined for a missing, blank, or malformed value", () => {
    expect(decodeAttachmentNameHeader(undefined)).toBeUndefined();
    expect(decodeAttachmentNameHeader("   ")).toBeUndefined();
    expect(decodeAttachmentNameHeader("%E0%A4%A")).toBeUndefined();
  });
});
