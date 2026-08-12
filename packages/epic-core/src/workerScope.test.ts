import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ProcessRunner from "./processRunner.ts";
import {
  deriveWorkerScopeId,
  prepareWorkerScope,
  WORKER_SCOPE_CPU_WEIGHT,
  WORKER_SCOPE_MEMORY_HIGH,
  WorkerScopeCollisionError,
  workerScopeUnitName,
  wrapWorkerScopeSpawn,
} from "./workerScope.ts";

const identity = {
  repositoryPath: "/repo",
  runDirectory: "/repo/.git/t3code/epic-runs/run-1",
  epicId: "epic-1",
  runId: "run-1",
};

const output = (stdout: string, code = 0, stderr = ""): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr,
  code: code as never,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const fakeRunner = (
  handler: (input: ProcessRunner.ProcessRunInput) => ProcessRunner.ProcessRunOutput | null,
  captured: ProcessRunner.ProcessRunInput[] = [],
) => ({
  runner: ProcessRunner.ProcessRunner.of({
    run: (input: ProcessRunner.ProcessRunInput) => {
      captured.push(input);
      const result = handler(input);
      return result === null
        ? Effect.fail(
            new ProcessRunner.ProcessSpawnError({
              command: input.command,
              argumentCount: input.args.length,
              cause: new Error("spawn failed"),
            }),
          )
        : Effect.succeed(result);
    },
  }),
  captured,
});

const prepare = (
  platform: NodeJS.Platform,
  runner: ProcessRunner.ProcessRunner["Service"],
  options?: { readonly reclaimOwnScopes?: boolean },
) =>
  prepareWorkerScope(identity, options).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(HostProcessPlatform, platform),
  );

