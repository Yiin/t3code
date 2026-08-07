import { describe, expect, it, vi } from "vite-plus/test";

import { epicRunPreflightBlockersFromError, preflightAndLaunchEpicRun } from "./epicRunLaunch";

describe("preflightAndLaunchEpicRun", () => {
  it("blocks launch and reports all blockers", async () => {
    const launch = vi.fn();
    const onBlocked = vi.fn();
    await preflightAndLaunchEpicRun({
      preflightInput: { epicId: "epic-1" },
      launchInput: { epicId: "epic-1" },
      preflight: async () => ({
        _tag: "Success",
        value: {
          ok: false,
          blockers: [{ _tag: "detached_head" }, { _tag: "dirty_tree", paths: ["a.ts"] }],
          warnings: [],
        },
      }),
      launch,
      onPreflightFailure: vi.fn(),
      onBlocked,
      onWarnings: vi.fn(),
    });
    expect(launch).not.toHaveBeenCalled();
    expect(onBlocked.mock.calls[0]?.[0].blockers).toHaveLength(2);
  });

  it("shows warnings and still launches", async () => {
    const launch = vi.fn(async () => "run");
    const onWarnings = vi.fn();
    expect(
      await preflightAndLaunchEpicRun({
        preflightInput: {},
        launchInput: {},
        preflight: async () => ({
          _tag: "Success",
          value: {
            ok: true,
            blockers: [],
            warnings: [{ _tag: "nothing_ready", epicId: "epic-1" }],
          },
        }),
        launch,
        onPreflightFailure: vi.fn(),
        onBlocked: vi.fn(),
        onWarnings,
      }),
    ).toBe("run");
    expect(onWarnings).toHaveBeenCalledOnce();
  });

  it("reports a preflight command failure without other callbacks", async () => {
    const launch = vi.fn();
    const onPreflightFailure = vi.fn();
    const onBlocked = vi.fn();
    const onWarnings = vi.fn();
    expect(
      await preflightAndLaunchEpicRun({
        preflightInput: {},
        launchInput: {},
        preflight: async () => ({ _tag: "Failure", error: new Error("offline") }),
        launch,
        onPreflightFailure,
        onBlocked,
        onWarnings,
      }),
    ).toBeUndefined();
    expect(onPreflightFailure).toHaveBeenCalledOnce();
    expect(onBlocked).not.toHaveBeenCalled();
    expect(onWarnings).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("reports an interrupted preflight without launching", async () => {
    const launch = vi.fn();
    const onPreflightFailure = vi.fn();
    await preflightAndLaunchEpicRun({
      preflightInput: {},
      launchInput: {},
      preflight: async () => ({ _tag: "Interrupted" }),
      launch,
      onPreflightFailure,
      onBlocked: vi.fn(),
      onWarnings: vi.fn(),
    });
    expect(onPreflightFailure).toHaveBeenCalledWith({ _tag: "Interrupted" });
    expect(launch).not.toHaveBeenCalled();
  });

  it("returns a launch failure without treating it as a preflight failure", async () => {
    const launchFailure = { _tag: "Failure" as const, error: new Error("race blocker") };
    const callbacks = [vi.fn(), vi.fn(), vi.fn()] as const;
    expect(
      await preflightAndLaunchEpicRun({
        preflightInput: {},
        launchInput: {},
        preflight: async () => ({
          _tag: "Success",
          value: { ok: true, blockers: [], warnings: [] },
        }),
        launch: async () => launchFailure,
        onPreflightFailure: callbacks[0],
        onBlocked: callbacks[1],
        onWarnings: callbacks[2],
      }),
    ).toBe(launchFailure);
    expect(callbacks.every((callback) => callback.mock.calls.length === 0)).toBe(true);
  });

  it("extracts authoritative launch blocker strings only from the typed error", () => {
    expect(
      epicRunPreflightBlockersFromError({
        _tag: "EpicRunPreflightBlockedError",
        blockers: ["first\nline", "second"],
      }),
    ).toEqual(["first\nline", "second"]);
    expect(epicRunPreflightBlockersFromError(new Error("no"))).toBeNull();
    expect(
      epicRunPreflightBlockersFromError({
        _tag: "EpicRunPreflightBlockedError",
        blockers: [42],
      }),
    ).toBeNull();
  });
});
