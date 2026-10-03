import { getHostResourcePressure } from "@t3tools/client-runtime/state/hostResourcePresentation";
import type { EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useHostResourceSnapshot } from "../../state/useHostResourceSnapshot";

function pressureClass(pressure: ReturnType<typeof getHostResourcePressure>): string {
  if (pressure === "critical") return "text-danger-foreground";
  if (pressure === "warning") return "text-foreground-secondary";
  return "text-foreground-muted";
}

export function HostResourceStatus(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
}) {
  const { data, isPending, refresh } = useHostResourceSnapshot(
    props.environmentId,
    props.connected,
  );
  if (!props.connected) return null;

  const unavailable = !data || data.status === "unavailable";
  return (
    <View className="flex-row items-center gap-1.5">
      <Text
        className={cn(
          "flex-1 text-2xs",
          unavailable ? "text-foreground-muted" : pressureClass(getHostResourcePressure(data)),
        )}
        numberOfLines={1}
      >
        {unavailable
          ? isPending
            ? "Reading host resources…"
            : "Host resources unavailable"
          : `C ${Math.round(data.cpuPercent ?? 0)}% · M ${Math.round(data.memoryUsedPercent ?? 0)}% · L ${data.loadAverage?.m1.toFixed(1) ?? "—"}`}
      </Text>
      <Pressable
        accessibilityLabel={`Refresh host resources for ${props.environmentLabel}`}
        accessibilityRole="button"
        className="h-7 w-7 items-center justify-center rounded-lg active:bg-subtle"
        onPress={(event) => {
          event.stopPropagation();
          refresh();
        }}
      >
        <SymbolView
          name="arrow.clockwise"
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}
