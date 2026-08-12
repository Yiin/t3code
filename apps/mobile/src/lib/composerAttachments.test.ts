import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderDriverKind,
} from "@t3tools/contracts";

const files = new Map<string, { base64: string; deleted: boolean }>();

type PickedDocument = {
  name: string;
  uri: string;
  size?: number;
  mimeType?: string;
};

let documentPickerResult: { canceled: boolean; assets: PickedDocument[] | null } = {
  canceled: true,
  assets: null,
};

vi.mock("expo-document-picker", () => ({
  getDocumentAsync: async () => documentPickerResult,
}));

vi.mock("expo-file-system", () => ({
  File: class {
    readonly uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    get exists(): boolean {
      return files.has(this.uri) && files.get(this.uri)?.deleted === false;
    }

    async base64(): Promise<string> {
      const entry = files.get(this.uri);
      if (!entry || entry.deleted) {
        throw new Error("missing file");
      }
      return entry.base64;
    }

    delete(): void {
      const entry = files.get(this.uri);
      if (entry) {
        entry.deleted = true;
      }
    }
  },
}));

vi.mock("./uuid", () => ({
  uuidv4: () => "attachment-id",
}));

import {
  composerAttachmentSources,
  convertPastedImagesToAttachments,
  documentMimeType,
  isOwnedPastedImageUri,
  pickComposerDocuments,
  toUploadChatAttachments,
} from "./composerAttachments";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
/** Not in the built-in table, so it falls back to files: "unsupported". */
const UNKNOWN_DRIVER = ProviderDriverKind.make("someForkDriver");

describe("toUploadChatAttachments", () => {
  it("strips client draft id and previewUri for the startTurn wire shape", () => {
    expect(
      toUploadChatAttachments([
        {
          id: "client-draft-id",
          type: "image",
          name: "pasted-image.png",
          mimeType: "image/png",
          sizeBytes: 12,
          dataUrl: "data:image/png;base64,AA==",
          previewUri: "file:///tmp/preview.png",
        },
      ]),
    ).toEqual([
      {
        type: "image",
        name: "pasted-image.png",
        mimeType: "image/png",
        sizeBytes: 12,
        dataUrl: "data:image/png;base64,AA==",
      },
    ]);
  });

  it("carries the discriminant of every member through", () => {
    expect(
      toUploadChatAttachments([
        {
          id: "draft-image",
          type: "image",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 12,
          dataUrl: "data:image/png;base64,AA==",
          previewUri: "file:///tmp/shot.png",
        },
        {
          id: "draft-file",
          type: "file",
          name: "spec.pdf",
          mimeType: "application/pdf",
          sizeBytes: 40,
          dataUrl: "data:application/pdf;base64,AA==",
        },
      ]).map((attachment) => attachment.type),
    ).toEqual(["image", "file"]);
  });
});

describe("composerAttachmentSources", () => {
  it("offers documents only when the driver can take files", () => {
    expect(composerAttachmentSources({ driver: CLAUDE })).toEqual({
      photos: true,
      documents: true,
    });
    expect(composerAttachmentSources({ driver: UNKNOWN_DRIVER })).toEqual({
      photos: true,
      documents: false,
    });
    expect(composerAttachmentSources({ driver: null })).toEqual({
      photos: true,
      documents: false,
    });
  });
});

describe("documentMimeType", () => {
  it("prefers the picker's mime type, then the extension, then a binary fallback", () => {
    expect(documentMimeType({ name: "notes.txt", mimeType: "text/plain" })).toBe("text/plain");
    expect(documentMimeType({ name: "spec.pdf", mimeType: undefined })).toBe("application/pdf");
    expect(documentMimeType({ name: "archive.unknownext" })).toBe("application/octet-stream");
  });
});

