import {
  DEFAULT_THREAD_AUTO_SETTLE_AFTER_DAYS,
  MAX_THREAD_AUTO_SETTLE_AFTER_DAYS,
  MIN_THREAD_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import {
  useClientSettings,
  usePrimarySettings,
  useUpdateClientSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const AUTO_SETTLE_MIN_DAYS = MIN_THREAD_AUTO_SETTLE_AFTER_DAYS;
const AUTO_SETTLE_MAX_DAYS = MAX_THREAD_AUTO_SETTLE_AFTER_DAYS;
const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_THREAD_AUTO_SETTLE_AFTER_DAYS;

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  // Local draft so the field can be emptied mid-edit; the setting only moves
  // on valid input and snaps back to the persisted value on blur.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <Input
      type="number"
      min={AUTO_SETTLE_MIN_DAYS}
      max={AUTO_SETTLE_MAX_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        // Number(), not parseInt: "3.5" must be rejected (not truncated to a
        // committed 3 while the field shows 3.5) — commit only when the
        // persisted value matches the displayed one.
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= AUTO_SETTLE_MIN_DAYS &&
          parsed <= AUTO_SETTLE_MAX_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label="Days of inactivity before auto-settle"
    />
  );
}

export function BetaSettingsPanel() {
  const sidebarV2Enabled = useClientSettings((settings) => settings.sidebarV2Enabled);
  const updateClientSettings = useUpdateClientSettings();
  // Auto-settle is a server setting, not a per-device one: the server sweeps
  // idle threads, emits a real thread.settled event, and stops the provider
  // session. So it is NOT gated on the sidebar v2 beta — it governs every
  // client of this server, including ones that never turn the beta on.
  const threadAutoSettleAfterDays = usePrimarySettings(
    (settings) => settings.threadAutoSettleAfterDays,
  );
  const updateServerSettings = useUpdatePrimarySettings();

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
      <SettingsSection title="Thread auto-settle">
        <SettingsRow
          title="Auto-settle inactive threads"
          description="Threads with no activity for this long settle automatically, which also releases the provider session. This is a server setting: it applies to every client connected to this server."
          control={
            <Switch
              checked={threadAutoSettleAfterDays !== null}
              onCheckedChange={(checked) =>
                updateServerSettings({
                  threadAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                })
              }
              aria-label="Auto-settle inactive threads"
            />
          }
        />
        {threadAutoSettleAfterDays !== null ? (
          <SettingsRow
            title="Days of inactivity before auto-settle"
            description="Any new activity un-settles a thread automatically."
            control={
              <AutoSettleDaysInput
                value={threadAutoSettleAfterDays}
                onCommit={(days) => updateServerSettings({ threadAutoSettleAfterDays: days })}
              />
            }
          />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
