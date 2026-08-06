import {
  isFreshRunningSubagent,
  SUBAGENT_STOP_ESCALATION_GRACE_MS,
  type CommandId,
  type OrchestrationThreadActivity,
  type OrchestrationThreadSubagent,
  type ThreadId,
} from "@t3tools/contracts";
import { SendIcon, SquareIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { selectSubagentSteerStates, type SubagentSteerState } from "../../session-logic";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { newCommandId } from "~/lib/utils";

export interface SubagentCommandFailure {
  message: string;
  unsupported: boolean;
}

type CommandResult = SubagentCommandFailure | null;

export function subagentInteractionDisabledReason(
  subagent: OrchestrationThreadSubagent,
  nowMs: number,
): string | null {
  if (subagent.status !== "running") return "This subagent is no longer running.";
  if (!isFreshRunningSubagent(subagent, nowMs)) {
    return "This subagent has not reported recent activity.";
  }
  return null;
}

interface OptimisticSteer {
  steerId: CommandId;
  text: string;
  status: "sending" | "queued";
}

export function SubagentInspectorFooter({
  threadId,
  subagent,
  activities,
  nowMs = Date.now(),
  onSteer,
  onStop,
  onInterrupt,
}: {
  threadId: ThreadId;
  subagent: OrchestrationThreadSubagent;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  nowMs?: number;
  onSteer: (text: string, commandId: CommandId) => Promise<CommandResult>;
  onStop: (commandId: CommandId) => Promise<CommandResult>;
  onInterrupt: () => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [optimisticSteers, setOptimisticSteers] = useState<OptimisticSteer[]>([]);
  const [optimisticStop, setOptimisticStop] = useState<"sending" | "stopping" | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [steeringUnsupported, setSteeringUnsupported] = useState(false);
  const states = useMemo(
    () => selectSubagentSteerStates(activities, subagent.subagentId),
    [activities, subagent.subagentId],
  );
  const activitySteerIds = useMemo(
    () => new Set(states.steers.map((steer) => steer.steerId)),
    [states.steers],
  );
  const pendingSteers = optimisticSteers.filter((steer) => !activitySteerIds.has(steer.steerId));
  const latestStop = states.stops.at(-1);
  const interactionDisabledReason = subagentInteractionDisabledReason(subagent, nowMs);
  const composerDisabledReason = steeringUnsupported
    ? "This server does not support subagent steering."
    : interactionDisabledReason;
  const isStopping =
    optimisticStop !== null ||
    latestStop?.status === "stopping" ||
    latestStop?.status === "escalated";

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || composerDisabledReason) return;
    const commandId = newCommandId();
    setDraft("");
    setCommandError(null);
    setOptimisticSteers((current) => [
      ...current,
      { steerId: commandId, text: trimmed, status: "sending" },
    ]);
    const failure = await onSteer(trimmed, commandId);
    if (failure === null) {
      setOptimisticSteers((current) =>
        current.map((steer) =>
          steer.steerId === commandId ? { ...steer, status: "queued" } : steer,
        ),
      );
      return;
    }
    setOptimisticSteers((current) => current.filter((steer) => steer.steerId !== commandId));
    if (failure.unsupported) {
      setSteeringUnsupported(true);
      setCommandError("This server does not support subagent steering.");
    } else {
      setCommandError(failure.message);
    }
  };

  const stop = async () => {
    if (interactionDisabledReason || isStopping) return;
    const commandId = newCommandId();
    setCommandError(null);
    setOptimisticStop("sending");
    const failure = await onStop(commandId);
    if (failure === null) {
      setOptimisticStop("stopping");
      return;
    }
    setOptimisticStop(null);
    setCommandError(failure.message);
  };

  const renderSteer = (steer: SubagentSteerState) => (
    <div
      className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-xs"
      key={steer.steerId}
    >
      <div className="font-medium text-foreground">You → subagent</div>
      {steer.text ? (
        <div className="mt-1 whitespace-pre-wrap text-foreground/90">{steer.text}</div>
      ) : null}
      <div
        className={
          steer.status === "failed" ? "mt-1 text-destructive" : "mt-1 text-muted-foreground"
        }
      >
        {steer.status === "queued"
          ? "Sending…"
          : steer.status === "delivered"
            ? "Queued for parent"
            : steer.detail}
      </div>
      {steer.status === "delivered" ? (
        <div className="mt-0.5 text-muted-foreground">
          The parent will receive this after the current subagent task returns.
        </div>
      ) : null}
      {steer.status === "failed" && steer.text ? (
        <Button
          className="mt-1.5"
          size="xs"
          variant="outline"
          onClick={() => void send(steer.text!)}
        >
          Retry
        </Button>
      ) : null}
    </div>
  );

  return (
    <div className="mt-auto border-t border-border/70" data-thread-id={threadId}>
      {states.steers.length > 0 || pendingSteers.length > 0 ? (
        <div className="max-h-48 space-y-2 overflow-y-auto p-3">
          {states.steers.map(renderSteer)}
          {pendingSteers.map((steer) => (
            <div
              className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-xs"
              key={steer.steerId}
            >
              <div className="font-medium text-foreground">You → subagent</div>
              <div className="mt-1 whitespace-pre-wrap text-foreground/90">{steer.text}</div>
              <div className="mt-1 text-muted-foreground">
                {steer.status === "sending" ? "Sending…" : "Queued for parent"}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="space-y-2 p-3">
        {latestStop?.status === "escalated" ? (
          <p className="text-xs text-destructive">Escalated: turn interrupted.</p>
        ) : latestStop?.status === "failed" ? (
          <p className="text-xs text-destructive">{latestStop.detail}</p>
        ) : isStopping ? (
          <p className="text-xs text-muted-foreground">
            Stopping… interrupts turn in {SUBAGENT_STOP_ESCALATION_GRACE_MS / 1_000}s.
          </p>
        ) : null}
        {commandError ? <p className="text-xs text-destructive">{commandError}</p> : null}

        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
        >
          <Textarea
            aria-label="Message subagent"
            className="[&_[data-slot=textarea]]:max-h-28 [&_[data-slot=textarea]]:min-h-8"
            disabled={composerDisabledReason !== null}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
            placeholder="Message this subagent"
            rows={1}
            title={composerDisabledReason ?? undefined}
            value={draft}
          />
          <Button
            aria-label="Send to subagent"
            disabled={composerDisabledReason !== null || draft.trim().length === 0}
            size="icon"
            title={composerDisabledReason ?? "Send to subagent"}
            type="submit"
          >
            <SendIcon aria-hidden />
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={interactionDisabledReason !== null || isStopping}
            onClick={() => void stop()}
            size="sm"
            title={interactionDisabledReason ?? "Stop subagent"}
            variant="destructive-outline"
          >
            <SquareIcon aria-hidden />
            {isStopping ? "Stopping…" : "Stop"}
          </Button>
          {isStopping && latestStop?.status !== "escalated" ? (
            <Button onClick={() => void onInterrupt()} size="sm" variant="ghost">
              Interrupt turn now
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
