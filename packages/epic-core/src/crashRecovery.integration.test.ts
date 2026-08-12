// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalDateInEffect:off globalTimers:off
/**
 * What a crash leaves behind, and whether a run can pick it back up.
 *
 * Four recovery bugs surfaced in production on 2026-08-09, each found by an
 * outage and each revealing the next. They were one flaw: a run's durable
 * resources were checked by EXISTENCE rather than OWNERSHIP, so after a crash
 * a run could not recognise its own belongings and every ambiguity resolved to
 * "someone else is here, refuse".
 *
 * These cells use real artifacts, because every one of those bugs lived in the
 * gap between a fake and the real thing: a real process really killed, a real
 * git repository, a real `bd` on PATH. A fake that answers what the test
 * expects cannot catch a rule that misreads what the world actually says.
 *
 * Not covered here: the server boot path end to end, which needs a running
 * server (t3code-i7g.1 tracks the remaining cell).
 */
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeProcessMergeSlot } from "./adapters/ProcessMergeSlot.ts";
import * as EpicRunPreflight from "./EpicRunPreflight.ts";
import { EpicRunConfigSource } from "./EpicRunConfigSource.ts";
import { layer as lockLayer } from "./adapters/NodeEpicRunLock.ts";
import { EpicRunLock, EpicRunLockHeldError } from "./ports/EpicRunLock.ts";
import { integrationBranch, mergeSlotHolder } from "./policy.ts";
import * as ProcessRunner from "./processRunner.ts";

const packageRoot = NodePath.resolve(import.meta.dirname, "..");
const lockAdapter = NodePath.join(packageRoot, "src/adapters/NodeEpicRunLock.ts");
const lockPort = NodePath.join(packageRoot, "src/ports/EpicRunLock.ts");

const unsupportedReason = !NodeFS.existsSync("/proc/self/stat")
  ? "requires Linux process metadata"
  : null;

const RUN_ID = "run-crash-1";
const EPIC_ID = "epic";

const execFile = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(command, [...args], { cwd }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

const makeRepo = async (): Promise<string> => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "epic-crash-"));
  const repo = NodePath.join(root, "repo");
  await NodeFSP.mkdir(NodePath.join(repo, ".beads"), { recursive: true });
  await execFile("git", ["init", "-q", "-b", "main"], repo);
  await execFile("git", ["config", "user.name", "Crash recovery"], repo);
  await execFile("git", ["config", "user.email", "crash@example.invalid"], repo);
  await NodeFSP.writeFile(NodePath.join(repo, "base.txt"), "base\n");
  await execFile("git", ["add", "base.txt"], repo);
  await execFile("git", ["commit", "-qm", "base"], repo);
  return repo;
};

const repoScope = Effect.acquireRelease(Effect.promise(makeRepo), (repo) =>
  Effect.promise(() => NodeFSP.rm(NodePath.dirname(repo), { recursive: true, force: true })),
);

/**
 * A separate process that really takes the lock through the real adapter, then
 * stays alive until it is killed.
 *
 * A hand-written lock file would only assert what this test already believes.
 * The adapter records a supervisor pid and pgid, and the supervisor exits on
 * its own about a second after its parent dies — so what a kill leaves behind
 * is the adapter's business, not the test's.
 */
const holderScript = (repo: string) => `
const Effect = await import("effect/Effect");
const { layer } = await import(${JSON.stringify(lockAdapter)});
const { EpicRunLock } = await import(${JSON.stringify(lockPort)});
await Effect.runPromise(
  Effect.flatMap(EpicRunLock, (locks) =>
    locks.acquire({
      workspaceRoot: ${JSON.stringify(repo)},
      epicId: ${JSON.stringify(EPIC_ID)},
      owner: "t3code",
      runDir: ${JSON.stringify(repo)},
    }),
  ).pipe(Effect.provide(layer)),
);
console.log("acquired");
setInterval(() => {}, 1000);
`;

const spawnHolder = (repo: string): NodeChildProcess.ChildProcess =>
  NodeChildProcess.spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", holderScript(repo)],
    // cwd is the package, not the temp repo: a bare `effect` import has to
    // resolve through node_modules. The repo path travels in the script.
    { cwd: packageRoot, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );

