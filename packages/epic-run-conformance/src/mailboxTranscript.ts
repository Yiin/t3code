import { EpicRunTranscriptEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

type MailboxRecord = Readonly<Record<string, unknown>>;

const decodeTranscript = Schema.decodeUnknownSync(Schema.Array(EpicRunTranscriptEvent), {
  onExcessProperty: "error",
});

const record = (value: unknown): MailboxRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("mailbox line must contain one JSON object");
  }
  return value as MailboxRecord;
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const optionalInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const repositories = (value: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const names = value.flatMap((item) => {
    if (typeof item === "string" && item.trim() !== "") return [item];
    if (typeof item !== "object" || item === null) return [];
    const name = optionalString((item as MailboxRecord)["repo"]);
    return name === undefined ? [] : [name];
  });
  return names.length === 0 ? undefined : names;
};

const failureReason = (reason: string | undefined): string | undefined => {
  if (reason === undefined) return undefined;
  if (/timed? out|timeout/iu.test(reason)) return "infra:timeout";
  if (/rate.?limit/iu.test(reason)) return "infra:rate-limited";
  if (/permission/iu.test(reason)) return "infra:turn-error";
  if (/RALPH_BLOCKED|blocked/iu.test(reason)) return "child:blocked";
  if (/no.?commit/iu.test(reason)) return "child:no-commit-child-open";
  return reason.startsWith("infra:") || reason.startsWith("child:") ? reason : `child:${reason}`;
};

const finishedStatus = (item: MailboxRecord): "done" | "failed" | "cancelled" => {
  const reason = optionalString(item["reason"]) ?? "";
  if (/cancel|stopp?ed by/iu.test(reason)) return "cancelled";
  if (item["fatal"] === true || /failed|blocked|error|dirty|detached|not found/iu.test(reason)) {
    return "failed";
  }
  return "done";
};

const terminalTag = (value: string): EpicRunTranscriptEvent["_tag"] => {
  const normalized = value === "lock_held" ? "lock_held" : value.replaceAll("_", "-");
  const known = new Set<EpicRunTranscriptEvent["_tag"]>([
    "blocked",
    "completed-no-code",
    "dispatched",
    "done",
    "finished",
    "folded",
    "inspection-continue",
    "inspection-started",
    "inspection-stop",
    "inspection-stop-pending",
    "inspection-uncertain",
    "lock_held",
    "merged",
    "parked",
    "provider-fallback",
    "rate-limited",
    "researched",
    "retry",
    "worker-cap",
    "worker-idle",
  ]);
  if (!known.has(normalized as EpicRunTranscriptEvent["_tag"])) {
    throw new Error(`unsupported mailbox event: ${value}`);
  }
  return normalized as EpicRunTranscriptEvent["_tag"];
};

export const parseMailboxJsonl = (contents: string): ReadonlyArray<MailboxRecord> => {
  const records: MailboxRecord[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    if (start === -1) {
      if (/\s/u.test(character ?? "")) continue;
      if (character !== "{") {
        throw new Error(`invalid mailbox record ${String(records.length + 1)}`);
      }
      start = index;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          records.push(record(JSON.parse(contents.slice(start, index + 1))));
        } catch (cause) {
          throw new Error(`invalid mailbox record ${String(records.length + 1)}`, { cause });
        }
        start = -1;
      }
    }
  }

  if (start !== -1 || inString) {
    throw new Error(`invalid mailbox record ${String(records.length + 1)}`);
  }
  return records;
};

