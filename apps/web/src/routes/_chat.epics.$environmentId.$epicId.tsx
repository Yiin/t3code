import type { BeadsStatusResult, EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, CircleAlertIcon, CircleDashedIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { epicChildren, epicStatusLabel, uniqueEpicProjectSources } from "../epics.logic";
import { epicsEnvironment } from "../state/epics";
import { useProjects } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { SidebarInset } from "../components/ui/sidebar";
import { Skeleton } from "../components/ui/skeleton";

interface DetailSource {
  readonly environmentId: string;
  readonly workspaceRoot: string;
  readonly projectId: string;
  readonly projectTitle: string;
}

function EpicDetailQuery(props: {
  readonly source: DetailSource;
  readonly onResult: (
    projectId: string,
    result: BeadsStatusResult | null,
    pending: boolean,
  ) => void;
}) {
  const query = useEnvironmentQuery(
    epicsEnvironment.list({
      environmentId: props.source.environmentId as EnvironmentId,
      input: { workspaceRoot: props.source.workspaceRoot },
    }),
  );
  useEffect(
    () => props.onResult(props.source.projectId, query.data, query.isPending),
    [props.onResult, props.source.projectId, query.data, query.isPending],
  );
  return null;
}

function EpicDetailRouteView() {
  const { environmentId, epicId } = Route.useParams();
  const { project: requestedProjectId } = Route.useSearch();
  const projects = useProjects();
  const sources = useMemo(() => {
    const matches = uniqueEpicProjectSources(
      projects
        .filter((project) => project.environmentId === environmentId)
        .map((project) => ({
          environmentId: project.environmentId,
          workspaceRoot: project.workspaceRoot,
          projectId: project.id,
          projectTitle: project.title,
        })),
    );
    return requestedProjectId
      ? [...matches].sort((a, b) =>
          a.projectId === requestedProjectId ? -1 : b.projectId === requestedProjectId ? 1 : 0,
        )
      : matches;
  }, [environmentId, projects, requestedProjectId]);
  const [results, setResults] = useState<
    ReadonlyMap<string, { readonly data: BeadsStatusResult | null; readonly pending: boolean }>
  >(() => new Map());
  const onResult = useCallback(
    (projectId: string, data: BeadsStatusResult | null, pending: boolean) => {
      setResults((current) => {
        const previous = current.get(projectId);
        if (previous?.data === data && previous.pending === pending) return current;
        const next = new Map(current);
        next.set(projectId, { data, pending });
        return next;
      });
    },
    [],
  );
  const match = sources
    .map((source) => {
      const data = results.get(source.projectId)?.data;
      const snapshot = data?._tag === "available" ? data : null;
      const epic = snapshot?.epics.find((candidate) => candidate.id === epicId) ?? null;
      return epic && snapshot ? { source, snapshot, epic } : null;
    })
    .find((entry) => entry !== null);
  const pending = sources.some((source) => results.get(source.projectId)?.pending !== false);
  const children = match ? epicChildren(epicId, match.snapshot.issues) : [];

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      {sources.map((source) => (
        <EpicDetailQuery key={source.projectId} source={source} onResult={onResult} />
      ))}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-8">
        <main className="mx-auto max-w-3xl">
          <Link
            to="/epics"
            className="mb-6 inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon className="size-4" />
            All epics
          </Link>
          {pending && !match ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-2/3" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : match ? (
            <>
              <div className="mb-8">
                <div className="font-mono text-xs text-muted-foreground">{match.epic.id}</div>
                <h1 className="mt-2 text-2xl font-semibold">{match.epic.title}</h1>
                <div className="mt-2 text-sm text-muted-foreground">
                  {match.source.projectTitle} · {epicStatusLabel(match.epic.status)}
                </div>
              </div>
              <div className="overflow-hidden rounded-xl border border-border">
                {children.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                    This epic has no child issues yet.
                  </p>
                ) : (
                  children.map((issue) => {
                    const done = issue.status === "closed" || issue.status === "done";
                    const blocked = issue.blockedBy.length > 0 || issue.status === "blocked";
                    const Icon = done ? CheckIcon : blocked ? CircleAlertIcon : CircleDashedIcon;
                    return (
                      <div
                        key={issue.id}
                        className="flex min-h-16 items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                      >
                        <span
                          className={
                            done
                              ? "flex size-6 items-center justify-center rounded-full bg-success/10 text-success"
                              : blocked
                                ? "flex size-6 items-center justify-center rounded-full bg-destructive/10 text-destructive"
                                : "flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground"
                          }
                        >
                          <Icon className="size-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium" title={issue.title}>
                            {issue.title}
                          </div>
                          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                            {issue.id} · {epicStatusLabel(issue.status)}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-border px-6 py-12 text-center">
              <h1 className="font-medium">Epic unavailable</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                It may belong to another project or Beads may be unavailable.
              </p>
            </div>
          )}
        </main>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/epics/$environmentId/$epicId")({
  validateSearch: (search: Record<string, unknown>) => ({
    project: typeof search.project === "string" ? search.project : undefined,
  }),
  component: EpicDetailRouteView,
});
