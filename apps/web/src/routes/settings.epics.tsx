import { createFileRoute } from "@tanstack/react-router";

import { EpicsSettingsPanel } from "../components/settings/EpicsSettings";

function SettingsEpicsRoute() {
  return <EpicsSettingsPanel />;
}

export const Route = createFileRoute("/settings/epics")({
  component: SettingsEpicsRoute,
});
