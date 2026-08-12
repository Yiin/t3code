import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS, type ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ResolvedSharePayload, SharePayload } from "expo-sharing";

import { DraftComposerAttachmentSchema } from "../../lib/composer-attachment-schema";
import {
  attachmentKindForMimeType,
  attachmentOverSizeMessage,
  composerAttachmentSources,
  documentMimeType,
  maxAttachmentBytes,
  type ComposerAttachmentKind,
  type DraftComposerAttachment,
} from "../../lib/composerAttachmentRules";
import { estimateBase64ByteSize } from "../../lib/base64";

export interface IncomingShareDraft {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly destination?: IncomingShareDestination;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly warnings: ReadonlyArray<string>;
}

export interface IncomingShareDestination {
  readonly environmentId: string;
  readonly projectId: string;
}

const IncomingShareDestinationSchema = Schema.Struct({
  environmentId: Schema.String,
  projectId: Schema.String,
});

export const IncomingShareDraftSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  createdAt: Schema.String,
  destination: Schema.optional(IncomingShareDestinationSchema),
  text: Schema.String,
  attachments: Schema.Array(DraftComposerAttachmentSchema),
  warnings: Schema.Array(Schema.String),
});

const decodeIncomingShareDraftSync = Schema.decodeUnknownSync(IncomingShareDraftSchema);

export function decodeIncomingShareDraft(value: unknown): IncomingShareDraft {
  return decodeIncomingShareDraftSync(value);
}

export interface IncomingShareFileReader {
  readonly readBase64: (uri: string) => Promise<string>;
  readonly removeOwnedFile: (uri: string) => Promise<void> | void;
}

function sharedText(payloads: ReadonlyArray<SharePayload>): string {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const payload of payloads) {
    if (payload.shareType !== "text" && payload.shareType !== "url") {
      continue;
    }
    const value = payload.value.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
  }
  return values.join("\n\n");
}

/** Every share type that carries content rather than words. */
export function carriesShareAttachment(payload: SharePayload): boolean {
  return payload.shareType !== "text" && payload.shareType !== "url";
}

function resolvedAttachmentFor(
  payload: SharePayload,
  index: number,
  resolvedPayloads: ReadonlyArray<ResolvedSharePayload>,
  consumedIndexes: Set<number>,
): ResolvedSharePayload | undefined {
  const sameIndex = resolvedPayloads[index];
  if (
    !consumedIndexes.has(index) &&
    sameIndex?.shareType === payload.shareType &&
    sameIndex.value === payload.value
  ) {
    consumedIndexes.add(index);
    return sameIndex;
  }
  const matchingIndex = resolvedPayloads.findIndex(
    (candidate, candidateIndex) =>
      !consumedIndexes.has(candidateIndex) &&
      candidate.shareType === payload.shareType &&
      candidate.value === payload.value,
  );
  if (matchingIndex < 0) {
    return undefined;
  }
  consumedIndexes.add(matchingIndex);
  return resolvedPayloads[matchingIndex];
}

async function releaseOwnedFiles(
  fileReader: IncomingShareFileReader,
  uris: ReadonlyArray<string | undefined>,
): Promise<void> {
  for (const uri of new Set(uris.filter((candidate): candidate is string => Boolean(candidate)))) {
    try {
      await fileReader.removeOwnedFile(uri);
    } catch {
      // Temporary-file cleanup is best-effort and must never discard content
      // that was successfully converted into a durable composer attachment.
    }
  }
}

function nameFromUri(uri: string): string | undefined {
  try {
    const pathName = new URL(uri).pathname.split("/").findLast((segment) => segment.length > 0);
    return pathName ? decodeURIComponent(pathName) : undefined;
  } catch {
    return undefined;
  }
}

function fallbackName(index: number, mimeType: string, kind: ComposerAttachmentKind): string {
  const extension =
    mimeType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || (kind === "image" ? "png" : "bin");
  return `shared-${kind}-${index + 1}.${extension}`;
}

/** What the share is, and what to call it. Every field the composer needs. */
interface SharedAttachmentIdentity {
  readonly name: string;
  readonly mimeType: string;
  readonly kind: ComposerAttachmentKind;
}

function sharedAttachmentIdentity(input: {
  readonly payload: SharePayload;
  readonly resolved: ResolvedSharePayload | undefined;
  readonly uri: string;
  readonly index: number;
}): SharedAttachmentIdentity {
  const declared = (input.resolved?.contentMimeType ?? input.payload.mimeType)
    ?.trim()
    .toLowerCase();
  const sharedName = input.resolved?.originalName ?? nameFromUri(input.uri);
  let mimeType = documentMimeType({ name: sharedName ?? "", mimeType: declared });
  if (mimeType === "application/octet-stream" && input.payload.shareType === "image") {
    // The platform called it an image but typed neither the payload nor the
    // file name. The image-only path assumed PNG; keep those shares working.
    mimeType = "image/png";
  }
  const kind = attachmentKindForMimeType(mimeType);
  return {
    name: sharedName ?? fallbackName(input.index, mimeType, kind),
    mimeType,
    kind,
  };
}

