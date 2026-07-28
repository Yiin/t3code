import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

const REQUIRED_PROVIDER_COMMANDS = ["bd", "git"] as const;

export const diagnoseProviderCommandPath = Effect.fn("diagnoseProviderCommandPath")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const missingCommands: Array<(typeof REQUIRED_PROVIDER_COMMANDS)[number]> = [];
  for (const command of REQUIRED_PROVIDER_COMMANDS) {
    if (!(yield* isCommandAvailable(command, { env: environment }))) {
      missingCommands.push(command);
    }
  }
  if (missingCommands.length === 0) {
    return;
  }

  yield* Effect.logWarning(
    "Provider sessions may fail because required commands are missing from PATH.",
    {
      missingCommands,
      searchedPath: environment.PATH ?? "",
    },
  );
});
