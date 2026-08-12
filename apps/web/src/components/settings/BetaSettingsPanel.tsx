import type { UnifiedSettings } from "@t3tools/contracts/settings";
import {
  useClientSettings,
  usePrimarySettings,
  useUpdateClientSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { isSubagentSpawnEnabled, nextSubagentSpawnSettings } from "./BetaSettingsPanel.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const selectSubagentSpawn = (settings: UnifiedSettings) => settings.subagentSpawn;

export function BetaSettingsPanel() {
  const sidebarV2Enabled = useClientSettings((settings) => settings.sidebarV2Enabled);
  const updateClientSettings = useUpdateClientSettings();
  const subagentSpawn = usePrimarySettings(selectSubagentSpawn);
  const updatePrimarySettings = useUpdatePrimarySettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Beta features">
        <SettingsRow
          title="Sidebar v2"
          description="One flat thread list in creation order. Active work renders as rich cards; settled threads collapse to compact rows. Settling requires an up-to-date server — on older servers threads simply stay active. Switch back any time."
          control={
            <Switch
              checked={sidebarV2Enabled}
              onCheckedChange={(checked) =>
                updateClientSettings({ sidebarV2Enabled: Boolean(checked) })
              }
              aria-label="Enable the sidebar v2 beta"
            />
          }
        />
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
