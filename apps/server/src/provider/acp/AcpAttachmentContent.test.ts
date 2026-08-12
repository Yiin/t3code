// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as EffectAcpSchema from "effect-acp/schema";

import { type ChatAttachment, ProviderDriverKind } from "@t3tools/contracts";

import { ProviderAdapterRequestError } from "../Errors.ts";
import { toAcpAttachmentContentBlocks } from "./AcpAttachmentContent.ts";

const PROVIDER = ProviderDriverKind.make("kimi");

const EMBEDDED_CONTEXT: EffectAcpSchema.PromptCapabilities = { image: true, embeddedContext: true };
const NO_EMBEDDED_CONTEXT: EffectAcpSchema.PromptCapabilities = {
  image: true,
  embeddedContext: false,
};

const makeAttachmentsDir = Effect.promise(() =>
  NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-attachment-content-")),
);

const writeAttachment = (attachmentsDir: string, relativePath: string, contents: Uint8Array) =>
  Effect.promise(() => NodeFSP.writeFile(NodePath.join(attachmentsDir, relativePath), contents));

const encode = (input: {
  readonly attachmentsDir: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly promptCapabilities: EffectAcpSchema.PromptCapabilities | undefined;
  readonly materializeLinkTarget?: (linkInput: {
    readonly attachment: ChatAttachment;
    readonly sourcePath: string;
  }) => Effect.Effect<string, ProviderAdapterRequestError>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* toAcpAttachmentContentBlocks({
      provider: PROVIDER,
      attachments: input.attachments,
      attachmentsDir: input.attachmentsDir,
      promptCapabilities: input.promptCapabilities,
      fileSystem,
      materializeLinkTarget: input.materializeLinkTarget,
    });
  });

