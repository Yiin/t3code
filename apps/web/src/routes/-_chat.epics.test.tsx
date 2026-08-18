import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type EpicRun } from "@t3tools/contracts";

import { Button } from "../components/ui/button";
import type { EpicProjectSource } from "../epics.logic";
import {
  epicGroupListId,
  epicGroupModel,
  epicRowModels,
  type EpicGroupModel,
  type EpicPageSummary,
} from "../epicsPage.logic";
import { EpicProjectGroupSection, EpicsEmptyState } from "./_chat.epics.index";
import { EpicRunLog, EpicRunResumeFailureNote } from "./_chat.epics.$environmentId.$epicId";

function findButton(node: ReactNode): ReactElement<{ readonly onClick: () => void }> | null {
  if (!isValidElement(node)) return null;
  if (node.type === Button) {
    return node as ReactElement<{ readonly onClick: () => void }>;
  }
  const children = (node.props as { readonly children?: ReactNode }).children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = findButton(child);
    if (match) return match;
  }
  return null;
}

describe("EpicsEmptyState", () => {
  it("starts planning from its call to action", () => {
    const onPlan = vi.fn();
    const view = <EpicsEmptyState canPlan onPlan={onPlan} />;
    const markup = renderToStaticMarkup(view);
    const button = findButton(EpicsEmptyState({ canPlan: true, onPlan }));

    expect(markup).toContain("No epics yet — plan one");
    expect(markup).toContain("Plan an epic");
    button?.props.onClick();

    expect(onPlan).toHaveBeenCalledOnce();
  });
});

const source: EpicProjectSource = {
  environmentId: EnvironmentId.make("env"),
  workspaceRoot: "/repo",
  projectId: ProjectId.make("project"),
  projectTitle: "T3 Code",
};

function epic(overrides: Partial<EpicPageSummary> = {}): EpicPageSummary {
  return {
    id: "t3code-j8s",
    title: "Rethink the Epics page",
    status: "open",
    childCounts: { total: 4, ready: 2, byStatus: { open: 3, closed: 1 } },
    createdAt: null,
    updatedAt: null,
    lastActivityAt: null,
    ...overrides,
  };
}

function run(overrides: Partial<EpicRun> = {}): EpicRun {
  return {
    runId: "run-1",
    epicId: "t3code-j8s",
    projectId: source.projectId,
    cwd: source.workspaceRoot,
    status: "done",
    updatedAt: "2026-08-03T00:00:00.000Z",
    threadRefs: [],
    ...overrides,
  } as unknown as EpicRun;
}

function groupWith(runs: ReadonlyArray<EpicRun>): EpicGroupModel {
  return epicGroupModel(source, epicRowModels(source, [epic()], runs));
}

type SectionChildren = ReactElement<{ readonly children: ReadonlyArray<ReactNode> }>;

/** The toggle inside the group heading, which is the only button the section renders. */
function headerElement(view: ReactNode): ReactElement<{
  readonly onClick: () => void;
  readonly "aria-expanded": boolean;
  readonly "aria-controls": string;
}> {
  const heading = (view as SectionChildren).props.children[0] as SectionChildren;
  return heading.props.children as never;
}

/** The row list, or `null` when the group is collapsed and its rows are gone. */
function rowListElement(view: ReactNode): ReactNode {
  return (view as SectionChildren).props.children[1];
}

