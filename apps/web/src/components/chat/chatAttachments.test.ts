import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attachmentExtensionLabel,
  composerAttachmentKind,
  formatAttachmentSize,
  screenComposerAttachment,
} from "./chatAttachments";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");
const UNKNOWN = ProviderDriverKind.make("someFork");

function screen(
  file: { name: string; type: string; size: number },
  options: { driver?: ProviderDriverKind; attachedCount?: number } = {},
) {
  return screenComposerAttachment({
    file,
    driver: options.driver ?? CLAUDE,
    providerLabel: "Claude Code",
    attachedCount: options.attachedCount ?? 0,
  });
}

describe("composerAttachmentKind", () => {
  it("classifies by mime prefix", () => {
    expect(composerAttachmentKind("image/png")).toBe("image");
    expect(composerAttachmentKind("application/pdf")).toBe("file");
    expect(composerAttachmentKind("")).toBe("file");
  });
});

describe("screenComposerAttachment", () => {
  it("accepts an image", () => {
    expect(screen({ name: "shot.png", type: "image/png", size: 1_024 })).toEqual({
      outcome: "accept",
      kind: "image",
    });
  });

  it("accepts a file the driver takes natively", () => {
    expect(screen({ name: "report.pdf", type: "application/pdf", size: 4_096 })).toEqual({
      outcome: "accept",
      kind: "file",
    });
  });

  it("accepts a mime type outside the driver's declared list", () => {
    // Only `unsupported` refuses; the driver's encoder falls back for the rest.
    expect(screen({ name: "data.csv", type: "text/csv", size: 4_096 })).toEqual({
      outcome: "accept",
      kind: "file",
    });
  });

  it("accepts a file a path-reference driver takes", () => {
    expect(
      screen({ name: "notes.md", type: "text/markdown", size: 512 }, { driver: CODEX }),
    ).toEqual({ outcome: "accept", kind: "file" });
  });

  it("rejects a file when the driver cannot take files, naming the provider", () => {
    const result = screen(
      { name: "notes.md", type: "text/markdown", size: 512 },
      {
        driver: UNKNOWN,
      },
    );
    expect(result.outcome).toBe("reject");
    if (result.outcome !== "reject") return;
    expect(result.message).toContain("Claude Code");
    expect(result.message).toContain("notes.md");
  });

  it("still takes an image from a driver that refuses files", () => {
    expect(screen({ name: "shot.png", type: "image/png", size: 512 }, { driver: UNKNOWN })).toEqual(
      { outcome: "accept", kind: "image" },
    );
  });

  it("rejects an oversized file against the attachment limit", () => {
    const result = screen({ name: "big.pdf", type: "application/pdf", size: 11 * 1024 * 1024 });
    expect(result.outcome).toBe("reject");
    if (result.outcome !== "reject") return;
    expect(result.message).toContain("10MB");
  });

  it("stops once the message is full, and says files not images", () => {
    const result = screen(
      { name: "shot.png", type: "image/png", size: 512 },
      {
        attachedCount: 8,
      },
    );
    expect(result.outcome).toBe("stop");
    if (result.outcome !== "stop") return;
    expect(result.message).toBe("You can attach up to 8 files per message.");
  });
});

describe("formatAttachmentSize", () => {
  it("formats bytes, kilobytes and megabytes", () => {
    expect(formatAttachmentSize(512)).toBe("512 B");
    expect(formatAttachmentSize(2_048)).toBe("2 KB");
    expect(formatAttachmentSize(1_468_006)).toBe("1.4 MB");
  });
});

describe("attachmentExtensionLabel", () => {
  it("reads the trailing extension", () => {
    expect(attachmentExtensionLabel("report.pdf")).toBe("PDF");
    expect(attachmentExtensionLabel("archive.tar.gz")).toBe("GZ");
  });

  it("returns empty for a name without a usable extension", () => {
    expect(attachmentExtensionLabel("Makefile")).toBe("");
    expect(attachmentExtensionLabel(".gitignore")).toBe("");
    expect(attachmentExtensionLabel("report.")).toBe("");
  });
});
