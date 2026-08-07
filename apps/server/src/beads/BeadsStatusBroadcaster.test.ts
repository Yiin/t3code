// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { BeadsStatusResult } from "@t3tools/contracts";

import * as ProcessRunner from "@t3tools/epic-core/processRunner";
import * as BeadsStatusBroadcaster from "./BeadsStatusBroadcaster.ts";

const fixtureDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
/** Recorded from this repo's `.beads` (`bd list --json --status=all`). */
const bdListFixture = NodeFS.readFileSync(
  NodePath.join(fixtureDirectory, "testing", "bd-list.fixture.json"),
  "utf8",
);

const okOutput = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

/** A minimal `bd list --json` payload: one epic with one child. */
const oneEpicListOutput = (childStatus: string) =>
  JSON.stringify([
    { id: "epic-1", title: "Epic", status: "open", issue_type: "epic" },
    {
      id: "epic-1.1",
      title: "Child",
      status: childStatus,
      issue_type: "task",
      priority: 1,
      dependencies: [{ type: "parent-child", depends_on_id: "epic-1" }],
    },
  ]);

interface BdCallCounts {
  listCalls: number;
  readyCalls: number;
}

const makeRecordingProcessRunner =
  (counts: BdCallCounts): ProcessRunner.ProcessRunner["Service"]["run"] =>
  (input) =>
    Effect.sync(() => {
      if (input.args[0] === "ready") {
        counts.readyCalls += 1;
        return okOutput("[]");
      }
      counts.listCalls += 1;
      return okOutput(bdListFixture);
    });

const makeTestLayer = (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  BeadsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
  );

const prepareBeadsWorkspace = Effect.fn("test.prepareBeadsWorkspace")(function* (options?: {
  readonly withBeads?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-beads-status-" });
  if (options?.withBeads !== false) {
    const beadsDirectory = path.join(workspaceRoot, ".beads");
    yield* fs.makeDirectory(beadsDirectory, { recursive: true });
    yield* fs.writeFileString(path.join(beadsDirectory, "metadata.json"), '{"backend":"dolt"}');
    yield* fs.writeFileString(path.join(beadsDirectory, "last-touched"), "t3code-vst.15\n");
  }
  return yield* fs.realPath(workspaceRoot);
});

/** Waits for the watcher to drive `listCalls` to `expected`, or fails the test. */
const awaitListCalls = Effect.fn("test.awaitListCalls")(function* (
  counts: BdCallCounts,
  expected: number,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (counts.listCalls >= expected) return;
    yield* Effect.sleep(Duration.millis(25));
  }
  assert.fail(`bd list was called ${counts.listCalls} times, expected ${expected}`);
});

