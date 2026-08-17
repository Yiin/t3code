// @effect-diagnostics nodeBuiltinImport:off
/**
 * The terminal merge drain: merge-queue writes and the queued-branch drain
 * the pool scheduler runs, over the file-backed merge-queue store and the
 * `bd`/`git` CLIs.
 *
 * A semantic port of the server's `makeServerMergeDrain`
 * (`PoolMergeDrain.ts`): same drain input derivation from the persisted
 * run, same integration-worktree asset restoration, same holder convention.
 * The terminal fold hook is a deliberate no-op — notes folding was dropped
 * for the terminal surface (t3code-06s.28).
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { EpicRunnerDispatchError, EpicRunnerStoreError } from "../Errors.ts";
import { drainMergeQueue } from "../MergeQueue.ts";
import type { MergeDrainShape } from "../ParallelEpicLoop.ts";
import type { BacklogShape } from "../ports/Backlog.ts";
import type { GateShape } from "../ports/Gate.ts";
import type { GateReceiptJournalShape } from "../ports/GateReceipts.ts";
import type { MergeRepairShape, MergeSlotShape } from "../ports/MergeQueue.ts";
import { MergeQueuePortError } from "../ports/MergeQueue.ts";
import { mergeSlotHolder } from "../policy.ts";
import { RunJournalError, type RunJournalShape } from "../ports/RunJournal.ts";
import type * as ProcessRunner from "../processRunner.ts";
import { linkNodeModulesTree } from "./worktreeNodeModules.ts";
import { makeProcessBacklog } from "./ProcessBacklog.ts";
import { makeProcessMergeGit } from "./ProcessMergeGit.ts";
import { makeProcessMergeSlot } from "./ProcessMergeSlot.ts";
import type { FileMergeQueueStoreShape } from "./FileMergeQueueStore.ts";

/** The env files `setup_worktree_assets` copies (never production/staging). */
const WORKTREE_ASSET_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.test",
] as const;

const detail = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const pathExists = async (target: string): Promise<boolean> =>
  NodeFSP.access(target).then(
    () => true,
    () => false,
  );

const storeError = (operation: string) => (cause: unknown) =>
  new EpicRunnerStoreError({ operation, cause });

const journalError = (operation: string) => (cause: unknown) =>
  new RunJournalError({
    operation,
    detail: cause instanceof Error ? cause.message : detail(cause),
    ...(cause === undefined ? {} : { cause }),
  });

