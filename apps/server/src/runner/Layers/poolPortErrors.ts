import { EpicRunnerStoreError } from "@t3tools/epic-core/Errors";
import { RunJournalError } from "@t3tools/epic-core/ports/RunJournal";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

export const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const storeError = (operation: string) => (cause: unknown) =>
  new EpicRunnerStoreError({ operation, cause });

export const journalError = (operation: string) => (cause: unknown) =>
  new RunJournalError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
    ...(cause === undefined ? {} : { cause }),
  });
