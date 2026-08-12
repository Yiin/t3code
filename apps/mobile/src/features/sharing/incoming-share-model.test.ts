import { describe, expect, it, vi } from "@effect/vitest";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type { ResolvedSharePayload, SharePayload } from "expo-sharing";

import type { DraftComposerAttachment } from "../../lib/composerAttachmentRules";
import {
  buildIncomingShareDraft,
  hasIncomingShareContent,
  screenShareAttachmentsForDriver,
} from "./incoming-share-model";

describe("incoming native shares", () => {
  it("converts shared text, URLs, and images into a durable composer draft", async () => {
    const image: SharePayload = {
      shareType: "image",
      value: "file:///shared/Screenshot.png",
      mimeType: "image/png",
    };
    const payloads: SharePayload[] = [
      { shareType: "text", value: "Please explain this error" },
      { shareType: "url", value: "https://example.com/issue/1" },
      { shareType: "text", value: "Please explain this error" },
      image,
    ];
    const resolvedImage: ResolvedSharePayload = {
      ...image,
      contentUri: image.value,
      contentType: "image",
      contentMimeType: "image/png",
      contentSize: 3,
      originalName: "Screenshot.png",
    };
    const removeOwnedFile = vi.fn(() => Promise.resolve());

    const result = await buildIncomingShareDraft({
      id: "share-1",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads,
      resolvedPayloads: [resolvedImage],
      fileReader: {
        readBase64: async () => "YWJj",
        removeOwnedFile,
      },
    });

    expect(result).toEqual({
      schemaVersion: 1,
      id: "share-1",
      createdAt: "2026-07-15T10:00:00.000Z",
      text: "Please explain this error\n\nhttps://example.com/issue/1",
      attachments: [
        {
          id: "share-1:image:3",
          type: "image",
          name: "Screenshot.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataUrl: "data:image/png;base64,YWJj",
          previewUri: "data:image/png;base64,YWJj",
        },
      ],
      warnings: [],
    });
    expect(removeOwnedFile).toHaveBeenCalledWith(image.value);
    expect(hasIncomingShareContent(result)).toBe(true);
  });

  it("skips oversized images and releases the temporary native file", async () => {
    const image: SharePayload = {
      shareType: "image",
      value: "file:///shared/huge.png",
      mimeType: "image/png",
    };
    const readBase64 = vi.fn(async () => "unused");
    const removeOwnedFile = vi.fn(() => Promise.resolve());

    const result = await buildIncomingShareDraft({
      id: "share-2",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads: [image],
      resolvedPayloads: [
        {
          ...image,
          contentUri: image.value,
          contentType: "image",
          contentMimeType: "image/png",
          contentSize: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
          originalName: "huge.png",
        },
      ],
      fileReader: { readBase64, removeOwnedFile },
    });

    expect(result.attachments).toEqual([]);
    expect(result.warnings).toEqual(["'huge.png' exceeds the 10 MB attachment limit."]);
    expect(readBase64).not.toHaveBeenCalled();
    expect(removeOwnedFile).toHaveBeenCalledWith(image.value);
    expect(hasIncomingShareContent(result)).toBe(false);
  });

  it("releases every temporary file when a share exceeds the attachment limit", async () => {
    const payloads = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 }, (_, index) => ({
      shareType: "image" as const,
      value: `file:///shared/${index}.png`,
      mimeType: "image/png",
    }));
    const removeOwnedFile = vi.fn(() => Promise.resolve());
    const readBase64 = vi.fn(async () => "YWJj");

    const result = await buildIncomingShareDraft({
      id: "share-3",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads,
      resolvedPayloads: [],
      fileReader: { readBase64, removeOwnedFile },
    });

    expect(result.attachments).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
    expect(result.warnings).toEqual([
      `Only the first ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} shared files were attached.`,
    ]);
    expect(readBase64).toHaveBeenCalledTimes(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
    expect(removeOwnedFile).toHaveBeenCalledTimes(payloads.length);
  });

  it("maps duplicate image payloads to distinct resolved files", async () => {
    const duplicate: SharePayload = {
      shareType: "image",
      value: "content://shared/screenshot",
      mimeType: "image/png",
    };
    const resolvedPayloads: ResolvedSharePayload[] = [
      {
        ...duplicate,
        contentUri: "file:///cache/first.png",
        contentType: "image",
        contentMimeType: "image/png",
        contentSize: 3,
        originalName: "first.png",
      },
      {
        ...duplicate,
        contentUri: "file:///cache/second.png",
        contentType: "image",
        contentMimeType: "image/png",
        contentSize: 3,
        originalName: "second.png",
      },
    ];
    const readBase64 = vi.fn(async (uri: string) =>
      uri.includes("first") ? "Zmlyc3Q=" : "c2Vjb25k",
    );
    const removeOwnedFile = vi.fn(async () => undefined);

    const result = await buildIncomingShareDraft({
      id: "share-duplicates",
      createdAt: "2026-07-16T08:00:00.000Z",
      payloads: [duplicate, duplicate],
      resolvedPayloads,
      fileReader: { readBase64, removeOwnedFile },
    });

    expect(readBase64.mock.calls.map(([uri]) => uri)).toEqual([
      "file:///cache/first.png",
      "file:///cache/second.png",
    ]);
    expect(result.attachments.map((attachment) => attachment.name)).toEqual([
      "first.png",
      "second.png",
    ]);
    expect(removeOwnedFile).toHaveBeenCalledWith("file:///cache/first.png");
    expect(removeOwnedFile).toHaveBeenCalledWith("file:///cache/second.png");
  });

  it("keeps imported content when temporary-file cleanup fails", async () => {
    const image: SharePayload = {
      shareType: "image",
      value: "file:///shared/screenshot.png",
      mimeType: "image/png",
    };

    const result = await buildIncomingShareDraft({
      id: "share-cleanup-failure",
      createdAt: "2026-07-16T08:00:00.000Z",
      payloads: [image],
      resolvedPayloads: [],
      fileReader: {
        readBase64: async () => "YWJj",
        removeOwnedFile: async () => {
          throw new Error("file is busy");
        },
      },
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("converts a shared document into a file attachment with no preview", async () => {
    const document: SharePayload = {
      shareType: "file",
      value: "content://shared/report",
      mimeType: "application/pdf",
    };

    const result = await buildIncomingShareDraft({
      id: "share-file",
      createdAt: "2026-08-12T08:00:00.000Z",
      payloads: [{ shareType: "text", value: "Summarize this" }, document],
      resolvedPayloads: [
        {
          ...document,
          contentUri: "file:///cache/report.pdf",
          contentType: "file",
          contentMimeType: "application/pdf",
          contentSize: 3,
          originalName: "Q3 report.pdf",
        },
      ],
      fileReader: {
        readBase64: async () => "YWJj",
        removeOwnedFile: async () => undefined,
      },
    });

    expect(result.text).toBe("Summarize this");
    expect(result.attachments).toEqual([
      {
        id: "share-file:file:1",
        type: "file",
        name: "Q3 report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
        dataUrl: "data:application/pdf;base64,YWJj",
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("types an untyped shared file from its name and names an untyped one from its type", async () => {
    const named: SharePayload = { shareType: "file", value: "file:///shared/notes.md" };
    const unnamed: SharePayload = {
      shareType: "video",
      value: "content://shared",
      mimeType: "video/mp4",
    };

    const result = await buildIncomingShareDraft({
      id: "share-types",
      createdAt: "2026-08-12T08:00:00.000Z",
      payloads: [named, unnamed],
      resolvedPayloads: [],
      fileReader: {
        readBase64: async () => "YWJj",
        removeOwnedFile: async () => undefined,
      },
    });

    expect(
      result.attachments.map((attachment) => ({
        name: attachment.name,
        mimeType: attachment.mimeType,
        type: attachment.type,
      })),
    ).toEqual([
      { name: "notes.md", mimeType: "text/markdown", type: "file" },
      { name: "shared-file-2.mp4", mimeType: "video/mp4", type: "file" },
    ]);
  });

  it("holds a shared file to the file byte limit", async () => {
    const document: SharePayload = {
      shareType: "file",
      value: "file:///shared/huge.zip",
      mimeType: "application/zip",
    };
    const readBase64 = vi.fn(async () => "unused");

    const result = await buildIncomingShareDraft({
      id: "share-huge-file",
      createdAt: "2026-08-12T08:00:00.000Z",
      payloads: [document],
      resolvedPayloads: [
        {
          ...document,
          contentUri: document.value,
          contentType: "file",
          contentMimeType: "application/zip",
          contentSize: PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES + 1,
          originalName: "huge.zip",
        },
      ],
      fileReader: { readBase64, removeOwnedFile: async () => undefined },
    });

    expect(result.attachments).toEqual([]);
    expect(result.warnings).toEqual(["'huge.zip' exceeds the 10 MB attachment limit."]);
    expect(readBase64).not.toHaveBeenCalled();
  });
});

describe("screening shared attachments for the destination driver", () => {
  const image: DraftComposerAttachment = {
    id: "a",
    type: "image",
    name: "shot.png",
    mimeType: "image/png",
    sizeBytes: 3,
    dataUrl: "data:image/png;base64,YWJj",
    previewUri: "data:image/png;base64,YWJj",
  };
  const file: DraftComposerAttachment = {
    id: "b",
    type: "file",
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 3,
    dataUrl: "data:application/pdf;base64,YWJj",
  };

  it("keeps every attachment for a driver that takes files", () => {
    const result = screenShareAttachmentsForDriver({
      attachments: [image, file],
      driver: ProviderDriverKind.make("claudeAgent"),
    });

    expect(result.attachments).toEqual([image, file]);
    expect(result.warnings).toEqual([]);
  });

  it("drops files for a driver that cannot take them and names the provider", () => {
    const result = screenShareAttachmentsForDriver({
      attachments: [image, file, { ...file, id: "c" }],
      driver: ProviderDriverKind.make("someForkDriver"),
      providerLabel: "Fork Agent",
    });

    expect(result.attachments).toEqual([image]);
    expect(result.warnings).toEqual([
      "Fork Agent cannot take file attachments, so 2 shared files were skipped.",
    ]);
  });

  it("keeps everything while the destination driver is still unresolved", () => {
    const result = screenShareAttachmentsForDriver({
      attachments: [image, file],
      driver: null,
    });

    expect(result.attachments).toEqual([image, file]);
    expect(result.warnings).toEqual([]);
  });
});
