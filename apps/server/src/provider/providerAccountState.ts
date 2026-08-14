import type { ProviderAccountLimit, ProviderUsageSample, ServerProvider } from "@t3tools/contracts";

/**
 * Join an account's usage-ledger samples and account-limit rows onto its
 * provider snapshot.
 *
 * `samples` / `limits` are `undefined` when the backing store was unavailable
 * or the read failed — losing a store costs the snapshot that field, never the
 * snapshot itself.
 *
 * Liveness matches `maxLiveUtilizationByInstance` in
 * `packages/epic-core/src/epicSubagents.ts`: a row whose `resetsAt` has passed
 * says only what the last poll saw, so it is dropped; a null `resetsAt` stays.
 * The UI and the router must never disagree on which windows count.
 *
 * `usage` is set only when at least one live window exists. A driver with no
 * usage reader (kimi, opencode, cursor, grok, prime today) records no samples,
 * so its snapshot omits the field — an empty-but-present array would read as
 * "zero usage". `limit` is the newest live block, or null when the store
 * answered and found none.
 */
export const stampProviderAccountState = (input: {
  readonly provider: ServerProvider;
  readonly samples: ReadonlyArray<ProviderUsageSample> | undefined;
  readonly limits: ReadonlyArray<ProviderAccountLimit> | undefined;
  readonly nowIso: string;
}): ServerProvider => {
  const { usage: _usage, limit: _limit, ...base } = input.provider;
  let next: ServerProvider = base;

  if (input.samples !== undefined) {
    const liveUsage = input.samples.filter(
      (sample) =>
        sample.providerInstanceId === input.provider.instanceId &&
        (sample.resetsAt === null || sample.resetsAt > input.nowIso),
    );
    if (liveUsage.length > 0) {
      next = { ...next, usage: liveUsage };
    }
  }

  if (input.limits !== undefined) {
    const liveLimits = input.limits.filter(
      (limit) =>
        limit.providerInstanceId === input.provider.instanceId &&
        (limit.resetsAt === null || limit.resetsAt > input.nowIso),
    );
    const currentLimit = [...liveLimits].sort((left, right) =>
      right.detectedAt.localeCompare(left.detectedAt),
    )[0];
    next = { ...next, limit: currentLimit ?? null };
  }

  return next;
};
