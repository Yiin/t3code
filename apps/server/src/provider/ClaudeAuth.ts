import * as NodeUtil from "node:util";
import {
  ProviderSetupError,
  type ClaudeSettings,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { makeClaudeEnvironment, resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";

const CLAUDE_AUTH_METHODS = [
  {
    id: "claudeai",
    name: "Claude account",
    description: "Sign in with a Claude subscription.",
    type: "terminal" as const,
  },
];

const decodeAuthStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      loggedIn: Schema.Boolean,
      email: Schema.optional(Schema.String),
    }),
  ),
);

function authorizationUrl(output: string): string | undefined {
  // OSC hyperlinks can repeat the URL. Match only Claude's HTTPS authorization endpoints.
  const candidates = NodeUtil.stripVTControlCharacters(output).match(
    /https:\/\/(?:claude\.(?:ai|com)|platform\.claude\.com)\/[^\s]+/gu,
  );
  return candidates?.findLast((candidate) => {
    try {
      return new URL(candidate).pathname.endsWith("/oauth/authorize");
    } catch {
      return false;
    }
  });
}

export const readClaudeAuthStatus = Effect.fn("readClaudeAuthStatus")(function* (
  config: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const result = yield* spawnAndCollect(
    config.binaryPath,
    ChildProcess.make(config.binaryPath, ["auth", "status", "--json"], {
      cwd,
      env: yield* makeClaudeEnvironment(config, environment),
    }),
  ).pipe(Effect.timeout(15_000));
  return yield* decodeAuthStatus(result.stdout);
});

/** Login output stays in the auth flow. It never enters terminal history or provider logs. */
export const makeClaudeAuth = Effect.fn("makeClaudeAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly config: ClaudeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly onChanged: Effect.Effect<void>;
}) {
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const environment = yield* makeClaudeEnvironment(options.config, options.environment);
  const homePath = yield* resolveClaudeHomePath(options.config, environment);
  const failure = (operation: "start" | "respond" | "logout", detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  const run = (args: ReadonlyArray<string>) =>
    spawnAndCollect(
      options.config.binaryPath,
      ChildProcess.make(options.config.binaryPath, args, { cwd: options.cwd, env: environment }),
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: `claude:home:${homePath}` },
    methods: Effect.succeed(CLAUDE_AUTH_METHODS),
    timeoutMs: 10 * 60_000,
    authenticate: (_method, context) =>
      Effect.gen(function* () {
        if (!options.config.enabled)
          return yield* failure("start", "Enable Claude before signing in.");
        if (Option.isNone(pty))
          return yield* failure("start", "The sign-in terminal is unavailable on this server.");
        yield* fs
          .makeDirectory(homePath, { recursive: true, mode: 0o700 })
          .pipe(
            Effect.mapError(() =>
              failure("start", "Could not create the Claude account directory."),
            ),
          );
        const exited = yield* Deferred.make<number>();
        const output = yield* Queue.sliding<string>(64);
        const child = yield* pty.value
          .spawn({
            shell: options.config.binaryPath,
            args: ["auth", "login", "--claudeai"],
            cwd: options.cwd,
            env: { ...environment, BROWSER: "true" },
            cols: 100,
            rows: 30,
          })
          .pipe(Effect.mapError(() => failure("start", "Could not start Claude sign-in.")));
        const detachData = child.onData((data) => Queue.offerUnsafe(output, data.slice(-16_384)));
        const detachExit = child.onExit(({ exitCode }) => {
          Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            detachData();
            detachExit();
            try {
              child.kill();
            } catch {
              /* The process may have already exited. */
            }
          }),
        );
        let transcript = "";
        let outputOffset = 0;
        let submitted = false;
        let url: string | undefined;
        const update = () => {
          if (submitted) return Effect.void;
          url = authorizationUrl(transcript) ?? url;
          if (/paste\s+code\s+here/i.test(NodeUtil.stripVTControlCharacters(transcript)))
            return context.setInteraction(
              {
                type: "credentials",
                id: "code",
                fields: [{ name: "code", label: "Authorization code", secret: true }],
              },
              (response) =>
                Effect.gen(function* () {
                  if (response.type !== "credentials") return;
                  const code = response.values.code?.trim();
                  if (!code || /[\r\n]/u.test(code))
                    return yield* failure("respond", "Paste the authorization code from Claude.");
                  yield* Effect.try({
                    try: () => {
                      child.write(`${code}\r`);
                    },
                    catch: () =>
                      failure("respond", "The Claude sign-in terminal is no longer available."),
                  });
                  submitted = true;
                  yield* context.verifying;
                }),
              undefined,
              url,
            );
          return context.setInteraction(
            { type: "terminal", id: "terminal", output: transcript, outputOffset },
            (response) =>
              response.type === "terminal"
                ? Effect.try({
                    try: () => {
                      if (response.size) child.resize(response.size.cols, response.size.rows);
                      if (response.data) child.write(response.data);
                    },
                    catch: () =>
                      failure("respond", "The Claude sign-in terminal is no longer available."),
                  })
                : Effect.void,
            undefined,
            url,
          );
        };
        yield* update();
        const outputFiber = yield* Queue.take(output).pipe(
          Effect.flatMap((data) => {
            outputOffset += data.length;
            transcript = (transcript + data).slice(-16_384);
            return update();
          }),
          Effect.forever,
          Effect.forkScoped,
        );
        if ((yield* Deferred.await(exited)) !== 0)
          return yield* failure(
            "start",
            "Claude sign-in did not finish successfully. Start again.",
          );
        yield* Fiber.interrupt(outputFiber);
        yield* context.verifying;
        const status = yield* readClaudeAuthStatus(options.config, environment, options.cwd).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Path.Path, path),
          Effect.mapError(() => failure("start", "Could not verify the Claude account.")),
        );
        if (!status.loggedIn || !status.email?.trim())
          return yield* failure(
            "start",
            "Claude did not confirm a signed-in account. Start again.",
          );
        yield* options.onChanged;
      }),
    logout: Effect.scoped(
      Effect.gen(function* () {
        const result = yield* run(["auth", "logout"]).pipe(
          Effect.timeout(30_000),
          Effect.mapError(() => failure("logout", "Could not sign out of Claude. Try again.")),
        );
        if (result.code !== 0)
          return yield* failure("logout", "Claude could not sign out. Try again.");
        yield* options.onChanged;
      }),
    ),
  });
});
