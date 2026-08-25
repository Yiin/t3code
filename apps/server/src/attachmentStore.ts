// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ChatAttachment } from "@t3tools/contracts";

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { inferAttachmentExtension } from "./attachmentMime.ts";
import { inferImageExtension } from "./imageMime.ts";

const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const ATTACHMENT_ID_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})$`,
  "i",
);

export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) {
    return null;
  }
  return segment;
}

export function createAttachmentId(threadId: string): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return null;
  }
  return `${threadSegment}-${NodeCrypto.randomUUID()}`;
}

export function parseThreadSegmentFromAttachmentId(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const match = normalizedId.match(ATTACHMENT_ID_PATTERN);
  if (!match) {
    return null;
  }
  return match[1]?.toLowerCase() ?? null;
}

export function attachmentRelativePath(attachment: ChatAttachment): string {
  switch (attachment.type) {
    case "image": {
      const extension = inferImageExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
    case "file": {
      const extension = inferAttachmentExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
  }
}

export function resolveAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
}): string | null {
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: attachmentRelativePath(input.attachment),
  });
}

export function resolveAttachmentPathById(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
}): string | null {
  const normalizedId = normalizeAttachmentRelativePath(input.attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  try {
    for (const entry of NodeFS.readdirSync(input.attachmentsDir, { withFileTypes: true })) {
      if (!entry.isFile() || parseAttachmentIdFromRelativePath(entry.name) !== normalizedId) {
        continue;
      }
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: input.attachmentsDir,
        relativePath: entry.name,
      });
      if (attachmentPath) {
        return attachmentPath;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function parseAttachmentIdFromRelativePath(relativePath: string): string | null {
  const normalized = normalizeAttachmentRelativePath(relativePath);
  if (!normalized || normalized.includes("/")) {
    return null;
  }
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return null;
  }
  const id = normalized.slice(0, extensionIndex);
  return id.length > 0 && !id.includes(".") ? id : null;
}

// --- HTTP upload staging area ---------------------------------------------
//
// `POST /api/attachments` streams a file to `<attachmentsDir>/uploads/` ahead
// of the turn that references it, so a multi-hundred-MB attachment never
// rides the WebSocket send-turn frame. Each upload gets a `.bin` (the bytes)
// and a sibling `.json` (the metadata the Normalizer needs to persist it the
// same way the legacy dataUrl path does).

const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const UPLOADS_SUBDIR = "uploads";

export interface UploadMeta {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

export function isValidUploadId(uploadId: string): boolean {
  return UPLOAD_ID_PATTERN.test(uploadId);
}

export function createUploadId(): string {
  return NodeCrypto.randomUUID();
}

/**
 * Resolves the staged `.bin` (bytes) or `.json` (metadata) path for an
 * uploadId. Returns null for an id that fails `UPLOAD_ID_PATTERN` or that
 * would escape `attachmentsDir`, so a client-supplied id cannot traverse.
 */
export function resolveUploadPath(input: {
  readonly attachmentsDir: string;
  readonly uploadId: string;
  readonly extension: "bin" | "json";
}): string | null {
  if (!isValidUploadId(input.uploadId)) {
    return null;
  }
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: `${UPLOADS_SUBDIR}/${input.uploadId}.${input.extension}`,
  });
}

export function resolveUploadsDir(attachmentsDir: string): string {
  return NodePath.join(attachmentsDir, UPLOADS_SUBDIR);
}

/**
 * Writes the `.json` sidecar once the `.bin` upload has finished streaming
 * (see http.ts's `POST /api/attachments` route). Throws on an invalid
 * uploadId or a filesystem error; callers wrap this in `Effect.try`.
 */
export function writeUploadMeta(input: {
  readonly attachmentsDir: string;
  readonly uploadId: string;
  readonly meta: UploadMeta;
}): void {
  const metaPath = resolveUploadPath({ ...input, extension: "json" });
  if (!metaPath) {
    throw new Error(`Invalid upload id '${input.uploadId}'.`);
  }
  NodeFS.mkdirSync(NodePath.dirname(metaPath), { recursive: true });
  NodeFS.writeFileSync(metaPath, JSON.stringify(input.meta));
}

export function readUploadMeta(input: {
  readonly attachmentsDir: string;
  readonly uploadId: string;
}): UploadMeta | null {
  const metaPath = resolveUploadPath({ ...input, extension: "json" });
  if (!metaPath) {
    return null;
  }
  try {
    const raw = NodeFS.readFileSync(metaPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<UploadMeta>;
    if (
      typeof parsed.name !== "string" ||
      typeof parsed.mimeType !== "string" ||
      typeof parsed.sizeBytes !== "number" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return {
      name: parsed.name,
      mimeType: parsed.mimeType,
      sizeBytes: parsed.sizeBytes,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

export function removeUpload(input: {
  readonly attachmentsDir: string;
  readonly uploadId: string;
}): void {
  const binPath = resolveUploadPath({ ...input, extension: "bin" });
  const metaPath = resolveUploadPath({ ...input, extension: "json" });
  for (const path of [binPath, metaPath]) {
    if (!path) {
      continue;
    }
    try {
      NodeFS.rmSync(path, { force: true });
    } catch {
      // Best-effort cleanup; a leftover file is swept later by sweepExpiredUploads.
    }
  }
}

/**
 * Removes staged uploads whose metadata is older than `maxAgeMs`. The `.json`
 * file is written last (after the `.bin` finishes streaming), so its mtime
 * marks completion, not the start of an in-flight upload.
 *
 * A `.bin` without a sibling `.json` is an upload that never finished: the
 * client aborted mid-body, or the server died before writing the meta. Those
 * are swept on the same age rule, otherwise they would sit on disk forever.
 * The age check keeps an in-flight `.bin` (which also has no `.json` yet)
 * safe, since `maxAgeMs` is an hour and no single upload runs that long.
 */
export function sweepExpiredUploads(input: {
  readonly attachmentsDir: string;
  readonly maxAgeMs: number;
}): void {
  const uploadsDir = resolveUploadsDir(input.attachmentsDir);
  let entries: Array<NodeFS.Dirent>;
  try {
    entries = NodeFS.readdirSync(uploadsDir, { withFileTypes: true });
  } catch {
    return;
  }

  const uploadIdsWithMeta = new Set<string>();
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      uploadIdsWithMeta.add(entry.name.slice(0, -".json".length));
    }
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const isMeta = entry.name.endsWith(".json");
    const isOrphanBin =
      entry.name.endsWith(".bin") && !uploadIdsWithMeta.has(entry.name.slice(0, -".bin".length));
    if (!isMeta && !isOrphanBin) {
      continue;
    }
    const uploadId = entry.name.slice(0, -(isMeta ? ".json" : ".bin").length);
    if (!isValidUploadId(uploadId)) {
      continue;
    }
    const agePath = resolveUploadPath({
      attachmentsDir: input.attachmentsDir,
      uploadId,
      extension: isMeta ? "json" : "bin",
    });
    if (!agePath) {
      continue;
    }
    let mtimeMs: number;
    try {
      mtimeMs = NodeFS.statSync(agePath).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs >= input.maxAgeMs) {
      removeUpload({ attachmentsDir: input.attachmentsDir, uploadId });
    }
  }
}
