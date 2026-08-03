import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  BeadsChildCounts,
  BeadsEpicSummary,
  BeadsIssueSummary,
  BeadsStatusInput,
  BeadsStatusResult,
  BeadsUnavailableReason,
} from "@t3tools/contracts";

import { ProcessRunner, type ProcessRunError } from "../processRunner.ts";

const BEADS_DIRECTORY_NAME = ".beads";
const BEADS_METADATA_FILE_NAME = "metadata.json";
const BEADS_LAST_TOUCHED_FILE_NAME = "last-touched";
const BEADS_INTERACTIONS_FILE_NAME = "interactions.jsonl";

/**
 * The `.beads` files a mutation writes, as far as we can watch for one. No
 * single file covers every command: `bd create` and `bd update` write
 * `last-touched`, `bd close` writes only `interactions.jsonl`, and `bd reopen`
 * writes neither (that gap is what the poll backstop is for).
 *
 * Safe to watch because the reads this service issues — `bd list` and
 * `bd ready` — write neither file, so a refresh cannot retrigger itself.
 * `bd show` would (it rewrites `last-touched`), which is why it is never used.
 */
const BEADS_CHANGE_SIGNAL_FILE_NAMES: ReadonlyArray<string> = [
  BEADS_LAST_TOUCHED_FILE_NAME,
  BEADS_INTERACTIONS_FILE_NAME,
];

/** Coalesces the burst of watch events a single `bd` write produces. */
export const BEADS_WATCH_DEBOUNCE = Duration.millis(300);
/**
 * Backstop cadence, run alongside the watcher rather than only when `fs.watch`
 * is unavailable (network mounts, watcher exhaustion). It is the only thing
 * that catches a mutation bd signals through no file at all.
 */
export const BEADS_POLL_INTERVAL = Duration.seconds(45);

/**
 * `fs.watch` reports a path that may be a basename, a path relative to the
 * watched directory, or an absolute path, depending on the platform.
 */
export function makeChangeSignalPredicate(
  path: Path.Path,
  beadsDirectory: string,
): (eventPath: string) => boolean {
  const resolvedSignalPaths = new Set(
    BEADS_CHANGE_SIGNAL_FILE_NAMES.map((name) => path.resolve(path.join(beadsDirectory, name))),
  );
  return (eventPath) =>
    BEADS_CHANGE_SIGNAL_FILE_NAMES.includes(eventPath) ||
    resolvedSignalPaths.has(path.resolve(beadsDirectory, eventPath));
}

const BD_COMMAND = "bd";
const BD_TIMEOUT = Duration.seconds(20);
const BD_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const BD_RETRY_ATTEMPTS = 3;
const BD_RETRY_BASE_DELAY = Duration.millis(200);
const BD_FAILURE_DETAIL_MAX_LENGTH = 256;
/** bd's own default when an issue carries no usable priority. */
const DEFAULT_ISSUE_PRIORITY = 2;

export interface ParsedBeadsIssue {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly issueType: string;
  readonly priority: number;
  readonly assignee: string | null;
  readonly parent: string | null;
  readonly blockedBy: ReadonlyArray<string>;
}

interface BdFailure {
  readonly reason: Exclude<BeadsUnavailableReason, "no-beads">;
  readonly detail: string;
  readonly transient: boolean;
}

/**
 * Embedded-dolt lock contention and process timeouts are worth retrying; a
 * genuine bd error (bad flag, corrupt DB) is not.
 */
const BD_TRANSIENT_FAILURE_PATTERNS = [
  /database (?:is|table is) locked/i,
  /resource temporarily unavailable/i,
  /(?:could not|failed to|unable to) (?:acquire|obtain|get) .{0,40}lock/i,
  /lock(?:ed| file| conflict)/i,
  /another (?:process|instance)/i,
  /timed? ?out/i,
] as const;

const BD_MISSING_COMMAND_PATTERNS = [
  /command not found/i,
  /not recognized as an internal or external command/i,
  /no such file or directory/i,
] as const;

export function isTransientBdFailureDetail(detail: string): boolean {
  return BD_TRANSIENT_FAILURE_PATTERNS.some((pattern) => pattern.test(detail));
}

function looksLikeMissingBdCommand(detail: string): boolean {
  return BD_MISSING_COMMAND_PATTERNS.some((pattern) => pattern.test(detail));
}

