import { BotIcon } from "lucide-react";

import { formatSubagentDiffBadge } from "../../lib/subagentDiffAttribution";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Marks a file in a turn diff as written by a subagent, not by this chat.
 *
 * A thread-backed subagent shares its parent's worktree and always settles
 * before the parent's checkpoint is captured, so its files land in the parent's
 * turn diff. The patch is right; the attribution is what this badge corrects.
 */
export function SubagentDiffBadge(props: { filePath: string; labels: ReadonlyArray<string> }) {
  const badge = formatSubagentDiffBadge(props.labels);
  if (!badge) return null;

  const description =
    props.labels.length === 1
      ? `Written by subagent ${props.labels[0] ?? ""}, not by this chat`
      : `Written by subagents ${props.labels.join(", ")}, not by this chat`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border/70 bg-background/70 px-1.5 py-px text-[10px] leading-4 font-medium text-muted-foreground"
            data-subagent-diff-badge={props.filePath}
            aria-label={description}
          />
        }
      >
        <BotIcon className="size-3" aria-hidden="true" />
        {badge}
      </TooltipTrigger>
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
}
