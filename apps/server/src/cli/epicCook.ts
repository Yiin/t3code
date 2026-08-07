// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalProcess:off preferSchemaOverJson:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { ProviderInstanceId, PositiveInt, EpicRunConfigOverride } from "@t3tools/contracts";
import * as EpicRunPreflight from "@t3tools/epic-core/EpicRunPreflight";
import * as EpicRunConfigSource from "@t3tools/epic-core/EpicRunConfigSource";
import { runSequentialEpicLoop } from "@t3tools/epic-core/SequentialEpicLoop";
import { makeFileRunEvents } from "@t3tools/epic-core/adapters/FileRunEvents";
import * as FileRunJournal from "@t3tools/epic-core/adapters/FileRunJournal";
import * as NodeEpicRunLock from "@t3tools/epic-core/adapters/NodeEpicRunLock";
import { makeProcessBacklog } from "@t3tools/epic-core/adapters/ProcessBacklog";
import { makeProcessGate } from "@t3tools/epic-core/adapters/ProcessGate";
import { makeProcessVcs } from "@t3tools/epic-core/adapters/ProcessVcs";
import {
  makeTerminalAgentDispatch,
  type TerminalHarness,
} from "@t3tools/epic-core/adapters/TerminalAgentDispatch";
import * as ProcessRunner from "@t3tools/epic-core/processRunner";
import { EpicRunLock } from "@t3tools/epic-core/ports/EpicRunLock";
import { resolveEpicRunConfig } from "@t3tools/shared/epicRunConfig";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

