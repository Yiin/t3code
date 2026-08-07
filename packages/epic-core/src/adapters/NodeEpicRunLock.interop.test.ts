// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalDateInEffect:off globalTimers:off
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { EpicRunLock, EpicRunLockHeldError, type EpicRunLockLease } from "../ports/EpicRunLock.ts";
import { layer, makeLayer } from "./NodeEpicRunLock.ts";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "../../../..");
const cookEpicRunner = NodePath.join(repositoryRoot, "skills/cook-epic/run-legacy.sh");
const requiredCommands = ["bash", "flock", "git", "jq", "setsid", "sha256sum", "timeout"];
const unsupportedReason =
  !NodeFS.existsSync("/proc/self/stat") ||
  requiredCommands.some(
    (command) =>
      NodeChildProcess.spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "probe", command])
        .status !== 0,
  )
    ? "requires Linux process metadata and the cook-epic shell tools"
    : null;

interface Fixture {
  readonly root: string;
  readonly repo: string;
  readonly bin: string;
  readonly state: string;
  readonly lockFile: string;
}

const execFile = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(command, [...args], { cwd }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

const makeFixture = async (): Promise<Fixture> => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "epic-lock-interop-"));
  const repo = NodePath.join(root, "repo");
  const bin = NodePath.join(root, "bin");
  const state = NodePath.join(root, "state");
  await Promise.all([
    NodeFSP.mkdir(NodePath.join(repo, ".beads"), { recursive: true }),
    NodeFSP.mkdir(bin),
    NodeFSP.mkdir(state),
  ]);
  await execFile("git", ["init", "-q", "-b", "main"], repo);
  await execFile("git", ["config", "user.name", "Lock interop"], repo);
  await execFile("git", ["config", "user.email", "lock@example.invalid"], repo);
  await NodeFSP.writeFile(NodePath.join(repo, "base.txt"), "base\n");
  await execFile("git", ["add", "base.txt"], repo);
  await execFile("git", ["commit", "-qm", "base"], repo);
  await NodeFSP.writeFile(NodePath.join(state, "status"), "open");
  await NodeFSP.writeFile(
    NodePath.join(bin, "bd"),
    `#!/usr/bin/env bash
set -uo pipefail
state="\${FAKE_BD_STATE:?}"
cmd="\${1:-}"; shift || true
status=$(cat "$state/status" 2>/dev/null || printf open)
case "$cmd" in
  show)
    if [ "\${1:-}" = epic ]; then
      printf '{"id":"epic","status":"open","title":"Epic","issue_type":"epic","comment_count":0}\\n'
    else
      printf '{"id":"%s","status":"%s","title":"Child","issue_type":"task","assignee":"%s","comment_count":0}\\n' \
        "\${1:-}" "$status" "$(cat "$state/assignee" 2>/dev/null || true)"
    fi ;;
  ready)
    if [ "$status" = open ]; then printf '[{"id":"child","title":"Child"}]\\n'; else printf '[]\\n'; fi ;;
  list)
    if [ "$status" = closed ]; then printf '[]\\n'; else printf '[{"id":"child","status":"%s"}]\\n' "$status"; fi ;;
  update)
    shift || true
    args=("$@")
    for ((i = 0; i < \${#args[@]}; i++)); do
      if [ "\${args[$i]}" = --assignee ]; then
        printf '%s' "\${args[$((i + 1))]}" > "$state/assignee"
      fi
    done ;;
  close) printf closed > "$state/status" ;;
  note) ;;
  merge-slot|swarm|label) ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  await NodeFSP.writeFile(
    NodePath.join(bin, "worker.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
sleep "\${FIXTURE_SLEEP:-0}"
printf 'work\\n' >> work.txt
git add work.txt
git commit -qm work
bd close "\${COOKEPIC_CHILD:?}"
`,
    { mode: 0o755 },
  );
  return {
    root,
    repo,
    bin,
    state,
    lockFile: NodePath.join(repo, ".beads", "run-lock.epic.json"),
  };
};

const spawnCook = (fixture: Fixture, runDir: string, workerSleep: number) =>
  NodeChildProcess.spawn("bash", [cookEpicRunner, runDir], {
    cwd: fixture.repo,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      FAKE_BD_STATE: fixture.state,
      FIXTURE_SLEEP: String(workerSleep),
      COOKEPIC_EPIC: "epic",
      COOKEPIC_HARNESS: "claude",
      COOKEPIC_WORKER_CMD: NodePath.join(fixture.bin, "worker.sh"),
      COOKEPIC_SEQUENTIAL: "1",
      COOKEPIC_NO_GATE: "1",
      COOKEPIC_NO_PUSH: "1",
      COOKEPIC_DISABLE_SYSTEMD: "1",
      COOKEPIC_SPAWN_DELAY: "0",
      COOKEPIC_SUPERVISION_TICK: "1",
      COOKEPIC_MAX_DISPATCHES: "1",
      COOKEPIC_MAX_ATTEMPTS: "1",
      COOKEPIC_WORKER_TIMEOUT: "60",
      RUNLOCK_HEARTBEAT_SECS: "1",
    },
  });

