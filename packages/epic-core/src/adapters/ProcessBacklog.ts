import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProcessRunner, type ProcessRunOutput } from "../processRunner.ts";
import { BacklogError, type BacklogIssue, type BacklogShape } from "../ports/Backlog.ts";

const BdIssue = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  priority: Schema.optional(Schema.NullOr(Schema.Number)),
  issue_type: Schema.optional(Schema.NullOr(Schema.String)),
  parent: Schema.optional(Schema.NullOr(Schema.String)),
  notes: Schema.optional(Schema.String),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.optional(Schema.Array(Schema.String)),
  comments: Schema.optional(Schema.Array(Schema.Unknown)),
  comment_count: Schema.optional(Schema.Number),
});
type BdIssue = typeof BdIssue.Type;

const BdIssueOutput = Schema.Union([BdIssue, Schema.Array(BdIssue)]);
const decodeBdIssueOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(BdIssueOutput));
const MergeSlotAcquireOutput = Schema.Struct({
  acquired: Schema.Boolean,
  holder: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeMergeSlotAcquireOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MergeSlotAcquireOutput),
);

const toIssue = (issue: BdIssue): BacklogIssue => ({
  id: issue.id,
  title: issue.title,
  status: issue.status,
  priority: issue.priority ?? null,
  issueType: issue.issue_type ?? null,
  parentId: issue.parent ?? null,
  description: issue.description ?? "",
  labels: issue.labels ?? [],
  commentCount: issue.comment_count ?? issue.comments?.length ?? 0,
});

const outputDetail = (output: ProcessRunOutput): string =>
  output.stderr.trim() || output.stdout.trim() || `bd exited with code ${String(output.code)}`;

