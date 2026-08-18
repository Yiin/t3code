/**
 * ProviderAuthManager owns short-lived provider login PTYs.
 *
 * These PTYs are separate from TerminalManager. Provider authentication has
 * no thread id, terminal history, global terminal events, terminal metadata,
 * or process discovery. A dedicated scope avoids inventing a fake thread and
 * keeps credential-bearing output in memory only.
 */
import * as NodeOS from "node:os";

import {
  ClaudeSettings,
  CodexSettings,
  KimiSettings,
  OpenCodeSettings,
  ProviderAuthError,
  type ProviderAuthLoginCancelInput,
  type ProviderAuthLoginCancelResult,
  type ProviderAuthLoginRespondInput,
  type ProviderAuthLoginRespondResult,
  type ProviderAuthLoginStartInput,
  type ProviderAuthLoginStartResult,
  type ProviderAuthLogoutInput,
  type ProviderAuthLogoutResult,
  type ProviderAuthRunState,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeClaudeEnvironment, resolveClaudeHomeLayout } from "./Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import { makeKimiEnvironment, resolveKimiHomeLayout } from "./Drivers/KimiHome.ts";
import { managedAccountHomePath } from "./Drivers/managedAccountHome.ts";
import {
  makeOpenCodeEnvironment,
  openCodeAuthFilePath,
  resolveOpenCodeHomeLayout,
  resolveOpenCodeDataHome,
} from "./Drivers/OpenCodeHome.ts";
import { deriveProviderInstanceConfigMap } from "./Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { makeProviderMaintenanceCommandCoordinator } from "./providerMaintenanceCommandCoordinator.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";

const LOGIN_IDLE_TIMEOUT = Duration.minutes(10);
const OUTPUT_MAX_BYTES = 10_000;
const RECENT_RUN_LIMIT = 20;
const PTY_COLS = 100;
const PTY_ROWS = 30;
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeKimiSettings = Schema.decodeUnknownEffect(KimiSettings);
const decodeOpenCodeSettings = Schema.decodeUnknownEffect(OpenCodeSettings);

type SupportedDriver = "claudeAgent" | "codex" | "kimi" | "opencode";

interface ResolvedAuthTarget {
  readonly instanceId: ProviderInstanceId;
  readonly driver: SupportedDriver;
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly homePath: string;
  readonly sharedHomePath?: string;
  readonly authFilePath: string;
}

type LoginEvent =
  | { readonly type: "data"; readonly data: string }
  | { readonly type: "exit"; readonly exitCode: number }
  | { readonly type: "cancel" };

interface ActiveRun {
  readonly instanceId: ProviderInstanceId;
  readonly state: SubscriptionRef.SubscriptionRef<ProviderAuthRunState>;
  readonly events: Queue.Queue<LoginEvent>;
  readonly process: Ref.Ref<PtyAdapter.PtyProcess | null>;
}

export interface ProviderAuthManagerShape {
  readonly loginStart: (
    input: ProviderAuthLoginStartInput,
  ) => Effect.Effect<ProviderAuthLoginStartResult, ProviderAuthError>;
  readonly loginCancel: (
    input: ProviderAuthLoginCancelInput,
  ) => Effect.Effect<ProviderAuthLoginCancelResult, ProviderAuthError>;
  readonly loginRespond: (
    input: ProviderAuthLoginRespondInput,
  ) => Effect.Effect<ProviderAuthLoginRespondResult, ProviderAuthError>;
  readonly loginStatus: (
    terminalId: string,
  ) => Stream.Stream<ProviderAuthRunState, ProviderAuthError>;
  readonly logout: (
    input: ProviderAuthLogoutInput,
  ) => Effect.Effect<ProviderAuthLogoutResult, ProviderAuthError>;
}

export class ProviderAuthManager extends Context.Service<
  ProviderAuthManager,
  ProviderAuthManagerShape
>()("t3/provider/ProviderAuthManager") {}

function authError(message: string): ProviderAuthError {
  return new ProviderAuthError({ message });
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

function idleState(): ProviderAuthRunState {
  return {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    message: null,
    output: "",
    verificationUrl: null,
    userCode: null,
  };
}

function trimOutputTail(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= OUTPUT_MAX_BYTES) return value;

  let offset = bytes.byteLength - OUTPUT_MAX_BYTES;
  while (offset < bytes.byteLength && (bytes[offset]! & 0xc0) === 0x80) offset += 1;
  let output = bytes.subarray(offset).toString("utf8");
  while (Buffer.byteLength(output, "utf8") > OUTPUT_MAX_BYTES) output = output.slice(1);
  return output;
}

