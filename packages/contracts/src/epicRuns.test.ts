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
} from "./epicRuns.ts";
import {
  WS_METHODS,
  WsEpicRunCancelRpc,
  WsEpicRunListRpc,
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
    });
    const event = { version: 1 as const, type: "run-state-changed" as const, run };

    expect(decodeEpicRun(encodeEpicRun(run))).toEqual(run);
    expect(decodeEpicRunEvent(encodeEpicRunEvent(event))).toEqual(event);
  });

  it("declares every public epic-run RPC method", () => {
    expect(WS_METHODS).toMatchObject({
      epicRunStart: "epicRun.start",
      epicRunPause: "epicRun.pause",
      epicRunResume: "epicRun.resume",
      epicRunCancel: "epicRun.cancel",
      epicRunList: "epicRun.list",
      subscribeEpicRuns: "epicRun.subscribe",
    });
    for (const rpc of [
      WsEpicRunStartRpc,
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
});
