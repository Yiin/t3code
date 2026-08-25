import {
  type EnvironmentId,
  isProviderDriverKind,
  ProjectId,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { type ChatMessage, type SessionPhase, type Thread } from "../types";
import { type ComposerImageAttachment, type DraftThreadState } from "../composerDraftStore";
import * as Schema from "effect/Schema";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import type { DraftThreadEnvMode } from "../composerDraftStore";
import { parseStandaloneComposerSlashCommand, type ComposerSlashCommand } from "../composer-logic";
import { resolvePlanFollowUpSubmission } from "../proposedPlan";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;
export const MAX_HIDDEN_MOUNTED_PREVIEW_THREADS = 3;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function resolveThreadMetadataUpdateForNextTurn(input: {
  currentModelSelection: ModelSelection;
  nextModelSelection?: ModelSelection;
  currentBranch: string | null;
  nextBranch?: string;
}): {
  modelSelection?: ModelSelection;
  branch?: string;
  worktreePath?: null;
} | null {
  const nextModelSelection = input.nextModelSelection;
  const modelSelectionChanged =
    nextModelSelection !== undefined &&
    (nextModelSelection.model !== input.currentModelSelection.model ||
      nextModelSelection.instanceId !== input.currentModelSelection.instanceId ||
      JSON.stringify(nextModelSelection.options ?? null) !==
        JSON.stringify(input.currentModelSelection.options ?? null));
  const branchChanged = input.nextBranch !== undefined && input.nextBranch !== input.currentBranch;
  if (!modelSelectionChanged && !branchChanged) {
    return null;
  }
  return {
    ...(modelSelectionChanged ? { modelSelection: nextModelSelection } : {}),
    ...(branchChanged ? { branch: input.nextBranch, worktreePath: null } : {}),
  };
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    createdAt: draftThread.createdAt,
    updatedAt: draftThread.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    parentThreadId: null,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    checkpoints: [],
    activities: [],
    proposedPlans: [],
    subagents: [],
  };
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  serverThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.serverThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.serverThread.environmentId === input.routeThreadRef.environmentId &&
    input.serverThread.id === input.targetThreadId,
  );
}

type ThreadTurnInterruptInput = {
  threadId: ThreadId;
  turnId?: TurnId;
};

export function buildThreadTurnInterruptInput(
  thread: Pick<Thread, "id" | "session">,
): ThreadTurnInterruptInput {
  const runningTurnId = thread.session?.status === "running" ? thread.session.activeTurnId : null;
  return {
    threadId: thread.id,
    ...(runningTurnId !== null ? { turnId: runningTurnId } : {}),
  };
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  return reconcileRetainedMountedThreadIds({
    currentThreadIds: input.currentThreadIds,
    openThreadIds: input.openThreadIds,
    activeThreadId: input.activeThreadId,
    activeThreadOpen: input.activeThreadTerminalOpen,
    maxHiddenThreadCount: input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  });
}

export function reconcileRetainedMountedThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadOpen: boolean;
  maxHiddenThreadCount: number;
  retainInactiveActiveThread?: boolean;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) =>
      (threadId !== input.activeThreadId || input.retainInactiveActiveThread === true) &&
      openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(0, input.maxHiddenThreadCount);
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export type DraftErrorEntry = {
  readonly message: string | null;
  readonly at: number;
};

export function migrateDraftErrorEntry(
  draftEntry: DraftErrorEntry,
  serverEntry: DraftErrorEntry | undefined,
): DraftErrorEntry | null {
  if (
    serverEntry !== undefined &&
    (serverEntry.at > draftEntry.at || serverEntry.message === draftEntry.message)
  ) {
    return null;
  }
  return draftEntry;
}

export type AttachmentPreviewHandoff = Readonly<Record<string, ReadonlyArray<string>>>;

