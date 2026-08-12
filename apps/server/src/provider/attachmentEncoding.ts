import type { ChatAttachment } from "@t3tools/contracts";

const TEXT_LIKE_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/graphql",
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/sql",
  "application/toml",
  "application/typescript",
  "application/x-javascript",
  "application/x-ndjson",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-typescript",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
]);

const TEXT_LIKE_MIME_SUFFIXES: ReadonlyArray<string> = ["+json", "+xml", "+yaml"];

/**
 * Whether this mime type's bytes can ride as text rather than base64.
 *
 * ACP uses it to pick `text` over a `blob` in an embedded resource; Claude uses
 * it to pick a plain-text document source over a path reference.
 */
export function isTextLikeAttachmentMimeType(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized.startsWith("text/")) {
    return true;
  }
  if (TEXT_LIKE_MIME_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return true;
  }
  return TEXT_LIKE_MIME_TYPES.has(normalized);
}

export interface AttachmentPathReference {
  readonly attachment: ChatAttachment;
  readonly path: string;
}

/**
 * The prompt text that hands a provider an attachment it cannot carry
 * structurally: the file's name, mime type and absolute path, plus an
 * instruction to read it.
 *
 * Codex, Prime and Claude's residual binary case all fall back to this, and the
 * `t3code-vzb.33` probe confirmed each one reads an absolute path under the
 * attachments directory. Keep the wording in one place so a model sees the same
 * phrasing whichever provider it runs on.
 */
export function formatAttachmentPathReferenceText(
  files: ReadonlyArray<AttachmentPathReference>,
): string {
  const lines = files.map(
    ({ attachment, path }) => `- ${attachment.name} (${attachment.mimeType}): ${path}`,
  );
  const single = files.length === 1;
  return `The user attached ${single ? "this file" : "these files"}. Read ${
    single ? "it" : "them"
  } from disk:\n${lines.join("\n")}`;
}