describe("parseBeadsIssues", () => {
  it("parses recorded bd list output including parents and blocking dependencies", () => {
    const issues = BeadsStatusBroadcaster.parseBeadsIssues(bdListFixture);
    assert.isNotNull(issues);
    assert.deepStrictEqual(issues.map((issue) => issue.id).sort(), [
      "t3code-vst",
      "t3code-vst.1",
      "t3code-vst.11",
      "t3code-vst.15",
      "t3code-vst.2",
    ]);

    const epic = issues.find((issue) => issue.id === "t3code-vst");
    assert.equal(epic?.issueType, "epic");
    assert.equal(epic?.parent, null);
    assert.deepStrictEqual(epic?.blockedBy, []);

    const blockedChild = issues.find((issue) => issue.id === "t3code-vst.11");
    assert.equal(blockedChild?.parent, "t3code-vst");
    assert.equal(blockedChild?.status, "open");
    assert.equal(blockedChild?.priority, 1);
    // parent-child rows must not leak into blockedBy.
    assert.deepStrictEqual(blockedChild?.blockedBy, ["t3code-vst.10", "t3code-vst.2"]);

    const claimedChild = issues.find((issue) => issue.id === "t3code-vst.15");
    assert.equal(claimedChild?.status, "in_progress");

    // Parsed as instants, so recency is comparable rather than string-compared.
    assert.equal(
      claimedChild?.createdAt === null ? null : DateTime.formatIso(claimedChild!.createdAt!),
      "2026-07-27T16:37:37.000Z",
    );
    assert.equal(
      claimedChild?.updatedAt === null ? null : DateTime.formatIso(claimedChild!.updatedAt!),
      "2026-07-27T18:23:49.000Z",
    );
  });

  it("maps missing, unparseable, and zero timestamps to null", () => {
    // bd writes created_at/updated_at as non-pointer Go time fields, so the case
    // to survive is the zero time, not absence — but neither may throw.
    const issues = BeadsStatusBroadcaster.parseBeadsIssues(
      JSON.stringify([
        { id: "absent" },
        { id: "zero", created_at: "0001-01-01T00:00:00Z", updated_at: "0001-01-01T00:00:00Z" },
        { id: "garbage", created_at: "not a date", updated_at: "" },
        { id: "wrong-type", created_at: 1754200000, updated_at: { at: "now" } },
        // Offset form, since the Z-suffixed second precision bd emits today is
        // incidental and must not be relied on.
        { id: "offset", created_at: "2026-08-03T09:23:04+03:00", updated_at: "2026-08-03T06:24Z" },
      ]),
    );
    assert.isNotNull(issues);

    const timestamps = issues.map((issue) => [
      issue.id,
      issue.createdAt === null ? null : DateTime.formatIso(issue.createdAt),
      issue.updatedAt === null ? null : DateTime.formatIso(issue.updatedAt),
    ]);
    assert.deepStrictEqual(timestamps, [
      ["absent", null, null],
      ["zero", null, null],
      ["garbage", null, null],
      ["wrong-type", null, null],
      ["offset", "2026-08-03T06:23:04.000Z", "2026-08-03T06:24:00.000Z"],
    ]);
  });

  it("drops unusable entries and falls back for missing fields", () => {
    const issues = BeadsStatusBroadcaster.parseBeadsIssues(
      JSON.stringify([
        { title: "no id" },
        null,
        "not an object",
        { id: "   " },
        { id: "only-id" },
        { id: "odd-priority", priority: "high", status: 7, issue_type: 3 },
      ]),
    );

    assert.deepStrictEqual(issues, [
      {
        id: "only-id",
        title: "",
        status: "unknown",
        issueType: "task",
        priority: 2,
        assignee: null,
        parent: null,
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      },
      {
        id: "odd-priority",
        title: "",
        status: "unknown",
        issueType: "task",
        priority: 2,
        assignee: null,
        parent: null,
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      },
    ]);
  });

  it("returns null when bd did not print a JSON array", () => {
    assert.isNull(BeadsStatusBroadcaster.parseBeadsIssues("Error: no beads database found"));
    assert.isNull(BeadsStatusBroadcaster.parseBeadsIssues('{"issues":[]}'));
  });
});

