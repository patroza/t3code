import { View } from "react-native";

import { T3HeaderButton } from "../../native/T3HeaderButton.android";
import {
  HOME_LIST_MODE_ICONS,
  HOME_LIST_MODE_LABELS,
  otherHomeListModes,
} from "../home/homeListMode";
import type { SidebarHeaderActionsProps } from "./sidebar-header-actions";

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  const alternateModes = otherHomeListModes(props.listMode);
  return (
    <View className="h-11 flex-row gap-1">
      {alternateModes.map((mode) => (
        <T3HeaderButton
          key={mode}
          accessibilityLabel={HOME_LIST_MODE_LABELS[mode]}
          icon={HOME_LIST_MODE_ICONS[mode] as never}
          onPress={() => props.onListModeChange(mode)}
        />
      ))}
      <T3HeaderButton
        accessibilityLabel="Open settings"
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
    </View>
  );
}