export function decideAttachmentPreviewPromotions(
  handoffs: AttachmentPreviewHandoff,
  serverMessages: ReadonlyArray<ChatMessage>,
): Array<{ messageId: string; previewUrls: string[] }> {
  const serverMessagesById = new Map(
    serverMessages
      .filter((message) => message.role === "user")
      .map((message) => [String(message.id), message] as const),
  );
  return Object.entries(handoffs).flatMap(([messageId, handoffPreviewUrls]) => {
    const serverMessage = serverMessagesById.get(messageId);
    const serverPreviewUrls = (serverMessage?.attachments ?? []).flatMap((attachment) =>
      attachment.type === "image" && attachment.previewUrl ? [attachment.previewUrl] : [],
    );
    if (
      serverPreviewUrls.length === 0 ||
      serverPreviewUrls.length !== handoffPreviewUrls.length ||
      serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
    ) {
      return [];
    }
    return [{ messageId, previewUrls: serverPreviewUrls }];
  });
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

/**
 * The wire shape for one attachment on send: the `uploadId` a completed
 * `POST /api/attachments` staged (`apps/web/src/lib/attachmentUpload.ts`),
 * never the file bytes. `null` when the attachment has not finished
 * uploading yet — `deriveComposerSendState` blocks sending in that case, so
 * a `null` here means the caller ignored that gate.
 */
export function composerAttachmentToUploadRef(
  attachment: ComposerImageAttachment,
): UploadChatAttachment | null {
  if (attachment.upload.status !== "done") {
    return null;
  }
  const { name, mimeType, sizeBytes } = attachment;
  const uploadId = attachment.upload.uploadId;
  return attachment.type === "image"
    ? { type: "image", name, mimeType, sizeBytes, uploadId }
    : { type: "file", name, mimeType, sizeBytes, uploadId };
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

/**
 * True when a turn-start failure says the server could not find a staged
 * upload. The Normalizer keeps consumed uploads on disk until the whole batch
 * commits, so this only fires once the hourly sweep has expired one.
 */
export function isExpiredUploadFailureMessage(message: string): boolean {
  return /upload expired/i.test(message);
}

export const EXPIRED_UPLOAD_RETRY_ERROR = "Upload expired. Retry.";

/**
 * Restores one attachment onto the draft after a failed send. The blob
 * preview URL is remade because the optimistic message that owned the old one
 * is being revoked.
 *
 * `uploadExpired` resets a completed upload to `failed`, so the chip shows
 * Retry and re-uploads from `image.file`. Without it a dead `uploadId` would
 * read as `done` and every further send would fail the same way.
 */
export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
  options?: { readonly uploadExpired?: boolean },
): ComposerImageAttachment {
  const upload: ComposerImageAttachment["upload"] =
    options?.uploadExpired === true && image.upload.status === "done"
      ? { status: "failed", error: EXPIRED_UPLOAD_RETRY_ERROR }
      : image.upload;
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return upload === image.upload ? image : { ...image, upload };
  }
  try {
    return {
      ...image,
      upload,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return upload === image.upload ? image : { ...image, upload };
  }
}

/**
 * Why attachment upload state blocks a send, or `null` when it does not.
 * Every composer calls this so the block reads with one wording.
 */
export function attachmentUploadBlockedReason(
  statuses: ReadonlyArray<"uploading" | "done" | "failed">,
): string | null {
  if (statuses.some((status) => status === "uploading")) return "Send blocked: upload in progress";
  if (statuses.some((status) => status === "failed")) return "Send blocked: an upload failed";
  return null;
}

type ComposerSendState = {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
  /**
   * Why a send is blocked by attachment upload state, or `null` when none
   * is. Independent of `hasSendableContent`: a prompt can have plenty of
   * content and still not be sendable while a file is uploading or failed.
   */
  attachmentUploadBlockedReason: string | null;
};

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  /**
   * Optional element-pick attachment count. Element contexts contribute to
   * "sendable content" exactly like images and (text-bearing) terminal
   * contexts do: a prompt of just element chips is still a valid send.
   */
  elementContextCount?: number;
  /** Upload status of every attachment currently on the draft. */
  attachmentUploadStatuses?: ReadonlyArray<"uploading" | "done" | "failed"> | undefined;
}): ComposerSendState {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  const elementContextCount = options.elementContextCount ?? 0;
  const attachmentUploadStatuses = options.attachmentUploadStatuses ?? [];
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      sendableTerminalContexts.length > 0 ||
      elementContextCount > 0,
    attachmentUploadBlockedReason: attachmentUploadBlockedReason(attachmentUploadStatuses),
  };
}

