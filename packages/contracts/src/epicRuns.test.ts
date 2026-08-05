import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { EpicRunId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  EpicRun,
  EpicRunEvent,
  EpicRunInput,
  EpicRunnerDispatchError,
  EpicRunnerStoreError,
  epicRunIterationThreadId,
  ListEpicRunsInput,
  ListEpicRunsQuery,
  parseEpicRunIterationThreadId,
} from "./epicRuns.ts";
import {
  WS_METHODS,
  WsEpicRunCancelRpc,
  WsEpicRunListRpc,
  WsEpicRunLaunchRpc,
  WsEpicRunPauseRpc,
  WsEpicRunResumeRpc,
  WsEpicRunStartRpc,
  WsRpcGroup,
  WsSubscribeEpicRunsRpc,
} from "./rpc.ts";

const input = {
  epicId: "t3code-vst",
  projectId: ProjectId.make("project-1"),
  cwd: "/tmp/project",
  prompt: "Cook one child.",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
};
const decodeEpicRunInput = Schema.decodeUnknownSync(EpicRunInput);
const decodeEpicRun = Schema.decodeUnknownSync(EpicRun);
const encodeEpicRun = Schema.encodeSync(EpicRun);
const decodeEpicRunEvent = Schema.decodeUnknownSync(EpicRunEvent);
const encodeEpicRunEvent = Schema.encodeSync(EpicRunEvent);
const decodeEpicRunStartPayload = Schema.decodeUnknownSync(WsEpicRunStartRpc.payloadSchema);
const decodeEpicRunnerStoreError = Schema.decodeUnknownSync(EpicRunnerStoreError);
const encodeEpicRunnerStoreError = Schema.encodeSync(EpicRunnerStoreError);
const decodeEpicRunnerDispatchError = Schema.decodeUnknownSync(EpicRunnerDispatchError);

describe("EpicRun contracts", () => {
  it("defaults omitted runtime mode to full access", () => {
    expect(decodeEpicRunInput(input).runtimeMode).toBe("full-access");
  });

  it("round-trips a complete run and versioned state-change event", () => {
    const run = decodeEpicRun({
      ...input,
      runtimeMode: "full-access",
      runId: EpicRunId.make("run-1"),
      originThreadId: ThreadId.make("thread-origin"),
      status: "running",
      maxIterations: 10,
      iterationsCompleted: 1,
      currentThreadId: ThreadId.make("thread-1"),
      currentTurnStartedAt: "2026-07-28T00:00:00.000Z",
      consecutiveFailures: 0,
      lastError: null,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:01:00.000Z",
      threadRefs: [{ issueId: "t3code-vst.1", threadId: "thread-1", iterationIndex: 1 }],
      recentIterations: [
        {
          iterationIndex: 1,
          threadId: "thread-1",
          issueId: "t3code-vst.1",
          turnStatus: "completed",
          summary: "built it",
          why: "needed it",
          startedAt: "2026-07-28T00:00:00.000Z",
          finishedAt: "2026-07-28T00:01:00.000Z",
        },
      ],
    });
    const event = { version: 1 as const, type: "run-state-changed" as const, run };

    // The iteration above predates `failureReason`; old rows decode to null.
    expect(run.recentIterations[0]?.failureReason).toBeNull();
    expect(decodeEpicRun(encodeEpicRun(run))).toEqual(run);
    expect(decodeEpicRunEvent(encodeEpicRunEvent(event))).toEqual(event);
  });

  it("round-trips iteration thread ids, and rejects ids it did not build", () => {
    const runId = "0c5a1f4e-9b7d-4a2c-8f31-6d0e2b7a4c19";
    expect(
      parseEpicRunIterationThreadId(epicRunIterationThreadId({ runId, iterationIndex: 12 })),
    ).toEqual({ runId, iterationIndex: 12 });
    for (const alien of [
      "thread-1",
      "epic-runner-notes",
      `epic-run-${runId}-final`,
      "epic-run--1",
    ]) {
      expect(parseEpicRunIterationThreadId(alien)).toBeNull();
    }
  });

  it("declares every public epic-run RPC method", () => {
    expect(WS_METHODS).toMatchObject({
      epicRunStart: "epicRun.start",
      epicRunLaunch: "epicRun.launch",
      epicRunPause: "epicRun.pause",
      epicRunResume: "epicRun.resume",
      epicRunCancel: "epicRun.cancel",
      epicRunList: "epicRun.list",
      subscribeEpicRuns: "epicRun.subscribe",
    });
    for (const rpc of [
      WsEpicRunStartRpc,
      WsEpicRunLaunchRpc,
      WsEpicRunPauseRpc,
      WsEpicRunResumeRpc,
      WsEpicRunCancelRpc,
      WsEpicRunListRpc,
      WsSubscribeEpicRunsRpc,
    ]) {
      expect(WsRpcGroup.requests.get(rpc._tag)).toBe(rpc);
    }
    expect(
      decodeEpicRunStartPayload({
        ...input,
        _tag: WS_METHODS.epicRunStart,
      }).runtimeMode,
    ).toBe("full-access");
  });

  it("decodes internal-shaped errors and encodes them without causes", () => {
    const sanitized = decodeEpicRunnerStoreError({
      _tag: "EpicRunnerStoreError",
      operation: "listRuns",
      cause: { secret: "sqlite details" },
    });
    expect(encodeEpicRunnerStoreError(sanitized)).toEqual({
      _tag: "EpicRunnerStoreError",
      operation: "listRuns",
    });
    expect(
      decodeEpicRunnerDispatchError({
        _tag: "EpicRunnerDispatchError",
        commandType: "thread.turn.start",
        detail: "provider unavailable",
      }).detail,
    ).toBe("provider unavailable");
  });

  it("keeps the run-listing bound optional and decodes it from a query string", () => {
    const decodeInput = Schema.decodeUnknownSync(ListEpicRunsInput);
    const decodeQuery = Schema.decodeUnknownSync(ListEpicRunsQuery);

    // Every caller before this change sent `{}`, and it must still mean
    // "everything, oldest first" — the runner's restart read depends on it.
    expect(decodeInput({})).toEqual({});
    expect(decodeInput({ status: "running", limit: 50, orderBy: "updatedAt-desc" })).toEqual({
      status: "running",
      limit: 50,
      orderBy: "updatedAt-desc",
    });
    expect(() => decodeInput({ limit: 0 })).toThrow();
    expect(() => decodeInput({ limit: 2.5 })).toThrow();
    expect(() => decodeInput({ orderBy: "createdAt-desc" })).toThrow();

    // A GET carries `limit` as text; the decoded value must be a number so the
    // SQL LIMIT does not bind a string.
    expect(decodeQuery({ status: "running", limit: "50", orderBy: "updatedAt-desc" })).toEqual({
      status: "running",
      limit: 50,
      orderBy: "updatedAt-desc",
    });
    expect(decodeQuery({})).toEqual({});
    expect(() => decodeQuery({ limit: "0" })).toThrow();
    expect(() => decodeQuery({ limit: "2.5" })).toThrow();
    expect(() => decodeQuery({ limit: "many" })).toThrow();
  });
});
