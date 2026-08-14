import * as NodeAssert from "node:assert/strict";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { beforeEach } from "vite-plus/test";

import { OpenCodeSettings } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { checkOpenCodeProviderStatus, openCodeAuthFromJson } from "./OpenCodeProvider.ts";
import type { OpenCodeInventory } from "../opencodeRuntime.ts";
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);
const encodeUnknownJson = Schema.encodeSync(Schema.UnknownFromJsonString);

const DEFAULT_VERSION_STDOUT = "opencode 1.14.19\n";

/**
 * The legacy `OpenCodeProviderLive` Layer + `OpenCodeProvider` service tag
 * are deleted. The snapshot-producing logic they wrapped now lives in the
 * standalone `checkOpenCodeProviderStatus(settings, cwd)` Effect, which
 * drivers call directly when building their per-instance snapshot
 * `ServerProviderShape`. Tests mirror that shape: build a settings payload,
 * invoke the check, assert on the returned snapshot.
 */

const runtimeMock = {
  state: {
    runVersionError: null as Error | null,
    versionStdout: DEFAULT_VERSION_STDOUT,
    inventoryError: null as Error | null,
    closeCalls: 0,
    inventory: {
      providerList: { connected: [] as string[], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
    } as unknown,
  },
  reset() {
    this.state.runVersionError = null;
    this.state.versionStdout = DEFAULT_VERSION_STDOUT;
    this.state.inventoryError = null;
    this.state.closeCalls = 0;
    this.state.inventory = {
      providerList: { connected: [], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
    };
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () =>
    Effect.succeed({
      url: "http://127.0.0.1:4301",
      exitCode: Effect.never,
    }),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.gen(function* () {
      if (!serverUrl) {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            runtimeMock.state.closeCalls += 1;
          }),
        );
      }
      return {
        url: serverUrl ?? "http://127.0.0.1:4301",
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () =>
    runtimeMock.state.runVersionError
      ? Effect.fail(
          new OpenCodeRuntimeError({
            operation: "runOpenCodeCommand",
            detail: runtimeMock.state.runVersionError.message,
            cause: runtimeMock.state.runVersionError,
          }),
        )
      : Effect.succeed({ stdout: runtimeMock.state.versionStdout, stderr: "", code: 0 }),
  createOpenCodeSdkClient: () =>
    ({}) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    runtimeMock.state.inventoryError
      ? Effect.fail(
          new OpenCodeRuntimeError({
            operation: "loadOpenCodeInventory",
            detail: runtimeMock.state.inventoryError.message,
            cause: runtimeMock.state.inventoryError,
          }),
        )
      : Effect.succeed(runtimeMock.state.inventory as OpenCodeInventory),
  loadInventoryFromCli: () =>
    runtimeMock.state.inventoryError
      ? Effect.fail(
          new OpenCodeRuntimeError({
            operation: "loadInventoryFromCli",
            detail: runtimeMock.state.inventoryError.message,
            cause: runtimeMock.state.inventoryError,
          }),
        )
      : Effect.succeed(runtimeMock.state.inventory as OpenCodeInventory),
};

beforeEach(() => {
  runtimeMock.reset();
});

const testLayer = Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

const makeOpenCodeSettings = (overrides?: Partial<OpenCodeSettings>): OpenCodeSettings =>
  decodeOpenCodeSettings({
    enabled: true,
    binaryPath: "opencode",
    serverUrl: "",
    serverPassword: "",
    customModels: [],
    ...overrides,
  });

const makeOpenCodeAuthHome = Effect.fn("makeOpenCodeAuthHome")(function* (
  prefix: string,
  contents?: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dataHome = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix,
  });
  if (contents !== undefined) {
    const authDirectory = path.join(dataHome, "opencode");
    yield* fileSystem.makeDirectory(authDirectory);
    yield* fileSystem.writeFileString(path.join(authDirectory, "auth.json"), contents);
  }
  return dataHome;
});

it("parses only safe OpenCode auth identity fields", () => {
  const auth = openCodeAuthFromJson(
    encodeUnknownJson({
      openai: {
        type: "oauth",
        refresh: "secret-refresh",
        access: "secret-access",
        expires: 1_800_000_000_000,
        accountId: "account-personal",
      },
      anthropic: { type: "api", key: "secret-api-key" },
    }),
    "OpenCode Personal",
  );

  NodeAssert.deepEqual(auth, {
    status: "authenticated",
    type: "api, oauth",
    label: "anthropic, openai · account-personal",
  });
  NodeAssert.equal(encodeUnknownJson(auth).includes("secret-"), false);
});

it("rejects malformed OpenCode auth entries and matches accepted empty string fields", () => {
  NodeAssert.deepEqual(openCodeAuthFromJson('{"openai":'), { status: "unauthenticated" });
  NodeAssert.deepEqual(
    openCodeAuthFromJson('{"openai":{"type":"oauth","refresh":"","access":"","expires":0}}'),
    { status: "authenticated", type: "oauth", label: "openai" },
  );
});

it("accepts OpenCode well-known credentials without exposing them", () => {
  const auth = openCodeAuthFromJson(
    '{"https://example.com":{"type":"wellknown","key":"AUTH_TOKEN","token":"secret"}}',
  );
  NodeAssert.deepEqual(auth, {
    status: "authenticated",
    type: "wellknown",
    label: "https://example.com",
  });
  NodeAssert.equal(encodeUnknownJson(auth).includes("secret"), false);
});

it("rejects negative and fractional OpenCode OAuth expiry values", () => {
  for (const expires of [-1, 1.5]) {
    const auth = openCodeAuthFromJson(
      encodeUnknownJson({
        openai: { type: "oauth", refresh: "refresh", access: "access", expires },
      }),
    );
    NodeAssert.deepEqual(auth, { status: "unauthenticated" });
  }
});

it.layer(testLayer)("checkOpenCodeProviderStatus", (it) => {
  it.effect("shows a codex-style missing binary message", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("spawn opencode ENOENT");
      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, false);
      NodeAssert.equal(
        snapshot.message,
        "OpenCode CLI (`opencode`) is not installed or not on PATH.",
      );
    }),
  );

  it.effect("hides generic Effect.tryPromise text for local CLI probe failures", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("An error occurred in Effect.tryPromise");
      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.message, "Failed to execute OpenCode CLI health check.");
    }),
  );

  it.effect("emits OpenCode variant defaults so trait picker can resolve a visible selection", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["openai"],
          all: [
            {
              id: "openai",
              name: "OpenAI",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  variants: {
                    none: {},
                    low: {},
                    medium: {},
                    high: {},
                    xhigh: {},
                  },
                },
              },
            },
          ],
          default: {},
        },
        agents: [
          { name: "build", hidden: false, mode: "primary" },
          { name: "plan", hidden: false, mode: "primary" },
        ],
      };

      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());
      const model = snapshot.models.find((entry) => entry.slug === "openai/gpt-5.4");

      NodeAssert.ok(model);
      const variantDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "variant" && descriptor.type === "select",
      );
      NodeAssert.ok(variantDescriptor && variantDescriptor.type === "select");
      NodeAssert.equal(
        variantDescriptor.options.find((option) => option.isDefault === true)?.id,
        "medium",
      );
      const agentDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "agent" && descriptor.type === "select",
      );
      NodeAssert.ok(agentDescriptor && agentDescriptor.type === "select");
      NodeAssert.equal(
        agentDescriptor.options.find((option) => option.isDefault === true)?.id,
        "build",
      );
    }),
  );

  it.effect("does not spawn a local server for health check (uses CLI instead)", () =>
    Effect.gen(function* () {
      yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      NodeAssert.equal(runtimeMock.state.closeCalls, 0);
    }),
  );

  it.effect("reports local model inventory failures without treating them as empty", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error("opencode models failed");
      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.models.length, 0);
      NodeAssert.equal(
        snapshot.message,
        "Failed to execute OpenCode CLI health check: opencode models failed",
      );
    }),
  );

  it.effect("reads signed-in identity from the effective OpenCode auth file", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      runtimeMock.state.inventory = {
        providerList: { connected: ["openai"], all: [], default: {} },
        agents: [],
      };
      const dataHome = yield* makeOpenCodeAuthHome(
        "opencode-authenticated-",
        encodeUnknownJson({ openai: { type: "api", key: "secret-api-key" } }),
      );
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({ dataHomePath: dataHome }),
        process.cwd(),
      );

      NodeAssert.equal(snapshot.auth.status, "authenticated");
      NodeAssert.equal(snapshot.auth.type, "api");
      NodeAssert.equal(snapshot.auth.label, `openai · ${path.basename(dataHome)}`);
      NodeAssert.equal(encodeUnknownJson(snapshot).includes("secret-api-key"), false);
    }),
  );

  it.effect("reports signed out for missing and truncated OpenCode auth files", () =>
    Effect.gen(function* () {
      const missingHome = yield* makeOpenCodeAuthHome("opencode-missing-");
      const corruptHome = yield* makeOpenCodeAuthHome(
        "opencode-corrupt-",
        '{"openai":{"type":"api","key":"secret-api-key"}',
      );
      const snapshots = yield* Effect.all(
        [missingHome, corruptHome].map((dataHome) =>
          checkOpenCodeProviderStatus(
            makeOpenCodeSettings({ dataHomePath: dataHome }),
            process.cwd(),
          ),
        ),
      );

      const missing = snapshots[0]!;
      const corrupt = snapshots[1]!;
      NodeAssert.deepEqual(missing.auth, { status: "unauthenticated" });
      NodeAssert.deepEqual(corrupt.auth, { status: "unauthenticated" });
      NodeAssert.equal(encodeUnknownJson(corrupt).includes("secret-api-key"), false);
    }),
  );

  it.effect("prefers OPENCODE_AUTH_CONTENT over the auth file", () =>
    Effect.gen(function* () {
      const dataHome = yield* makeOpenCodeAuthHome(
        "opencode-env-auth-",
        encodeUnknownJson({ anthropic: { type: "api", key: "file-secret" } }),
      );
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({ dataHomePath: dataHome }),
        process.cwd(),
        {
          ...process.env,
          OPENCODE_AUTH_CONTENT: encodeUnknownJson({
            openai: { type: "api", key: "environment-secret" },
          }),
        },
      );

      NodeAssert.equal(snapshot.auth.label?.startsWith("openai · "), true);
      NodeAssert.equal(encodeUnknownJson(snapshot).includes("file-secret"), false);
      NodeAssert.equal(encodeUnknownJson(snapshot).includes("environment-secret"), false);
    }),
  );

  it.effect("falls back to the auth file when OPENCODE_AUTH_CONTENT is malformed", () =>
    Effect.gen(function* () {
      const dataHome = yield* makeOpenCodeAuthHome(
        "opencode-invalid-env-auth-",
        encodeUnknownJson({ anthropic: { type: "api", key: "file-secret" } }),
      );
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({ dataHomePath: dataHome }),
        process.cwd(),
        { ...process.env, OPENCODE_AUTH_CONTENT: '{"openai":' },
      );

      NodeAssert.equal(snapshot.auth.label?.startsWith("anthropic · "), true);
      NodeAssert.equal(encodeUnknownJson(snapshot).includes("file-secret"), false);
    }),
  );

  it.effect("keeps identities separate across two OpenCode data homes", () =>
    Effect.gen(function* () {
      const homes = yield* Effect.all(
        ["opencode-personal-", "opencode-work-"].map((prefix) =>
          makeOpenCodeAuthHome(
            prefix,
            encodeUnknownJson({ openai: { type: "api", key: `${prefix}secret` } }),
          ),
        ),
      );
      const snapshots = yield* Effect.all(
        homes.map((dataHome) =>
          checkOpenCodeProviderStatus(
            makeOpenCodeSettings({ dataHomePath: dataHome }),
            process.cwd(),
          ),
        ),
      );

      NodeAssert.notEqual(snapshots[0]!.auth.label, snapshots[1]!.auth.label);
      NodeAssert.equal(encodeUnknownJson(snapshots).includes("secret"), false);
    }),
  );
});

