// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalDateInEffect:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { BeadsStatusResult } from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "@t3tools/epic-core/processRunner";
import {
  EpicRunPreflight,
  layer as EpicRunPreflightLive,
} from "@t3tools/epic-core/EpicRunPreflight";
import * as EpicRunLockLive from "@t3tools/epic-core/adapters/NodeEpicRunLock";
import { EpicRunLock, EpicRunLockHeldError } from "@t3tools/epic-core/ports/EpicRunLock";
import * as BeadsStatusBroadcaster from "../src/beads/BeadsStatusBroadcaster.ts";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "../../..");
const cookEpicRunner = NodePath.join(repositoryRoot, "skills/cook-epic/run.sh");

const execFile = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv,
) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(command, [...args], { cwd, env }, (error, stdout) =>
          error ? reject(error) : resolve(stdout),
        );
      }),
  );

const bdUnsupportedReason = (() => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bd-probe-"));
  try {
    const cwd = NodePath.join(directory, "repo");
    const home = NodePath.join(directory, "home");
    NodeFS.mkdirSync(cwd);
    NodeFS.mkdirSync(home);
    const env = { ...process.env, HOME: home, BD_CONFIG: NodePath.join(directory, "config.yaml") };
    NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd, env, stdio: "ignore" });
    NodeChildProcess.execFileSync(
      "bd",
      [
        "init",
        "--non-interactive",
        "--skip-agents",
        "--skip-hooks",
        "--prefix",
        "probe",
        "--quiet",
      ],
      { cwd, env, stdio: "ignore" },
    );
    return null;
  } catch (cause) {
    return `bd is unavailable or unusable: ${String(cause)}`;
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
})();

const terminalUnsupportedReason = (() => {
  if (!NodeFS.existsSync("/proc/self/stat")) {
    return `cook-epic terminal lock fixture requires Linux process metadata`;
  }
  const required = ["bash", "bd", "flock", "git", "jq", "setsid", "sha256sum", "timeout"];
  const missing = required.filter(
    (command) =>
      NodeChildProcess.spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "probe", command])
        .status !== 0,
  );
  return missing.length === 0
    ? null
    : `cook-epic terminal lock fixture is missing: ${missing.join(", ")}`;
})();

interface Fixture {
  readonly root: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly epicId: string;
  readonly firstId: string;
  readonly secondId: string;
}

const fixture = Effect.acquireRelease(
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-beads-shared-")),
    );
    const cwd = NodePath.join(root, "repo");
    const home = NodePath.join(root, "home");
    yield* Effect.promise(() => Promise.all([NodeFSP.mkdir(cwd), NodeFSP.mkdir(home)]));
    const env = { ...process.env, HOME: home, BD_CONFIG: NodePath.join(root, "config.yaml") };
    yield* execFile("git", ["init", "-q"], cwd, env);
    yield* execFile("git", ["config", "user.name", "T3 integration"], cwd, env);
    yield* execFile("git", ["config", "user.email", "integration@example.invalid"], cwd, env);
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(cwd, "base.txt"), "base\n"));
    yield* execFile("git", ["add", "base.txt"], cwd, env);
    yield* execFile("git", ["commit", "-qm", "fixture baseline"], cwd, env);
    yield* execFile(
      "bd",
      [
        "init",
        "--non-interactive",
        "--skip-agents",
        "--skip-hooks",
        "--prefix",
        `shared${process.pid}`,
        "--quiet",
      ],
      cwd,
      env,
    );
    const create = (title: string, args: ReadonlyArray<string>) =>
      execFile("bd", ["create", title, ...args, "--silent"], cwd, env).pipe(
        Effect.map((value) => value.trim()),
      );
    const epicId = yield* create("Shared state epic", ["--type", "epic"]);
    const firstId = yield* create("First child", ["--parent", epicId]);
    const secondId = yield* create("Second child", ["--parent", epicId]);
    return { root, cwd, env, epicId, firstId, secondId } satisfies Fixture;
  }),
  ({ root }) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);

const lockFixture = Effect.acquireRelease(
  Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-server-lock-")),
    );
    const cwd = NodePath.join(root, "repo");
    yield* Effect.promise(() => NodeFSP.mkdir(cwd));
    yield* execFile("git", ["init", "-q"], cwd, process.env);
    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(cwd, ".beads")));
    return { root, cwd };
  }),
  ({ root }) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);

const awaitChildExit = (child: NodeChildProcess.ChildProcess) =>
  Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.void);
      return;
    }
    const onClose = () => resume(Effect.void);
    child.once("close", onClose);
    return Effect.sync(() => child.off("close", onClose));
  });

const signalChildGroup = (child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals) =>
  Effect.sync(() => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group already exited.
    }
  });

const stopChildGroup = (child: NodeChildProcess.ChildProcess) =>
  Effect.gen(function* () {
    yield* signalChildGroup(child, "SIGTERM");
    const terminated = yield* awaitChildExit(child).pipe(Effect.timeoutOption("2 seconds"));
    if (Option.isSome(terminated)) return;
    yield* signalChildGroup(child, "SIGKILL");
    yield* awaitChildExit(child).pipe(Effect.timeout("2 seconds"), Effect.ignore);
  });

const withFixtureEnvironment = <A, E, R>(fixture: Fixture, effect: Effect.Effect<A, E, R>) => {
  const previousHome = process.env.HOME;
  const previousConfig = process.env.BD_CONFIG;
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      process.env.HOME = fixture.env.HOME;
      process.env.BD_CONFIG = fixture.env.BD_CONFIG;
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousConfig === undefined) delete process.env.BD_CONFIG;
        else process.env.BD_CONFIG = previousConfig;
      }),
  );
};

