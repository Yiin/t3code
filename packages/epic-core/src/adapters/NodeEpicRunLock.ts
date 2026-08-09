// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalRandom:off globalDateInEffect:off globalTimers:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  EpicRunLock,
  EpicRunLockError,
  EpicRunLockHeldError,
  type EpicRunLockLease,
  type EpicRunLockOwner,
} from "../ports/EpicRunLock.ts";

const staleSeconds = 300;
const heartbeatMilliseconds = 30_000;

export interface NodeEpicRunLockOptions {
  readonly beforeHeartbeatCommit?: () => Promise<void>;
  readonly now?: () => number;
}

const startTicks = async (pid: number): Promise<string> => {
  try {
    const stat = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19] ?? "";
  } catch {
    return "";
  }
};

const processGroup = async (): Promise<number> => {
  try {
    const stat = await NodeFSP.readFile("/proc/self/stat", "utf8");
    return Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[2] ?? 0);
  } catch {
    return 0;
  }
};

const bootId = async (): Promise<string> => {
  try {
    return (await NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  } catch {
    return "";
  }
};

/**
 * `EPERM` means the process is alive and owned by somebody else — signal 0 was
 * refused, not undeliverable. Only `ESRCH` proves absence. Collapsing the two
 * would let one user's boot declare another user's live run dead and steal its
 * lock, which matters now that death alone can reclaim a fresh lock.
 */
const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const startSupervisor = () => {
  const child = NodeChildProcess.spawn(
    "sh",
    [
      "-c",
      'trap "exit 0" TERM INT; while kill -0 "$1" 2>/dev/null; do sleep 1; done',
      "epic-run-supervisor",
      String(process.pid),
    ],
    { detached: true, stdio: "ignore" },
  );
  const pid = child.pid;
  if (pid === undefined) throw new Error("epic run supervisor did not receive a pid");
  child.unref();
  return {
    pid,
    stop: async () => {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 200))]);
      if (processExists(pid)) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 200))]);
      }
    },
  };
};

/** Same `EPERM`-is-alive rule as {@link processExists}, for a process group. */
const groupExists = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const lockDirectory = async (workspaceRoot: string): Promise<string> => {
  const beads = NodePath.join(workspaceRoot, ".beads");
  try {
    const beadsReal = await NodeFSP.realpath(beads);
    try {
      const redirect = (
        await NodeFSP.readFile(NodePath.join(beadsReal, "redirect"), "utf8")
      ).trim();
      if (redirect) {
        const target = NodePath.isAbsolute(redirect)
          ? redirect
          : NodePath.resolve(workspaceRoot, redirect);
        return await NodeFSP.realpath(target);
      }
    } catch {
      // A normal .beads directory has no redirect.
    }
    return beadsReal;
  } catch {
    const common = await runGit(workspaceRoot, ["rev-parse", "--git-common-dir"]);
    return NodeFSP.realpath(NodePath.resolve(workspaceRoot, common.trim()));
  }
};

const runGit = (cwd: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr || `git exited ${code}`)),
    );
  });

const lockPath = async (workspaceRoot: string, key: string): Promise<string> =>
  NodePath.join(
    await lockDirectory(workspaceRoot),
    `run-lock.${key.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`,
  );

const addExclude = async (workspaceRoot: string, directory: string): Promise<void> => {
  const commonRaw = await runGit(workspaceRoot, ["rev-parse", "--git-common-dir"]);
  const common = await NodeFSP.realpath(NodePath.resolve(workspaceRoot, commonRaw.trim()));
  if (directory === common || directory.startsWith(`${common}${NodePath.sep}`)) return;
  const info = NodePath.join(common, "info");
  const exclude = NodePath.join(info, "exclude");
  await NodeFSP.mkdir(info, { recursive: true });
  let contents = "";
  try {
    contents = await NodeFSP.readFile(exclude, "utf8");
  } catch {}
  if (!contents.split(/\r?\n/).includes(".beads/run-lock.*")) {
    await NodeFSP.appendFile(
      exclude,
      `${contents && !contents.endsWith("\n") ? "\n" : ""}.beads/run-lock.*\n`,
    );
  }
};

