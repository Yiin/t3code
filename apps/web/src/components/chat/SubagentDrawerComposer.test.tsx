import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveSubagentDrawerDelivery,
  subagentDrawerNotice,
  subagentDrawerSentLabel,
  SubagentDrawerComposer,
  SUBAGENT_DRAWER_BUSY_NOTICE,
  SUBAGENT_DRAWER_IDLE_NOTICE,
  SUBAGENT_DRAWER_PLACEHOLDER,
} from "./SubagentDrawerComposer";

const childThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-child-1"),
};

/** `renderToStaticMarkup` escapes an apostrophe, so the copy has to be too. */
function escaped(text: string): string {
  return text.replaceAll("'", "&#x27;");
}

function render(latestTurn: { state: "running" | "completed" } | null) {
  return renderToStaticMarkup(
    <SubagentDrawerComposer
      childLatestTurn={latestTurn}
      childThreadRef={childThreadRef}
      onSend={async () => null}
      skills={[]}
    />,
  );
}

describe("resolveSubagentDrawerDelivery", () => {
  it("parks a message for a busy child and sends one to an idle child now", () => {
    expect(resolveSubagentDrawerDelivery({ state: "running" })).toBe("turn-boundary");
    expect(resolveSubagentDrawerDelivery({ state: "completed" })).toBe("immediate");
    expect(resolveSubagentDrawerDelivery(null)).toBe("immediate");
  });
});

describe("subagentDrawerSentLabel", () => {
  it("says what happened and never claims the subagent read it", () => {
    expect(subagentDrawerSentLabel("sending", "immediate")).toBe("Sending…");
    expect(subagentDrawerSentLabel("sent", "immediate")).toBe("Sent");
    expect(subagentDrawerSentLabel("sent", "turn-boundary")).toContain(
      "waits for the current turn to end",
    );
    for (const delivery of ["immediate", "turn-boundary"] as const) {
      for (const status of ["sending", "sent"] as const) {
        expect(subagentDrawerSentLabel(status, delivery)).not.toContain("Delivered");
      }
    }
  });
});

describe("SubagentDrawerComposer", () => {
  it("stays enabled while the child is busy and says when the message lands", () => {
    const busyMarkup = render({ state: "running" });

    expect(busyMarkup).toContain(SUBAGENT_DRAWER_PLACEHOLDER);
    expect(busyMarkup).toContain(escaped(SUBAGENT_DRAWER_BUSY_NOTICE));
    expect(busyMarkup).not.toContain("Queued for parent");
    // The queue is the point: a busy child must still take a message.
    expect(busyMarkup).toContain('contentEditable="true"');
  });

  it("offers a new turn when the child is idle", () => {
    const idleMarkup = render(null);

    expect(idleMarkup).toContain(escaped(SUBAGENT_DRAWER_IDLE_NOTICE));
    expect(idleMarkup).not.toContain(escaped(SUBAGENT_DRAWER_BUSY_NOTICE));
    expect(subagentDrawerNotice("immediate")).toBe(SUBAGENT_DRAWER_IDLE_NOTICE);
  });
});
