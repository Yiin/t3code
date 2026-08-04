import { memo, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { BotIcon, CheckIcon, ChevronDownIcon, MinusIcon, XIcon } from "lucide-react";
import { formatDuration, formatElapsed, type SubagentGroup } from "../../session-logic";
import { cn } from "~/lib/utils";

/**
 * Inline card for one ad-hoc subagent (Agent/Task spawn) in the messages
 * timeline, replacing the flat `collab_agent_tool_call` tool row. Purely
 * presentational: the timeline row wrapper owns context reads and passes the
 * newest child tool row through `liveActivity`, the expansion detail through
 * `expandedBody`, and expansion state/toggling through `expanded` /
 * `onToggleExpanded` (so scroll compensation stays with the list owner).
 *
 * The group's status is authoritative — a "stopped" group renders as stopped
 * and deliberately skips the settled-neutral-to-check coercion plain work
 * rows apply.
 */
export const SubagentCard = memo(function SubagentCard({
  group,
  liveActivity,
  expanded = false,
  onToggleExpanded,
  expandedBody,
}: {
  group: SubagentGroup;
  liveActivity?: ReactNode;
  expanded?: boolean;
  onToggleExpanded?: (anchorElement?: HTMLElement) => void;
  expandedBody?: ReactNode;
}) {
  const toolCount = group.children.length;
  // Old servers / providers without child linkage yield 0 children — hide the
  // count instead of claiming "0 tools".
  const toolCountLabel = toolCount === 0 ? null : toolCount === 1 ? "1 tool" : `${toolCount} tools`;
  const resultPreview =
    group.status === "completed" && !expanded ? firstNonEmptyLine(group.resultText) : null;
  const isFailed = group.status === "failed";
  const canToggle = onToggleExpanded !== undefined;
  const headerToggleProps = canToggle
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-expanded": expanded,
        "aria-label": `${capitalizeSubagentName(group.name)} subagent details`,
        onClick: (e: React.MouseEvent<HTMLDivElement>) => onToggleExpanded(e.currentTarget),
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleExpanded(e.currentTarget);
          }
        },
      }
    : {};

  return (
    <div
      className="rounded-2xl border border-input bg-background p-3 shadow-xs/5 not-dark:bg-clip-padding dark:bg-input/32"
      data-subagent-status={group.status}
    >
      <div
        className={cn(
          "flex items-center gap-1.5",
          canToggle &&
            "-m-1 cursor-pointer select-none rounded-md p-1 transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        )}
        {...headerToggleProps}
      >
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center",
            isFailed ? "text-destructive" : "text-muted-foreground/65",
          )}
        >
          <BotIcon className="block size-3.5 shrink-0 stroke-[1.8] opacity-80" aria-hidden />
        </span>
        <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[12px] leading-5">
          <span
            className={cn(
              "min-w-0 shrink truncate font-medium",
              isFailed ? "text-destructive" : "text-foreground/82",
            )}
          >
            {capitalizeSubagentName(group.name)}
          </span>
          {group.description ? (
            <span className="min-w-0 flex-1 truncate text-muted-foreground/55">
              {group.description}
            </span>
          ) : null}
        </p>
        <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground/70 tabular-nums">
          {group.status === "running" ? (
            <>
              <span className="sr-only">Running</span>
              <span className="inline-flex items-center gap-[3px]" aria-hidden>
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse motion-reduce:animate-none" />
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse motion-reduce:animate-none [animation-delay:200ms]" />
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse motion-reduce:animate-none [animation-delay:400ms]" />
              </span>
              <SubagentElapsed startedAt={group.startedAt} />
              {toolCountLabel ? <span>{toolCountLabel}</span> : null}
            </>
          ) : group.status === "completed" ? (
            <>
              <span>{completedStatusLabel(group, toolCountLabel)}</span>
              <span className="inline-flex size-4 items-center justify-center">
                <CheckIcon
                  className="block size-3 shrink-0 stroke-current"
                  stroke="currentColor"
                  aria-hidden
                />
              </span>
            </>
          ) : group.status === "failed" ? (
            <>
              <span className="text-destructive">Failed</span>
              <span className="inline-flex size-4 items-center justify-center">
                <XIcon className="block size-3 shrink-0 text-destructive" aria-hidden />
              </span>
            </>
          ) : (
            <>
              <span>Stopped</span>
              <span className="inline-flex size-4 items-center justify-center">
                <MinusIcon className="block size-3 shrink-0 opacity-70" aria-hidden />
              </span>
            </>
          )}
          {canToggle ? (
            <span className="inline-flex size-4 items-center justify-center">
              <ChevronDownIcon
                className={cn(
                  "block size-3 shrink-0 opacity-70 transition-transform duration-200",
                  expanded && "rotate-180",
                )}
                aria-hidden
              />
            </span>
          ) : null}
        </div>
      </div>
      {liveActivity && !expanded ? <div className="mt-1 ps-6">{liveActivity}</div> : null}
      {resultPreview ? (
        <p className="mt-1 truncate ps-6.5 text-[11px] leading-5 text-muted-foreground/65">
          {resultPreview}
        </p>
      ) : null}
      {expanded && expandedBody ? <div className="mt-2 ps-1.5">{expandedBody}</div> : null}
    </div>
  );
});

function completedStatusLabel(group: SubagentGroup, toolCountLabel: string | null): string {
  // completedAt comes from the read model; without it (old servers) omit the
  // duration rather than fabricating one.
  const duration = formatElapsed(group.startedAt, group.completedAt ?? undefined);
  const label = duration ? `Done in ${duration}` : "Done";
  return toolCountLabel ? `${label} · ${toolCountLabel}` : label;
}

export function capitalizeSubagentName(name: string): string {
  return name.length === 0 ? name : name.charAt(0).toUpperCase() + name.slice(1);
}

function firstNonEmptyLine(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

/**
 * Live elapsed label for a running subagent. Updates its own text node so the
 * per-second tick never causes a React commit (WorkingTimer pattern).
 */
function SubagentElapsed({ startedAt }: { startedAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatSubagentElapsedNow(startedAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatSubagentElapsedNow(startedAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}

function formatSubagentElapsedNow(startIso: string): string {
  const startedAt = Date.parse(startIso);
  if (!Number.isFinite(startedAt)) {
    return "0s";
  }
  return formatDuration(Math.max(0, Date.now() - startedAt));
}
