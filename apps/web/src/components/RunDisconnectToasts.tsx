import type { EpicRun, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { useEnvironments } from "../state/environments";
import { epicsEnvironment } from "../state/epics";
import { useEnvironmentQuery } from "../state/query";
import { stackedThreadToast, toastManager } from "./ui/toast";

const notifiedRunKeys = new Set<string>();

export function newlyDisconnectedRunKeys(input: {
  environmentId: EnvironmentId;
  wasConnected: boolean;
  isConnected: boolean;
  runs: ReadonlyArray<EpicRun>;
  notified: ReadonlySet<string>;
}): readonly string[] {
  if (!input.wasConnected || input.isConnected) return [];
  return input.runs.flatMap((run) => {
    const key = `${input.environmentId}:${run.runId}`;
    return run.status === "running" && !input.notified.has(key) ? [key] : [];
  });
}

function EnvironmentRunDisconnectToast(props: {
  environmentId: EnvironmentId;
  connected: boolean;
  notified: Set<string>;
}) {
  const query = useEnvironmentQuery(
    epicsEnvironment.allRuns({ environmentId: props.environmentId, input: {} }),
  );
  const previousConnected = useRef(props.connected);
  const lastRuns = useRef<ReadonlyArray<EpicRun>>([]);
  if (query.data !== null) lastRuns.current = query.data;
  useEffect(() => {
    const keys = newlyDisconnectedRunKeys({
      environmentId: props.environmentId,
      wasConnected: previousConnected.current,
      isConnected: props.connected,
      runs: lastRuns.current,
      notified: props.notified,
    });
    previousConnected.current = props.connected;
    for (const key of keys) {
      props.notified.add(key);
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Run continues on the server",
          description: "You can reconnect later to follow its progress.",
        }),
      );
    }
  }, [props.connected, props.environmentId, props.notified]);
  return null;
}

export function RunDisconnectToasts() {
  const { environments } = useEnvironments();
  return environments.map((environment) => (
    <EnvironmentRunDisconnectToast
      key={environment.environmentId}
      environmentId={environment.environmentId}
      connected={environment.connection.phase === "connected"}
      notified={notifiedRunKeys}
    />
  ));
}