describe("workerScope", () => {
  it("derives the run-legacy.sh scope identity hash", () => {
    const expected = NodeCrypto.createHash("sha256")
      .update("/repo\0/repo/.git/t3code/epic-runs/run-1\0epic-1\0run-1\0")
      .digest("hex")
      .slice(0, 24);
    expect(deriveWorkerScopeId(identity)).toBe(expected);
    expect(deriveWorkerScopeId(identity)).toMatch(/^[0-9a-f]{24}$/);
  });

  it("builds run-legacy.sh-shaped unit names and sanitizes worker components", () => {
    expect(workerScopeUnitName("abc123", "worker-1")).toBe("cook-epic-abc123-worker-1.scope");
    expect(workerScopeUnitName("abc123", "t3code 06s/29")).toBe(
      "cook-epic-abc123-t3code-06s-29.scope",
    );
  });

  it.effect("is inactive on non-Linux hosts without probing", () =>
    Effect.gen(function* () {
      const { runner, captured } = fakeRunner(() => output(""));
      const preparation = yield* prepare("darwin", runner);
      expect(preparation.active).toBe(false);
      expect(captured).toHaveLength(0);
    }),
  );

  it.effect("is inactive when the systemd probe fails", () =>
    Effect.gen(function* () {
      const { runner } = fakeRunner((input) =>
        input.command === "systemd-run"
          ? output("Failed to start transient scope", 1, "no bus")
          : output(""),
      );
      const preparation = yield* prepare("linux", runner);
      expect(preparation.active).toBe(false);
    }),
  );

  it.effect("is inactive when systemd-run cannot be executed", () =>
    Effect.gen(function* () {
      const { runner } = fakeRunner(() => null);
      const preparation = yield* prepare("linux", runner);
      expect(preparation.active).toBe(false);
    }),
  );

  it.effect(
    "activates on Linux with a working user manager and sets only delegated controllers",
    () =>
      Effect.gen(function* () {
        const { runner, captured } = fakeRunner(() => output(""));
        const preparation = yield* prepare("linux", runner);
        expect(preparation.active).toBe(true);
        expect(preparation.scopeId).toBe(deriveWorkerScopeId(identity));

        const probe = captured.find((input) => input.command === "systemd-run");
        expect(probe?.args).toEqual(["--user", "--scope", "--quiet", "--", "true"]);

        const setProperty = captured.find(
          (input) => input.command === "systemctl" && input.args[1] === "set-property",
        );
        expect(setProperty?.args).toEqual([
          "--user",
          "set-property",
          "--runtime",
          "cook-epic.slice",
          `CPUWeight=${String(WORKER_SCOPE_CPU_WEIGHT)}`,
          `MemoryHigh=${WORKER_SCOPE_MEMORY_HIGH}`,
        ]);
        // The io controller is not delegated on the reference host; IOWeight is
        // deliberately not ported.
        expect(setProperty?.args.join(" ")).not.toContain("IOWeight");
      }),
  );

  it.effect("stays active when set-property fails", () =>
    Effect.gen(function* () {
      const { runner } = fakeRunner((input) =>
        input.command === "systemctl" && input.args[1] === "set-property"
          ? output("Failed to set properties", 1, "denied")
          : output(""),
      );
      const preparation = yield* prepare("linux", runner);
      expect(preparation.active).toBe(true);
    }),
  );

  it.effect("refuses a colliding pre-existing scope and stops nothing", () =>
    Effect.gen(function* () {
      const scopeId = deriveWorkerScopeId(identity);
      const { runner, captured } = fakeRunner((input) =>
        input.command === "systemctl" && input.args[1] === "list-units"
          ? output(`cook-epic-${scopeId}-iteration-0.scope loaded active running\n`)
          : output(""),
      );
      const error = yield* Effect.flip(prepare("linux", runner));
      expect(error).toBeInstanceOf(WorkerScopeCollisionError);
      expect(error.scopeId).toBe(scopeId);
      expect(captured.filter((input) => input.args[1] === "stop")).toHaveLength(0);
    }),
  );

  it.effect("stops its own leftover scopes when the boot path asks for a reclaim", () =>
    Effect.gen(function* () {
      const scopeId = deriveWorkerScopeId(identity);
      let listed = 0;
      const { runner, captured } = fakeRunner((input) => {
        if (input.command === "systemctl" && input.args[1] === "list-units") {
          listed += 1;
          // The first probe finds the orphans a restart left behind; after the
          // stops they are gone.
          return listed === 1
            ? output(
                `cook-epic-${scopeId}-iteration-4.scope loaded active running Worker\n` +
                  `cook-epic-${scopeId}-iteration-5.scope loaded active running Worker\n`,
              )
            : output("");
        }
        return output("");
      });

      const preparation = yield* prepare("linux", runner, { reclaimOwnScopes: true });
      expect(preparation.active).toBe(true);
      expect(preparation.scopeId).toBe(scopeId);
      expect(
        captured
          .filter((input) => input.command === "systemctl" && input.args[1] === "stop")
          .map((input) => input.args[2]),
      ).toEqual([
        `cook-epic-${scopeId}-iteration-4.scope`,
        `cook-epic-${scopeId}-iteration-5.scope`,
      ]);
      expect(
        captured.filter(
          (input) => input.command === "systemctl" && input.args[1] === "reset-failed",
        ).length,
      ).toBe(2);
      expect(listed).toBe(2);
    }),
  );

  it.effect("still fails when a leftover scope refuses to stop", () =>
    Effect.gen(function* () {
      const scopeId = deriveWorkerScopeId(identity);
      let listed = 0;
      const { runner } = fakeRunner((input) => {
        if (input.command === "systemctl" && input.args[1] === "list-units") {
          listed += 1;
          return listed === 1
            ? output(
                `cook-epic-${scopeId}-iteration-4.scope loaded active running Worker\n` +
                  `cook-epic-${scopeId}-iteration-5.scope loaded active running Worker\n`,
              )
            : output(
                `cook-epic-${scopeId}-iteration-4.scope loaded active running Worker\n` +
                  `cook-epic-${scopeId}-iteration-5.scope loaded active running Worker\n`,
              );
        }
        return output("");
      });

      const error = yield* Effect.flip(prepare("linux", runner, { reclaimOwnScopes: true }));
      expect(error).toBeInstanceOf(WorkerScopeCollisionError);
      expect(error.detail).toContain(`cook-epic-${scopeId}-iteration-4.scope`);
      expect(error.detail).toContain(`cook-epic-${scopeId}-iteration-5.scope`);
    }),
  );

  it.effect("fails the reclaim when the confirming probe cannot be executed", () =>
    Effect.gen(function* () {
      const scopeId = deriveWorkerScopeId(identity);
      let listed = 0;
      const { runner } = fakeRunner((input) => {
        if (input.command === "systemctl" && input.args[1] === "list-units") {
          listed += 1;
          return listed === 1
            ? output(`cook-epic-${scopeId}-iteration-4.scope loaded active running Worker\n`)
            : null;
        }
        return output("");
      });

      const error = yield* Effect.flip(prepare("linux", runner, { reclaimOwnScopes: true }));
      expect(error).toBeInstanceOf(WorkerScopeCollisionError);
      expect(error.detail).toContain("could not confirm");
    }),
  );

  it.effect("does not probe on non-Linux hosts even when a reclaim is requested", () =>
    Effect.gen(function* () {
      const { runner, captured } = fakeRunner(() => output(""));
      const preparation = yield* prepare("darwin", runner, { reclaimOwnScopes: true });
      expect(preparation.active).toBe(false);
      expect(captured).toHaveLength(0);
    }),
  );

  it("wraps the spawn when active and passes it through when inactive", () => {
    const scopeId = deriveWorkerScopeId(identity);
    expect(
      wrapWorkerScopeSpawn({ scopeId, active: true }, "iteration-0", "claude", ["-p", "x"]),
    ).toEqual({
      command: "systemd-run",
      args: [
        "--user",
        "--scope",
        "--quiet",
        "--slice=cook-epic",
        `--unit=cook-epic-${scopeId}-iteration-0.scope`,
        "--",
        "claude",
        "-p",
        "x",
      ],
    });
    expect(
      wrapWorkerScopeSpawn({ scopeId, active: false }, "iteration-0", "claude", ["-p"]),
    ).toEqual({
      command: "claude",
      args: ["-p"],
    });
  });
});
