import { assert, it } from "@effect/vitest";

import type { ChatAttachment } from "@t3tools/contracts";

import {
  formatAttachmentPathReferenceText,
  isTextLikeAttachmentMimeType,
} from "./attachmentEncoding.ts";

const makeFileAttachment = (name: string, mimeType: string): ChatAttachment => ({
  type: "file",
  id: `thread-attachment-12345678-1234-1234-1234-1234567890a${name.length % 10}`,
  name,
  mimeType,
  sizeBytes: 12,
});

it("classifies which mime types can ride as text", () => {
  assert.isTrue(isTextLikeAttachmentMimeType("text/markdown"));
  assert.isTrue(isTextLikeAttachmentMimeType("application/json"));
  assert.isTrue(isTextLikeAttachmentMimeType("application/vnd.api+json"));
  assert.isFalse(isTextLikeAttachmentMimeType("application/pdf"));
  assert.isFalse(isTextLikeAttachmentMimeType("application/zip"));
});

it("names one attachment path in the singular", () => {
  assert.equal(
    formatAttachmentPathReferenceText([
      { attachment: makeFileAttachment("notes.zip", "application/zip"), path: "/state/a.zip" },
    ]),
    "The user attached this file. Read it from disk:\n- notes.zip (application/zip): /state/a.zip",
  );
});

it("names several attachment paths in the plural", () => {
  assert.equal(
    formatAttachmentPathReferenceText([
      { attachment: makeFileAttachment("a.zip", "application/zip"), path: "/state/a.zip" },
      { attachment: makeFileAttachment("b.bin", "application/octet-stream"), path: "/state/b.bin" },
    ]),
    [
      "The user attached these files. Read them from disk:",
      "- a.zip (application/zip): /state/a.zip",
      "- b.bin (application/octet-stream): /state/b.bin",
    ].join("\n"),
  );
});
