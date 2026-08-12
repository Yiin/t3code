import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DraftComposerAttachmentSchema } from "./composer-attachment-schema";

const decode = Schema.decodeUnknownSync(DraftComposerAttachmentSchema);

describe("DraftComposerAttachmentSchema", () => {
  it("still decodes an image draft written before files were supported", () => {
    expect(
      decode({
        id: "draft-image",
        previewUri: "file:///tmp/shot.png",
        type: "image",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 12,
        dataUrl: "data:image/png;base64,AA==",
      }),
    ).toEqual({
      id: "draft-image",
      previewUri: "file:///tmp/shot.png",
      type: "image",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 12,
      dataUrl: "data:image/png;base64,AA==",
    });
  });

  it("decodes a file draft that carries no preview", () => {
    expect(
      decode({
        id: "draft-file",
        type: "file",
        name: "spec.pdf",
        mimeType: "application/pdf",
        sizeBytes: 40,
        dataUrl: "data:application/pdf;base64,AA==",
      }),
    ).toEqual({
      id: "draft-file",
      type: "file",
      name: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: 40,
      dataUrl: "data:application/pdf;base64,AA==",
    });
  });

  it("rejects an attachment with an unknown type", () => {
    expect(() =>
      decode({
        id: "draft-video",
        type: "video",
        name: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 40,
        dataUrl: "data:video/mp4;base64,AA==",
      }),
    ).toThrow();
  });
});
