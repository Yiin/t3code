import {
  EventId,
  ThreadId,
  type OrchestrationThreadActivity,
  type OrchestrationThreadSubagent,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PARENT_MEDIATED_NOTICE, SubagentInspectorFooter } from "./SubagentInspectorFooter";

const nowMs = Date.parse("2026-08-06T12:00:00.000Z");
const threadId = ThreadId.make("thread-1");
const commandSuccess = async () => null;

function subagent(
  overrides: Partial<OrchestrationThreadSubagent> = {},
): OrchestrationThreadSubagent {
  return {
    subagentId: "agent-1",
    turnId: null,
    status: "running",
    startedAt: "2026-08-06T11:55:00.000Z",
    updatedAt: "2026-08-06T11:59:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function activity(
  id: string,
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind,
    payload,
    summary: kind,
    tone: kind.includes("failed") ? "error" : "info",
    turnId: null,
    createdAt: `2026-08-06T11:59:0${id.at(-1) ?? "0"}.000Z`,
  };
}

function render(
  currentSubagent: OrchestrationThreadSubagent,
  activities: OrchestrationThreadActivity[] = [],
) {
  return renderToStaticMarkup(
    <SubagentInspectorFooter
      activities={activities}
      nowMs={nowMs}
      onInterrupt={async () => undefined}
      onSteer={commandSuccess}
      onStop={commandSuccess}
      subagent={currentSubagent}
      threadId={threadId}
    />,
  );
}

describe("SubagentInspectorFooter", () => {
  it("disables controls for terminal and stale subagents", () => {
    const terminalMarkup = render(
      subagent({ status: "completed", completedAt: "2026-08-06T11:59:00.000Z" }),
    );
    expect(terminalMarkup).toContain("This subagent is no longer running.");
    expect(terminalMarkup.match(/disabled/g)?.length).toBeGreaterThanOrEqual(3);

    const staleMarkup = render(subagent({ updatedAt: "2026-08-06T11:00:00.000Z" }));
    expect(staleMarkup).toContain("This subagent has not reported recent activity.");
    expect(staleMarkup.match(/disabled/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("names the parent hop before the first send, and only while the composer works", () => {
    expect(render(subagent())).toContain(PARENT_MEDIATED_NOTICE);
    // A settled subagent cannot be messaged at all, so the notice would lie.
    expect(render(subagent({ status: "completed" }))).not.toContain(PARENT_MEDIATED_NOTICE);
  });

  it("renders steer delivery and failure transitions from activities", () => {
    const markup = render(subagent(), [
      activity("event-1", "subagent.steer.requested", {
        subagentId: "agent-1",
        steerId: "steer-1",
        text: "Check the parser",
      }),
      activity("event-2", "subagent.steer.delivered", {
        subagentId: "agent-1",
        steerId: "steer-1",
      }),
      activity("event-3", "subagent.steer.requested", {
        subagentId: "agent-1",
        steerId: "steer-2",
        text: "Run the focused test",
      }),
      activity("event-4", "provider.subagent.steer.failed", {
        subagentId: "agent-1",
        steerId: "steer-2",
        detail: "Parent session closed",
      }),
    ]);

    expect(markup).toContain("You → subagent");
    expect(markup).toContain("Queued for parent");
    expect(markup).toContain("after the current subagent task returns");
    expect(markup).toContain("Parent session closed");
    expect(markup).toContain("Retry");
  });

  it("renders stopping and escalation transitions from activities", () => {
    const stoppingMarkup = render(subagent(), [
      activity("event-1", "subagent.stop.requested", {
        subagentId: "agent-1",
        stopId: "stop-1",
      }),
    ]);
    expect(stoppingMarkup).toContain("Stopping… interrupts turn in 30s.");
    expect(stoppingMarkup).toContain("Interrupt turn now");

    const escalatedMarkup = render(subagent(), [
      activity("event-1", "subagent.stop.escalated", {
        subagentId: "agent-1",
        stopId: "stop-1",
      }),
    ]);
    expect(escalatedMarkup).toContain("Escalated: turn interrupted.");
    expect(escalatedMarkup).not.toContain("Interrupt turn now");
  });
});
