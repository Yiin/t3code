import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import * as NetService from "@t3tools/shared/Net";
import packageJson from "../../package.json" with { type: "json" };
import { cookCommand } from "./epicCook.ts";

const epicCommand = Command.make("epic").pipe(Command.withSubcommands([cookCommand]));
const cookCli = Command.make("t3").pipe(Command.withSubcommands([epicCommand]));
const CookRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

export const runEpicCookCli = (): void => {
  Command.run(cookCli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CookRuntimeLayer),
    NodeRuntime.runMain,
  );
};
