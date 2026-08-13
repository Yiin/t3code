import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type { InspectorLaunchEvidence } from "../inspectorPrompt.ts";
import { DispatchError, type AgentDispatchShape } from "../ports/AgentDispatch.ts";
import type { WorkerRef } from "../ports/WorkerEvidence.ts";
import {
  disabledInspector,
  harnessSupportsInspector,
  makeAgentInspector,
} from "./AgentInspector.ts";

const REF: WorkerRef = { worker: "/runs/run-7/run-7-3.jsonl", repositoryPath: "/repo" };

const SELECTION = { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" };

const EVIDENCE: InspectorLaunchEvidence = {
  worker: REF.worker,
  child: "t3code-22o.12",
  elapsedSeconds: 5_400,
  idleSeconds: 1_800,
  outputBytes: 41_312,
  outputBytesDelta: 0,
  cpuUsecDelta: 0,
  ioBytesDelta: 0,
  processFingerprint: "9f2c1b",
  repoFingerprint: "abc123 hash=deadbeef",
};

const decision = JSON.stringify({
  decision: "continue",
  confidence: "high",
  rationale: "the compiler is still burning CPU",
});

interface AuxiliaryCall {
  readonly purpose: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly timeoutSeconds: number | undefined;
}

/**
 * A harness that never returns on its own. Every test decides when — and
 * whether — the inspector answers, so nothing here waits on wall clock.
 */
const fakeHarness = (input: {
  readonly calls: AuxiliaryCall[];
  readonly answer: Effect.Effect<
    { readonly output: string; readonly succeeded: boolean },
    DispatchError
  >;
}): AgentDispatchShape["runAuxiliary"] =>
  Effect.fnUntraced(function* (call) {
    input.calls.push({
      purpose: call.purpose,
      cwd: call.cwd,
      prompt: call.prompt,
      timeoutSeconds: call.timeoutSeconds,
    });
    return yield* input.answer;
  });

describe("harnessSupportsInspector", () => {
  it("allows only harnesses that can deny a subagent every tool", () => {
    expect(harnessSupportsInspector("claude")).toBe(true);
    expect(harnessSupportsInspector("ccx")).toBe(true);
    expect(harnessSupportsInspector("prime")).toBe(true);
    // Codex cannot enforce the contract; the rest have no auxiliary path.
    expect(harnessSupportsInspector("codex")).toBe(false);
    expect(harnessSupportsInspector("kimi")).toBe(false);
    expect(harnessSupportsInspector("opencode")).toBe(false);
    expect(harnessSupportsInspector("worker-cmd")).toBe(false);
  });
});

describe("disabledInspector", () => {
  it.effect("reports no support and never claims an inspector ran", () =>
    Effect.gen(function* () {
      expect(disabledInspector.inspectorSupported).toBe(false);
      yield* disabledInspector.launchInspector(REF, { timeoutSeconds: 120, evidence: EVIDENCE });
      expect(yield* disabledInspector.inspectorStatus(REF)).toEqual({ _tag: "none" });
    }),
  );
});

describe("makeAgentInspector", () => {
  it.effect("returns while the inspector is still running, not once it has finished", () =>
    Effect.gen(function* () {
      const calls: AuxiliaryCall[] = [];
      const gate = yield* Deferred.make<{ output: string; succeeded: boolean }>();
      const inspector = makeAgentInspector({
        runAuxiliary: fakeHarness({ calls, answer: Deferred.await(gate) }),
        selection: SELECTION,
        cwd: "/repo",
      });

      yield* inspector.launchInspector(REF, { timeoutSeconds: 120, evidence: EVIDENCE });
      // The launch has already returned while the harness is still blocked.
      expect(calls).toHaveLength(1);
      expect(yield* inspector.inspectorStatus(REF)).toEqual({ _tag: "running" });

      yield* Deferred.succeed(gate, { output: decision, succeeded: true });
      yield* Effect.yieldNow;
      expect(yield* inspector.inspectorStatus(REF)).toEqual({
        _tag: "finished",
        rc: 0,
        result: { text: decision, byteSize: decision.length, overflowed: false },
      });
    }),
  );

  it.effect("renders the prompt from structural evidence and bounds the harness call", () =>
    Effect.gen(function* () {
      const calls: AuxiliaryCall[] = [];
      const inspector = makeAgentInspector({
        runAuxiliary: fakeHarness({
          calls,
          answer: Effect.succeed({ output: decision, succeeded: true }),
        }),
        selection: SELECTION,
        cwd: "/repo",
        describeStructure: () =>
          Effect.succeed({
            processes: ["tool=node count=2"],
            repository: ["tracked-modified=3 added=0 deleted=0"],
          }),
      });

      yield* inspector.launchInspector(REF, { timeoutSeconds: 90, evidence: EVIDENCE });
      yield* Effect.yieldNow;

      const call = calls[0]!;
      expect(call.purpose).toBe("idle-inspection");
      // The coordinator checkout, never the worktree under inspection.
      expect(call.cwd).toBe("/repo");
      // The harness owns the process, so it gets the budget that kills it.
      expect(call.timeoutSeconds).toBe(90);
      expect(call.prompt).toContain("idle-seconds=1800");
      expect(call.prompt).toContain("tool=node count=2");
      expect(call.prompt).toContain("tracked-modified=3");
      expect(call.prompt).toContain("Do not use tools.");
      expect(call.prompt).not.toContain("/runs/run-7");
    }),
  );

  it.effect(
    "scores a failed run as rc 1 with no result, which the machine reads as uncertain",
    () =>
      Effect.gen(function* () {
        const calls: AuxiliaryCall[] = [];
        const inspector = makeAgentInspector({
          runAuxiliary: fakeHarness({
            calls,
            answer: Effect.succeed({ output: "boom", succeeded: false }),
          }),
          selection: SELECTION,
          cwd: "/repo",
        });

        yield* inspector.launchInspector(REF, { timeoutSeconds: 120, evidence: EVIDENCE });
        yield* Effect.yieldNow;
        expect(yield* inspector.inspectorStatus(REF)).toEqual({
          _tag: "finished",
          rc: 1,
          result: { text: "", byteSize: 0, overflowed: false },
        });
      }),
  );

  it.effect("scores a refused dispatch as rc 1, never as an answer", () =>
    Effect.gen(function* () {
      const calls: AuxiliaryCall[] = [];
      const inspector = makeAgentInspector({
        runAuxiliary: fakeHarness({
          calls,
          answer: Effect.fail(
            new DispatchError({ operation: "runAuxiliary", detail: "kimi does not support it" }),
          ),
        }),
        selection: SELECTION,
        cwd: "/repo",
      });

      yield* inspector.launchInspector(REF, { timeoutSeconds: 120, evidence: EVIDENCE });
      yield* Effect.yieldNow;
      const status = yield* inspector.inspectorStatus(REF);
      expect(status._tag === "finished" && status.rc).toBe(1);
    }),
  );

  it.effect("marks an oversized answer overflowed, so the machine rejects it", () =>
    Effect.gen(function* () {
      const calls: AuxiliaryCall[] = [];
      const flood = "x".repeat(200);
      const inspector = makeAgentInspector({
        runAuxiliary: fakeHarness({
          calls,
          answer: Effect.succeed({ output: flood, succeeded: true }),
        }),
        selection: SELECTION,
        cwd: "/repo",
        resultBytes: 64,
      });

      yield* inspector.launchInspector(REF, { timeoutSeconds: 120, evidence: EVIDENCE });
      yield* Effect.yieldNow;
      const status = yield* inspector.inspectorStatus(REF);
      expect(status._tag === "finished" && status.result.overflowed).toBe(true);
      expect(status._tag === "finished" && status.result.byteSize).toBe(200);
      expect(status._tag === "finished" && status.result.text.length).toBe(64);
    }),
  );

  it.effect("stops an inspector past its timeout and forgets it", () =>
    Effect.gen(function* () {
      const calls: AuxiliaryCall[] = [];
      const gate = yield* Deferred.make<{ output: string; succeeded: boolean }>();
      const inspector = makeAgentInspector({
        runAuxiliary: fakeHarness({ calls, answer: Deferred.await(gate) }),
        selection: SELECTION,
        cwd: "/repo",
      });

      yield* inspector.launchInspector(REF, { timeoutSeconds: 120, evidence: EVIDENCE });
      yield* inspector.stopInspector(REF);
      expect(yield* inspector.inspectorStatus(REF)).toEqual({ _tag: "none" });

      // A stopped inspector's answer must never reach the machine later.
      yield* Deferred.succeed(gate, { output: decision, succeeded: true });
      yield* Effect.yieldNow;
      expect(yield* inspector.inspectorStatus(REF)).toEqual({ _tag: "none" });
    }),
  );

  it.effect("keeps one inspector per worker, replacing a slot a reaped tick left", () =>
    Effect.gen(function* () {
      const calls: AuxiliaryCall[] = [];
      const gate = yield* Deferred.make<{ output: string; succeeded: boolean }>();
      const inspector = makeAgentInspector({
        runAuxiliary: fakeHarness({ calls, answer: Deferred.await(gate) }),
        selection: SELECTION,
        cwd: "/repo",
      });

      yield* inspector.launchInspector(REF, { timeoutSeconds: 120, evidence: EVIDENCE });
      yield* inspector.launchInspector(REF, { timeoutSeconds: 120, evidence: EVIDENCE });
      expect(calls).toHaveLength(2);
      expect(yield* inspector.inspectorStatus(REF)).toEqual({ _tag: "running" });

      // Only the surviving slot answers; the replaced one was interrupted.
      yield* Deferred.succeed(gate, { output: decision, succeeded: true });
      yield* Effect.yieldNow;
      const status = yield* inspector.inspectorStatus(REF);
      expect(status._tag).toBe("finished");
    }),
  );

  it.effect("tracks each worker separately", () =>
    Effect.gen(function* () {
      const calls: AuxiliaryCall[] = [];
      const other: WorkerRef = { worker: "/runs/run-7/run-7-4.jsonl", repositoryPath: "/repo" };
      const gate = yield* Deferred.make<{ output: string; succeeded: boolean }>();
      const inspector = makeAgentInspector({
        runAuxiliary: fakeHarness({ calls, answer: Deferred.await(gate) }),
        selection: SELECTION,
        cwd: "/repo",
      });

      yield* inspector.launchInspector(REF, { timeoutSeconds: 120, evidence: EVIDENCE });
      expect(yield* inspector.inspectorStatus(other)).toEqual({ _tag: "none" });
      expect(yield* inspector.inspectorStatus(REF)).toEqual({ _tag: "running" });
    }),
  );
});
