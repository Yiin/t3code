import * as Equal from "effect/Equal";
import {
  formatDuration,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type SubagentGroup,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import {
  type MessageId,
  type OrchestrationLatestTurn,
  type OrchestrationMessageOrigin,
  type OrchestrationThreadActivityTruncation,
  type OrchestrationThreadSubagentStatus,
  type TurnId,
} from "@t3tools/contracts";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;
export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
}

export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  return state?.isNearEnd ?? state?.isAtEnd;
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

export const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
export const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
export const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered, so the side gutter between them shrinks under browser zoom or a
 * narrow pane. A fixed-width hover strip would then sit on top of the message
 * text and swallow its pointer events. Cap the strip's width so it never
 * extends past the gutter into the content column; 0 disables the strip.
 */
export function resolveTimelineMinimapHitStripWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed strip remains gutter-capped so it cannot block
 * selecting message text.
 */
export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      onlyToolEntries: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      turnId: TurnId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "changed-files";
      id: string;
      createdAt: string;
      turnSummary: TurnDiffSummary;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "subagent";
      id: string;
      createdAt: string;
      group: SubagentGroup;
    }
  | {
      kind: "subagent-fleet";
      id: string;
      createdAt: string;
      total: number;
      running: number;
      completed: number;
      failed: number;
      /** Attention-first (failed, running, then finished) — see `subagentFleetDotPriority`. */
      agents: ReadonlyArray<SubagentFleetAgent>;
    }
  | {
      kind: "activities-truncated";
      id: string;
      createdAt: string;
      omittedCount: number;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      /** Groups still running, shown as "· N subagents" after the working label. */
      runningSubagentCount: number;
    };

export interface SubagentFleetAgent {
  /** Stable identity across derives (toolCallId, falling back to entryId). */
  key: string;
  /** Timeline row id of this agent's SubagentCard, for dot-click scrolling. */
  rowId: string;
  name: string;
  status: OrchestrationThreadSubagentStatus;
}

/**
 * Attention-first ordering for fleet dots: failures first,
 * then in-flight work, then finished. Subagents have no waiting states.
 */
function subagentFleetDotPriority(status: OrchestrationThreadSubagentStatus): number {
  if (status === "failed") return 0;
  if (status === "running") return 1;
  return 2;
}

/** "{total} subagents · {running} running · {done} done · {failed} failed", zero segments omitted. */
export function formatSubagentFleetSummary(counts: {
  total: number;
  running: number;
  completed: number;
  failed: number;
}): string {
  const segments = [`${counts.total} subagents`];
  if (counts.running > 0) segments.push(`${counts.running} running`);
  if (counts.completed > 0) segments.push(`${counts.completed} done`);
  if (counts.failed > 0) segments.push(`${counts.failed} failed`);
  return segments.join(" · ");
}

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

/** What an agent-authored `role: "user"` row is called in the inspector drawer. */
export const AGENT_USER_MESSAGE_AUTHOR_LABEL = "Parent";

/**
 * Who wrote a `role: "user"` row, when it was not the human.
 *
 * Two authors share that role: the human, and an agent prompting a thread it
 * drives (a parent messaging its child thread, the epic runner continuing an
 * iteration). Only the second one needs saying — an unlabelled row is the
 * human's, which is what every thread looked like before `origin` existed.
 *
 * The main timeline no longer needs this: it drops agent-authored user rows
 * entirely (`deriveMessagesTimelineRows`). The subagent inspector drawer keeps
 * them, because there the parent's prompt is the transcript.
 */
