import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// Blacksmith runners come from the upstream org's installation. A fork has none, so a job pinned
// to a bare `blacksmith-*` label queues there forever. Every such job must read a repo variable
// first and fall back to the original label, which keeps the workflows a no-op upstream.
// See docs/operations/ci.md.

const RUNNER_LINE = /^\s*(?:runs-on|runner):\s*(.+?)\s*(?:#.*)?$/;
const OVERRIDDEN = /^\$\{\{ vars\.CI_RUNNER_(LINUX|MACOS|WINDOWS) \|\| '([^']+)' \}\}$/;

const OS_FOR_VARIABLE = {
  LINUX: "ubuntu",
  MACOS: "macos",
  WINDOWS: "windows",
} as const;

const workflowRunners = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* path.fromFileUrl(new URL("../.github/workflows", import.meta.url));
  const names = (yield* fileSystem.readDirectory(directory)).filter((name) =>
    name.endsWith(".yml"),
  );

  const runners: Array<{ readonly file: string; readonly line: number; readonly value: string }> =
    [];
  for (const name of names.toSorted()) {
    const contents = yield* fileSystem.readFileString(path.join(directory, name));
    contents.split("\n").forEach((text, index) => {
      const match = RUNNER_LINE.exec(text);
      if (match?.[1] !== undefined) {
        runners.push({ file: name, line: index + 1, value: match[1] });
      }
    });
  }
  return runners;
}).pipe(Effect.provide(NodeServices.layer));

describe("workflow runner labels", () => {
  it.effect("routes every blacksmith runner through a CI_RUNNER_* override", () =>
    Effect.gen(function* () {
      const runners = yield* workflowRunners;

      // Guards against the whole scan silently matching nothing. The floor is
      // deliberately well under the real count: workflows get deleted (the
      // mobile and contributor-hygiene ones were, on 2026-08-12) and a floor
      // pinned just below the current total fails on every such removal
      // without catching a single real regression.
      expect(runners.length).toBeGreaterThan(10);

      const pinned = runners
        .filter((runner) => runner.value.includes("blacksmith-"))
        .filter((runner) => !OVERRIDDEN.test(runner.value))
        .map((runner) => `${runner.file}:${runner.line} ${runner.value}`);

      expect(pinned).toEqual([]);
    }),
  );

  it.effect("pairs each override variable with a fallback label for the same OS", () =>
    Effect.gen(function* () {
      const runners = yield* workflowRunners;

      const mismatched = runners
        .flatMap((runner) => {
          const match = OVERRIDDEN.exec(runner.value);
          if (match?.[1] === undefined || match[2] === undefined) return [];
          const expectedOs = OS_FOR_VARIABLE[match[1] as keyof typeof OS_FOR_VARIABLE];
          return match[2].includes(expectedOs)
            ? []
            : [`${runner.file}:${runner.line} ${runner.value} is not a ${expectedOs} label`];
        })
        .toSorted();

      expect(mismatched).toEqual([]);
    }),
  );
});