export type PrepareSendAction =
  | {
      readonly _tag: "plan-follow-up";
      readonly text: string;
      readonly interactionMode: "default" | "plan";
    }
  | {
      readonly _tag: "slash-command";
      readonly command: Exclude<ComposerSlashCommand, "model">;
    }
  | { readonly _tag: "empty"; readonly expiredTerminalContextCount: number }
  | { readonly _tag: "missing-project" }
  | { readonly _tag: "missing-base-branch" }
  | { readonly _tag: "attachment-upload-blocked"; readonly reason: string }
  | {
      readonly _tag: "send";
      readonly trimmedPrompt: string;
      readonly sendableTerminalContexts: TerminalContextDraft[];
      readonly expiredTerminalContextCount: number;
      readonly baseBranchForWorktree: string | null;
    };

export function prepareSendAction(input: {
  draftText: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  elementContextCount: number;
  showPlanFollowUpPrompt: boolean;
  planMarkdown: string | null;
  activeProject: boolean;
  isFirstMessage: boolean;
  sendEnvMode: DraftThreadEnvMode;
  activeThreadWorktreePath: string | null;
  activeThreadBranch: string | null;
  attachmentUploadStatuses?: ReadonlyArray<"uploading" | "done" | "failed"> | undefined;
}): PrepareSendAction {
  const sendState = deriveComposerSendState({
    prompt: input.draftText,
    imageCount: input.imageCount,
    terminalContexts: input.terminalContexts,
    elementContextCount: input.elementContextCount,
    attachmentUploadStatuses: input.attachmentUploadStatuses,
  });

  // The upload gate applies to slash commands too: they run through this same
  // send path, and a draft can hold a failed attachment while one is typed.
  // Only a plan follow-up prompt skips it, since it sends the plan text alone.
  if (
    !input.showPlanFollowUpPrompt &&
    sendState.hasSendableContent &&
    sendState.attachmentUploadBlockedReason !== null
  ) {
    return { _tag: "attachment-upload-blocked", reason: sendState.attachmentUploadBlockedReason };
  }

  if (input.showPlanFollowUpPrompt && input.planMarkdown !== null) {
    const followUp = resolvePlanFollowUpSubmission({
      draftText: sendState.trimmedPrompt,
      planMarkdown: input.planMarkdown,
    });
    return {
      _tag: "plan-follow-up",
      text: followUp.text,
      interactionMode: followUp.interactionMode,
    };
  }

  const standaloneSlashCommand =
    input.imageCount === 0 &&
    sendState.sendableTerminalContexts.length === 0 &&
    input.elementContextCount === 0
      ? parseStandaloneComposerSlashCommand(sendState.trimmedPrompt)
      : null;
  if (standaloneSlashCommand) {
    return { _tag: "slash-command", command: standaloneSlashCommand };
  }

  if (!sendState.hasSendableContent) {
    return {
      _tag: "empty",
      expiredTerminalContextCount: sendState.expiredTerminalContextCount,
    };
  }
  if (!input.activeProject) {
    return { _tag: "missing-project" };
  }

  const shouldCreateWorktree =
    input.isFirstMessage && input.sendEnvMode === "worktree" && !input.activeThreadWorktreePath;
  if (shouldCreateWorktree && !input.activeThreadBranch) {
    return { _tag: "missing-base-branch" };
  }

  return {
    _tag: "send",
    trimmedPrompt: sendState.trimmedPrompt,
    sendableTerminalContexts: sendState.sendableTerminalContexts,
    expiredTerminalContextCount: sendState.expiredTerminalContextCount,
    baseBranchForWorktree: shouldCreateWorktree ? input.activeThreadBranch : null,
  };
}

