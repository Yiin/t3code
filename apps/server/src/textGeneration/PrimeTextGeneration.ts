import { TextGenerationError, type ModelSelection, type PrimeSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { findReservedPrimeLaunchArg } from "../provider/prime/PrimeLaunchArgs.ts";
import {
  makePrimeRpcTransport,
  type PrimeRpcThinkingLevel,
  type PrimeRpcTransportError,
  type PrimeRpcTransportOptions,
  type PrimeRpcTransportShape,
} from "../provider/prime/PrimeRpcTransport.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  toCommitMessageResult,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);
type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export interface PrimeTextGenerationOptions {
  readonly timeoutMs?: number;
  readonly makeTransport?: (
    options: PrimeRpcTransportOptions,
  ) => Effect.Effect<
    PrimeRpcTransportShape,
    PrimeRpcTransportError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >;
}

function splitModel(model: string): { provider?: string; modelId: string } {
  const slash = model.indexOf("/");
  return slash > 0
    ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }
    : { modelId: model };
}

function isThinkingLevel(value: string | undefined): value is PrimeRpcThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value ?? "");
}

function eventError(event: Record<string, unknown>): string | undefined {
  if (event.type !== "message_update") return undefined;
  const update = event.assistantMessageEvent;
  if (!update || typeof update !== "object" || Array.isArray(update)) return undefined;
  const record = update as Record<string, unknown>;
  if (record.type !== "error" && record.type !== "abort" && record.type !== "aborted") {
    return undefined;
  }
  return typeof record.reason === "string" && record.reason.trim()
    ? `Prime Agent stopped: ${record.reason.trim()}`
    : "Prime Agent stopped before producing output.";
}

export const makePrimeTextGeneration = Effect.fn("makePrimeTextGeneration")(function* (
  settings: PrimeSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options: PrimeTextGenerationOptions = {},
) {
  yield* Effect.void;
  const runJson = <S extends Schema.Top>(input: {
    operation: Operation;
    cwd: string;
    prompt: string;
    outputSchema: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.scoped(
      Effect.gen(function* () {
        const reserved = findReservedPrimeLaunchArg(settings.launchArgs);
        if (reserved) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: `Prime launch argument '${reserved}' is controlled by T3 Code.`,
          });
        }
        const selected = splitModel(input.modelSelection.model);
        if (!selected.provider || selected.modelId.trim().length === 0) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Prime text generation requires a provider-qualified model.",
          });
        }
        const thinking = getModelSelectionStringOptionValue(input.modelSelection, "thinking");
        if (thinking !== undefined && !isThinkingLevel(thinking)) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: `Unsupported Prime thinking level '${thinking}'.`,
          });
        }
        const transportFactory: NonNullable<PrimeTextGenerationOptions["makeTransport"]> =
          options.makeTransport ?? makePrimeRpcTransport;
        const transport = yield* transportFactory({
          binaryPath: settings.binaryPath,
          cwd: input.cwd,
          environment,
          launchArgs: [...settings.launchArgs, "--no-session"],
        }).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Failed to start Prime Agent for text generation.",
                cause,
              }),
          ),
        );
        const output = yield* Ref.make("");
        const settled = yield* Ref.make(false);
        yield* transport.setModel({ provider: selected.provider, modelId: selected.modelId });
        if (thinking) yield* transport.setThinkingLevel(thinking);
        yield* transport.prompt({ message: input.prompt });
        yield* transport.events.pipe(
          Stream.takeUntilEffect((event) =>
            Effect.succeed((event as Record<string, unknown>).type === "agent_settled"),
          ),
          Stream.runForEach((event) => {
            const record = event as Record<string, unknown>;
            if (record.type === "agent_settled") {
              return Ref.set(settled, true);
            }
            const error = eventError(record);
            if (error) {
              return Effect.fail(
                new TextGenerationError({ operation: input.operation, detail: error }),
              );
            }
            if (record.type !== "message_update") return Effect.void;
            const update = record.assistantMessageEvent;
            if (!update || typeof update !== "object" || Array.isArray(update)) {
              return Effect.void;
            }
            const assistant = update as Record<string, unknown>;
            return assistant.type === "text_delta" && typeof assistant.delta === "string"
              ? Ref.update(output, (current) => current + assistant.delta)
              : Effect.void;
          }),
        );
        if (!(yield* Ref.get(settled))) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Prime Agent event stream ended before completion.",
          });
        }
        const raw = (yield* Ref.get(output)).trim();
        if (!raw) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Prime Agent returned empty output.",
          });
        }
        // eslint-disable-next-line t3code/no-inline-schema-compile -- Each operation supplies its own output schema.
        return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
          extractJsonObject(raw),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Prime Agent returned invalid structured output.",
                cause,
              }),
          ),
        );
      }).pipe(
        Effect.timeoutOption(Duration.millis(options.timeoutMs ?? TIMEOUT_MS)),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: input.operation,
                  detail: "Prime Agent text generation timed out.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "Prime Agent text generation failed.",
                cause,
              }),
        ),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PrimeTextGeneration.generateCommitMessage")(function* (input) {
      const built = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });
      const generated = yield* runJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt: built.prompt,
        outputSchema: built.outputSchema,
        modelSelection: input.modelSelection,
      });
      return toCommitMessageResult(generated);
    });
  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PrimeTextGeneration.generatePrContent")(function* (input) {
      const built = buildPrContentPrompt(input);
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt: built.prompt,
        outputSchema: built.outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });
  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PrimeTextGeneration.generateBranchName")(function* (input) {
      const built = buildBranchNamePrompt(input);
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt: built.prompt,
        outputSchema: built.outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });
  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PrimeTextGeneration.generateThreadTitle")(function* (input) {
      const built = buildThreadTitlePrompt(input);
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt: built.prompt,
        outputSchema: built.outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return TextGeneration.TextGeneration.of({
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  });
});
