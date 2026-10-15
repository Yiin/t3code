import { RunId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const runId = RunId.make("run-limited");
const baseProps = {
  runId,
  resetAt: "2099-10-20T18:00:00.000Z",
  stoppedAt: "2099-10-15T01:31:00.000Z",
  snoozedUntil: null,
  recovery: null,
  onChange: async () => undefined,
};

function renderActions(item: ReturnType<typeof usageLimitRecoveryBannerItem>) {
  return renderToStaticMarkup(<>{item.actions}</>);
}

describe("usageLimitRecoveryBannerItem", () => {
  it("waits for the reset while the limited account stays picked", () => {
    const markup = renderActions(
      usageLimitRecoveryBannerItem({ ...baseProps, switchedAccount: null }),
    );

    expect(markup).toContain("Resume at reset");
    expect(markup).toContain("Snooze until reset");
    expect(markup).not.toContain("Resume now");
  });

  it("offers to resume now when another account is picked", () => {
    const markup = renderActions(
      usageLimitRecoveryBannerItem({
        ...baseProps,
        switchedAccount: { label: "Claude Work", onResumeNow: () => undefined },
      }),
    );

    expect(markup).toContain("Resume now on Claude Work");
    expect(markup).not.toContain("Resume at reset");
    expect(markup).not.toContain("Snooze until reset");
    expect(markup).not.toContain("Cancel auto-resume");
  });

  it("keeps an armed auto-resume cancellable after an account switch", () => {
    const markup = renderActions(
      usageLimitRecoveryBannerItem({
        ...baseProps,
        recovery: { runId, resetAt: baseProps.resetAt, autoResume: true },
        switchedAccount: { label: "Claude Work", onResumeNow: () => undefined },
      }),
    );

    expect(markup).toContain("Resume now on Claude Work");
    expect(markup).toContain("Cancel auto-resume");
  });

  it("offers the switch even when the reset time is unknown", () => {
    const markup = renderActions(
      usageLimitRecoveryBannerItem({
        ...baseProps,
        resetAt: null,
        switchedAccount: { label: "Claude Work", onResumeNow: () => undefined },
      }),
    );

    expect(markup).toContain("Resume now on Claude Work");
  });
});
