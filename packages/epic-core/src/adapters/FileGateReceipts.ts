/**
 * Gate receipts as one append-only JSONL file per run directory.
 *
 * The terminal counterpart to the server's table. Append-only on purpose: a
 * receipt is evidence, and evidence that a later write can rewrite is not
 * evidence. `sequence` is the line's position, so a restart reads back
 * exactly what earlier lifetimes wrote, in the order they wrote it.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { GateError } from "../ports/Gate.ts";
import { PersistedGateReceipt, type GateReceiptJournalShape } from "../ports/GateReceipts.ts";

export interface FileGateReceiptsOptions {
  /** The exact run directory. `gate-receipts.jsonl` is written directly below it. */
  readonly runDirectory: string;
}

const FILE_NAME = "gate-receipts.jsonl";

const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(PersistedGateReceipt));
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedGateReceipt));

const errorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const gateError = (operation: string) => (cause: unknown) =>
  new GateError({ operation, detail: errorDetail(cause), cause });

export const make = Effect.fn("FileGateReceipts.make")(function* (
  options: FileGateReceiptsOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(options.runDirectory, FILE_NAME);

  const readLines = Effect.fn("FileGateReceipts.readLines")(function* () {
    const exists = yield* fileSystem
      .exists(filePath)
      .pipe(Effect.mapError(gateError("gateReceipts.exists")));
    if (!exists) return [];
    const contents = yield* fileSystem
      .readFileString(filePath)
      .pipe(Effect.mapError(gateError("gateReceipts.read")));
    return contents.split("\n").filter((line) => line.trim().length > 0);
  });

  const journal: GateReceiptJournalShape = {
    record: Effect.fn("FileGateReceipts.record")(function* (receipt) {
      yield* fileSystem
        .makeDirectory(options.runDirectory, { recursive: true })
        .pipe(Effect.mapError(gateError("gateReceipts.makeDirectory")));
      // The store owns the sequence, so a caller cannot renumber history.
      const lines = yield* readLines();
      const line = yield* encodeReceipt({ ...receipt, sequence: lines.length }).pipe(
        Effect.mapError(gateError("gateReceipts.encode")),
      );
      yield* fileSystem
        .writeFileString(filePath, `${line}\n`, { flag: "a" })
        .pipe(Effect.mapError(gateError("gateReceipts.append")));
    }),
    list: Effect.fn("FileGateReceipts.list")(function* (runId) {
      const lines = yield* readLines();
      const receipts: Array<PersistedGateReceipt> = [];
      for (const line of lines) {
        const decoded = yield* decodeReceipt(line).pipe(
          Effect.mapError(gateError("gateReceipts.decode")),
        );
        if (decoded.runId === runId) receipts.push(decoded);
      }
      return receipts;
    }),
  };
  return journal;
});