export const makeTerminalMergeDrain = (deps: {
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly journal: RunJournalShape;
  readonly mergeQueueStore: FileMergeQueueStoreShape;
  readonly gate: GateShape;
  readonly gateReceipts: GateReceiptJournalShape;
  readonly repair: MergeRepairShape;
  /** Test seams; the process adapters are the real defaults. */
  readonly slot?: (repositoryPath: string) => MergeSlotShape;
  readonly backlog?: (
    repositoryPath: string,
  ) => Pick<BacklogShape, "createChild" | "listChildren" | "writeNotes">;
}): MergeDrainShape => {
  const { processRunner, journal, mergeQueueStore, gate, gateReceipts, repair } = deps;

  const writeBeadsRedirect = (runCwd: string, worktreeCwd: string) =>
    Effect.tryPromise({
      try: async () => {
        const beadsDirectory = NodePath.join(runCwd, ".beads");
        const canonicalBeads = await NodeFSP.realpath(beadsDirectory).catch(() => beadsDirectory);
        const redirect = await NodeFSP.readFile(
          NodePath.join(canonicalBeads, "redirect"),
          "utf8",
        ).then(
          (contents) => contents.trim(),
          () => "",
        );
        const targetBeads = await (async () => {
          const target =
            redirect.length === 0
              ? canonicalBeads
              : NodePath.isAbsolute(redirect)
                ? redirect
                : NodePath.resolve(runCwd, redirect);
          return NodeFSP.realpath(target).catch(() => target);
        })();
        const worktreeBeads = NodePath.join(worktreeCwd, ".beads");
        await NodeFSP.mkdir(worktreeBeads, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(worktreeBeads, "redirect"),
          NodePath.relative(worktreeCwd, targetBeads),
        );
      },
      catch: (cause) =>
        new MergeQueuePortError({
          operation: "setupWorktree",
          detail: `Could not write the beads redirect in ${worktreeCwd}: ${detail(cause)}`,
          cause,
        }),
    });

  const setupWorktreeAssets = (sourceRepo: string, target: string) =>
    Effect.tryPromise({
      try: async () => {
        await linkNodeModulesTree(sourceRepo, target);
        for (const name of WORKTREE_ASSET_ENV_FILES) {
          const source = NodePath.join(sourceRepo, name);
          const targetFile = NodePath.join(target, name);
          if ((await pathExists(source)) && !(await pathExists(targetFile))) {
            await NodeFSP.copyFile(source, targetFile);
          }
        }
      },
      catch: (cause) =>
        new MergeQueuePortError({
          operation: "setupWorktree",
          detail: `Could not restore integration worktree assets in ${target}: ${detail(cause)}`,
          cause,
        }),
    });

  const drain: MergeDrainShape["drain"] = Effect.fn("TerminalMergeDrain.drain")(function* (runCtx) {
    const run = yield* journal.getRun(runCtx.runId).pipe(
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
    const mergeState = yield* mergeQueueStore.read(run.runId).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) =>
        Effect.logWarning("epic.cook.merge-state-read-failed", {
          runId: run.runId,
          cause,
        }).pipe(Effect.as(Option.none())),
      ),
    );
    // The drain's `setup_worktree` mapping: the main integration worktree
    // gets the beads redirect plus assets; a SIBLING integration worktree
    // gets assets only, sourced from its own checkout — siblings have no
    // beads database (`skills/cook-epic/run-legacy.sh:1007-1011,3110-3112`).
    const siblingAssetSources = new Map(
      (Option.isSome(mergeState) ? mergeState.value.siblings : []).map((sibling) => [
        sibling.integrationWorktreePath,
        sibling.repositoryPath,
      ]),
    );
    const restoreIntegrationWorktreeAssets = (cwd: string) =>
      Effect.gen(function* () {
        const siblingSource =
          Option.isSome(mergeState) && cwd !== mergeState.value.integrationWorktreePath
            ? siblingAssetSources.get(cwd)
            : undefined;
        if (siblingSource === undefined) {
          yield* writeBeadsRedirect(run.cwd, cwd);
        }
        yield* setupWorktreeAssets(siblingSource ?? run.cwd, cwd);
      });
    const git = makeProcessMergeGit({
      processRunner,
      setupWorktree: restoreIntegrationWorktreeAssets,
    });
    // The merge slot is a bd coordination primitive the terminal coordinator
    // creates itself (`skills/cook-epic/run-legacy.sh:718`); without it every
    // acquire fails and the drain defers forever. Create is idempotent and
    // best-effort — a real contention failure still defers the drain.
    yield* processRunner
      .run({ command: "bd", args: ["merge-slot", "create"], cwd: run.cwd })
      .pipe(Effect.ignore);
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
        slot:
          deps.slot?.(run.cwd) ?? makeProcessMergeSlot({ repositoryPath: run.cwd, processRunner }),
        gate,
        gateReceipts,
        repair,
        backlog:
          deps.backlog?.(run.cwd) ?? makeProcessBacklog({ repositoryPath: run.cwd, processRunner }),
        // The same journal the loop writes its `RALPH_MSG` clauses into, so a
        // merge-fix child quotes what each author actually reported.
        iterations: journal,
        events: {
          emit: (event) =>
            Effect.logInfo(`epic.cook.merge-${event.event}`, {
              runId: run.runId,
              ...event,
            }).pipe(Effect.asVoid),
        },
        // Notes folding was deliberately dropped for the terminal (t3code-06s.28).
        fold: { run: () => Effect.void },
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
    // The loop consumes a narrow view; the queue-length telemetry stays here.
    if (result._tag === "fatal" && "detail" in result) {
      return { _tag: "fatal", detail: result.detail } as const;
    }
    if (result._tag === "deferred") {
      return { _tag: "deferred", holder: result.holder } as const;
    }
    if (result._tag === "drained") {
      return {
        _tag: "drained",
        ...(result.blocked === undefined ? {} : { blocked: result.blocked }),
      } as const;
    }
    return { _tag: "idle" } as const;
  });

  return {
    drain,
    enqueueMerge: (input) =>
      mergeQueueStore.enqueue(input).pipe(Effect.mapError(journalError("enqueueMerge"))),
    findParkedOriginalChild: (input) =>
      mergeQueueStore
        .parkedOriginalChild(input.runId, input.branch)
        .pipe(Effect.mapError(journalError("findParkedOriginalChild"))),
    integrationTarget: (runCtx) =>
      mergeQueueStore.read(runCtx.runId).pipe(
        Effect.map((state) => ({
          repositoryPath: state.repositoryPath,
          baseBranch: state.baseBranch,
          operatorBaseBranch: state.operatorBaseBranch,
        })),
        Effect.catchCause(() => Effect.succeed(null)),
      ),
    unlandedEntries: (runCtx) =>
      mergeQueueStore.read(runCtx.runId).pipe(
        Effect.map((state) =>
          state.entries.map((entry) => ({
            childId: entry.childId,
            branch: entry.branch,
            status: entry.status,
          })),
        ),
        // An unreadable store answers `null`, not `[]` (t3code-e46): the
        // loop's completion proof must not read "unlanded unknown" as
        // "nothing unlanded".
        Effect.catchCause(() => Effect.succeed(null)),
      ),
    recordIntegratedHead: (runCtx) =>
      Effect.gen(function* () {
        const state = yield* mergeQueueStore
          .read(runCtx.runId)
          .pipe(Effect.mapError(storeError("read")));
        const head = yield* makeProcessMergeGit({ processRunner })
          .head(state.repositoryPath, state.baseBranch)
          .pipe(
            Effect.mapError(
              (cause) =>
                new EpicRunnerDispatchError({
                  commandType: "git.integration-resync",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
        yield* mergeQueueStore
          .advanceIntegration({ runId: runCtx.runId, lastAcceptedHead: head })
          .pipe(Effect.mapError(storeError("advanceIntegration")));
      }),
  };
};
