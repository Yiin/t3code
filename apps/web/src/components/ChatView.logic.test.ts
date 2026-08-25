import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage, Thread } from "../types";
import {
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  buildExpiredTerminalContextToastCopy,
  buildThreadTurnInterruptInput,
  cloneComposerImageForRetry,
  decideAttachmentPreviewPromotions,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  getStartedThreadModelChangeBlockReason,
  hasServerAcknowledgedLocalDispatch,
  isExpiredUploadFailureMessage,
  migrateDraftErrorEntry,
  prepareSendAction,
  reconcileMountedTerminalThreadIds,
  reconcileRetainedMountedThreadIds,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  shouldWriteThreadErrorToCurrentServerThread,
} from "./ChatView.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    subagents: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    ...overrides,
  };
}

const completedTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  threadId,
  status: "ready" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

function imageMessage(id: string, previewUrl?: string): ChatMessage {
  return {
    id: MessageId.make(id),
    role: "user",
    text: "image",
    turnId: null,
    streaming: false,
    createdAt: now,
    updatedAt: now,
    attachments: [
      {
        type: "image",
        id: `attachment-${id}`,
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 1,
        ...(previewUrl ? { previewUrl } : {}),
      },
    ],
  };
}

describe("draft promotion reconciliation", () => {
  it("keeps the newer server error", () => {
    expect(
      migrateDraftErrorEntry({ message: "draft", at: 1 }, { message: "server", at: 2 }),
    ).toBeNull();
  });

  it("migrates a newer draft error", () => {
    expect(
      migrateDraftErrorEntry({ message: "draft", at: 2 }, { message: "server", at: 1 }),
    ).toEqual({
      message: "draft",
      at: 2,
    });
  });

  it("promotes matching non-blob server previews only", () => {
    expect(
      decideAttachmentPreviewPromotions({ "message-1": ["blob:local"] }, [
        imageMessage("message-1", "https://cdn/image.png"),
      ]),
    ).toEqual([{ messageId: "message-1", previewUrls: ["https://cdn/image.png"] }]);
    expect(
      decideAttachmentPreviewPromotions({ "message-1": ["blob:local", "blob:other"] }, [
        imageMessage("message-1", "https://cdn/image.png"),
      ]),
    ).toEqual([]);
    expect(
      decideAttachmentPreviewPromotions({ "message-1": ["blob:local"] }, [
        imageMessage("message-1", "blob:server"),
      ]),
    ).toEqual([]);
  });
});

