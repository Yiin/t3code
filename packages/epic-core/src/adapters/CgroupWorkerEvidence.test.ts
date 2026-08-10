import { describe, expect, it } from "vite-plus/test";

import { PROCESS_FINGERPRINT_UNAVAILABLE, REPO_PROBE_TIMEOUT_MARKER } from "../workerLiveness.ts";
import {
  parseCgroupCpuUsec,
  parseCgroupIoBytes,
  parseCgroupProcs,
  processCommFingerprint,
  repositoryProbeLine,
  repositoryProbeTimeoutLine,
} from "./CgroupWorkerEvidence.ts";

/** A real `cpu.stat` from a systemd scope, trimmed to its first lines. */
const CPU_STAT = `usage_usec 1301990000
user_usec 1150000000
system_usec 151990000
nr_periods 0
`;

describe("parseCgroupCpuUsec", () => {
  it("reads the scope's cumulative CPU microseconds", () => {
    expect(parseCgroupCpuUsec(CPU_STAT)).toBe(1301990000);
  });

  it("reports null when the field is absent, so no delta is invented", () => {
    expect(parseCgroupCpuUsec("nr_periods 0\n")).toBeNull();
    expect(parseCgroupCpuUsec("")).toBeNull();
  });

  it("separates the 2026-08-09 wedge from a working worker", () => {
    // The incident: 21m41.153s -> 21m41.990s across 12 minutes of wall clock.
    const before = parseCgroupCpuUsec("usage_usec 1301153000\n") ?? 0;
    const after = parseCgroupCpuUsec("usage_usec 1301990000\n") ?? 0;
    const perTick = (after - before) / ((12 * 60) / 5);
    expect(perTick).toBeLessThan(100_000);
  });
});

describe("parseCgroupIoBytes", () => {
  it("sums reads and writes across every device", () => {
    const ioStat = [
      "8:0 rbytes=1024 wbytes=2048 rios=3 wios=4 dbytes=0 dios=0",
      "8:16 rbytes=16 wbytes=32 rios=1 wios=1 dbytes=0 dios=0",
    ].join("\n");
    expect(parseCgroupIoBytes(ioStat)).toBe(1024 + 2048 + 16 + 32);
  });

  it("reports zero when the io controller is not delegated", () => {
    expect(parseCgroupIoBytes("")).toBe(0);
  });
});

describe("parseCgroupProcs", () => {
  it("keeps only process ids", () => {
    expect(parseCgroupProcs("123\n456\n\n")).toEqual(["123", "456"]);
    expect(parseCgroupProcs("")).toEqual([]);
  });
});

describe("processCommFingerprint", () => {
  it("ignores pid churn and comm order", () => {
    const left = processCommFingerprint(["node", "git", "node"]);
    const right = processCommFingerprint(["node", "node", "git"]);
    expect(left).toBe(right);
  });

  it("changes when the process shape changes", () => {
    expect(processCommFingerprint(["node", "git"])).not.toBe(processCommFingerprint(["node"]));
  });

  it("filters the comms that say nothing about progress", () => {
    expect(processCommFingerprint(["node", "sleep", "timeout"])).toBe(
      processCommFingerprint(["node"]),
    );
  });

  it("reports the machine's unavailable literal when nothing is live", () => {
    expect(processCommFingerprint([])).toBe(PROCESS_FINGERPRINT_UNAVAILABLE);
    expect(processCommFingerprint(["sleep"])).toBe(PROCESS_FINGERPRINT_UNAVAILABLE);
  });
});

describe("repositoryProbeLine", () => {
  it("changes when the worktree changes and holds when it does not", () => {
    const base = { head: "abc", status: " M src/a.ts\n", diff: "@@ -1 +1 @@\n" };
    expect(repositoryProbeLine(base)).toBe(repositoryProbeLine({ ...base }));
    expect(repositoryProbeLine(base)).not.toBe(
      repositoryProbeLine({ ...base, status: " M src/b.ts\n" }),
    );
    expect(repositoryProbeLine(base)).not.toBe(repositoryProbeLine({ ...base, head: "def" }));
  });

  it("carries the marker the machine reads as an unusable probe", () => {
    expect(repositoryProbeTimeoutLine()).toContain(REPO_PROBE_TIMEOUT_MARKER);
    expect(repositoryProbeLine({ head: "abc", status: "", diff: "" })).not.toContain(
      REPO_PROBE_TIMEOUT_MARKER,
    );
  });
});