function stripAnsiForParsing(output: string): string {
  const escape = String.fromCharCode(27);
  // OSC sequences first (e.g. the OSC 8 hyperlink wrapper ESC]8;;URL ESC\ or
  // BEL): they carry a URL payload that would otherwise duplicate the visible
  // link text in the parsed output.
  // oxlint-disable-next-line no-control-regex
  const withoutOsc = output.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/gu, "");
  return withoutOsc
    .split(escape)
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-?]*[ -/]*[@-~]/u, "")))
    .join("");
}

function extractVerificationUrl(output: string): string | null {
  const matches = stripAnsiForParsing(output).match(/https:\/\/[^\s]+/giu);
  const match = matches?.at(-1);
  return match?.replace(/[),.;:'"]+$/u, "").slice(0, 2_048) ?? null;
}

function extractUserCode(output: string): string | null {
  output = stripAnsiForParsing(output);
  const matches = [
    ...output.matchAll(/\bcode\b(?:\s*(?:is|:|=))?\s*([a-z0-9][a-z0-9-]{3,19})/giu),
    ...output.matchAll(/\benter\b(?:\s+the)?(?:\s+code)?\s*[:=]?\s*([a-z0-9][a-z0-9-]{3,19})/giu),
  ];
  const candidate = matches.at(-1)?.[1] ?? null;
  if (
    !candidate ||
    /^(?:code|enter|this|that|your|here|there|below|above|now|again|it)$/iu.test(candidate)
  ) {
    return null;
  }
  // A device code contains a digit, a dash, or uppercase letters. A bare
  // lowercase word is prose — e.g. "Paste code here if prompted" — not a code.
  if (!/[A-Z0-9-]/u.test(candidate)) return null;
  return candidate;
}

function isNotFound(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "NotFound";
}

const removeIfPresent = Effect.fn("ProviderAuthManager.removeIfPresent")(function* (
  fileSystem: FileSystem.FileSystem,
  target: string,
) {
  yield* fileSystem.remove(target, { force: true }).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        isNotFound(error)
          ? Effect.void
          : Effect.fail(authError("Could not remove the account credential file.")),
    }),
  );
});

const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

function assertSupportedDriver(
  driver: ProviderDriverKind,
): Effect.Effect<SupportedDriver, ProviderAuthError> {
  switch (driver) {
    case "claudeAgent":
      return Effect.succeed("claudeAgent");
    case "codex":
      return Effect.succeed("codex");
    case "kimi":
      return Effect.succeed("kimi");
    case "opencode":
      return Effect.succeed("opencode");
    default:
      return Effect.fail(authError("This provider does not support account authentication."));
  }
}

