import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { BacklogError } from "../ports/Backlog.ts";
import type { ProcessRunInput, ProcessRunOutput } from "../processRunner.ts";
import { makeProcessPoolBacklog } from "./ProcessPoolBacklog.ts";

const runnerReturning = (output: ProcessRunOutput) => ({
  run: (_input: ProcessRunInput) => Effect.succeed(output),
});

it.effect("logs bd ready's exit code and stderr when the ready read fails", () =>
  Effect.gen(function* () {
    // t3code-8vn: the backlog-empty decision starts from this read, so a
    // failed `bd ready` must leave its raw failure on record.
    const messages: Array<unknown> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      messages.push(message);
    });
    const backlog = makeProcessPoolBacklog(
      runnerReturning({
        stdout: "",
        stderr: "database is locked\n",
        code: ChildProcessSpawner.ExitCode(1),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    );

    const error = yield* backlog
      .readyFrontier("/repo", "epic-1")
      .pipe(Effect.flip, Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));

    assert.instanceOf(error, BacklogError);
    assert.equal(error.detail, "database is locked");
    const failureLog = messages
      .filter(Array.isArray)
      .find((message) => message[0] === "epic.runner.bd-ready-failed");
    assert.exists(failureLog);
    assert.deepEqual(failureLog?.[1], {
      cwd: "/repo",
      epicId: "epic-1",
      exitCode: 1,
      stderr: "database is locked",
    });
  }),
);
