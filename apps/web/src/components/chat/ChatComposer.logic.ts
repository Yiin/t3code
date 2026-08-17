import type {
  ComposerImageAttachment,
  PersistedComposerImageAttachment,
} from "../../composerDraftStore";

export function planImagePersistence(
  attachments: ReadonlyArray<
    PersistedComposerImageAttachment | Pick<ComposerImageAttachment, "id">
  >,
  persisted: ReadonlyArray<PersistedComposerImageAttachment>,
): PersistedComposerImageAttachment[] {
  const persistedById = new Map(persisted.map((attachment) => [attachment.id, attachment]));
  return attachments.flatMap((attachment) => {
    const attachmentId = attachment.id;
    const nextAttachment = "dataUrl" in attachment ? attachment : persistedById.get(attachmentId);
    return nextAttachment ? [nextAttachment] : [];
  });
}

export function toPersistedComposerImage(
  image: ComposerImageAttachment,
  dataUrl: string,
): PersistedComposerImageAttachment {
  return {
    type: image.type,
    id: image.id,
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    dataUrl,
  };
}
