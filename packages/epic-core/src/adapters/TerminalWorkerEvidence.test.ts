import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import type { WorkerRef } from "../ports/WorkerEvidence.ts";
import { makeTerminalWorkerActivity } from "./TerminalWorkerActivity.ts";
import {
  makeTerminalWorkerEvidence,
  parseWorkerScopeCgroupPath,
} from "./TerminalWorkerEvidence.ts";

/** A real `/proc/<pid>/cgroup` body for a scoped worker on the reference host. */
const SCOPED_PROC_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/cook-epic.slice/cook-epic-abc123-iteration-3.scope\n";

/** The same read for a spawn that never got a scope: the coordinator's cgroup. */
const UNSCOPED_PROC_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/t3code.service\n";

const REF: WorkerRef = { worker: "/runs/run-1/run-1-3.jsonl", repositoryPath: null };

const output = (stdout: string): ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: 0,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const evidenceOn = (input: {
  readonly activity: ReturnType<typeof makeTerminalWorkerActivity>;
  readonly procCgroup?: string | null;
  readonly calls?: ProcessRunInput[];
}) =>
  makeTerminalWorkerEvidence({
    processRunner: ProcessRunner.of({
      run: (command) =>
        Effect.sync(() => {
          input.calls?.push(command);
          return output("");
        }),
    }),
    activity: input.activity,
    readProcCgroup: () => Effect.succeed(input.procCgroup ?? null),
  });

describe("parseWorkerScopeCgroupPath", () => {
  it("resolves a worker scope to its cgroup v2 directory", () => {
    expect(parseWorkerScopeCgroupPath(SCOPED_PROC_CGROUP)).toBe(
      "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cook-epic.slice/cook-epic-abc123-iteration-3.scope",
    );
  });

  it("refuses a cgroup the worker only shares, so no sibling CPU reads as progress", () => {
    // An unwrapped spawn inherits the coordinator's cgroup. Sampling it would
    // count every other worker's CPU as this worker's progress.
    expect(parseWorkerScopeCgroupPath(UNSCOPED_PROC_CGROUP)).toBeNull();
  });

  it("ignores cgroup v1 controller lines, which carry no delegated cpu.stat", () => {
    expect(parseWorkerScopeCgroupPath("3:cpu:/cook-epic-abc123-iteration-3.scope\n")).toBeNull();
    expect(parseWorkerScopeCgroupPath("")).toBeNull();
  });
});

describe("makeTerminalWorkerEvidence", () => {
  it.effect("reports the dispatch's cumulative output bytes, never a truncated tail", () =>
    Effect.gen(function* () {
      const activity = makeTerminalWorkerActivity();
      activity.started(REF.worker, 4242);
      activity.appended(REF.worker, 900);
      activity.appended(REF.worker, 124);
      const evidence = evidenceOn({ activity, procCgroup: UNSCOPED_PROC_CGROUP });

      const sample = yield* evidence.sampleSignals(REF);
      expect(sample.outputBytes).toBe(1024);
      expect(sample.isActive).toBe(true);
      // No worker scope means no per-worker cgroup, so neither counter moves.
      expect(sample.cpuUsec).toBe(0);
      expect(sample.ioBytes).toBe(0);
    }),
  );

  it.effect("reports the worker inactive once the harness saw its child close", () =>
    Effect.gen(function* () {
      const activity = makeTerminalWorkerActivity();
      activity.started(REF.worker, 4242);
      activity.appended(REF.worker, 64);
      activity.ended(REF.worker);
      const evidence = evidenceOn({ activity, procCgroup: SCOPED_PROC_CGROUP });

      const sample = yield* evidence.sampleSignals(REF);
      // The harness owns the process, so its answer outranks an unreadable
      // cgroup, which would otherwise report the worker still alive.
      expect(sample.isActive).toBe(false);
      // The counter survives the close; a reset would read as no progress.
      expect(sample.outputBytes).toBe(64);
    }),
  );

  it.effect("reports an unknown worker active, so a missing entry never stops one", () =>
    Effect.gen(function* () {
      const evidence = evidenceOn({ activity: makeTerminalWorkerActivity() });
      const sample = yield* evidence.sampleSignals(REF);
      expect(sample.isActive).toBe(true);
      expect(sample.outputBytes).toBe(0);
    }),
  );

  it.effect("keeps counting output across a continuation's re-spawn", () =>
    Effect.gen(function* () {
      const activity = makeTerminalWorkerActivity();
      activity.started(REF.worker, 1);
      activity.appended(REF.worker, 500);
      activity.ended(REF.worker);
      activity.started(REF.worker, 2);
      activity.appended(REF.worker, 500);
      const evidence = evidenceOn({ activity, procCgroup: UNSCOPED_PROC_CGROUP });

      const sample = yield* evidence.sampleSignals(REF);
      expect(sample.outputBytes).toBe(1000);
      expect(sample.isActive).toBe(true);
    }),
  );

  it.effect("runs no git probe for a worker with no checkout", () =>
    Effect.gen(function* () {
      const calls: ProcessRunInput[] = [];
      const evidence = evidenceOn({ activity: makeTerminalWorkerActivity(), calls });
      // `repositoryPath: null` leaves the probe nowhere to run, and its timeout
      // marker never counts as progress.
      expect(yield* evidence.probeRepository(REF)).toContain("probe-timeout");
      expect(calls).toEqual([]);
    }),
  );

  it("declares no inspector until a harness can enforce the no-tool contract", () => {
    expect(evidenceOn({ activity: makeTerminalWorkerActivity() }).inspectorSupported).toBe(false);
  });
});
