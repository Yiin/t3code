import { ChefHatIcon } from "lucide-react";
import type { EpicRun } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { resolveEpicRunStatusPill } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface EpicRunPillProps {
  readonly run: EpicRun;
  readonly onView: () => void;
  readonly className?: string;
}

/**
 * Compact replacement for the epic-run composer banner: a pill under the
 * composer that opens the run on click and explains itself in a tooltip.
 */
export function EpicRunPill({ run, onView, className }: EpicRunPillProps) {
  const statusPill = resolveEpicRunStatusPill(run.status);
  if (!statusPill) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid="epic-run-pill"
            aria-label={`View epic run ${run.epicId} (${statusPill.label})`}
            onClick={onView}
            className={cn(
              "pointer-events-auto inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/60 bg-card px-2.5 text-[11px] font-medium text-muted-foreground shadow-sm transition-colors hover:border-border hover:text-foreground",
              className,
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full motion-reduce:animate-none",
                statusPill.dotClass,
                statusPill.pulse ? "animate-status-pulse" : null,
              )}
            />
            <ChefHatIcon aria-hidden className={cn("size-3", statusPill.colorClass)} />
            <span className="max-w-44 truncate">{run.epicId}</span>
          </button>
        }
      />
      <TooltipPopup side="top" className="max-w-72">
        <div className="flex flex-col gap-0.5 py-0.5">
          <span className="font-medium text-foreground">
            This thread is part of an active epic run
          </span>
          <span className="text-muted-foreground">
            {run.epicId} · {statusPill.label} · {run.iterationsCompleted}/{run.maxIterations}{" "}
            iterations
          </span>
          <span className="text-muted-foreground">Click to open the run</span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
