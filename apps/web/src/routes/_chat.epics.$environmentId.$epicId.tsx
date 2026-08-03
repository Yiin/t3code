import type {
  BeadsIssueSummary,
  BeadsStatusResult,
  EnvironmentId,
  EpicRun,
  ProjectId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  LoaderIcon,
  PlayIcon,
  SquareIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  epicChildren,
  epicStatusLabel,
  latestEpicThreadId,
  selectEpicDetail,
  uniqueEpicProjectSources,
} from "../epics.logic";
import {
  currentEpicRunIssue,
  epicRunUiState,
  formatEpicRunElapsed,
  shouldStickToBottom,
} from "../epicRun.logic";
import { epicsEnvironment } from "../state/epics";
import { useProjects } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { SidebarInset } from "../components/ui/sidebar";
import { Skeleton } from "../components/ui/skeleton";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/ui/alert-dialog";
import ChatMarkdown from "../components/ChatMarkdown";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useAtomCommand } from "../state/use-atom-command";

interface DetailSource {
  readonly environmentId: string;
  readonly workspaceRoot: string;
  readonly projectId: string;
  readonly projectTitle: string;
}

function useElapsed(startedAt: string | null, endedAt: string | null) {
  const [now, setNow] = useState(() => (endedAt ? Date.parse(endedAt) : Date.now()));
  useEffect(() => {
    if (startedAt === null) return;
    if (endedAt !== null) {
      setNow(Date.parse(endedAt));
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [endedAt, startedAt]);
  return startedAt ? formatEpicRunElapsed(startedAt, now) : "0:00";
}

function EpicRunLog(props: {
  readonly run: EpicRun;
  readonly environmentId: string;
  readonly cwd: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  useLayoutEffect(() => {
    const viewport = rootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (viewport && followRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [props.run.recentIterations]);

  return (
    <div ref={rootRef} className="h-72 min-w-0">
      <ScrollArea
        className="rounded-lg border border-border bg-muted/20"
        onScrollCapture={(event) => {
          if (event.target instanceof HTMLElement) {
            followRef.current = shouldStickToBottom(event.target);
          }
        }}
      >
        <div className="min-w-0 space-y-3 p-4">
          {props.run.recentIterations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Waiting for the first iteration…</p>
          ) : (
            props.run.recentIterations.map((iteration) => (
              <article
                key={iteration.iterationIndex}
                className="min-w-0 border-b pb-3 last:border-0"
              >
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span>Iteration {iteration.iterationIndex + 1}</span>
                  {iteration.issueId ? (
                    <span className="font-mono">{iteration.issueId}</span>
                  ) : null}
                  <span>{iteration.turnStatus}</span>
                </div>
                {iteration.summary ? (
                  <ChatMarkdown
                    className="mt-2 text-sm"
                    text={iteration.summary}
                    cwd={props.cwd}
                    threadRef={{
                      environmentId: props.environmentId as EnvironmentId,
                      threadId: iteration.threadId,
                    }}
                  />
                ) : null}
                {iteration.why ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                      Why this iteration
                    </summary>
                    <ChatMarkdown
                      className="mt-2 text-sm"
                      text={iteration.why}
                      cwd={props.cwd}
                      threadRef={{
                        environmentId: props.environmentId as EnvironmentId,
                        threadId: iteration.threadId,
                      }}
                    />
                  </details>
                ) : null}
              </article>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function EpicRunSection(props: {
  readonly environmentId: string;
  readonly epicId: string;
  readonly source: DetailSource;
  readonly issues: ReadonlyArray<BeadsIssueSummary>;
  readonly run: EpicRun | null;
}) {
  const launchRun = useAtomCommand(epicsEnvironment.launchRun, { reportFailure: false });
  const stopRun = useAtomCommand(epicsEnvironment.stopRun, { reportFailure: false });
  const [pending, setPending] = useState<"starting" | "stopping" | null>(null);
  const state = epicRunUiState(props.run, pending);
  const terminal = props.run !== null && ["done", "failed", "cancelled"].includes(props.run.status);
  const elapsed = useElapsed(
    props.run?.createdAt ?? null,
    terminal ? (props.run?.updatedAt ?? null) : null,
  );
  const current = props.run ? currentEpicRunIssue(props.run, props.issues) : null;

  useEffect(() => {
    if (pending === "starting" && props.run !== null) setPending(null);
    if (
      pending === "stopping" &&
      props.run !== null &&
      ["done", "failed", "cancelled"].includes(props.run.status)
    ) {
      setPending(null);
    }
  }, [pending, props.run]);

  const reportFailure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag === "Success") return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };
  const start = () => {
    if (state !== "idle") return;
    setPending("starting");
    void launchRun({
      environmentId: props.environmentId as EnvironmentId,
      input: {
        epicId: props.epicId,
        projectId: props.source.projectId as ProjectId,
        cwd: props.source.workspaceRoot,
      },
    }).then((result) => {
      if (result._tag === "Success") return;
      setPending(null);
      reportFailure("Could not start run", result);
    });
  };
  const stop = () => {
    if (!props.run || state === "stopping") return;
    setPending("stopping");
    void stopRun({
      environmentId: props.environmentId as EnvironmentId,
      input: { runId: props.run.runId },
    }).then((result) => {
      if (result._tag === "Success") return;
      setPending(null);
      reportFailure("Could not stop run", result);
    });
  };

  return (
    <section className="mt-8 min-w-0" aria-labelledby="run-heading">
      <span className="sr-only" role="status" aria-live="polite">
        Run status: {state}
      </span>
      <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
        <h2 id="run-heading" className="text-lg font-semibold">
          Run
        </h2>
        {state === "idle" ? (
          <Button size="xl" disabled={pending !== null} onClick={start}>
            <PlayIcon />
            Start run
          </Button>
        ) : null}
      </div>
      {state === "starting" ? (
        <div className="flex min-h-20 items-center gap-2 rounded-xl border px-4 text-sm">
          <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
          Starting run…
        </div>
      ) : props.run ? (
        <div className="min-w-0 space-y-4 rounded-xl border border-border p-4">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {state === "running" || state === "stopping" ? (
                  <span
                    className="size-2 animate-status-pulse rounded-full bg-success motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : null}
                <span className="capitalize">{state}</span>
                <span className="text-muted-foreground">
                  Iteration {Math.min(props.run.iterationsCompleted + 1, props.run.maxIterations)}{" "}
                  of {props.run.maxIterations}
                </span>
                <span className="tabular-nums text-muted-foreground">{elapsed}</span>
              </div>
              {current ? (
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId: props.environmentId, threadId: current.threadId }}
                  className="mt-2 block min-w-0 truncate text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-mono">{current.issue.id}</span> · {current.issue.title}
                </Link>
              ) : null}
            </div>
            {state === "running" || state === "stopping" ? (
              <AlertDialog>
                <AlertDialogTrigger
                  render={
                    <Button
                      className="min-h-11"
                      variant="destructive-outline"
                      disabled={state === "stopping"}
                    />
                  }
                >
                  {state === "stopping" ? (
                    <LoaderIcon className="animate-spin motion-reduce:animate-none" />
                  ) : (
                    <SquareIcon />
                  )}
                  {state === "stopping" ? "Stopping…" : "Stop run"}
                </AlertDialogTrigger>
                <AlertDialogPopup>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Stop this run?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The current orchestration turn will be interrupted.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogClose render={<Button variant="outline" />}>
                      Keep running
                    </AlertDialogClose>
                    <AlertDialogClose render={<Button variant="destructive" onClick={stop} />}>
                      Stop run
                    </AlertDialogClose>
                  </AlertDialogFooter>
                </AlertDialogPopup>
              </AlertDialog>
            ) : null}
          </div>
          {props.run.lastError ? (
            <p
              className="rounded-lg bg-destructive/8 p-3 text-sm text-destructive-foreground"
              role="alert"
            >
              {props.run.lastError}
            </p>
          ) : null}
          <EpicRunLog
            run={props.run}
            environmentId={props.environmentId}
            cwd={props.source.workspaceRoot}
          />
        </div>
      ) : null}
    </section>
  );
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
  const sources = useMemo(
    () =>
      uniqueEpicProjectSources(
        projects
          .filter((project) => project.environmentId === environmentId)
          .map((project) => ({
            environmentId: project.environmentId,
            workspaceRoot: project.workspaceRoot,
            projectId: project.id,
            projectTitle: project.title,
          })),
      ),
    [environmentId, projects],
  );
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
  const match = selectEpicDetail(
    sources.map((project) => ({ project, result: results.get(project.projectId)?.data ?? null })),
    epicId,
    requestedProjectId,
  );
  const pending = sources.some((source) => results.get(source.projectId)?.pending !== false);
  const children = match ? epicChildren(epicId, match.snapshot.issues) : [];
  const runQuery = useEnvironmentQuery(
    match
      ? epicsEnvironment.run({
          environmentId: environmentId as EnvironmentId,
          input: {
            epicId,
            projectId: match.project.projectId,
            cwd: match.project.workspaceRoot,
          },
        })
      : null,
  );

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
                  {match.project.projectTitle} · {epicStatusLabel(match.epic.status)}
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
                    const threadId = latestEpicThreadId(runQuery.data, issue.id);
                    const content = (
                      <>
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
                      </>
                    );
                    return threadId === null ? (
                      <div
                        key={issue.id}
                        className="flex min-h-16 items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                      >
                        {content}
                      </div>
                    ) : (
                      <Link
                        key={issue.id}
                        to="/$environmentId/$threadId"
                        params={{ environmentId, threadId }}
                        className="flex min-h-16 items-center gap-3 border-b border-border px-4 py-3 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset last:border-b-0"
                      >
                        {content}
                      </Link>
                    );
                  })
                )}
              </div>
              <EpicRunSection
                environmentId={environmentId}
                epicId={epicId}
                source={match.project}
                issues={match.snapshot.issues}
                run={runQuery.data}
              />
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
