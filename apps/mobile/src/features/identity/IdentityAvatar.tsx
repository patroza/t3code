import { identityAvatar } from "@t3tools/shared/identityAvatar";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

/**
 * Generated initials chip for identity map people (same palette as web).
 */
export function IdentityAvatar(props: {
  readonly personId?: string | null | undefined;
  readonly username?: string | null | undefined;
  readonly name?: string | null | undefined;
  readonly size?: "micro" | "sm" | "md";
  readonly className?: string;
  readonly highlighted?: boolean;
}) {
  const model = identityAvatar({
    personId: props.personId,
    username: props.username,
    name: props.name,
  });
  const size = props.size ?? "micro";
  const box = size === "md" ? "size-7" : size === "sm" ? "size-6" : "size-3.5";
  const text = size === "md" ? "text-[11px]" : size === "sm" ? "text-[10px]" : "text-[8px]";

  return (
    <View
      accessibilityLabel={model.label}
      className={cn(
        "shrink-0 items-center justify-center rounded-full",
        box,
        props.highlighted && "bg-primary",
        props.className,
      )}
      style={props.highlighted ? undefined : { backgroundColor: model.backgroundColor }}
    >
      <Text
        className={cn("font-t3-bold", text, props.highlighted && "text-primary-foreground")}
        style={props.highlighted ? undefined : { color: model.color }}
      >
        {model.initials}
      </Text>
    </View>
  );
}
