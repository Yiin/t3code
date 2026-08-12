// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { ChatAttachment, ProviderDriverKind } from "@t3tools/contracts";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";

const PROMPT_METHOD = "session/prompt";

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
 * Whether an embedded resource for this mime type should carry `text` rather
 * than a base64 `blob`. ACP lets an agent read either, but text costs no
 * decode step on the agent side and keeps the prompt log readable.
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

/**
 * Encodes chat attachments as ACP prompt content blocks.
 *
 * Cursor, Grok and Kimi all speak ACP, so they share one encoding:
 *
 * - An image stays `{type:"image"}`, exactly as before.
 * - A file becomes an embedded `resource` when the agent advertises
 *   `promptCapabilities.embeddedContext`, so the agent never has to open the
 *   file itself. Text-ish mime types ride as `text`, everything else as a
 *   base64 `blob`.
 * - Without `embeddedContext` a file becomes a `resource_link`, which every
 *   ACP agent must support. Attachments live outside the workspace, so an
 *   agent that refuses external paths sees the name and URI only.
 */
export const toAcpAttachmentContentBlocks = (input: {
  readonly provider: ProviderDriverKind;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
  readonly promptCapabilities: EffectAcpSchema.PromptCapabilities | undefined;
  readonly fileSystem: FileSystem.FileSystem;
}): Effect.Effect<ReadonlyArray<EffectAcpSchema.ContentBlock>, ProviderAdapterRequestError> =>
  Effect.gen(function* () {
    const attachments = input.attachments ?? [];
    if (attachments.length === 0) {
      return [];
    }

    const fileSystem = input.fileSystem;
    const supportsEmbeddedContext = input.promptCapabilities?.embeddedContext === true;
    const blocks: Array<EffectAcpSchema.ContentBlock> = [];

    for (const attachment of attachments) {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: input.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new ProviderAdapterRequestError({
          provider: input.provider,
          method: PROMPT_METHOD,
          detail: `Invalid attachment id '${attachment.id}'.`,
        });
      }

      const readBytes = fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: input.provider,
              method: PROMPT_METHOD,
              detail: cause.message,
              cause,
            }),
        ),
      );

      if (attachment.type === "image") {
        const bytes = yield* readBytes;
        blocks.push({
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: attachment.mimeType,
        });
        continue;
      }

      const uri = NodeURL.pathToFileURL(attachmentPath).href;

      if (!supportsEmbeddedContext) {
        const exists = yield* fileSystem
          .exists(attachmentPath)
          .pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          return yield* new ProviderAdapterRequestError({
            provider: input.provider,
            method: PROMPT_METHOD,
            detail: `Attachment file for '${attachment.id}' is missing.`,
          });
        }
        blocks.push({
          type: "resource_link",
          name: attachment.name,
          uri,
          mimeType: attachment.mimeType,
          size: attachment.sizeBytes,
        });
        continue;
      }

      const bytes = yield* readBytes;
      blocks.push({
        type: "resource",
        resource: isTextLikeAttachmentMimeType(attachment.mimeType)
          ? { uri, mimeType: attachment.mimeType, text: new TextDecoder().decode(bytes) }
          : { uri, mimeType: attachment.mimeType, blob: Buffer.from(bytes).toString("base64") },
      });
    }

    return blocks;
  });