describe("EpicProjectGroupSection", () => {
  it("keeps a running run visible on the header of a collapsed group", () => {
    const group = groupWith([run({ status: "running" })]);
    const markup = renderToStaticMarkup(
      <EpicProjectGroupSection group={group} collapsed onToggle={vi.fn()} />,
    );

    expect(markup).toContain("T3 Code");
    expect(markup).toContain("1 epic");
    expect(markup).toContain("Running");
    expect(markup).toContain("2 ready");
    expect(markup).toContain("animate-status-pulse");
    expect(markup).toContain('aria-expanded="false"');
    // Hidden rows, never hidden state: the epic row itself is gone.
    expect(markup).not.toContain("Rethink the Epics page");
  });

  it("renders its rows only while expanded, and points aria-controls at them", () => {
    const group = groupWith([run({ status: "failed" })]);
    const collapsed = EpicProjectGroupSection({ group, collapsed: true, onToggle: vi.fn() });
    const expanded = EpicProjectGroupSection({ group, collapsed: false, onToggle: vi.fn() });
    const listId = epicGroupListId(group.key);

    expect(headerElement(collapsed).props["aria-controls"]).toBe(listId);
    expect(headerElement(collapsed).props["aria-expanded"]).toBe(false);
    expect(headerElement(expanded).props["aria-expanded"]).toBe(true);
    expect(rowListElement(collapsed)).toBeNull();
    expect(rowListElement(expanded)).not.toBeNull();
  });

  it("flips the persisted collapse state for its own group key", () => {
    const group = groupWith([]);
    const onToggle = vi.fn();
    headerElement(EpicProjectGroupSection({ group, collapsed: false, onToggle })).props.onClick();
    expect(onToggle).toHaveBeenCalledWith("env\0/repo", true);

    onToggle.mockClear();
    headerElement(EpicProjectGroupSection({ group, collapsed: true, onToggle })).props.onClick();
    expect(onToggle).toHaveBeenCalledWith("env\0/repo", false);
  });

  it("escapes the group key into an id-safe aria-controls target", () => {
    expect(epicGroupListId("env\0/repo")).toBe("epics-project-group-env_0__2f_repo");
    expect(epicGroupListId("env\0/a-b")).not.toBe(epicGroupListId("env\0/a_b"));
  });

  it("says how much work is waiting when a group has never been run", () => {
    const markup = renderToStaticMarkup(
      <EpicProjectGroupSection group={groupWith([])} collapsed onToggle={vi.fn()} />,
    );
    expect(markup).toContain("2 ready");
    expect(markup).not.toContain("animate-status-pulse");
  });
});

const logIteration = (
  overrides: Partial<EpicRun["recentIterations"][number]>,
): EpicRun["recentIterations"][number] =>
  ({
    iterationIndex: 0,
    threadId: "thread-1",
    issueId: "t3code-j8s.1",
    workerId: null,
    branch: null,
    worktreePath: null,
    turnStatus: "completed",
    summary: null,
    why: null,
    failureReason: null,
    resumeCount: 0,
    lastResumedAt: null,
    startedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: "2026-08-03T00:01:00.000Z",
    ...overrides,
  }) as unknown as EpicRun["recentIterations"][number];

const logRun = (iterations: ReadonlyArray<EpicRun["recentIterations"][number]>): EpicRun =>
  run({ recentIterations: iterations } as Partial<EpicRun>);

describe("EpicRunLog", () => {
  it("says an iteration was resumed, and says nothing when it never stopped", () => {
    const resumed = renderToStaticMarkup(
      <EpicRunLog
        run={logRun([logIteration({ resumeCount: 2 })])}
        environmentId={EnvironmentId.make("env")}
        cwd="/repo"
      />,
    );
    const untouched = renderToStaticMarkup(
      <EpicRunLog
        run={logRun([logIteration({})])}
        environmentId={EnvironmentId.make("env")}
        cwd="/repo"
      />,
    );

    expect(resumed).toContain("resumed 2 times");
    expect(untouched).not.toContain("resumed");
  });

  it("explains a resume-family failure and leaves every other reason verbatim", () => {
    const unsupported = renderToStaticMarkup(
      <EpicRunLog
        run={logRun([
          logIteration({ turnStatus: "abandoned", failureReason: "infra:resume-unsupported" }),
        ])}
        environmentId={EnvironmentId.make("env")}
        cwd="/repo"
      />,
    );
    const timedOut = renderToStaticMarkup(
      <EpicRunLog
        run={logRun([logIteration({ turnStatus: "failed", failureReason: "infra:timeout" })])}
        environmentId={EnvironmentId.make("env")}
        cwd="/repo"
      />,
    );

    expect(unsupported).toContain("provider cannot resume a session");
    expect(unsupported).not.toContain("infra:resume-unsupported");
    expect(timedOut).toContain("infra:timeout");
  });
});

describe("EpicRunResumeFailureNote", () => {
  it("appears only when the newest iteration could not be continued", () => {
    const blocked = renderToStaticMarkup(
      <EpicRunResumeFailureNote
        run={logRun([
          logIteration({ iterationIndex: 0, failureReason: "infra:timeout" }),
          logIteration({
            iterationIndex: 1,
            turnStatus: "abandoned",
            failureReason: "infra:resume-blocked",
          }),
        ])}
      />,
    );
    const ordinary = renderToStaticMarkup(
      <EpicRunResumeFailureNote
        run={logRun([logIteration({ turnStatus: "failed", failureReason: "infra:timeout" })])}
      />,
    );

    expect(blocked).toContain("could not be continued");
    expect(ordinary).toBe("");
  });
});