describe("resolveThreadMetadataUpdateForNextTurn", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("updates a stale local thread branch to the active checkout", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({ branch: "feature/checkout", worktreePath: null });
  });

  it("does not write metadata when the model and branch are unchanged", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: "feature/current",
        nextBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("buildThreadTurnInterruptInput", () => {
  it("targets the session's active running turn", () => {
    const activeTurnId = TurnId.make("turn-running");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: activeTurnId });
  });

  it("omits a turn id when the session is not running", () => {
    expect(buildThreadTurnInterruptInput(makeThread({ session: readySession }))).toEqual({
      threadId,
    });
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats element contexts as sendable content (no text, no images, no terminals)", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });

  it("does NOT treat zero element contexts as sendable", () => {
    expect(
      deriveComposerSendState({
        prompt: "",
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false);
  });

  it("blocks sending with an upload-in-progress reason while any attachment uploads", () => {
    const state = deriveComposerSendState({
      prompt: "hello",
      imageCount: 1,
      terminalContexts: [],
      attachmentUploadStatuses: ["done", "uploading"],
    });
    expect(state.attachmentUploadBlockedReason).toBe("Send blocked: upload in progress");
  });

  it("blocks sending with an upload-failed reason when none are uploading but one failed", () => {
    const state = deriveComposerSendState({
      prompt: "hello",
      imageCount: 1,
      terminalContexts: [],
      attachmentUploadStatuses: ["done", "failed"],
    });
    expect(state.attachmentUploadBlockedReason).toBe("Send blocked: an upload failed");
  });

  it("does not block sending once every attachment is done", () => {
    const state = deriveComposerSendState({
      prompt: "hello",
      imageCount: 2,
      terminalContexts: [],
      attachmentUploadStatuses: ["done", "done"],
    });
    expect(state.attachmentUploadBlockedReason).toBeNull();
  });

  it("does not block sending when no attachments are staged", () => {
    const state = deriveComposerSendState({
      prompt: "hello",
      imageCount: 0,
      terminalContexts: [],
    });
    expect(state.attachmentUploadBlockedReason).toBeNull();
  });
});

describe("prepareSendAction", () => {
  const baseInput = {
    draftText: "hello",
    imageCount: 0,
    terminalContexts: [],
    elementContextCount: 0,
    showPlanFollowUpPrompt: false,
    planMarkdown: null,
    activeProject: true,
    isFirstMessage: false,
    sendEnvMode: "local" as const,
    activeThreadWorktreePath: null,
    activeThreadBranch: null,
  };

  it("gives plan follow-up precedence over every other branch", () => {
    expect(
      prepareSendAction({
        ...baseInput,
        draftText: "",
        showPlanFollowUpPrompt: true,
        planMarkdown: "- Do the work",
      }),
    ).toEqual({
      _tag: "plan-follow-up",
      text: "PLEASE IMPLEMENT THIS PLAN:\n- Do the work",
      interactionMode: "default",
    });
  });

  it("recognizes standalone slash commands before empty content", () => {
    expect(prepareSendAction({ ...baseInput, draftText: "/plan" })).toEqual({
      _tag: "slash-command",
      command: "plan",
    });
  });

  it("reports expired terminal context when no sendable content remains", () => {
    expect(
      prepareSendAction({
        ...baseInput,
        draftText: "\uFFFC",
        terminalContexts: [
          {
            id: "expired",
            threadId,
            terminalId: "default",
            terminalLabel: "Terminal 1",
            lineStart: 1,
            lineEnd: 1,
            text: "",
            createdAt: now,
          },
        ],
      }),
    ).toEqual({ _tag: "empty", expiredTerminalContextCount: 1 });
  });

  it("checks the project before the worktree base branch", () => {
    expect(
      prepareSendAction({
        ...baseInput,
        activeProject: false,
        isFirstMessage: true,
        sendEnvMode: "worktree",
      }),
    ).toEqual({ _tag: "missing-project" });
  });

  it("requires a base branch for a new worktree", () => {
    expect(
      prepareSendAction({
        ...baseInput,
        isFirstMessage: true,
        sendEnvMode: "worktree",
      }),
    ).toEqual({ _tag: "missing-base-branch" });
  });

  it("returns send data when all guards pass", () => {
    expect(
      prepareSendAction({
        ...baseInput,
        isFirstMessage: true,
        sendEnvMode: "worktree",
        activeThreadBranch: "main",
      }),
    ).toEqual({
      _tag: "send",
      trimmedPrompt: "hello",
      sendableTerminalContexts: [],
      expiredTerminalContextCount: 0,
      baseBranchForWorktree: "main",
    });
  });

  it("blocks the send while an attachment uploads, ahead of the project/branch checks", () => {
    expect(
      prepareSendAction({
        ...baseInput,
        activeProject: false,
        attachmentUploadStatuses: ["uploading"],
      }),
    ).toEqual({ _tag: "attachment-upload-blocked", reason: "Send blocked: upload in progress" });
  });

  it("blocks the send when an attachment upload failed", () => {
    expect(
      prepareSendAction({
        ...baseInput,
        attachmentUploadStatuses: ["failed"],
      }),
    ).toEqual({ _tag: "attachment-upload-blocked", reason: "Send blocked: an upload failed" });
  });

  it("does not block a plan follow-up on attachment upload state", () => {
    expect(
      prepareSendAction({
        ...baseInput,
        draftText: "",
        showPlanFollowUpPrompt: true,
        planMarkdown: "- Do the work",
        attachmentUploadStatuses: ["uploading"],
      }),
    ).toEqual({
      _tag: "plan-follow-up",
      text: "PLEASE IMPLEMENT THIS PLAN:\n- Do the work",
      interactionMode: "default",
    });
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats empty and omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("getStartedThreadModelChangeBlockReason", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
    },
    {
      instanceId: ProviderInstanceId.make("grok"),
      requiresNewThreadForModelChange: true,
    },
  ];

  it("allows model changes before a provider session has started", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: false,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toBeNull();
  });

  it("allows unchanged model selections for restricted providers", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toBeNull();
  });

  it("blocks started-session model changes when either provider requires a new thread", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toEqual({
      title: "Start a new chat to change models",
      description:
        "This provider does not allow switching models after a conversation has started.",
    });
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps open threads and makes the active thread most recent", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["thread-a", "thread-b", "thread-c"],
        openThreadIds: ["thread-a", "thread-b", "thread-c"],
        activeThreadId: "thread-a",
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual(["thread-b", "thread-c", "thread-a"]);
  });

  it("drops closed threads and enforces the hidden mounted cap", () => {
    const ids = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => `thread-${index}`,
    );
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ids,
        openThreadIds: ids.slice(1),
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(ids.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("reconcileRetainedMountedThreadIds", () => {
  it("retains hidden open threads and adds the active open thread", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden")],
        openThreadIds: [ThreadId.make("thread-hidden")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: true,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("can retain the active thread as hidden when it is inactive", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-active")],
        openThreadIds: [ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
        retainInactiveActiveThread: true,
      }),
    ).toEqual([ThreadId.make("thread-active")]);
  });

  it("evicts the oldest hidden threads beyond the configured cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_PREVIEW_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("requires the environment, route thread, and target thread to match", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: { environmentId, id: threadId },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: null,
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("does not acknowledge unchanged server state", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: completedTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges a settled newer turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const newerTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: newerTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      state: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: TurnId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: runningTurn.turnId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a steering message projected onto the current running turn", () => {
    const runningTurn = {
      ...completedTurn,
      state: "running" as const,
      completedAt: null,
    };
    const runningSession = {
      ...readySession,
      status: "running" as const,
      activeTurnId: runningTurn.turnId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        latestTurn: runningTurn,
        session: runningSession,
        messages: [
          {
            id: MessageId.make("message-before-steer"),
            role: "user",
            text: "Initial prompt",
            turnId: runningTurn.turnId,
            createdAt: runningTurn.requestedAt,
            updatedAt: runningTurn.requestedAt,
            streaming: false,
          },
        ],
      }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: MessageId.make("message-steer"),
        session: runningSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges pending user interaction and errors immediately", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestTurn: null,
      latestUserMessageId: localDispatch.latestUserMessageId,
      session: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: "failed" })).toBe(true);
  });
});

describe("cloneComposerImageForRetry", () => {
  const attachment = {
    type: "file" as const,
    id: "attachment-1",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    previewUrl: "",
    file: { name: "notes.txt" } as unknown as File,
    upload: { status: "done" as const, uploadId: "upload-1" },
  };

  it("keeps a completed upload when the send failed for another reason", () => {
    expect(cloneComposerImageForRetry(attachment).upload).toEqual({
      status: "done",
      uploadId: "upload-1",
    });
  });

  // A dead uploadId that still reads as "done" shows no Retry button, so the
  // user can only remove and re-add the file. Reset it to failed instead.
  it("resets a completed upload to failed when the server said it expired", () => {
    expect(cloneComposerImageForRetry(attachment, { uploadExpired: true }).upload).toEqual({
      status: "failed",
      error: "Upload expired. Retry.",
    });
  });

  it("leaves an already-failed upload untouched", () => {
    const failed = { ...attachment, upload: { status: "failed" as const, error: "Nope." } };
    expect(cloneComposerImageForRetry(failed, { uploadExpired: true }).upload).toEqual({
      status: "failed",
      error: "Nope.",
    });
  });
});

describe("isExpiredUploadFailureMessage", () => {
  it("matches the Normalizer's expired-upload error", () => {
    expect(
      isExpiredUploadFailureMessage("Attachment 'notes.txt' upload expired, attach it again."),
    ).toBe(true);
  });

  it("does not match an unrelated send failure", () => {
    expect(isExpiredUploadFailureMessage("Failed to persist attachment 'notes.txt'.")).toBe(false);
  });
});