function boundedDetail(detail: string): string {
  const collapsed = detail.trim().replace(/\s+/g, " ");
  return collapsed.slice(0, BD_FAILURE_DETAIL_MAX_LENGTH);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readDependencyIds(value: unknown, dependencyType: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const ids: Array<string> = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record["type"] !== dependencyType) continue;
    const dependsOnId = readString(record["depends_on_id"]);
    if (dependsOnId !== null && !ids.includes(dependsOnId)) {
      ids.push(dependsOnId);
    }
  }
  return ids;
}

/**
 * Parses `bd list --json` output. Returns `null` when the payload is not a JSON
 * array (bd printed a diagnostic, or the CLI changed shape); individual entries
 * that carry no id are dropped rather than failing the whole snapshot.
 */
export function parseBeadsIssues(stdout: string): ReadonlyArray<ParsedBeadsIssue> | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(decoded)) return null;

  const issues: Array<ParsedBeadsIssue> = [];
  for (const entry of decoded) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = readString(record["id"]);
    if (id === null) continue;

    const priority = record["priority"];
    const parentDependencies = readDependencyIds(record["dependencies"], "parent-child");

    issues.push({
      id,
      title: typeof record["title"] === "string" ? record["title"] : "",
      status: readString(record["status"]) ?? "unknown",
      issueType: readString(record["issue_type"]) ?? "task",
      priority:
        typeof priority === "number" && Number.isInteger(priority) && priority >= 0
          ? priority
          : DEFAULT_ISSUE_PRIORITY,
      assignee: readString(record["assignee"]),
      parent: readString(record["parent"]) ?? parentDependencies[0] ?? null,
      blockedBy: readDependencyIds(record["dependencies"], "blocks"),
    });
  }
  return issues;
}

/** Reads the id `bd` recorded for its most recent write, when one exists. */
export function parseLastTouchedId(contents: string): string | null {
  return readString(contents.split("\n")[0] ?? "");
}

function summarizeEpicChildren(
  epicId: string,
  issues: ReadonlyArray<BeadsIssueSummary>,
): BeadsChildCounts {
  const byStatus: Record<string, number> = {};
  let total = 0;
  let ready = 0;
  for (const issue of issues) {
    if (issue.parent !== epicId) continue;
    total += 1;
    if (issue.isReady) ready += 1;
    byStatus[issue.status] = (byStatus[issue.status] ?? 0) + 1;
  }
  return { total, ready, byStatus };
}

export function summarizeBeadsStatus(input: {
  readonly workspaceRoot: string;
  readonly issues: ReadonlyArray<ParsedBeadsIssue>;
  readonly readyIds: ReadonlyArray<string>;
  readonly lastTouchedId: string | null;
  readonly fetchedAt: DateTime.Utc;
}): BeadsStatusResult {
  const readyIds = new Set(input.readyIds);
  const issues: ReadonlyArray<BeadsIssueSummary> = input.issues.map((issue) => ({
    ...issue,
    isReady: readyIds.has(issue.id),
  }));
  const epics: ReadonlyArray<BeadsEpicSummary> = issues
    .filter((issue) => issue.issueType === "epic")
    .map((epic) => ({
      id: epic.id,
      title: epic.title,
      status: epic.status,
      childCounts: summarizeEpicChildren(epic.id, issues),
    }));

  return {
    _tag: "available",
    workspaceRoot: input.workspaceRoot,
    epics,
    issues,
    readyCount: readyIds.size,
    lastTouchedId: input.lastTouchedId,
    fetchedAt: input.fetchedAt,
  };
}

function unavailable(
  workspaceRoot: string,
  reason: BeadsUnavailableReason,
  detail: string | null,
  fetchedAt: DateTime.Utc,
): BeadsStatusResult {
  return { _tag: "unavailable", workspaceRoot, reason, detail, fetchedAt };
}

/**
 * `fetchedAt` is deliberately excluded: a poll that observes unchanged beads
 * state must not wake every subscriber.
 */
function fingerprintStatus(status: BeadsStatusResult): string {
  return status._tag === "available"
    ? JSON.stringify([
        status._tag,
        status.workspaceRoot,
        status.lastTouchedId,
        status.readyCount,
        status.epics,
        status.issues,
      ])
    : JSON.stringify([status._tag, status.workspaceRoot, status.reason, status.detail]);
}

function bdFailureFromProcessError(error: ProcessRunError): BdFailure {
  switch (error._tag) {
    case "ProcessSpawnError":
      return {
        reason: "bd-not-found",
        detail: `The '${BD_COMMAND}' CLI could not be started from PATH.`,
        transient: false,
      };
    case "ProcessTimeoutError":
      return {
        reason: "bd-failed",
        detail: `The '${BD_COMMAND}' CLI timed out after ${error.timeoutMs}ms.`,
        transient: true,
      };
    default:
      return {
        reason: "bd-failed",
        detail: boundedDetail(error.message),
        transient: false,
      };
  }
}

