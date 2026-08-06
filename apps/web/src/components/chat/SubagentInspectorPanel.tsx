import type {
  CommandId,
  OrchestrationThreadActivity,
  OrchestrationThreadSubagent,
  OrchestrationThreadSubagentStatus,
  ThreadId,
} from "@t3tools/contracts";
import { BotIcon } from "lucide-react";

import { formatElapsed, type SubagentGroup } from "../../session-logic";
import { cn } from "~/lib/utils";
import { capitalizeSubagentName, SubagentElapsed } from "./SubagentCard";
import { SubagentInspectorFooter, type SubagentCommandFailure } from "./SubagentInspectorFooter";

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
  threadId,
  activities,
  onSteer,
  onStop,
  onInterrupt,
}: {
  groups: readonly SubagentGroup[];
  subagents: readonly OrchestrationThreadSubagent[];
  activeSubagentKey: string;
  threadId: ThreadId;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  onSteer: (
    subagentId: string,
    text: string,
    commandId: CommandId,
  ) => Promise<SubagentCommandFailure | null>;
  onStop: (subagentId: string, commandId: CommandId) => Promise<SubagentCommandFailure | null>;
  onInterrupt: () => Promise<void>;
}) {
  const group = groups.find(
    (candidate) => (candidate.toolCallId ?? candidate.entryId) === activeSubagentKey,
  );
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
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            <span
              className={cn("size-1.5 rounded-full", STATUS_DOT_CLASS[group.status])}
              aria-hidden
            />
            <span>{STATUS_LABEL[group.status]}</span>
            {group.status === "running" ? (
              <SubagentElapsed startedAt={group.startedAt} />
            ) : settledElapsed ? (
              <span>{settledElapsed}</span>
            ) : null}
          </div>
        </div>
      </header>
      {readModel ? (
        <SubagentInspectorFooter
          activities={activities}
          onInterrupt={onInterrupt}
          onSteer={(text, commandId) => onSteer(readModel.subagentId, text, commandId)}
          onStop={(commandId) => onStop(readModel.subagentId, commandId)}
          subagent={readModel}
          threadId={threadId}
        />
      ) : null}
    </div>
  );
}
