import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import type { ChatAttachment } from "@t3tools/contracts";

/** Directory the mirror owns inside a workspace. */
export const WORKSPACE_MIRROR_ROOT_DIR = ".t3code";
/** Directory holding one subdirectory per session inside the mirror root. */
export const WORKSPACE_MIRROR_ATTACHMENTS_DIR = "attachments";

/** Keeps the copies out of the user's git status without a repo-level edit. */
const MIRROR_GITIGNORE_CONTENTS = "*\n";

const MAX_SEGMENT_CHARS = 80;
const MAX_FILE_NAME_CHARS = 120;

/**
 * Reduces an arbitrary id to one safe path segment. Cursor compares canonical
 * paths, so a segment must never contain a separator or a `..`. Dots are not
 * in the allowed set, which rules both out.
 */
export function toWorkspaceMirrorSegment(value: string, fallback: string): string {
  const segment = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SEGMENT_CHARS)
    .replace(/-+$/g, "");
  return segment.length === 0 ? fallback : segment;
}

/**
 * Keeps the attachment's own file name, so the agent sees what the human
 * attached rather than an opaque id. A dot survives here because the extension
 * is what tells the agent how to read the file; `..` does not.
 */
export function toWorkspaceMirrorFileName(attachment: ChatAttachment): string {
  const base = (attachment.name.split(/[/\\]/).pop() ?? "").slice(-MAX_FILE_NAME_CHARS);
  const fileName = base
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return fileName.length === 0 ? toWorkspaceMirrorSegment(attachment.id, "attachment") : fileName;
}

export interface WorkspaceAttachmentMirror {
  /**
   * Copies one attachment into the workspace and returns the copy's absolute
   * path. Cursor drops the content of a resource whose uri sits outside the
   * project root, so the copy is what makes the file readable at all.
   */
  readonly materialize: (input: {
    readonly promptKey: string;
    readonly attachment: ChatAttachment;
    readonly sourcePath: string;
  }) => Effect.Effect<string, PlatformError.PlatformError>;
  /** Drops one prompt's copies once that prompt has settled. */
  readonly releasePrompt: (promptKey: string) => Effect.Effect<void>;
  /** Drops the whole session directory, and the mirror root when it empties. */
  readonly releaseSession: Effect.Effect<void>;
}

/**
 * Materializes chat attachments inside a workspace for the lifetime of one
 * prompt.
 *
 * Only Cursor needs this. It advertises no `embeddedContext` and drops the
 * content of any `resource_link` whose uri is outside the project root, so an
 * attachment under the state directory reaches the model as a name and a uri
 * only. Grok and Kimi read an external absolute path fine.
 *
 * The copies are real files, never symlinks: Cursor canonicalizes the path
 * before it compares it against the root, so a link would resolve straight
 * back outside the workspace.
 */
export function makeWorkspaceAttachmentMirror(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workspaceRoot: string;
  readonly sessionKey: string;
}): WorkspaceAttachmentMirror {
  const { fileSystem, path } = input;
  const attachmentsRoot = path.join(
    input.workspaceRoot,
    WORKSPACE_MIRROR_ROOT_DIR,
    WORKSPACE_MIRROR_ATTACHMENTS_DIR,
  );
  const sessionDir = path.join(
    attachmentsRoot,
    toWorkspaceMirrorSegment(input.sessionKey, "session"),
  );

  let gitignoreWritten = false;
  const ensureGitignore = Effect.suspend(() => {
    if (gitignoreWritten) {
      return Effect.void;
    }
    gitignoreWritten = true;
    return fileSystem
      .writeFileString(path.join(attachmentsRoot, ".gitignore"), MIRROR_GITIGNORE_CONTENTS)
      .pipe(Effect.ignore);
  });

  const promptDir = (promptKey: string) =>
    path.join(sessionDir, toWorkspaceMirrorSegment(promptKey, "prompt"));

  const materialize: WorkspaceAttachmentMirror["materialize"] = (materializeInput) =>
    Effect.gen(function* () {
      const directory = promptDir(materializeInput.promptKey);
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* ensureGitignore;

      const fileName = toWorkspaceMirrorFileName(materializeInput.attachment);
      const preferred = path.join(directory, fileName);
      // Two attachments in one prompt can share a name; the id disambiguates
      // the second one without renaming the first.
      const taken = yield* fileSystem.exists(preferred).pipe(Effect.orElseSucceed(() => false));
      const target = taken
        ? path.join(directory, `${materializeInput.attachment.id}-${fileName}`)
        : preferred;

      yield* fileSystem.copyFile(materializeInput.sourcePath, target);
      return target;
    });

  const releasePrompt: WorkspaceAttachmentMirror["releasePrompt"] = (promptKey) =>
    fileSystem.remove(promptDir(promptKey), { recursive: true, force: true }).pipe(Effect.ignore);

  const removeWhenSpent = (directory: string, spentEntries: ReadonlyArray<string>) =>
    fileSystem.readDirectory(directory).pipe(
      Effect.flatMap((entries) =>
        entries.every((entry) => spentEntries.includes(entry))
          ? fileSystem.remove(directory, { recursive: true, force: true })
          : Effect.void,
      ),
      Effect.ignore,
    );

  const releaseSession = Effect.gen(function* () {
    yield* fileSystem.remove(sessionDir, { recursive: true, force: true }).pipe(Effect.ignore);
    // Another session on the same workspace may still own a directory here,
    // so only an otherwise empty mirror is torn down.
    yield* removeWhenSpent(attachmentsRoot, [".gitignore"]);
    yield* removeWhenSpent(path.join(input.workspaceRoot, WORKSPACE_MIRROR_ROOT_DIR), []);
  });

  return { materialize, releasePrompt, releaseSession };
}
