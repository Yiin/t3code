import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function BetaSettingsPanel() {
  const sidebarV2Enabled = useClientSettings((settings) => settings.sidebarV2Enabled);
  const updateClientSettings = useUpdateClientSettings();

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
      </SettingsSection>
    </SettingsPageContainer>
  );
}
