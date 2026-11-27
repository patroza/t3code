import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

export function AntigravityUsageLimitsSetting({
  environmentId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const gt = useGT();
  const enabled = useEnvironmentSettings(
    environmentId,
    (settings) => settings.antigravityUsageLimitsEnabled,
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  return (
    <SettingsRow
      title={gt("Antigravity usage limits")}
      description={gt(
        "Read quota windows from the local agy CLI (/usage). Checked at most once every 15 minutes when Antigravity is installed and configured.",
      )}
      control={
        <Switch
          data-testid="antigravity-usage-limits-toggle"
          aria-label={gt("Antigravity usage limits")}
          checked={enabled}
          disabled={readOnly}
          onCheckedChange={(checked) =>
            updateSettings({ antigravityUsageLimitsEnabled: Boolean(checked) })
          }
        />
      }
    />
  );
}