export const mailboxToTranscript = (input: {
  readonly epicId: string;
  readonly records: ReadonlyArray<unknown>;
}): ReadonlyArray<EpicRunTranscriptEvent> => {
  const latestIteration = new Map<string, number>();
  let nextIteration = 0;
  const events = input.records.map((value, sequence) => {
    const item = record(value);
    const rawEvent = optionalString(item["event"]);
    if (rawEvent === undefined) throw new Error(`mailbox record ${String(sequence)} has no event`);
    const _tag = terminalTag(rawEvent);
    const issueId = optionalString(item["child"]) ?? null;
    if (_tag === "dispatched" && issueId !== null) {
      latestIteration.set(issueId, nextIteration);
      nextIteration += 1;
    }
    let iterationIndex: number | null = null;
    if (issueId !== null) {
      iterationIndex = latestIteration.get(issueId) ?? nextIteration++;
      if (!latestIteration.has(issueId)) latestIteration.set(issueId, iterationIndex);
    }
    const reason = optionalString(item["reason"]);
    const common = {
      _tag,
      sequence,
      epicId: input.epicId,
      issueId,
      iterationIndex,
      pushed: item["pushed"] === true,
      verified: item["verified"] === true,
      ...(optionalString(item["ts"]) === undefined
        ? {}
        : { meta: { timestamp: optionalString(item["ts"]) } }),
    };

    switch (_tag) {
      case "blocked":
        return {
          ...common,
          ...(reason === undefined ? {} : { reason, failureReason: failureReason(reason) }),
          ...(optionalInteger(item["attempts"]) === undefined
            ? {}
            : { attempts: optionalInteger(item["attempts"]) }),
        };
      case "completed-no-code":
      case "researched":
        return {
          ...common,
          ...(optionalInteger(item["comments"]) === undefined
            ? {}
            : { comments: optionalInteger(item["comments"]) }),
        };
      case "dispatched":
      case "done":
        return {
          ...common,
          ...(optionalString(item["branch"]) === undefined
            ? {}
            : { branch: optionalString(item["branch"]) }),
          ...(optionalString(item["summary"]) === undefined
            ? {}
            : { summary: optionalString(item["summary"]) }),
        };
      case "finished":
        return {
          ...common,
          status: finishedStatus(item),
          ...(reason === undefined ? {} : { reason }),
        };
      case "lock_held":
      case "folded":
        return { ...common, ...(reason === undefined ? {} : { reason }) };
      case "merged":
        return {
          ...common,
          ...(optionalString(item["branch"]) === undefined
            ? {}
            : { branch: optionalString(item["branch"]) }),
          ...(repositories(item["repositories"]) === undefined
            ? {}
            : { repositories: repositories(item["repositories"]) }),
        };
      case "parked":
        return {
          ...common,
          ...(reason === undefined ? {} : { reason }),
          ...(optionalString(item["branch"]) === undefined
            ? {}
            : { branch: optionalString(item["branch"]) }),
        };
      case "provider-fallback":
        return {
          ...common,
          ...(optionalString(item["from"]) === undefined
            ? {}
            : { fromProvider: optionalString(item["from"]) }),
          ...(optionalString(item["to"]) === undefined
            ? {}
            : { toProvider: optionalString(item["to"]) }),
          ...(optionalString(item["model"]) === undefined
            ? {}
            : { model: optionalString(item["model"]) }),
        };
      case "rate-limited":
        return { ...common, failureReason: "infra:rate-limited" };
      case "retry":
        return {
          ...common,
          ...(reason === undefined ? {} : { reason, failureReason: failureReason(reason) }),
          ...(optionalInteger(item["attempt"]) === undefined
            ? {}
            : { attempts: optionalInteger(item["attempt"]) }),
          ...(optionalInteger(item["max"]) === undefined
            ? {}
            : { maxAttempts: optionalInteger(item["max"]) }),
        };
      case "worker-cap":
        return {
          ...common,
          ...(optionalInteger(item["workers"]) === undefined
            ? {}
            : { workerLimit: optionalInteger(item["workers"]) }),
        };
      case "worker-idle":
        return {
          ...common,
          ...(optionalInteger(item["idleSeconds"] ?? item["idle_seconds"]) === undefined
            ? {}
            : { idleSeconds: optionalInteger(item["idleSeconds"] ?? item["idle_seconds"]) }),
          ...(optionalInteger(item["elapsedSeconds"] ?? item["elapsed_seconds"]) === undefined
            ? {}
            : {
                elapsedSeconds: optionalInteger(item["elapsedSeconds"] ?? item["elapsed_seconds"]),
              }),
        };
      case "inspection-started":
        return {
          ...common,
          ...(optionalInteger(item["timeoutSeconds"] ?? item["timeout_seconds"]) === undefined
            ? {}
            : {
                timeoutSeconds: optionalInteger(item["timeoutSeconds"] ?? item["timeout_seconds"]),
              }),
        };
      case "inspection-continue":
      case "inspection-stop":
      case "inspection-stop-pending":
      case "inspection-uncertain":
        return {
          ...common,
          ...(reason === undefined ? {} : { reason }),
          ...(optionalString(item["rationale"]) === undefined
            ? {}
            : { rationale: optionalString(item["rationale"]) }),
          ...(optionalInteger(item["nextCheckSeconds"] ?? item["next_check_seconds"]) === undefined
            ? {}
            : {
                nextCheckSeconds: optionalInteger(
                  item["nextCheckSeconds"] ?? item["next_check_seconds"],
                ),
              }),
        };
      default:
        return common;
    }
  });
  return decodeTranscript(events);
};