describe("pickComposerDocuments", () => {
  beforeEach(() => {
    files.clear();
    documentPickerResult = { canceled: true, assets: null };
  });

  it("produces a file upload attachment carrying the document's mime type and size", async () => {
    const uri = "file:///tmp/picked/spec.pdf";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });
    documentPickerResult = {
      canceled: false,
      assets: [{ name: "spec.pdf", uri, size: 2048, mimeType: "application/pdf" }],
    };

    const result = await pickComposerDocuments({ existingCount: 0, driver: CLAUDE });

    expect(result.error).toBeNull();
    expect(result.attachments).toEqual([
      {
        id: "attachment-id",
        type: "file",
        name: "spec.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
        dataUrl: "data:application/pdf;base64,aGVsbG8=",
      },
    ]);
  });

  it("keeps a picked image as an image attachment with a preview", async () => {
    const uri = "file:///tmp/picked/shot.png";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });
    documentPickerResult = {
      canceled: false,
      assets: [{ name: "shot.png", uri, size: 12, mimeType: "image/png" }],
    };

    const result = await pickComposerDocuments({ existingCount: 0, driver: CLAUDE });

    expect(result.attachments).toEqual([
      {
        id: "attachment-id",
        type: "image",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 12,
        dataUrl: "data:image/png;base64,aGVsbG8=",
        previewUri: uri,
      },
    ]);
  });

  it("rejects an oversized document and names the file", async () => {
    const uri = "file:///tmp/picked/huge.zip";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });
    documentPickerResult = {
      canceled: false,
      assets: [
        {
          name: "huge.zip",
          uri,
          size: PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES + 1,
          mimeType: "application/zip",
        },
      ],
    };

    const result = await pickComposerDocuments({ existingCount: 0, driver: CLAUDE });

    expect(result.attachments).toEqual([]);
    expect(result.error).toBe("'huge.zip' exceeds the 10 MB attachment limit.");
  });

  it("refuses to open the picker when the driver cannot take files", async () => {
    documentPickerResult = {
      canceled: false,
      assets: [{ name: "spec.pdf", uri: "file:///tmp/picked/spec.pdf", size: 10 }],
    };

    const result = await pickComposerDocuments({
      existingCount: 0,
      driver: UNKNOWN_DRIVER,
      providerLabel: "Some Fork",
    });

    expect(result.attachments).toEqual([]);
    expect(result.error).toBe("Some Fork cannot take file attachments.");
  });

  it("stops at the per-message attachment cap", async () => {
    const uri = "file:///tmp/picked/spec.pdf";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });
    documentPickerResult = {
      canceled: false,
      assets: [{ name: "spec.pdf", uri, size: 10, mimeType: "application/pdf" }],
    };

    const result = await pickComposerDocuments({
      existingCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
      driver: CLAUDE,
    });

    expect(result.attachments).toEqual([]);
    expect(result.error).toBe(
      `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
    );
  });
});

describe("native pasted image cleanup", () => {
  beforeEach(() => {
    files.clear();
  });

  it("recognizes only files created in the native composer paste directory", () => {
    expect(
      isOwnedPastedImageUri(
        "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png",
      ),
    ).toBe(true);
    expect(isOwnedPastedImageUri("file:///private/var/mobile/photos/id.png")).toBe(false);
    expect(isOwnedPastedImageUri("https://example.com/t3-composer-paste/id.png")).toBe(false);
  });

  it("converts owned files to data-backed previews and deletes the source", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });

    const attachments = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(attachments).toEqual([
      expect.objectContaining({
        dataUrl: "data:image/png;base64,aGVsbG8=",
        previewUri: "data:image/png;base64,aGVsbG8=",
      }),
    ]);
    expect(files.get(uri)?.deleted).toBe(true);
  });

  it("deletes rejected and overflow owned files without deleting user-owned files", async () => {
    const rejected =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/bad.png";
    const overflow =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/overflow.png";
    const userOwned = "file:///private/var/mobile/photos/library.png";
    files.set(rejected, { base64: "", deleted: false });
    files.set(overflow, { base64: "aGVsbG8=", deleted: false });
    files.set(userOwned, { base64: "aGVsbG8=", deleted: false });

    await convertPastedImagesToAttachments({
      uris: [rejected, overflow, userOwned],
      existingCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
    });

    expect(files.get(rejected)?.deleted).toBe(true);
    expect(files.get(overflow)?.deleted).toBe(true);
    expect(files.get(userOwned)?.deleted).toBe(false);
  });
});
