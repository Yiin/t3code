import {
  DEFAULT_EPIC_RUN_CONFIG,
  DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
  ProviderInstanceId,
  type EpicRunConfig,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { runSequentialEpicLoop, type SequentialEpicLoopPorts } from "./SequentialEpicLoop.ts";
import { DispatchError, type IterationHandle } from "./ports/AgentDispatch.ts";
import { BacklogError, type BacklogIssue, type BacklogShape } from "./ports/Backlog.ts";
import type { RunEvent } from "./ports/RunEvents.ts";
import type { PersistedEpicRun, PersistedEpicRunIteration } from "./ports/RunJournal.ts";
import { VcsError } from "./ports/Vcs.ts";

type Attempt = {
  readonly infra?: boolean;
  readonly claim?: boolean;
  readonly commit?: boolean;
  readonly close?: boolean;
  readonly comment?: boolean;
  readonly dirty?: boolean;
  readonly blocked?: boolean;
};

const issue = (
  input: Partial<BacklogIssue> & Pick<BacklogIssue, "id" | "title">,
): BacklogIssue => ({
  id: input.id,
  title: input.title,
  status: input.status ?? "open",
  priority: input.priority ?? 1,
  issueType: input.issueType ?? "task",
  parentId: input.parentId ?? "epic",
  description: input.description ?? "",
  labels: input.labels ?? [],
  commentCount: input.commentCount ?? 0,
});

const config = (override: Partial<EpicRunConfig> = {}): EpicRunConfig => ({
  ...DEFAULT_EPIC_RUN_CONFIG,
  ...override,
  limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxIterations: 10, ...override.limits },
  gate: { ...DEFAULT_EPIC_RUN_CONFIG.gate, disabled: true, ...override.gate },
  vcs: { ...DEFAULT_EPIC_RUN_CONFIG.vcs, noPush: true, ...override.vcs },
  server: {
    ...DEFAULT_EPIC_RUN_CONFIG.server,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    ...override.server,
  },
});