export async function buildIncomingShareDraft(input: {
  readonly payloads: ReadonlyArray<SharePayload>;
  readonly resolvedPayloads: ReadonlyArray<ResolvedSharePayload>;
  readonly fileReader: IncomingShareFileReader;
  readonly id: string;
  readonly createdAt: string;
}): Promise<IncomingShareDraft> {
  const attachments: DraftComposerAttachment[] = [];
  const warnings: string[] = [];
  const consumedResolvedPayloadIndexes = new Set<number>();
  let warnedAttachmentLimit = false;

  for (const [index, payload] of input.payloads.entries()) {
    if (!carriesShareAttachment(payload)) {
      continue;
    }
    const resolved = resolvedAttachmentFor(
      payload,
      index,
      input.resolvedPayloads,
      consumedResolvedPayloadIndexes,
    );
    const uri = resolved?.contentUri ?? payload.value;
    if (attachments.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      if (!warnedAttachmentLimit) {
        warnings.push(
          `Only the first ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} shared files were attached.`,
        );
        warnedAttachmentLimit = true;
      }
      await releaseOwnedFiles(input.fileReader, [uri, payload.value]);
      continue;
    }

    if (!uri) {
      warnings.push("One shared item had no readable content.");
      await releaseOwnedFiles(input.fileReader, [payload.value]);
      continue;
    }

    const { name, mimeType, kind } = sharedAttachmentIdentity({ payload, resolved, uri, index });
    const maxBytes = maxAttachmentBytes(kind);
    if (
      resolved?.contentSize !== null &&
      resolved?.contentSize !== undefined &&
      resolved.contentSize > maxBytes
    ) {
      warnings.push(attachmentOverSizeMessage(name, kind));
      await releaseOwnedFiles(input.fileReader, [uri, payload.value]);
      continue;
    }

    try {
      const base64 = await input.fileReader.readBase64(uri);
      const sizeBytes = resolved?.contentSize ?? estimateBase64ByteSize(base64);
      if (sizeBytes <= 0 || sizeBytes > maxBytes) {
        warnings.push(attachmentOverSizeMessage(name, kind));
        continue;
      }
      const dataUrl = `data:${mimeType};base64,${base64}`;
      attachments.push(
        kind === "image"
          ? {
              id: `${input.id}:image:${index}`,
              type: "image",
              name,
              mimeType,
              sizeBytes,
              dataUrl,
              // The share provider's file is temporary. A data-backed preview
              // keeps the composer valid after its source file and App Group
              // entry are gone.
              previewUri: dataUrl,
            }
          : {
              id: `${input.id}:file:${index}`,
              type: "file",
              name,
              mimeType,
              sizeBytes,
              dataUrl,
            },
      );
    } catch {
      warnings.push(`Could not read '${name}'.`);
    } finally {
      await releaseOwnedFiles(input.fileReader, [uri, payload.value]);
    }
  }

  return {
    schemaVersion: 1,
    id: input.id,
    createdAt: input.createdAt,
    text: sharedText(input.payloads),
    attachments,
    warnings,
  };
}

export function hasIncomingShareContent(draft: IncomingShareDraft): boolean {
  return draft.text.trim().length > 0 || draft.attachments.length > 0;
}

export interface ScreenedShareAttachments {
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly warnings: ReadonlyArray<string>;
}

function skippedCountLabel(count: number, noun: string): string {
  return count === 1 ? `1 shared ${noun} was skipped` : `${count} shared ${noun}s were skipped`;
}

/**
 * Drops shared attachments the destination cannot take, reading the same
 * `attachmentCapabilityForDriver` table the composer's pickers read.
 *
 * A share arrives before its destination is chosen, so the gate runs at import
 * time against the driver that will run the turn. A null driver keeps
 * everything: the provider list may still be loading, and dropping a file the
 * user can no longer re-share is worse than one the send path refuses.
 */
export function screenShareAttachmentsForDriver(input: {
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly driver: ProviderDriverKind | null;
  /** Display name of the provider instance that will run the turn. */
  readonly providerLabel?: string | undefined;
}): ScreenedShareAttachments {
  if (!input.driver || input.attachments.length === 0) {
    return { attachments: input.attachments, warnings: [] };
  }
  const sources = composerAttachmentSources({ driver: input.driver });
  if (sources.photos && sources.documents) {
    return { attachments: input.attachments, warnings: [] };
  }

  const kept: DraftComposerAttachment[] = [];
  let skippedImages = 0;
  let skippedFiles = 0;
  for (const attachment of input.attachments) {
    const allowed = attachment.type === "image" ? sources.photos : sources.documents;
    if (allowed) {
      kept.push(attachment);
    } else if (attachment.type === "image") {
      skippedImages += 1;
    } else {
      skippedFiles += 1;
    }
  }

  const label = input.providerLabel ?? "This provider";
  const warnings: string[] = [];
  if (skippedImages > 0) {
    warnings.push(
      `${label} cannot take image attachments, so ${skippedCountLabel(skippedImages, "image")}.`,
    );
  }
  if (skippedFiles > 0) {
    warnings.push(
      `${label} cannot take file attachments, so ${skippedCountLabel(skippedFiles, "file")}.`,
    );
  }
  return { attachments: kept, warnings };
}
