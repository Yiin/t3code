import { RunId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function bannerDescription(resetAt: Date, timestampFormat: TimestampFormat) {
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
    resetAt: resetAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    snoozedUntil: null,
    recovery: null,
    timestampFormat,
    switchedAccount: null,
    onChange: async () => {},
  }).description;
}

describe("usageLimitRecoveryBannerItem", () => {
  it.each([
    ["12-hour", "Resets 5:30 PM"],
    ["24-hour", "Resets 17:30"],
  ] as const)("formats a same-day reset with the %s setting", (timestampFormat, expected) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 20, 17, 30), timestampFormat)).toBe(expected);
  });

  it("names the day when the reset is tomorrow", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 21, 17, 30), "24-hour")).toBe(
      "Resets tomorrow at 17:30",
    );
  });
});

describe("usageLimitRecoveryBannerItem account switch", () => {
  const runId = RunId.make("run-limited");
  const baseProps = {
    runId,
    resetAt: "2099-10-20T18:00:00.000Z",
    stoppedAt: "2099-10-15T01:31:00.000Z",
    snoozedUntil: null,
    recovery: null,
    timestampFormat: "24-hour" as const,
    onChange: async () => undefined,
  };

  function renderActions(item: ReturnType<typeof usageLimitRecoveryBannerItem>) {
    return renderToStaticMarkup(<>{item.actions}</>);
  }

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
