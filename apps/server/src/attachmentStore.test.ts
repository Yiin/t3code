// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ChatAttachment } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  attachmentRelativePath,
  createAttachmentId,
  createUploadId,
  isValidUploadId,
  parseThreadSegmentFromAttachmentId,
  readUploadMeta,
  removeUpload,
  resolveAttachmentPathById,
  resolveUploadPath,
  sweepExpiredUploads,
} from "./attachmentStore.ts";

const decodeChatAttachment = Schema.decodeUnknownSync(ChatAttachment);

describe("attachmentStore", () => {
  it.each([
    ["report.log", "text/plain", ".log"],
    ["report", "application/pdf", ".pdf"],
    ["report", "application/x-unknown", ".bin"],
    [".env", "application/x-unknown", ".bin"],
  ])("uses a safe file extension for %s", (name, mimeType, extension) => {
    const attachment = decodeChatAttachment({
      type: "file",
      id: "attachment-1",
      name,
      mimeType,
      sizeBytes: 128,
    });

    expect(attachmentRelativePath(attachment)).toBe(`attachment-1${extension}`);
  });

  it("sanitizes thread ids when creating attachment ids", () => {
    const attachmentId = createAttachmentId("thread.folder/unsafe space");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }

    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    expect(threadSegment).toBeTruthy();
    expect(threadSegment).toMatch(/^[a-z0-9_-]+$/i);
    expect(threadSegment).not.toContain(".");
    expect(threadSegment).not.toContain("%");
    expect(threadSegment).not.toContain("/");
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("normalizes created thread segments to lowercase", () => {
    const attachmentId = createAttachmentId("Thread.Foo");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }
    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("thread-foo");
  });

  it("resolves attachment path by id using the extension that exists on disk", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachmentId = "thread-1-attachment";
      const pngPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      });
      expect(resolved).toBe(pngPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("resolves a file attachment with an arbitrary safe extension", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachmentId = "thread-1-attachment";
      const logPath = NodePath.join(attachmentsDir, `${attachmentId}.log`);
      NodeFS.writeFileSync(logPath, Buffer.from("hello"));

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      });
      expect(resolved).toBe(logPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("returns null when no attachment file exists for the id", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: "thread-1-missing",
      });
      expect(resolved).toBeNull();
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  describe("upload staging", () => {
    function withAttachmentsDir(run: (attachmentsDir: string) => void) {
      const attachmentsDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-uploads-"),
      );
      try {
        run(attachmentsDir);
      } finally {
        NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
      }
    }

    function stageUpload(attachmentsDir: string, uploadId: string, meta: object) {
      const binPath = resolveUploadPath({ attachmentsDir, uploadId, extension: "bin" });
      const metaPath = resolveUploadPath({ attachmentsDir, uploadId, extension: "json" });
      if (!binPath || !metaPath) {
        throw new Error("expected valid upload paths");
      }
      NodeFS.mkdirSync(NodePath.dirname(binPath), { recursive: true });
      NodeFS.writeFileSync(binPath, Buffer.from("hello"));
      NodeFS.writeFileSync(metaPath, JSON.stringify(meta));
      return { binPath, metaPath };
    }

    it("creates upload ids that pass isValidUploadId", () => {
      const uploadId = createUploadId();
      expect(isValidUploadId(uploadId)).toBe(true);
    });

    it("rejects unsafe upload ids when resolving paths", () => {
      withAttachmentsDir((attachmentsDir) => {
        expect(
          resolveUploadPath({ attachmentsDir, uploadId: "../escape", extension: "bin" }),
        ).toBeNull();
        expect(resolveUploadPath({ attachmentsDir, uploadId: "", extension: "json" })).toBeNull();
      });
    });

    it("reads back staged metadata", () => {
      withAttachmentsDir((attachmentsDir) => {
        const uploadId = createUploadId();
        stageUpload(attachmentsDir, uploadId, {
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          createdAt: new Date().toISOString(),
        });

        const meta = readUploadMeta({ attachmentsDir, uploadId });
        expect(meta).toEqual({
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          createdAt: expect.any(String),
        });
      });
    });

    it("returns null metadata for an unknown upload id", () => {
      withAttachmentsDir((attachmentsDir) => {
        expect(readUploadMeta({ attachmentsDir, uploadId: createUploadId() })).toBeNull();
      });
    });

    it("removes both staged files", () => {
      withAttachmentsDir((attachmentsDir) => {
        const uploadId = createUploadId();
        const { binPath, metaPath } = stageUpload(attachmentsDir, uploadId, {
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          createdAt: new Date().toISOString(),
        });

        removeUpload({ attachmentsDir, uploadId });

        expect(NodeFS.existsSync(binPath)).toBe(false);
        expect(NodeFS.existsSync(metaPath)).toBe(false);
      });
    });

    it("sweeps only uploads whose metadata is older than maxAgeMs", () => {
      withAttachmentsDir((attachmentsDir) => {
        const staleId = createUploadId();
        const freshId = createUploadId();
        const { binPath: staleBinPath, metaPath: staleMetaPath } = stageUpload(
          attachmentsDir,
          staleId,
          { name: "old.txt", mimeType: "text/plain", sizeBytes: 5, createdAt: "x" },
        );
        const { binPath: freshBinPath } = stageUpload(attachmentsDir, freshId, {
          name: "new.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          createdAt: "x",
        });

        const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
        NodeFS.utimesSync(staleMetaPath, oldTime, oldTime);

        sweepExpiredUploads({ attachmentsDir, maxAgeMs: 60 * 60 * 1000 });

        expect(NodeFS.existsSync(staleBinPath)).toBe(false);
        expect(NodeFS.existsSync(staleMetaPath)).toBe(false);
        expect(NodeFS.existsSync(freshBinPath)).toBe(true);
      });
    });

    // A client that aborts mid-body, or a server that dies while streaming,
    // leaves a `.bin` with no sibling `.json`. Without this the orphan sits
    // on disk forever, because the meta-driven pass above never sees it.
    it("sweeps an orphan .bin that has no sibling .json once it is old enough", () => {
      withAttachmentsDir((attachmentsDir) => {
        const orphanId = createUploadId();
        const orphanBinPath = resolveUploadPath({
          attachmentsDir,
          uploadId: orphanId,
          extension: "bin",
        });
        if (!orphanBinPath) {
          throw new Error("expected a valid upload bin path");
        }
        NodeFS.mkdirSync(NodePath.dirname(orphanBinPath), { recursive: true });
        NodeFS.writeFileSync(orphanBinPath, Buffer.from("half an upload"));
        const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
        NodeFS.utimesSync(orphanBinPath, oldTime, oldTime);

        sweepExpiredUploads({ attachmentsDir, maxAgeMs: 60 * 60 * 1000 });

        expect(NodeFS.existsSync(orphanBinPath)).toBe(false);
      });
    });

    it("keeps an in-flight .bin that has no sibling .json yet", () => {
      withAttachmentsDir((attachmentsDir) => {
        const inFlightId = createUploadId();
        const inFlightBinPath = resolveUploadPath({
          attachmentsDir,
          uploadId: inFlightId,
          extension: "bin",
        });
        if (!inFlightBinPath) {
          throw new Error("expected a valid upload bin path");
        }
        NodeFS.mkdirSync(NodePath.dirname(inFlightBinPath), { recursive: true });
        NodeFS.writeFileSync(inFlightBinPath, Buffer.from("still streaming"));

        sweepExpiredUploads({ attachmentsDir, maxAgeMs: 60 * 60 * 1000 });

        expect(NodeFS.existsSync(inFlightBinPath)).toBe(true);
      });
    });
  });
});
