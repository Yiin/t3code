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
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  LoaderIcon,
  PauseIcon,
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
  epicRunHistory,
  epicRunHistoryHasRun,
  epicRunIterationCountLabel,
  epicRunIterationDuration,
  epicRunUiState,
  epicRuntimeModeLabel,
  epicStartControl,
  formatEpicRunElapsed,
  isTerminalEpicRunStatus,
  shouldStickToBottom,
  type EpicRunHistory,
  type EpicRunPendingAction,
} from "../epicRun.logic";
import { resolveEpicRunStatusPill } from "../components/Sidebar.logic";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { cn } from "../lib/utils";
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

/** Ticks once a second only while something on screen is still running. */
function useNowMs(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function EpicRunPill(props: { readonly run: EpicRun }) {
  const pill = resolveEpicRunStatusPill(props.run.status);
  if (pill === null) return null;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", pill.colorClass)}>
      <span
        className={cn(
          "size-2 rounded-full",
          pill.dotClass,
          pill.pulse && "animate-status-pulse motion-reduce:animate-none",
        )}
        aria-hidden="true"
      />
      {pill.label}
    </span>
  );
}

/**
 * How the run was configured, plus a way back to the thread that launched it.
 * All of it already rides the contract and none of it was on screen.
 */
function EpicRunMetaLine(props: { readonly run: EpicRun; readonly environmentId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="font-mono">{props.run.modelSelection.model}</span>
      <span aria-hidden="true">·</span>
      <span>{epicRuntimeModeLabel(props.run.runtimeMode)}</span>
      {props.run.originThreadId ? (
        <>
          <span aria-hidden="true">·</span>
          <Link
            to="/$environmentId/$threadId"
            params={{
              environmentId: props.environmentId,
              threadId: props.run.originThreadId,
            }}
            className="text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Launched from thread
          </Link>
        </>
      ) : null}
    </div>
  );
}

