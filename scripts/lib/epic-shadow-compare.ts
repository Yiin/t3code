// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";

import {
  classifyTranscriptDivergences,
  EPIC_RUN_TRANSCRIPT_TAGS,
  EpicRunTranscriptEvent,
  type EpicRunTranscriptDivergence,
  type EpicRunTranscriptEvent as TranscriptEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeEvent = Schema.decodeUnknownSync(EpicRunTranscriptEvent);
const transcriptTags = new Set<string>(EPIC_RUN_TRANSCRIPT_TAGS);

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const parseJsonLines = (text: string): ReadonlyArray<unknown> => {
  const values: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (start < 0) {
      if (/\s/u.test(character)) continue;
      start = index;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") depth -= 1;
    if (depth !== 0 || inString) continue;
    const encoded = text.slice(start, index + 1);
    try {
      values.push(JSON.parse(encoded) as unknown);
    } catch (cause) {
      throw new Error(`Invalid JSON stream value: ${encoded.slice(0, 200)}`, { cause });
    }
    start = -1;
  }
  if (start >= 0 || depth !== 0 || inString) throw new Error("Truncated JSON stream.");
  return values;
};

export const readTranscriptFile = (path: string): ReadonlyArray<TranscriptEvent> =>
  parseJsonLines(NodeFS.readFileSync(path, "utf8")).map((value) => decodeEvent(value));

export const requireTranscriptEpic = (
  events: ReadonlyArray<TranscriptEvent>,
  epicId: string,
  adapter: string,
): ReadonlyArray<TranscriptEvent> => {
  if (events.length === 0) {
    throw new Error(`${adapter} transcript is empty; expected events for epic ${epicId}.`);
  }
  const unexpected = events.find((event) => event.epicId !== epicId);
  if (unexpected !== undefined) {
    throw new Error(
      `${adapter} transcript contains epic ${unexpected.epicId}; expected ${epicId}.`,
    );
  }
  return events;
};

export const normalizeLegacyMailbox = (
  values: ReadonlyArray<unknown>,
  epicId: string,
  options: { readonly subagentLivenessUnavailable?: boolean } = {},
): ReadonlyArray<TranscriptEvent> => {
  let iteration = -1;
  let activeIteration: number | null = null;
  const events = values.flatMap((value, sequence) => {
    const input = record(value);
    const tag = string(input?.event);
    if (input === null || tag === undefined || !transcriptTags.has(tag)) return [];
    if (tag === "dispatched") {
      iteration += 1;
      activeIteration = iteration;
    }
    const child = string(input.child) ?? null;
    const reason = string(input.reason);
    const summary = string(input.summary);
    const why = string(input.why);
    const attempts = number(input.attempts) ?? number(input.attempt);
    const maxAttempts = number(input.max);
    const comments = number(input.comments);
    const policyBoundary = tag === "blocked" || tag === "retry";
    const event = decodeEvent({
      _tag: tag,
      sequence,
      epicId,
      issueId: child,
      iterationIndex: child === null ? null : activeIteration,
      ...(tag === "finished" ? { status: input.fatal === true ? "failed" : "done" } : {}),
      ...(reason === undefined || tag === "finished" || policyBoundary ? {} : { reason }),
      ...(summary === undefined ? {} : { summary }),
      ...(why === undefined ? {} : { why }),
      ...(attempts === undefined || policyBoundary ? {} : { attempts }),
      ...(maxAttempts === undefined || policyBoundary ? {} : { maxAttempts }),
      ...(comments === undefined || policyBoundary ? {} : { comments }),
    });
    return tag === "dispatched" && options.subagentLivenessUnavailable
      ? [
          event,
          decodeEvent({
            _tag: "subagent-liveness-unavailable",
            sequence,
            epicId,
            issueId: null,
            iterationIndex: activeIteration,
          }),
        ]
      : [event];
  });
  return events.map((event, sequence) => ({ ...event, sequence }));
};

export const normalizeCoreMailbox = (
  values: ReadonlyArray<unknown>,
  epicId: string,
  options: { readonly blockedIssueIds?: ReadonlySet<string> } = {},
): ReadonlyArray<TranscriptEvent> => {
  const output: TranscriptEvent[] = [];
  for (const [valueIndex, value] of values.entries()) {
    const input = record(value);
    const type = string(input?.type);
    if (input === null || type === undefined) continue;
    if (type === "iteration-state-changed") {
      const item = record(input.iteration);
      const turnStatus = string(item?.turnStatus);
      if (item === null || turnStatus === undefined) continue;
      const issueId = string(item.issueId) ?? null;
      const laterFailureForIssue = values.slice(valueIndex + 1).some((candidate) => {
        const candidateInput = record(candidate);
        const candidateIteration = record(candidateInput?.iteration);
        return (
          string(candidateInput?.type) === "iteration-state-changed" &&
          string(candidateIteration?.turnStatus) === "failed" &&
          string(candidateIteration?.issueId) === issueId
        );
      });
      const tag =
        turnStatus === "running"
          ? "dispatched"
          : turnStatus === "completed"
            ? "done"
            : turnStatus === "abandoned"
              ? "blocked"
              : issueId !== null &&
                  options.blockedIssueIds?.has(issueId) === true &&
                  !laterFailureForIssue
                ? "blocked"
                : "retry";
      const summary = string(item.summary);
      const why = string(item.why);
      const failureReason = string(item.failureReason);
      output.push(
        decodeEvent({
          _tag: tag,
          sequence: output.length,
          epicId,
          issueId,
          iterationIndex: number(item.iterationIndex) ?? null,
          ...(summary === undefined ? {} : { summary }),
          ...(why === undefined ? {} : { why }),
          ...(failureReason === undefined || tag === "blocked" || tag === "retry"
            ? {}
            : { failureReason }),
        }),
      );
      continue;
    }
    if (type === "run-state-changed") {
      const run = record(input.run);
      const status = string(run?.status);
      if (run === null || status === undefined || status === "running" || status === "paused") {
        continue;
      }
      output.push(
        decodeEvent({
          _tag: "finished",
          sequence: output.length,
          epicId,
          issueId: null,
          iterationIndex: null,
          status,
        }),
      );
      continue;
    }
    if (type === "subagent-liveness-degraded" || type === "subagent-liveness-unavailable") {
      output.push(
        decodeEvent({
          _tag: type,
          sequence: output.length,
          epicId,
          issueId: null,
          iterationIndex: number(input.iterationIndex) ?? null,
        }),
      );
    }
  }
  return output;
};

export const compareTranscripts = (
  left: ReadonlyArray<TranscriptEvent>,
  right: ReadonlyArray<TranscriptEvent>,
): {
  readonly divergences: ReadonlyArray<EpicRunTranscriptDivergence>;
  readonly structural: ReadonlyArray<EpicRunTranscriptDivergence>;
  readonly content: ReadonlyArray<EpicRunTranscriptDivergence>;
} => {
  const divergences = classifyTranscriptDivergences(left, right);
  return {
    divergences,
    structural: divergences.filter((item) => item.kind === "structural"),
    content: divergences.filter((item) => item.kind === "content"),
  };
};

export interface ComparatorSafetySnapshot {
  readonly dirtyPaths: ReadonlyArray<string>;
  readonly branch: string;
  readonly defaultBranches: ReadonlyArray<string>;
  readonly repoRoot: string;
  readonly databasePath: string;
  readonly doltHost: string | null;
  readonly siblingCount: number;
  readonly standaloneGitDirectory: boolean;
}

export const comparatorSafetyViolations = (
  input: ComparatorSafetySnapshot,
): ReadonlyArray<string> => {
  const violations: string[] = [];
  if (input.dirtyPaths.length > 0) violations.push("The repository is not clean.");
  if (input.defaultBranches.includes(input.branch)) {
    violations.push(`Branch ${input.branch} is a default branch.`);
  }
  const beadsRoot = `${NodeFS.realpathSync(input.repoRoot)}/.beads/`;
  let databasePath: string;
  try {
    databasePath = NodeFS.realpathSync(input.databasePath);
  } catch {
    databasePath = input.databasePath;
  }
  if (!`${databasePath}/`.startsWith(beadsRoot)) {
    violations.push("The Beads database is not isolated inside --cwd/.beads.");
  }
  if (input.doltHost !== null && input.doltHost.trim() !== "") {
    violations.push(`Beads uses the shared Dolt host ${input.doltHost}.`);
  }
  if (input.siblingCount > 0) {
    violations.push("Sibling repositories are not isolated by this comparator.");
  }
  if (!input.standaloneGitDirectory) {
    violations.push("Linked Git worktrees are not isolated by this comparator.");
  }
  return violations;
};