interface StreamStatusOptions {
  readonly pollInterval?: Duration.Duration;
}

export class BeadsStatusBroadcaster extends Context.Service<
  BeadsStatusBroadcaster,
  {
    readonly getStatus: (input: BeadsStatusInput) => Effect.Effect<BeadsStatusResult>;
    readonly refreshStatus: (workspaceRoot: string) => Effect.Effect<BeadsStatusResult>;
    readonly streamStatus: (
      input: BeadsStatusInput,
      options?: StreamStatusOptions,
    ) => Stream.Stream<BeadsStatusResult>;
  }
>()("t3/beads/BeadsStatusBroadcaster") {}

interface BeadsStatusChange {
  readonly workspaceRoot: string;
  readonly status: BeadsStatusResult;
}

interface CachedBeadsStatus {
  readonly fingerprint: string;
  readonly value: BeadsStatusResult;
}

interface ActiveWatcher {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly subscriberCount: number;
}

const normalizeWorkspaceRoot = (workspaceRoot: string) =>
  Effect.service(FileSystem.FileSystem).pipe(
    Effect.flatMap((fs) => fs.realPath(workspaceRoot)),
    Effect.orElseSucceed(() => workspaceRoot),
  );

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner;
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<BeadsStatusChange>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const cacheRef = yield* Ref.make(new Map<string, CachedBeadsStatus>());
  const watchersRef = yield* SynchronizedRef.make(new Map<string, ActiveWatcher>());

  const withFileSystem = Effect.provideService(FileSystem.FileSystem, fs);

  const runBdOnce = (workspaceRoot: string, args: ReadonlyArray<string>) =>
    processRunner
      .run({
        command: BD_COMMAND,
        args,
        cwd: workspaceRoot,
        timeout: BD_TIMEOUT,
        maxOutputBytes: BD_MAX_OUTPUT_BYTES,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError(bdFailureFromProcessError),
        Effect.flatMap((output) => {
          if (output.timedOut) {
            return Effect.fail<BdFailure>({
              reason: "bd-failed",
              detail: `The '${BD_COMMAND}' CLI timed out.`,
              transient: true,
            });
          }
          if (output.code === 0) {
            return Effect.succeed(output.stdout);
          }
          const detail = boundedDetail(output.stderr.length > 0 ? output.stderr : output.stdout);
          return Effect.fail<BdFailure>({
            reason:
              output.code === 127 || looksLikeMissingBdCommand(detail)
                ? "bd-not-found"
                : "bd-failed",
            detail:
              detail.length > 0 ? detail : `The '${BD_COMMAND}' CLI exited with ${output.code}.`,
            transient: isTransientBdFailureDetail(detail),
          });
        }),
      );

  const runBd = (workspaceRoot: string, args: ReadonlyArray<string>) =>
    runBdOnce(workspaceRoot, args).pipe(
      Effect.retry({
        while: (failure: BdFailure) => failure.transient,
        times: BD_RETRY_ATTEMPTS,
        schedule: Schedule.exponential(BD_RETRY_BASE_DELAY),
      }),
    );

  const readLastTouchedId = (beadsDirectory: string) =>
    fs.readFileString(path.join(beadsDirectory, BEADS_LAST_TOUCHED_FILE_NAME)).pipe(
      Effect.map(parseLastTouchedId),
      Effect.orElseSucceed(() => null),
    );

  const loadStatus = Effect.fn("BeadsStatusBroadcaster.loadStatus")(function* (
    workspaceRoot: string,
  ) {
    const fetchedAt = yield* DateTime.now;
    const beadsDirectory = path.join(workspaceRoot, BEADS_DIRECTORY_NAME);
    const participates = yield* fs
      .exists(path.join(beadsDirectory, BEADS_METADATA_FILE_NAME))
      .pipe(Effect.orElseSucceed(() => false));
    if (!participates) {
      return unavailable(workspaceRoot, "no-beads", null, fetchedAt);
    }

    // Sequential on purpose: the embedded-dolt backend serializes on a DB lock,
    // so concurrent `bd` invocations only manufacture contention to retry past.
    // `bd show` is never used here — unlike `list`/`ready` it rewrites
    // .beads/last-touched, which is the very file the watcher reacts to.
    const reads = yield* runBd(workspaceRoot, ["list", "--json", "--status=all"]).pipe(
      Effect.flatMap((listStdout) =>
        runBd(workspaceRoot, ["ready", "--json"]).pipe(
          Effect.map((readyStdout) => ({ listStdout, readyStdout })),
        ),
      ),
      Effect.exit,
    );
    if (Exit.isFailure(reads)) {
      const failure = reads.cause.reasons.find(Cause.isFailReason)?.error;
      if (failure === undefined) {
        return yield* Effect.failCause(reads.cause as Cause.Cause<never>);
      }
      return unavailable(workspaceRoot, failure.reason, failure.detail, fetchedAt);
    }

    const issues = parseBeadsIssues(reads.value.listStdout);
    const readyIssues = parseBeadsIssues(reads.value.readyStdout);
    if (issues === null || readyIssues === null) {
      return unavailable(
        workspaceRoot,
        "bd-failed",
        `The '${BD_COMMAND}' CLI returned output that is not a JSON issue array.`,
        fetchedAt,
      );
    }

    return summarizeBeadsStatus({
      workspaceRoot,
      issues,
      readyIds: readyIssues.map((issue) => issue.id),
      lastTouchedId: yield* readLastTouchedId(beadsDirectory),
      fetchedAt,
    });
  });

  const cacheStatus = Effect.fn("BeadsStatusBroadcaster.cacheStatus")(function* (
    workspaceRoot: string,
    status: BeadsStatusResult,
    options?: { readonly publish?: boolean },
  ) {
    const next = {
      fingerprint: fingerprintStatus(status),
      value: status,
    } satisfies CachedBeadsStatus;
    const changed = yield* Ref.modify(cacheRef, (cache) => {
      const previous = cache.get(workspaceRoot);
      const nextCache = new Map(cache);
      nextCache.set(workspaceRoot, next);
      return [previous?.fingerprint !== next.fingerprint, nextCache] as const;
    });

    if (options?.publish && changed) {
      yield* PubSub.publish(changesPubSub, { workspaceRoot, status });
    }

    return status;
  });

  const refreshStatusCore = Effect.fn("BeadsStatusBroadcaster.refreshStatusCore")(function* (
    workspaceRoot: string,
  ) {
    const status = yield* loadStatus(workspaceRoot);
    return yield* cacheStatus(workspaceRoot, status, { publish: true });
  });

  const getOrLoadStatus = Effect.fn("BeadsStatusBroadcaster.getOrLoadStatus")(function* (
    workspaceRoot: string,
  ) {
    const cached = yield* Ref.get(cacheRef).pipe(
      Effect.map((cache) => cache.get(workspaceRoot) ?? null),
    );
    if (cached) {
      return cached.value;
    }
    const status = yield* loadStatus(workspaceRoot);
    return yield* cacheStatus(workspaceRoot, status);
  });

  const getStatus: BeadsStatusBroadcaster["Service"]["getStatus"] = Effect.fn(
    "BeadsStatusBroadcaster.getStatus",
  )(function* (input) {
    const workspaceRoot = yield* withFileSystem(normalizeWorkspaceRoot(input.workspaceRoot));
    return yield* getOrLoadStatus(workspaceRoot);
  });

  const refreshStatus: BeadsStatusBroadcaster["Service"]["refreshStatus"] = Effect.fn(
    "BeadsStatusBroadcaster.refreshStatus",
  )(function* (rawWorkspaceRoot) {
    const workspaceRoot = yield* withFileSystem(normalizeWorkspaceRoot(rawWorkspaceRoot));
    return yield* refreshStatusCore(workspaceRoot);
  });

  const makeWatchLoop = (workspaceRoot: string, pollInterval: Duration.Duration) =>
    Effect.gen(function* () {
      const beadsDirectory = path.join(workspaceRoot, BEADS_DIRECTORY_NAME);
      const isChangeSignal = makeChangeSignalPredicate(path, beadsDirectory);
      const refreshSafely = refreshStatusCore(workspaceRoot).pipe(
        Effect.ignoreCause({ log: true }),
        Effect.asVoid,
      );
      // A real periodic backstop, not a failure fallback. bd writes no signal
      // file at all for some mutations (`bd reopen` touches neither), so a
      // healthy watcher is not enough to keep a snapshot honest. Publishing is
      // fingerprint-gated, so an unchanged snapshot still wakes nobody — the
      // cost of an idle poll is the bd subprocess pair, not client churn.
      const pollLoop = refreshSafely.pipe(
        Effect.delay(pollInterval),
        Effect.forever,
        Effect.asVoid,
      );

      // Refresh once on attach. Nothing watches a workspace while it has no
      // subscribers, so the cache a re-subscriber is served can be arbitrarily
      // stale — bd may have been driven from a terminal the whole time. This
      // also closes the gap between the initial load and the watch starting.
      // Publishing is fingerprint-gated, so an unchanged snapshot wakes nobody.
      yield* refreshSafely;

      // Watch the directory rather than the files: the signal files may not
      // exist until bd's first write, and watching a missing path fails.
      const changes = fs.watch(beadsDirectory).pipe(
        Stream.filter((event) => isChangeSignal(event.path)),
        Stream.debounce(BEADS_WATCH_DEBOUNCE),
      );

      const watchLoop = Stream.runForEach(changes, () => refreshSafely).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => {
            const interruptionReasons = cause.reasons.filter(Cause.isInterruptReason);
            if (interruptionReasons.length > 0) {
              return Effect.failCause(Cause.fromReasons<never>(interruptionReasons));
            }
            return Effect.logWarning("Beads watch unavailable, leaning on the poll backstop", {
              workspaceRootLength: workspaceRoot.length,
              pollIntervalMs: Duration.toMillis(pollInterval),
            }).pipe(Effect.andThen(Effect.never));
          },
          // The watch stream should never end on its own; the poll carries on.
          onSuccess: () => Effect.never,
        }),
      );

      return yield* Effect.all([pollLoop, watchLoop], {
        concurrency: "unbounded",
        discard: true,
      });
    });

  const retainWatcher = Effect.fn("BeadsStatusBroadcaster.retainWatcher")(function* (
    workspaceRoot: string,
    pollInterval: Duration.Duration,
  ) {
    yield* SynchronizedRef.modifyEffect(watchersRef, (watchers) => {
      const existing = watchers.get(workspaceRoot);
      if (existing) {
        const nextWatchers = new Map(watchers);
        nextWatchers.set(workspaceRoot, {
          ...existing,
          subscriberCount: existing.subscriberCount + 1,
        });
        return Effect.succeed([undefined, nextWatchers] as const);
      }

      return makeWatchLoop(workspaceRoot, pollInterval).pipe(
        Effect.forkIn(broadcasterScope),
        Effect.map((fiber) => {
          const nextWatchers = new Map(watchers);
          nextWatchers.set(workspaceRoot, { fiber, subscriberCount: 1 });
          return [undefined, nextWatchers] as const;
        }),
      );
    });
  });

  const releaseWatcher = Effect.fn("BeadsStatusBroadcaster.releaseWatcher")(function* (
    workspaceRoot: string,
  ) {
    const watcherToInterrupt = yield* SynchronizedRef.modify(watchersRef, (watchers) => {
      const existing = watchers.get(workspaceRoot);
      if (!existing) {
        return [null, watchers] as const;
      }

      if (existing.subscriberCount > 1) {
        const nextWatchers = new Map(watchers);
        nextWatchers.set(workspaceRoot, {
          ...existing,
          subscriberCount: existing.subscriberCount - 1,
        });
        return [null, nextWatchers] as const;
      }

      const nextWatchers = new Map(watchers);
      nextWatchers.delete(workspaceRoot);
      return [existing.fiber, nextWatchers] as const;
    });

    if (watcherToInterrupt) {
      yield* Fiber.interrupt(watcherToInterrupt).pipe(Effect.ignore);
    }
  });

  const streamStatus: BeadsStatusBroadcaster["Service"]["streamStatus"] = (input, options) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const workspaceRoot = yield* withFileSystem(normalizeWorkspaceRoot(input.workspaceRoot));
        // Subscribe before the initial load so a refresh racing the load is
        // delivered twice rather than dropped.
        const subscription = yield* PubSub.subscribe(changesPubSub);
        const initial = yield* getOrLoadStatus(workspaceRoot);
        yield* retainWatcher(workspaceRoot, options?.pollInterval ?? BEADS_POLL_INTERVAL);

        const release = releaseWatcher(workspaceRoot).pipe(Effect.ignore, Effect.asVoid);

        return Stream.concat(
          Stream.make(initial),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.workspaceRoot === workspaceRoot),
            Stream.map((change) => change.status),
          ),
        ).pipe(Stream.ensuring(release));
      }),
    );

  return BeadsStatusBroadcaster.of({
    getStatus,
    refreshStatus,
    streamStatus,
  });
});

export const layer = Layer.effect(BeadsStatusBroadcaster, make);