export const makeProcessBacklog = (input: {
  readonly repositoryPath: string;
  readonly processRunner: ProcessRunner["Service"];
}): BacklogShape => {
  const run = Effect.fn("ProcessBacklog.run")(function* (command: {
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly issueId?: string;
    readonly cwd?: string;
  }) {
    const output = yield* input.processRunner
      .run({
        command: "bd",
        args: command.args,
        cwd: command.cwd ?? input.repositoryPath,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BacklogError({
              operation: command.operation,
              issueId: command.issueId,
              detail: "Could not run bd",
              cause,
            }),
        ),
      );
    if (output.code !== 0) {
      return yield* new BacklogError({
        operation: command.operation,
        issueId: command.issueId,
        detail: outputDetail(output),
      });
    }
    return output.stdout;
  });

  const decodeIssues = Effect.fn("ProcessBacklog.decodeIssues")(function* (command: {
    readonly operation: string;
    readonly issueId?: string;
    readonly stdout: string;
  }) {
    const decoded = yield* decodeBdIssueOutput(command.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new BacklogError({
            operation: command.operation,
            issueId: command.issueId,
            detail: "bd returned invalid issue JSON",
            cause,
          }),
      ),
    );
    return (Array.isArray(decoded) ? decoded : [decoded]).map(toIssue);
  });

  const readyChildren: BacklogShape["readyChildren"] = Effect.fn("ProcessBacklog.readyChildren")(
    function* (epicId, limit) {
      const operation = "readyChildren";
      const stdout = yield* run({
        operation,
        issueId: epicId,
        args: [
          "ready",
          "--parent",
          epicId,
          "--json",
          ...(limit === undefined ? [] : ["--limit", String(limit)]),
        ],
      });
      return yield* decodeIssues({ operation, issueId: epicId, stdout });
    },
  );

  const showIssue: BacklogShape["showIssue"] = Effect.fn("ProcessBacklog.showIssue")(
    function* (issueId) {
      const operation = "showIssue";
      const stdout = yield* run({ operation, issueId, args: ["show", issueId, "--json"] });
      const issues = yield* decodeIssues({ operation, issueId, stdout });
      const issue = issues[0];
      if (issue === undefined) {
        return yield* new BacklogError({
          operation,
          issueId,
          detail: "bd returned no issue",
        });
      }
      return issue;
    },
  );

  const listChildren: BacklogShape["listChildren"] = Effect.fn("ProcessBacklog.listChildren")(
    function* (epicId) {
      const operation = "listChildren";
      const stdout = yield* run({
        operation,
        issueId: epicId,
        args: ["list", "--parent", epicId, "--all", "--flat", "--json"],
      });
      return yield* decodeIssues({ operation, issueId: epicId, stdout });
    },
  );

  const claim: BacklogShape["claim"] = (issueId, actor) =>
    run({
      operation: "claim",
      issueId,
      args: ["update", issueId, "--claim", ...(actor === undefined ? [] : ["--actor", actor])],
    }).pipe(Effect.asVoid);
  const releaseClaim: BacklogShape["releaseClaim"] = Effect.fn("ProcessBacklog.releaseClaim")(
    function* (issueId) {
      const issue = yield* showIssue(issueId);
      if (issue.status !== "in_progress") return false;
      yield* run({
        operation: "releaseClaim",
        issueId,
        args: ["update", issueId, "--status", "open", "--assignee", ""],
      });
      return true;
    },
  );
  const setStatus: BacklogShape["setStatus"] = (issueId, status) =>
    run({
      operation: "setStatus",
      issueId,
      args: ["update", issueId, "--status", status],
    }).pipe(Effect.asVoid);
  const createChild: BacklogShape["createChild"] = Effect.fn("ProcessBacklog.createChild")(
    function* ({ epicId, title, description, priority, discoveredFrom }) {
      const operation = "createChild";
      const stdout = yield* run({
        operation,
        issueId: epicId,
        args: [
          "create",
          title,
          "--type",
          "task",
          "--parent",
          epicId,
          "-p",
          String(priority),
          "-d",
          description,
          ...(discoveredFrom === undefined ? [] : ["--deps", `discovered-from:${discoveredFrom}`]),
          "--json",
        ],
      });
      const issues = yield* decodeIssues({ operation, issueId: epicId, stdout });
      const issue = issues[0];
      if (issue === undefined) {
        return yield* new BacklogError({
          operation,
          issueId: epicId,
          detail: "bd returned no created issue",
        });
      }
      return issue;
    },
  );
  const close: BacklogShape["close"] = ({ issueId, reason }) =>
    run({
      operation: "close",
      issueId,
      args: ["close", issueId, "--reason", reason],
    }).pipe(Effect.asVoid);
  const comment: BacklogShape["comment"] = ({ issueId, body }) =>
    run({ operation: "comment", issueId, args: ["comment", issueId, body] }).pipe(Effect.asVoid);

  const readNotes: BacklogShape["readNotes"] = Effect.fn("ProcessBacklog.readNotes")(
    function* (issueId) {
      const operation = "readNotes";
      const stdout = yield* run({ operation, issueId, args: ["show", issueId, "--json"] });
      const decoded = yield* decodeBdIssueOutput(stdout).pipe(
        Effect.mapError(
          (cause) =>
            new BacklogError({
              operation,
              issueId,
              detail: "bd returned invalid issue JSON",
              cause,
            }),
        ),
      );
      const issue = Array.isArray(decoded) ? decoded[0] : decoded;
      if (issue === undefined) {
        return yield* new BacklogError({ operation, issueId, detail: "bd returned no issue" });
      }
      return issue.notes ?? "";
    },
  );

  const writeNotes: BacklogShape["writeNotes"] = ({ issueId, note }) =>
    run({ operation: "writeNotes", issueId, args: ["note", issueId, note] }).pipe(Effect.asVoid);

  const swarm: BacklogShape["swarm"] = ({ epicId, action }) =>
    run({ operation: `swarm.${action}`, issueId: epicId, args: ["swarm", action, epicId] });

  const ensureSwarm: BacklogShape["ensureSwarm"] = Effect.fn("ProcessBacklog.ensureSwarm")(
    function* (epicId) {
      const output = yield* input.processRunner
        .run({
          command: "bd",
          args: ["swarm", "create", epicId],
          cwd: input.repositoryPath,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new BacklogError({
                operation: "ensureSwarm",
                issueId: epicId,
                detail: "Could not run bd",
                cause,
              }),
          ),
        );
      if (output.code === 0 || /swarm already exists/i.test(`${output.stdout}\n${output.stderr}`)) {
        return;
      }
      return yield* new BacklogError({
        operation: "ensureSwarm",
        issueId: epicId,
        detail: outputDetail(output),
      });
    },
  );

  const acquireMergeSlot: BacklogShape["acquireMergeSlot"] = Effect.fn(
    "ProcessBacklog.acquireMergeSlot",
  )(function* (holder) {
    const output = yield* input.processRunner
      .run({
        command: "bd",
        args: ["merge-slot", "acquire", "--holder", holder, "--json"],
        cwd: input.repositoryPath,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BacklogError({
              operation: "acquireMergeSlot",
              detail: "Could not run bd",
              cause,
            }),
        ),
      );
    const result = yield* decodeMergeSlotAcquireOutput(output.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new BacklogError({
            operation: "acquireMergeSlot",
            detail:
              output.code === 0 ? "bd returned invalid merge-slot JSON" : outputDetail(output),
            cause,
          }),
      ),
    );
    if (!result.acquired) return Option.none();
    if (output.code !== 0) {
      return yield* new BacklogError({
        operation: "acquireMergeSlot",
        detail: outputDetail(output),
      });
    }
    return Option.some({ holder: result.holder ?? holder });
  });

  const mergeSlot: BacklogShape["mergeSlot"] = ({ repositoryPath, action, holder }) =>
    run({
      operation: `mergeSlot.${action}`,
      cwd: repositoryPath,
      args: ["merge-slot", action, ...(holder === undefined ? [] : ["--holder", holder])],
    });

  return {
    readyChildren,
    showIssue,
    listChildren,
    claim,
    releaseClaim,
    setStatus,
    createChild,
    close,
    comment,
    readNotes,
    writeNotes,
    swarm,
    ensureSwarm,
    acquireMergeSlot,
    mergeSlot,
  };
};

export const make = Effect.fn("ProcessBacklog.make")(function* (input: {
  readonly repositoryPath: string;
}) {
  const processRunner = yield* ProcessRunner;
  return makeProcessBacklog({ ...input, processRunner });
});