const fixture = (input: {
  readonly attempts?: ReadonlyArray<Attempt>;
  readonly initialStatus?: string;
  readonly config?: EpicRunConfig;
  readonly gatePasses?: boolean;
  readonly pushFails?: boolean;
  readonly childTitle?: string;
  readonly stopChecks?: ReadonlyArray<boolean>;
  readonly releaseFailures?: number;
}) => {
  const epic = issue({
    id: "epic",
    title: "Epic",
    status: "open",
    parentId: null,
    description: "Goal",
  });
  let child = issue({
    id: "epic.1",
    title: input.childTitle ?? "Child",
    status: input.initialStatus ?? "open",
  });
  let head = 0;
  let fingerprint = "";
  let dispatches = 0;
  let released = false;
  let claims = 0;
  let releaseAttempts = 0;
  let stopReads = 0;
  let persistedRun: PersistedEpicRun | null = null;
  const iterations: PersistedEpicRunIteration[] = [];
  const statuses: string[] = [];
  const events: RunEvent[] = [];
  const ordering: string[] = [];
  const attempts = input.attempts ?? [];

  const backlog = {
    readyChildren: () => Effect.succeed(child.status === "open" ? [child] : []),
    showIssue: (id: string) => Effect.succeed(id === epic.id ? epic : child),
    listChildren: () => Effect.succeed([child]),
    claim: () =>
      Effect.sync(() => {
        claims += 1;
        child = { ...child, status: "in_progress" };
      }),
    releaseClaim: () => {
      releaseAttempts += 1;
      ordering.push("claim:release-attempt");
      if (releaseAttempts <= (input.releaseFailures ?? 0)) {
        return Effect.fail(
          new BacklogError({
            operation: "releaseClaim",
            issueId: child.id,
            detail: "offline",
          }),
        );
      }
      return Effect.sync(() => {
        if (child.status !== "in_progress") return false;
        child = { ...child, status: "open" };
        statuses.push("open");
        return true;
      });
    },
    setStatus: (_id: string, status: "open" | "in_progress" | "blocked" | "closed") =>
      Effect.sync(() => {
        child = { ...child, status };
        statuses.push(status);
      }),
  } as unknown as BacklogShape;

  const ports: SequentialEpicLoopPorts = {
    preflight: { check: () => Effect.succeed({ ok: true, blockers: [], warnings: [] }) },
    lock: {
      inspect: () => Effect.sync((): undefined => undefined),
      acquire: () =>
        Effect.succeed({
          path: "/lock",
          owner: {
            owner: "test",
            host: "host",
            pid: 1,
            pgid: 1,
            runDir: "/run",
            startedAt: "now",
            heartbeatAt: 1,
          },
          heartbeat: Effect.succeed(true),
          release: Effect.sync(() => {
            ordering.push("lease:released");
            released = true;
            return true;
          }),
        }),
    },
    backlog,
    journal: {
      createRun: (run) =>
        Effect.sync(() => {
          persistedRun = run;
        }),
      saveRun: (run) =>
        Effect.sync(() => {
          persistedRun = run;
        }),
      getRun: () =>
        Effect.succeed(persistedRun === null ? Option.none() : Option.some(persistedRun)),
      appendIteration: (iteration) =>
        Effect.sync(() => {
          iterations.push(iteration);
          ordering.push("journal:running");
        }),
      updateIteration: (update) =>
        Effect.sync(() => {
          const index = iterations.findIndex(
            (item) => item.iterationIndex === update.iterationIndex,
          );
          if (index >= 0) iterations[index] = { ...iterations[index]!, ...update };
          ordering.push(`journal:${update.turnStatus}`);
        }),
      listIterations: () => Effect.succeed(iterations),
      getLatestIteration: () => {
        const latest = iterations.at(-1);
        return Effect.succeed(latest === undefined ? Option.none() : Option.some(latest));
      },
    },
    events: {
      publish: (event) =>
        Effect.sync(() => {
          events.push(event);
          if (event.type === "iteration-state-changed") {
            ordering.push(`event:${event.iteration.turnStatus}`);
          } else if (event.type === "child-claim-released") {
            ordering.push("event:child-claim-released");
          }
        }),
    },
    dispatch: {
      startIteration: () => {
        const attempt = attempts[dispatches++] ?? {};
        if (attempt.infra)
          return Effect.fail(new DispatchError({ operation: "start", detail: "offline" }));
        const handle: IterationHandle = {
          ref: `attempt-${String(dispatches)}`,
          capabilities: {
            terminalSignal: "process-exit",
            continuation: "none",
            subagentLiveness: "unavailable",
            finalMessage: "result-field",
            cost: "none",
          },
          awaitSettled: Effect.sync(() => {
            if (attempt.claim) child = { ...child, status: "in_progress" };
            if (attempt.commit) head += 1;
            if (attempt.close) child = { ...child, status: "closed" };
            if (attempt.comment) child = { ...child, commentCount: child.commentCount + 1 };
            if (attempt.dirty) fingerprint = " M dirty";
            return { turnState: "completed" as const, timedOut: false, providerError: null };
          }),
          continueTurn: () => Effect.void,
          interrupt: Effect.void,
          release: Effect.void,
          runningSubagents: Effect.succeed({ mode: "unavailable", reason: "test" }),
          finalMessage: Effect.succeed({
            text: attempt.blocked ? "RALPH_BLOCKED" : 'RALPH_MSG: {"summary":"done","why":"test"}',
            streaming: false,
            waitExhausted: false,
          }),
        };
        return Effect.succeed(handle);
      },
      runAuxiliary: () => Effect.succeed({ output: "", succeeded: false }),
    },
    gate: {
      run: () =>
        Effect.succeed({
          passed: input.gatePasses ?? true,
          repositoryPaths: ["/repo"],
          output: "gate output",
        }),
    },
    vcs: {
      headCommit: () => Effect.succeed(`head-${String(head)}`),
      worktreeFingerprint: () => Effect.succeed(fingerprint),
      push: () =>
        input.pushFails
          ? Effect.fail(
              new VcsError({
                operation: "push",
                repositoryPath: "/repo",
                detail: "offline",
              }),
            )
          : Effect.void,
    } as unknown as SequentialEpicLoopPorts["vcs"],
  };

  const run = () =>
    runSequentialEpicLoop(
      {
        runId: "run",
        epicId: "epic",
        cwd: "/repo",
        runDirectory: "/run",
        repository: {
          repositoryPath: "/repo",
          baseBranch: "mine",
          worktreeRoot: "/worktrees",
          siblings: [],
        },
        selection: { instanceId: ProviderInstanceId.make("worker"), model: "test" },
        configSnapshot: {
          fileResult: { _tag: "absent" },
          config: input.config ?? config(),
          provenance: DEFAULT_EPIC_RUN_CONFIG_PROVENANCE,
          violations: [],
        },
        readOrientation: () => Effect.succeed("orientation"),
        shouldStop: () => Effect.succeed(input.stopChecks?.[stopReads++] ?? false),
        now: () => "2026-01-01T00:00:00Z",
      },
      ports,
    );

  return {
    run,
    child: () => child,
    dispatches: () => dispatches,
    statuses,
    iterations,
    released: () => released,
    claims: () => claims,
    releaseAttempts: () => releaseAttempts,
    events,
    ordering,
  };
};

