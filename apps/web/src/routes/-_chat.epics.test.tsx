import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { EpicRun } from "@t3tools/contracts";

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
  environmentId: "env",
  workspaceRoot: "/repo",
  projectId: "project",
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
