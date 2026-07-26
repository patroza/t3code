import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { HOME_LIST_MODE_LABELS, HOME_LIST_MODES, type HomeListMode } from "./homeListMode";

export function HomeListModeSwitcher(props: {
  readonly mode: HomeListMode;
  readonly onModeChange: (mode: HomeListMode) => void;
  readonly className?: string;
}) {
  return (
    <View
      accessibilityRole="tablist"
      className={cn("flex-row rounded-full border border-border bg-subtle p-0.5", props.className)}
    >
      {HOME_LIST_MODES.map((mode) => {
        const selected = props.mode === mode;
        return (
          <Pressable
            key={mode}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={HOME_LIST_MODE_LABELS[mode]}
            onPress={() => props.onModeChange(mode)}
            className={cn(
              "min-h-8 flex-1 items-center justify-center rounded-full px-2.5 py-1.5",
              selected ? "bg-card" : "bg-transparent",
            )}
            style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
          >
            <Text
              className={cn(
                "text-xs font-t3-medium",
                selected ? "text-foreground" : "text-foreground-muted",
              )}
            >
              {HOME_LIST_MODE_LABELS[mode]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
