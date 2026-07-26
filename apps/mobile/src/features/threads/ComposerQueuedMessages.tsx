import type { MessageId } from "@t3tools/contracts";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { deriveQueuedMessageControls } from "../../lib/threadActivity";
import { useThemeColor } from "../../lib/useThemeColor";

export interface ComposerQueueItem {
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachmentCount: number;
  readonly deliveryState: "waiting" | "sending" | "queued";
  readonly queueSource: "local" | "server";
}

/**
 * Server + local outbox follow-ups, sticky above the keyboard composer
 * (web QueuedMessageChips parity — not timeline rows).
 */
export function ComposerQueuedMessages(props: {
  readonly items: ReadonlyArray<ComposerQueueItem>;
  readonly disabled?: boolean;
  readonly onSteer: (messageId: MessageId) => void;
  readonly onEdit: (messageId: MessageId, source: "local" | "server") => void;
}) {
  const iconMuted = useThemeColor("--color-icon-muted");
  const accent = useThemeColor("--color-accent");

  if (props.items.length === 0) {
    return null;
  }

  return (
    <View className="gap-1.5 px-3 pb-2">
      {props.items.map((item) => {
        const controls = deriveQueuedMessageControls(item.deliveryState, item.queueSource);
        const preview =
          item.text.trim().length > 0
            ? item.text.trim()
            : item.attachmentCount > 0
              ? `${item.attachmentCount} attachment${item.attachmentCount === 1 ? "" : "s"}`
              : "Empty message";
        const statusLabel =
          item.deliveryState === "sending"
            ? "Sending"
            : item.deliveryState === "waiting"
              ? "Waiting for connection"
              : "Queued";

        return (
          <View
            key={item.messageId}
            className="flex-row items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2"
          >
            <SymbolView
              name="arrow.turn.left.up"
              size={14}
              tintColor={iconMuted}
              type="monochrome"
            />
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-sm text-foreground" numberOfLines={2}>
                {preview}
              </Text>
              <View className="flex-row items-center gap-1.5">
                {item.deliveryState === "sending" ? (
                  <ActivityIndicator size="small" color={iconMuted} />
                ) : null}
                <Text className="text-3xs font-t3-medium text-foreground-muted">{statusLabel}</Text>
              </View>
            </View>
            {controls.canSteer ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send queued message now"
                disabled={props.disabled}
                hitSlop={6}
                onPress={() => props.onSteer(item.messageId)}
                className="min-h-8 justify-center rounded-full px-2"
                style={{ opacity: props.disabled ? 0.45 : 1 }}
              >
                <Text className="text-xs font-t3-semibold" style={{ color: accent }}>
                  Send now
                </Text>
              </Pressable>
            ) : null}
            {controls.canRemove ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Edit queued message"
                disabled={props.disabled}
                hitSlop={6}
                onPress={() => props.onEdit(item.messageId, item.queueSource)}
                className="size-8 items-center justify-center rounded-full"
                style={{ opacity: props.disabled ? 0.45 : 1 }}
              >
                <SymbolView
                  name="square.and.pencil"
                  size={15}
                  tintColor={accent}
                  type="monochrome"
                />
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
