import * as Effect from "effect/Effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
  makeChildStdio,
  makeInMemoryStdio,
  makeTerminationError as makeTerminationErrorCore,
} from "effect-jsonrpc-stdio/stdio";
import * as CodexError from "../errors.ts";

export { makeChildStdio, makeInMemoryStdio };

type ChildProcessTerminationHandle = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "exitCode" | "pid"
>;

export const makeTerminationError = (
  handle: ChildProcessTerminationHandle,
): Effect.Effect<CodexError.CodexAppServerError> =>
  makeTerminationErrorCore<CodexError.CodexAppServerError>(handle, {
    transport: ({ pid, cause }) =>
      new CodexError.CodexAppServerTransportError({
        operation: "read-process-exit-status",
        pid,
        cause,
      }),
    exited: ({ code, pid }) => new CodexError.CodexAppServerProcessExitedError({ code, pid }),
  });
