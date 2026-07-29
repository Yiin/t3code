// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDateInEffect:off globalDate:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { BeadsStatusResult } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as EpicRunLockLive from "../runner/Layers/EpicRunLock.ts";
import {
  EpicRunLock,
  EpicRunLockHeldError,
  type EpicRunLockOwner,
} from "../runner/Services/EpicRunLock.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as BeadsStatusBroadcaster from "./BeadsStatusBroadcaster.ts";
import { EpicRunPreflight, layer as EpicRunPreflightLive } from "./EpicRunPreflight.ts";

const execFile = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(command, [...args], { cwd }, (error, stdout) =>
          error ? reject(error) : resolve(stdout),
        );
      }),
  );

const fixture = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-epic-parity-"))),
  (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
);

const createIssue = Effect.fn("test.createIssue")(function* (
  cwd: string,
  title: string,
  args: ReadonlyArray<string>,
) {
  return (yield* execFile("bd", ["create", title, ...args, "--silent"], cwd)).trim();
});

const issueStatus = (snapshot: BeadsStatusResult, issueId: string) =>
  snapshot._tag === "available"
    ? snapshot.issues.find((issue) => issue.id === issueId)?.status
    : undefined;

const waitForStatus = Effect.fn("test.waitForStatus")(function* (signal: Deferred.Deferred<void>) {
  yield* Deferred.await(signal).pipe(Effect.timeout("10 seconds"));
});

const nodeLayer = NodeServices.layer;
const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-epic-parity-test-" });
const processLayer = ProcessRunner.layer.pipe(Layer.provide(nodeLayer));
const gitLayer = GitVcsDriver.layer.pipe(Layer.provide(configLayer), Layer.provideMerge(nodeLayer));
const lockLayer = EpicRunLockLive.layer;
const broadcasterLayer = BeadsStatusBroadcaster.layer.pipe(
  Layer.provide(processLayer),
  Layer.provideMerge(nodeLayer),
);
const preflightLayer = EpicRunPreflightLive.pipe(
  Layer.provide(gitLayer),
  Layer.provide(processLayer),
  Layer.provide(lockLayer),
);
const testLayer = Layer.mergeAll(processLayer, lockLayer, broadcasterLayer, preflightLayer);

