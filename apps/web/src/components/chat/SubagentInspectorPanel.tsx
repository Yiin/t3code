import type {
  CommandId,
  OrchestrationThreadActivity,
  OrchestrationThreadSubagent,
  OrchestrationThreadSubagentStatus,
  ScopedThreadRef,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { BotIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { formatElapsed, type SubagentGroup } from "../../session-logic";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { capitalizeSubagentName, SubagentElapsed } from "./SubagentCard";
import { SubagentInspectorFooter, type SubagentCommandFailure } from "./SubagentInspectorFooter";
import { summarizeSubagentUsage } from "./SubagentInspectorPanel.logic";
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

export function SubagentInspectorPanel({
  groups,
  subagents,
  activeSubagentKey,
  threadRef,
  activities,
  markdownCwd,
  workspaceRoot,
  skills,
  onSteer,
  onStop,
  onInterrupt,
}: {
  groups: readonly SubagentGroup[];
  subagents: readonly OrchestrationThreadSubagent[];
  activeSubagentKey: string;
  threadRef: ScopedThreadRef;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  onSteer: (
    subagentId: string,
    text: string,
    commandId: CommandId,
  ) => Promise<SubagentCommandFailure | null>;
  onStop: (subagentId: string, commandId: CommandId) => Promise<SubagentCommandFailure | null>;
  onInterrupt: () => Promise<void>;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const shouldFollowTailRef = useRef(true);
  const group = groups.find(
    (candidate) => (candidate.toolCallId ?? candidate.entryId) === activeSubagentKey,
  );

  useEffect(() => {
    shouldFollowTailRef.current = true;
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [activeSubagentKey]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (group?.status === "running" && transcript && shouldFollowTailRef.current) {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }, [group?.children.length, group?.status]);

  if (!group) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        This subagent is no longer available.
      </div>
    );
  }

  const readModel = subagents.find((subagent) => subagent.spawnedByItemId === activeSubagentKey);
  const completedAt = readModel?.completedAt ?? group.completedAt;
  const settledElapsed =
    group.status === "running" ? null : formatElapsed(group.startedAt, completedAt ?? undefined);
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
  const toolCountLabel =
    group.children.length === 1 ? "1 tool call" : group.children.length + " tool calls";
  const liveProgress =
    group.status === "running"
      ? [readModel?.lastProgressSummary, readModel?.lastToolName].filter(
          (value): value is string => value !== undefined,
        )
      : [];

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
              title={capitalizeSubagentName(group.name)}
            >
              {capitalizeSubagentName(group.name)}
            </h2>
            {group.description ? (
              <p className="truncate text-xs text-muted-foreground" title={group.description}>
                {group.description}
              </p>
            ) : null}
          </div>
        </div>
      </header>

      <div className="border-b border-border/45 px-3 py-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={cn("size-1.5 rounded-full", STATUS_DOT_CLASS[group.status])}
              aria-hidden
            />
            {group.status === "running" ? (
              <>
                <span>{STATUS_LABEL[group.status]}</span>
                <SubagentElapsed startedAt={group.startedAt} />
              </>
            ) : (
              <span>
                {STATUS_LABEL[group.status]}
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
          {group.children.length > 0 ? (
            <section>
              <p className="px-0.5 pb-0.5 font-medium text-[11px] text-muted-foreground/65">
                {group.children.length === 1
                  ? "1 tool call shown"
                  : group.children.length + " tool calls shown"}
              </p>
              <div className="space-y-px">
                {group.children.map((workEntry) => (
                  <WorkEntryRow
                    key={workEntry.id}
                    workEntry={workEntry}
                    workspaceRoot={workspaceRoot}
                    turnSettled={group.status !== "running"}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {group.resultText !== null ? (
            <section>
              <div className="flex items-center justify-between gap-2 px-0.5 pb-0.5">
                <p className="font-medium text-[11px] text-muted-foreground/65">Result</p>
                <MessageCopyButton text={group.resultText} size="icon-xs" variant="ghost" />
              </div>
              <div className="border-s border-border/45 ps-3 text-sm">
                <ChatMarkdown
                  text={group.resultText}
                  cwd={markdownCwd}
                  threadRef={threadRef}
                  skills={skills}
                />
              </div>
            </section>
          ) : null}

          {group.prompt !== null ? (
            <details open={group.children.length === 0}>
              <summary className="cursor-pointer select-none px-0.5 text-[11px] font-medium text-muted-foreground/65">
                Spawn prompt
              </summary>
              <div className="mt-1 border-s border-border/45 ps-3 pt-0.5">
                <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground select-text">
                  {group.prompt}
                </pre>
              </div>
            </details>
          ) : null}
        </div>
      </div>

      {readModel ? (
        <SubagentInspectorFooter
          activities={activities}
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