const waitForAcquired = (child: NodeChildProcess.ChildProcess) =>
  new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`holder never acquired: ${output}`)), 30_000);
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("acquired")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on("data", (chunk) => (output += String(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

const processGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
};

/** Kill the group, the way a systemd stop takes the whole service cgroup. */
const killGroupAndWait = async (child: NodeChildProcess.ChildProcess): Promise<void> => {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (processGone(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("holder did not die");
};

const holderScope = (repo: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const child = spawnHolder(repo);
      await waitForAcquired(child);
      return child;
    }),
    (child) => Effect.promise(() => killGroupAndWait(child)).pipe(Effect.ignore),
  );

const lockFileOf = (repo: string) => NodePath.join(repo, ".beads", `run-lock.${EPIC_ID}.json`);

/** Wait for the adapter's supervisor to notice its parent died and exit. */
const waitForOwnerDeath = async (repo: string): Promise<void> => {
  const holder = JSON.parse(await NodeFSP.readFile(lockFileOf(repo), "utf8")) as {
    readonly pid: number;
  };
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (processGone(holder.pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("lock supervisor outlived its owner");
};

/** A real `bd` on PATH: enough for preflight to find the epic, plus the slot. */
const makeFakeBeads = async (repo: string): Promise<string> => {
  const binDirectory = NodePath.join(NodePath.dirname(repo), "bin");
  const statePath = NodePath.join(NodePath.dirname(repo), "slot-holder");
  await NodeFSP.mkdir(binDirectory, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(binDirectory, "bd"),
    `#!/usr/bin/env bash
set -uo pipefail
state="${statePath}"
case "\${1:-}" in
  show) printf '{"id":"epic","status":"open","title":"Epic","issue_type":"epic","comment_count":0}\\n' ;;
  ready) printf '[{"id":"child","title":"Child"}]\\n' ;;
  list) printf '[{"id":"child","status":"open"}]\\n' ;;
  merge-slot)
    if [ "\${2:-}" = check ]; then
      holder=$(cat "$state" 2>/dev/null || true)
      if [ -z "$holder" ]; then
        printf '{"available":true,"holder":null,"id":"epic-merge-slot","waiters":null}\\n'
      else
        printf '{"available":false,"holder":"%s","id":"epic-merge-slot","waiters":null}\\n' "$holder"
      fi
    elif [ "\${2:-}" = release ]; then
      : > "$state"
    fi ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  return binDirectory;
};

const slotStatePath = (repo: string) => NodePath.join(NodePath.dirname(repo), "slot-holder");

const withLock = <A, E>(effect: Effect.Effect<A, E, EpicRunLock>) =>
  effect.pipe(Effect.provide(lockLayer));

const acquire = (repo: string) =>
  withLock(
    Effect.flatMap(EpicRunLock, (locks) =>
      locks.acquire({
        workspaceRoot: repo,
        epicId: EPIC_ID,
        owner: "t3code",
        runDir: repo,
      }),
    ),
  );

const inspect = (repo: string) =>
  withLock(
    Effect.flatMap(EpicRunLock, (locks) => locks.inspect({ workspaceRoot: repo, epicId: EPIC_ID })),
  );

it.live.skipIf(unsupportedReason !== null)(
  "reclaims the lock of a killed owner at the real clock, with no heartbeat to wait out",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The production shape exactly: the owner heartbeats until the instant
        // it dies, and the restart is seconds behind. Before liveness was
        // checked first, this read as a live holder for five minutes and the
        // server failed its own run with "another epic run owns this
        // repository", naming its own dead pid.
        const repo = yield* repoScope;
        const child = yield* holderScope(repo);

        const before = yield* inspect(repo);
        expect(before?.owner).toBe("t3code");

        yield* Effect.promise(() => killGroupAndWait(child));
        yield* Effect.promise(() => waitForOwnerDeath(repo));

        const heartbeat = (
          JSON.parse(yield* Effect.promise(() => NodeFSP.readFile(lockFileOf(repo), "utf8"))) as {
            readonly heartbeatAt: number;
          }
        ).heartbeatAt;
        // No clock fakery: the heartbeat is genuinely seconds old, which is
        // the whole point. Waiting out the staleness window would prove
        // nothing about a crash-restart, which is always faster than it.
        expect(Math.floor(Date.now() / 1000) - heartbeat).toBeLessThan(300);

        expect(yield* inspect(repo)).toBeUndefined();
        const lease = yield* acquire(repo);
        yield* lease.release;
      }),
    ),
);

it.live.skipIf(unsupportedReason !== null)("refuses the lock of an owner that is still alive", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // The safety half. Reclaiming on death is only correct while a living
      // owner is still untouchable, or one boot steals another run's work.
      const repo = yield* repoScope;
      yield* holderScope(repo);

      const error = yield* Effect.flip(acquire(repo));

      expect(error).toBeInstanceOf(EpicRunLockHeldError);
      expect((yield* inspect(repo))?.owner).toBe("t3code");
    }),
  ),
);

it.live.skipIf(unsupportedReason !== null)(
  "reclaims a merge slot left under this run's own holder, and no other",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Through a real `bd` on PATH, so the reclaim is decided by what the
        // CLI actually prints rather than by a fake echoing the test back.
        const repo = yield* repoScope;
        const binDirectory = yield* Effect.promise(() => makeFakeBeads(repo));
        const statePath = slotStatePath(repo);

        const runner = yield* ProcessRunner.ProcessRunner;
        const slot = makeProcessMergeSlot({
          repositoryPath: repo,
          // The real runner, with the fake `bd` first on PATH.
          processRunner: {
            run: (input) =>
              runner.run({
                ...input,
                env: { PATH: `${binDirectory}:${process.env["PATH"] ?? ""}` },
              }),
          },
        });

        const ours = mergeSlotHolder(RUN_ID);
        yield* Effect.promise(() => NodeFSP.writeFile(statePath, "cook-epic-someone-else"));
        expect(yield* slot.reclaim(ours)).toEqual({ reclaimed: false });
        expect(yield* Effect.promise(() => NodeFSP.readFile(statePath, "utf8"))).toBe(
          "cook-epic-someone-else",
        );

        yield* Effect.promise(() => NodeFSP.writeFile(statePath, ours));
        expect(yield* slot.reclaim(ours)).toEqual({ reclaimed: true });
        expect(yield* Effect.promise(() => NodeFSP.readFile(statePath, "utf8"))).toBe("");
      }).pipe(
        Effect.provide(
          Layer.merge(
            NodeServices.layer,
            ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
      ),
    ),
);

it.live.skipIf(unsupportedReason !== null)(
  "blocks a fresh launch on a leftover integration branch but lets its owner resume",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Through the real preflight, real git, and a real `bd` on PATH. The
        // bug was a name comparison against `git branch --list` output, and a
        // fake that hands the expected strings back cannot fail that way.
        const repo = yield* repoScope;
        const binDirectory = yield* Effect.promise(() => makeFakeBeads(repo));
        const branch = integrationBranch(RUN_ID);
        const worktree = NodePath.join(NodePath.dirname(repo), "integration");
        yield* Effect.promise(() =>
          execFile("git", ["worktree", "add", "-q", worktree, "-b", branch, "main"], repo),
        );

        const runner = yield* ProcessRunner.ProcessRunner;
        const preflightLayer = EpicRunPreflight.layer.pipe(
          Layer.provide(
            Layer.succeed(EpicRunConfigSource, { read: () => Effect.succeed({ _tag: "absent" }) }),
          ),
          Layer.provide(
            Layer.succeed(ProcessRunner.ProcessRunner, {
              run: (input) =>
                runner.run({
                  ...input,
                  env: { PATH: `${binDirectory}:${process.env["PATH"] ?? ""}` },
                }),
            }),
          ),
          Layer.provide(lockLayer),
        );
        const check = (resumingRunId?: string) =>
          Effect.flatMap(EpicRunPreflight.EpicRunPreflight, (preflight) =>
            preflight.check({
              workspaceRoot: repo,
              epicId: EPIC_ID,
              mode: "parallel",
              ...(resumingRunId === undefined
                ? {}
                : { resume: { runId: resumingRunId, worktreePaths: [] } }),
            }),
          ).pipe(Effect.provide(preflightLayer));

        // A fresh launch has no claim on it and must still be refused.
        const fresh = yield* check();
        expect(fresh.blockers.filter((blocker) => blocker._tag === "integration_leftover")).toEqual(
          [{ _tag: "integration_leftover", branch, worktreePath: worktree }],
        );

        // Its owner resuming is not a leftover; it is where the run left off.
        const resumed = yield* check(RUN_ID);
        expect(resumed.blockers.some((blocker) => blocker._tag === "integration_leftover")).toBe(
          false,
        );

        // Forgiveness is exact, never blanket.
        const otherRun = yield* check("run-somebody-else");
        expect(otherRun.blockers.some((blocker) => blocker._tag === "integration_leftover")).toBe(
          true,
        );

        yield* Effect.promise(() =>
          execFile("git", ["worktree", "remove", "--force", worktree], repo),
        );
      }).pipe(
        Effect.provide(
          Layer.merge(
            NodeServices.layer,
            ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
      ),
    ),
);
