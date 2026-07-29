import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { Button } from "../components/ui/button";
import { EpicsEmptyState } from "./_chat.epics.index";

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
