// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { RunEventsError, type RunEvent, type RunEventsShape } from "../ports/RunEvents.ts";

export interface FileRunEventsOptions {
  readonly runDirectory: string;
  readonly stdout?: (line: string) => void;
}

const detail = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const summary = (event: RunEvent): string => {
  if (event.type === "run-state-changed") {
    const run = event.run;
    return [
      `# Epic run ${run.epicId}`,
      "",
      `- Status: ${run.status}`,
      `- Iterations: ${String(run.iterationsCompleted)}/${String(run.maxIterations)}`,
      `- Last error: ${run.lastError ?? "none"}`,
      "",
    ].join("\n");
  }
  if (event.type === "iteration-state-changed") {
    const item = event.iteration;
    return `- ${String(item.iterationIndex)} ${item.issueId ?? "-"}: ${item.turnStatus}${item.summary === null ? "" : ` — ${item.summary}`}\n`;
  }
  return `- ${String(event.iterationIndex)}: ${event.type}\n`;
};

export const makeFileRunEvents = (options: FileRunEventsOptions): RunEventsShape => {
  let runSummary = "";
  const iterationSummaries = new Map<number, string>();
  const publish: RunEventsShape["publish"] = (event) =>
    Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(options.runDirectory, { recursive: true });
        const encoded = JSON.stringify(event);
        const now = new Date().toISOString();
        await NodeFSP.appendFile(
          NodePath.join(options.runDirectory, "mailbox.jsonl"),
          `${encoded}\n`,
        );
        await NodeFSP.appendFile(
          NodePath.join(options.runDirectory, "loop.log"),
          `[${now}] ${event.type}\n`,
        );
        if (event.type === "run-state-changed") runSummary = summary(event);
        else if (event.type === "iteration-state-changed") {
          iterationSummaries.set(event.iteration.iterationIndex, summary(event));
        }
        const iterationText = [...iterationSummaries.entries()]
          .toSorted(([left], [right]) => left - right)
          .map(([, line]) => line)
          .join("");
        await NodeFSP.writeFile(
          NodePath.join(options.runDirectory, "summary.md"),
          `${runSummary}${iterationText}`,
        );
        options.stdout?.(encoded);
      },
      catch: (cause) => new RunEventsError({ detail: detail(cause), cause }),
    });
  return { publish };
};
