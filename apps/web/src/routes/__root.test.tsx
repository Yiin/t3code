// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RootRouteErrorActions } from "./__root";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
});

describe("RootRouteErrorActions", () => {
  it("disables retry and prevents repeated invalidation while the request is pending", async () => {
    let resolveInvalidate: (() => void) | undefined;
    const invalidatePromise = new Promise<void>((resolve) => {
      resolveInvalidate = resolve;
    });
    const invalidate = vi.fn(() => invalidatePromise);
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<RootRouteErrorActions router={{ invalidate }} />);
    });

    const tryAgainButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Try again",
    );
    if (!tryAgainButton) {
      throw new Error("Try again button not found.");
    }

    act(() => {
      tryAgainButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(invalidate).toHaveBeenCalledOnce();
    expect(tryAgainButton.disabled).toBe(true);
    expect(tryAgainButton.textContent).toBe("Trying again...");

    act(() => {
      tryAgainButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(invalidate).toHaveBeenCalledOnce();

    await act(async () => {
      resolveInvalidate?.();
      await invalidatePromise;
    });

    expect(tryAgainButton.disabled).toBe(false);
    expect(tryAgainButton.textContent).toBe("Try again");
  });
});
