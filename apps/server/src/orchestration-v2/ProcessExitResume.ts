import {
  CommandId,
  MessageId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type RunId,
} from "@t3tools/contracts";
import { PROVIDER_PROCESS_EXITED_CODE } from "@t3tools/provider-core/server/failure";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";

/** Automatic resumes allowed in a row before the thread waits for the user. */
export const MAX_PROCESS_EXIT_RESUMES = 3;
/** A resumed run that dies later than this after its start begins a new count. */
export const PROCESS_EXIT_RESUME_WINDOW_MS = 10 * 60 * 1000;
const PROCESS_EXIT_RESUME_BASE_DELAY_MS = 5 * 1000;

const MESSAGE_ID_PREFIX = "message:process-exit-resume:";

/** `T3CODE_RESUME_AFTER_PROCESS_DEATH=0` turns automatic resume off. */
export const processExitResumeEnabled = Effect.orElseSucceed(
  Config.Boolean("T3CODE_RESUME_AFTER_PROCESS_DEATH").pipe(Config.withDefault(true)),
  () => true,
);

export const processExitResumeEffectId = (runId: RunId) => `effect:process-exit-resume:${runId}`;

export const processExitResumeMessageId = (sourceRunId: RunId, attempt: number) =>
  MessageId.make(`${MESSAGE_ID_PREFIX}${attempt}:${sourceRunId}`);

/** 5s, 15s, 45s. */
function processExitResumeDelayMs(attempt: number): number {
  return PROCESS_EXIT_RESUME_BASE_DELAY_MS * 3 ** (attempt - 1);
}

/**
 * Which automatic resume the death of `run` would be. A run that an automatic
 * resume started and that died inside the window continues that count, so a
 * crash loop stops. Anything else, a user message or a long healthy run,
 * starts again at 1.
 */
export function processExitResumeAttempt(
  run: Pick<OrchestrationV2Run, "userMessageId" | "startedAt">,
  diedAt: DateTime.Utc,
): number {
  if (!run.userMessageId.startsWith(MESSAGE_ID_PREFIX) || run.startedAt === null) return 1;
  const previous = Number.parseInt(run.userMessageId.slice(MESSAGE_ID_PREFIX.length), 10);
  if (!Number.isInteger(previous) || previous < 1) return 1;
  const ranForMs = DateTime.toEpochMillis(diedAt) - DateTime.toEpochMillis(run.startedAt);
  return ranForMs <= PROCESS_EXIT_RESUME_WINDOW_MS ? previous + 1 : 1;
}

function processExitResumeNotice(attempt: number): string {
  if (attempt > MAX_PROCESS_EXIT_RESUMES) {
    return `The provider process exited mid-turn again. Automatic resume stopped after ${MAX_PROCESS_EXIT_RESUMES} attempts. Send a message to continue.`;
  }
  const delaySeconds = Math.round(processExitResumeDelayMs(attempt) / 1000);
  return `The provider process exited mid-turn. Resuming the session in ${delaySeconds}s (attempt ${attempt} of ${MAX_PROCESS_EXIT_RESUMES}).`;
}

/**
 * What a run's terminal write adds when its provider process died mid-turn: a
 * notice on the run, and, unless the attempts are used up, a delayed effect
 * that resumes the thread. Both commit with the run's terminal events, so a
 * Stop that wins the race leaves neither.
 */
export function planProcessExitResume(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2Shape;
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly completedAt: DateTime.Utc;
}): {
  readonly notice: OrchestrationV2TurnItem;
  readonly effects: ReadonlyArray<PendingOrchestrationEffectV2>;
} | null {
  if (input.failure.code !== PROVIDER_PROCESS_EXITED_CODE) return null;
  const attempt = processExitResumeAttempt(input.run, input.completedAt);
  const message = processExitResumeNotice(attempt);
  const notice: OrchestrationV2TurnItem = {
    id: input.idAllocator.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "process-exit-resume",
    }),
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.rootNode.id,
    providerThreadId: input.providerThread.id,
    providerTurnId: input.rootNode.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.run.ordinal * 100 + 97,
    status: "completed",
    title: "Provider process exited",
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    updatedAt: input.completedAt,
    type: "system_notice",
    message,
  };
  if (attempt > MAX_PROCESS_EXIT_RESUMES) return { notice, effects: [] };
  return {
    notice,
    effects: [
      {
        id: processExitResumeEffectId(input.run.id),
        commandId: CommandId.make(`command:effect:process-exit-resume:${input.run.id}`),
        threadId: input.run.threadId,
        request: { type: "provider-runtime.resume-after-exit", sourceRunId: input.run.id, attempt },
        availableAt: DateTime.add(input.completedAt, {
          milliseconds: processExitResumeDelayMs(attempt),
        }),
      },
    ],
  };
}
