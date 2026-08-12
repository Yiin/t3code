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
 * is bound to ChatView internals. Attachments go through `chatAttachments`, the
 * same gate the main composer screens a file pick with, so the two surfaces
 * refuse the same files for the same reasons.
 *
 * @module chat/SubagentDrawerComposer
 */
import type {
  OrchestrationLatestTurn,
  ProviderDriverKind,
  ScopedThreadRef,
  ServerProviderSkill,
  ThreadTurnStartDelivery,
  UploadChatAttachment,
} from "@t3tools/contracts";
import { FileIcon, PaperclipIcon, SendIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { randomUUID } from "~/lib/utils";
import { readFileAsDataUrl } from "../ChatView.logic";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import {
  attachmentExtensionLabel,
  formatAttachmentSize,
  screenComposerAttachments,
} from "./chatAttachments";
import type { SubagentCommandFailure } from "./SubagentInspectorFooter";

export const SUBAGENT_DRAWER_PLACEHOLDER = "Message this subagent";

/** Said while the child is mid-turn, so the wait is never a surprise. */
export const SUBAGENT_DRAWER_BUSY_NOTICE = "Sends when this subagent's current turn ends.";

/** Said while the child is idle: the message opens a turn of its own. */
export const SUBAGENT_DRAWER_IDLE_NOTICE = "Starts a new turn on this subagent's own thread.";

/** Stands in for the prompt when a message carries files and no words. */
export const SUBAGENT_DRAWER_ATTACHMENT_ONLY_PROMPT =
  "[Files were attached with no additional text. Use the attached file(s).]";

/** Shown when a file cannot be read off disk, so the send never fails silently. */
export const SUBAGENT_DRAWER_ATTACHMENT_READ_ERROR =
  "Could not read one of the attached files. Nothing was sent.";

/** A file staged on the drawer's draft, before it is read into a data URL. */
interface DrawerAttachment {
  readonly id: string;
  readonly type: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly previewUrl: string;
  readonly file: File;
}

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

/**
 * The text a send puts on the wire, or `null` when there is nothing to send.
 *
 * Files alone are a message: the prompt stands in for the words so the child
 * gets an instruction rather than an empty turn.
 */
export function resolveSubagentDrawerMessageText(
  draft: string,
  attachmentCount: number,
): string | null {
  const trimmed = draft.trim();
  if (trimmed.length > 0) return trimmed;
  return attachmentCount > 0 ? SUBAGENT_DRAWER_ATTACHMENT_ONLY_PROMPT : null;
}

/** The size and extension line under an attachment chip's name. */
export function subagentDrawerAttachmentMeta(name: string, sizeBytes: number): string {
  return [attachmentExtensionLabel(name), formatAttachmentSize(sizeBytes)]
    .filter((part) => part.length > 0)
    .join(" · ");
}

interface SentMessage {
  readonly id: number;
  readonly text: string;
  readonly attachmentNames: ReadonlyArray<string>;
  readonly delivery: ThreadTurnStartDelivery;
  readonly status: "sending" | "sent";
}

export function SubagentDrawerComposer({
  childThreadRef,
  childLatestTurn,
  driver,
  providerLabel,
  skills,
  onSend,
}: {
  childThreadRef: ScopedThreadRef;
  childLatestTurn: Pick<OrchestrationLatestTurn, "state"> | null;
  /** The child's own driver, or null when its session has not named one yet. */
  driver: ProviderDriverKind | null;
  providerLabel: string;
  skills: ReadonlyArray<ServerProviderSkill>;
  onSend: (
    text: string,
    delivery: ThreadTurnStartDelivery,
    attachments: ReadonlyArray<UploadChatAttachment>,
  ) => Promise<SubagentCommandFailure | null>;
}) {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const filePickerRef = useRef<HTMLInputElement>(null);
  const nextSentIdRef = useRef(0);
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [attachments, setAttachments] = useState<ReadonlyArray<DrawerAttachment>>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState<ReadonlyArray<SentMessage>>([]);
  const delivery = resolveSubagentDrawerDelivery(childLatestTurn);

  const attachFiles = (files: ReadonlyArray<File>) => {
    if (files.length === 0) return;
    const { accepted, error } = screenComposerAttachments(files, {
      driver,
      providerLabel,
      attachedCount: attachments.length,
    });
    if (accepted.length > 0) {
      setAttachments((current) => [
        ...current,
        ...accepted.map(({ file, kind }) => ({
          id: randomUUID(),
          type: kind,
          name: file.name || (kind === "image" ? "image" : "file"),
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          previewUrl: URL.createObjectURL(file),
          file,
        })),
      ]);
    }
    setSendError(error);
  };

  // Every preview URL here is a blob this component made, so it also frees it.
  const releasePreviews = (released: ReadonlyArray<DrawerAttachment>) => {
    for (const attachment of released) URL.revokeObjectURL(attachment.previewUrl);
  };

  const removeAttachment = (attachmentId: string) => {
    releasePreviews(attachments.filter((attachment) => attachment.id === attachmentId));
    setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
  };

  const send = async () => {
    const staged = attachments;
    const text = resolveSubagentDrawerMessageText(draft, staged.length);
    if (text === null) return;
    const id = nextSentIdRef.current++;
    setSendError(null);
    let uploads: ReadonlyArray<UploadChatAttachment>;
    try {
      uploads = await Promise.all(
        staged.map(async (attachment) => ({
          type: attachment.type,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          dataUrl: await readFileAsDataUrl(attachment.file),
        })),
      );
    } catch {
      setSendError(SUBAGENT_DRAWER_ATTACHMENT_READ_ERROR);
      return;
    }
    setSent((current) => [
      ...current,
      {
        id,
        text,
        attachmentNames: staged.map((attachment) => attachment.name),
        delivery,
        status: "sending",
      },
    ]);
    const failure = await onSend(text, delivery, uploads);
    if (failure === null) {
      // Only clear the draft once the send is accepted, so a failure never
      // costs the human what they typed or picked.
      setDraft("");
      setCursor(0);
      releasePreviews(staged);
      setAttachments([]);
      setSent((current) =>
        current.map((message) => (message.id === id ? { ...message, status: "sent" } : message)),
      );
      return;
    }
    setSent((current) => current.filter((message) => message.id !== id));
    setSendError(failure.message);
  };

  const hasSendableContent = resolveSubagentDrawerMessageText(draft, attachments.length) !== null;

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
              {message.attachmentNames.length > 0 ? (
                <div className="mt-1 text-muted-foreground">
                  {message.attachmentNames.join(", ")}
                </div>
              ) : null}
              <div className="mt-1 text-muted-foreground">
                {subagentDrawerSentLabel(message.status, message.delivery)}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {sendError ? <p className="text-xs text-destructive">{sendError}</p> : null}
      <p className="text-xs text-muted-foreground">{subagentDrawerNotice(delivery)}</p>

      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <div
              className="relative flex max-w-56 items-center gap-2 rounded-lg border border-border/80 bg-background py-1.5 pe-7 ps-2"
              key={attachment.id}
            >
              {attachment.type === "image" ? (
                <img
                  alt={attachment.name}
                  className="size-8 shrink-0 rounded object-cover"
                  src={attachment.previewUrl}
                />
              ) : (
                <FileIcon className="size-4 shrink-0 text-muted-foreground/70" />
              )}
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-xs" title={attachment.name}>
                  {attachment.name}
                </span>
                <span className="text-[10px] text-muted-foreground/70">
                  {subagentDrawerAttachmentMeta(attachment.name, attachment.sizeBytes)}
                </span>
              </div>
              <button
                aria-label={`Remove ${attachment.name}`}
                className="absolute right-1 top-1 rounded p-0.5 text-muted-foreground/70 hover:text-foreground"
                onClick={() => removeAttachment(attachment.id)}
                type="button"
              >
                <XIcon aria-hidden className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          className="hidden"
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            // Reset so picking the same file again re-triggers the change event.
            event.target.value = "";
            attachFiles(files);
          }}
          ref={filePickerRef}
          type="file"
        />
        <Button
          aria-label="Attach files"
          onClick={() => filePickerRef.current?.click()}
          size="icon"
          title="Attach files"
          type="button"
          variant="ghost"
        >
          <PaperclipIcon aria-hidden />
        </Button>
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
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length === 0) return;
              event.preventDefault();
              attachFiles(files);
            }}
            onRemoveTerminalContext={() => undefined}
            placeholder={SUBAGENT_DRAWER_PLACEHOLDER}
            skills={skills}
            terminalContexts={[]}
            value={draft}
          />
        </div>
        <Button
          aria-label="Send to subagent"
          disabled={!hasSendableContent}
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
