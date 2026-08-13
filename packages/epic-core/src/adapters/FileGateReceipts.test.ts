import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { gateCommandDigest } from "../ports/Gate.ts";
import { persistedGateReceipt } from "../ports/GateReceipts.ts";
import { make } from "./FileGateReceipts.ts";

const receipt = (outcome: "passed" | "failed" | "error") =>
  persistedGateReceipt({
    runId: "run-1",
    phase: "entry",
    childId: "child-1",
    branch: "epic/child-1",
    receipt: {
      commandDigest: gateCommandDigest("vp check"),
      cwd: "/integration",
      outcome,
      exitCode: outcome === "passed" ? 0 : outcome === "failed" ? 1 : null,
      queuedAt: "2026-08-13T00:00:00.000Z",
      acquiredAt: "2026-08-13T00:00:02.000Z",
      finishedAt: "2026-08-13T00:00:07.000Z",
      lockWaitMs: 2_000,
      executionMs: 5_000,
      inputHeads: [{ repositoryPath: "/repo", head: "head-1" }],
      output: "gate said something",
    },
  });

describe("FileGateReceipts", () => {
  /**
   * A restart must be able to read what every earlier lifetime of the run
   * verified, so the second adapter over the same directory is the test.
   */
  it.effect("keeps every receipt a run wrote, across process lifetimes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const runDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "epic-gate-receipts-test-",
        });

        const first = yield* make({ runDirectory });
        yield* first.record(receipt("failed"));
        yield* first.record(receipt("error"));

        const second = yield* make({ runDirectory });
        yield* second.record(receipt("passed"));

        const all = yield* second.list("run-1");
        // The store owns the sequence, so a caller cannot renumber history.
        assert.deepStrictEqual(
          all.map((entry) => [entry.sequence, entry.outcome]),
          [
            [0, "failed"],
            [1, "error"],
            [2, "passed"],
          ],
        );
        assert.deepStrictEqual(all[2]?.inputHeads, [{ repositoryPath: "/repo", head: "head-1" }]);
        assert.strictEqual(all[2]?.commandDigest, gateCommandDigest("vp check"));
        assert.strictEqual(all[1]?.exitCode, null);
        assert.deepStrictEqual(yield* second.list("run-other"), []);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
