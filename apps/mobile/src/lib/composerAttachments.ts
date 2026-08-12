/**
 * Composer attachment sources for the Expo client.
 *
 * The composer takes photos and arbitrary documents. Photos come from
 * `expo-image-picker`, documents from `expo-document-picker`. Which sources are
 * offered depends on the driver that will run the turn:
 * `attachmentCapabilityForDriver` is the same table the web composer reads, and
 * only `unsupported` refuses a class of attachment here. A mime type outside a
 * driver's declared list still goes through, because the driver's encoder falls
 * back for it.
 */
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  attachmentCapabilityForDriver,
  type ProviderDriverKind,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { estimateBase64ByteSize } from "./base64";
import { uuidv4 } from "./uuid";

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

const attachmentKindForMimeType = (mimeType: string): ComposerAttachmentKind =>
  mimeType.startsWith("image/") ? "image" : "file";

const tooManyAttachmentsMessage = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;

const overSizeMessage = (name: string, kind: ComposerAttachmentKind): string =>
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

const OWNED_PASTED_IMAGE_DIRECTORY = "t3-composer-paste";

async function loadImagePicker() {
  try {
    return await import("expo-image-picker");
  } catch (error) {
    throw new Error("Image attachments are unavailable right now.", { cause: error });
  }
}

async function loadDocumentPicker() {
  try {
    return await import("expo-document-picker");
  } catch (error) {
    throw new Error("File attachments are unavailable right now.", { cause: error });
  }
}

async function loadClipboard() {
  try {
    return await import("expo-clipboard");
  } catch (error) {
    throw new Error("Clipboard paste is unavailable right now.", { cause: error });
  }
}

export async function pickComposerPhotos(input: { readonly existingCount: number }): Promise<{
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly error: string | null;
}> {
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  if (remainingSlots <= 0) {
    return {
      attachments: [],
      error: tooManyAttachmentsMessage,
    };
  }

  let imagePicker: Awaited<ReturnType<typeof loadImagePicker>>;
  try {
    imagePicker = await loadImagePicker();
  } catch (error) {
    return {
      attachments: [],
      error:
        error instanceof Error ? error.message : "Image attachments are unavailable right now.",
    };
  }

  const permission = await imagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return {
      attachments: [],
      error: "Allow photo library access to attach images.",
    };
  }

  const result = await imagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: remainingSlots,
    base64: true,
    quality: 1,
  });

  if (result.canceled) {
    return {
      attachments: [],
      error: null,
    };
  }

  const nextImages: DraftComposerImageAttachment[] = [];
  let error: string | null = null;

  for (const asset of result.assets) {
    const mimeType = asset.mimeType?.toLowerCase();
    if (!mimeType?.startsWith("image/")) {
      error = `Unsupported file type for '${asset.fileName ?? "image"}'.`;
      continue;
    }

    const base64 = asset.base64;
    if (!base64) {
      error = `Failed to read '${asset.fileName ?? "image"}'.`;
      continue;
    }

    const sizeBytes = asset.fileSize ?? estimateBase64ByteSize(base64);
    if (sizeBytes <= 0 || sizeBytes > maxAttachmentBytes("image")) {
      error = overSizeMessage(asset.fileName ?? "image", "image");
      continue;
    }

    nextImages.push({
      id: uuidv4(),
      type: "image",
      name: asset.fileName ?? "image",
      mimeType,
      sizeBytes,
      dataUrl: `data:${mimeType};base64,${base64}`,
      previewUri: asset.uri,
    });
  }

  return {
    attachments: nextImages,
    error,
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

/**
 * Pick documents of any type. An image chosen here still becomes an image
 * attachment, so it previews like one from the photo picker.
 */
export async function pickComposerDocuments(input: {
  readonly existingCount: number;
  readonly driver: ProviderDriverKind | null;
  /** Display name of the provider instance that will run the turn. */
  readonly providerLabel?: string | undefined;
}): Promise<{
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly error: string | null;
}> {
  if (!composerAttachmentSources({ driver: input.driver }).documents) {
    return {
      attachments: [],
      error: `${input.providerLabel ?? "This provider"} cannot take file attachments.`,
    };
  }

  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  if (remainingSlots <= 0) {
    return { attachments: [], error: tooManyAttachmentsMessage };
  }

  let documentPicker: Awaited<ReturnType<typeof loadDocumentPicker>>;
  try {
    documentPicker = await loadDocumentPicker();
  } catch (error) {
    return {
      attachments: [],
      error: error instanceof Error ? error.message : "File attachments are unavailable right now.",
    };
  }

  const result = await documentPicker.getDocumentAsync({
    type: "*/*",
    multiple: true,
    copyToCacheDirectory: true,
  });

  if (result.canceled) {
    return { attachments: [], error: null };
  }

  const { File } = await import("expo-file-system");
  const nextAttachments: DraftComposerAttachment[] = [];
  let error: string | null = null;

  for (const asset of result.assets) {
    if (nextAttachments.length >= remainingSlots) {
      error = tooManyAttachmentsMessage;
      break;
    }

    const mimeType = documentMimeType({ name: asset.name, mimeType: asset.mimeType });
    const kind = attachmentKindForMimeType(mimeType);

    // Read before the size gate only when the picker gave no size: a document
    // provider may omit it, and the base64 length is the only measure left.
    let base64: string;
    try {
      base64 = await new File(asset.uri).base64();
    } catch (readError) {
      console.warn("Failed to read picked document", asset.uri, readError);
      error = `Failed to read '${asset.name}'.`;
      continue;
    }

    const sizeBytes = asset.size ?? estimateBase64ByteSize(base64);
    if (sizeBytes <= 0 || sizeBytes > maxAttachmentBytes(kind)) {
      error = overSizeMessage(asset.name, kind);
      continue;
    }

    const dataUrl = `data:${mimeType};base64,${base64}`;
    nextAttachments.push(
      kind === "image"
        ? {
            id: uuidv4(),
            type: "image",
            name: asset.name,
            mimeType,
            sizeBytes,
            dataUrl,
            previewUri: asset.uri,
          }
        : {
            id: uuidv4(),
            type: "file",
            name: asset.name,
            mimeType,
            sizeBytes,
            dataUrl,
          },
    );
  }

  return { attachments: nextAttachments, error };
}

export async function pasteComposerClipboard(input: { readonly existingCount: number }): Promise<{
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly text: string | null;
  readonly error: string | null;
}> {
  let clipboard: Awaited<ReturnType<typeof loadClipboard>>;
  try {
    clipboard = await loadClipboard();
  } catch (error) {
    return {
      attachments: [],
      text: null,
      error: error instanceof Error ? error.message : "Clipboard paste is unavailable right now.",
    };
  }

  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;

  if (await clipboard.hasImageAsync()) {
    if (remainingSlots <= 0) {
      return {
        attachments: [],
        text: null,
        error: tooManyAttachmentsMessage,
      };
    }
    const image = await clipboard.getImageAsync({ format: "png" });
    if (!image) {
      return {
        attachments: [],
        text: null,
        error: "Clipboard image is unavailable.",
      };
    }

    const base64 = image.data.split(",")[1] ?? "";
    const sizeBytes = estimateBase64ByteSize(base64);
    if (sizeBytes <= 0 || sizeBytes > maxAttachmentBytes("image")) {
      return {
        attachments: [],
        text: null,
        error: `Clipboard image exceeds the ${megabyteLabel(maxAttachmentBytes("image"))} attachment limit.`,
      };
    }

    return {
      attachments: [
        {
          id: uuidv4(),
          type: "image",
          name: "pasted-image.png",
          mimeType: "image/png",
          sizeBytes,
          dataUrl: image.data,
          previewUri: image.data,
        },
      ],
      text: null,
      error: null,
    };
  }

  if (await clipboard.hasStringAsync()) {
    const text = await clipboard.getStringAsync();
    return {
      attachments: [],
      text: text.length > 0 ? text : null,
      error: text.length > 0 ? null : "Clipboard is empty.",
    };
  }

  return {
    attachments: [],
    text: null,
    error: "Clipboard does not contain pasteable text or image content.",
  };
}

function mimeTypeFromUri(uri: string): string {
  const ext = uri.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    default:
      return "image/png";
  }
}

