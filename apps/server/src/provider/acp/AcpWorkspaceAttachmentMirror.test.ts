// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { ChatAttachment } from "@t3tools/contracts";

import {
  makeWorkspaceAttachmentMirror,
  toWorkspaceMirrorFileName,
  toWorkspaceMirrorSegment,
} from "./AcpWorkspaceAttachmentMirror.ts";

const SESSION_KEY = "thread_cursor-1";
const PROMPT_KEY = "prompt-1";

const fileAttachment = (input: { readonly id: string; readonly name: string }): ChatAttachment => ({
  type: "file",
  id: input.id,
  name: input.name,
  mimeType: "text/plain",
  sizeBytes: 4,
});

const makeTempDir = (prefix: string) =>
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix)));

const makeSource = (directory: string, name: string, contents: string) =>
  Effect.promise(async () => {
    const sourcePath = NodePath.join(directory, name);
    await NodeFSP.writeFile(sourcePath, contents);
    return sourcePath;
  });

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceRoot = yield* makeTempDir("acp-mirror-workspace-");
  const attachmentsDir = yield* makeTempDir("acp-mirror-attachments-");
  const mirror = makeWorkspaceAttachmentMirror({
    fileSystem,
    path,
    workspaceRoot,
    sessionKey: SESSION_KEY,
  });
  return { fileSystem, workspaceRoot, attachmentsDir, mirror };
});

it("reduces an id to one safe path segment", () => {
  assert.equal(toWorkspaceMirrorSegment("thread/../etc", "fallback"), "thread-etc");
  assert.equal(toWorkspaceMirrorSegment("...", "fallback"), "fallback");
  assert.equal(toWorkspaceMirrorSegment("", "fallback"), "fallback");
});

it("keeps the attachment's own file name", () => {
  assert.equal(
    toWorkspaceMirrorFileName(fileAttachment({ id: "a-1", name: "report notes.md" })),
    "report-notes.md",
  );
  assert.equal(
    toWorkspaceMirrorFileName(fileAttachment({ id: "a-2", name: "../../escape.txt" })),
    "escape.txt",
  );
  assert.equal(toWorkspaceMirrorFileName(fileAttachment({ id: "a-3", name: "///" })), "a-3");
});

