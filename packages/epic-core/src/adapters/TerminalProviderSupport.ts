// @effect-diagnostics nodeBuiltinImport:off globalProcess:off
import * as NodeChildProcess from "node:child_process";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderInventoryShape } from "../ports/ProviderInventory.ts";
import type { TerminalHarness } from "./TerminalAgentDispatch.ts";

export interface TerminalProviderRoute {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly harness: TerminalHarness;
  readonly binary: string;
  readonly model: string;
  readonly primary: boolean;
}

export interface TerminalProviderSupport {
  readonly routes: ReadonlyArray<TerminalProviderRoute>;
  readonly inventory: ProviderInventoryShape;
}

const driverForHarness = (harness: TerminalHarness): ProviderDriverKind =>
  ProviderDriverKind.make(harness === "claude" || harness === "ccx" ? "claudeAgent" : harness);

const defaultBinary = (harness: TerminalHarness): string =>
  harness === "claude" || harness === "ccx" ? "claude" : harness;

const fallbackHarnesses = (harness: TerminalHarness): ReadonlyArray<TerminalHarness> => {
  if (harness === "claude" || harness === "ccx") return ["codex", "kimi"];
  if (harness === "codex") return ["kimi"];
  return [];
};

const fallbackModel = (harness: TerminalHarness): string =>
  harness === "codex" ? "gpt-5.6-sol" : harness === "kimi" ? "kimi-code/k3" : "";

const isCommandAvailable = (command: string, environment: NodeJS.ProcessEnv): boolean =>
  NodeChildProcess.spawnSync(
    "/bin/sh",
    ["-c", 'command -v -- "$1" >/dev/null 2>&1', "provider-probe", command],
    { env: { ...process.env, ...environment }, stdio: "ignore" },
  ).status === 0;

const snapshot = (route: TerminalProviderRoute, installed: boolean): ServerProvider => ({
  instanceId: route.instanceId,
  driver: route.driver,
  enabled: true,
  installed,
  version: null,
  status: installed ? "ready" : "error",
  auth: { status: "authenticated" },
  checkedAt: "1970-01-01T00:00:00.000Z",
  availability: installed ? "available" : "unavailable",
  models: [{ slug: route.model, name: route.model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

export const makeTerminalProviderSupport = (options: {
  readonly harness: TerminalHarness;
  readonly selection: ModelSelection;
  readonly binary?: string;
  readonly workerCommand?: string;
  readonly environment?: NodeJS.ProcessEnv;
}): TerminalProviderSupport => {
  const primaryBinary =
    options.harness === "worker-cmd"
      ? (options.workerCommand ?? options.binary ?? "")
      : (options.binary ?? defaultBinary(options.harness));
  const routes: TerminalProviderRoute[] = [
    {
      instanceId: options.selection.instanceId,
      driver: driverForHarness(options.harness),
      harness: options.harness,
      binary: primaryBinary,
      model: options.selection.model,
      primary: true,
    },
    ...fallbackHarnesses(options.harness).map(
      (harness): TerminalProviderRoute => ({
        instanceId: ProviderInstanceId.make(harness),
        driver: driverForHarness(harness),
        harness,
        binary: defaultBinary(harness),
        model: fallbackModel(harness),
        primary: false,
      }),
    ),
  ].filter(
    (route, index, all) =>
      all.findIndex((candidate) => candidate.instanceId === route.instanceId) === index,
  );
  const environment = options.environment ?? {};
  return {
    routes,
    inventory: {
      getProviders: Effect.sync(() =>
        routes.map((route) => snapshot(route, isCommandAvailable(route.binary, environment))),
      ),
    },
  };
};
