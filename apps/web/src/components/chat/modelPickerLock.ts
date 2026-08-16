export function matchesLockedContinuation(input: {
  readonly entry: {
    readonly driverKind: string;
    readonly continuationGroupKey?: string | undefined;
  };
  readonly lockedProvider: string | null;
  readonly lockedContinuationGroupKey: string | null;
}): boolean {
  if (input.lockedProvider === null) return true;
  if (input.entry.driverKind !== input.lockedProvider) return false;
  if (!input.lockedContinuationGroupKey) return true;
  return input.entry.continuationGroupKey === input.lockedContinuationGroupKey;
}