const nodeLayer = NodeServices.layer;
const processLayer = ProcessRunner.layer.pipe(Layer.provide(nodeLayer));
const lockLayer = EpicRunLockLive.layer;
const broadcasterLayer = BeadsStatusBroadcaster.layer.pipe(
  Layer.provide(processLayer),
  Layer.provideMerge(nodeLayer),
);
const preflightLayer = EpicRunPreflightLive.pipe(
  Layer.provide(processLayer),
  Layer.provide(lockLayer),
);
const testLayer = Layer.mergeAll(processLayer, lockLayer, broadcasterLayer, preflightLayer);

const issueStatus = (snapshot: BeadsStatusResult, issueId: string) =>
  snapshot._tag === "available"
    ? snapshot.issues.find((issue) => issue.id === issueId)?.status
    : undefined;

describe("shared Beads state", () => {
  it.live.skipIf(bdUnsupportedReason !== null)(
    `observes terminal issue updates through the server broadcaster (${bdUnsupportedReason ?? "isolated bd available"})`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const value = yield* fixture;
          yield* withFixtureEnvironment(
            value,
            Effect.gen(function* () {
              const broadcaster = yield* BeadsStatusBroadcaster.BeadsStatusBroadcaster;
              const streamScope = yield* Scope.make();
              const sawClaim = yield* Deferred.make<void>();
              yield* Stream.runForEach(
                broadcaster.streamStatus({ workspaceRoot: value.cwd }),
                (snapshot) =>
                  issueStatus(snapshot, value.firstId) === "in_progress"
                    ? Deferred.succeed(sawClaim, undefined).pipe(Effect.ignore)
                    : Effect.void,
              ).pipe(Effect.forkIn(streamScope));
              yield* execFile("bd", ["update", value.firstId, "--claim"], value.cwd, value.env);
              yield* Deferred.await(sawClaim).pipe(Effect.timeout("10 seconds"));
              yield* Scope.close(streamScope, Exit.void);
            }),
          );
        }).pipe(Effect.provide(testLayer)),
      ),
  );

  it.live.skipIf(bdUnsupportedReason !== null || terminalUnsupportedReason !== null)(
    `reads a terminal lock written by cook-epic (${bdUnsupportedReason ?? terminalUnsupportedReason ?? "requirements available"})`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const value = yield* fixture;
          yield* withFixtureEnvironment(
            value,
            Effect.gen(function* () {
              const runDir = NodePath.join(value.root, "run");
              const worker = NodePath.join(value.root, "worker.sh");
              yield* Effect.promise(() => NodeFSP.mkdir(runDir));
              yield* Effect.promise(() =>
                NodeFSP.writeFile(
                  worker,
                  "#!/usr/bin/env bash\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
                  { mode: 0o755 },
                ),
              );
              const child = yield* Effect.acquireRelease(
                Effect.sync(() =>
                  NodeChildProcess.spawn("bash", [cookEpicRunner, runDir], {
                    cwd: value.cwd,
                    detached: true,
                    stdio: "ignore",
                    env: {
                      ...value.env,
                      COOKEPIC_EPIC: value.epicId,
                      COOKEPIC_WORKER_CMD: worker,
                      COOKEPIC_SEQUENTIAL: "1",
                      COOKEPIC_NO_PUSH: "1",
                      COOKEPIC_NO_GATE: "1",
                      COOKEPIC_DISABLE_SYSTEMD: "1",
                      COOKEPIC_SPAWN_DELAY: "0",
                      COOKEPIC_SUPERVISION_TICK: "1",
                    },
                  }),
                ),
                stopChildGroup,
              );
              const pid = child.pid;
              expect(pid).toBeDefined();
              const lockFile = NodePath.join(value.cwd, ".beads", `run-lock.${value.epicId}.json`);
              yield* Effect.gen(function* () {
                for (let attempt = 0; attempt < 100; attempt += 1) {
                  if (yield* Effect.sync(() => NodeFS.existsSync(lockFile))) return;
                  yield* Effect.sleep("50 millis");
                }
                throw new Error("cook-epic did not write its lock");
              });
              const preflight = yield* EpicRunPreflight;
              const result = yield* preflight.check({
                workspaceRoot: value.cwd,
                epicId: value.epicId,
                mode: "sequential",
              });
              expect(
                result.blockers.some(
                  (blocker) => blocker._tag === "run_in_progress" && blocker.owner === "terminal",
                ),
              ).toBe(true);
            }),
          );
        }).pipe(Effect.provide(testLayer)),
      ),
  );

  it.live("excludes two server lock owners", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const value = yield* lockFixture;
        const locks = yield* EpicRunLock;
        yield* Effect.acquireRelease(
          locks.acquire({
            workspaceRoot: value.cwd,
            epicId: "server-lock",
            owner: "t3code",
            runDir: value.cwd,
          }),
          (lease) => lease.release.pipe(Effect.ignore),
        );
        const error = yield* Effect.flip(
          locks.acquire({
            workspaceRoot: value.cwd,
            epicId: "server-lock",
            owner: "t3code",
            runDir: value.root,
          }),
        );
        expect(error).toBeInstanceOf(EpicRunLockHeldError);
      }).pipe(Effect.provide(testLayer)),
    ),
  );
});
