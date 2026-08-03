import type {
  BeadsStatusResult,
  EnvironmentId,
  EpicRun,
  EpicsGroupingMode,
} from "@t3tools/contracts";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertCircleIcon, ChevronRightIcon, LayersIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { epicSourceKey, uniqueEpicProjectSources, type EpicProjectSource } from "../epics.logic";
import {
  epicGroupCountLabel,
  epicGroupListId,
  epicGroupModels,
  epicSourceFailures,
  resolveEpicProjectGroupCollapsed,
  sortEpicRowsByActivity,
  type EpicGroupModel,
  type EpicRowModel,
  type EpicSourceResult,
} from "../epicsPage.logic";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { epicsEnvironment } from "../state/epics";
import { useProjects } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { useUiStateStore } from "../uiStateStore";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { Skeleton } from "../components/ui/skeleton";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { cn } from "../lib/utils";

/** Stable empty array so a still-loading environment does not rebuild every row. */
const NO_RUNS: ReadonlyArray<EpicRun> = [];

const GROUPING_MODE_ANNOUNCEMENT: Record<EpicsGroupingMode, string> = {
  recency: "Epics sorted by recent activity",
  project: "Epics grouped by project",
};

function ProjectEpicQuery({
  source,
  onResult,
}: {
  readonly source: EpicProjectSource;
  readonly onResult: (
    key: string,
    value: BeadsStatusResult | null,
    pending: boolean,
    error: string | null,
  ) => void;
}) {
  const query = useEnvironmentQuery(
    epicsEnvironment.list({
      environmentId: source.environmentId as EnvironmentId,
      input: { workspaceRoot: source.workspaceRoot },
    }),
  );
  const key = epicSourceKey(source);
  useEffect(
    () => onResult(key, query.data, query.isPending, query.error),
    [key, onResult, query.data, query.error, query.isPending],
  );
  return null;
}

/**
 * One run subscription per environment, not per epic. `allRuns` already carries
 * the whole collection, so every row on the page joins against this one read.
 */
function EnvironmentRunsQuery({
  environmentId,
  onRuns,
}: {
  readonly environmentId: string;
  readonly onRuns: (environmentId: string, runs: ReadonlyArray<EpicRun> | null) => void;
}) {
  const query = useEnvironmentQuery(
    epicsEnvironment.allRuns({ environmentId: environmentId as EnvironmentId, input: {} }),
  );
  useEffect(() => onRuns(environmentId, query.data), [environmentId, onRuns, query.data]);
  return null;
}

export function EpicsEmptyState(props: { readonly canPlan: boolean; readonly onPlan: () => void }) {
  return (
    <Empty className="min-h-96">
      <EmptyHeader>
        <EmptyTitle>No epics yet — plan one</EmptyTitle>
        <EmptyDescription>
          Start a planning thread and turn a larger goal into ready work.
        </EmptyDescription>
        <Button size="sm" onClick={props.onPlan} disabled={!props.canPlan}>
          <PlusIcon className="size-4" />
          Plan an epic
        </Button>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * The two channels render side by side and never derive from each other: the
 * work line reads the epic, the machinery line reads its latest run. An epic
 * whose children all landed shows 9 done AND a Failed pill when that is true.
 */
function EpicRow({
  row,
  showProject,
}: {
  readonly row: EpicRowModel;
  readonly showProject: boolean;
}) {
  const { work, machinery, project } = row;
  return (
    <Link
      to="/epics/$environmentId/$epicId"
      params={{ environmentId: project.environmentId, epicId: work.epicId }}
      search={{ project: project.projectId }}
      className="flex min-h-20 items-center gap-4 border-b border-border px-4 py-3 last:border-b-0 hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full bg-muted-foreground/35",
              work.tone === "blocked" && "bg-destructive",
              work.tone === "done" && "bg-success",
            )}
            aria-hidden
          />
          <span className="truncate font-medium" title={work.title}>
            {work.title}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{work.epicId}</span>
          {showProject ? (
            <span className="truncate rounded-full bg-muted px-2 py-0.5">
              {project.projectTitle}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          {machinery.pill === null ? (
            <span>{machinery.emptyLabel}</span>
          ) : (
            <>
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  machinery.pill.dotClass,
                  machinery.pill.pulse && "animate-status-pulse motion-reduce:animate-none",
                )}
                aria-hidden
              />
              <span className={machinery.pill.colorClass}>{machinery.pill.label}</span>
            </>
          )}
          {machinery.updatedAt === null ? null : (
            <span>{formatRelativeTimeLabel(machinery.updatedAt)}</span>
          )}
          {machinery.runCount > 1 ? <span>{machinery.runCount} runs</span> : null}
        </div>
        <div className="flex items-center gap-3">
          <span>{work.statusLabel}</span>
          <span>{work.counts.ready} ready</span>
          <span className="hidden sm:inline">{work.counts.blocked} blocked</span>
          <span className="hidden sm:inline">{work.counts.done} done</span>
        </div>
      </div>
    </Link>
  );
}

