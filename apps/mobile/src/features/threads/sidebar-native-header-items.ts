import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
} from "@react-navigation/native-stack";

import type { HomeListFilterMenu } from "../home/home-list-filter-menu";
import {
  HOME_LIST_MODE_ICONS,
  HOME_LIST_MODE_LABELS,
  otherHomeListModes,
  type HomeListMode,
} from "../home/homeListMode";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

type NativeHeaderMenuItems = NativeStackHeaderItemMenu["menu"]["items"];
type NativeHeaderIcon = NonNullable<Extract<NativeStackHeaderItem, { type: "button" }>["icon"]>;

function sfSymbolIcon(name: string): NativeHeaderIcon {
  return { type: "sfSymbol", name: name as never };
}

function toNativeHeaderMenuItems(items: HomeListFilterMenu["items"]): NativeHeaderMenuItems {
  return items.map((item) =>
    item.type === "action"
      ? {
          type: "action" as const,
          label: item.title,
          description: item.subtitle,
          onPress: item.onPress,
          state: item.state === "on" ? ("on" as const) : undefined,
        }
      : {
          type: "submenu" as const,
          label: item.title,
          items: toNativeHeaderMenuItems(item.items),
        },
  );
}

/**
 * Right-side UINavigationBar items for the sidebar column: filter/sort menu,
 * the two alternate list-mode icons (Recent / Projects / Board), and settings.
 */
export function createSidebarHeaderItems(input: {
  readonly filterIcon: string;
  readonly filterMenu: HomeListFilterMenu;
  readonly listMode: HomeListMode;
  readonly onListModeChange: (mode: HomeListMode) => void;
  readonly onOpenSettings: () => void;
}): NativeStackHeaderItem[] {
  const alternateModes = otherHomeListModes(input.listMode);
  return [
    withNativeGlassHeaderItem({
      type: "menu",
      label: "",
      accessibilityLabel: "Filter and sort threads",
      icon: sfSymbolIcon(input.filterIcon),
      menu: {
        title: input.filterMenu.title,
        items: toNativeHeaderMenuItems(input.filterMenu.items),
      },
    }),
    ...alternateModes.map((mode) =>
      withNativeGlassHeaderItem({
        type: "button" as const,
        label: "",
        accessibilityLabel: HOME_LIST_MODE_LABELS[mode],
        icon: sfSymbolIcon(HOME_LIST_MODE_ICONS[mode]),
        onPress: () => input.onListModeChange(mode),
      }),
    ),
    withNativeGlassHeaderItem({
      type: "button",
      label: "",
      accessibilityLabel: "Open settings",
      icon: sfSymbolIcon("gearshape"),
      onPress: input.onOpenSettings,
    }),
  ];
}