describe("summarizeBeadsStatus", () => {
  /** Summarizes a `bd list --json` payload through the real parser. */
  const summarizeEntries = (entries: ReadonlyArray<Record<string, unknown>>) => {
    const issues = BeadsStatusBroadcaster.parseBeadsIssues(JSON.stringify(entries));
    assert.isNotNull(issues);
    const status = BeadsStatusBroadcaster.summarizeBeadsStatus({
      workspaceRoot: "/repo",
      issues,
      readyIds: [],
      lastTouchedId: null,
      fetchedAt: DateTime.makeUnsafe("2026-08-03T12:00:00Z"),
    });
    assert.equal(status._tag, "available");
    if (status._tag !== "available") throw new Error("unreachable");
    return status;
  };

  const child = (id: string, parent: string, updatedAt: string, status = "open") => ({
    id,
    parent,
    status,
    issue_type: "task",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: updatedAt,
  });

  it("counts epic children by status and marks ready issues", () => {
    const issues = BeadsStatusBroadcaster.parseBeadsIssues(bdListFixture);
    assert.isNotNull(issues);

    const status = BeadsStatusBroadcaster.summarizeBeadsStatus({
      workspaceRoot: "/repo",
      issues,
      readyIds: ["t3code-vst.15"],
      lastTouchedId: "t3code-vst.15",
      fetchedAt: DateTime.makeUnsafe("2026-07-27T18:00:00Z"),
    });

    assert.equal(status._tag, "available");
    if (status._tag !== "available") return;
    assert.equal(status.readyCount, 1);
    assert.equal(status.lastTouchedId, "t3code-vst.15");
    assert.deepStrictEqual(
      status.epics.map((epic) => epic.id),
      ["t3code-vst"],
    );
    assert.deepStrictEqual(status.epics[0]?.childCounts, {
      total: 4,
      ready: 1,
      byStatus: { open: 1, in_progress: 1, closed: 2 },
    });
    assert.isTrue(status.issues.find((issue) => issue.id === "t3code-vst.15")?.isReady);
    assert.isFalse(status.issues.find((issue) => issue.id === "t3code-vst.11")?.isReady);

    // Timestamps reach the wire as ISO strings.
    assert.equal(
      status.issues.find((issue) => issue.id === "t3code-vst.15")?.updatedAt,
      "2026-07-27T18:23:49.000Z",
    );
    assert.equal(status.epics[0]?.createdAt, "2026-07-27T16:22:52.000Z");
    assert.equal(status.epics[0]?.updatedAt, "2026-07-27T18:16:21.000Z");
    // The epic issue itself last moved at 18:16:21, but child .15 moved at
    // 18:23:49 — recency has to follow the child.
    assert.equal(status.epics[0]?.lastActivityAt, "2026-07-27T18:23:49.000Z");
  });

  it("drops closed blockers from blockedBy and keeps the ones still open", () => {
    const dependsOn = (...ids: ReadonlyArray<string>) =>
      ids.map((id) => ({ type: "blocks", depends_on_id: id }));
    const status = summarizeEntries([
      { id: "epic-1", issue_type: "epic", status: "open" },
      // Every blocker landed, so this issue is ready however bd still records
      // the edges.
      { ...child("epic-1.1", "epic-1", "2026-08-03T11:00:00Z"), dependencies: dependsOn("done-1") },
      {
        ...child("epic-1.2", "epic-1", "2026-08-03T11:00:00Z"),
        dependencies: dependsOn("done-1", "epic-1.1", "elsewhere"),
      },
      { id: "done-1", parent: "epic-1", status: "closed" },
    ]);

    const blockedBy = (id: string) =>
      status.issues.find((issue) => issue.id === id)?.blockedBy ?? null;
    assert.deepStrictEqual(blockedBy("epic-1.1"), []);
    // An id the snapshot cannot resolve stays: unknown is not the same as done.
    assert.deepStrictEqual(blockedBy("epic-1.2"), ["epic-1.1", "elsewhere"]);
  });

  it("rolls direct children up into lastActivityAt, closed ones included", () => {
    const status = summarizeEntries([
      { id: "epic-1", issue_type: "epic", status: "open", updated_at: "2026-08-03T10:00:00Z" },
      child("epic-1.1", "epic-1", "2026-08-03T11:00:00Z"),
      // Closing a child is the event that matters most and it only moves the
      // CHILD's updated_at, so a closed child must still count.
      child("epic-1.2", "epic-1", "2026-08-03T12:00:00Z", "closed"),
      // A sibling epic's child must not leak across.
      { id: "epic-2", issue_type: "epic", status: "open", updated_at: "2026-08-03T09:00:00Z" },
      child("epic-2.1", "epic-2", "2026-08-03T23:00:00Z"),
      // Direct children only, matching childCounts: a subtask of a child does not
      // count as epic activity.
      child("epic-1.1.1", "epic-1.1", "2026-08-03T23:30:00Z"),
    ]);

    assert.deepStrictEqual(
      status.epics.map((epic) => [epic.id, epic.lastActivityAt]),
      [
        ["epic-1", "2026-08-03T12:00:00.000Z"],
        ["epic-2", "2026-08-03T23:00:00.000Z"],
      ],
    );
  });

  it("keeps the epic's own updatedAt when no child is newer", () => {
    const status = summarizeEntries([
      { id: "epic-1", issue_type: "epic", status: "open", updated_at: "2026-08-03T14:00:00Z" },
      child("epic-1.1", "epic-1", "2026-08-03T11:00:00Z"),
    ]);

    assert.equal(status.epics[0]?.lastActivityAt, "2026-08-03T14:00:00.000Z");
  });

  it("reports null recency instead of throwing when bd gave no usable timestamps", () => {
    const status = summarizeEntries([
      { id: "epic-1", issue_type: "epic", status: "open" },
      { id: "epic-1.1", parent: "epic-1", status: "open", updated_at: "0001-01-01T00:00:00Z" },
    ]);

    assert.deepStrictEqual(
      status.epics.map((epic) => [epic.createdAt, epic.updatedAt, epic.lastActivityAt]),
      [[null, null, null]],
    );
  });

  it("falls back to a child's timestamp when the epic itself has none", () => {
    const status = summarizeEntries([
      { id: "epic-1", issue_type: "epic", status: "open" },
      child("epic-1.1", "epic-1", "2026-08-03T11:00:00Z"),
    ]);

    assert.equal(status.epics[0]?.updatedAt, null);
    assert.equal(status.epics[0]?.lastActivityAt, "2026-08-03T11:00:00.000Z");
  });
});