const waitForFile = async (file: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (NodeFS.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${file}`);
};

const waitForExit = (child: NodeChildProcess.ChildProcess) =>
  new Promise<{ readonly code: number | null; readonly output: string }>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, output: "" });
      return;
    }
    let output = "";
    child.stdout?.on("data", (chunk) => (output += String(chunk)));
    child.stderr?.on("data", (chunk) => (output += String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });

const killGroup = async (child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals) => {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch {}
  }
  await waitForExit(child);
};

const runLock = <A, E>(effect: Effect.Effect<A, E, EpicRunLock>, lockLayer = layer) =>
  effect.pipe(Effect.provide(lockLayer));

const fixtureScope = Effect.acquireRelease(Effect.promise(makeFixture), (fixture) =>
  Effect.promise(() => NodeFSP.rm(fixture.root, { recursive: true, force: true })),
);

const processScope = (start: () => NodeChildProcess.ChildProcess) =>
  Effect.acquireRelease(Effect.sync(start), (child) =>
    child.exitCode !== null || child.signalCode !== null
      ? Effect.void
      : Effect.promise(() => killGroup(child, "SIGKILL")).pipe(Effect.ignore),
  );

it.live.skipIf(unsupportedReason !== null)(
  `rejects a Bash lock, then reads its killed owner as stale (${unsupportedReason ?? "supported"})`,
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* fixtureScope;
        const child = yield* processScope(() =>
          spawnCook(fixture, NodePath.join(fixture.root, "bash-run"), 60),
        );
        yield* Effect.promise(() => waitForFile(fixture.lockFile));
        const raw = yield* Effect.promise(() => NodeFSP.readFile(fixture.lockFile, "utf8"));
        const payload = JSON.parse(raw) as { readonly heartbeatAt: number };
        const holder = yield* runLock(
          Effect.flatMap(EpicRunLock, (locks) =>
            locks.inspect({ workspaceRoot: fixture.repo, epicId: "epic" }),
          ),
        );
        expect(holder?.owner).toBe("terminal");
        const error = yield* runLock(
          Effect.flatMap(EpicRunLock, (locks) =>
            locks.acquire({
              workspaceRoot: fixture.repo,
              epicId: "epic",
              owner: "t3code",
              runDir: fixture.root,
            }),
          ),
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(EpicRunLockHeldError);

        yield* Effect.promise(() => killGroup(child, "SIGKILL"));
        const staleLayer = makeLayer({ now: () => payload.heartbeatAt + 301 });
        expect(
          yield* runLock(
            Effect.flatMap(EpicRunLock, (locks) =>
              locks.inspect({ workspaceRoot: fixture.repo, epicId: "epic" }),
            ),
            staleLayer,
          ),
        ).toBeUndefined();
      }),
    ),
);

it.live.skipIf(unsupportedReason !== null)(
  `makes Bash reject a TypeScript lock and writes the exact payload (${unsupportedReason ?? "supported"})`,
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* fixtureScope;
        yield* Effect.acquireRelease(
          runLock(
            Effect.flatMap(EpicRunLock, (locks) =>
              locks.acquire({
                workspaceRoot: fixture.repo,
                epicId: "epic",
                owner: "t3code",
                runDir: fixture.root,
              }),
            ),
          ),
          (lease) => lease.release.pipe(Effect.ignore),
        );
        const raw = yield* Effect.promise(() => NodeFSP.readFile(fixture.lockFile, "utf8"));
        expect(raw.endsWith("\n")).toBe(true);
        expect(Object.keys(JSON.parse(raw) as object).toSorted()).toEqual([
          "bootId",
          "heartbeatAt",
          "host",
          "owner",
          "pgid",
          "pid",
          "runDir",
          "startTicks",
          "startedAt",
        ]);

        const result = yield* Effect.promise(() =>
          waitForExit(spawnCook(fixture, NodePath.join(fixture.root, "blocked-run"), 0)),
        );
        expect(result.code).toBe(75);
        expect(result.output).toContain('"event":"lock_held"');
        expect(result.output).toContain('"owner":"t3code"');
      }),
    ),
);

it.live.skipIf(unsupportedReason !== null)(
  `lets Bash replace a killed TypeScript owner after clock advance (${unsupportedReason ?? "supported"})`,
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* fixtureScope;
        const owner = yield* processScope(() =>
          NodeChildProcess.spawn("sleep", ["300"], { detached: true, stdio: "ignore" }),
        );
        const ownerPid = owner.pid;
        if (ownerPid === undefined) throw new Error("sleep owner did not receive a pid");
        let now = 1_000;
        const testLayer = makeLayer({ now: () => now });
        yield* Effect.acquireRelease(
          runLock(
            Effect.flatMap(EpicRunLock, (locks) =>
              locks.acquire({
                workspaceRoot: fixture.repo,
                epicId: "epic",
                owner: "t3code",
                runDir: fixture.root,
                pid: ownerPid,
                pgid: ownerPid,
              }),
            ),
            testLayer,
          ),
          (lease: EpicRunLockLease) => lease.release.pipe(Effect.ignore),
        );
        yield* Effect.promise(() => killGroup(owner, "SIGKILL"));
        now += 301;
        expect(
          yield* runLock(
            Effect.flatMap(EpicRunLock, (locks) =>
              locks.inspect({ workspaceRoot: fixture.repo, epicId: "epic" }),
            ),
            testLayer,
          ),
        ).toBeUndefined();

        const result = yield* Effect.promise(() =>
          waitForExit(spawnCook(fixture, NodePath.join(fixture.root, "takeover-run"), 0)),
        );
        expect(result.code).toBe(0);
        expect(result.output).not.toContain('"event":"lock_held"');
        expect(NodeFS.existsSync(fixture.lockFile)).toBe(false);
      }),
    ),
);