function EpicRowList({
  rows,
  showProject,
  id,
}: {
  readonly rows: ReadonlyArray<EpicRowModel>;
  readonly showProject: boolean;
  readonly id?: string;
}) {
  return (
    <div id={id} className="overflow-hidden rounded-xl border border-border">
      {rows.map((row) => (
        <EpicRow key={row.key} row={row} showProject={showProject} />
      ))}
    </div>
  );
}

/**
 * A project group whose header carries everything the rows would have told you.
 * Collapsing hides rows, so the loudest run in the group, its ready count and
 * when it last moved all move up to the header — a group that is pulsing red
 * inside must pulse on the line you can still see.
 *
 * The header is one real button: Enter and Space toggle it natively and focus
 * stays where it was, so toggling never walks the user into the group. Collapsed
 * rows unmount rather than hide, keeping Tab order and screen-reader row counts
 * equal to what is on screen.
 */
export function EpicProjectGroupSection({
  group,
  collapsed,
  onToggle,
}: {
  readonly group: EpicGroupModel;
  readonly collapsed: boolean;
  readonly onToggle: (groupKey: string, collapsed: boolean) => void;
}) {
  const listId = epicGroupListId(group.key);
  const { pill } = group;
  return (
    <section>
      {/* The toggle lives inside the heading so jumping by heading still finds
          the project, and the heading itself is what you press to collapse it. */}
      <h2 className="mb-3">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={listId}
          data-testid={`${listId}-toggle`}
          onClick={() => onToggle(group.key, !collapsed)}
          className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm text-muted-foreground hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 transition-transform", !collapsed && "rotate-90")}
          />
          <span className="truncate font-medium text-foreground/90">
            {group.project.projectTitle}
          </span>
          <span className="shrink-0 tabular-nums text-xs">
            {epicGroupCountLabel(group.epicCount)}
          </span>
          {pill === null ? null : (
            <span
              className={cn(
                "flex shrink-0 items-center gap-1 text-xs font-medium",
                pill.colorClass,
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  pill.dotClass,
                  pill.pulse && "animate-status-pulse motion-reduce:animate-none",
                )}
              />
              {pill.label}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-3 text-xs">
            <span className="tabular-nums">{group.readyCount} ready</span>
            {group.activityAt === null ? null : (
              <span>{formatRelativeTimeLabel(group.activityAt)}</span>
            )}
          </span>
        </button>
      </h2>
      {collapsed ? null : <EpicRowList id={listId} rows={group.rows} showProject={false} />}
    </section>
  );
}

export function EpicsRouteView() {
  const projects = useProjects();
  const newThread = useHandleNewThread();
  const groupingMode = useClientSettings((settings) => settings.epicsGroupingMode);
  const updateSettings = useUpdateClientSettings();
  /** Read, never written, when the mode changes: switching to Recent and back
      must find the groups exactly as the user left them. */
  const collapsedGroups = useUiStateStore((state) => state.epicsProjectGroupCollapsedByKey);
  const setGroupCollapsed = useUiStateStore((state) => state.setEpicsProjectGroupCollapsed);
  const sources = useMemo(
    () =>
      uniqueEpicProjectSources(
        projects.map((project) => ({
          environmentId: project.environmentId,
          workspaceRoot: project.workspaceRoot,
          projectId: project.id,
          projectTitle: project.title,
        })),
      ),
    [projects],
  );
  const environmentIds = useMemo(
    () => [...new Set(sources.map((source) => source.environmentId))],
    [sources],
  );
  const [results, setResults] = useState<
    ReadonlyMap<string, EpicSourceResult & { readonly pending: boolean }>
  >(() => new Map());
  const onResult = useCallback(
    (key: string, data: BeadsStatusResult | null, pending: boolean, error: string | null) => {
      setResults((current) => {
        const previous = current.get(key);
        if (previous?.data === data && previous.pending === pending && previous.error === error)
          return current;
        const next = new Map(current);
        next.set(key, { data, pending, error });
        return next;
      });
    },
    [],
  );
  const [runsByEnvironment, setRunsByEnvironment] = useState<
    ReadonlyMap<string, ReadonlyArray<EpicRun>>
  >(() => new Map());
  const onRuns = useCallback((environmentId: string, runs: ReadonlyArray<EpicRun> | null) => {
    setRunsByEnvironment((current) => {
      const next = runs ?? NO_RUNS;
      if (current.get(environmentId) === next) return current;
      const updated = new Map(current);
      updated.set(environmentId, next);
      return updated;
    });
  }, []);

  const groups = epicGroupModels({ sources, results, runsByEnvironment });
  const recentRows = sortEpicRowsByActivity(groups.flatMap((group) => group.rows));
  const pending = sources.some((source) => results.get(epicSourceKey(source))?.pending !== false);
  const failures = epicSourceFailures(sources, results);
  const allFailed = sources.length > 0 && failures.length === sources.length && !pending;
  const startPlanning = useCallback(() => {
    if (!newThread.defaultProjectRef) return;
    void newThread.handleNewThread(newThread.defaultProjectRef, {
      initialPrompt: "/plan-epic ",
    });
  }, [newThread]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      {sources.map((source) => (
        <ProjectEpicQuery key={epicSourceKey(source)} source={source} onResult={onResult} />
      ))}
      {environmentIds.map((environmentId) => (
        <EnvironmentRunsQuery key={environmentId} environmentId={environmentId} onRuns={onRuns} />
      ))}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-4xl">
          <header className="mb-8 flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-muted">
              <LayersIcon className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold">Epics</h1>
              <p className="text-sm text-muted-foreground">Plan and follow work across projects.</p>
            </div>
            <ToggleGroup
              className="shrink-0"
              variant="outline"
              size="xs"
              aria-label="Epic list grouping"
              value={[groupingMode]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "recency" || next === "project") {
                  updateSettings({ epicsGroupingMode: next });
                }
              }}
            >
              <Toggle value="recency" aria-label="Sort epics by recent activity">
                Recent
              </Toggle>
              <Toggle value="project" aria-label="Group epics by project">
                By project
              </Toggle>
            </ToggleGroup>
          </header>
          <span className="sr-only" role="status" aria-live="polite">
            {GROUPING_MODE_ANNOUNCEMENT[groupingMode]}
          </span>
          {failures.length > 0 && !allFailed ? (
            <div className="mb-6 rounded-lg border border-warning/35 bg-warning/8 px-3 py-2 text-sm">
              <p>Some projects could not load their epics.</p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {failures.map((failure) => (
                  <li key={failure.key}>
                    <span className="text-foreground">{failure.project.projectTitle}</span> —{" "}
                    {failure.label}
                    {failure.detail === null ? null : `: ${failure.detail}`}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {pending && groups.length === 0 ? (
            <div className="space-y-3" aria-label="Loading epics">
              {[0, 1, 2].map((row) => (
                <Skeleton key={row} className="h-20 w-full rounded-xl" />
              ))}
            </div>
          ) : allFailed ? (
            <Empty className="min-h-96">
              <EmptyHeader>
                <AlertCircleIcon className="mx-auto size-6 text-warning" />
                <EmptyTitle>Epics are unavailable</EmptyTitle>
                <EmptyDescription>
                  Beads could not be read for the projects in this environment. Check the project
                  connection and try again.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : groups.length === 0 ? (
            <EpicsEmptyState
              canPlan={newThread.defaultProjectRef !== null}
              onPlan={startPlanning}
            />
          ) : groupingMode === "recency" ? (
            <EpicRowList rows={recentRows} showProject />
          ) : (
            <div className="space-y-8">
              {groups.map((group) => (
                <EpicProjectGroupSection
                  key={group.key}
                  group={group}
                  collapsed={resolveEpicProjectGroupCollapsed({
                    override: collapsedGroups[group.key],
                  })}
                  onToggle={setGroupCollapsed}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/epics/")({
  component: EpicsRouteView,
});
