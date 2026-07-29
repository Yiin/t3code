import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useUiStateStore } from "../uiStateStore";

function EpicsLayout() {
  const markEpicsVisited = useUiStateStore((state) => state.markEpicsVisited);
  useEffect(() => {
    markEpicsVisited(new Date().toISOString());
  }, [markEpicsVisited]);
  return <Outlet />;
}

export const Route = createFileRoute("/_chat/epics")({
  component: EpicsLayout,
});