function EpicRunLog(props: {
  readonly run: EpicRun;
  readonly environmentId: string;
  readonly cwd: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const now = useNowMs(props.run.recentIterations.some((entry) => entry.finishedAt === null));
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
                  <span className="tabular-nums">{epicRunIterationDuration(iteration, now)}</span>
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

/**
 * One earlier run, collapsed to a line. Expanding mounts its log; collapsing
 * unmounts it, so Tab order matches what is on screen.
 */
function EpicRunHistoryEntry(props: {
  readonly run: EpicRun;
  readonly environmentId: string;
  readonly cwd: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const endedAt = formatRelativeTimeLabel(props.run.updatedAt);
  return (
    <div className="min-w-0 rounded-xl border border-border">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-4 py-3 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <ChevronRightIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            expanded && "rotate-90",
          )}
          aria-hidden="true"
        />
        <EpicRunPill run={props.run} />
        <span className="text-sm text-muted-foreground">
          {epicRunIterationCountLabel(props.run.iterationsCompleted)}
        </span>
        <span className="tabular-nums text-sm text-muted-foreground">
          {formatEpicRunElapsed(props.run.createdAt, Date.parse(props.run.updatedAt))}
        </span>
        {endedAt ? <span className="text-sm text-muted-foreground">ended {endedAt}</span> : null}
      </button>
      {expanded ? (
        <div className="min-w-0 space-y-3 border-t border-border p-4">
          <EpicRunMetaLine run={props.run} environmentId={props.environmentId} />
          {props.run.lastError ? (
            <p className="rounded-lg bg-destructive/8 p-3 text-sm text-destructive-foreground">
              {props.run.lastError}
            </p>
          ) : null}
          <EpicRunLog run={props.run} environmentId={props.environmentId} cwd={props.cwd} />
        </div>
      ) : null}
    </div>
  );
}

function EpicRunSection(props: {
  readonly environmentId: string;
  readonly epicId: string;
  readonly source: DetailSource;
  readonly issues: ReadonlyArray<BeadsIssueSummary>;
  readonly history: EpicRunHistory;
}) {
  const launchRun = useAtomCommand(epicsEnvironment.launchRun, { reportFailure: false });
  const pauseRun = useAtomCommand(epicsEnvironment.pauseRun, { reportFailure: false });
  const resumeRun = useAtomCommand(epicsEnvironment.resumeRun, { reportFailure: false });
  const stopRun = useAtomCommand(epicsEnvironment.stopRun, { reportFailure: false });
  const [pending, setPending] = useState<EpicRunPendingAction | null>(null);
  // The run a launch answered with, awaited so a repeat's pending start clears
  // on the new run arriving rather than on the old terminal one still being there.
  const [startedRunId, setStartedRunId] = useState<string | null>(null);
  const run = props.history.latest;
  const state = epicRunUiState(run, pending);
  const startControl = epicStartControl(run, state);
  const terminal = run !== null && isTerminalEpicRunStatus(run.status);
  const elapsed = useElapsed(run?.createdAt ?? null, terminal ? (run?.updatedAt ?? null) : null);
  const current = run ? currentEpicRunIssue(run, props.issues) : null;
  const history = props.history;

  useEffect(() => {
    if (
      pending === "starting" &&
      startedRunId !== null &&
      epicRunHistoryHasRun(history, startedRunId)
    ) {
      setPending(null);
      setStartedRunId(null);
    }
    if (pending === "stopping" && run !== null && isTerminalEpicRunStatus(run.status)) {
      setPending(null);
    }
    // Pause and resume clear as soon as the run leaves the state they acted
    // on, including when it ends underneath them.
    if (pending === "pausing" && run?.status !== "running") setPending(null);
    if (pending === "resuming" && run?.status !== "paused") setPending(null);
  }, [history, pending, run, startedRunId]);

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
    if (startControl === null || startControl.busy) return;
    setPending("starting");
    setStartedRunId(null);
    void launchRun({
      environmentId: props.environmentId as EnvironmentId,
      input: {
        epicId: props.epicId,
        projectId: props.source.projectId as ProjectId,
        cwd: props.source.workspaceRoot,
      },
    }).then((result) => {
      if (result._tag === "Success") {
        setStartedRunId(result.value.runId);
        return;
      }
      setPending(null);
      reportFailure("Could not start run", result);
    });
  };
  const stop = () => {
    if (!run || state === "stopping") return;
    setPending("stopping");
    void stopRun({
      environmentId: props.environmentId as EnvironmentId,
      input: { runId: run.runId },
    }).then((result) => {
      if (result._tag === "Success") return;
      setPending(null);
      reportFailure("Could not stop run", result);
    });
  };
  // Pause and resume are reversible, so they act on click with no dialog. A
  // stale button loses the race as a typed 409, which lands as a toast.
  const pause = () => {
    if (!run || state !== "running" || pending !== null) return;
    setPending("pausing");
    void pauseRun({
      environmentId: props.environmentId as EnvironmentId,
      input: { runId: run.runId },
    }).then((result) => {
      if (result._tag === "Success") return;
      setPending(null);
      reportFailure("Could not pause run", result);
    });
  };
  const resume = () => {
    // A pause still draining its iteration resumes too — the server hands the
    // run back to the loop that is finishing it.
    if (!run || (state !== "paused" && state !== "pausing") || pending !== null) return;
    setPending("resuming");
    void resumeRun({
      environmentId: props.environmentId as EnvironmentId,
      input: { runId: run.runId },
    }).then((result) => {
      if (result._tag === "Success") return;
      setPending(null);
      reportFailure("Could not resume run", result);
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
        {startControl ? (
          <Button size="xl" disabled={startControl.busy} onClick={start}>
            {startControl.busy ? (
              <LoaderIcon className="animate-spin motion-reduce:animate-none" />
            ) : (
              <PlayIcon />
            )}
            {startControl.label}
          </Button>
        ) : null}
      </div>
      {state === "starting" && run === null ? (
        <div className="flex min-h-20 items-center gap-2 rounded-xl border px-4 text-sm">
          <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
          Starting run…
        </div>
      ) : run ? (
        <div className="min-w-0 space-y-4 rounded-xl border border-border p-4">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {state === "stopping" || state === "pausing" ? (
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <LoaderIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
                    {state === "stopping" ? "Stopping" : "Pausing"}
                  </span>
                ) : (
                  <EpicRunPill run={run} />
                )}
                <span className="text-muted-foreground">
                  Iteration {Math.min(run.iterationsCompleted + 1, run.maxIterations)} of{" "}
                  {run.maxIterations}
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
            {state === "running" ||
            state === "pausing" ||
            state === "paused" ||
            state === "stopping" ? (
              <div className="flex flex-wrap items-center gap-2">
                {state === "pausing" || state === "paused" ? (
                  <Button
                    className="min-h-11"
                    variant="outline"
                    disabled={pending !== null}
                    onClick={resume}
                  >
                    {pending === "resuming" ? (
                      <LoaderIcon className="animate-spin motion-reduce:animate-none" />
                    ) : (
                      <PlayIcon />
                    )}
                    {pending === "resuming" ? "Resuming…" : "Resume run"}
                  </Button>
                ) : null}
                {state === "running" ? (
                  <Button
                    className="min-h-11"
                    variant="outline"
                    disabled={pending !== null}
                    onClick={pause}
                  >
                    {pending === "pausing" ? (
                      <LoaderIcon className="animate-spin motion-reduce:animate-none" />
                    ) : (
                      <PauseIcon />
                    )}
                    {pending === "pausing" ? "Pausing…" : "Pause run"}
                  </Button>
                ) : null}
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
                        The current orchestration turn is interrupted and cannot be resumed.
                        Completed iterations and their threads are kept.
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
              </div>
            ) : null}
          </div>
          <EpicRunMetaLine run={run} environmentId={props.environmentId} />
          {run.lastError ? (
            <p
              className="rounded-lg bg-destructive/8 p-3 text-sm text-destructive-foreground"
              role="alert"
            >
              {run.lastError}
            </p>
          ) : null}
          <EpicRunLog
            run={run}
            environmentId={props.environmentId}
            cwd={props.source.workspaceRoot}
          />
        </div>
      ) : null}
      {props.history.prior.length > 0 ? (
        <div className="mt-4 min-w-0 space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">
            Earlier runs ({props.history.prior.length})
          </h3>
          {props.history.prior.map((prior) => (
            <EpicRunHistoryEntry
              key={prior.runId}
              run={prior}
              environmentId={props.environmentId}
              cwd={props.source.workspaceRoot}
            />
          ))}
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
  // One subscription for every run in the environment, narrowed to this epic
  // below — the per-epic `run` atom only ever surfaced the latest one, which is
  // what made a page of five runs look like a page of one.
  const runsQuery = useEnvironmentQuery(
    epicsEnvironment.allRuns({ environmentId: environmentId as EnvironmentId, input: {} }),
  );
  const runs = runsQuery.data;
  const projectId = match?.project.projectId ?? null;
  const workspaceRoot = match?.project.workspaceRoot ?? null;
  const history = useMemo<EpicRunHistory>(
    () =>
      projectId === null || workspaceRoot === null
        ? { latest: null, prior: [] }
        : epicRunHistory(runs ?? [], { epicId, projectId, cwd: workspaceRoot }),
    [epicId, projectId, runs, workspaceRoot],
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
                    const threadId = latestEpicThreadId(history.latest, issue.id);
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
                history={history}
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
