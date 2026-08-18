// @vitest-environment jsdom
import { ApprovalRequestId, type UserInputQuestion } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const QUESTIONS: ReadonlyArray<UserInputQuestion> = [
  {
    id: "Pick one color",
    header: "Color",
    question: "Pick one color",
    options: [
      { label: "Red", description: "" },
      { label: "Blue", description: "" },
    ],
    multiSelect: false,
  },
  {
    id: "Pick many toppings",
    header: "Toppings",
    question: "Pick many toppings",
    options: [
      { label: "Cheese", description: "" },
      { label: "Bacon", description: "" },
      { label: "Onion", description: "" },
    ],
    multiSelect: true,
  },
];

function makePrompt(): PendingUserInput {
  return {
    requestId: ApprovalRequestId.make("request-multi-select"),
    createdAt: "2026-08-13T00:00:00.000Z",
    questions: QUESTIONS,
  };
}

type RenderedPanel = { container: HTMLDivElement; root: Root };

function renderPanel(props: {
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
}): RenderedPanel {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[makePrompt()]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={props.questionIndex}
        onToggleOption={props.onToggleOption}
        onAdvance={props.onAdvance}
      />,
    );
  });
  return { container, root };
}

function clickOption(container: HTMLElement, optionLabel: string): void {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes(optionLabel) ?? false,
  );
  if (!button) {
    throw new Error(`Option button not found: ${optionLabel}`);
  }
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ComposerPendingUserInputPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("toggles options on a multiSelect question without advancing past the 200ms timer", () => {
    const onToggleOption = vi.fn();
    const onAdvance = vi.fn();
    const { container, root } = renderPanel({ questionIndex: 1, onToggleOption, onAdvance });

    expect(container.textContent).toContain("Select one or more options.");

    // Three clicks, each separated by more than the 200ms auto-advance window.
    for (const label of ["Cheese", "Bacon", "Onion"]) {
      clickOption(container, label);
      act(() => {
        vi.advanceTimersByTime(500);
      });
    }

    expect(onToggleOption).toHaveBeenCalledTimes(3);
    expect(onToggleOption).toHaveBeenNthCalledWith(1, "Pick many toppings", "Cheese");
    expect(onToggleOption).toHaveBeenNthCalledWith(2, "Pick many toppings", "Bacon");
    expect(onToggleOption).toHaveBeenNthCalledWith(3, "Pick many toppings", "Onion");
    expect(onAdvance).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("toggles via number-key shortcut on a multiSelect question without advancing", () => {
    const onToggleOption = vi.fn();
    const onAdvance = vi.fn();
    const { root } = renderPanel({ questionIndex: 1, onToggleOption, onAdvance });

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(onToggleOption).toHaveBeenCalledTimes(1);
    expect(onToggleOption).toHaveBeenCalledWith("Pick many toppings", "Bacon");
    expect(onAdvance).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("keeps the single-select auto-advance behavior as a control case", () => {
    const onToggleOption = vi.fn();
    const onAdvance = vi.fn();
    const { container, root } = renderPanel({ questionIndex: 0, onToggleOption, onAdvance });

    clickOption(container, "Red");

    expect(onToggleOption).toHaveBeenCalledTimes(1);
    expect(onToggleOption).toHaveBeenCalledWith("Pick one color", "Red");
    expect(onAdvance).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(onAdvance).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });
});
