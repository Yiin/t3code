import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  type EpicRunPreflightResult,
} from "@t3tools/contracts";

import {
  epicRunPreflightBlockersFromError,
  epicRunPreflightModeForConfig,
  preflightAndLaunchEpicRun,
} from "./epicRunLaunch";

const stubPreflightResult = (
  overrides?: Partial<EpicRunPreflightResult>,
): EpicRunPreflightResult => ({
  ok: true,
  blockers: [],
  warnings: [],
  resolvedConfig: DEFAULT_EPIC_RUN_CONFIG,
  configProvenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  ...overrides,
});

describe("epicRunPreflightModeForConfig", () => {
  it("preflights a launch that sets no execution key as auto", () => {
    expect(epicRunPreflightModeForConfig(undefined)).toBe("auto");
    expect(epicRunPreflightModeForConfig({ vcs: { noPush: true } })).toBe("auto");
    expect(DEFAULT_EPIC_RUN_CONFIG.execution.mode).toBe("auto");
  });

  it("follows the execution mode the launch carries", () => {
    expect(epicRunPreflightModeForConfig({ execution: { mode: "parallel" } })).toBe("parallel");
    expect(epicRunPreflightModeForConfig({ execution: { mode: "sequential" } })).toBe("sequential");
  });

  it("maps the legacy execution flag the launch carries", () => {
    expect(epicRunPreflightModeForConfig({ execution: { sequential: true } })).toBe("sequential");
    expect(epicRunPreflightModeForConfig({ execution: { sequential: false } })).toBe("parallel");
  });
});

/**
 * Every web launch path has to derive its mode. A hardcoded literal here
 * blocks parallel runs over untracked files the run would have tolerated,
 * and the drift is invisible until an operator hits it.
 */
describe("web epic launch call sites", () => {
  const callSites = import.meta.glob<string>(
    [
      "./routes/_chat.epics.$environmentId.$epicId.tsx",
      "./components/EpicRunOptionsForm.tsx",
      "./components/ChatView.tsx",
    ],
    { query: "?raw", import: "default", eager: true },
  );

  it("derive the preflight mode instead of hardcoding it", () => {
    expect(Object.keys(callSites)).toHaveLength(3);
    for (const [path, source] of Object.entries(callSites)) {
      expect(source, path).toContain("epicRunPreflightModeForConfig(");
      expect(source, path).not.toContain('mode: "sequential"');
    }
  });
});

describe("preflightAndLaunchEpicRun", () => {
  it("blocks launch and reports all blockers", async () => {
    const launch = vi.fn();
    const onBlocked = vi.fn();
    await preflightAndLaunchEpicRun({
      preflightInput: { epicId: "epic-1" },
      launchInput: { epicId: "epic-1" },
      preflight: async () => ({
        _tag: "Success",
        value: stubPreflightResult({
          ok: false,
          blockers: [{ _tag: "detached_head" }, { _tag: "dirty_tree", paths: ["a.ts"] }],
        }),
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
          value: stubPreflightResult({
            warnings: [{ _tag: "nothing_ready", epicId: "epic-1" }],
          }),
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
          value: stubPreflightResult(),
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
