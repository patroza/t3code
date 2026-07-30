import { identityAvatar } from "@t3tools/shared/identityAvatar";
import { cn } from "~/lib/utils";

export function IdentityAvatar(props: {
  readonly personId?: string | null | undefined;
  readonly username?: string | null | undefined;
  readonly name?: string | null | undefined;
  readonly size?: "micro" | "sm" | "md";
  readonly className?: string;
  /** `null` suppresses the native title when a parent owns richer tooltip content. */
  readonly title?: string | null;
}) {
  const model = identityAvatar({
    personId: props.personId,
    username: props.username,
    name: props.name,
  });
  const sizeClass =
    props.size === "md"
      ? "size-7 text-[11px]"
      : props.size === "sm"
        ? "size-6 text-[10px]"
        : "size-3.5 text-[8px]";

  const title = props.title === null ? undefined : (props.title ?? model.label);

  return (
    <span
      aria-hidden={title === undefined}
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-tight select-none",
        sizeClass,
        props.className,
      )}
      style={{ backgroundColor: model.backgroundColor, color: model.color }}
    >
      {model.initials}
    </span>
  );
}
