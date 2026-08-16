import { describe, expect, it } from "vite-plus/test";
import { matchesLockedContinuation } from "./modelPickerLock";

const entry = (driverKind: string, continuationGroupKey?: string) => ({
  driverKind,
  ...(continuationGroupKey === undefined ? {} : { continuationGroupKey }),
});

describe("matchesLockedContinuation", () => {
  it("allows every entry when unlocked", () => {
    expect(
      matchesLockedContinuation({
        entry: entry("claudeAgent", "shared"),
        lockedProvider: null,
        lockedContinuationGroupKey: null,
      }),
    ).toBe(true);
  });
  it("allows the same driver and continuation key", () => {
    expect(
      matchesLockedContinuation({
        entry: entry("claudeAgent", "shared"),
        lockedProvider: "claudeAgent",
        lockedContinuationGroupKey: "shared",
      }),
    ).toBe(true);
  });
  it("rejects a different continuation key", () => {
    expect(
      matchesLockedContinuation({
        entry: entry("claudeAgent", "other"),
        lockedProvider: "claudeAgent",
        lockedContinuationGroupKey: "shared",
      }),
    ).toBe(false);
  });
  it("rejects a missing entry key when the locked key is set", () => {
    expect(
      matchesLockedContinuation({
        entry: entry("claudeAgent"),
        lockedProvider: "claudeAgent",
        lockedContinuationGroupKey: "shared",
      }),
    ).toBe(false);
  });
  it("uses a driver-only lock when the locked key is null", () => {
    expect(
      matchesLockedContinuation({
        entry: entry("claudeAgent"),
        lockedProvider: "claudeAgent",
        lockedContinuationGroupKey: null,
      }),
    ).toBe(true);
    expect(
      matchesLockedContinuation({
        entry: entry("codex"),
        lockedProvider: "claudeAgent",
        lockedContinuationGroupKey: null,
      }),
    ).toBe(false);
  });
});
