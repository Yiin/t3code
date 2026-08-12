/**
 * SubagentDrawerComposer - talk to a thread-backed subagent from the drawer.
 *
 * A thread-backed child owns a thread and a provider session, so a message can
 * go straight to it. That is the whole difference from the in-process footer,
 * which can only leave a note for the parent.
 *
 * It reuses `ComposerPromptEditor`, the 14-prop primitive behind the main
 * composer, rather than `ChatComposer`: the editor already brings Lexical,
 * paste, mention drag and the Enter/Tab/Arrow key contract, while `ChatComposer`
 * is bound to ChatView internals.
 *
 * @module chat/SubagentDrawerComposer
 */
import type {
  OrchestrationLatestTurn,
  ScopedThreadRef,
  ServerProviderSkill,
  ThreadTurnStartDelivery,
} from "@t3tools/contracts";
import { SendIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import type { SubagentCommandFailure } from "./SubagentInspectorFooter";

export const SUBAGENT_DRAWER_PLACEHOLDER = "Message this subagent";

/** Said while the child is mid-turn, so the wait is never a surprise. */
export const SUBAGENT_DRAWER_BUSY_NOTICE = "Sends when this subagent's current turn ends.";

/** Said while the child is idle: the message opens a turn of its own. */
export const SUBAGENT_DRAWER_IDLE_NOTICE = "Starts a new turn on this subagent's own thread.";

/**
 * A busy child parks the turn start until its current turn ends; an idle one
 * takes it now. Nothing here claims the subagent has read it.
 */
export function resolveSubagentDrawerDelivery(
  latestTurn: Pick<OrchestrationLatestTurn, "state"> | null,
): ThreadTurnStartDelivery {
  return latestTurn?.state === "running" ? "turn-boundary" : "immediate";
}

export function subagentDrawerNotice(delivery: ThreadTurnStartDelivery): string {
  return delivery === "turn-boundary" ? SUBAGENT_DRAWER_BUSY_NOTICE : SUBAGENT_DRAWER_IDLE_NOTICE;
}

/**
 * What a sent message can honestly say about itself.
 *
 * "Sent" means the server accepted the turn start, never that the subagent read
 * it. A parked message says so, because it has not started a turn yet.
 */
export function subagentDrawerSentLabel(
  status: "sending" | "sent",
  delivery: ThreadTurnStartDelivery,
): string {
  if (status === "sending") return "Sending…";
  return delivery === "turn-boundary" ? "Sent · waits for the current turn to end" : "Sent";
}

interface SentMessage {
  readonly id: number;
  readonly text: string;
  readonly delivery: ThreadTurnStartDelivery;
  readonly status: "sending" | "sent";
}

export function SubagentDrawerComposer({
  childThreadRef,
  childLatestTurn,
  skills,
  onSend,
}: {
  childThreadRef: ScopedThreadRef;
  childLatestTurn: Pick<OrchestrationLatestTurn, "state"> | null;
  skills: ReadonlyArray<ServerProviderSkill>;
  onSend: (
    text: string,
    delivery: ThreadTurnStartDelivery,
  ) => Promise<SubagentCommandFailure | null>;
}) {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const nextSentIdRef = useRef(0);
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState<ReadonlyArray<SentMessage>>([]);
  const delivery = resolveSubagentDrawerDelivery(childLatestTurn);

  const send = async () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    const id = nextSentIdRef.current++;
    setSendError(null);
    setSent((current) => [...current, { id, text: trimmed, delivery, status: "sending" }]);
    const failure = await onSend(trimmed, delivery);
    if (failure === null) {
      // Only clear the draft once the send is accepted, so a failure never
      // costs the human what they typed.
      setDraft("");
      setCursor(0);
      setSent((current) =>
        current.map((message) => (message.id === id ? { ...message, status: "sent" } : message)),
      );
      return;
    }
    setSent((current) => current.filter((message) => message.id !== id));
    setSendError(failure.message);
  };

  return (
    <div className="space-y-2" data-subagent-drawer-composer={childThreadRef.threadId}>
      {sent.length > 0 ? (
        <div className="max-h-40 space-y-2 overflow-y-auto">
          {sent.map((message) => (
            <div
              className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-xs"
              key={message.id}
            >
              <div className="font-medium text-foreground">You → subagent</div>
              <div className="mt-1 whitespace-pre-wrap text-foreground/90">{message.text}</div>
              <div className="mt-1 text-muted-foreground">
                {subagentDrawerSentLabel(message.status, message.delivery)}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {sendError ? <p className="text-xs text-destructive">{sendError}</p> : null}
      <p className="text-xs text-muted-foreground">{subagentDrawerNotice(delivery)}</p>

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5">
          <ComposerPromptEditor
            cursor={cursor}
            disabled={false}
            editorRef={editorRef}
            onChange={(nextValue, nextCursor) => {
              setDraft(nextValue);
              setCursor(nextCursor);
            }}
            onCommandKeyDown={(key, event) => {
              if (key !== "Enter" || event.shiftKey) return false;
              void send();
              return true;
            }}
            onPaste={() => undefined}
            onRemoveTerminalContext={() => undefined}
            placeholder={SUBAGENT_DRAWER_PLACEHOLDER}
            skills={skills}
            terminalContexts={[]}
            value={draft}
          />
        </div>
        <Button
          aria-label="Send to subagent"
          disabled={draft.trim().length === 0}
          size="icon"
          title="Send to subagent"
          type="submit"
        >
          <SendIcon aria-hidden />
        </Button>
      </form>
    </div>
  );
}
