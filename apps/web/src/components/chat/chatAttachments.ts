/**
 * Chat attachment gate and presentation helpers.
 *
 * The composer takes any file type. What a file is worth depends on the driver
 * that will run the turn: `attachmentCapabilityForDriver` says whether the
 * driver's protocol can express that class of attachment at all. Only
 * `unsupported` refuses a file here — a mime type outside a driver's declared
 * list still goes through, because the driver's encoder falls back for it.
 *
 * Kept pure so the size, count and capability rules can be tested without a
 * DOM.
 */
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderDriverKind,
  attachmentCapabilityForDriver,
} from "@t3tools/contracts";

export type ComposerAttachmentKind = "image" | "file";

/** The fields the gate reads from a `File`. */
export interface ComposerAttachmentCandidate {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

export type ComposerAttachmentScreening =
  /** Attach this file. */
  | { readonly outcome: "accept"; readonly kind: ComposerAttachmentKind }
  /** Skip this file, keep screening the rest. */
  | { readonly outcome: "reject"; readonly message: string }
  /** No room left; stop screening. */
  | { readonly outcome: "stop"; readonly message: string };

export const composerAttachmentKind = (mimeType: string): ComposerAttachmentKind =>
  mimeType.startsWith("image/") ? "image" : "file";

const megabyteLabel = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))}MB`;

/**
 * Human size for a chip label. Bytes below 1 KB read as bytes; everything else
 * gets one decimal place so a 1.4 MB file does not read as 1 MB.
 */
export const formatAttachmentSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
};

/** Uppercase extension for a chip label, empty when the name carries none. */
export const attachmentExtensionLabel = (name: string): string => {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return "";
  const extension = name.slice(dotIndex + 1);
  return /^[a-z0-9]{1,8}$/i.test(extension) ? extension.toUpperCase() : "";
};

export interface ScreenComposerAttachmentContext {
  /**
   * The driver that will run the turn, or `null` when the surface cannot name
   * one. A `null` driver skips the capability gate: refusing a file because we
   * do not know who reads it is worse than letting the driver's encoder decide.
   */
  readonly driver: ProviderDriverKind | null;
  /** Display name of the provider instance that will run the turn. */
  readonly providerLabel: string;
  /** Attachments already staged on this draft. */
  readonly attachedCount: number;
}

export interface ScreenComposerAttachmentInput extends ScreenComposerAttachmentContext {
  readonly file: ComposerAttachmentCandidate;
}

export const screenComposerAttachment = ({
  file,
  driver,
  providerLabel,
  attachedCount,
}: ScreenComposerAttachmentInput): ComposerAttachmentScreening => {
  if (attachedCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    return {
      outcome: "stop",
      message: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
    };
  }
  const kind = composerAttachmentKind(file.type);
  const capability = driver === null ? null : attachmentCapabilityForDriver(driver);
  const support =
    capability === null ? null : kind === "image" ? capability.images : capability.files;
  if (support === "unsupported") {
    return {
      outcome: "reject",
      message:
        kind === "image"
          ? `${providerLabel} cannot take images, so '${file.name}' was not attached.`
          : `${providerLabel} cannot take file attachments, so '${file.name}' was not attached.`,
    };
  }
  const maxBytes =
    kind === "image" ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES : PROVIDER_SEND_TURN_MAX_ATTACHMENT_BYTES;
  if (file.size > maxBytes) {
    return {
      outcome: "reject",
      message: `'${file.name}' exceeds the ${megabyteLabel(maxBytes)} attachment limit.`,
    };
  }
  return { outcome: "accept", kind };
};

export interface ScreenedComposerAttachment<TFile> {
  readonly file: TFile;
  readonly kind: ComposerAttachmentKind;
}

export interface ScreenComposerAttachmentsResult<TFile> {
  readonly accepted: ReadonlyArray<ScreenedComposerAttachment<TFile>>;
  /**
   * The last refusal, or `null` when every file was taken. One message, because
   * one line of composer error space is what a surface has.
   */
  readonly error: string | null;
}

/**
 * Screen a whole drop or file pick. A full draft stops the run; a single
 * refused file is skipped and the rest keep going, so one bad file never costs
 * the others.
 */
export const screenComposerAttachments = <TFile extends ComposerAttachmentCandidate>(
  files: ReadonlyArray<TFile>,
  context: ScreenComposerAttachmentContext,
): ScreenComposerAttachmentsResult<TFile> => {
  const accepted: Array<ScreenedComposerAttachment<TFile>> = [];
  let attachedCount = context.attachedCount;
  let error: string | null = null;
  for (const file of files) {
    const screening = screenComposerAttachment({ ...context, attachedCount, file });
    if (screening.outcome === "stop") {
      error = screening.message;
      break;
    }
    if (screening.outcome === "reject") {
      error = screening.message;
      continue;
    }
    accepted.push({ file, kind: screening.kind });
    attachedCount += 1;
  }
  return { accepted, error };
};
