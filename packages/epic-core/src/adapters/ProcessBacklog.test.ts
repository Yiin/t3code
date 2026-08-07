import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import { makeProcessBacklog } from "./ProcessBacklog.ts";

const success = (stdout = ""): ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: 0 as ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const failure = (stderr: string): ProcessRunOutput => ({
  ...success(),
  stderr,
  code: 1 as ProcessRunOutput["code"],
});

describe("ProcessBacklog", () => {
  it.effect("uses the bd command contract and decodes omitted parent fields", () =>
    Effect.gen(function* () {
      const calls: ProcessRunInput[] = [];
      const processRunner = ProcessRunner.of({
        run: (command) =>
          Effect.sync(() => {
            calls.push(command);
            if (command.args[0] === "ready") {
              return success(
                '[{"id":"epic.1","title":"First","status":"open","priority":1,"issue_type":"task","comment_count":4}]',
              );
            }
            if (command.args[0] === "list") return success("[]");
            if (command.args[0] === "show") {
              return success('{"id":"epic.1","title":"First","status":"open","notes":"one\\ntwo"}');
            }
            if (command.args[0] === "create") {
              return success('{"id":"epic.2","title":"Merge fix","status":"open"}');
            }
            if (command.args[0] === "merge-slot" && command.args[1] === "acquire") {
              return success('{"acquired":true,"holder":"worker-1"}');
            }
            return success("ok");
          }),
      });
      const backlog = makeProcessBacklog({ repositoryPath: "/repo", processRunner });

      expect(yield* backlog.readyChildren("epic", 20)).toEqual([
        {
          id: "epic.1",
          title: "First",
          status: "open",
          priority: 1,
          issueType: "task",
          parentId: null,
          description: "",
          labels: [],
          commentCount: 4,
        },
      ]);
      yield* backlog.showIssue("epic.1");
      yield* backlog.listChildren("epic");
      yield* backlog.claim("epic.1", "worker-1");
      yield* backlog.setStatus("epic.1", "blocked");
      expect(
        yield* backlog.createChild({
          epicId: "epic",
          title: "Merge fix",
          description: "Resolve the conflict.",
          priority: 1,
          discoveredFrom: "epic.1",
        }),
      ).toMatchObject({ id: "epic.2", title: "Merge fix" });
      yield* backlog.close({ issueId: "epic.1", reason: "complete" });
      yield* backlog.comment({ issueId: "epic.1", body: "finding" });
      expect(yield* backlog.readNotes("epic.1")).toBe("one\ntwo");
      yield* backlog.writeNotes({ issueId: "epic", note: "progress" });
      yield* backlog.swarm({ epicId: "epic", action: "create" });
      yield* backlog.ensureSwarm("epic");
      expect(yield* backlog.acquireMergeSlot("worker-1")).toMatchObject({ _tag: "Some" });
      yield* backlog.mergeSlot({
        repositoryPath: "/other",
        action: "release",
        holder: "worker-1",
      });

      expect(calls.map(({ command, args, cwd }) => ({ command, args, cwd }))).toEqual([
        {
          command: "bd",
          args: ["ready", "--parent", "epic", "--json", "--limit", "20"],
          cwd: "/repo",
        },
        { command: "bd", args: ["show", "epic.1", "--json"], cwd: "/repo" },
        {
          command: "bd",
          args: ["list", "--parent", "epic", "--all", "--flat", "--json"],
          cwd: "/repo",
        },
        {
          command: "bd",
          args: ["update", "epic.1", "--claim", "--actor", "worker-1"],
          cwd: "/repo",
        },
        {
          command: "bd",
          args: ["update", "epic.1", "--status", "blocked"],
          cwd: "/repo",
        },
        {
          command: "bd",
          args: [
            "create",
            "Merge fix",
            "--type",
            "task",
            "--parent",
            "epic",
            "-p",
            "1",
            "-d",
            "Resolve the conflict.",
            "--deps",
            "discovered-from:epic.1",
            "--json",
          ],
          cwd: "/repo",
        },
        {
          command: "bd",
          args: ["close", "epic.1", "--reason", "complete"],
          cwd: "/repo",
        },
        { command: "bd", args: ["comment", "epic.1", "finding"], cwd: "/repo" },
        { command: "bd", args: ["show", "epic.1", "--json"], cwd: "/repo" },
        { command: "bd", args: ["note", "epic", "progress"], cwd: "/repo" },
        { command: "bd", args: ["swarm", "create", "epic"], cwd: "/repo" },
        { command: "bd", args: ["swarm", "create", "epic"], cwd: "/repo" },
        {
          command: "bd",
          args: ["merge-slot", "acquire", "--holder", "worker-1", "--json"],
          cwd: "/repo",
        },
        {
          command: "bd",
          args: ["merge-slot", "release", "--holder", "worker-1"],
          cwd: "/other",
        },
      ]);
    }),
  );

  it.effect("treats an existing swarm as ensured but preserves other failures", () =>
    Effect.gen(function* () {
      let response = failure("Swarm already exists: epic");
      const processRunner = ProcessRunner.of({ run: () => Effect.succeed(response) });
      const backlog = makeProcessBacklog({ repositoryPath: "/repo", processRunner });

      yield* backlog.ensureSwarm("epic");

      response = failure("database unavailable");
      const error = yield* backlog.ensureSwarm("epic").pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "BacklogError", operation: "ensureSwarm" });
    }),
  );

  it.effect("distinguishes a held merge slot from command failure", () =>
    Effect.gen(function* () {
      let response = {
        ...success('{"acquired":false,"holder":"worker-2"}'),
        code: 1 as ProcessRunOutput["code"],
      };
      const processRunner = ProcessRunner.of({ run: () => Effect.succeed(response) });
      const backlog = makeProcessBacklog({ repositoryPath: "/repo", processRunner });

      expect(yield* backlog.acquireMergeSlot("worker-1")).toMatchObject({ _tag: "None" });

      response = failure("database unavailable");
      const error = yield* backlog.acquireMergeSlot("worker-1").pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "BacklogError", operation: "acquireMergeSlot" });
    }),
  );
});
