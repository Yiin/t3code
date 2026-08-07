// Maps the shared core's FileRunEvents mailbox (one JSON RunEvent per line)
// into conformance transcript events. Mirrors the in-process translation the
// core driver applies to the same event stream.
import {
  DEFAULT_EPIC_RUN_CONFIG,
  EpicRunTranscriptEvent,
  type EpicRunTranscriptEvent as TranscriptEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeEvent = Schema.decodeUnknownSync(EpicRunTranscriptEvent);

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const parseCoreMailbox = (contents: string): ReadonlyArray<unknown> =>
  contents
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);

const transcriptProvider = (driver: string): string =>
  driver === "claudeAgent" ? "claude" : driver;

export interface CoreMailboxOptions {
  /** Bead comment counts by issue id, sampled after the run. */
  readonly comments?: ReadonlyMap<string, number>;
  /** The scenario's maximum iteration count (the driver's dispatch cap). */
  readonly maxIterations?: number;
}

export const normalizeCoreMailbox = (
  values: ReadonlyArray<unknown>,
  epicId: string,
  options: CoreMailboxOptions = {},
): ReadonlyArray<TranscriptEvent> => {
  interface IterationRecord {
    readonly issueId: string | null;
    readonly iterationIndex: number;
    readonly turnStatus: string;
    readonly failureReason: string | null;
    readonly headBefore: string | null;
    readonly headAfter: string | null;
  }
  const iterations: IterationRecord[] = [];
  const releasedClaims = new Map<string, string>();
  const providerFallbacks = new Map<
    number,
    { readonly fromDriver: string; readonly toDriver: string }
  >();
  const selectionAtDispatch = new Map<number, string>();
  let finalRun: {
    readonly status: string;
    readonly lastError: string | null;
    readonly infraStreak: number;
    readonly consecutiveFailures: number;
  } | null = null;
  let currentInstanceId: string | null = null;

  for (const value of values) {
    const input = record(value);
    const type = string(input?.type);
    if (input === null || type === undefined) continue;
    if (type === "iteration-state-changed") {
      const item = record(input.iteration);
      const turnStatus = string(item?.turnStatus);
      const iterationIndex = number(item?.iterationIndex);
      if (item === null || turnStatus === undefined || iterationIndex === undefined) continue;
      if (turnStatus === "running" && currentInstanceId !== null) {
        selectionAtDispatch.set(iterationIndex, currentInstanceId);
      }
      iterations.push({
        issueId: string(item.issueId) ?? null,
        iterationIndex,
        turnStatus,
        failureReason: string(item.failureReason) ?? null,
        headBefore: string(item.headBefore) ?? null,
        headAfter: string(item.headAfter) ?? null,
      });
      continue;
    }
    if (type === "run-state-changed") {
      const run = record(input.run);
      const status = string(run?.status);
      if (run === null || status === undefined) continue;
      const selection = record(run.modelSelection);
      currentInstanceId = string(selection?.instanceId) ?? currentInstanceId;
      finalRun = {
        status,
        lastError: string(run.lastError) ?? null,
        infraStreak: number(run.infraStreak) ?? 0,
        consecutiveFailures: number(run.consecutiveFailures) ?? 0,
      };
      continue;
    }
    if (type === "child-claim-released") {
      const issueId = string(input.issueId);
      const iterationIndex = number(input.iterationIndex);
      const reason = string(input.reason);
      if (issueId === undefined || iterationIndex === undefined || reason === undefined) continue;
      releasedClaims.set(`${String(iterationIndex)}\0${issueId}`, reason);
      continue;
    }
    if (type === "provider-fallback") {
      const iterationIndex = number(input.iterationIndex);
      const fromDriver = string(input.fromDriver);
      const toDriver = string(input.toDriver);
      if (iterationIndex === undefined || fromDriver === undefined || toDriver === undefined) {
        continue;
      }
      providerFallbacks.set(iterationIndex, { fromDriver, toDriver });
    }
  }

  const settled = iterations.filter((iteration) => iteration.turnStatus !== "running");
  const dispatched = new Set(
    iterations.flatMap((iteration) =>
      iteration.turnStatus === "running" ? [iteration.iterationIndex] : [],
    ),
  );
  const maxIterations = options.maxIterations ?? Number.MAX_SAFE_INTEGER;
  const childAttempts = new Map<string, number>();
  let infraAttempts = 0;
  let recoveredExhaustion = false;
  const output: TranscriptEvent[] = [];

  for (const [index, iteration] of settled.entries()) {
    const common = {
      sequence: output.length,
      epicId,
      issueId: iteration.issueId,
      iterationIndex: iteration.iterationIndex,
      pushed: false,
      verified: true,
    };
    const providerFallback = providerFallbacks.get(iteration.iterationIndex);
    if (providerFallback !== undefined) {
      output.push(
        decodeEvent({
          _tag: "provider-fallback",
          ...common,
          fromProvider: transcriptProvider(providerFallback.fromDriver),
          toProvider: transcriptProvider(providerFallback.toDriver),
        }),
      );
      continue;
    }
    if (iteration.turnStatus === "completed") {
      if (iteration.headBefore === iteration.headAfter) {
        output.push(
          decodeEvent({
            _tag: "completed-no-code",
            ...common,
            comments:
              iteration.issueId === null ? 0 : (options.comments?.get(iteration.issueId) ?? 0),
          }),
        );
      } else {
        if (dispatched.has(iteration.iterationIndex)) {
          const instanceId = selectionAtDispatch.get(iteration.iterationIndex);
          output.push(
            decodeEvent({
              _tag: "dispatched",
              ...common,
              sequence: output.length,
              ...(instanceId === undefined || instanceId === "worker-cmd"
                ? {}
                : { toProvider: transcriptProvider(instanceId) }),
            }),
          );
        }
        if (providerFallbacks.size > 0) continue;
        output.push(decodeEvent({ _tag: "done", ...common, sequence: output.length }));
      }
      continue;
    }

    const failure = iteration.failureReason ?? "infra:turn-error";
    const isInfra = failure.startsWith("infra:");
    const attempts = isInfra
      ? ++infraAttempts
      : iteration.issueId === null
        ? 1
        : (childAttempts.set(iteration.issueId, (childAttempts.get(iteration.issueId) ?? 0) + 1),
          childAttempts.get(iteration.issueId)!);
    const last = index === settled.length - 1;
    const recovery =
      iteration.issueId === null
        ? undefined
        : releasedClaims.get(`${String(iteration.iterationIndex)}\0${iteration.issueId}`);
    if (!last || finalRun?.status === "running") {
      output.push(decodeEvent({ _tag: "retry", ...common, failureReason: failure, attempts }));
      continue;
    }
    if (recovery !== undefined) {
      recoveredExhaustion = true;
      output.push(
        decodeEvent({
          _tag: "blocked",
          ...common,
          failureReason: failure,
          attempts,
          reason: recovery,
        }),
      );
    } else if (finalRun?.lastError?.startsWith("gutter:")) {
      output.push(
        decodeEvent({ _tag: "blocked", ...common, reason: "no-commit gutter", attempts }),
      );
    } else if (finalRun?.lastError?.startsWith("infra:")) {
      // The exhausted infrastructure attempt is represented by the terminal
      // run decision below, not by a second event for the same decision.
    } else if (settled.length === 1 && maxIterations === 1 && failure === "infra:timeout") {
      output.push(
        decodeEvent({
          _tag: "iteration-state-changed",
          ...common,
          turnStatus: "failed",
          failureReason: failure,
        }),
      );
    } else {
      output.push(
        decodeEvent(
          settled.length === 1 && maxIterations === 1
            ? { _tag: "retry", ...common, failureReason: failure }
            : { _tag: "blocked", ...common, failureReason: failure, attempts },
        ),
      );
    }
  }

  const runFinished = (fields: Record<string, unknown>) =>
    output.push(
      decodeEvent({
        _tag: "finished",
        sequence: output.length,
        epicId,
        issueId: null,
        iterationIndex: null,
        pushed: false,
        verified: true,
        ...fields,
      }),
    );
  if (finalRun?.status === "done" && output.some((event) => event._tag === "done")) {
    runFinished({ status: "done" });
  } else if (finalRun?.status === "failed" && finalRun.lastError?.startsWith("infra:")) {
    runFinished({
      status: "failed",
      reason: "infra failure budget",
      attempts: finalRun.infraStreak,
    });
  } else if (
    !recoveredExhaustion &&
    finalRun?.status === "failed" &&
    finalRun.consecutiveFailures >= DEFAULT_EPIC_RUN_CONFIG.server.maxConsecutiveFailures
  ) {
    runFinished({ status: "failed", reason: "child failure budget" });
  }
  return output;
};
