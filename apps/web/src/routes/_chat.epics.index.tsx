import type { BeadsEpicSummary, BeadsStatusResult, EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertCircleIcon, LayersIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  availableEpicGroups,
  epicCounts,
  epicPresentationStatus,
  epicSourceKey,
  epicStatusLabel,
  uniqueEpicProjectSources,
  type EpicProjectSource,
} from "../epics.logic";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { epicsEnvironment } from "../state/epics";
import { useProjects } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";

function EpicStatus({
  environmentId,
  projectId,
  cwd,
  epic,
  counts,
}: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly cwd: string;
  readonly epic: BeadsEpicSummary;
  readonly counts: ReturnType<typeof epicCounts>;
}) {
  const run = useEnvironmentQuery(
    epicsEnvironment.run({
      environmentId: environmentId as EnvironmentId,
      input: { epicId: epic.id, projectId, cwd },
    }),
  );
  const status = epicPresentationStatus(epic, run.data);
  return (
    <>
      <span
        className={cn(
          "size-2 shrink-0 rounded-full bg-muted-foreground/35",
          status === "running" && "animate-status-pulse bg-success motion-reduce:animate-none",
          status === "blocked" && "bg-destructive",
          status === "done" && "bg-success",
        )}
        aria-hidden
      />
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground sm:flex-row sm:gap-3">
        <span>{status === "running" ? "Running" : epicStatusLabel(epic.status)}</span>
        <span>{counts.ready} ready</span>
        <span className="hidden sm:inline">{counts.blocked} blocked</span>
        <span className="hidden sm:inline">{counts.done} done</span>
      </div>
    </>
  );
}

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

export function EpicsRouteView() {
  const projects = useProjects();
  const newThread = useHandleNewThread();
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
  const [results, setResults] = useState<
    ReadonlyMap<
      string,
      {
        readonly data: BeadsStatusResult | null;
        readonly pending: boolean;
        readonly error: string | null;
      }
    >
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
  const groups = availableEpicGroups(
    sources.map((project) => ({
      project,
      result: results.get(epicSourceKey(project))?.data ?? null,
    })),
  );
  const pending = sources.some((source) => results.get(epicSourceKey(source))?.pending !== false);
  const failedSources = sources.filter((source) => {
    const value = results.get(epicSourceKey(source));
    return value?.error != null || value?.data?._tag === "unavailable";
  });
  const allFailed = sources.length > 0 && failedSources.length === sources.length && !pending;
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
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-4xl">
          <header className="mb-8 flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-muted">
              <LayersIcon className="size-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Epics</h1>
              <p className="text-sm text-muted-foreground">Plan and follow work across projects.</p>
            </div>
          </header>
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
          ) : (
            <div className="space-y-8">
              {failedSources.length > 0 ? (
                <div className="rounded-lg border border-warning/35 bg-warning/8 px-3 py-2 text-sm">
                  Some projects could not load their epics.
                </div>
              ) : null}
              {groups.map(({ project: source, snapshot }) => (
                <section key={epicSourceKey(source)}>
                  <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                    {source.projectTitle}
                  </h2>
                  <div className="overflow-hidden rounded-xl border border-border">
                    {snapshot.epics.map((epic) => {
                      const counts = epicCounts(epic);
                      return (
                        <Link
                          key={epic.id}
                          to="/epics/$environmentId/$epicId"
                          params={{ environmentId: source.environmentId, epicId: epic.id }}
                          search={{ project: source.projectId }}
                          className="flex min-h-20 items-center gap-4 border-b border-border px-4 py-3 last:border-b-0 hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium" title={epic.title}>
                              {epic.title}
                            </div>
                            <div className="mt-1 font-mono text-xs text-muted-foreground">
                              {epic.id}
                            </div>
                          </div>
                          <EpicStatus
                            environmentId={source.environmentId}
                            projectId={source.projectId}
                            cwd={source.workspaceRoot}
                            epic={epic}
                            counts={counts}
                          />
                        </Link>
                      );
                    })}
                  </div>
                </section>
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
