import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { BeadsStatusResult, EnvironmentId, EpicRun, ProjectId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  Animated,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SymbolView } from "../../components/AppSymbol";
import { useProjects } from "../../state/entities";
import { epicsEnvironment } from "../../state/epics";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  boundedRunLog,
  epicChildren,
  epicLoadState,
  epicProgress,
  epicRunUiState,
  isActiveRun,
  issueStatusLabel,
  latestEpicThreadId,
  pendingAfterCommandResult,
  epicSourceKey,
  selectEpicDetail,
  uniqueEpicProjectSources,
  type EpicProjectSource,
  type EpicSourceResult,
} from "./epics.logic";

function SourceQuery(props: {
  readonly source: EpicProjectSource;
  readonly onChange: (
    source: EpicProjectSource,
    result: BeadsStatusResult | null,
    error: string | null,
    pending: boolean,
    refresh: () => void,
  ) => void;
}) {
  const query = useEnvironmentQuery(
    epicsEnvironment.list({
      environmentId: props.source.environmentId as EnvironmentId,
      input: { workspaceRoot: props.source.workspaceRoot },
    }),
  );
  const onChange = props.onChange;
  const source = props.source;
  useEffect(
    () => onChange(source, query.data, query.error, query.isPending, query.refresh),
    [onChange, query.data, query.error, query.isPending, query.refresh, source],
  );
  return null;
}

function RunsQuery(props: {
  readonly environmentId: string;
  readonly onChange: (environmentId: string, runs: ReadonlyArray<EpicRun>) => void;
}) {
  const query = useEnvironmentQuery(
    epicsEnvironment.allRuns({
      environmentId: props.environmentId as EnvironmentId,
      input: {},
    }),
  );
  const environmentId = props.environmentId;
  const onChange = props.onChange;
  useEffect(() => {
    if (query.data) onChange(environmentId, query.data);
  }, [environmentId, onChange, query.data]);
  return null;
}

function useEpicSources() {
  const projects = useProjects();
  const sources = useMemo(
    () =>
      uniqueEpicProjectSources(
        projects.map((project) => ({
          environmentId: String(project.environmentId),
          workspaceRoot: project.workspaceRoot,
          projectId: String(project.id),
          projectTitle: project.title,
        })),
      ),
    [projects],
  );
  const [results, setResults] = useState<ReadonlyMap<string, EpicSourceResult>>(() => new Map());
  const onChange = useCallback(
    (
      project: EpicProjectSource,
      result: BeadsStatusResult | null,
      error: string | null,
      pending: boolean,
      refresh: () => void,
    ) => {
      setResults((current) => {
        const key = epicSourceKey(project);
        const previous = current.get(key);
        if (
          previous?.result === result &&
          previous.error === error &&
          previous.pending === pending &&
          previous.refresh === refresh
        ) {
          return current;
        }
        const next = new Map(current);
        next.set(key, { project, result, error, pending, refresh });
        return next;
      });
    },
    [],
  );
  return {
    sources,
    results: sources.map(
      (project) => results.get(epicSourceKey(project)) ?? { project, result: null, pending: true },
    ),
    queries: sources.map((source) => (
      <SourceQuery
        key={`${source.environmentId}:${source.workspaceRoot}`}
        source={source}
        onChange={onChange}
      />
    )),
  };
}

function ActiveRunIndicator() {
  const opacity = useMemo(() => new Animated.Value(1), []);
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (!cancelled) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (enabled) => {
      setReduceMotion(enabled);
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    if (reduceMotion) {
      opacity.stopAnimation();
      opacity.setValue(1);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => {
      animation.stop();
      opacity.setValue(1);
    };
  }, [opacity, reduceMotion]);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no"
      className="size-2 rounded-full bg-success"
      style={{ opacity }}
    />
  );
}

