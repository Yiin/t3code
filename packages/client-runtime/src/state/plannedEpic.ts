import type { EpicPlanCorrelation, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentThread } from "./models.ts";

export interface ScopedEpicPlanCorrelation extends EpicPlanCorrelation {
  readonly environmentId: ScopedThreadRef["environmentId"];
}

export function resolveLatestFinalizedPlannedEpic(
  thread: EnvironmentThread | null,
): ScopedEpicPlanCorrelation | null {
  if (thread === null) {
    return null;
  }
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (
      message?.role === "assistant" &&
      !message.streaming &&
      message.correlation !== undefined &&
      message.correlation.threadId === thread.id &&
      message.correlation.projectId === thread.projectId
    ) {
      return { environmentId: thread.environmentId, ...message.correlation };
    }
  }
  return null;
}

export function latestFinalizedPlannedEpicAtom(
  threadAtom: Atom.Atom<EnvironmentThread | null>,
): Atom.Atom<ScopedEpicPlanCorrelation | null> {
  return Atom.make((get) => resolveLatestFinalizedPlannedEpic(get(threadAtom)));
}
