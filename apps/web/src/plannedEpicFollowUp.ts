import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { ScopedEpicPlanCorrelation } from "@t3tools/client-runtime/state/planned-epic";

export function plannedEpicIdentity(correlation: ScopedEpicPlanCorrelation): string {
  return `${correlation.environmentId}:${correlation.projectId}:${correlation.epicId}`;
}

export function plannedEpicRoute(correlation: ScopedEpicPlanCorrelation) {
  return {
    to: "/epics/$environmentId/$epicId" as const,
    params: {
      environmentId: correlation.environmentId,
      epicId: correlation.epicId,
    },
    search: { project: correlation.projectId },
  };
}

export function plannedEpicLaunchInput(correlation: ScopedEpicPlanCorrelation) {
  return {
    environmentId: correlation.environmentId as EnvironmentId,
    input: {
      epicId: correlation.epicId,
      projectId: correlation.projectId as ProjectId,
      cwd: correlation.cwd,
      // The planning conversation is the launcher: without it the run's
      // sidebar group floats at project level and never tidies away with
      // the thread it came from.
      originThreadId: correlation.threadId,
    },
  };
}

export async function launchPlannedEpic<
  R extends { readonly _tag: "Success" } | { readonly _tag: "Failure" },
>(input: {
  correlation: ScopedEpicPlanCorrelation;
  launch: (launchInput: ReturnType<typeof plannedEpicLaunchInput>) => Promise<R>;
  navigate: (route: ReturnType<typeof plannedEpicRoute>) => void | Promise<void>;
  onFailure: (result: Extract<R, { readonly _tag: "Failure" }>) => void;
  onSettled: () => void;
}): Promise<void> {
  const result = await input.launch(plannedEpicLaunchInput(input.correlation));
  input.onSettled();
  if (result._tag === "Success") {
    await input.navigate(plannedEpicRoute(input.correlation));
    return;
  }
  input.onFailure(result as Extract<R, { readonly _tag: "Failure" }>);
}