it.live("keeps a closed child unchanged after a gate failure", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ claim: true, commit: true, close: true }],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 1, maxIterations: 2 },
        gate: { command: "gate", disabled: false },
      }),
      gatePasses: false,
    });
    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.equal(test.child().status, "closed");
    assert.deepEqual(test.statuses, []);
  }),
);

it.live("reopens a claimed child and emits recovery when its retry budget is exhausted", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ claim: true, blocked: true }],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 1 },
        server: { ...DEFAULT_EPIC_RUN_CONFIG.server, maxConsecutiveFailures: 1 },
      }),
    });

    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.equal(test.child().status, "open");
    assert.deepEqual(test.statuses, ["open"]);
    assert.deepEqual(
      test.events.filter((event) => event.type === "child-claim-released"),
      [
        {
          type: "child-claim-released",
          runId: "run",
          issueId: "epic.1",
          iterationIndex: 0,
          reason: "retry budget exhausted; child reopened",
        },
      ],
    );
    assert.isBelow(
      test.ordering.indexOf("event:failed"),
      test.ordering.indexOf("event:child-claim-released"),
    );
  }),
);

it.live("keeps an unclaimed child open without emitting recovery at exhaustion", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ blocked: true }],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 1 },
        server: { ...DEFAULT_EPIC_RUN_CONFIG.server, maxConsecutiveFailures: 1 },
      }),
    });

    assert.equal((yield* test.run()).status, "failed");
    assert.equal(test.child().status, "open");
    assert.deepEqual(
      test.events.filter((event) => event.type === "child-claim-released"),
      [],
    );
  }),
);

it.live("retries a failed claim release during terminal cleanup", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ claim: true, blocked: true }],
      releaseFailures: 1,
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 1 },
        server: { ...DEFAULT_EPIC_RUN_CONFIG.server, maxConsecutiveFailures: 1 },
      }),
    });

    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.equal(result.lastError, "agent reported RALPH_BLOCKED");
    assert.equal(test.child().status, "open");
    assert.equal(test.releaseAttempts(), 2);
    assert.isBelow(
      test.ordering.lastIndexOf("claim:release-attempt"),
      test.ordering.indexOf("lease:released"),
    );
    assert.deepEqual(
      test.events.filter((event) => event.type === "child-claim-released"),
      [
        {
          type: "child-claim-released",
          runId: "run",
          issueId: "epic.1",
          iterationIndex: 0,
          reason: "retry budget exhausted; child reopened",
        },
      ],
    );
  }),
);

