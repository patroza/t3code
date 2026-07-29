import { View } from "react-native";

import type { UsageMarker } from "@t3tools/client-runtime/state/aiUsagePresentation";

import { ProviderIcon } from "./ProviderIcon";

export interface ProviderUsageIconProps {
  readonly provider: string | null | undefined;
  readonly size?: number;
  readonly marker?: UsageMarker | null;
}

/**
 * Renders a provider icon with an optional usage status dot + ring,
 * for use in conversation lists, composer, headers etc.
 */
export function ProviderUsageIcon(props: ProviderUsageIconProps) {
  const { provider, size = 16, marker } = props;

  if (!marker) {
    return <ProviderIcon provider={provider} size={size} />;
  }

  const { fill, outlookAtRisk } = marker;

  let dotColor: string;
  let ringColor: string | null = null;

  if (fill === "critical") {
    dotColor = "#ef4444";
    if (outlookAtRisk) ringColor = "#f59e0b";
  } else if (fill === "warn") {
    dotColor = "#f59e0b";
    if (outlookAtRisk) ringColor = "#f59e0b";
  } else if (outlookAtRisk) {
    dotColor = "#6b7280";
    ringColor = "#f59e0b";
  } else {
    return <ProviderIcon provider={provider} size={size} />;
  }

  const dotSize = ringColor ? 7 : 5;
  const containerSize = size + 4;

  return (
    <View
      style={{
        width: containerSize,
        height: containerSize,
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
      }}
    >
      <ProviderIcon provider={provider} size={size} />
      <View
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          width: dotSize + (ringColor ? 2 : 0),
          height: dotSize + (ringColor ? 2 : 0),
          borderRadius: 999,
          backgroundColor: ringColor ? "transparent" : dotColor,
          borderWidth: ringColor ? 1.5 : 0,
          borderColor: ringColor ?? undefined,
        }}
      >
        <View
          style={{
            position: "absolute",
            top: ringColor ? 1 : 0,
            left: ringColor ? 1 : 0,
            right: ringColor ? 1 : 0,
            bottom: ringColor ? 1 : 0,
            borderRadius: 999,
            backgroundColor: dotColor,
          }}
        />
      </View>
    </View>
  );
}
