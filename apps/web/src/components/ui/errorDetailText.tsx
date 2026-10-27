"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

/** Long bodies get a responsive clamp in-card; shorter text stays fully visible. */
export const ERROR_DETAIL_CLAMP_MIN_CHARS = 120;

export const ERROR_DETAIL_TOOLTIP_CLASS =
  "max-w-[min(calc(var(--available-width)-1rem),36rem)] whitespace-pre-wrap text-xs leading-relaxed";

export function errorDetailShouldClamp(
  text: string,
  minChars = ERROR_DETAIL_CLAMP_MIN_CHARS,
): boolean {
  return text.length >= minChars;
}

export function errorDetailClampClassName(shouldClamp: boolean): string | undefined {
  if (!shouldClamp) {
    return undefined;
  }
  return "line-clamp-4 sm:line-clamp-6 lg:line-clamp-[10]";
}

export function ErrorDetailCopyButton({ text, className }: { text: string; className?: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "error-message" });
  const label = isCopied ? "Copied error" : "Copy error";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={label}
            className={cn(
              "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md p-0 text-muted-foreground/80 transition-colors hover:bg-muted/40 hover:text-muted-foreground",
              className,
            )}
            onClick={() => copyToClipboard(text)}
            type="button"
          />
        }
      >
        {isCopied ? (
          <CheckIcon className="size-3.5 text-success" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function ErrorDetailText({
  text,
  className,
  textClassName,
  showCopy = true,
  tooltipSide = "top",
}: {
  text: string;
  className?: string;
  textClassName?: string;
  showCopy?: boolean;
  tooltipSide?: "top" | "bottom" | "left" | "right";
}) {
  const shouldClamp = errorDetailShouldClamp(text);
  const clampClassName = errorDetailClampClassName(shouldClamp);

  const body: ReactNode = (
    <span
      className={cn(
        "min-w-0 whitespace-pre-wrap wrap-break-word text-sm leading-relaxed",
        clampClassName,
        textClassName,
      )}
    >
      {text}
    </span>
  );

  const textBlock = shouldClamp ? (
    <Tooltip>
      <TooltipTrigger render={<div className="min-w-0 flex-1 cursor-default" />}>
        {body}
      </TooltipTrigger>
      <TooltipPopup side={tooltipSide} className={ERROR_DETAIL_TOOLTIP_CLASS}>
        {text}
      </TooltipPopup>
    </Tooltip>
  ) : (
    <div className="min-w-0 flex-1">{body}</div>
  );

  if (!showCopy) {
    return <div className={cn("min-w-0", className)}>{textBlock}</div>;
  }

  return (
    <div className={cn("flex min-w-0 items-start gap-2", className)}>
      {textBlock}
      <ErrorDetailCopyButton className="mt-0.5" text={text} />
    </div>
  );
}