const readHolder = async (file: string): Promise<EpicRunLockOwner | undefined> => {
  try {
    return JSON.parse(await NodeFSP.readFile(file, "utf8")) as EpicRunLockOwner;
  } catch {
    return undefined;
  }
};

/**
 * Whether the recorded owner is provably gone on this host.
 *
 * "Provably" is the whole point: an absent pid, or a pid whose process is
 * alive but started at a different time (the number was reused), with no
 * surviving process group either. Anything short of that — no pid recorded,
 * an unreadable `/proc`, a live matching process — is not evidence of death
 * and must leave the lock alone.
 */
const ownerIsDead = async (value: Partial<EpicRunLockOwner>): Promise<boolean> => {
  if (!Number.isInteger(value.pid) || value.pid! < 1) return false;
  if (processExists(value.pid!)) {
    if (!value.startTicks || value.startTicks === (await startTicks(value.pid!))) return false;
  }
  // The leader is gone. Its process group is the last evidence of life: a
  // terminal coordinator's workers outlive the leader that spawned them.
  return !(Number.isInteger(value.pgid) && value.pgid! > 0 && groupExists(value.pgid!));
};

const isStale = async (file: string, now: number): Promise<boolean> => {
  let value: Partial<EpicRunLockOwner>;
  try {
    value = JSON.parse(await NodeFSP.readFile(file, "utf8")) as Partial<EpicRunLockOwner>;
  } catch {
    const stat = await NodeFSP.stat(file);
    return now - Math.floor(stat.mtimeMs / 1000) >= staleSeconds;
  }
  if (value.host !== NodeOS.hostname()) return false;
  const currentBoot = await bootId();
  if (value.bootId && value.bootId !== currentBoot) return true;
  // Liveness BEFORE heartbeat freshness, or a crashed run can never resume.
  // The owner heartbeats until the instant it dies, and a restart is always
  // faster than the staleness window, so the fresh heartbeat of a corpse used
  // to read as a live holder: the server came back, found a lock naming its
  // own dead pid, and failed the run with "another epic run owns this
  // repository". That is a hard kill locking a run out of its own recovery.
  if (await ownerIsDead(value)) return true;
  if (now - (Number.isInteger(value.heartbeatAt) ? value.heartbeatAt! : 0) < staleSeconds) {
    return false;
  }
  // Past the staleness window with no pid to check, nothing can vouch for the
  // owner and the lock has to be reclaimable.
  return !Number.isInteger(value.pid) || value.pid! < 1;
};

const withGuard = async <A>(file: string, body: () => Promise<A>): Promise<A> => {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  return new Promise<A>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "flock",
      ["-w", "10", `${file}.guard`, "sh", "-c", "printf x; cat >/dev/null"],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let started = false;
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      if (!started) finish(() => reject(new Error(`flock guard exited ${code}`)));
    });
    child.stdout.once("data", () => {
      started = true;
      body().then(
        (result) => {
          child.stdin.end();
          child.once("close", () => finish(() => resolve(result)));
        },
        (error) => {
          child.stdin.end();
          child.once("close", () => finish(() => reject(error)));
        },
      );
    });
  });
};