type ExpiredTerminalContextToastCopy = { title: string; description: string };

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): ExpiredTerminalContextToastCopy {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

// `threadProvider` is the open branded driver kind carried by the session.
// Unknown driver kinds degrade to `null` (i.e. "unlocked"), which is the safe
// rollback / fork behavior — the routing layer is the right place to surface
// "driver not installed" errors, not the lock state.
//
// `selectedProvider` takes the same open-string shape because the composer
// now tracks the picker selection as a `ProviderInstanceId` (e.g.
// `codex_personal`). Custom instance ids that don't directly match a
// registered driver resolve to `null` here, which matches the existing
// "unknown driver -> unlocked" semantics. Callers that want the lock to track
// a custom instance's underlying driver kind should resolve the instance id
// upstream and pass the correlated kind.
export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: string | null;
  threadProvider: string | null;
}): ProviderDriverKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }
  const sessionProvider = input.thread?.session?.providerName ?? null;
  if (sessionProvider && isProviderDriverKind(sessionProvider)) {
    return sessionProvider;
  }
  const narrowedThreadProvider =
    input.threadProvider && isProviderDriverKind(input.threadProvider)
      ? input.threadProvider
      : null;
  const narrowedSelectedProvider =
    input.selectedProvider && isProviderDriverKind(input.selectedProvider)
      ? input.selectedProvider
      : null;
  return narrowedThreadProvider ?? narrowedSelectedProvider ?? null;
}

export function getStartedThreadModelChangeBlockReason(input: {
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "requiresNewThreadForModelChange">>;
  hasStartedSession: boolean;
  currentModelSelection: ModelSelection;
  currentProviderInstanceId?: ModelSelection["instanceId"] | null | undefined;
  nextModelSelection: ModelSelection;
}): { title: string; description: string } | null {
  if (!input.hasStartedSession) {
    return null;
  }
  const currentModelSelection = {
    ...input.currentModelSelection,
    instanceId: input.currentProviderInstanceId ?? input.currentModelSelection.instanceId,
  };
  if (
    currentModelSelection.instanceId === input.nextModelSelection.instanceId &&
    currentModelSelection.model === input.nextModelSelection.model
  ) {
    return null;
  }
  const currentProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === currentModelSelection.instanceId,
  );
  const nextProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === input.nextModelSelection.instanceId,
  );
  if (
    currentProvider?.requiresNewThreadForModelChange !== true &&
    nextProvider?.requiresNewThreadForModelChange !== true
  ) {
    return null;
  }
  return {
    title: "Start a new chat to change models",
    description: "This provider does not allow switching models after a conversation has started.",
  };
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const threadAtom = environmentThreadDetails.detailAtom(threadRef);
  const getThread = () => appAtomRegistry.get(threadAtom);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = appAtomRegistry.subscribe(threadAtom, (thread) => {
      if (!threadHasStarted(thread)) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestUserMessageId: ChatMessage["id"] | null;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionStatus: NonNullable<Thread["session"]>["status"] | null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  const latestUserMessage = activeThread?.messages.findLast((message) => message.role === "user");
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestUserMessageId: latestUserMessage?.id ?? null,
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionStatus: session?.status ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  latestUserMessageId: ChatMessage["id"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const latestUserMessageChanged =
    input.localDispatch.latestUserMessageId !== input.latestUserMessageId;
  const latestTurnChanged =
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    // Steering adds a user message to the current running turn without
    // necessarily changing any of the turn timestamps. Treat that projected
    // message as the server acknowledgment so the composer does not remain
    // stuck in its local "Sending" state until the turn settles.
    if (latestUserMessageChanged) {
      return true;
    }
    if (!latestTurnChanged) {
      return false;
    }
    if (latestTurn?.startedAt === null || latestTurn === null) {
      return false;
    }
    if (
      session?.activeTurnId !== null &&
      session?.activeTurnId !== undefined &&
      latestTurn?.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestTurnChanged ||
    input.localDispatch.sessionStatus !== (session?.status ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}