describe("terminal and T3 Code epic-run parity", () => {
  it.live("shares Beads progress and the epic lock without a server refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* fixture;
        yield* execFile("git", ["init", "-q"], cwd);
        yield* execFile("git", ["config", "user.name", "T3 parity test"], cwd);
        yield* execFile("git", ["config", "user.email", "parity@example.invalid"], cwd);
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(cwd, "base.txt"), "base\n"));
        yield* execFile("git", ["add", "base.txt"], cwd);
        yield* execFile("git", ["commit", "-qm", "fixture baseline"], cwd);
        yield* execFile(
          "bd",
          [
            "init",
            "--non-interactive",
            "--skip-agents",
            "--skip-hooks",
            "--prefix",
            `parity${process.pid}`,
            "--quiet",
          ],
          cwd,
        );

        const epicId = yield* createIssue(cwd, "Parity epic", ["--type", "epic"]);
        const firstId = yield* createIssue(cwd, "First child", ["--parent", epicId]);
        const secondId = yield* createIssue(cwd, "Second child", ["--parent", epicId]);
        const thirdId = yield* createIssue(cwd, "Third child", ["--parent", epicId]);
        yield* execFile("bd", ["dep", "add", secondId, firstId], cwd);
        yield* execFile("bd", ["dep", "add", thirdId, secondId], cwd);

        const broadcaster = yield* BeadsStatusBroadcaster.BeadsStatusBroadcaster;
        const processRunner = yield* ProcessRunner.ProcessRunner;
        const streamScope = yield* Scope.make();
        const sawClaim = yield* Deferred.make<void>();
        const sawSecondTouched = yield* Deferred.make<void>();
        const sawClose = yield* Deferred.make<void>();
        yield* Stream.runForEach(broadcaster.streamStatus({ workspaceRoot: cwd }), (snapshot) =>
          Effect.all(
            [
              issueStatus(snapshot, firstId) === "in_progress"
                ? Deferred.succeed(sawClaim, undefined).pipe(Effect.ignore)
                : Effect.void,
              issueStatus(snapshot, firstId) === "closed"
                ? Deferred.succeed(sawClose, undefined).pipe(Effect.ignore)
                : Effect.void,
              snapshot._tag === "available" && snapshot.lastTouchedId === secondId
                ? Deferred.succeed(sawSecondTouched, undefined).pipe(Effect.ignore)
                : Effect.void,
            ],
            { discard: true },
          ),
        ).pipe(Effect.forkIn(streamScope));

        // This is the plain-terminal path: no broadcaster refresh is requested.
        yield* execFile("bd", ["update", firstId, "--claim"], cwd);
        yield* waitForStatus(sawClaim);

        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(cwd, "iteration.txt"), "terminal iteration\n"),
        );
        yield* execFile("git", ["add", "iteration.txt"], cwd);
        yield* execFile("git", ["commit", "-qm", "complete first child"], cwd);
        expect((yield* execFile("git", ["log", "-1", "--format=%s"], cwd)).trim()).toBe(
          "complete first child",
        );

        // bd does not rewrite last-touched for consecutive updates to one issue.
        // Move it away and wait for that watcher event before testing the close.
        yield* execFile(
          "bd",
          ["update", secondId, "--append-notes", "Waiting for the first child"],
          cwd,
        );
        yield* waitForStatus(sawSecondTouched);

        yield* execFile("bd", ["update", firstId, "--status", "closed"], cwd);
        yield* waitForStatus(sawClose);

        const readyAfterTerminal = JSON.parse(
          yield* execFile("bd", ["ready", "--parent", epicId, "--json"], cwd),
        ) as ReadonlyArray<{ readonly id: string }>;
        expect(readyAfterTerminal.map((issue) => issue.id)).toContain(secondId);
        yield* Scope.close(streamScope, Exit.void);

        // This is the server-launched stub path. A bare shell must see its
        // claim/close advance the ready frontier to the third child.
        const serverClaim = yield* processRunner.run({
          command: "bd",
          args: ["update", secondId, "--claim"],
          cwd,
          timeout: "30 seconds",
        });
        expect(serverClaim.code).toBe(0);
        const serverClose = yield* processRunner.run({
          command: "bd",
          args: ["update", secondId, "--status", "closed"],
          cwd,
          timeout: "30 seconds",
        });
        expect(serverClose.code).toBe(0);
        const readyAfterServer = JSON.parse(
          yield* execFile("bd", ["ready", "--parent", epicId, "--json"], cwd),
        ) as ReadonlyArray<{ readonly id: string }>;
        expect(readyAfterServer.map((issue) => issue.id)).toContain(thirdId);
        expect(readyAfterServer.map((issue) => issue.id)).not.toContain(secondId);

        const preflight = yield* EpicRunPreflight;
        const lockFile = NodePath.join(cwd, ".beads", `run-lock.${epicId}.json`);
        const [bootId, processStat] = yield* Effect.all([
          Effect.promise(() => NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8")),
          Effect.promise(() => NodeFSP.readFile(`/proc/${process.pid}/stat`, "utf8")),
        ]);
        const processFields = processStat.slice(processStat.lastIndexOf(") ") + 2).split(" ");
        const terminalOwner = {
          owner: "terminal",
          host: NodeOS.hostname(),
          bootId: bootId.trim(),
          pid: process.pid,
          pgid: Number(processFields[2] ?? 0),
          startTicks: processFields[19] ?? "",
          runDir: "/var/tmp/terminal-parity",
          startedAt: new Date().toISOString(),
          heartbeatAt: Math.floor(Date.now() / 1000),
        } satisfies EpicRunLockOwner;
        yield* Effect.promise(() =>
          NodeFSP.writeFile(lockFile, `${JSON.stringify(terminalOwner)}\n`, { flag: "wx" }),
        );
        const blocked = yield* preflight.check({
          workspaceRoot: cwd,
          epicId,
          mode: "sequential",
        });
        expect(blocked.blockers).toContainEqual({
          _tag: "run_in_progress",
          owner: "terminal",
          runDir: terminalOwner.runDir,
          host: terminalOwner.host,
          pid: terminalOwner.pid,
        });
        yield* Effect.promise(() => NodeFSP.unlink(lockFile));

        const locks = yield* EpicRunLock;
        const lease = yield* locks.acquire({
          workspaceRoot: cwd,
          epicId,
          owner: "t3code",
          runDir: cwd,
        });
        const competingAcquire = yield* Effect.flip(
          locks.acquire({
            workspaceRoot: cwd,
            epicId,
            owner: "terminal",
            runDir: "/var/tmp/terminal-parity",
          }),
        );
        expect(competingAcquire).toBeInstanceOf(EpicRunLockHeldError);
        yield* lease.release;
      }).pipe(Effect.provide(testLayer)),
    ),
  );
});
