/**
 * childThreadTranscript - the drawer transcript of a thread-backed subagent.
 *
 * A thread-backed child runs in its own thread with its own provider session,
 * so the parent hears nothing about its work. `childMirror.ts` mirrors the
 * child's *lifecycle* onto the parent — started, progress, completed — and
 * nothing else, which is all the parent-side subagent activity query can serve.
 * The child's real transcript, its assistant turns and its tool calls, only
 * ever exists on the child thread.
 *
 * So the drawer reads that thread directly and builds rows the same way the
 * main chat does: `deriveWorkLogEntries` over the activities, merged with the
 * messages by timestamp. Proposed plans are dropped — the drawer has no plan
 * affordance, and a plan card there would offer actions it cannot run.
 *
 * @module chat/childThreadTranscript
 */
import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  deriveTimelineEntries,
  deriveWorkLogEntries,
  workLogEntryIsToolLike,
  type TimelineEntry,
} from "../../session-logic";

/** One drawer row: a message the child exchanged, or a step it took. */
export type ChildThreadTranscriptRow = Extract<TimelineEntry, { kind: "message" | "work" }>;

export interface ChildThreadTranscript {
  readonly rows: ReadonlyArray<ChildThreadTranscriptRow>;
  /** Tool-like work rows only, for the drawer's "N tool calls" meta line. */
  readonly toolCount: number;
}

const EMPTY_TRANSCRIPT: ChildThreadTranscript = { rows: [], toolCount: 0 };

export function buildChildThreadTranscript(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}): ChildThreadTranscript {
  if (input.messages.length === 0 && input.activities.length === 0) return EMPTY_TRANSCRIPT;

  const workEntries = deriveWorkLogEntries(input.activities);
  const rows = deriveTimelineEntries(input.messages, [], workEntries).filter(
    (row): row is ChildThreadTranscriptRow => row.kind !== "proposed-plan",
  );
  return { rows, toolCount: workEntries.filter(workLogEntryIsToolLike).length };
}
