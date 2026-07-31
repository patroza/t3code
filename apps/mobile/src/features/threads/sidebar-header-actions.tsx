import { SymbolView } from "../../components/AppSymbol";
import { Pressable, StyleSheet, View, useColorScheme } from "react-native";

import { useThemeColor } from "../../lib/useThemeColor";
import {
  HOME_LIST_MODE_ICONS,
  HOME_LIST_MODE_LABELS,
  otherHomeListModes,
  type HomeListMode,
} from "../home/homeListMode";

export interface SidebarHeaderActionsProps {
  readonly onOpenSettings: () => void;
  readonly listMode: HomeListMode;
  readonly onListModeChange: (mode: HomeListMode) => void;
  /** Rendered inside a shared capsule group — buttons drop their own chrome. */
  readonly grouped?: boolean;
}

function FallbackHeaderButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: string;
  readonly grouped?: boolean;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-foreground");
  const pressedBackgroundColor = useThemeColor("--color-subtle");
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const idleBackgroundColor =
    colorScheme === "dark" ? "rgba(118,118,128,0.24)" : "rgba(255,255,255,0.72)";
  const borderColor = colorScheme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";

  return (
    <Pressable
      className="h-11 w-[50px] items-center justify-center rounded-[22px]"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
      onPress={props.onPress}
      style={({ pressed }) => [
        props.grouped
          ? { backgroundColor: pressed ? pressedBackgroundColor : "transparent", borderWidth: 0 }
          : {
              backgroundColor: pressed ? pressedBackgroundColor : idleBackgroundColor,
              borderColor,
              borderWidth: StyleSheet.hairlineWidth,
            },
      ]}
    >
      <SymbolView name={props.icon as never} size={20} tintColor={iconColor} type="monochrome" />
    </Pressable>
  );
}

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  const alternateModes = otherHomeListModes(props.listMode);
  return (
    <View className="flex-row items-center gap-0.5">
      {alternateModes.map((mode) => (
        <FallbackHeaderButton
          key={mode}
          accessibilityLabel={HOME_LIST_MODE_LABELS[mode]}
          grouped={props.grouped}
          icon={HOME_LIST_MODE_ICONS[mode]}
          onPress={() => props.onListModeChange(mode)}
        />
      ))}
      <FallbackHeaderButton
        accessibilityLabel="Open settings"
        grouped={props.grouped}
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
    </View>
  );
}
