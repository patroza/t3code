import { getHostResourcePressure } from "@t3tools/client-runtime/state/hostResourcePresentation";
import type { EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { useHostResourceSnapshot } from "../../state/useHostResourceSnapshot";

function pressureClass(pressure: ReturnType<typeof getHostResourcePressure>): string {
  if (pressure === "critical") return "text-rose-500 dark:text-rose-400";
  if (pressure === "warning") return "text-amber-500 dark:text-amber-400";
  return "text-foreground-muted";
}

export function HostResourceStatus(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
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
          : `CPU ${Math.round(data.cpuPercent ?? 0)}% · MEM ${Math.round(data.memoryUsedPercent ?? 0)}% · LOAD ${data.loadAverage?.m1.toFixed(1) ?? "—"}`}
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
        <SymbolView name="arrow.clockwise" size={12} tintColor={iconColor} type="monochrome" />
      </Pressable>
    </View>
  );
}
