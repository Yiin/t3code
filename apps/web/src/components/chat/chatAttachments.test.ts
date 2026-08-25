import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attachmentExtensionLabel,
  attachmentUploadPercent,
  composerAttachmentKind,
  formatAttachmentSize,
  formatAttachmentUploadProgress,
  screenComposerAttachment,
  screenComposerAttachments,
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
    const result = screen({ name: "big.pdf", type: "application/pdf", size: 101 * 1024 * 1024 });
    expect(result.outcome).toBe("reject");
    if (result.outcome !== "reject") return;
    expect(result.message).toContain("100MB");
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

describe("attachmentUploadPercent", () => {
  it("rounds to a whole percent", () => {
    expect(attachmentUploadPercent({ loaded: 1, total: 3 })).toBe(33);
    expect(attachmentUploadPercent({ loaded: 0, total: 100 })).toBe(0);
    expect(attachmentUploadPercent({ loaded: 100, total: 100 })).toBe(100);
  });

  it("clamps to [0, 100] and treats a zero or non-finite total as 0%", () => {
    expect(attachmentUploadPercent({ loaded: 150, total: 100 })).toBe(100);
    expect(attachmentUploadPercent({ loaded: 5, total: 0 })).toBe(0);
    expect(attachmentUploadPercent({ loaded: 5, total: Number.NaN })).toBe(0);
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

describe("screenComposerAttachment with an unnamed driver", () => {
  it("takes a file, because refusing it on a guess is worse", () => {
    // An unknown driver refuses files; a null driver means we do not know one
    // yet, and the driver's own encoder gets the last word instead.
    expect(
      screen({ name: "rows.csv", type: "text/csv", size: 2_048 }, { driver: UNKNOWN }),
    ).toEqual({
      outcome: "reject",
      message: "Claude Code cannot take file attachments, so 'rows.csv' was not attached.",
    });
    expect(
      screenComposerAttachment({
        file: { name: "rows.csv", type: "text/csv", size: 2_048 },
        driver: null,
        providerLabel: "This subagent's provider",
        attachedCount: 0,
      }),
    ).toEqual({ outcome: "accept", kind: "file" });
  });

  it("still enforces the size and count limits", () => {
    const result = screenComposerAttachment({
      file: { name: "huge.bin", type: "application/octet-stream", size: 1_024 * 1_024 * 1_024 },
      driver: null,
      providerLabel: "This subagent's provider",
      attachedCount: 0,
    });
    expect(result.outcome).toBe("reject");
  });
});

describe("screenComposerAttachments", () => {
  it("keeps the good files when one is refused", () => {
    const result = screenComposerAttachments(
      [
        { name: "rows.csv", type: "text/csv", size: 2_048 },
        { name: "huge.bin", type: "application/octet-stream", size: 1_024 * 1_024 * 1_024 },
        { name: "shot.png", type: "image/png", size: 1_024 },
      ],
      { driver: CLAUDE, providerLabel: "Claude Code", attachedCount: 0 },
    );
    expect(result.accepted.map(({ file, kind }) => [file.name, kind])).toEqual([
      ["rows.csv", "file"],
      ["shot.png", "image"],
    ]);
    expect(result.error).toContain("huge.bin");
  });

  it("stops at the per-message cap and counts what is already staged", () => {
    const files = Array.from({ length: 4 }, (_unused, index) => ({
      name: `note-${index}.txt`,
      type: "text/plain",
      size: 16,
    }));
    const result = screenComposerAttachments(files, {
      driver: CODEX,
      providerLabel: "Codex",
      attachedCount: 6,
    });
    expect(result.accepted).toHaveLength(2);
    expect(result.error).toBe("You can attach up to 8 files per message.");
  });
});

describe("formatAttachmentUploadProgress", () => {
  it("shows both halves in the total's unit", () => {
    expect(
      formatAttachmentUploadProgress({ loaded: 1.3 * 1024 * 1024, total: 3.1 * 1024 * 1024 }),
    ).toBe("42% · 1.3 / 3.1 MB");
  });

  it("rounds bytes to whole numbers", () => {
    expect(formatAttachmentUploadProgress({ loaded: 512, total: 1000 })).toBe("51% · 512 / 1000 B");
  });

  it("falls back to the percent alone when the total is unknown", () => {
    expect(formatAttachmentUploadProgress({ loaded: 0, total: 0 })).toBe("0%");
  });
});
