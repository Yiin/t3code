import { DEFAULT_EPIC_RUN_CONFIG } from "@t3tools/contracts";
import type {
  EpicRunConfigOverride,
  EpicRunPreflightMode,
  EpicRunPreflightResult,
} from "@t3tools/contracts";

type CommandResult<T> =
  | { readonly _tag: "Success"; readonly value: T }
  | { readonly _tag: "Failure"; readonly error?: unknown }
  | { readonly _tag: "Interrupted" };

export function epicRunPreflightBlockersFromError(error: unknown): readonly string[] | null {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return null;
  if (error._tag !== "EpicRunPreflightBlockedError" || !("blockers" in error)) return null;
  if (
    !Array.isArray(error.blockers) ||
    !error.blockers.every((value) => typeof value === "string")
  ) {
    return null;
  }
  return error.blockers;
}

/**
 * Picks the preflight mode the server will actually run this launch in.
 *
 * The two modes disagree about dirt: sequential treats every untracked file as
 * a fatal blocker, parallel only warns. Preflighting as sequential for a run
 * that launches parallel blocks the operator over dirt the run tolerates, so
 * the mode has to come from the config the launch carries. Keys the override
 * leaves alone fall back to the contract default, which is parallel.
 */
export function epicRunPreflightModeForConfig(
  override: EpicRunConfigOverride | undefined,
): EpicRunPreflightMode {
  const sequential =
    override?.execution?.sequential ?? DEFAULT_EPIC_RUN_CONFIG.execution.sequential;
  return sequential ? "sequential" : "parallel";
}

export async function preflightAndLaunchEpicRun<P, L, R>(input: {
  readonly preflightInput: P;
  readonly launchInput: L;
  readonly preflight: (value: P) => Promise<CommandResult<EpicRunPreflightResult>>;
  readonly launch: (value: L) => Promise<R>;
  readonly onPreflightFailure: (result: CommandResult<EpicRunPreflightResult>) => void;
  readonly onBlocked: (result: EpicRunPreflightResult) => void;
  readonly onWarnings: (result: EpicRunPreflightResult) => void;
}): Promise<R | undefined> {
  const preflight = await input.preflight(input.preflightInput);
  if (preflight._tag !== "Success") {
    input.onPreflightFailure(preflight);
    return undefined;
  }
  if (preflight.value.blockers.length > 0) {
    input.onBlocked(preflight.value);
    return undefined;
  }
  if (preflight.value.warnings.length > 0) input.onWarnings(preflight.value);
  return input.launch(input.launchInput);
}
