import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { isSubagentSpawnEnabled, nextSubagentSpawnSettings } from "./BetaSettingsPanel.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const selectSubagentSpawn = (settings: UnifiedSettings) => settings.subagentSpawn;

export function BetaSettingsPanel() {
  const subagentSpawn = usePrimarySettings(selectSubagentSpawn);
  const updatePrimarySettings = useUpdatePrimarySettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Beta features">
        <SettingsRow
          title="Thread-backed subagents"
          description="Give each subagent its own thread and provider session, so you can watch it and talk to it from the roster. The session gives up its built-in delegation tools in exchange, so a fan-out runs one subagent at a time. The caps stay in settings.json under subagentSpawn."
          control={
            <Switch
              checked={isSubagentSpawnEnabled(subagentSpawn)}
              onCheckedChange={(checked) =>
                updatePrimarySettings({
                  subagentSpawn: nextSubagentSpawnSettings(subagentSpawn, Boolean(checked)),
                })
              }
              aria-label="Enable thread-backed subagent spawning"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
