import { EpicRunId } from "@t3tools/contracts";
import type * as ProcessRunner from "@t3tools/epic-core/processRunner";
import type { MergeDrainShape, PoolRunJournalShape } from "@t3tools/epic-core/ParallelEpicLoop";
import { mergeSlotHolder } from "@t3tools/epic-core/policy";
import { drainMergeQueue } from "@t3tools/epic-core/MergeQueue";
import { makeProcessBacklog } from "@t3tools/epic-core/adapters/ProcessBacklog";
import { makeProcessGate } from "@t3tools/epic-core/adapters/ProcessGate";
import { makeProcessMergeRepair } from "@t3tools/epic-core/adapters/ProcessMergeRepair";
import { makeProcessMergeSlot } from "@t3tools/epic-core/adapters/ProcessMergeSlot";
import { GateError } from "@t3tools/epic-core/ports/Gate";
import type {
  GateReceiptJournalShape,
  PersistedGateReceipt,
} from "@t3tools/epic-core/ports/GateReceipts";
import { MergeQueuePortError } from "@t3tools/epic-core/ports/MergeQueue";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as FileSystem from "effect/FileSystem";

import { EpicRunnerDispatchError, EpicRunnerStoreError } from "@t3tools/epic-core/Errors";
import { makeEpicRunMergeGit } from "../EpicRunMergeGit.ts";
import { makeEpicRunMergeQueueStore } from "../EpicRunMergeQueueStore.ts";
import { setupWorktreeAssets, writeBeadsRedirect } from "./poolWorktreeAssets.ts";
import { journalError, storeError } from "./poolPortErrors.ts";
import type { EpicRunStore } from "../../persistence/Services/EpicRuns.ts";
import type { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";

export const makeServerGateReceipts = (
  store: EpicRunStore["Service"],
): GateReceiptJournalShape => ({
  record: (receipt) =>
    store
      .recordGateReceipt({
        ...receipt,
        runId: EpicRunId.make(receipt.runId),
        inputHeads: receipt.inputHeads,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new GateError({ operation: "gateReceipts.record", detail: cause.message, cause }),
        ),
      ),
  list: (runId) =>
    store.listGateReceipts({ runId: EpicRunId.make(runId) }).pipe(
      Effect.map((rows): ReadonlyArray<PersistedGateReceipt> => rows),
      Effect.mapError(
        (cause) => new GateError({ operation: "gateReceipts.list", detail: cause.message, cause }),
      ),
    ),
});

export const makeServerMergeDrain = (deps: {
  readonly store: EpicRunStore["Service"];
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly gitVcsDriver: GitVcsDriver["Service"];
  readonly iterations: PoolRunJournalShape;
}): MergeDrainShape => {
  const { store, processRunner, fileSystem, path, gitVcsDriver, iterations } = deps;
  const mergeQueueStore = makeEpicRunMergeQueueStore(store);
  const mergeGate = makeProcessGate({
    processRunner,
    environment: process.env,
    uid: process.getuid?.() ?? 0,
  });
  const mergeRepair = makeProcessMergeRepair({
    processRunner,
    environment: process.env,
    uid: process.getuid?.() ?? 0,
  });
  const writeDrainBeadsRedirect = writeBeadsRedirect({ fileSystem, path });

  const drain: MergeDrainShape["drain"] = Effect.fn("EpicRunner.drainQueuedBranches")(
    function* (runCtx) {
      const run = yield* store.getRun({ runId: runCtx.runId }).pipe(
        Effect.mapError(storeError("getRun")),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new EpicRunnerStoreError({
                  operation: `merge drain run not found: ${runCtx.runId}`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (run.config.execution.sequential) return { _tag: "idle" } as const;
      const mergeState = yield* store.getMergeState({ runId: run.runId }).pipe(
        Effect.map(Option.getOrNull),
        Effect.catchCause((cause) =>
          Effect.logWarning("epic.runner.merge-state-read-failed", {
            runId: run.runId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      const siblingAssetSources = new Map(
        (mergeState?.siblings ?? []).map((sibling) => [
          sibling.integrationWorktreePath,
          sibling.repositoryPath,
        ]),
      );
      const restoreIntegrationWorktreeAssets = (cwd: string) =>
        Effect.gen(function* () {
          const siblingSource =
            mergeState !== null && cwd !== mergeState.integrationWorktreePath
              ? siblingAssetSources.get(cwd)
              : undefined;
          if (siblingSource === undefined) yield* writeDrainBeadsRedirect(run.cwd, cwd);
          yield* setupWorktreeAssets({ fileSystem, path }, siblingSource ?? run.cwd, cwd);
        }).pipe(
          Effect.mapError(
            (cause) =>
              new MergeQueuePortError({
                operation: "setupWorktree",
                detail: `Could not restore integration worktree assets in ${cwd}`,
                cause,
              }),
          ),
        );
      const git = makeEpicRunMergeGit({
        git: gitVcsDriver,
        setupWorktree: restoreIntegrationWorktreeAssets,
      });
      yield* processRunner
        .run({ command: "bd", args: ["merge-slot", "create"], cwd: run.cwd })
        .pipe(Effect.ignore);
      let gateLogSequence = 0;
      const mergeGateWithLog: typeof mergeGate = {
        run: (gateInput) =>
          mergeGate.run(gateInput).pipe(
            Effect.flatMap((result) => {
              if (result.passed) return Effect.succeed(result);
              gateLogSequence += 1;
              const sequence = gateLogSequence;
              return Effect.flatMap(DateTime.now, (now) => {
                const logPath = path.join(
                  run.cwd,
                  ".git",
                  "t3code",
                  "epic-runs",
                  run.runId,
                  `gate-${String(DateTime.toEpochMillis(now))}-${String(sequence)}.log`,
                );
                return fileSystem.makeDirectory(path.dirname(logPath), { recursive: true }).pipe(
                  Effect.andThen(fileSystem.writeFileString(logPath, result.output)),
                  Effect.map(() => ({ ...result, outputPath: logPath })),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("epic.runner.gate-log-persist-failed", {
                      runId: run.runId,
                      cause,
                    }).pipe(Effect.as(result)),
                  ),
                );
              });
            }),
          ),
      };
      const result = yield* drainMergeQueue(
        {
          runId: run.runId,
          epicId: run.epicId,
          holder: mergeSlotHolder(run.runId),
          gateCommand: run.config.gate.disabled ? null : run.config.gate.command,
          pushEnabled: !run.config.vcs.noPush,
          verified: !run.config.gate.disabled,
          maxGateOutputBytes: 1024 * 1024,
        },
        {
          store: mergeQueueStore,
          git,
          slot: makeProcessMergeSlot({ repositoryPath: run.cwd, processRunner }),
          gate: mergeGateWithLog,
          gateReceipts: makeServerGateReceipts(store),
          repair: mergeRepair,
          backlog: makeProcessBacklog({ repositoryPath: run.cwd, processRunner }),
          iterations,
          events: {
            emit: (event) =>
              Effect.logInfo(`epic.runner.merge-${event.event}`, {
                runId: run.runId,
                ...event,
              }).pipe(Effect.asVoid),
          },
          fold: {
            run: (childId) =>
              Effect.logDebug("epic.runner.merge-fold-hook", { runId: run.runId, childId }).pipe(
                Effect.asVoid,
              ),
          },
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new EpicRunnerDispatchError({
              commandType: "git.merge-queue",
              detail: cause.message,
              cause,
            }),
        ),
      );
      if (result._tag === "fatal" && "detail" in result)
        return { _tag: "fatal", detail: result.detail } as const;
      if (result._tag === "deferred") return { _tag: "deferred", holder: result.holder } as const;
      if (result._tag === "drained")
        return {
          _tag: "drained",
          ...(result.blocked === undefined ? {} : { blocked: result.blocked }),
        } as const;
      return { _tag: "idle" } as const;
    },
  );

  return {
    drain,
    enqueueMerge: (input) =>
      store.enqueueMerge(input).pipe(Effect.mapError(journalError("enqueueMerge"))),
    findParkedOriginalChild: (input) =>
      store
        .findParkedOriginalChild(input)
        .pipe(Effect.mapError(journalError("findParkedOriginalChild"))),
    integrationTarget: (runCtx) =>
      store.getMergeState({ runId: runCtx.runId }).pipe(
        Effect.map((state) =>
          Option.match(state, {
            onNone: () => null,
            onSome: (merge) => ({
              repositoryPath: merge.repositoryPath,
              baseBranch: merge.baseBranch,
              operatorBaseBranch: merge.operatorBaseBranch,
            }),
          }),
        ),
        Effect.catchCause(() => Effect.succeed(null)),
      ),
    unlandedEntries: (runCtx) =>
      store.getMergeState({ runId: runCtx.runId }).pipe(
        Effect.map((state) =>
          Option.match(state, {
            onNone: () => [],
            onSome: (merge) =>
              merge.entries.map((entry) => ({
                childId: entry.childId,
                branch: entry.branch,
                status: entry.status,
              })),
          }),
        ),
        Effect.catchCause(() => Effect.succeed(null)),
      ),
    recordIntegratedHead: (runCtx) =>
      Effect.gen(function* () {
        const state = Option.getOrThrow(
          yield* store
            .getMergeState({ runId: runCtx.runId })
            .pipe(Effect.mapError(storeError("getMergeState"))),
        );
        const mergeGit = makeEpicRunMergeGit({
          git: gitVcsDriver,
          setupWorktree: () => Effect.void,
        });
        const head = yield* mergeGit.head(state.repositoryPath, state.baseBranch).pipe(
          Effect.mapError(
            (cause) =>
              new EpicRunnerDispatchError({
                commandType: "git.integration-resync",
                detail: cause.message,
                cause,
              }),
          ),
        );
        const siblingHeads = yield* Effect.forEach(
          state.siblings,
          (sibling) =>
            mergeGit.head(sibling.repositoryPath).pipe(
              Effect.map((siblingHead) => ({
                repositoryPath: sibling.repositoryPath,
                lastAcceptedHead: siblingHead,
              })),
            ),
          { concurrency: 1 },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new EpicRunnerDispatchError({
                commandType: "git.integration-resync",
                detail: cause.message,
                cause,
              }),
          ),
        );
        yield* store
          .advanceMergeIntegration({
            runId: runCtx.runId,
            lastAcceptedHead: head,
            ...(siblingHeads.length > 0 ? { siblingHeads } : {}),
          })
          .pipe(Effect.mapError(storeError("advanceMergeIntegration")));
      }),
  };
};
