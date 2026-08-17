/**
 * The `bd` probes the pool loop reads its backlog through, over a
 * {@link ProcessRunner}. Shared by the server runner
 * (`PoolWorkspace.ts`) and the terminal `t3 epic cook` entry. Evidence
 * reads never fail: an unreadable issue yields conservative nulls, exactly
 * like the server's probes, and the loop treats unknown as unproven.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  IssueEvidenceRead,
  PoolBacklogShape,
  ReadyFrontierSelection,
} from "../ParallelEpicLoop.ts";
import { BacklogError } from "../ports/Backlog.ts";
import type * as ProcessRunner from "../processRunner.ts";

const IssueEvidence = Schema.Struct({
  status: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  comment_count: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
const decodeIssueEvidence = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([IssueEvidence, Schema.Array(IssueEvidence)])),
);
const decodeEpicDescription = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ description: Schema.String }),
      Schema.Array(Schema.Struct({ description: Schema.String })),
    ]),
  ),
);
const ReadyChildren = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      parent: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
    }),
  ),
);
const decodeReadyChildren = Schema.decodeUnknownEffect(ReadyChildren);
const EpicChildren = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
    }),
  ),
);
const decodeEpicChildren = Schema.decodeUnknownEffect(EpicChildren);

export const makeProcessPoolBacklog = (
  processRunner: ProcessRunner.ProcessRunner["Service"],
): PoolBacklogShape => {
  const readyFrontier: PoolBacklogShape["readyFrontier"] = (cwd, epicId) =>
    processRunner
      .run({
        command: "bd",
        args: ["ready", "--parent", epicId, "--json"],
        cwd,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BacklogError({
              operation: "bd.ready",
              detail: "Could not read the epic's ready children",
              cause,
            }),
        ),
        Effect.flatMap((output) => {
          if (output.code !== 0) {
            // The backlog-empty decision starts from this read, so its raw
            // failure belongs on record, not only inside the raised error.
            return Effect.gen(function* () {
              yield* Effect.logWarning("epic.runner.bd-ready-failed", {
                cwd,
                epicId,
                exitCode: output.code,
                stderr: output.stderr.trim(),
              });
              return yield* new BacklogError({
                operation: "bd.ready",
                detail: output.stderr.trim() || `bd ready exited with code ${output.code}`,
              });
            });
          }
          return decodeReadyChildren(output.stdout).pipe(
            Effect.mapError(
              (cause) =>
                new BacklogError({
                  operation: "bd.ready",
                  detail: `Invalid bd ready output: ${String(cause)}`,
                  cause,
                }),
            ),
            Effect.flatMap((value): Effect.Effect<ReadyFrontierSelection, BacklogError> => {
              if (value.length === 0)
                return Effect.succeed<ReadyFrontierSelection>({ _tag: "empty" });

              // `bd ready --parent` owns the scope. Some bd rows omit the
              // parent value, which decodes to null and is usable. Reject
              // only an explicit parent that names another issue.
              const direct = value.filter(
                (issue) => issue.parent === null || issue.parent === epicId,
              );
              if (direct.length === 0) {
                return Effect.succeed<ReadyFrontierSelection>({
                  _tag: "unrecognised",
                  candidateIds: value.map((issue) => issue.id),
                });
              }
              const invalid = direct.find((issue) => issue.id.trim().length === 0);
              return invalid !== undefined
                ? Effect.fail(
                    new BacklogError({
                      operation: "bd.ready",
                      detail: "Invalid bd ready output: a usable ready child has no id",
                    }),
                  )
                : Effect.succeed<ReadyFrontierSelection>({
                    _tag: "children",
                    issueIds: direct.map((issue) => issue.id),
                  });
            }),
          );
        }),
      );

  const openChildIds: PoolBacklogShape["openChildIds"] = (cwd, epicId) =>
    processRunner
      .run({
        command: "bd",
        args: ["list", "--parent", epicId, "--all", "--flat", "--json"],
        cwd,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BacklogError({
              operation: "bd.list",
              detail: "Could not read the epic's children",
              cause,
            }),
        ),
        Effect.flatMap((output) => {
          if (output.code !== 0) {
            return Effect.fail(
              new BacklogError({
                operation: "bd.list",
                detail: output.stderr.trim() || `bd list exited with code ${output.code}`,
              }),
            );
          }
          return decodeEpicChildren(output.stdout).pipe(
            Effect.mapError(
              (cause) =>
                new BacklogError({
                  operation: "bd.list",
                  detail: `Invalid bd list output: ${String(cause)}`,
                  cause,
                }),
            ),
            Effect.map((children) =>
              children
                .filter((child) => child.id !== epicId && child.status !== "closed")
                .map((child) => child.id),
            ),
          );
        }),
      );

  const emptyIssueEvidence: IssueEvidenceRead = {
    status: null,
    title: null,
    commentCount: 0,
  } as const;

  /**
   * The child issue evidence available from one `bd show`, with conservative
   * defaults when the command fails or its output cannot be decoded. Never
   * fails the caller: unknown status and comment count cannot prove work.
   */
  const issueEvidence: PoolBacklogShape["issueEvidence"] = (cwd, issueId) =>
    processRunner.run({ command: "bd", args: ["show", issueId, "--json"], cwd }).pipe(
      Effect.map((shown) => {
        if (shown.code !== 0) return emptyIssueEvidence;
        const decoded = decodeIssueEvidence(shown.stdout);
        if (Option.isNone(decoded)) return emptyIssueEvidence;
        const value = Array.isArray(decoded.value) ? decoded.value[0] : decoded.value;
        if (value === undefined) return emptyIssueEvidence;
        return {
          status: value.status ?? null,
          title: value.title ?? null,
          commentCount: value.comment_count,
        };
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("epic.runner.issue-evidence-read-failed", { cwd, issueId, cause }).pipe(
          Effect.as(emptyIssueEvidence),
        ),
      ),
    );

  /**
   * Whether findings in the bead are this child's deliverable. A title
   * prefix is authoritative; otherwise a failed label read means false.
   */
  const issueIsResearch: PoolBacklogShape["issueIsResearch"] = (cwd, issueId, title) => {
    if (title?.startsWith("Research:") === true) return Effect.succeed(true);
    return processRunner.run({ command: "bd", args: ["label", "list", issueId], cwd }).pipe(
      Effect.map((listed) => listed.code === 0 && /^\s*-\s*research\s*$/imu.test(listed.stdout)),
      Effect.catchCause(() => Effect.succeed(false)),
    );
  };

  const epicDescription: PoolBacklogShape["epicDescription"] = (cwd, epicId) =>
    processRunner.run({ command: "bd", args: ["show", epicId, "--json"], cwd }).pipe(
      Effect.flatMap((shown) => {
        if (shown.code !== 0) {
          return Effect.logWarning("epic.runner.epic-description-read-failed", {
            cwd,
            epicId,
            detail: shown.stderr.trim() || `bd show exited with code ${shown.code}`,
          }).pipe(Effect.as(null));
        }
        const decoded = decodeEpicDescription(shown.stdout);
        const value = Option.isSome(decoded)
          ? Array.isArray(decoded.value)
            ? decoded.value[0]
            : decoded.value
          : undefined;
        if (value === undefined) {
          return Effect.logWarning("epic.runner.epic-description-decode-failed", {
            cwd,
            epicId,
          }).pipe(Effect.as(null));
        }
        return Effect.succeed<string | null>(value.description);
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("epic.runner.epic-description-read-failed", {
          cwd,
          epicId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );

  /**
   * Best-effort: un-claim a child issue the loop's own exit just stranded.
   *
   * An iteration's agent claims its child itself and is expected to close it
   * before the turn ends. When the *run* instead exits without that happening
   * the child is left `in_progress` with no worker attached, and `bd ready`
   * filters on status, so a phantom claim silently stalls the epic. The
   * child's *current* status is re-read and only a standing claim is reopened,
   * so the happy path (the agent already closed it) and a legitimate handoff
   * to another run are both untouched. Returns whether a claim was released.
   *
   * Never fails the caller: this runs from terminal paths (finalizers,
   * restart bookkeeping) that have nowhere useful to send an error.
   */
  const releaseClaimedChild: PoolBacklogShape["releaseClaimedChild"] = (cwd, issueId) =>
    issueEvidence(cwd, issueId).pipe(
      Effect.flatMap((evidence) => {
        if (evidence.status !== "in_progress") return Effect.succeed(false);
        return processRunner
          .run({
            command: "bd",
            args: ["update", issueId, "--status", "open", "--assignee", ""],
            cwd,
          })
          .pipe(Effect.as(true));
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("epic.runner.release-claimed-child-failed", { cwd, issueId, cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  /**
   * Take the standing claim on a child a resume is about to continue.
   *
   * The claim may or may not have survived the process that made it: the run's
   * own finalizer reopens every child it stranded, so the bead can read `open`
   * again even though the worktree and the agent session are both still there.
   * Only `open` is claimed. `in_progress` is already ours (or a legitimate
   * handoff) and needs no write, and `closed` is the one answer that must stop
   * the resume.
   *
   * An unreadable bead is `unknown`, never `closed`: dropping a live agent
   * session because `bd` hiccuped costs more than continuing one turn too many.
   */
  const claimChild: PoolBacklogShape["claimChild"] = (cwd, issueId) =>
    issueEvidence(cwd, issueId).pipe(
      Effect.flatMap((evidence) => {
        if (evidence.status === "closed") return Effect.succeed("closed" as const);
        if (evidence.status === "in_progress") return Effect.succeed("already-claimed" as const);
        if (evidence.status !== "open") return Effect.succeed("unknown" as const);
        return processRunner
          .run({ command: "bd", args: ["update", issueId, "--status", "in_progress"], cwd })
          .pipe(
            Effect.map((claimed) =>
              claimed.code === 0 ? ("claimed" as const) : ("unknown" as const),
            ),
          );
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("epic.runner.claim-child-failed", { cwd, issueId, cause }).pipe(
          Effect.as("unknown" as const),
        ),
      ),
    );

  return {
    readyFrontier,
    openChildIds,
    issueEvidence,
    issueIsResearch,
    epicDescription,
    releaseClaimedChild,
    claimChild,
  };
};