class EpicCookCliError extends Schema.TaggedErrorClass<EpicCookCliError>()("EpicCookCliError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const decodeEpicRunConfigOverride = Schema.decodeUnknownEffect(EpicRunConfigOverride);

const optionalString = (name: string, description: string) =>
  Flag.string(name).pipe(Flag.withDescription(description), Flag.optional);

const deprecatedEnvironmentOverride = (
  environment: NodeJS.ProcessEnv,
  harness: TerminalHarness,
): unknown => ({
  ...(environment.COOKEPIC_GATE === undefined && environment.COOKEPIC_NO_GATE === undefined
    ? {}
    : {
        gate: {
          ...(environment.COOKEPIC_GATE === undefined
            ? {}
            : { command: environment.COOKEPIC_GATE }),
          ...(environment.COOKEPIC_NO_GATE === undefined
            ? {}
            : { disabled: environment.COOKEPIC_NO_GATE === "1" }),
        },
      }),
  ...(environment.COOKEPIC_MAX_DISPATCHES === undefined
    ? {}
    : { limits: { maxIterations: Number(environment.COOKEPIC_MAX_DISPATCHES) } }),
  ...(environment.COOKEPIC_MAX_ATTEMPTS === undefined
    ? {}
    : {
        limits: {
          maxAttemptsPerChild: Number(environment.COOKEPIC_MAX_ATTEMPTS),
          ...(environment.COOKEPIC_MAX_DISPATCHES === undefined
            ? {}
            : { maxIterations: Number(environment.COOKEPIC_MAX_DISPATCHES) }),
        },
      }),
  ...(environment.COOKEPIC_WORKER_TIMEOUT === undefined &&
  environment.COOKEPIC_STOP_GRACE === undefined
    ? {}
    : {
        supervision: {
          ...(environment.COOKEPIC_WORKER_TIMEOUT === undefined
            ? {}
            : { workerTimeoutSeconds: Number(environment.COOKEPIC_WORKER_TIMEOUT) }),
          ...(environment.COOKEPIC_STOP_GRACE === undefined
            ? {}
            : { stopGraceSeconds: Number(environment.COOKEPIC_STOP_GRACE) }),
        },
      }),
  ...(environment.COOKEPIC_MODEL === undefined
    ? {}
    : { provider: { modelSelection: { instanceId: harness, model: environment.COOKEPIC_MODEL } } }),
  ...(environment.COOKEPIC_ORIENTATION_FILE === undefined
    ? {}
    : { orientation: { file: environment.COOKEPIC_ORIENTATION_FILE } }),
  ...(environment.COOKEPIC_NO_PUSH === undefined
    ? {}
    : { vcs: { noPush: environment.COOKEPIC_NO_PUSH === "1" } }),
  ...(environment.COOKEPIC_PERMISSION_MODE === undefined
    ? {}
    : {
        runtime: {
          mode:
            environment.COOKEPIC_PERMISSION_MODE === "auto" ||
            environment.COOKEPIC_PERMISSION_MODE === "bypassPermissions"
              ? "full-access"
              : environment.COOKEPIC_PERMISSION_MODE,
        },
      }),
});

const selectHarness = (environment: NodeJS.ProcessEnv): TerminalHarness => {
  if (environment.COOKEPIC_WORKER_CMD) return "worker-cmd";
  const explicit = environment.COOKEPIC_HARNESS;
  if (
    explicit === "kimi" ||
    explicit === "claude" ||
    explicit === "ccx" ||
    explicit === "codex" ||
    explicit === "opencode"
  )
    return explicit;
  if (explicit !== undefined && explicit !== "auto") return "codex";
  if (environment.CLAUDECODE || environment.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (environment.KIMI_SESSION_ID) return "kimi";
  if (environment.OPENCODE_SESSION_ID) return "opencode";
  return "codex";
};

export const cookCommand = Command.make("cook", {
  epic: Flag.string("epic").pipe(Flag.withDescription("Beads epic id.")),
  cwd: Flag.string("cwd").pipe(Flag.withDescription("Repository root.")),
  runDir: optionalString("run-dir", "Artifact directory."),
  gate: optionalString("gate", "Integration gate command."),
  noGate: Flag.boolean("no-gate").pipe(
    Flag.withDescription("Explicitly disable the integration gate."),
    Flag.withDefault(false),
  ),
  maxIterations: Flag.integer("max-iterations").pipe(
    Flag.withSchema(PositiveInt),
    Flag.withDescription("Maximum provider dispatches."),
    Flag.optional,
  ),
  model: optionalString("model", "Harness model id."),
  json: Flag.boolean("json").pipe(
    Flag.withDescription("Emit JSON events and final state."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Cook an epic in this foreground process without a T3 Code server."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const gateFlag = Option.getOrUndefined(flags.gate);
      if (gateFlag !== undefined && flags.noGate) {
        return yield* new EpicCookCliError({
          operation: "epicCook.flags",
          detail: "--gate and --no-gate cannot be used together.",
        });
      }
      const cwd = NodePath.resolve(flags.cwd);
      const harness = selectHarness(process.env);
      const environmentOverride = yield* decodeEpicRunConfigOverride(
        deprecatedEnvironmentOverride(process.env, harness),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new EpicCookCliError({
              operation: "epicCook.environment",
              detail: `Invalid deprecated COOKEPIC_* value: ${String(cause)}`,
              cause,
            }),
        ),
      );
      const flagOverride = yield* decodeEpicRunConfigOverride({
        execution: { sequential: true },
        ...(gateFlag === undefined && !flags.noGate
          ? {}
          : {
              gate: {
                ...(gateFlag === undefined ? {} : { command: gateFlag }),
                ...(gateFlag === undefined ? {} : { disabled: false }),
                ...(flags.noGate ? { disabled: true } : {}),
              },
            }),
        ...(Option.isNone(flags.maxIterations)
          ? {}
          : { limits: { maxIterations: flags.maxIterations.value } }),
        ...(Option.isNone(flags.model)
          ? {}
          : { provider: { modelSelection: { instanceId: harness, model: flags.model.value } } }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new EpicCookCliError({ operation: "epicCook.flags", detail: String(cause), cause }),
        ),
      );

      const dependencies = Layer.mergeAll(
        ProcessRunner.layer,
        NodeEpicRunLock.layer,
        EpicRunConfigSource.layer,
      );
      const localLayer = Layer.merge(
        dependencies,
        EpicRunPreflight.layer.pipe(Layer.provide(dependencies)),
      );
      const result = yield* Effect.gen(function* () {
        const runner = yield* ProcessRunner.ProcessRunner;
        const lock = yield* EpicRunLock;
        const source = yield* EpicRunConfigSource.EpicRunConfigSource;
        const preflight = yield* EpicRunPreflight.EpicRunPreflight;
        const file = yield* source.read({ repoRoot: cwd });
        const resolved = resolveEpicRunConfig({
          file: file._tag === "loaded" ? file.override : null,
          environment: environmentOverride,
          override: flagOverride,
          harness,
        });
        const snapshot = { fileResult: file, ...resolved };
        if (!snapshot.config.gate.disabled && snapshot.config.gate.command === null) {
          return yield* new EpicCookCliError({
            operation: "epicCook.gate",
            detail: "A gate is required. Pass --gate <command> or explicitly pass --no-gate.",
          });
        }
        const modelSelection = snapshot.config.provider.modelSelection ?? {
          instanceId: ProviderInstanceId.make(harness),
          model:
            Option.getOrUndefined(flags.model) ??
            (harness === "claude" || harness === "ccx"
              ? "sonnet"
              : harness === "kimi"
                ? "kimi-code/k3"
                : harness === "codex"
                  ? "gpt-5.6-sol"
                  : "default"),
        };
        const runId = `${flags.epic}-${Date.now().toString(36)}-${String(process.pid)}`;
        const runDirectory = NodePath.resolve(
          Option.getOrUndefined(flags.runDir) ??
            NodePath.join(cwd, ".git", "t3code", "epic-runs", runId),
        );
        const branchResult = yield* runner.run({
          command: "git",
          args: ["branch", "--show-current"],
          cwd,
        });
        if (branchResult.code !== 0 || branchResult.stdout.trim() === "") {
          return yield* new EpicCookCliError({
            operation: "epicCook.branch",
            detail: "Could not resolve the current branch.",
          });
        }
        const journal = yield* FileRunJournal.make({ runDirectory });
        let stop = false;
        const requestStop = () => {
          stop = true;
        };
        process.once("SIGINT", requestStop);
        process.once("SIGTERM", requestStop);
        try {
          return yield* Effect.uninterruptible(
            runSequentialEpicLoop(
              {
                runId,
                epicId: flags.epic,
                cwd,
                runDirectory,
                repository: {
                  repositoryPath: cwd,
                  baseBranch: branchResult.stdout.trim(),
                  worktreeRoot: NodePath.join(runDirectory, "worktrees"),
                  siblings: [],
                },
                selection: modelSelection,
                configSnapshot: snapshot,
                readOrientation: (configured) =>
                  Effect.tryPromise({
                    try: async () => {
                      const candidates =
                        configured === null
                          ? ["docs/agent-orientation.md", "AGENTS.md"]
                          : [configured];
                      for (const candidate of candidates) {
                        try {
                          return await NodeFSP.readFile(NodePath.join(cwd, candidate), "utf8");
                        } catch {}
                      }
                      return "(no orientation card in this repo)";
                    },
                    catch: (cause) =>
                      new EpicCookCliError({
                        operation: "epicCook.orientation",
                        detail: String(cause),
                        cause,
                      }),
                  }),
                shouldStop: () =>
                  Effect.tryPromise({
                    try: async () =>
                      stop ||
                      (await NodeFSP.access(NodePath.join(runDirectory, "STOP")).then(
                        () => true,
                        () => false,
                      )),
                    catch: (cause) =>
                      new EpicCookCliError({
                        operation: "epicCook.stop",
                        detail: String(cause),
                        cause,
                      }),
                  }).pipe(Effect.orElseSucceed(() => stop)),
              },
              {
                preflight,
                lock,
                backlog: makeProcessBacklog({ repositoryPath: cwd, processRunner: runner }),
                journal,
                events: makeFileRunEvents({
                  runDirectory,
                  ...(flags.json ? { stdout: (line) => process.stdout.write(`${line}\n`) } : {}),
                }),
                dispatch: makeTerminalAgentDispatch({
                  harness,
                  artifactsDirectory: runDirectory,
                  ...(process.env.COOKEPIC_BIN === undefined
                    ? {}
                    : { binary: process.env.COOKEPIC_BIN }),
                  ...(process.env.COOKEPIC_WORKER_CMD === undefined
                    ? {}
                    : { workerCommand: process.env.COOKEPIC_WORKER_CMD }),
                  ...(process.env.COOKEPIC_PERMISSION_MODE === undefined
                    ? {}
                    : { permissionMode: process.env.COOKEPIC_PERMISSION_MODE }),
                  useHarnessDefaultModel: snapshot.config.provider.modelSelection === null,
                  timeoutSeconds: snapshot.config.supervision.workerTimeoutSeconds,
                  stopGraceSeconds: snapshot.config.supervision.stopGraceSeconds,
                }),
                gate: makeProcessGate({
                  processRunner: runner,
                  environment: process.env,
                  uid: process.getuid?.() ?? 0,
                }),
                vcs: makeProcessVcs({ processRunner: runner }),
              },
            ),
          );
        } finally {
          process.removeListener("SIGINT", requestStop);
          process.removeListener("SIGTERM", requestStop);
        }
      }).pipe(Effect.provide(localLayer));
      yield* Console.log(
        flags.json
          ? JSON.stringify(result)
          : `${result.runId}\t${result.status}\t${result.iterationsCompleted}/${result.maxIterations}`,
      );
      if (result.status !== "done" && result.status !== "cancelled") {
        return yield* new EpicCookCliError({
          operation: "epicCook",
          detail: result.lastError ?? `Run ended ${result.status}.`,
        });
      }
    }),
  ),
);
