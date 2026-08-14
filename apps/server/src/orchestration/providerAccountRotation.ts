/**
 * providerAccountRotation moves an interactive thread to a sibling account
 * of the same driver after a usage-limit turn failure.
 *
 * Epic runs already rotate accounts between iterations. An interactive chat
 * thread had no rotation at all: a spend-limit refusal settled the turn as an
 * error and the conversation stopped. This module holds the pure decision
 * logic; `ProviderRuntimeIngestion` wires it to the failed-turn chokepoint
 * and dispatches the rebind (`thread.meta.update`) plus the visible
 * `provider.account.rotated` activity.
 *
 * ## Rotation never leaves the harness
 *
 * Continuation is keyed per instance by
 * `ProviderInstance.continuationIdentity` / `continuation.groupKey`
 * (apps/server/src/provider/ProviderDriver.ts:65-80,
 * packages/contracts/src/server.ts:119-122). A different driver cannot
 * continue the conversation, so the walk is
 * `resolveSameDriverSiblingRotation`. It stays in one driver and does not use
 * the stage walk.
 *
 * ## What rotation does with conversation history
 *
 * Decision: rotation only uses a sibling with the same continuation group.
 * It stops the failing provider session before it rebinds the thread. The
 * persisted cursor then continues the provider conversation on the sibling.
 *
 * - Codex keys continuation on the shared home
 *   (apps/server/src/provider/Drivers/CodexHomeLayout.ts:55), so sibling
 *   accounts share one group key and the persisted resume cursor is
 *   inherited across the rebind. The sibling resumes the same provider
 *   conversation. `ProviderService.startSession` accepts a persisted binding
 *   from another instance when its persisted continuation identity matches
 *   the new instance's (apps/server/src/provider/Layers/ProviderService.ts,
 *   `bindingContinuesConversation`). This is the preferred shape.
 * - Claude keys continuation on its resolved config home
 *   (apps/server/src/provider/Drivers/ClaudeHome.ts:37-42). Two accounts
 *   normally use different group keys. T3 Code refuses that switch and adds
 *   a visible activity. The server has no transcript replay path, so starting
 *   an empty provider session would make the timeline imply context that the
 *   provider did not receive.
 *
 * @module providerAccountRotation
 */
import {
  type ModelSelection,
  type ProviderAccountLimit,
  type ProviderInstanceId,
  type ProviderUsageSample,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import { resolveSameDriverSiblingRotation } from "@t3tools/epic-core/providerFallback";
import { isLiveProviderDegradation } from "@t3tools/epic-core/providerDegradation";
import { isAccountExhausted, maxLiveUtilizationByInstance } from "@t3tools/epic-core/epicSubagents";
import { detectProviderError } from "@t3tools/epic-core/ralphProtocol";

/**
 * Only limit-shaped failures rotate. Auth failures and outages follow the
 * existing error path: rotating on them would mask a misconfiguration with
 * an account switch.
 */
export type AccountRotationReason = "spend-limit" | "rate-limit";

/** The failure categories that mean "this account is out of budget". */
export const classifyAccountRotationReason = (message: string): AccountRotationReason | null => {
  const match = detectProviderError(message);
  if (match === null) return null;
  return match.category === "spend-limit" || match.category === "rate-limit"
    ? match.category
    : null;
};

/**
 * Accounts a rotation must not land on, mirroring launch selection
 * (apps/server/src/runner/Layers/EpicRunnerLaunch.ts): a live max utilization
 * at or above 100, or a live usage-limit/spend-limit row. Auth, unavailable,
 * and credits-depleted rows never exhaust. Unknown utilization never
 * exhausts. Limit rows reuse the degradation liveness rule: the account's own
 * reset time wins, and the flat TTL covers only rows without one.
 */
export const buildExhaustedAccountBlocklist = (input: {
  readonly limits: ReadonlyArray<ProviderAccountLimit>;
  readonly samples: ReadonlyArray<ProviderUsageSample>;
  readonly now: string;
  readonly degradationTtlMs: number;
}): ReadonlySet<ProviderInstanceId> => {
  const blocked = new Set<ProviderInstanceId>();
  const cutoff = DateTime.formatIso(
    DateTime.subtractDuration(
      DateTime.makeUnsafe(input.now),
      Duration.millis(input.degradationTtlMs),
    ),
  );

  const utilization = maxLiveUtilizationByInstance(input.samples, input.now);
  for (const [instanceId, value] of utilization) {
    if (isAccountExhausted({ utilization: value })) {
      blocked.add(instanceId);
    }
  }

  for (const limit of input.limits) {
    if (limit.kind !== "usage-limit" && limit.kind !== "spend-limit") continue;
    const asRecord = {
      failureReason: limit.kind,
      degradedAt: limit.detectedAt,
      resetsAt: limit.resetsAt,
    };
    if (isLiveProviderDegradation(asRecord, cutoff, input.now)) {
      blocked.add(limit.providerInstanceId);
    }
  }

  return blocked;
};

/**
 * The sibling account the thread should rebind to, or null when no eligible
 * sibling exists. Same driver only; the failing instance and every blocked
 * instance are skipped.
 */
export const resolveAccountRotationTarget = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
  readonly failingInstanceId: ProviderInstanceId;
  readonly blocked: ReadonlySet<ProviderInstanceId>;
}): ModelSelection | null =>
  resolveSameDriverSiblingRotation({
    providers: input.providers,
    current: input.current,
    isBlocked: (instanceId) =>
      instanceId === input.failingInstanceId || input.blocked.has(instanceId),
  });

/**
 * The user-facing sentence for the rotation activity. The shared classifier
 * folds usage-limit refusals into `spend-limit`, so that category prints as
 * "usage limit", which is the phrase the provider showed the user.
 */
export const accountRotationSummary = (input: {
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly reason: AccountRotationReason;
  readonly fromModel: string;
  readonly toModel: string;
}): string => {
  const limit = input.reason === "spend-limit" ? "usage limit" : "rate limit";
  const modelSwitch =
    input.fromModel === input.toModel
      ? ""
      : ` The model also changed from '${input.fromModel}' to '${input.toModel}'.`;
  return `Account '${input.fromLabel}' hit its ${limit}. This thread now uses account '${input.toLabel}'.${modelSwitch}`;
};

export const accountRotationRefusedSummary = (input: {
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly reason: AccountRotationReason;
}): string => {
  const limit = input.reason === "spend-limit" ? "usage limit" : "rate limit";
  return `Account '${input.fromLabel}' hit its ${limit}. T3 Code kept this account because '${input.toLabel}' cannot continue its provider session.`;
};