export function resolveUserMessageAuthorLabel(
  origin: OrchestrationMessageOrigin | undefined,
): string | null {
  return origin === "agent" ? AGENT_USER_MESSAGE_AUTHOR_LABEL : null;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

interface TurnFold {
  turnId: TurnId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
}

/**
 * The session's running turn is authoritative when latestTurn briefly lags or
 * regresses behind it. Otherwise, the latest turn counts as unsettled while it
 * is still running (or has not recorded a completion). This is deliberately
 * keyed on turn lifecycle rather than transient working state: right after the
 * user sends a message, the previous turn is still the "active" one until the
 * server creates the new turn, and folding must not flicker through that window.
 */
function deriveUnsettledTurnId(
  latestTurn: TimelineLatestTurn | null,
  runningTurnId: TurnId | null,
): TurnId | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return isSettled ? null : latestTurn.turnId;
}

/**
 * Settled turns fold their commentary and tool activity behind a
 * "Worked for ..." row anchored at the turn's first foldable entry; the
 * terminal assistant message stays visible below the fold.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestTurn: TimelineLatestTurn | null;
  unsettledTurnId: TurnId | null;
}): ReadonlyMap<string, TurnFold> {
  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    /**
     * The user message that kicked the turn off. Entry timestamps alone
     * undercount the duration (the first entry appears only once the
     * provider starts producing output), and a turn cut short by a steer may
     * hold a single instantaneous commentary message.
     */
    startBoundary: string | null;
  }
  const groupsByTurnId = new Map<TurnId, TurnGroup>();

  let pendingUserBoundary: string | null = null;
  for (const entry of input.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const turnId =
      entry.kind === "message" && entry.message.role === "assistant"
        ? (entry.message.turnId ?? null)
        : entry.kind === "work"
          ? (entry.entry.turnId ?? null)
          : null;
    if (!turnId) {
      continue;
    }
    let group = groupsByTurnId.get(turnId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        // Each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groupsByTurnId.set(turnId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      if (entry.message.streaming) {
        group.hasStreamingMessage = true;
      }
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [turnId, group] of groupsByTurnId) {
    if (turnId === input.unsettledTurnId) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    for (const entry of group.entries) {
      if (entry.id !== group.terminalEntry?.id) {
        hiddenEntryIds.add(entry.id);
      }
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestTurn?.turnId === turnId && input.latestTurn.state === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs =
      input.latestTurn?.turnId === turnId &&
      input.latestTurn.startedAt &&
      input.latestTurn.completedAt
        ? computeElapsedMs(input.latestTurn.startedAt, input.latestTurn.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    foldsByAnchorEntryId.set(firstEntry.id, {
      turnId,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return foldsByAnchorEntryId;
}

const ACTIVITIES_TRUNCATED_ROW_ID = "activities-truncated";

/**
 * Timeline row id of the first (oldest) running SubagentCard, for jump
 * actions living outside the list (e.g. the composer presence banner).
 * Mirrors the subagent-row mapping in `deriveMessagesTimelineRows`: a work
 * entry whose entry id anchors a running group renders as that group's card
 * under the same row id.
 */
export function resolveFirstRunningSubagentRowId(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  subagentGroups: ReadonlyArray<SubagentGroup>,
): string | null {
  const runningGroupEntryIds = new Set<string>();
  for (const group of subagentGroups) {
    if (group.status === "running") {
      runningGroupEntryIds.add(group.entryId);
    }
  }
  if (runningGroupEntryIds.size === 0) {
    return null;
  }
  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind === "work" && runningGroupEntryIds.has(timelineEntry.entry.id)) {
      return timelineEntry.id;
    }
  }
  return null;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  activitiesTruncated?: OrchestrationThreadActivityTruncation | null;
  latestTurn?: TimelineLatestTurn | null;
  runningTurnId?: TurnId | null;
  expandedTurnIds?: ReadonlySet<TurnId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  /** From `deriveSubagentGroups`; absent means no subagent grouping (plain work rows). */
  subagentGroups?: ReadonlyArray<SubagentGroup>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const turnIdByTimelineRowId = new Map<string, TurnId>();
  for (const entry of input.timelineEntries) {
    const turnId =
      entry.kind === "message"
        ? entry.message.turnId
        : entry.kind === "proposed-plan"
          ? entry.proposedPlan.turnId
          : entry.entry.turnId;
    if (turnId) {
      turnIdByTimelineRowId.set(entry.id, turnId);
    }
  }
  const turnIdsByWorkToggleRowId = new Map<string, ReadonlySet<TurnId>>();
  const turnIdByFleetRowId = new Map<string, TurnId>();
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null,
  );
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: input.timelineEntries,
    terminalAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnId,
  });
  // The server caps how many activities it returns and offers no way to fetch
  // the rest, so say so at the top of the transcript instead of letting the
  // older tool rows disappear behind messages that survived.
  const omittedActivityCount = input.activitiesTruncated?.omittedCount ?? 0;
  if (omittedActivityCount > 0) {
    nextRows.push({
      kind: "activities-truncated",
      id: ACTIVITIES_TRUNCATED_ROW_ID,
      createdAt: input.timelineEntries[0]?.createdAt ?? "",
      omittedCount: omittedActivityCount,
    });
  }

  const collapsedEntryIds = new Set<string>();
  const collapsedTurnIds = new Set<TurnId>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedTurnIds?.has(fold.turnId)) {
      collapsedTurnIds.add(fold.turnId);
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }

  // Subagent spawns replace their flat `collab_agent_tool_call` row with a
  // card; the tool rows that ran inside a subagent leave the flat stream
  // entirely (the card summarizes them, and expansion renders them later).
  const subagentGroupByEntryId = new Map<string, SubagentGroup>();
  const subagentGroupByToolCallId = new Map<string, SubagentGroup>();
  const subagentChildEntryIds = new Set<string>();
  for (const group of input.subagentGroups ?? []) {
    subagentGroupByEntryId.set(group.entryId, group);
    if (group.toolCallId !== null) {
      subagentGroupByToolCallId.set(group.toolCallId, group);
    }
    for (const child of group.children) {
      subagentChildEntryIds.add(child.id);
    }
  }
  // With 2+ subagents in the unsettled turn, one fleet summary row goes
  // directly above the turn's first subagent card. Presentation-only: the
  // cards below stay individually rendered and expandable.
  interface FleetCandidate {
    rowId: string;
    createdAt: string;
    group: SubagentGroup;
  }
  const fleetCandidates: FleetCandidate[] = [];
  if (unsettledTurnId !== null) {
    for (const timelineEntry of input.timelineEntries) {
      if (timelineEntry.kind !== "work" || timelineEntry.entry.turnId !== unsettledTurnId) {
        continue;
      }
      const group = subagentGroupByEntryId.get(timelineEntry.entry.id);
      if (group) {
        fleetCandidates.push({
          rowId: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          group,
        });
      }
    }
  }
  const firstFleetCandidate = fleetCandidates.length >= 2 ? fleetCandidates[0] : undefined;
  const fleetRow: MessagesTimelineRow | null = firstFleetCandidate
    ? {
        kind: "subagent-fleet",
        id: `subagent-fleet:${unsettledTurnId}`,
        createdAt: firstFleetCandidate.createdAt,
        total: fleetCandidates.length,
        running: fleetCandidates.filter((c) => c.group.status === "running").length,
        completed: fleetCandidates.filter((c) => c.group.status === "completed").length,
        failed: fleetCandidates.filter((c) => c.group.status === "failed").length,
        agents: fleetCandidates
          .map((candidate) => ({
            key: candidate.group.toolCallId ?? candidate.group.entryId,
            rowId: candidate.rowId,
            name: candidate.group.name,
            status: candidate.group.status,
          }))
          .sort((a, b) => subagentFleetDotPriority(a.status) - subagentFleetDotPriority(b.status)),
      }
    : null;

  const isHiddenSubagentWorkEntry = (entry: WorkLogEntry): boolean => {
    if (subagentChildEntryIds.has(entry.id)) {
      return true;
    }
    // A duplicate spawn row merged into another group (deriveSubagentGroups
    // dedupes same-toolCallId parents) must not resurface as a plain work row.
    return (
      entry.itemType === "collab_agent_tool_call" &&
      !subagentGroupByEntryId.has(entry.id) &&
      entry.toolCallId !== undefined &&
      subagentGroupByToolCallId.has(entry.toolCallId)
    );
  };

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.turnId}`,
        createdAt: turnFold.createdAt,
        turnId: turnFold.turnId,
        label: turnFold.label,
        expanded: input.expandedTurnIds?.has(turnFold.turnId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const subagentGroup = subagentGroupByEntryId.get(timelineEntry.entry.id);
      if (subagentGroup) {
        if (fleetRow !== null && timelineEntry.id === firstFleetCandidate?.rowId) {
          nextRows.push(fleetRow);
          if (unsettledTurnId !== null) {
            turnIdByFleetRowId.set(fleetRow.id, unsettledTurnId);
          }
        }
        nextRows.push({
          kind: "subagent",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          group: subagentGroup,
        });
        continue;
      }
      if (isHiddenSubagentWorkEntry(timelineEntry.entry)) {
        continue;
      }

      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id) ||
          subagentGroupByEntryId.has(nextEntry.entry.id)
        ) {
          break;
        }
        if (isHiddenSubagentWorkEntry(nextEntry.entry)) {
          cursor += 1;
          continue;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = groupedEntries.filter(
        (entry) => !workEntryIndicatesToolNeutralStatus(entry),
      );
      if (visibleGroupedEntries.length > 0) {
        if (visibleGroupedEntries.length <= MAX_VISIBLE_WORK_LOG_ENTRIES) {
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
          });
        } else {
          const groupId = `work-group:${timelineEntry.id}`;
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const hiddenEntries = visibleGroupedEntries.slice(0, -MAX_VISIBLE_WORK_LOG_ENTRIES);
          const visibleEntries = visibleGroupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES);
          const renderedEntries = expanded ? [...hiddenEntries, ...visibleEntries] : visibleEntries;

          for (const workEntry of renderedEntries) {
            nextRows.push({
              kind: "work",
              id: workEntry.id,
              createdAt: workEntry.createdAt,
              groupedEntries: [workEntry],
            });
          }

          const toggleRowId = `work-toggle:${timelineEntry.id}`;
          nextRows.push({
            kind: "work-toggle",
            id: toggleRowId,
            createdAt: timelineEntry.createdAt,
            groupId,
            hiddenCount: hiddenEntries.length,
            expanded,
            onlyToolEntries: visibleGroupedEntries.every((entry) => workLogEntryIsToolLike(entry)),
          });
          turnIdsByWorkToggleRowId.set(
            toggleRowId,
            new Set(visibleGroupedEntries.flatMap((entry) => (entry.turnId ? [entry.turnId] : []))),
          );
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    // Agent-authored user rows (epic-run status posts, a parent prompting this
    // thread) exist to start a turn, not to be read — the assistant's reply
    // carries the content. The subagent inspector drawer still shows them.
    if (timelineEntry.message.role === "user" && timelineEntry.message.origin === "agent") {
      continue;
    }

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      unsettledTurnId !== null &&
      timelineEntry.message.turnId === unsettledTurnId;

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantTurnStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
      runningSubagentCount: (input.subagentGroups ?? []).filter(
        (group) => group.status === "running",
      ).length,
    });
  }

  const insertionsByIndex = new Map<number, MessagesTimelineRow[]>();
  const workingRowIndex = nextRows.findIndex((row) => row.kind === "working");
  for (const turnSummary of input.turnDiffSummaries) {
    if (turnSummary.files.length === 0 || collapsedTurnIds.has(turnSummary.turnId)) {
      continue;
    }

    let anchorIndex = nextRows.findIndex(
      (row) => row.kind === "message" && row.message.id === turnSummary.assistantMessageId,
    );
    if (anchorIndex < 0) {
      for (let index = nextRows.length - 1; index >= 0; index -= 1) {
        const row = nextRows[index];
        if (
          row &&
          timelineRowBelongsToTurn({
            row,
            turnId: turnSummary.turnId,
            turnIdByTimelineRowId,
            turnIdsByWorkToggleRowId,
            turnIdByFleetRowId,
          })
        ) {
          anchorIndex = index;
          break;
        }
      }
    }

    const insertionIndex =
      anchorIndex >= 0 ? anchorIndex + 1 : workingRowIndex >= 0 ? workingRowIndex : nextRows.length;
    const insertions = insertionsByIndex.get(insertionIndex) ?? [];
    insertions.push({
      kind: "changed-files",
      id: `changed-files:${turnSummary.turnId}`,
      createdAt: turnSummary.completedAt,
      turnSummary,
    });
    insertionsByIndex.set(insertionIndex, insertions);
  }

  if (insertionsByIndex.size === 0) {
    return nextRows;
  }

  const rowsWithChangedFiles: MessagesTimelineRow[] = [];
  for (let index = 0; index <= nextRows.length; index += 1) {
    rowsWithChangedFiles.push(...(insertionsByIndex.get(index) ?? []));
    const row = nextRows[index];
    if (row) {
      rowsWithChangedFiles.push(row);
    }
  }
  return rowsWithChangedFiles;
}

function timelineRowBelongsToTurn(input: {
  row: MessagesTimelineRow;
  turnId: TurnId;
  turnIdByTimelineRowId: ReadonlyMap<string, TurnId>;
  turnIdsByWorkToggleRowId: ReadonlyMap<string, ReadonlySet<TurnId>>;
  turnIdByFleetRowId: ReadonlyMap<string, TurnId>;
}): boolean {
  switch (input.row.kind) {
    case "message":
      return input.row.message.turnId === input.turnId;
    case "proposed-plan":
      return input.row.proposedPlan.turnId === input.turnId;
    case "turn-fold":
      return input.row.turnId === input.turnId;
    case "work":
      return input.row.groupedEntries.some((entry) => entry.turnId === input.turnId);
    case "subagent":
      return input.turnIdByTimelineRowId.get(input.row.id) === input.turnId;
    case "subagent-fleet":
      return input.turnIdByFleetRowId.get(input.row.id) === input.turnId;
    case "work-toggle":
      return input.turnIdsByWorkToggleRowId.get(input.row.id)?.has(input.turnId) ?? false;
    case "activities-truncated":
    case "changed-files":
    case "working":
      return false;
  }
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/**
 * Per-variant field comparison; reference checks where producers keep stable
 * references, structural `Equal.equals` where derivation rebuilds values.
 */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working": {
      const bw = b as typeof a;
      return a.createdAt === bw.createdAt && a.runningSubagentCount === bw.runningSubagentCount;
    }

    case "activities-truncated": {
      const bt = b as typeof a;
      return a.createdAt === bt.createdAt && a.omittedCount === bt.omittedCount;
    }

    case "turn-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "changed-files": {
      const bc = b as typeof a;
      return a.createdAt === bc.createdAt && Equal.equals(a.turnSummary, bc.turnSummary);
    }

    case "subagent": {
      const bs = b as typeof a;
      return a.createdAt === bs.createdAt && Equal.equals(a.group, bs.group);
    }

    case "subagent-fleet": {
      const bf = b as typeof a;
      return (
        a.createdAt === bf.createdAt &&
        a.total === bf.total &&
        a.running === bf.running &&
        a.completed === bf.completed &&
        a.failed === bf.failed &&
        Equal.equals(a.agents, bf.agents)
      );
    }

    case "work":
      return Equal.equals(a.groupedEntries, (b as typeof a).groupedEntries);

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.onlyToolEntries === bw.onlyToolEntries
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