const makeLease = (
  file: string,
  owner: EpicRunLockOwner,
  now: () => number,
  stopTimer: () => void,
  stopSupervisor: () => Promise<void>,
  beforeHeartbeatCommit?: () => Promise<void>,
): EpicRunLockLease => {
  const update = async (): Promise<boolean> => {
    let before;
    try {
      before = await NodeFSP.stat(file);
      const current = JSON.parse(await NodeFSP.readFile(file, "utf8")) as EpicRunLockOwner;
      if (current.pid !== owner.pid || current.startedAt !== owner.startedAt) return false;
      const temp = `${file}.hb.${owner.pid}.${Math.random().toString(36).slice(2)}`;
      await NodeFSP.writeFile(temp, `${JSON.stringify({ ...current, heartbeatAt: now() })}\n`, {
        flag: "wx",
      });
      await beforeHeartbeatCommit?.();
      const after = await NodeFSP.stat(file);
      if (before.dev !== after.dev || before.ino !== after.ino) {
        await NodeFSP.unlink(temp).catch(() => undefined);
        return false;
      }
      await NodeFSP.rename(temp, file);
      return true;
    } catch {
      return false;
    }
  };
  return {
    path: file,
    owner,
    heartbeat: Effect.tryPromise({
      try: update,
      catch: (cause) => new EpicRunLockError("heartbeat", cause),
    }),
    release: Effect.tryPromise({
      try: async () => {
        stopTimer();
        const released = await withGuard(file, async () => {
          const current = await readHolder(file);
          if (current?.pid !== owner.pid || current.startedAt !== owner.startedAt) return false;
          await NodeFSP.unlink(file);
          return true;
        });
        await stopSupervisor();
        return released;
      },
      catch: (cause) => new EpicRunLockError("release", cause),
    }),
  };
};

export const makeLayer = (options: NodeEpicRunLockOptions = {}) => {
  const now = () => options.now?.() ?? Math.floor(Date.now() / 1000);
  return Layer.succeed(EpicRunLock, {
    inspect: ({ workspaceRoot, epicId }) =>
      Effect.tryPromise({
        try: async () => {
          const file = await lockPath(workspaceRoot, epicId);
          const holder = await readHolder(file);
          if (holder === undefined) return undefined;
          return (await isStale(file, now())) ? undefined : holder;
        },
        catch: (cause) => new EpicRunLockError("inspect", cause),
      }),
    acquire: (input) =>
      Effect.tryPromise({
        try: async () => {
          const file = await lockPath(input.workspaceRoot, input.epicId);
          let supervisor: ReturnType<typeof startSupervisor> | undefined;
          try {
            await addExclude(input.workspaceRoot, NodePath.dirname(file));
            supervisor = input.pid === undefined ? startSupervisor() : undefined;
            const pid = input.pid ?? supervisor!.pid;
            const owner: EpicRunLockOwner = {
              owner: input.owner,
              host: NodeOS.hostname(),
              bootId: await bootId(),
              pid,
              pgid: input.pgid ?? (supervisor === undefined ? await processGroup() : pid),
              startTicks: await startTicks(pid),
              runDir: input.runDir,
              startedAt: new Date().toISOString(),
              heartbeatAt: now(),
            };
            return await withGuard(file, async () => {
              for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                  await NodeFSP.writeFile(file, `${JSON.stringify(owner)}\n`, {
                    flag:
                      NodeFS.constants.O_CREAT |
                      NodeFS.constants.O_EXCL |
                      NodeFS.constants.O_WRONLY,
                  });
                  let timer: NodeJS.Timeout | undefined;
                  const lease = makeLease(
                    file,
                    owner,
                    now,
                    () => timer && clearInterval(timer),
                    supervisor?.stop ?? (async () => {}),
                    options?.beforeHeartbeatCommit,
                  );
                  timer = setInterval(() => {
                    Effect.runPromise(lease.heartbeat).catch(() => undefined);
                  }, heartbeatMilliseconds);
                  timer.unref();
                  return lease;
                } catch (cause) {
                  const error = cause as NodeJS.ErrnoException;
                  if (error.code !== "EEXIST") throw cause;
                  if (attempt === 0 && (await isStale(file, now()))) {
                    await NodeFSP.unlink(file).catch(() => undefined);
                    continue;
                  }
                  throw new EpicRunLockHeldError(file, await readHolder(file));
                }
              }
              throw new EpicRunLockHeldError(file, await readHolder(file));
            });
          } catch (cause) {
            await supervisor?.stop();
            throw cause;
          }
        },
        catch: (cause) =>
          cause instanceof EpicRunLockHeldError ? cause : new EpicRunLockError("acquire", cause),
      }),
  });
};

export const layer = makeLayer();