export function isOwnedPastedImageUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") {
      return false;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    return (
      segments.at(-2) === OWNED_PASTED_IMAGE_DIRECTORY && segments.at(-1)?.endsWith(".png") === true
    );
  } catch {
    return false;
  }
}

export async function convertPastedImagesToAttachments(input: {
  readonly uris: ReadonlyArray<string>;
  readonly existingCount: number;
}): Promise<ReadonlyArray<DraftComposerImageAttachment>> {
  const { File } = await import("expo-file-system");
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  const results: DraftComposerImageAttachment[] = [];

  for (const [index, uri] of input.uris.entries()) {
    const ownedTemporaryFile = isOwnedPastedImageUri(uri);
    try {
      if (index >= Math.max(0, remainingSlots)) {
        continue;
      }
      const file = new File(uri);
      const base64 = await file.base64();
      const sizeBytes = estimateBase64ByteSize(base64);
      if (sizeBytes <= 0 || sizeBytes > maxAttachmentBytes("image")) {
        continue;
      }
      const mimeType = mimeTypeFromUri(uri);
      results.push({
        id: uuidv4(),
        type: "image",
        name: `pasted-image.${mimeType.split("/")[1] ?? "png"}`,
        mimeType,
        sizeBytes,
        dataUrl: `data:${mimeType};base64,${base64}`,
        previewUri: ownedTemporaryFile ? `data:${mimeType};base64,${base64}` : uri,
      });
    } catch (error) {
      console.warn("Failed to read pasted image", uri, error);
    } finally {
      if (ownedTemporaryFile) {
        try {
          const file = new File(uri);
          if (file.exists) {
            file.delete();
          }
        } catch (error) {
          console.warn("Failed to remove temporary pasted image", uri, error);
        }
      }
    }
  }

  return results;
}
