import { useAtomValue } from "@effect/atom-react";
import { selectLiveSubagentTail } from "@t3tools/client-runtime/state/subagent-activity";
import type {
  CommandId,
  OrchestrationSubagentActivityCursor,
  OrchestrationThreadActivity,
  OrchestrationThreadSubagent,
  OrchestrationThreadSubagentStatus,
  ScopedThreadRef,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { SUBAGENT_ACTIVITY_PAGE_LIMIT } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { BotIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { formatElapsed, type SubagentGroup } from "../../session-logic";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { capitalizeSubagentName, SubagentElapsed, SubagentUnavailableData } from "./SubagentCard";
import { SubagentInspectorFooter, type SubagentCommandFailure } from "./SubagentInspectorFooter";
import {
  decodeSubagentTranscriptRow,
  selectSubagentInspectorPlaceholder,
  selectSubagentTranscriptEntries,
  summarizeSubagentUsage,
} from "./SubagentInspectorPanel.logic";
import {
  findRosterEntry,
  formatSubagentRosterSummary,
  resolveSubagentInteraction,
  type SubagentRosterEntry,
} from "./subagentRoster.logic";
import { MessageCopyButton } from "./MessageCopyButton";
import { WorkEntryRow } from "./WorkEntryRow";

const STATUS_DOT_CLASS: Record<OrchestrationThreadSubagentStatus, string> = {
  running: "bg-sky-500 dark:bg-sky-300/80 animate-status-pulse motion-reduce:animate-none",
  completed: "bg-emerald-500 dark:bg-emerald-300/90",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground/40",
};

const STATUS_LABEL: Record<OrchestrationThreadSubagentStatus, string> = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

const INITIAL_BACKFILL_CURSORS = [undefined] as const;

export function SubagentInspectorPlaceholder({ state }: { state: "loading" | "unavailable" }) {
  return state === "loading" ? (
    <p role="status" className="py-2 text-center text-sm text-muted-foreground">
      Loading subagent details…
    </p>
  ) : (
    <SubagentUnavailableData className="py-2 text-center" />
  );
}

function SubagentSwitcher({
  activeSubagentKey,
  items,
  onSelectSubagent,
}: {
  activeSubagentKey: string;
  items: ReadonlyArray<SubagentRosterEntry>;
  onSelectSubagent: (subagentKey: string) => void;
}) {
  if (items.length < 2) return null;

  const summary = formatSubagentRosterSummary(items);
  return (
    <div className="border-b border-border/45 py-2">
      {summary ? (
        <p className="px-3 pb-1.5 text-[11px] text-muted-foreground tabular-nums">{summary}</p>
      ) : null}
      <ScrollArea hideScrollbars scrollFade className="h-7 rounded-none">
        <div className="flex w-max min-w-full items-center gap-1 px-3">
          {items.map((item) => {
            const active = item.key === activeSubagentKey;
            const name = capitalizeSubagentName(item.name);
            return (
              <button
                key={item.key}
                type="button"
                aria-label={`${name} · ${item.status}`}
                aria-pressed={active}
                title={item.description ?? name}
                className={cn(
                  "flex h-7 max-w-40 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
                onClick={() => onSelectSubagent(item.key)}
              >
                <span
                  className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASS[item.status])}
                  aria-hidden
                />
                <span className="truncate">{name}</span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

function useSubagentTranscriptBackfill(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly fallbackEntries: SubagentGroup["children"];
  readonly subagent: OrchestrationThreadSubagent | undefined;
  readonly threadRef: ScopedThreadRef;
}) {
  const targetKey = input.subagent
    ? JSON.stringify([
        input.threadRef.environmentId,
        input.threadRef.threadId,
        input.subagent.subagentId,
      ])
    : null;
  const [pagination, setPagination] = useState<{
    readonly targetKey: string | null;
    readonly cursors: ReadonlyArray<OrchestrationSubagentActivityCursor | undefined>;
  }>({ targetKey, cursors: INITIAL_BACKFILL_CURSORS });
  const cursors =
    pagination.targetKey === targetKey ? pagination.cursors : INITIAL_BACKFILL_CURSORS;
  const pageAtoms = useMemo(
    () =>
      input.subagent
        ? cursors.map((before) =>
            orchestrationEnvironment.subagentActivities({
              environmentId: input.threadRef.environmentId,
              input: {
                threadId: input.threadRef.threadId,
                subagentId: input.subagent!.subagentId,
                limit: SUBAGENT_ACTIVITY_PAGE_LIMIT,
                ...(before === undefined ? {} : { before }),
              },
            }),
          )
        : [],
    [cursors, input.subagent, input.threadRef.environmentId, input.threadRef.threadId],
  );
  const pagesAtom = useMemo(
    () =>
      Atom.make((get) => pageAtoms.map((atom) => get(atom))).pipe(
        Atom.withLabel(`web:subagent-activity-pages:${targetKey ?? "empty"}`),
      ),
    [pageAtoms, targetKey],
  );
  const results = useAtomValue(pagesAtom);
  const pageValues = results.flatMap((result) => {
    const value = Option.getOrNull(AsyncResult.value(result));
    return value === null ? [] : [value];
  });
  const failed = results.some((result) => result._tag === "Failure");
  const hasBackfill = !failed && pageValues.length > 0;
  const liveTail = input.subagent
    ? selectLiveSubagentTail(
        input.activities,
        input.subagent.spawnedByItemId === undefined
          ? { subagentId: input.subagent.subagentId }
          : {
              subagentId: input.subagent.subagentId,
              spawnedByItemId: input.subagent.spawnedByItemId,
            },
      )
    : [];
  const entries = useMemo(
    () =>
      selectSubagentTranscriptEntries({
        backfillPages: hasBackfill ? pageValues.map((page) => page.activities) : null,
        liveTail,
        fallbackEntries: input.fallbackEntries,
      }),
    [hasBackfill, input.fallbackEntries, liveTail, pageValues],
  );
  const nextBefore = hasBackfill ? (pageValues.at(-1)?.nextBefore ?? null) : null;
  const loadEarlier = useCallback(() => {
    if (targetKey === null || nextBefore === null) return;
    setPagination((current) => {
      const currentCursors =
        current.targetKey === targetKey ? current.cursors : INITIAL_BACKFILL_CURSORS;
      return currentCursors.includes(nextBefore)
        ? { targetKey, cursors: currentCursors }
        : { targetKey, cursors: [...currentCursors, nextBefore] };
    });
  }, [nextBefore, targetKey]);

  return {
    entries,
    isComplete: hasBackfill && nextBefore === null,
    isPending: results.some((result) => result.waiting),
    liveTailLength: liveTail.length,
    loadEarlier,
    pageCount: pageValues.length,
    showLoadEarlier: nextBefore !== null,
  };
}

export function SubagentInspectorPanel({
  roster,
  activeSubagentKey,
  threadRef,
  activities,
  markdownCwd,
  workspaceRoot,
  skills,
  nowMs = Date.now(),
  onSteer,
  onStop,
  onInterrupt,
  onSelectSubagent,
}: {
  roster: ReadonlyArray<SubagentRosterEntry>;
  activeSubagentKey: string;
  threadRef: ScopedThreadRef;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  markdownCwd: string | undefined;
  nowMs?: number;
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  onSteer: (
    subagentId: string,
    text: string,
    commandId: CommandId,
  ) => Promise<SubagentCommandFailure | null>;
  onStop: (subagentId: string, commandId: CommandId) => Promise<SubagentCommandFailure | null>;
  onInterrupt: () => Promise<void>;
  onSelectSubagent: (subagentKey: string) => void;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const shouldFollowTailRef = useRef(true);
  const pendingPrependRef = useRef<{ pageCount: number; scrollHeight: number } | null>(null);
  const target = findRosterEntry(roster, activeSubagentKey);
  const group = target?.group ?? null;
  const readModel = target?.readModel ?? undefined;
  const backfill = useSubagentTranscriptBackfill({
    activities,
    fallbackEntries: group?.children ?? [],
    subagent: readModel,
    threadRef,
  });

  useEffect(() => {
    shouldFollowTailRef.current = true;
    pendingPrependRef.current = null;
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [activeSubagentKey]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (target?.status === "running" && transcript && shouldFollowTailRef.current) {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }, [backfill.liveTailLength, target?.status]);

  useLayoutEffect(() => {
    const pending = pendingPrependRef.current;
    const transcript = transcriptRef.current;
    if (!transcript) return;

    if (pending) {
      if (backfill.pageCount > pending.pageCount) {
        transcript.scrollTop += transcript.scrollHeight - pending.scrollHeight;
        pendingPrependRef.current = null;
      } else if (!backfill.isPending) {
        pendingPrependRef.current = null;
      }
      return;
    }

    if (shouldFollowTailRef.current) transcript.scrollTop = transcript.scrollHeight;
  }, [backfill.isPending, backfill.pageCount]);

  if (!target) {
    return (
      <div className="flex h-full w-full min-h-0 flex-1 flex-col">
        <SubagentSwitcher
          activeSubagentKey={activeSubagentKey}
          items={roster}
          onSelectSubagent={onSelectSubagent}
        />
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          This subagent is no longer available.
        </div>
      </div>
    );
  }

  const interaction = resolveSubagentInteraction(target, nowMs);
  const settledElapsed =
    target.status === "running"
      ? null
      : formatElapsed(target.startedAt, target.completedAt ?? undefined);
  // A group means the client saw the spawning tool call; a `spawnedByItemId`
  // means the server recorded one. Without either, the row only ever arrived
  // as provider-reported progress.
  const spawnLabel =
    target.group !== null || readModel?.spawnedByItemId !== undefined
      ? "spawned by Task"
      : "reported by the provider";
  const usage = summarizeSubagentUsage(readModel?.usage);
  const usageLabel =
    usage.inputTokens !== null || usage.outputTokens !== null
      ? [
          usage.inputTokens !== null ? formatContextWindowTokens(usage.inputTokens) + " in" : null,
          usage.outputTokens !== null
            ? formatContextWindowTokens(usage.outputTokens) + " out"
            : null,
        ]
          .filter((value): value is string => value !== null)
          .join(" · ")
      : null;
  const toolCount = backfill.entries.filter(
    (child) =>
      child.sourceActivityKind !== "subagent.text" &&
      child.sourceActivityKind !== "subagent.thinking",
  ).length;
  const toolCountLabel = `${toolCount === 1 ? "1 tool call" : toolCount + " tool calls"}${
    backfill.isComplete ? "" : " shown"
  }`;
  const liveProgress =
    target.status === "running"
      ? [target.lastProgressSummary, target.lastToolName].filter(
          (value): value is string => value !== null,
        )
      : [];
  const prompt = group?.prompt ?? null;
  // The per-subagent activity query keys off parent_tool_use_id / task_id and
  // the spawn tool row carries neither, so the prompt is genuinely gone with
  // the group. The settled read-model summary still stands in for the result.
  const resultText =
    group?.resultText ??
    (target.status === "running" ? null : (target.lastProgressSummary ?? null));
  const placeholder = selectSubagentInspectorPlaceholder({
    entryCount: backfill.entries.length,
    isPending: backfill.isPending,
    prompt,
    resultText,
  });

  return (
    <div className="flex h-full w-full min-h-0 flex-1 flex-col">
      <header className="surface-subheader h-auto min-h-12 gap-2 px-3 py-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <BotIcon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2
              className="truncate text-sm font-medium text-foreground"
              title={capitalizeSubagentName(target.name)}
            >
              {capitalizeSubagentName(target.name)}
            </h2>
            {target.description ? (
              <p className="truncate text-xs text-muted-foreground" title={target.description}>
                {target.description}
              </p>
            ) : null}
          </div>
          <p className="truncate text-[11px] text-muted-foreground">
            {spawnLabel}
            {target.status === "running" ? (
              <>
                {" · "}
                <SubagentElapsed startedAt={target.startedAt} />
              </>
            ) : settledElapsed ? (
              " · " + settledElapsed
            ) : null}
          </p>
        </div>
      </header>

      <SubagentSwitcher
        activeSubagentKey={target.key}
        items={roster}
        onSelectSubagent={onSelectSubagent}
      />

      <div className="border-b border-border/45 px-3 py-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={cn("size-1.5 rounded-full", STATUS_DOT_CLASS[target.status])}
              aria-hidden
            />
            {target.status === "running" ? (
              <>
                <span>{STATUS_LABEL[target.status]}</span>
                <SubagentElapsed startedAt={target.startedAt} />
              </>
            ) : (
              <span>
                {STATUS_LABEL[target.status]}
                {settledElapsed ? " in " + settledElapsed : ""}
              </span>
            )}
          </span>
          <span aria-hidden>·</span>
          <span>{toolCountLabel}</span>
          {usageLabel ? (
            <>
              <span aria-hidden>·</span>
              <span>{usageLabel}</span>
            </>
          ) : null}
        </div>
        {liveProgress.length > 0 ? (
          <p className="mt-1 truncate" title={liveProgress.join(" · ")}>
            {liveProgress.join(" · ")}
          </p>
        ) : null}
      </div>

      <div
        ref={transcriptRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
        onScroll={(event) => {
          const element = event.currentTarget;
          shouldFollowTailRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
        }}
      >
        <div className="space-y-3">
          {backfill.showLoadEarlier ? (
            <div className="sticky top-0 z-10 flex justify-center bg-background/90 pb-2 backdrop-blur-sm">
              <Button
                size="xs"
                variant="outline"
                disabled={backfill.isPending}
                onClick={() => {
                  const transcript = transcriptRef.current;
                  if (transcript) {
                    pendingPrependRef.current = {
                      pageCount: backfill.pageCount,
                      scrollHeight: transcript.scrollHeight,
                    };
                  }
                  backfill.loadEarlier();
                }}
              >
                {backfill.isPending ? "Loading…" : "Load earlier"}
              </Button>
            </div>
          ) : null}

          {backfill.entries.length > 0 ? (
            <section>
              <p className="px-0.5 pb-0.5 font-medium text-[11px] text-muted-foreground/65">
                {backfill.entries.length === 1
                  ? "1 transcript entry"
                  : backfill.entries.length + " transcript entries"}
              </p>
              <div className="space-y-px">
                {backfill.entries.map((workEntry) => (
                  <SubagentTranscriptEntryRow
                    key={workEntry.id}
                    workEntry={workEntry}
                    markdownCwd={markdownCwd}
                    skills={skills}
                    threadRef={threadRef}
                    workspaceRoot={workspaceRoot}
                    turnSettled={target.status !== "running"}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {resultText !== null ? (
            <section>
              <div className="flex items-center justify-between gap-2 px-0.5 pb-0.5">
                <p className="font-medium text-[11px] text-muted-foreground/65">Result</p>
                <MessageCopyButton text={resultText} size="icon-xs" variant="ghost" />
              </div>
              <div className="border-s border-border/45 ps-3 text-sm">
                <ChatMarkdown
                  text={resultText}
                  cwd={markdownCwd}
                  threadRef={threadRef}
                  skills={skills}
                />
              </div>
            </section>
          ) : null}

          {prompt !== null ? (
            <details open={backfill.entries.length === 0}>
              <summary className="cursor-pointer select-none px-0.5 text-[11px] font-medium text-muted-foreground/65">
                Spawn prompt
              </summary>
              <div className="mt-1 border-s border-border/45 ps-3 pt-0.5">
                <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground select-text">
                  {prompt}
                </pre>
              </div>
            </details>
          ) : null}

          {placeholder !== null ? <SubagentInspectorPlaceholder state={placeholder} /> : null}
        </div>
      </div>

      {interaction.kind === "unaddressable" ? (
        <div className="mt-auto border-t border-border/70 p-3">
          <p className="text-xs text-muted-foreground">{interaction.reason}</p>
        </div>
      ) : readModel ? (
        <SubagentInspectorFooter
          activities={activities}
          nowMs={nowMs}
          onInterrupt={onInterrupt}
          onSteer={(text, commandId) => onSteer(readModel.subagentId, text, commandId)}
          onStop={(commandId) => onStop(readModel.subagentId, commandId)}
          subagent={readModel}
          threadId={threadRef.threadId}
        />
      ) : null}
    </div>
  );
}

export function SubagentTranscriptEntryRow({
  workEntry,
  markdownCwd,
  skills,
  threadRef,
  workspaceRoot,
  turnSettled,
}: {
  workEntry: SubagentGroup["children"][number];
  markdownCwd: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  threadRef: ScopedThreadRef;
  workspaceRoot: string | undefined;
  turnSettled: boolean;
}) {
  const transcriptRow = decodeSubagentTranscriptRow(workEntry);
  if (!transcriptRow) {
    return (
      <WorkEntryRow workEntry={workEntry} workspaceRoot={workspaceRoot} turnSettled={turnSettled} />
    );
  }

  const truncatedMarker = transcriptRow.truncated ? (
    <span className="ms-1 text-[11px] italic text-muted-foreground/65">… truncated</span>
  ) : null;

  if (transcriptRow.kind === "thinking") {
    return (
      <details className="border-s border-border/45 ps-3 text-muted-foreground">
        <summary className="cursor-pointer select-none py-1 text-xs italic">Thinking</summary>
        <div className="pb-1 text-sm italic">
          <ChatMarkdown
            text={transcriptRow.text}
            cwd={markdownCwd}
            threadRef={threadRef}
            skills={skills}
          />
          {truncatedMarker}
        </div>
      </details>
    );
  }

  return (
    <div className="border-s border-border/45 py-1 ps-3 text-sm text-muted-foreground">
      <ChatMarkdown
        text={transcriptRow.text}
        cwd={markdownCwd}
        threadRef={threadRef}
        skills={skills}
      />
      {truncatedMarker}
    </div>
  );
}