describe("isTransientBdFailureDetail", () => {
  it("treats dolt lock contention and timeouts as retryable", () => {
    assert.isTrue(BeadsStatusBroadcaster.isTransientBdFailureDetail("database is locked"));
    assert.isTrue(
      BeadsStatusBroadcaster.isTransientBdFailureDetail("failed to acquire the dolt write lock"),
    );
    assert.isTrue(
      BeadsStatusBroadcaster.isTransientBdFailureDetail("another process is using the database"),
    );
    assert.isTrue(BeadsStatusBroadcaster.isTransientBdFailureDetail("operation timed out"));
  });

  it("does not retry ordinary bd errors", () => {
    assert.isFalse(BeadsStatusBroadcaster.isTransientBdFailureDetail("unknown flag: --nope"));
    assert.isFalse(BeadsStatusBroadcaster.isTransientBdFailureDetail("issue not found"));
  });
});

describe("makeChangeSignalPredicate", () => {
  it.effect("accepts both bd signal files in every shape fs.watch reports", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const beadsDirectory = path.join("/repo", ".beads");
      const isChangeSignal = BeadsStatusBroadcaster.makeChangeSignalPredicate(path, beadsDirectory);

      // `bd create`/`bd update` write last-touched; `bd close` writes only
      // interactions.jsonl.
      assert.isTrue(isChangeSignal("last-touched"));
      assert.isTrue(isChangeSignal("interactions.jsonl"));
      assert.isTrue(isChangeSignal(path.join(beadsDirectory, "interactions.jsonl")));
      assert.isTrue(isChangeSignal(path.join(beadsDirectory, "..", ".beads", "last-touched")));

      assert.isFalse(isChangeSignal("issues.jsonl"));
      assert.isFalse(isChangeSignal("metadata.json"));
      assert.isFalse(isChangeSignal(path.join(beadsDirectory, "embeddeddolt", "last-touched")));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("BeadsStatusBroadcaster", () => {
  it.effect("reports repos without .beads as unavailable", () => {
    const run: ProcessRunner.ProcessRunner["Service"]["run"] = () =>
      Effect.die(new Error("bd must not run for a repo without .beads"));

    return Effect.gen(function* () {
      const workspaceRoot = yield* prepareBeadsWorkspace({ withBeads: false });
      const broadcaster = yield* BeadsStatusBroadcaster.BeadsStatusBroadcaster;
      const status = yield* broadcaster.getStatus({ workspaceRoot });

      assert.equal(status._tag, "unavailable");
      if (status._tag !== "unavailable") return;
      assert.equal(status.reason, "no-beads");
      assert.equal(status.workspaceRoot, workspaceRoot);
    }).pipe(Effect.provide(makeTestLayer(run)));
  });

  it.effect("emits an unavailable snapshot instead of failing when bd is missing", () => {
    const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
      Effect.fail(
        new ProcessRunner.ProcessSpawnError({
          command: input.command,
          argumentCount: input.args.length,
          cwd: input.cwd,
          cause: PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "bd is not installed in the test environment",
          }),
        }),
      );

    return Effect.gen(function* () {
      const workspaceRoot = yield* prepareBeadsWorkspace();
      const broadcaster = yield* BeadsStatusBroadcaster.BeadsStatusBroadcaster;

      const first = yield* Stream.runHead(broadcaster.streamStatus({ workspaceRoot }));

      assert.isTrue(Option.isSome(first));
      const status = Option.getOrThrow(first);
      assert.equal(status._tag, "unavailable");
      if (status._tag !== "unavailable") return;
      assert.equal(status.reason, "bd-not-found");
    }).pipe(Effect.provide(makeTestLayer(run)));
  });

  // `it.live`, not `it.effect`: the watcher is driven by real `fs.watch` events
  // from the OS, which a virtual clock cannot be synchronized with — and
  // `Stream.debounce` reads that same clock.
  it.live("coalesces last-touched writes and stops watching once released", () => {
    const counts: BdCallCounts = { listCalls: 0, readyCalls: 0 };

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* prepareBeadsWorkspace();
      const beadsDirectory = path.join(workspaceRoot, ".beads");
      const lastTouchedPath = path.join(beadsDirectory, "last-touched");

      const broadcaster = yield* BeadsStatusBroadcaster.BeadsStatusBroadcaster;
      const scope = yield* Scope.make();
      const firstEvent = yield* Deferred.make<BeadsStatusResult>();
      yield* Stream.runForEach(broadcaster.streamStatus({ workspaceRoot }), (status) =>
        Deferred.succeed(firstEvent, status).pipe(Effect.ignore),
      ).pipe(Effect.forkIn(scope));

      const initial = yield* Deferred.await(firstEvent);
      assert.equal(initial._tag, "available");
      // One read for the initial snapshot, one for the watcher's attach refresh.
      yield* awaitListCalls(counts, 2);
      yield* Effect.sleep(Duration.millis(700));
      assert.equal(counts.listCalls, 2);

      // Three writes inside one debounce window must produce a single refresh.
      yield* fs.writeFileString(lastTouchedPath, "t3code-vst.1\n");
      yield* Effect.sleep(Duration.millis(30));
      yield* fs.writeFileString(lastTouchedPath, "t3code-vst.2\n");
      yield* Effect.sleep(Duration.millis(30));
      yield* fs.writeFileString(lastTouchedPath, "t3code-vst.11\n");

      yield* awaitListCalls(counts, 3);
      yield* Effect.sleep(Duration.millis(700));
      assert.equal(counts.listCalls, 3);

      // Unrelated files in .beads are not a change signal.
      yield* fs.writeFileString(path.join(beadsDirectory, "issues.jsonl"), "{}\n");
      yield* Effect.sleep(Duration.millis(700));
      assert.equal(counts.listCalls, 3);

      // Releasing the last subscriber must stop the watcher fiber.
      yield* Scope.close(scope, Exit.void);
      yield* fs.writeFileString(lastTouchedPath, "t3code-vst.4\n");
      yield* Effect.sleep(Duration.millis(700));
      assert.equal(counts.listCalls, 3);
    }).pipe(Effect.provide(makeTestLayer(makeRecordingProcessRunner(counts))));
  });

  // `bd close` bumps an issue's updated_at but writes only
  // `.beads/interactions.jsonl` — never `.beads/last-touched`. Closing a child
  // is the single most important epic-progress event, so it must not wait for
  // an unrelated bd write or a re-subscribe to reach the client.
  it.live("refreshes when a close writes only interactions.jsonl", () => {
    const state = { childStatus: "open" };
    const counts: BdCallCounts = { listCalls: 0, readyCalls: 0 };
    const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
      Effect.sync(() => {
        if (input.args[0] === "ready") {
          counts.readyCalls += 1;
          return okOutput("[]");
        }
        counts.listCalls += 1;
        return okOutput(oneEpicListOutput(state.childStatus));
      });

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* prepareBeadsWorkspace();
      const interactionsPath = path.join(workspaceRoot, ".beads", "interactions.jsonl");

      const broadcaster = yield* BeadsStatusBroadcaster.BeadsStatusBroadcaster;
      const scope = yield* Scope.make();
      const sawClose = yield* Deferred.make<void>();
      yield* Stream.runForEach(broadcaster.streamStatus({ workspaceRoot }), (status) =>
        status._tag === "available" && status.epics[0]?.childCounts.byStatus["closed"] === 1
          ? Deferred.succeed(sawClose, undefined).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(scope));

      yield* awaitListCalls(counts, 2);
      state.childStatus = "closed";
      yield* fs.writeFileString(interactionsPath, '{"kind":"field_change"}\n');

      // Times out rather than resolving if the watch filter ignores the file.
      const closed = yield* Deferred.await(sawClose).pipe(
        Effect.timeoutOption(Duration.seconds(5)),
      );
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(Option.isSome(closed));
    }).pipe(Effect.provide(makeTestLayer(run)));
  });

  // `bd reopen` writes neither signal file, so a healthy watcher is not enough.
  it.live("polls as a backstop while the watcher is healthy, without churn", () => {
    const counts: BdCallCounts = { listCalls: 0, readyCalls: 0 };

    return Effect.gen(function* () {
      const workspaceRoot = yield* prepareBeadsWorkspace();
      const broadcaster = yield* BeadsStatusBroadcaster.BeadsStatusBroadcaster;
      const scope = yield* Scope.make();
      const observed = yield* Ref.make(0);
      yield* Stream.runForEach(
        broadcaster.streamStatus({ workspaceRoot }, { pollInterval: Duration.millis(80) }),
        () => Ref.update(observed, (seen) => seen + 1),
      ).pipe(Effect.forkIn(scope));

      // Nothing writes to `.beads` here: only the poll can drive these reads.
      yield* awaitListCalls(counts, 5);
      yield* Scope.close(scope, Exit.void);

      // The fingerprint gate still holds — the snapshot never changed, so the
      // subscriber saw the initial event and nothing else.
      assert.equal(yield* Ref.get(observed), 1);
    }).pipe(Effect.provide(makeTestLayer(makeRecordingProcessRunner(counts))));
  });

  it.live("re-reads beads state for a subscriber that attaches after a gap", () => {
    // Nothing watches a workspace with no subscribers, so `bd` runs from a
    // terminal in that window leave the cache stale. Attaching must re-read.
    const state = { childStatus: "open" };
    const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
      Effect.sync(() =>
        okOutput(input.args[0] === "ready" ? "[]" : oneEpicListOutput(state.childStatus)),
      );

    const childStatusOf = (status: BeadsStatusResult) =>
      status._tag === "available"
        ? (status.issues.find((issue) => issue.id === "epic-1.1")?.status ?? null)
        : null;

    return Effect.gen(function* () {
      const workspaceRoot = yield* prepareBeadsWorkspace();
      const broadcaster = yield* BeadsStatusBroadcaster.BeadsStatusBroadcaster;

      const firstScope = yield* Scope.make();
      const firstEvent = yield* Deferred.make<BeadsStatusResult>();
      yield* Stream.runForEach(broadcaster.streamStatus({ workspaceRoot }), (status) =>
        Deferred.succeed(firstEvent, status).pipe(Effect.ignore),
      ).pipe(Effect.forkIn(firstScope));
      assert.equal(childStatusOf(yield* Deferred.await(firstEvent)), "open");

      // Detach every subscriber, then move beads state behind the watcher's back.
      yield* Scope.close(firstScope, Exit.void);
      yield* Effect.sleep(Duration.millis(100));
      state.childStatus = "in_progress";

      const secondScope = yield* Scope.make();
      const observed = yield* Ref.make<ReadonlyArray<string | null>>([]);
      const sawRefresh = yield* Deferred.make<void>();
      yield* Stream.runForEach(broadcaster.streamStatus({ workspaceRoot }), (status) =>
        Ref.update(observed, (seen) => [...seen, childStatusOf(status)]).pipe(
          Effect.andThen(
            childStatusOf(status) === "in_progress"
              ? Deferred.succeed(sawRefresh, undefined).pipe(Effect.ignore)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkIn(secondScope));

      // Without the attach refresh this never resolves: no `fs` event fires.
      yield* Deferred.await(sawRefresh).pipe(Effect.timeoutOption(Duration.seconds(5)));
      yield* Scope.close(secondScope, Exit.void);

      // Cached snapshot first for a fast first paint, then the fresh read.
      assert.deepStrictEqual(yield* Ref.get(observed), ["open", "in_progress"]);
    }).pipe(Effect.provide(makeTestLayer(run)));
  });
});
