import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { formatElapsed } from "../../session-logic";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { capitalizeSubagentName, SubagentElapsed } from "./SubagentCard";
import {
  formatSubagentRosterSummary,
  orderRosterForDisplay,
  SUBAGENT_STATUS_DOT_CLASS,
  SUBAGENT_STATUS_LABEL,
  type SubagentRosterEntry,
} from "./subagentRoster.logic";

/** The one line under a row's name: what it is doing, or how it ended. */
export function rosterRowStatusText(entry: SubagentRosterEntry): string {
  if (entry.status === "running") {
    return entry.lastToolName ?? entry.lastProgressSummary ?? entry.description ?? "working";
  }
  const label = SUBAGENT_STATUS_LABEL[entry.status];
  const elapsed = formatElapsed(entry.startedAt, entry.completedAt ?? undefined);
  return elapsed ? `${label} in ${elapsed}` : label;
}

function rosterCountLabel(count: number): string {
  return count === 1 ? "1 subagent" : `${count} subagents`;
}

/**
 * The rows themselves, split out because base-ui portals the popup body and so
 * an SSR test can never reach it through the popover.
 */
export function SubagentRosterList({
  roster,
  onOpenSubagent,
}: {
  roster: ReadonlyArray<SubagentRosterEntry>;
  onOpenSubagent: (key: string) => void;
}) {
  const ordered = orderRosterForDisplay(roster);
  if (ordered.length === 0) {
    return <p className="px-3 py-2 text-muted-foreground text-xs">No subagents yet.</p>;
  }

  return (
    <div className="flex flex-col">
      {ordered.map((entry) => {
        const name = capitalizeSubagentName(entry.name);
        const statusText = rosterRowStatusText(entry);
        return (
          <button
            key={entry.key}
            type="button"
            aria-label={`${name} · ${SUBAGENT_STATUS_LABEL[entry.status]}`}
            title={entry.description ?? name}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            onClick={() => onOpenSubagent(entry.key)}
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                SUBAGENT_STATUS_DOT_CLASS[entry.status],
              )}
              aria-hidden
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium text-foreground text-xs">{name}</span>
              <span className="truncate text-[11px] text-muted-foreground">{statusText}</span>
            </span>
            {entry.status === "running" ? (
              <span className="shrink-0 text-[11px] text-muted-foreground/70">
                <SubagentElapsed startedAt={entry.startedAt} />
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The composer banner's way into the subagent drawer.
 *
 * It always opens, even with one subagent, so the control means one thing. The
 * list carries finished subagents too: while a sibling still runs, the popover
 * is the only way back to one that already reported.
 */
export function SubagentRosterPopover({
  roster,
  onOpenSubagent,
  triggerLabel,
}: {
  roster: ReadonlyArray<SubagentRosterEntry>;
  onOpenSubagent: (key: string) => void;
  triggerLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const summary = formatSubagentRosterSummary(roster);
  const countLabel = rosterCountLabel(roster.length);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            aria-label={
              summary
                ? `${triggerLabel}, ${countLabel}, ${summary}`
                : `${triggerLabel}, ${countLabel}`
            }
          >
            <span>{triggerLabel}</span>
            <ChevronDownIcon aria-hidden />
          </Button>
        }
      />
      <PopoverPopup side="top" align="end" className="w-72 max-w-none" viewportClassName="p-0">
        <div className="flex flex-col gap-1 py-2">
          <p className="px-3 font-medium text-[11px] text-muted-foreground tabular-nums">
            {summary || countLabel}
          </p>
          <ScrollArea className="max-h-64 rounded-none">
            <div className="px-1">
              <SubagentRosterList
                roster={roster}
                onOpenSubagent={(key) => {
                  setOpen(false);
                  onOpenSubagent(key);
                }}
              />
            </div>
          </ScrollArea>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