const make = Effect.fn("ProviderAuthManager.make")(function* () {
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;
  const managerScope = yield* Scope.Scope;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runsRef = yield* Ref.make<ReadonlyMap<string, ActiveRun>>(new Map());
  const completedRunIdsRef = yield* Ref.make<ReadonlyArray<string>>([]);
  const activeProcessesRef = yield* Ref.make<ReadonlySet<PtyAdapter.PtyProcess>>(new Set());
  const terminalSequenceRef = yield* Ref.make(0);
  const killedProcesses = new WeakSet<PtyAdapter.PtyProcess>();
  const commandCoordinator = yield* makeProviderMaintenanceCommandCoordinator({
    makeAlreadyRunningError: () => authError("Authentication is already running for this account."),
  });

  const refresh = (instanceId: ProviderInstanceId) => providerRegistry.refreshInstance(instanceId);

  const safeKill = (process: PtyAdapter.PtyProcess) =>
    Effect.sync(() => {
      if (killedProcesses.has(process)) return true;
      try {
        process.kill();
        killedProcesses.add(process);
        return true;
      } catch {
        // Keep the process active so a later cleanup can try again.
        return false;
      }
    });

  const addActiveProcess = (process: PtyAdapter.PtyProcess) =>
    Ref.update(activeProcessesRef, (active) => new Set(active).add(process));

  const removeActiveProcess = (process: PtyAdapter.PtyProcess) =>
    Ref.update(activeProcessesRef, (active) => {
      const next = new Set(active);
      next.delete(process);
      return next;
    });

  const killAndReleaseProcess = (process: PtyAdapter.PtyProcess) =>
    safeKill(process).pipe(
      Effect.flatMap((killed) => (killed ? removeActiveProcess(process) : Effect.void)),
    );

  const cleanupActiveProcess = (process: PtyAdapter.PtyProcess) =>
    Ref.get(activeProcessesRef).pipe(
      Effect.flatMap((active) =>
        active.has(process) ? killAndReleaseProcess(process) : Effect.void,
      ),
    );

  const retainCompletedRun = (terminalId: string) =>
    Ref.modify(completedRunIdsRef, (completed) => {
      const next = [...completed, terminalId];
      return [next.slice(0, -RECENT_RUN_LIMIT), next.slice(-RECENT_RUN_LIMIT)] as const;
    }).pipe(
      Effect.flatMap((evicted) =>
        Ref.update(runsRef, (runs) => {
          const next = new Map(runs);
          for (const id of evicted) next.delete(id);
          return next;
        }),
      ),
    );

  const resolveTarget = Effect.fn("ProviderAuthManager.resolveTarget")(function* (
    instanceId: ProviderInstanceId,
  ): Effect.fn.Return<ResolvedAuthTarget, ProviderAuthError> {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => authError("Could not read the provider account configuration.")),
    );
    const envelope = deriveProviderInstanceConfigMap(settings)[instanceId];
    if (!envelope) {
      return yield* authError("The provider account does not exist.");
    }
    const driver = yield* assertSupportedDriver(envelope.driver);
    const instanceEnvironment = mergeProviderInstanceEnvironment(envelope.environment);

    switch (driver) {
      case "claudeAgent": {
        const driverConfig = yield* decodeClaudeSettings(envelope.config ?? {}).pipe(
          Effect.mapError(() => authError("The provider account configuration is invalid.")),
        );
        const layout = yield* resolveClaudeHomeLayout(driverConfig).pipe(
          Effect.provideService(Path.Path, path),
        );
        const environment = yield* makeClaudeEnvironment(
          { homePath: layout.effectiveHomePath ?? driverConfig.homePath },
          instanceEnvironment,
        ).pipe(Effect.provideService(Path.Path, path));
        const homePath = path.resolve(
          environment.CLAUDE_CONFIG_DIR?.trim() || path.join(NodeOS.homedir(), ".claude"),
        );
        return {
          instanceId,
          driver,
          binaryPath: driverConfig.binaryPath,
          environment,
          homePath,
          authFilePath: path.join(homePath, ".credentials.json"),
        };
      }
      case "codex": {
        const driverConfig = yield* decodeCodexSettings(envelope.config ?? {}).pipe(
          Effect.mapError(() => authError("The provider account configuration is invalid.")),
        );
        const layout = yield* resolveCodexHomeLayout(driverConfig).pipe(
          Effect.provideService(Path.Path, path),
        );
        const configuredHome = layout.effectiveHomePath;
        const environment = {
          ...instanceEnvironment,
          ...(configuredHome ? { CODEX_HOME: configuredHome } : {}),
        };
        const homePath = path.resolve(
          environment.CODEX_HOME?.trim() || path.join(NodeOS.homedir(), ".codex"),
        );
        return {
          instanceId,
          driver,
          binaryPath: driverConfig.binaryPath,
          environment,
          homePath,
          authFilePath: path.join(homePath, "auth.json"),
        };
      }
      case "kimi": {
        const driverConfig = yield* decodeKimiSettings(envelope.config ?? {}).pipe(
          Effect.mapError(() => authError("The provider account configuration is invalid.")),
        );
        const layout = yield* resolveKimiHomeLayout(driverConfig).pipe(
          Effect.provideService(Path.Path, path),
        );
        const environment = yield* makeKimiEnvironment(driverConfig, instanceEnvironment).pipe(
          Effect.provideService(Path.Path, path),
        );
        const homePath = layout.effectiveHomePath ?? layout.sharedHomePath;
        return {
          instanceId,
          driver,
          binaryPath: driverConfig.binaryPath,
          environment,
          homePath,
          ...(layout.mode === "authOverlay" ? { sharedHomePath: layout.sharedHomePath } : {}),
          authFilePath: path.join(homePath, "credentials", "kimi-code.json"),
        };
      }
      case "opencode": {
        const driverConfig = yield* decodeOpenCodeSettings(envelope.config ?? {}).pipe(
          Effect.mapError(() => authError("The provider account configuration is invalid.")),
        );
        const environment = yield* makeOpenCodeEnvironment(driverConfig, instanceEnvironment).pipe(
          Effect.provideService(Path.Path, path),
        );
        const homePath = yield* resolveOpenCodeDataHome(driverConfig, environment).pipe(
          Effect.provideService(Path.Path, path),
        );
        const openCodeLayout = yield* resolveOpenCodeHomeLayout(driverConfig, environment).pipe(
          Effect.provideService(Path.Path, path),
        );
        return {
          instanceId,
          driver,
          binaryPath: driverConfig.binaryPath,
          environment,
          homePath,
          authFilePath: yield* openCodeAuthFilePath(driverConfig, environment).pipe(
            Effect.provideService(Path.Path, path),
          ),
          ...(openCodeLayout.mode === "authOverlay"
            ? { sharedHomePath: openCodeLayout.sharedDataHomePath }
            : {}),
        };
      }
    }
  });

  const loginArgs = (
    target: ResolvedAuthTarget,
    input: ProviderAuthLoginStartInput,
  ): ReadonlyArray<string> => {
    switch (target.driver) {
      case "claudeAgent":
        return ["auth", "login"];
      case "codex":
        return ["login", "--device-auth"];
      case "kimi":
        return ["login"];
      case "opencode":
        return [
          "auth",
          "login",
          ...(input.provider ? ["--provider", input.provider] : []),
          ...(input.method ? ["--method", input.method] : []),
        ];
    }
  };

  const updateOutput = (run: ActiveRun, data: string) =>
    SubscriptionRef.update(run.state, (state) => {
      if (state.status !== "running") return state;
      const combinedOutput = state.output + data;
      const output = trimOutputTail(combinedOutput);
      return {
        ...state,
        output,
        verificationUrl: extractVerificationUrl(combinedOutput) ?? state.verificationUrl,
        userCode: extractUserCode(combinedOutput) ?? state.userCode,
      };
    });

  const drainLoginEvents = Effect.fn("ProviderAuthManager.drainLoginEvents")(function* loop(
    run: ActiveRun,
  ): Effect.fn.Return<Exclude<LoginEvent, { readonly type: "data" }> | { type: "timeout" }> {
    const event = yield* Queue.take(run.events).pipe(Effect.timeoutOption(LOGIN_IDLE_TIMEOUT));
    if (Option.isNone(event)) return { type: "timeout" };
    if (event.value.type === "data") {
      yield* updateOutput(run, event.value.data);
      return yield* loop(run);
    }
    return event.value;
  });

  const runLogin = Effect.fn("ProviderAuthManager.runLogin")(function* (
    terminalId: string,
    run: ActiveRun,
    target: ResolvedAuthTarget,
    input: ProviderAuthLoginStartInput,
    started: Deferred.Deferred<ProviderAuthLoginStartResult, ProviderAuthError>,
  ) {
    const process = yield* ptyAdapter
      .spawn({
        shell: target.binaryPath,
        args: [...loginArgs(target, input)],
        cwd: config.cwd,
        cols: PTY_COLS,
        rows: PTY_ROWS,
        env: target.environment,
      })
      .pipe(Effect.mapError(() => authError("Could not start the provider login command.")));
    yield* Ref.set(run.process, process);
    yield* addActiveProcess(process);
    const removeDataListener = process.onData((data) => {
      Queue.offerUnsafe(run.events, { type: "data", data });
    });
    const removeExitListener = process.onExit((event) => {
      Queue.offerUnsafe(run.events, { type: "exit", exitCode: event.exitCode });
    });

    const startedAt = yield* nowIso;
    const runningState: ProviderAuthRunState = {
      ...idleState(),
      status: "running",
      startedAt,
      message: "Waiting for provider authentication.",
    };
    yield* SubscriptionRef.set(run.state, runningState);
    yield* Deferred.succeed(started, { terminalId, state: runningState });

    const finish = Effect.gen(function* () {
      const completion = yield* drainLoginEvents(run);
      if (completion.type === "exit") yield* removeActiveProcess(process);
      const finishedAt = yield* nowIso;
      const current = yield* SubscriptionRef.get(run.state);
      const next: ProviderAuthRunState =
        completion.type === "cancel"
          ? {
              ...current,
              status: "cancelled",
              finishedAt,
              message: "Provider login was cancelled.",
            }
          : completion.type === "timeout"
            ? {
                ...current,
                status: "failed",
                finishedAt,
                message: "Provider login timed out after 10 minutes without output.",
              }
            : completion.exitCode === 0
              ? {
                  ...current,
                  status: "succeeded",
                  finishedAt,
                  message: "Provider login completed.",
                }
              : {
                  ...current,
                  status: "failed",
                  finishedAt,
                  message: `Provider login exited with code ${completion.exitCode}.`,
                };
      yield* SubscriptionRef.set(run.state, next);
      yield* refresh(run.instanceId);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          removeDataListener();
          removeExitListener();
        }),
      ),
      Effect.ensuring(Ref.set(run.process, null)),
      Effect.ensuring(cleanupActiveProcess(process)),
      Effect.ensuring(retainCompletedRun(terminalId)),
    );
    yield* finish;
  });

  const loginStart: ProviderAuthManagerShape["loginStart"] = Effect.fn(
    "ProviderAuthManager.loginStart",
  )(function* (input) {
    const target = yield* resolveTarget(input.instanceId);
    const terminalId = `provider-auth-${yield* Ref.updateAndGet(terminalSequenceRef, (n) => n + 1)}`;
    const state = yield* SubscriptionRef.make(idleState());
    const events = yield* Queue.unbounded<LoginEvent>();
    const process = yield* Ref.make<PtyAdapter.PtyProcess | null>(null);
    const run: ActiveRun = {
      instanceId: input.instanceId,
      state,
      events,
      process,
    };
    yield* Ref.update(runsRef, (runs) => new Map(runs).set(terminalId, run));
    const started = yield* Deferred.make<ProviderAuthLoginStartResult, ProviderAuthError>();
    const targetKey = `instance:${input.instanceId}`;

    yield* commandCoordinator
      .withCommandLock({
        targetKey,
        lockKey: targetKey,
        run: runLogin(terminalId, run, target, input, started),
      })
      .pipe(
        Effect.catch((error) =>
          Deferred.fail(started, error).pipe(
            Effect.andThen(
              Ref.update(runsRef, (runs) => {
                const next = new Map(runs);
                next.delete(terminalId);
                return next;
              }),
            ),
          ),
        ),
        Effect.forkIn(managerScope),
      );
    return yield* Deferred.await(started);
  });

  const findRun = Effect.fn("ProviderAuthManager.findRun")(function* (terminalId: string) {
    const run = (yield* Ref.get(runsRef)).get(terminalId);
    if (!run) return yield* authError("The provider login session does not exist.");
    return run;
  });

  const loginCancel: ProviderAuthManagerShape["loginCancel"] = Effect.fn(
    "ProviderAuthManager.loginCancel",
  )(function* (input) {
    const run = yield* findRun(input.terminalId);
    const current = yield* SubscriptionRef.get(run.state);
    if (current.status !== "running") return { state: current };
    Queue.offerUnsafe(run.events, { type: "cancel" });
    const process = yield* Ref.get(run.process);
    if (process) yield* killAndReleaseProcess(process);
    const state = yield* SubscriptionRef.changes(run.state).pipe(
      Stream.filter((state) => state.status !== "running"),
      Stream.runHead,
      Effect.map(Option.getOrElse(() => current)),
    );
    return { state };
  });

  const loginRespond: ProviderAuthManagerShape["loginRespond"] = Effect.fn(
    "ProviderAuthManager.loginRespond",
  )(function* (input) {
    const run = yield* findRun(input.terminalId);
    const current = yield* SubscriptionRef.get(run.state);
    if (current.status !== "running") {
      return yield* authError("The provider login is not waiting for input.");
    }
    const process = yield* Ref.get(run.process);
    if (!process) {
      return yield* authError("The provider login command is not running.");
    }
    // The value can be a one-time OAuth code. Write it to the PTY and forget
    // it; never log it or store it outside the PTY's own echo in the tail.
    yield* Effect.sync(() => {
      process.write(`${input.data}\r`);
    });
    return { state: current };
  });

  const loginStatus: ProviderAuthManagerShape["loginStatus"] = (terminalId) =>
    Stream.unwrap(
      findRun(terminalId).pipe(Effect.map((run) => SubscriptionRef.changes(run.state))),
    );

  const runLogoutCommand = Effect.fn("ProviderAuthManager.runLogoutCommand")(function* (
    target: ResolvedAuthTarget,
    args: ReadonlyArray<string>,
  ) {
    const process = yield* ptyAdapter
      .spawn({
        shell: target.binaryPath,
        args: [...args],
        cwd: config.cwd,
        cols: PTY_COLS,
        rows: PTY_ROWS,
        env: target.environment,
      })
      .pipe(Effect.mapError(() => authError("Could not start the provider logout command.")));
    yield* addActiveProcess(process);
    const exit = yield* Deferred.make<number>();
    const removeExitListener = process.onExit((event) => {
      runFork(Deferred.succeed(exit, event.exitCode));
    });
    yield* Effect.gen(function* () {
      const exitCode = yield* Deferred.await(exit).pipe(Effect.timeoutOption(LOGIN_IDLE_TIMEOUT));
      if (Option.isNone(exitCode)) return yield* authError("Provider logout timed out.");
      yield* removeActiveProcess(process);
      if (exitCode.value !== 0) {
        return yield* authError(`Provider logout exited with code ${exitCode.value}.`);
      }
    }).pipe(
      Effect.ensuring(Effect.sync(removeExitListener)),
      Effect.ensuring(cleanupActiveProcess(process)),
    );
  });

  const validateManagedHome = Effect.fn("ProviderAuthManager.validateManagedHome")(function* (
    target: ResolvedAuthTarget,
  ) {
    const lexicalAccounts = path.resolve(config.accountsDir);
    const lexicalTarget = path.resolve(target.homePath);
    const expectedTarget = path.resolve(
      yield* managedAccountHomePath({
        accountsDir: config.accountsDir,
        driverKind: ProviderDriverKind.make(target.driver),
        instanceId: target.instanceId,
      }).pipe(Effect.provideService(Path.Path, path)),
    );
    if (lexicalTarget !== expectedTarget) {
      return yield* authError("The account home does not match this provider account.");
    }
    const relative = path.relative(lexicalAccounts, lexicalTarget);
    if (
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return yield* authError("The account home is not a managed account directory.");
    }

    const sharedHomes = [
      // These are the driver's shared homes. Keep this refusal list load-bearing
      // now that managed accounts use credentials-only shadow homes.
      path.join(NodeOS.homedir(), ".claude"),
      path.join(NodeOS.homedir(), ".codex"),
      path.join(NodeOS.homedir(), ".kimi-code"),
      path.join(NodeOS.homedir(), ".local", "share", "opencode"),
      path.join(NodeOS.homedir(), ".local", "share"),
      ...(target.sharedHomePath ? [target.sharedHomePath] : []),
    ].map((value) => path.resolve(value));
    if (sharedHomes.includes(lexicalTarget)) {
      return yield* authError("The shared provider home cannot be deleted.");
    }

    const canonicalAccounts = yield* fileSystem
      .realPath(lexicalAccounts)
      .pipe(Effect.mapError(() => authError("The managed accounts directory is not safe to use.")));
    if (canonicalAccounts !== lexicalAccounts) {
      return yield* authError("The managed accounts directory cannot use symbolic links.");
    }

    const canonicalTarget = yield* fileSystem
      .realPath(lexicalTarget)
      .pipe(Effect.mapError(() => authError("The account home path is missing or unsafe.")));
    const canonicalSharedHomes = yield* Effect.forEach(sharedHomes, (sharedHome) =>
      fileSystem.realPath(sharedHome).pipe(Effect.orElseSucceed((): string | null => null)),
    );
    if (canonicalSharedHomes.includes(canonicalTarget)) {
      return yield* authError("The shared provider home cannot be deleted.");
    }

    const canonicalRelative = path.relative(canonicalAccounts, canonicalTarget);
    if (
      canonicalRelative.length === 0 ||
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(canonicalRelative)
    ) {
      return yield* authError("The account home is outside the managed accounts directory.");
    }

    let candidate = lexicalAccounts;
    for (const segment of relative.split(path.sep)) {
      candidate = path.join(candidate, segment);
      const canonicalCandidate = yield* fileSystem
        .realPath(candidate)
        .pipe(Effect.mapError(() => authError("The account home path is missing or unsafe.")));
      if (canonicalCandidate !== candidate) {
        return yield* authError("The account home path cannot use symbolic links.");
      }
    }

    return lexicalTarget;
  });

  const removeOpenCodeCredential = Effect.fn("ProviderAuthManager.removeOpenCodeCredential")(
    function* (target: ResolvedAuthTarget, provider: string | undefined) {
      const raw = yield* fileSystem.readFileString(target.authFilePath).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            isNotFound(error)
              ? Effect.succeed<string | null>(null)
              : Effect.fail(authError("Could not read the OpenCode credential file.")),
        }),
      );
      if (raw === null) return;
      const credentials = yield* decodeUnknownJsonString(raw).pipe(
        Effect.mapError(() => authError("The OpenCode credential file is invalid.")),
      );
      if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
        return yield* authError("The OpenCode credential file is invalid.");
      }
      const record = credentials as Record<string, unknown>;
      const keys = Object.keys(record);
      const selectedProvider = provider ?? (keys.length === 1 ? keys[0] : undefined);
      if (!selectedProvider) {
        return yield* authError("Select an OpenCode provider before signing out.");
      }
      if (!(selectedProvider in record)) return;
      const next = { ...record };
      delete next[selectedProvider];
      const encoded = yield* encodeUnknownJsonString(next).pipe(
        Effect.mapError(() => authError("Could not update the OpenCode credential file.")),
      );
      yield* writeFileStringAtomically({
        filePath: target.authFilePath,
        contents: `${encoded}\n`,
        mode: 0o600,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(() => authError("Could not update the OpenCode credential file.")),
      );
    },
  );

  const performLogout = Effect.fn("ProviderAuthManager.performLogout")(function* (
    target: ResolvedAuthTarget,
    input: ProviderAuthLogoutInput,
    validatedHome: string | null,
  ) {
    if (target.driver === "kimi" && target.sharedHomePath) {
      const indexPath = path.join(target.sharedHomePath, "session_index.jsonl");
      const index = yield* fileSystem
        .readFileString(indexPath)
        .pipe(Effect.orElseSucceed(() => ""));
      if (index.length > 0) {
        const oldPrefix = `${target.homePath}${path.sep}`;
        const rewritten = index
          .split("\n")
          .map((line) => {
            if (line.trim().length === 0) return line;
            try {
              const row = JSON.parse(line) as Record<string, unknown>;
              if (typeof row.sessionDir !== "string" || !row.sessionDir.startsWith(oldPrefix)) {
                return line;
              }
              return JSON.stringify({
                ...row,
                sessionDir: `${target.sharedHomePath}${row.sessionDir.slice(target.homePath.length)}`,
              });
            } catch {
              return line;
            }
          })
          .join("\n");
        if (rewritten !== index) {
          yield* writeFileStringAtomically({
            filePath: indexPath,
            contents: rewritten,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.mapError(() => authError("Could not update the Kimi session index.")),
          );
        }
      }
    }
    if (target.driver === "claudeAgent" || target.driver === "codex") {
      yield* Effect.result(
        runLogoutCommand(target, target.driver === "claudeAgent" ? ["auth", "logout"] : ["logout"]),
      );
    }

    switch (target.driver) {
      case "claudeAgent":
      case "codex":
      case "kimi":
        yield* removeIfPresent(fileSystem, target.authFilePath);
        break;
      case "opencode":
        yield* removeOpenCodeCredential(target, input.provider);
        break;
    }

    if (validatedHome) {
      yield* fileSystem
        .remove(validatedHome, { recursive: true })
        .pipe(Effect.mapError(() => authError("Could not delete the managed account home.")));
    }
  });

  const logout: ProviderAuthManagerShape["logout"] = Effect.fn("ProviderAuthManager.logout")(
    function* (input) {
      const target = yield* resolveTarget(input.instanceId);
      const validatedHome = input.deleteAccountHome ? yield* validateManagedHome(target) : null;
      const targetKey = `instance:${input.instanceId}`;
      const outcome = yield* Effect.result(
        commandCoordinator.withCommandLock({
          targetKey,
          lockKey: targetKey,
          run: performLogout(target, input, validatedHome),
        }),
      );
      const providers = yield* refresh(input.instanceId);
      if (Result.isFailure(outcome)) return yield* outcome.failure;
      return { providers };
    },
  );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const runs = yield* Ref.get(runsRef);
      for (const run of runs.values()) Queue.offerUnsafe(run.events, { type: "cancel" });
      const processes = yield* Ref.get(activeProcessesRef);
      yield* Effect.forEach(processes, killAndReleaseProcess, { discard: true });
    }),
  );

  return ProviderAuthManager.of({ loginStart, loginCancel, loginRespond, loginStatus, logout });
});

export const layer = Layer.effect(ProviderAuthManager, make());
