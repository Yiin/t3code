// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDateInEffect:off globalDate:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { EpicRunLock } from "../ports/EpicRunLock.ts";
import { layer, makeLayer } from "./NodeEpicRunLock.ts";

const fixture = Effect.acquireRelease(
  Effect.tryPromise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-epic-lock-"))),
  (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
);

const initialize = (directory: string) =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(NodePath.join(directory, ".beads"));
    await new Promise<void>((resolve, reject) => {
      NodeChildProcess.execFile("git", ["init", "-q"], { cwd: directory }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  });

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const supervisorPids = async () => {
  const ids: Array<number> = [];
  for (const name of await NodeFSP.readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const [stat, cmdline] = await Promise.all([
        NodeFSP.readFile(`/proc/${name}/stat`, "utf8"),
        NodeFSP.readFile(`/proc/${name}/cmdline`, "utf8"),
      ]);
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
      if (Number(fields[1]) === process.pid && cmdline.includes("epic-run-supervisor")) {
        ids.push(Number(name));
      }
    } catch {}
  }
  return ids.toSorted((left, right) => left - right);
};

describe("EpicRunLock", () => {
  it.live("uses and cleans up a distinct supervisor process for every run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fixture;
        yield* initialize(directory);
        const locks = yield* EpicRunLock;
        const first = yield* locks.acquire({
          workspaceRoot: directory,
          epicId: "one",
          owner: "t3code",
          runDir: "/tmp/one",
        });
        const second = yield* locks.acquire({
          workspaceRoot: directory,
          epicId: "two",
          owner: "t3code",
          runDir: "/tmp/two",
        });
        expect(first.owner.pid).not.toBe(process.pid);
        expect(second.owner.pid).not.toBe(process.pid);
        expect(first.owner.pid).not.toBe(second.owner.pid);
        expect(isAlive(first.owner.pid)).toBe(true);
        expect(isAlive(second.owner.pid)).toBe(true);
        yield* first.release;
        yield* second.release;
        yield* Effect.sleep("50 millis");
        expect(isAlive(first.owner.pid)).toBe(false);
        expect(isAlive(second.owner.pid)).toBe(false);
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.live("cleans up the per-run supervisor when acquisition loses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fixture;
        yield* initialize(directory);
        const locks = yield* EpicRunLock;
        const held = yield* locks.acquire({
          workspaceRoot: directory,
          epicId: "epic",
          owner: "terminal",
          runDir: "/tmp/held",
        });
        const before = yield* Effect.promise(supervisorPids);
        yield* Effect.flip(
          locks.acquire({
            workspaceRoot: directory,
            epicId: "epic",
            owner: "t3code",
            runDir: "/tmp/loser",
          }),
        );
        yield* Effect.sleep("50 millis");
        expect(yield* Effect.promise(supervisorPids)).toEqual(before);
        yield* held.release;
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.live("does not start a supervisor when workspace resolution fails", () =>
    Effect.gen(function* () {
      const before = yield* Effect.promise(supervisorPids);
      const locks = yield* EpicRunLock;
      const invalid = NodePath.join(
        NodeOS.tmpdir(),
        `missing-epic-workspace-${process.pid}-${Date.now()}`,
      );
      yield* Effect.flip(
        locks.acquire({
          workspaceRoot: invalid,
          epicId: "epic",
          owner: "t3code",
          runDir: "/tmp/invalid",
        }),
      );
      yield* Effect.sleep("50 millis");
      expect(yield* Effect.promise(supervisorPids)).toEqual(before);
    }).pipe(Effect.provide(layer)),
  );
  it.live("acquires, heartbeats, excludes, reports, and owner-safely releases", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fixture;
        yield* initialize(directory);
        const locks = yield* EpicRunLock;
        const lease = yield* locks.acquire({
          workspaceRoot: directory,
          epicId: "epic/a",
          owner: "t3code",
          runDir: "/tmp/run-a",
        });
        expect(NodePath.basename(lease.path)).toBe("run-lock.epic-a.json");
        expect((yield* locks.inspect({ workspaceRoot: directory, epicId: "epic/a" }))?.owner).toBe(
          "t3code",
        );
        const before = (yield* locks.inspect({ workspaceRoot: directory, epicId: "epic/a" }))
          ?.heartbeatAt;
        yield* Effect.sleep("1100 millis");
        expect(yield* lease.heartbeat).toBe(true);
        expect(
          (yield* locks.inspect({ workspaceRoot: directory, epicId: "epic/a" }))?.heartbeatAt,
        ).toBeGreaterThan(before ?? 0);
        const common = yield* Effect.promise(() =>
          NodeFSP.realpath(NodePath.join(directory, ".git")),
        );
        const exclude = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(common, "info", "exclude"), "utf8"),
        );
        expect(exclude).toContain(".beads/run-lock.*");
        expect(yield* lease.release).toBe(true);
        expect(
          yield* locks.inspect({ workspaceRoot: directory, epicId: "epic/a" }),
        ).toBeUndefined();
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.live("refuses a live owner and takes one stale local lock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fixture;
        yield* initialize(directory);
        const locks = yield* EpicRunLock;
        const first = yield* locks.acquire({
          workspaceRoot: directory,
          epicId: "epic",
          owner: "terminal",
          runDir: "/tmp/first",
        });
        const held = yield* Effect.flip(
          locks.acquire({
            workspaceRoot: directory,
            epicId: "epic",
            owner: "t3code",
            runDir: "/tmp/second",
          }),
        );
        expect(held._tag).toBe("EpicRunLockHeldError");
        yield* first.release;

        const staleFile = NodePath.join(directory, ".beads", "run-lock.epic.json");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            staleFile,
            JSON.stringify({
              owner: "terminal",
              host: NodeOS.hostname(),
              pid: 999_999_999,
              pgid: 999_999_999,
              runDir: "/tmp/dead",
              startedAt: "old",
              heartbeatAt: 1,
            }),
          ),
        );
        const replacement = yield* locks.acquire({
          workspaceRoot: directory,
          epicId: "epic",
          owner: "t3code",
          runDir: "/tmp/replacement",
        });
        expect((yield* locks.inspect({ workspaceRoot: directory, epicId: "epic" }))?.runDir).toBe(
          "/tmp/replacement",
        );
        yield* replacement.release;
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.live("follows a worktree beads redirect and preserves a foreign-host lock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fixture;
        yield* initialize(directory);
        const shared = NodePath.join(directory, "shared-beads");
        yield* Effect.promise(() => NodeFSP.mkdir(shared));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(directory, ".beads", "redirect"), "shared-beads\n"),
        );
        const foreign = NodePath.join(shared, "run-lock.epic.json");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            foreign,
            JSON.stringify({
              owner: "terminal",
              host: "another-host",
              pid: 999_999_999,
              heartbeatAt: 1,
            }),
          ),
        );
        const locks = yield* EpicRunLock;
        const held = yield* Effect.flip(
          locks.acquire({
            workspaceRoot: directory,
            epicId: "epic",
            owner: "t3code",
            runDir: "/tmp/run",
          }),
        );
        expect(held._tag).toBe("EpicRunLockHeldError");
        if (held._tag === "EpicRunLockHeldError") expect(held.path).toBe(foreign);
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.live("takes malformed, old-boot, and recycled-pid locks but preserves replacements", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fixture;
        yield* initialize(directory);
        const locks = yield* EpicRunLock;
        const file = NodePath.join(directory, ".beads", "run-lock.epic.json");

        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(file, "{");
          const old = new Date(0);
          await NodeFSP.utimes(file, old, old);
        });
        const malformed = yield* locks.acquire({
          workspaceRoot: directory,
          epicId: "epic",
          owner: "t3code",
          runDir: "/tmp/malformed",
        });
        yield* malformed.release;

        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            file,
            JSON.stringify({
              owner: "terminal",
              host: NodeOS.hostname(),
              bootId: "not-this-boot",
              pid: process.pid,
              heartbeatAt: Math.floor(Date.now() / 1000),
            }),
          ),
        );
        const oldBoot = yield* locks.acquire({
          workspaceRoot: directory,
          epicId: "epic",
          owner: "t3code",
          runDir: "/tmp/boot",
        });
        yield* oldBoot.release;

        const lease = yield* locks.acquire({
          workspaceRoot: directory,
          epicId: "epic",
          owner: "t3code",
          runDir: "/tmp/original",
        });
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            file,
            JSON.stringify({
              owner: "terminal",
              host: NodeOS.hostname(),
              pid: process.pid,
              pgid: process.pid,
              runDir: "/tmp/replacement",
              startedAt: "replacement",
              heartbeatAt: Math.floor(Date.now() / 1000),
            }),
          ),
        );
        expect(yield* lease.heartbeat).toBe(false);
        expect(yield* lease.release).toBe(false);
        expect((yield* locks.inspect({ workspaceRoot: directory, epicId: "epic" }))?.runDir).toBe(
          "/tmp/replacement",
        );
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.live("applies heartbeat, pid identity, process-group, and malformed-age staleness rules", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fixture;
        yield* initialize(directory);
        const locks = yield* EpicRunLock;
        const file = NodePath.join(directory, ".beads", "run-lock.epic.json");
        const now = Math.floor(Date.now() / 1000);
        const proc = yield* Effect.promise(() =>
          NodeFSP.readFile(`/proc/${process.pid}/stat`, "utf8"),
        );
        const fields = proc.slice(proc.lastIndexOf(") ") + 2).split(" ");
        const pgid = Number(fields[2]);
        const ticks = fields[19] ?? "";
        const base = {
          owner: "terminal",
          host: NodeOS.hostname(),
          pid: process.pid,
          pgid,
          runDir: "/tmp/held",
          startedAt: "old",
        };
        const expectHeld = (payload: object) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => NodeFSP.writeFile(file, JSON.stringify(payload)));
            const error = yield* Effect.flip(
              locks.acquire({
                workspaceRoot: directory,
                epicId: "epic",
                owner: "t3code",
                runDir: "/tmp/new",
              }),
            );
            expect(error._tag).toBe("EpicRunLockHeldError");
          });

        // A fresh heartbeat no longer vouches for an owner that is provably
        // gone. It used to: a crashed server restarted in seconds, found the
        // lock its own corpse had just heartbeated, and failed the run with
        // "another epic run owns this repository" — locked out of its own
        // recovery by a heartbeat it wrote moments before dying.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            file,
            JSON.stringify({ ...base, pid: 999_999_999, pgid: 999_999_999, heartbeatAt: now }),
          ),
        );
        const afterCrash = yield* locks.acquire({
          workspaceRoot: directory,
          epicId: "epic",
          owner: "t3code",
          runDir: "/tmp/after-crash",
        });
        yield* afterCrash.release;

        // A live owner still holds it, heartbeat fresh or long stale.
        yield* expectHeld({ ...base, startTicks: ticks, heartbeatAt: now });
        yield* expectHeld({ ...base, startTicks: ticks, heartbeatAt: 1 });
        yield* expectHeld({ ...base, startTicks: "recycled", heartbeatAt: 1 });

        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            file,
            JSON.stringify({
              ...base,
              pgid: 999_999_999,
              startTicks: "recycled",
              heartbeatAt: 1,
            }),
          ),
        );
        const recycled = yield* locks.acquire({
          workspaceRoot: directory,
          epicId: "epic",
          owner: "t3code",
          runDir: "/tmp/recycled",
        });
        yield* recycled.release;

        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(file, "{");
          const recent = new Date();
          await NodeFSP.utimes(file, recent, recent);
        });
        const recentMalformed = yield* Effect.flip(
          locks.acquire({
            workspaceRoot: directory,
            epicId: "epic",
            owner: "t3code",
            runDir: "/tmp/new",
          }),
        );
        expect(recentMalformed._tag).toBe("EpicRunLockHeldError");
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.live("waits for the advisory guard before acquiring", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fixture;
        yield* initialize(directory);
        const guard = NodePath.join(directory, ".beads", "run-lock.epic.json.guard");
        const blocker = NodeChildProcess.spawn("flock", [guard, "sleep", "0.2"]);
        yield* Effect.sleep("30 millis");
        const locks = yield* EpicRunLock;
        const started = Date.now();
        const lease = yield* locks.acquire({
          workspaceRoot: directory,
          epicId: "epic",
          owner: "t3code",
          runDir: "/tmp/run",
        });
        expect(Date.now() - started).toBeGreaterThanOrEqual(100);
        yield* lease.release;
        blocker.kill();
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.live("allows exactly one winner when two contenders take over the same stale lock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fixture;
        yield* initialize(directory);
        const file = NodePath.join(directory, ".beads", "run-lock.epic.json");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            file,
            JSON.stringify({
              owner: "dead",
              host: NodeOS.hostname(),
              pid: 999_999_999,
              pgid: 999_999_999,
              heartbeatAt: 1,
            }),
          ),
        );
        const locks = yield* EpicRunLock;
        const attempts = yield* Effect.all(
          ["one", "two"].map((runDir) =>
            Effect.exit(
              locks.acquire({
                workspaceRoot: directory,
                epicId: "epic",
                owner: "t3code",
                runDir,
              }),
            ),
          ),
          { concurrency: "unbounded" },
        );
        const successes = attempts.filter((exit) => exit._tag === "Success");
        expect(successes).toHaveLength(1);
        if (successes[0]?._tag === "Success") yield* successes[0].value.release;
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.live("does not clobber a replacement installed during heartbeat commit", () => {
    let file = "";
    const testLayer = makeLayer({
      beforeHeartbeatCommit: async () => {
        const temp = `${file}.replacement`;
        await NodeFSP.writeFile(
          temp,
          JSON.stringify({
            owner: "terminal",
            host: NodeOS.hostname(),
            pid: process.pid,
            pgid: process.pid,
            runDir: "/tmp/replacement",
            startedAt: "replacement",
            heartbeatAt: Math.floor(Date.now() / 1000),
          }),
        );
        await NodeFSP.rename(temp, file);
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fixture;
        yield* initialize(directory);
        file = NodePath.join(directory, ".beads", "run-lock.epic.json");
        const locks = yield* EpicRunLock;
        const lease = yield* locks.acquire({
          workspaceRoot: directory,
          epicId: "epic",
          owner: "t3code",
          runDir: "/tmp/original",
        });
        expect(yield* lease.heartbeat).toBe(false);
        expect((yield* locks.inspect({ workspaceRoot: directory, epicId: "epic" }))?.runDir).toBe(
          "/tmp/replacement",
        );
        expect(yield* lease.release).toBe(false);
      }).pipe(Effect.provide(testLayer)),
    );
  });
  it.live("shares locks between a main checkout and a linked worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fixture;
        yield* initialize(directory);
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) =>
              NodeFSP.writeFile(NodePath.join(directory, "base.txt"), "base\n")
                .then(() =>
                  NodeChildProcess.execFile(
                    "git",
                    ["add", "base.txt"],
                    { cwd: directory },
                    (error) => (error ? reject(error) : resolve()),
                  ),
                )
                .catch(reject),
            ),
        );
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) =>
              NodeChildProcess.execFile(
                "git",
                [
                  "-c",
                  "user.name=lock-test",
                  "-c",
                  "user.email=lock@test",
                  "commit",
                  "-qm",
                  "base",
                ],
                { cwd: directory },
                (error) => (error ? reject(error) : resolve()),
              ),
            ),
        );
        const worktree = NodePath.join(directory, "linked-worktree");
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) =>
              NodeChildProcess.execFile(
                "git",
                ["worktree", "add", "-q", "-b", "linked", worktree],
                { cwd: directory },
                (error) => (error ? reject(error) : resolve()),
              ),
            ),
        );
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(worktree, ".beads")));

        const locks = yield* EpicRunLock;
        const mainLease = yield* locks.acquire({
          workspaceRoot: directory,
          epicId: "epic",
          owner: "t3code",
          runDir: directory,
        });
        expect((yield* locks.inspect({ workspaceRoot: worktree, epicId: "epic" }))?.owner).toBe(
          "t3code",
        );
        const held = yield* Effect.flip(
          locks.acquire({
            workspaceRoot: worktree,
            epicId: "epic",
            owner: "terminal",
            runDir: worktree,
          }),
        );
        expect(held._tag).toBe("EpicRunLockHeldError");
        const independent = yield* locks.acquire({
          workspaceRoot: worktree,
          epicId: "other-epic",
          owner: "terminal",
          runDir: worktree,
        });
        yield* independent.release;
        yield* mainLease.release;
      }).pipe(Effect.provide(layer)),
    ),
  );
});
