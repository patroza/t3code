import { SymbolView } from "../../components/AppSymbol";
import { Pressable, View } from "react-native";

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
}

function FallbackHeaderButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: string;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-foreground");

  return (
    <Pressable
      className="size-11 items-center justify-center rounded-full bg-subtle active:opacity-70"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
      onPress={props.onPress}
    >
      <SymbolView name={props.icon as never} size={18} tintColor={iconColor} type="monochrome" />
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
          icon={HOME_LIST_MODE_ICONS[mode]}
          onPress={() => props.onListModeChange(mode)}
        />
      ))}
      <FallbackHeaderButton
        accessibilityLabel="Open settings"
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
    </View>
  );
}
