import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  BeadsEpicSummary,
  BeadsIssueSummary,
  EpicRunPreflightError,
  EpicRunPreflightInput,
  EpicRunPreflightResult,
} from "./beads.ts";
import { WS_METHODS, WsEpicRunPreflightRpc } from "./rpc.ts";

const encodeInput = Schema.encodeSync(EpicRunPreflightInput);
const decodeInput = Schema.decodeUnknownSync(EpicRunPreflightInput);
const encodeResult = Schema.encodeSync(EpicRunPreflightResult);
const decodeResult = Schema.decodeUnknownSync(EpicRunPreflightResult);
const decodeError = Schema.decodeUnknownSync(EpicRunPreflightError);
const decodeIssue = Schema.decodeUnknownSync(BeadsIssueSummary);
const decodeEpic = Schema.decodeUnknownSync(BeadsEpicSummary);
const encodeEpic = Schema.encodeSync(BeadsEpicSummary);

describe("beads timestamps", () => {
  it("decodes a payload from a server that predates the timestamp fields", () => {
    expect(
      decodeIssue({
        id: "t3code-j8s.2",
        title: "Carry issue timestamps",
        status: "open",
        issueType: "task",
        priority: 1,
        assignee: null,
        parent: "t3code-j8s",
        blockedBy: [],
        isReady: true,
      }),
    ).toMatchObject({ createdAt: null, updatedAt: null });

    expect(
      decodeEpic({
        id: "t3code-j8s",
        title: "Rethink the Epics page",
        status: "open",
        childCounts: { total: 13, ready: 1, byStatus: { open: 10, closed: 3 } },
      }),
    ).toMatchObject({ createdAt: null, updatedAt: null, lastActivityAt: null });
  });

  it("round-trips the recency the Epics page orders on", () => {
    const epic = {
      id: "t3code-j8s",
      title: "Rethink the Epics page",
      status: "open",
      childCounts: { total: 1, ready: 0, byStatus: { closed: 1 } },
      createdAt: "2026-08-03T06:00:00.000Z",
      updatedAt: "2026-08-03T06:23:04.000Z",
      lastActivityAt: "2026-08-03T09:41:12.000Z",
    };

    expect(decodeEpic(encodeEpic(epic))).toEqual(epic);
  });
});

describe("EpicRunPreflightInput", () => {
  it("round-trips a typed preflight request", () => {
    const input = {
      workspaceRoot: "/repo",
      epicId: "t3code-vst",
      mode: "parallel" as const,
    };

    const encoded = encodeInput(input);

    expect(decodeInput(encoded)).toEqual(input);
  });
});

describe("EpicRunPreflightResult", () => {
  it("round-trips blockers and warnings with their reason-specific details", () => {
    const result = {
      ok: false,
      blockers: [
        { _tag: "dirty_tree" as const, paths: ["src/changed.ts"] },
        {
          _tag: "run_in_progress" as const,
          owner: "cook-epic",
          runDir: "/repo/.worktrees/cook-epic-123",
          host: "devbox",
          pid: 1234,
        },
      ],
      warnings: [
        { _tag: "stale_claims" as const, childIds: ["t3code-vst.1"] },
        { _tag: "nothing_ready" as const, epicId: "t3code-vst" },
      ],
    };

    const encoded = encodeResult(result);

    expect(decodeResult(encoded)).toEqual(result);
  });

  it("rejects malformed reason-specific details", () => {
    expect(() =>
      decodeResult({
        ok: false,
        blockers: [{ _tag: "run_in_progress", owner: "cook-epic" }],
        warnings: [],
      }),
    ).toThrow();
  });
});

describe("WsEpicRunPreflightRpc", () => {
  it("registers the public method and typed error schema", () => {
    expect(WS_METHODS.epicRunPreflight).toBe("epicRunPreflight");
    expect(WsEpicRunPreflightRpc).toBeDefined();

    const error = new EpicRunPreflightError({ message: "bd failed" });
    expect(decodeError(error)).toEqual(error);
  });
});
