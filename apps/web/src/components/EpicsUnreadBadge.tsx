import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { useEnvironments } from "../state/environments";
import { countUnreadEpicRuns, epicsEnvironment } from "../state/epics";
import { useEnvironmentQuery } from "../state/query";
import { useUiStateStore } from "../uiStateStore";

function EnvironmentUnreadRuns(props: {
  environmentId: EnvironmentId;
  lastVisitedAt: string | null;
  report: (environmentId: EnvironmentId, count: number) => void;
}) {
  const runs = useEnvironmentQuery(
    epicsEnvironment.allRuns({ environmentId: props.environmentId, input: {} }),
  );
  const count = countUnreadEpicRuns([runs.data], props.lastVisitedAt);
  useEffect(() => {
    props.report(props.environmentId, count);
  }, [count, props]);
  return null;
}

export function EpicsUnreadBadge() {
  const { environments } = useEnvironments();
  const lastVisitedAt = useUiStateStore((state) => state.epicsLastVisitedAt);
  const [counts, setCounts] = useState<ReadonlyMap<EnvironmentId, number>>(() => new Map());
  const report = useMemo(
    () => (environmentId: EnvironmentId, count: number) =>
      setCounts((current) => {
        if (current.get(environmentId) === count) return current;
        const next = new Map(current);
        next.set(environmentId, count);
        return next;
      }),
    [],
  );
  const total = environments.reduce(
    (sum, environment) => sum + (counts.get(environment.environmentId) ?? 0),
    0,
  );
  return (
    <>
      {environments.map((environment) => (
        <EnvironmentUnreadRuns
          key={environment.environmentId}
          environmentId={environment.environmentId}
          lastVisitedAt={lastVisitedAt}
          report={report}
        />
      ))}
      <span className="ml-auto" role="status" aria-live="polite">
        {total > 0 ? (
          <span
            className="inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground"
            aria-label={`${total} unread epic runs`}
          >
            {total > 99 ? "99+" : total}
          </span>
        ) : null}
      </span>
    </>
  );
}