it.layer(NodeServices.layer)("toAcpAttachmentContentBlocks", (it) => {
  it.effect("encodes an image as an ACP image block", () =>
    Effect.gen(function* () {
      const attachmentsDir = yield* makeAttachmentsDir;
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      yield* writeAttachment(attachmentsDir, "shot-1.png", bytes);

      const blocks = yield* encode({
        attachmentsDir,
        attachments: [
          {
            type: "image",
            id: "shot-1",
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: bytes.byteLength,
          },
        ],
        promptCapabilities: EMBEDDED_CONTEXT,
      });

      assert.deepEqual(blocks, [
        {
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: "image/png",
        },
      ]);
    }),
  );

  it.effect("embeds a text file as a resource with its contents", () =>
    Effect.gen(function* () {
      const attachmentsDir = yield* makeAttachmentsDir;
      const text = "attachment probe ACP_TEXT_RESOURCE\n";
      yield* writeAttachment(attachmentsDir, "notes-1.txt", new TextEncoder().encode(text));

      const blocks = yield* encode({
        attachmentsDir,
        attachments: [
          {
            type: "file",
            id: "notes-1",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: text.length,
          },
        ],
        promptCapabilities: EMBEDDED_CONTEXT,
      });

      assert.deepEqual(blocks, [
        {
          type: "resource",
          resource: {
            uri: NodeURL.pathToFileURL(NodePath.join(attachmentsDir, "notes-1.txt")).href,
            mimeType: "text/plain",
            text,
          },
        },
      ]);
    }),
  );

  it.effect("embeds a binary file as a base64 blob resource", () =>
    Effect.gen(function* () {
      const attachmentsDir = yield* makeAttachmentsDir;
      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
      yield* writeAttachment(attachmentsDir, "doc-1.pdf", bytes);

      const blocks = yield* encode({
        attachmentsDir,
        attachments: [
          {
            type: "file",
            id: "doc-1",
            name: "doc.pdf",
            mimeType: "application/pdf",
            sizeBytes: bytes.byteLength,
          },
        ],
        promptCapabilities: EMBEDDED_CONTEXT,
      });

      assert.deepEqual(blocks, [
        {
          type: "resource",
          resource: {
            uri: NodeURL.pathToFileURL(NodePath.join(attachmentsDir, "doc-1.pdf")).href,
            mimeType: "application/pdf",
            blob: Buffer.from(bytes).toString("base64"),
          },
        },
      ]);
    }),
  );

  it.effect("links a file when the agent does not advertise embedded context", () =>
    Effect.gen(function* () {
      const attachmentsDir = yield* makeAttachmentsDir;
      const text = "linked only";
      yield* writeAttachment(attachmentsDir, "notes-2.txt", new TextEncoder().encode(text));

      const blocks = yield* encode({
        attachmentsDir,
        attachments: [
          {
            type: "file",
            id: "notes-2",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: text.length,
          },
        ],
        promptCapabilities: NO_EMBEDDED_CONTEXT,
      });

      assert.deepEqual(blocks, [
        {
          type: "resource_link",
          name: "notes.txt",
          uri: NodeURL.pathToFileURL(NodePath.join(attachmentsDir, "notes-2.txt")).href,
          mimeType: "text/plain",
          size: text.length,
        },
      ]);
    }),
  );

  it.effect("links a file when the agent advertises no prompt capabilities at all", () =>
    Effect.gen(function* () {
      const attachmentsDir = yield* makeAttachmentsDir;
      const text = "no capabilities";
      yield* writeAttachment(attachmentsDir, "notes-3.txt", new TextEncoder().encode(text));

      const blocks = yield* encode({
        attachmentsDir,
        attachments: [
          {
            type: "file",
            id: "notes-3",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: text.length,
          },
        ],
        promptCapabilities: undefined,
      });

      assert.equal(blocks[0]?.type, "resource_link");
    }),
  );

  it.effect("fails the prompt when an attachment id does not resolve to a path", () =>
    Effect.gen(function* () {
      const attachmentsDir = yield* makeAttachmentsDir;

      const error = yield* Effect.flip(
        encode({
          attachmentsDir,
          attachments: [
            {
              type: "file",
              id: "..",
              name: "escape.txt",
              mimeType: "text/plain",
              sizeBytes: 4,
            },
          ],
          promptCapabilities: EMBEDDED_CONTEXT,
        }),
      );

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(error.method, "session/prompt");
      assert.include(error.detail, "Invalid attachment id");
    }),
  );

  it.effect("fails the prompt when a linked attachment file is missing on disk", () =>
    Effect.gen(function* () {
      const attachmentsDir = yield* makeAttachmentsDir;

      const error = yield* Effect.flip(
        encode({
          attachmentsDir,
          attachments: [
            {
              type: "file",
              id: "gone-1",
              name: "gone.txt",
              mimeType: "text/plain",
              sizeBytes: 4,
            },
          ],
          promptCapabilities: NO_EMBEDDED_CONTEXT,
        }),
      );

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.include(error.detail, "is missing");
    }),
  );

  it.effect("links the materialized copy when the adapter supplies one", () =>
    Effect.gen(function* () {
      const attachmentsDir = yield* makeAttachmentsDir;
      const text = "materialized";
      yield* writeAttachment(attachmentsDir, "notes-5.txt", new TextEncoder().encode(text));
      const workspaceCopy = NodePath.join(attachmentsDir, "workspace-copy.txt");
      const seen: Array<string> = [];

      const blocks = yield* encode({
        attachmentsDir,
        attachments: [
          {
            type: "file",
            id: "notes-5",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: text.length,
          },
        ],
        promptCapabilities: NO_EMBEDDED_CONTEXT,
        materializeLinkTarget: ({ sourcePath }) => {
          seen.push(sourcePath);
          return Effect.succeed(workspaceCopy);
        },
      });

      assert.deepEqual(seen, [NodePath.join(attachmentsDir, "notes-5.txt")]);
      assert.deepEqual(blocks, [
        {
          type: "resource_link",
          name: "notes.txt",
          uri: NodeURL.pathToFileURL(workspaceCopy).href,
          mimeType: "text/plain",
          size: text.length,
        },
      ]);
    }),
  );

  it.effect("never materializes a copy for an embedded resource", () =>
    Effect.gen(function* () {
      const attachmentsDir = yield* makeAttachmentsDir;
      yield* writeAttachment(attachmentsDir, "notes-6.txt", new TextEncoder().encode("embedded"));
      let calls = 0;

      yield* encode({
        attachmentsDir,
        attachments: [
          {
            type: "file",
            id: "notes-6",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 8,
          },
        ],
        promptCapabilities: EMBEDDED_CONTEXT,
        materializeLinkTarget: ({ sourcePath }) => {
          calls += 1;
          return Effect.succeed(sourcePath);
        },
      });

      assert.equal(calls, 0);
    }),
  );

  it.effect("fails the prompt when materializing the copy fails", () =>
    Effect.gen(function* () {
      const attachmentsDir = yield* makeAttachmentsDir;
      yield* writeAttachment(attachmentsDir, "notes-7.txt", new TextEncoder().encode("nope"));

      const error = yield* Effect.flip(
        encode({
          attachmentsDir,
          attachments: [
            {
              type: "file",
              id: "notes-7",
              name: "notes.txt",
              mimeType: "text/plain",
              sizeBytes: 4,
            },
          ],
          promptCapabilities: NO_EMBEDDED_CONTEXT,
          materializeLinkTarget: () =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: "workspace is read-only",
              }),
            ),
        }),
      );

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.include(error.detail, "workspace is read-only");
    }),
  );

  it.effect("keeps every attachment in the order it was sent", () =>
    Effect.gen(function* () {
      const attachmentsDir = yield* makeAttachmentsDir;
      yield* writeAttachment(attachmentsDir, "shot-2.png", new Uint8Array([1, 2, 3]));
      yield* writeAttachment(attachmentsDir, "notes-4.txt", new TextEncoder().encode("second"));

      const blocks = yield* encode({
        attachmentsDir,
        attachments: [
          {
            type: "image",
            id: "shot-2",
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
          {
            type: "file",
            id: "notes-4",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 6,
          },
        ],
        promptCapabilities: EMBEDDED_CONTEXT,
      });

      assert.deepEqual(
        blocks.map((block) => block.type),
        ["image", "resource"],
      );
    }),
  );
});
