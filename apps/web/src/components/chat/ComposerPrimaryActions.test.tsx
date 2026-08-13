import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

const REASON = "A worker is running epic-1.7.";

const baseProps = {
  compact: false,
  pendingAction: null,
  isRunning: false,
  showPlanFollowUpPrompt: false,
  promptHasText: false,
  isSendBusy: false,
  isConnecting: false,
  isEnvironmentUnavailable: false,
  isPreparingWorktree: false,
  hasSendableContent: true,
  onPreviousPendingQuestion: () => {},
  onInterrupt: () => {},
  onImplementPlanInNewThread: () => {},
} as const;

describe("ComposerPrimaryActions on a runner-owned thread", () => {
  it("turns off send and says why", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions {...baseProps} runnerOwnedReason={REASON} />,
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-label="Epic run owns this thread"');
    expect(markup).toContain(REASON);
  });

  it("turns off stop, which would end the turn the runner is waiting on", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions {...baseProps} isRunning runnerOwnedReason={REASON} />,
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-label="Epic run owns this thread"');
  });

  it("leaves both on when no run owns the thread", () => {
    expect(
      renderToStaticMarkup(<ComposerPrimaryActions {...baseProps} runnerOwnedReason={null} />),
    ).not.toContain('disabled=""');
    expect(
      renderToStaticMarkup(
        <ComposerPrimaryActions {...baseProps} isRunning runnerOwnedReason={null} />,
      ),
    ).toContain('aria-label="Stop generation"');
  });

  it("keeps the user-input answer button on: answering is how a human unblocks a worker", () => {
    const markup = renderToStaticMarkup(
      <ComposerPrimaryActions
        {...baseProps}
        pendingAction={{
          questionIndex: 0,
          isLastQuestion: true,
          canAdvance: true,
          isResponding: false,
          isComplete: true,
        }}
        runnerOwnedReason={REASON}
      />,
    );

    expect(markup).not.toContain('disabled=""');
  });
});