it.layer(testLayer)("checkOpenCodeProviderStatus with configured server URL", (it) => {
  it.effect("does not infer external-server authentication from connected providers", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: { connected: ["openai"], all: [], default: {} },
        agents: [],
      };
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({ serverUrl: "http://127.0.0.1:9999" }),
        process.cwd(),
        {
          ...process.env,
          OPENCODE_AUTH_CONTENT: encodeUnknownJson({
            openai: { type: "api", key: "local-secret" },
          }),
        },
      );

      NodeAssert.deepEqual(snapshot.auth, { status: "unknown" });
      NodeAssert.equal(encodeUnknownJson(snapshot).includes("local-secret"), false);
    }),
  );

  it.effect("surfaces a friendly auth error for configured servers", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error("401 Unauthorized");
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
        process.cwd(),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(
        snapshot.message,
        "OpenCode server rejected authentication. Check the server URL and password.",
      );
    }),
  );

  it.effect("surfaces a friendly connection error for configured servers", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error(
        "fetch failed: connect ECONNREFUSED 127.0.0.1:9999",
      );
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
        process.cwd(),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(
        snapshot.message,
        "Couldn't reach the configured OpenCode server at http://127.0.0.1:9999. Check that the server is running and the URL is correct.",
      );
    }),
  );
});
