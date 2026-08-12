/**
 * Pure attachment rules for the Expo client: what an attachment is, how big it
 * may be, what to call it, and which sources a driver accepts.
 *
 * This half has no native dependency, so any module can read it — including the
 * incoming-share model, which runs before a composer exists. The pickers that
 * touch the photo library, the document provider and the clipboard live in
 * `composerAttachments.ts`, which re-exports everything here.
 */
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  attachmentCapabilityForDriver,
  type ProviderDriverKind,
  type UploadChatAttachment,
} from "@t3tools/contracts";

type UploadChatImageAttachment = Extract<UploadChatAttachment, { readonly type: "image" }>;
type UploadChatFileAttachment = Extract<UploadChatAttachment, { readonly type: "file" }>;

export type ComposerAttachmentKind = UploadChatAttachment["type"];

export interface DraftComposerImageAttachment extends UploadChatImageAttachment {
  readonly id: string;
  /** A URI the composer can render in an `<Image>`. */
  readonly previewUri: string;
}

export interface DraftComposerFileAttachment extends UploadChatFileAttachment {
  readonly id: string;
  /** A file has no image preview. The strip renders an icon and the name. */
  readonly previewUri?: undefined;
}

export type DraftComposerAttachment = DraftComposerImageAttachment | DraftComposerFileAttachment;

/** Wire shape for startTurn: pure uploads without client draft id / previewUri. */
export function toUploadChatAttachments(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): ReadonlyArray<UploadChatAttachment> {
  return attachments.map((attachment) =>
    attachment.type === "image"
      ? {
          type: "image",
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          dataUrl: attachment.dataUrl,
        }
      : {
          type: "file",
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          dataUrl: attachment.dataUrl,
        },
  );
}

/** Byte cap for one attachment. A document may be larger than a photo. */
export function maxAttachmentBytes(kind: ComposerAttachmentKind): number {
  return kind === "image"
    ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
    : PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES;
}

const megabyteLabel = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

/** An attachment is an image when its mime type says so, whatever produced it. */
export const attachmentKindForMimeType = (mimeType: string): ComposerAttachmentKind =>
  mimeType.startsWith("image/") ? "image" : "file";

export const tooManyAttachmentsMessage = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;

/** One over-size wording for every attachment source: picker, paste, share. */
export const attachmentOverSizeMessage = (name: string, kind: ComposerAttachmentKind): string =>
  `'${name}' exceeds the ${megabyteLabel(maxAttachmentBytes(kind))} attachment limit.`;

/** Which pickers the composer may offer for the driver that runs the turn. */
export interface ComposerAttachmentSources {
  readonly photos: boolean;
  readonly documents: boolean;
}

export function composerAttachmentSources(input: {
  readonly driver: ProviderDriverKind | null;
}): ComposerAttachmentSources {
  if (!input.driver) {
    // No driver resolved yet. Photos are safe on every driver this product has
    // shipped; a document waits until we know who runs the turn.
    return { photos: true, documents: false };
  }
  const capability = attachmentCapabilityForDriver(input.driver);
  return {
    photos: capability.images !== "unsupported",
    documents: capability.files !== "unsupported",
  };
}

const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  csv: "text/csv",
  gif: "image/gif",
  heic: "image/heic",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  txt: "text/plain",
  webp: "image/webp",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
};

/**
 * Mime type for a document the picker did not label. The picker leaves
 * `mimeType` undefined for a type the platform does not know, so fall back to
 * the extension and then to a generic binary type the file schema accepts.
 */
export function documentMimeType(input: {
  readonly name: string;
  readonly mimeType?: string | undefined;
}): string {
  const declared = input.mimeType?.trim().toLowerCase();
  if (declared && declared.includes("/")) {
    return declared;
  }
  const extension = input.name.split(".").pop()?.toLowerCase();
  return (extension ? EXTENSION_MIME_TYPES[extension] : undefined) ?? "application/octet-stream";
}