it.layer(NodeServices.layer)("makeWorkspaceAttachmentMirror", (it) => {
  it.effect("copies an attachment inside the workspace and keeps its name", () =>
    Effect.gen(function* () {
      const { fileSystem, workspaceRoot, attachmentsDir, mirror } = yield* setup;
      const sourcePath = yield* makeSource(attachmentsDir, "notes-1.txt", "body");

      const target = yield* mirror.materialize({
        promptKey: PROMPT_KEY,
        attachment: fileAttachment({ id: "notes-1", name: "notes.txt" }),
        sourcePath,
      });

      assert.equal(
        target,
        NodePath.join(
          workspaceRoot,
          ".t3code",
          "attachments",
          SESSION_KEY,
          PROMPT_KEY,
          "notes.txt",
        ),
      );
      assert.equal(yield* fileSystem.readFileString(target), "body");
      // The original must survive: it is the store copy every other surface reads.
      assert.isTrue(yield* fileSystem.exists(sourcePath));
    }),
  );

  it.effect("hides the copies from git", () =>
    Effect.gen(function* () {
      const { fileSystem, workspaceRoot, attachmentsDir, mirror } = yield* setup;
      const sourcePath = yield* makeSource(attachmentsDir, "notes-2.txt", "body");

      yield* mirror.materialize({
        promptKey: PROMPT_KEY,
        attachment: fileAttachment({ id: "notes-2", name: "notes.txt" }),
        sourcePath,
      });

      const gitignore = NodePath.join(workspaceRoot, ".t3code", "attachments", ".gitignore");
      assert.equal(yield* fileSystem.readFileString(gitignore), "*\n");
    }),
  );

  it.effect("disambiguates two attachments that share a name", () =>
    Effect.gen(function* () {
      const { fileSystem, attachmentsDir, mirror } = yield* setup;
      const first = yield* makeSource(attachmentsDir, "notes-3.txt", "first");
      const second = yield* makeSource(attachmentsDir, "notes-4.txt", "second");

      const firstTarget = yield* mirror.materialize({
        promptKey: PROMPT_KEY,
        attachment: fileAttachment({ id: "notes-3", name: "notes.txt" }),
        sourcePath: first,
      });
      const secondTarget = yield* mirror.materialize({
        promptKey: PROMPT_KEY,
        attachment: fileAttachment({ id: "notes-4", name: "notes.txt" }),
        sourcePath: second,
      });

      assert.notEqual(firstTarget, secondTarget);
      assert.equal(NodePath.basename(secondTarget), "notes-4-notes.txt");
      assert.equal(yield* fileSystem.readFileString(firstTarget), "first");
      assert.equal(yield* fileSystem.readFileString(secondTarget), "second");
    }),
  );

  it.effect("drops one prompt's copies and leaves the other prompt alone", () =>
    Effect.gen(function* () {
      const { fileSystem, attachmentsDir, mirror } = yield* setup;
      const sourcePath = yield* makeSource(attachmentsDir, "notes-5.txt", "body");

      const first = yield* mirror.materialize({
        promptKey: "prompt-a",
        attachment: fileAttachment({ id: "notes-5", name: "notes.txt" }),
        sourcePath,
      });
      const second = yield* mirror.materialize({
        promptKey: "prompt-b",
        attachment: fileAttachment({ id: "notes-5", name: "notes.txt" }),
        sourcePath,
      });

      yield* mirror.releasePrompt("prompt-a");

      assert.isFalse(yield* fileSystem.exists(first));
      assert.isTrue(yield* fileSystem.exists(second));
    }),
  );

  it.effect("removes the whole mirror when the session ends", () =>
    Effect.gen(function* () {
      const { fileSystem, workspaceRoot, attachmentsDir, mirror } = yield* setup;
      const sourcePath = yield* makeSource(attachmentsDir, "notes-6.txt", "body");
      yield* mirror.materialize({
        promptKey: PROMPT_KEY,
        attachment: fileAttachment({ id: "notes-6", name: "notes.txt" }),
        sourcePath,
      });

      yield* mirror.releaseSession;

      assert.isFalse(yield* fileSystem.exists(NodePath.join(workspaceRoot, ".t3code")));
    }),
  );

  it.effect("keeps another session's directory when this one ends", () =>
    Effect.gen(function* () {
      const { fileSystem, workspaceRoot, attachmentsDir, mirror } = yield* setup;
      const path = yield* Path.Path;
      const otherMirror = makeWorkspaceAttachmentMirror({
        fileSystem,
        path,
        workspaceRoot,
        sessionKey: "thread_cursor-2",
      });
      const sourcePath = yield* makeSource(attachmentsDir, "notes-7.txt", "body");
      yield* mirror.materialize({
        promptKey: PROMPT_KEY,
        attachment: fileAttachment({ id: "notes-7", name: "notes.txt" }),
        sourcePath,
      });
      const otherTarget = yield* otherMirror.materialize({
        promptKey: PROMPT_KEY,
        attachment: fileAttachment({ id: "notes-7", name: "notes.txt" }),
        sourcePath,
      });

      yield* mirror.releaseSession;

      assert.isTrue(yield* fileSystem.exists(otherTarget));
    }),
  );

  it.effect("releasing a session that never materialized anything is a no-op", () =>
    Effect.gen(function* () {
      const { fileSystem, workspaceRoot, mirror } = yield* setup;

      yield* mirror.releaseSession;
      yield* mirror.releasePrompt(PROMPT_KEY);

      assert.isTrue(yield* fileSystem.exists(workspaceRoot));
    }),
  );

  it.effect("fails when the source file is gone", () =>
    Effect.gen(function* () {
      const { attachmentsDir, mirror } = yield* setup;

      const error = yield* Effect.flip(
        mirror.materialize({
          promptKey: PROMPT_KEY,
          attachment: fileAttachment({ id: "gone-1", name: "gone.txt" }),
          sourcePath: NodePath.join(attachmentsDir, "gone-1.txt"),
        }),
      );

      assert.isDefined(error.message);
    }),
  );
});
