import * as Effect from "effect/Effect";
import {
  makeChildStdio,
  makeInMemoryStdio,
  makeTerminationError as makeTerminationErrorCore,
} from "effect-jsonrpc-stdio/stdio";
import type { ChildProcessSpawner } from "effect/unstable/process";

import * as AcpError from "../errors.ts";

export { makeChildStdio, makeInMemoryStdio };

type ChildProcessTerminationHandle = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "exitCode" | "pid"
>;

export const makeTerminationError = (
  handle: ChildProcessTerminationHandle,
): Effect.Effect<AcpError.AcpError> =>
  makeTerminationErrorCore<AcpError.AcpError>(handle, {
    transport: ({ pid, cause }) =>
      new AcpError.AcpTransportError({ operation: "read-process-exit-status", pid, cause }),
    exited: ({ code, pid }) => new AcpError.AcpProcessExitedError({ code, pid }),
  });
