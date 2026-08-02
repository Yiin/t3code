import { assert, it } from "@effect/vitest";

import { EnvironmentInternalError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { HttpClientError } from "effect/unstable/http";

import {
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerRequestError,
  projectCommandErrorFromLiveServerRequest,
  shouldClearProjectRuntimeState,
} from "./project.ts";

it("maps declared server failures into structural project command errors", () => {
  const cause = new EnvironmentInternalError({
    code: "internal_error",
    reason: "orchestration_snapshot_failed",
    traceId: "trace-123",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerDeclaredResponseError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.code, "internal_error");
  assert.strictEqual(error.traceId, "trace-123");
  assert.strictEqual(error.message, "Server request failed (internal_error, trace trace-123).");
  assert.strictEqual(error.cause, cause);
});

it("preserves unexpected server failures without deriving the message from them", () => {
  const cause = new Error("credential abc123 was rejected");

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});

it("keeps declared server failures without clearing runtime state", () => {
  const failure = new ProjectLiveServerDeclaredResponseError({
    operation: "callLiveServer",
    code: "internal_error",
    traceId: "trace-1",
    cause: new EnvironmentInternalError({
      code: "internal_error",
      reason: "orchestration_snapshot_failed",
      traceId: "trace-1",
    }),
  });
  assert.isFalse(shouldClearProjectRuntimeState(failure));
});

it("keeps a probe timeout without clearing runtime state", () => {
  // The regression this pins: a slow-but-alive server must never look dead.
  const failure = new ProjectLiveServerRequestError({
    operation: "callLiveServer",
    cause: new Cause.TimeoutError(),
  });
  assert.isFalse(shouldClearProjectRuntimeState(failure));
});

it("clears runtime state only on a genuine transport failure", () => {
  const failure = new ProjectLiveServerRequestError({
    operation: "callLiveServer",
    cause: new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request: {} as never,
        cause: new Error("connect ECONNREFUSED"),
      }),
    }),
  });
  assert.isTrue(shouldClearProjectRuntimeState(failure));
});
