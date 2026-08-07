// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  comparatorSafetyViolations,
  compareTranscripts,
  normalizeCoreMailbox,
  normalizeLegacyMailbox,
  requireTranscriptEpic,
} from "./epic-shadow-compare.ts";

describe("epic shadow transcript adapters", () => {
  it("normalizes the terminal and core happy path to the same structure", () => {
    const terminal = normalizeLegacyMailbox(
      [
        { event: "dispatched", child: "epic.1", pushed: false, verified: true },
        { event: "done", child: "epic.1", summary: "terminal", pushed: false, verified: true },
        { event: "finished", reason: "complete", pushed: false, verified: true },
      ],
      "epic",
    );
    const core = normalizeCoreMailbox(
      [
        {
          type: "iteration-state-changed",
          iteration: {
            issueId: "epic.1",
            iterationIndex: 0,
            turnStatus: "running",
            summary: null,
            why: null,
            failureReason: null,
          },
        },
        {
          type: "iteration-state-changed",
          iteration: {
            issueId: "epic.1",
            iterationIndex: 0,
            turnStatus: "completed",
            summary: "core",
            why: null,
            failureReason: null,
          },
        },
        { type: "run-state-changed", run: { status: "done", lastError: null } },
      ],
      "epic",
    );
    const comparison = compareTranscripts(terminal, core);
    expect(comparison.structural).toEqual([]);
    expect(comparison.content).toHaveLength(1);
  });

  it("detects one injected structural policy difference", () => {
    const terminal = normalizeLegacyMailbox(
      [
        { event: "dispatched", child: "epic.1", pushed: false, verified: true },
        { event: "blocked", child: "epic.1", pushed: false, verified: true },
      ],
      "epic",
    );
    const core = normalizeLegacyMailbox(
      [
        { event: "dispatched", child: "epic.1", pushed: false, verified: true },
        { event: "retry", child: "epic.1", pushed: false, verified: true },
      ],
      "epic",
    );
    expect(compareTranscripts(terminal, core).structural).toMatchObject([
      { index: 1, kind: "structural", left: { _tag: "blocked" }, right: { _tag: "retry" } },
    ]);
  });

  it("normalizes the final failed core attempt as blocked", () => {
    const core = normalizeCoreMailbox(
      [
        {
          type: "iteration-state-changed",
          iteration: { issueId: "epic.1", iterationIndex: 0, turnStatus: "failed" },
        },
        {
          type: "iteration-state-changed",
          iteration: { issueId: "epic.1", iterationIndex: 1, turnStatus: "failed" },
        },
      ],
      "epic",
      { blockedIssueIds: new Set(["epic.1"]) },
    );
    expect(core.map((event) => event._tag)).toEqual(["retry", "blocked"]);
  });

  it("matches equivalent terminal and core blocked paths", () => {
    const terminal = normalizeLegacyMailbox(
      [
        { event: "dispatched", child: "epic.1" },
        { event: "blocked", child: "epic.1", reason: "attempt limit", attempts: 2, max: 2 },
      ],
      "epic",
    );
    const core = normalizeCoreMailbox(
      [
        {
          type: "iteration-state-changed",
          iteration: { issueId: "epic.1", iterationIndex: 0, turnStatus: "running" },
        },
        {
          type: "iteration-state-changed",
          iteration: {
            issueId: "epic.1",
            iterationIndex: 0,
            turnStatus: "failed",
            failureReason: "child:protocol-error",
          },
        },
      ],
      "epic",
      { blockedIssueIds: new Set(["epic.1"]) },
    );
    expect(compareTranscripts(terminal, core).structural).toEqual([]);
  });

  it("rejects a transcript for another epic", () => {
    const events = normalizeLegacyMailbox(
      [{ event: "done", child: "other.1", pushed: false, verified: true }],
      "other",
    );
    expect(() => requireTranscriptEpic(events, "epic", "terminal")).toThrow(
      "terminal transcript contains epic other; expected epic.",
    );
  });

  it("rejects an empty transcript", () => {
    expect(() => requireTranscriptEpic([], "epic", "core")).toThrow(
      "core transcript is empty; expected events for epic epic.",
    );
  });
});

describe("comparator safety", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "epic-shadow-safety-"));
  const databasePath = NodePath.join(root, ".beads", "embeddeddolt");
  NodeFS.mkdirSync(databasePath, { recursive: true });

  it("accepts a clean throwaway branch with local embedded Beads", () => {
    expect(
      comparatorSafetyViolations({
        dirtyPaths: [],
        branch: "shadow-check",
        defaultBranches: ["main"],
        repoRoot: root,
        databasePath,
        doltHost: null,
        siblingCount: 0,
        standaloneGitDirectory: true,
      }),
    ).toEqual([]);
  });

  it("refuses dirty, default, shared, external, and sibling state", () => {
    expect(
      comparatorSafetyViolations({
        dirtyPaths: ["dirty.ts"],
        branch: "main",
        defaultBranches: ["main"],
        repoRoot: root,
        databasePath: NodePath.join(NodeOS.tmpdir(), "external-beads"),
        doltHost: "100.107.50.39",
        siblingCount: 1,
        standaloneGitDirectory: false,
      }),
    ).toEqual([
      "The repository is not clean.",
      "Branch main is a default branch.",
      "The Beads database is not isolated inside --cwd/.beads.",
      "Beads uses the shared Dolt host 100.107.50.39.",
      "Sibling repositories are not isolated by this comparator.",
      "Linked Git worktrees are not isolated by this comparator.",
    ]);
  });
});
