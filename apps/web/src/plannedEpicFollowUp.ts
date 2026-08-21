import type { EpicRun } from "@t3tools/contracts";
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
    environmentId: correlation.environmentId,
    input: {
      epicId: correlation.epicId,
      projectId: correlation.projectId,
      cwd: correlation.cwd,
      // The planning conversation is the launcher: without it the run's
      // sidebar group floats at project level and never tidies away with
      // the thread it came from.
      originThreadId: correlation.threadId,
      // Cooking from inside a conversation continues that conversation's
      // work, so the run keeps the provider instance, model and options the
      // user is already planning with. The Epics page has no such thread and
      // stays on the project default.
      inheritOriginModelSelection: true,
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
  // TS cannot narrow a value of generic type `R` by its discriminant, so the
  // `_tag === "Success"` early return above is invisible to the checker here.
  input.onFailure(result as Extract<R, { readonly _tag: "Failure" }>);
}

export type PlannedEpicBannerControl = "start" | "pause" | "resume" | "view-only" | "restart";

export interface PlannedEpicBannerModel {
  readonly visible: boolean;
  readonly control: PlannedEpicBannerControl;
  readonly title: string;
  /** The derived latest run for the planned epic, or null when none exists. */
  readonly run: EpicRun | null;
  readonly suppressRunPill: boolean;
  readonly variant: "error" | "success" | "warning";
}

/**
 * The latest run of the planned epic, matched on `epicId` + `projectId` only.
 *
 * `cwd` is deliberately not matched: a dashboard launch stores the workspace
 * root while a worktree-thread correlation carries the worktree path, so the
 * same run would never match both. This is safe because the per-repo run lock
 * serializes same-epic runs within one repo, and `projectId` scopes the match
 * across repos. Ordering follows `latestEpicRun`: latest by `updatedAt`, ties
 * broken by `runId`.
 */
export function latestRunForPlannedEpic(
  runs: ReadonlyArray<EpicRun>,
  plannedEpic: { readonly epicId: string; readonly projectId: string },
): EpicRun | null {
  return runs.reduce<EpicRun | null>((latest, candidate) => {
    if (candidate.epicId !== plannedEpic.epicId || candidate.projectId !== plannedEpic.projectId) {
      return latest;
    }
    if (
      latest === null ||
      candidate.updatedAt > latest.updatedAt ||
      (candidate.updatedAt === latest.updatedAt && candidate.runId > latest.runId)
    ) {
      return candidate;
    }
    return latest;
  }, null);
}

export function resolvePlannedEpicBanner(input: {
  readonly plannedEpic: ScopedEpicPlanCorrelation | null;
  /** `undefined` means the runs query has not emitted its first value yet. */
  readonly runs: ReadonlyArray<EpicRun> | undefined;
  readonly dismissed: boolean;
  readonly activeEpicRun: EpicRun | null;
}): PlannedEpicBannerModel {
  const visible = input.plannedEpic !== null && !input.dismissed;
  let run: EpicRun | null = null;
  if (input.plannedEpic) {
    if (input.runs === undefined) {
      // The runs query has not emitted yet. Fall back to the thread's active
      // run so the banner does not offer Start while a matching live run
      // exists — the previous `!activeEpicRun` condition hid the banner in
      // this window instead.
      run =
        input.activeEpicRun !== null &&
        input.activeEpicRun.epicId === input.plannedEpic.epicId &&
        input.activeEpicRun.projectId === input.plannedEpic.projectId
          ? input.activeEpicRun
          : null;
    } else {
      run = latestRunForPlannedEpic(input.runs, input.plannedEpic);
    }
  }
  const epicId = input.plannedEpic?.epicId ?? "";
  let control: PlannedEpicBannerControl;
  let title: string;
  let variant: PlannedEpicBannerModel["variant"];
  if (run === null) {
    control = "start";
    title = `Epic ${epicId} planned`;
    variant = "success";
  } else if (run.status === "running") {
    control = "pause";
    title = `Epic ${epicId} is running`;
    variant = "success";
  } else if (run.status === "paused") {
    control = "resume";
    title = `Epic ${epicId} paused`;
    variant = "warning";
  } else if (run.status === "done") {
    control = "view-only";
    title = `Epic ${epicId} completed`;
    variant = "success";
  } else if (run.status === "failed") {
    control = "restart";
    title = `Epic ${epicId} failed`;
    variant = "error";
  } else {
    control = "restart";
    title = `Epic ${epicId} stopped`;
    variant = "warning";
  }
  // While the banner covers a live run, the composer pill must not duplicate
  // it — but only while the banner is actually visible.
  const suppressRunPill =
    visible &&
    run !== null &&
    (run.status === "running" || run.status === "paused") &&
    input.activeEpicRun !== null &&
    input.activeEpicRun.runId === run.runId;
  return { visible, control, title, run, suppressRunPill, variant };
}
