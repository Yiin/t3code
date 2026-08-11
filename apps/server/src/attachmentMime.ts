// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import Mime from "@effect/platform-node/Mime";

const SAFE_ATTACHMENT_EXTENSION_PATTERN = /^\.[a-z0-9]{1,8}$/;

export function inferAttachmentExtension(input: {
  readonly mimeType: string;
  readonly fileName?: string;
}): string {
  const fromFileName = NodePath.extname(input.fileName?.trim() ?? "").toLowerCase();
  if (SAFE_ATTACHMENT_EXTENSION_PATTERN.test(fromFileName)) {
    return fromFileName;
  }

  const mimeExtension = Mime.getExtension(input.mimeType);
  const fromMime = mimeExtension ? `.${mimeExtension.toLowerCase()}` : "";
  if (SAFE_ATTACHMENT_EXTENSION_PATTERN.test(fromMime)) {
    return fromMime;
  }

  return ".bin";
}