it.live("does not charge infrastructure failures to the child attempt budget", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ infra: true }, { infra: true }, { commit: true, close: true }],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 1, maxIterations: 5 },
        server: {
          ...DEFAULT_EPIC_RUN_CONFIG.server,
          infraFailureBudget: 3,
          retryBaseDelayMs: 1,
          retryMaxDelayMs: 1,
        },
      }),
    });
    const result = yield* test.run();
    assert.equal(result.status, "done");
    assert.equal(test.dispatches(), 3);
    assert.notInclude(test.statuses, "blocked");
  }),
);

it.live("treats ready-empty with an open child as stuck", () =>
  Effect.gen(function* () {
    const test = fixture({ initialStatus: "in_progress" });
    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.include(result.lastError ?? "", "ready-empty-with-open-children");
    assert.equal(test.dispatches(), 0);
  }),
);

it.live("leaves claiming to the worker and reports done when it closes the child", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ claim: true, commit: true, close: true }],
      config: config({ limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxIterations: 1 } }),
    });
    const result = yield* test.run();
    assert.equal(result.status, "done");
    assert.equal(result.iterationsCompleted, 1);
    assert.equal(test.claims(), 0);
    assert.isTrue(test.released());
  }),
);

it.live("keeps a closed child unchanged when the worker leaves the worktree dirty", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ commit: true, close: true, dirty: true }],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 1, maxIterations: 2 },
      }),
    });
    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.equal(test.child().status, "closed");
  }),
);

it.live("fails safely after push failure without dispatching duplicate work", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ commit: true, close: true }],
      config: config({ vcs: { noPush: false } }),
      pushFails: true,
    });
    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.include(result.lastError ?? "", "push failed");
    assert.equal(test.dispatches(), 1);
    assert.equal(test.child().status, "closed");
  }),
);

it.live("records missing findings without reopening a closed research child", () =>
  Effect.gen(function* () {
    const test = fixture({
      childTitle: "Research: investigate",
      attempts: [{ commit: true, close: true }],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 1, maxIterations: 2 },
      }),
    });
    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.equal(test.child().status, "closed");
    assert.equal(test.iterations[0]?.failureReason, "child:closed-without-findings");
  }),
);

it.live("accepts committed research only with a new findings comment", () =>
  Effect.gen(function* () {
    const test = fixture({
      childTitle: "Research: investigate",
      attempts: [{ commit: true, close: true, comment: true }],
    });
    assert.equal((yield* test.run()).status, "done");
  }),
);

it.live("accepts non-code work with a closed child and new comment evidence", () =>
  Effect.gen(function* () {
    const test = fixture({ attempts: [{ close: true, comment: true }] });
    assert.equal((yield* test.run()).status, "done");
  }),
);

it.live("does not claim or dispatch when STOP appears before dispatch", () =>
  Effect.gen(function* () {
    const test = fixture({ stopChecks: [false, true] });
    const result = yield* test.run();
    assert.equal(result.status, "cancelled");
    assert.equal(test.claims(), 0);
    assert.equal(test.dispatches(), 0);
  }),
);

it.live("publishes iteration events only after their journal writes", () =>
  Effect.gen(function* () {
    const test = fixture({ attempts: [{ commit: true, close: true }] });
    yield* test.run();
    assert.isBelow(
      test.ordering.indexOf("journal:running"),
      test.ordering.indexOf("event:running"),
    );
    assert.isBelow(
      test.ordering.indexOf("journal:completed"),
      test.ordering.indexOf("event:completed"),
    );
  }),
);

it.live("does not reopen a closed child after a non-done outcome", () =>
  Effect.gen(function* () {
    const test = fixture({
      attempts: [{ claim: true, commit: true, close: true, blocked: true }],
      config: config({
        limits: { ...DEFAULT_EPIC_RUN_CONFIG.limits, maxAttemptsPerChild: 1, maxIterations: 2 },
      }),
    });
    const result = yield* test.run();
    assert.equal(result.status, "failed");
    assert.equal(test.child().status, "closed");
    assert.deepEqual(
      test.events.filter((event) => event.type === "child-claim-released"),
      [],
    );
  }),
);