export function EpicsListScreen() {
  const navigation = useNavigation();
  const { sources, results, queries } = useEpicSources();
  const [runsByEnvironment, setRunsByEnvironment] = useState<
    ReadonlyMap<string, ReadonlyArray<EpicRun>>
  >(() => new Map());
  const onRuns = useCallback((environmentId: string, runs: ReadonlyArray<EpicRun>) => {
    setRunsByEnvironment((current) => new Map(current).set(environmentId, runs));
  }, []);
  const load = epicLoadState(results);
  const rows = results.flatMap((source) =>
    source.result?._tag === "available"
      ? source.result.epics.map((epic) => ({ source: source.project, epic }))
      : [],
  );

  return (
    <View className="flex-1 bg-background">
      {queries}
      {[...new Set(sources.map((source) => source.environmentId))].map((environmentId) => (
        <RunsQuery key={environmentId} environmentId={environmentId} onChange={onRuns} />
      ))}
      {load.partialFailed ? (
        <View className="px-4 pt-3">
          <ErrorBanner message="Some projects could not load. Showing the epics that are available." />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry failed epic projects"
            className="min-h-11 justify-center"
            onPress={() =>
              results
                .filter((source) => source.error || source.result?._tag === "unavailable")
                .forEach((source) => source.refresh?.())
            }
          >
            <Text className="font-t3-bold text-primary">Retry</Text>
          </Pressable>
        </View>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(row) =>
          `${row.source.environmentId}:${row.source.workspaceRoot}:${row.epic.id}`
        }
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="px-4 pb-8"
        ListEmptyComponent={
          load.pending > 0 ? (
            <View className="gap-3 py-6">
              {[0, 1, 2].map((key) => (
                <View key={key} className="h-20 rounded-2xl bg-card" />
              ))}
            </View>
          ) : load.allFailed ? (
            <EmptyState
              title="Epics unavailable"
              detail="Beads could not be read from any project."
              actionLabel="Retry"
              onAction={() => results.forEach((source) => source.refresh?.())}
              variant="plain"
            />
          ) : (
            <EmptyState
              title="No epics yet"
              detail="Plan an epic to break a larger change into runnable work."
              actionLabel="Plan one"
              onAction={() =>
                navigation.navigate("NewTaskSheet", {
                  screen: "NewTaskDraft",
                  params: {
                    initialPrompt: "/plan-epic ",
                    initialPromptRequestId: String(Date.now()),
                  },
                })
              }
              variant="plain"
            />
          )
        }
        renderItem={({ item, index }) => {
          const progress = epicProgress(item.epic);
          const active = (runsByEnvironment.get(item.source.environmentId) ?? []).some(
            (run) =>
              run.epicId === item.epic.id &&
              run.projectId === item.source.projectId &&
              run.cwd === item.source.workspaceRoot &&
              isActiveRun(run),
          );
          const previous = rows[index - 1];
          const showHeader =
            !previous ||
            previous.source.environmentId !== item.source.environmentId ||
            previous.source.workspaceRoot !== item.source.workspaceRoot;
          return (
            <>
              {showHeader ? (
                <Text className="pb-2 pt-5 text-xs font-t3-bold uppercase tracking-wide text-foreground-muted">
                  {item.source.projectTitle}
                </Text>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${item.epic.title}, ${progress.done} of ${progress.total} complete${active ? ", run active" : ""}`}
                accessibilityHint="Opens epic details"
                className="mb-2 min-h-20 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 active:opacity-70"
                onPress={() => {
                  void Haptics.selectionAsync();
                  navigation.navigate("EpicDetail", {
                    environmentId: item.source.environmentId,
                    epicId: item.epic.id,
                    projectId: item.source.projectId,
                  });
                }}
              >
                {active ? (
                  <ActiveRunIndicator />
                ) : (
                  <View className="size-2 rounded-full bg-border" />
                )}
                <View className="min-w-0 flex-1">
                  <Text className="text-base font-t3-bold">{item.epic.title}</Text>
                  <Text className="mt-1 text-sm text-foreground-muted">
                    {progress.done}/{progress.total} complete
                    {active ? " · Run active" : ""}
                  </Text>
                </View>
                <SymbolView name="chevron.right" size={18} tintColor="#8e8e93" />
              </Pressable>
            </>
          );
        }}
      />
    </View>
  );
}

type DetailParams = {
  readonly environmentId: string;
  readonly epicId: string;
  readonly projectId?: string;
};

function formatElapsed(startedAt: string, endedAt: string | null): string {
  const seconds = Math.max(
    0,
    Math.floor(((endedAt ? Date.parse(endedAt) : Date.now()) - Date.parse(startedAt)) / 1000),
  );
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function EpicDetailScreen({ route }: StaticScreenProps<DetailParams>) {
  const navigation = useNavigation();
  const primaryForeground = useThemeColor("--color-primary-foreground");
  const params = route.params;
  const { results, queries } = useEpicSources();
  const environmentResults = results.filter(
    (source) => source.project.environmentId === params.environmentId,
  );
  const match = selectEpicDetail(environmentResults, params.epicId, params.projectId);
  const pending = environmentResults.some((source) => source.pending);
  const runQuery = useEnvironmentQuery(
    match
      ? epicsEnvironment.run({
          environmentId: params.environmentId as EnvironmentId,
          input: {
            epicId: params.epicId,
            projectId: match.project.projectId,
            cwd: match.project.workspaceRoot,
          },
        })
      : null,
  );
  const launchRun = useAtomCommand(epicsEnvironment.launchRun, { reportFailure: false });
  const stopRun = useAtomCommand(epicsEnvironment.stopRun, { reportFailure: false });
  const [optimistic, setOptimistic] = useState<"starting" | "stopping" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const run = runQuery.data;
  const uiState = epicRunUiState(run, optimistic);
  useNow(uiState === "running" || uiState === "paused" || uiState === "stopping");
  useEffect(() => {
    if (optimistic === "starting" && run && isActiveRun(run)) setOptimistic(null);
    if (optimistic === "stopping" && run && ["done", "failed", "cancelled"].includes(run.status)) {
      setOptimistic(null);
    }
  }, [optimistic, run]);

  const fail = (result: Awaited<ReturnType<typeof launchRun>>) => {
    if (result._tag === "Success") return;
    if (isAtomCommandInterrupted(result)) {
      setOptimistic((pending) =>
        pending ? pendingAfterCommandResult(pending, "interrupted") : null,
      );
      return;
    }
    const cause = squashAtomCommandFailure(result);
    setActionError(cause instanceof Error ? cause.message : "The run action failed.");
    setOptimistic((pending) => (pending ? pendingAfterCommandResult(pending, "failure") : null));
  };
  const start = () => {
    if (!match || uiState !== "idle") return;
    void Haptics.selectionAsync();
    setActionError(null);
    setOptimistic("starting");
    void launchRun({
      environmentId: params.environmentId as EnvironmentId,
      input: {
        epicId: params.epicId,
        projectId: match.project.projectId as ProjectId,
        cwd: match.project.workspaceRoot,
      },
    }).then(fail);
  };
  const stop = () => {
    if (!run || optimistic === "stopping") return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    setActionError(null);
    setOptimistic("stopping");
    void stopRun({
      environmentId: params.environmentId as EnvironmentId,
      input: { runId: run.runId },
    }).then(fail);
  };
  const confirmStop = () =>
    Alert.alert("Stop this run?", "The current orchestration turn will be interrupted.", [
      { text: "Keep running", style: "cancel" },
      { text: "Stop run", style: "destructive", onPress: stop },
    ]);
  const refreshAll = () => {
    environmentResults.forEach((source) => source.refresh?.());
    runQuery.refresh();
  };
  const sourceFailure = environmentResults.find(
    (source) => source.error || source.result?._tag === "unavailable",
  );
  const sourceFailureDetail = sourceFailure
    ? (sourceFailure.error ??
      (sourceFailure.result?._tag === "unavailable"
        ? (sourceFailure.result.detail ?? "Beads is unavailable for this project.")
        : "The project could not be loaded."))
    : null;

  if (pending && !match) {
    return (
      <View className="flex-1 bg-background px-4 pt-6">
        <View className="h-32 rounded-2xl bg-card" />
        {queries}
      </View>
    );
  }
  if (!match) {
    return (
      <View className="flex-1 bg-background justify-center px-5">
        {queries}
        <EmptyState
          title={sourceFailure ? "Epic source unavailable" : "Epic unavailable"}
          detail={
            sourceFailure
              ? (sourceFailureDetail ?? "The project could not be loaded.")
              : params.projectId
                ? "This epic could not be found in the requested project."
                : "This link matches multiple projects or the epic is unavailable. Open it from the Epics list."
          }
          actionLabel={sourceFailure ? "Retry" : undefined}
          onAction={sourceFailure ? () => sourceFailure.refresh?.() : undefined}
        />
      </View>
    );
  }
  const snapshot = match.result;
  const children = epicChildren(
    params.epicId,
    snapshot?._tag === "available" ? snapshot.issues : [],
  );
  const terminal = run && ["done", "failed", "cancelled"].includes(run.status);
  const currentIteration =
    run?.recentIterations.toReversed().find((iteration) => iteration.turnStatus === "running") ??
    run?.recentIterations.at(-1);

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="px-4 pb-10"
      refreshControl={
        <RefreshControl
          refreshing={runQuery.isPending || environmentResults.some((source) => source.pending)}
          onRefresh={refreshAll}
        />
      }
    >
      {queries}
      <Text className="pt-5 font-mono text-xs text-foreground-muted">{match.epic.id}</Text>
      <Text className="mt-1 text-2xl font-t3-bold">{match.epic.title}</Text>
      <Text className="mt-1 text-sm text-foreground-muted">{match.project.projectTitle}</Text>

      <Text className="mb-2 mt-7 text-lg font-t3-bold">Children</Text>
      <View className="overflow-hidden rounded-2xl border border-border bg-card">
        {children.length === 0 ? (
          <Text className="p-5 text-center text-foreground-muted">
            This epic has no child issues yet.
          </Text>
        ) : (
          children.map((issue) => {
            const done = issue.status === "closed" || issue.status === "done";
            const blocked = issue.status === "blocked" || issue.blockedBy.length > 0;
            const threadId = latestEpicThreadId(run, issue.id);
            return (
              <Pressable
                key={issue.id}
                disabled={!threadId}
                accessibilityRole={threadId ? "button" : undefined}
                accessibilityLabel={`${issue.title}, ${issueStatusLabel(issue)}`}
                accessibilityHint={threadId ? "Opens the latest iteration thread" : undefined}
                accessibilityState={{ disabled: !threadId }}
                className={`min-h-16 flex-row items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 active:opacity-70 ${threadId ? "" : "opacity-60"}`}
                onPress={() =>
                  threadId &&
                  navigation.navigate("Thread", {
                    environmentId: params.environmentId as EnvironmentId,
                    threadId,
                  })
                }
              >
                <SymbolView
                  name={done ? "checkmark.circle" : blocked ? "exclamationmark.triangle" : "circle"}
                  size={22}
                  tintColor={done ? "#30d158" : blocked ? "#ff453a" : "#8e8e93"}
                />
                <View className="min-w-0 flex-1">
                  <Text className="font-t3-bold">{issue.title}</Text>
                  <Text className="mt-0.5 font-mono text-xs text-foreground-muted">
                    {issue.id} · {issueStatusLabel(issue)}
                  </Text>
                </View>
                {threadId ? (
                  <SymbolView name="chevron.right" size={17} tintColor="#8e8e93" />
                ) : null}
              </Pressable>
            );
          })
        )}
      </View>

      <View className="mt-7 flex-row items-center justify-between">
        <Text className="text-lg font-t3-bold">Run</Text>
        {uiState === "idle" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Start epic run"
            accessibilityState={{ busy: optimistic === "starting" }}
            className="min-h-11 flex-row items-center gap-2 rounded-full bg-primary px-5 active:opacity-70"
            onPress={start}
          >
            <SymbolView name="play" size={17} tintColor={primaryForeground} />
            <Text className="font-t3-bold text-primary-foreground">Start run</Text>
          </Pressable>
        ) : null}
      </View>
      {actionError ? (
        <View className="mt-3">
          <ErrorBanner message={actionError} />
        </View>
      ) : null}
      {runQuery.error ? (
        <View className="mt-3">
          <ErrorBanner message={runQuery.error} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry run status"
            className="min-h-11 justify-center"
            onPress={runQuery.refresh}
          >
            <Text className="font-t3-bold text-primary">Retry</Text>
          </Pressable>
        </View>
      ) : null}
      {uiState === "starting" ? (
        <View className="mt-3 min-h-20 justify-center rounded-2xl border border-border bg-card px-4">
          <Text>Starting run…</Text>
        </View>
      ) : run ? (
        <View className="mt-3 rounded-2xl border border-border bg-card p-4">
          <View className="flex-row items-center gap-2">
            {uiState === "running" || uiState === "paused" || uiState === "stopping" ? (
              <View className="size-2 rounded-full bg-success" />
            ) : null}
            <Text className="font-t3-bold capitalize">{uiState}</Text>
            <Text className="text-foreground-muted">
              Iteration {Math.min(run.iterationsCompleted + 1, run.maxIterations)} of{" "}
              {run.maxIterations}
            </Text>
            <Text className="ml-auto tabular-nums text-foreground-muted">
              {formatElapsed(run.createdAt, terminal ? run.updatedAt : null)}
            </Text>
          </View>
          {currentIteration?.issueId ? (
            <Pressable
              disabled={!currentIteration.threadId}
              accessibilityRole={currentIteration.threadId ? "button" : undefined}
              accessibilityLabel={`Open current thread for ${currentIteration.issueId}`}
              accessibilityHint={
                currentIteration.threadId ? "Opens the current epic iteration thread" : undefined
              }
              accessibilityState={{ disabled: !currentIteration.threadId }}
              className={`min-h-11 justify-center ${currentIteration.threadId ? "" : "opacity-50"}`}
              onPress={() =>
                navigation.navigate("Thread", {
                  environmentId: params.environmentId as EnvironmentId,
                  threadId: currentIteration.threadId,
                })
              }
            >
              <Text className="text-primary">{currentIteration.issueId} · Open current thread</Text>
            </Pressable>
          ) : null}
          {run.lastError ? (
            <Text className="mt-2 text-danger-foreground">{run.lastError}</Text>
          ) : null}
          {uiState === "running" || uiState === "paused" || uiState === "stopping" ? (
            <Pressable
              disabled={uiState === "stopping"}
              accessibilityRole="button"
              accessibilityLabel={uiState === "stopping" ? "Stopping epic run" : "Stop epic run"}
              accessibilityHint="Interrupts the current orchestration turn after confirmation"
              accessibilityState={{
                disabled: uiState === "stopping",
                busy: uiState === "stopping",
              }}
              className={`mt-3 min-h-11 items-center justify-center rounded-full border border-danger-foreground active:opacity-70 ${uiState === "stopping" ? "opacity-50" : ""}`}
              onPress={confirmStop}
            >
              <Text className="font-t3-bold text-danger-foreground">
                {uiState === "stopping" ? "Stopping…" : "Stop run"}
              </Text>
            </Pressable>
          ) : null}
          <Text className="mb-2 mt-5 text-xs font-t3-bold uppercase text-foreground-muted">
            Recent iterations
          </Text>
          {boundedRunLog(run.recentIterations).map((iteration) => (
            <View key={iteration.iterationIndex} className="border-t border-border py-3">
              <Text className="text-xs text-foreground-muted">
                Iteration {iteration.iterationIndex + 1} · {iteration.turnStatus}
              </Text>
              {iteration.summary ? <Text className="mt-1 text-sm">{iteration.summary}</Text> : null}
              {iteration.why ? (
                <Text className="mt-1 text-sm text-foreground-muted">{iteration.why}</Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
