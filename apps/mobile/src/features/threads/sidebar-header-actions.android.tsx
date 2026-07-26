import { View } from "react-native";

import { T3HeaderButton } from "../../native/T3HeaderButton.android";
import type { SidebarHeaderActionsProps } from "./sidebar-header-actions";

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  return (
    <View className="h-11 flex-row gap-1">
      {props.onOpenBoard ? (
        <T3HeaderButton
          accessibilityLabel="Open board"
          icon="square.split.2x1"
          onPress={props.onOpenBoard}
        />
      ) : null}
      <T3HeaderButton
        accessibilityLabel="Open settings"
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
    </View>
  );
}
