import {
  type AiUsageSnapshot,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { memo, useEffect, useMemo, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { resolveDriverUsage, usageDotFillClass, usageDotRingColor } from "../../aiUsageState";
import { AiUsageStats } from "./AiUsageStats";
import { ModelPickerContent } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  ModelEsque,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
} from "./providerIconUtils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useClientSettings } from "~/hooks/useSettings";

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  /**
   * The instance currently selected in the composer. Drives the trigger
   * icon, label and the default-highlighted combobox row.
   */
  activeInstanceId: ProviderInstanceId;
  model: string;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /** Instance entries rendered in the sidebar + used to resolve display name. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** Latest AI-usage snapshot for status markers + hover stats. */
  usageSnapshot?: AiUsageSnapshot | null;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  terminalOpen?: boolean;
  open?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  onOpenChange?: (open: boolean) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;
  const favoriteProviderIds = useClientSettings((settings) => settings.providerFavorites ?? []);
  const orderedInstanceEntries = useMemo(() => {
    const favorites = new Set(favoriteProviderIds);
    return props.instanceEntries
      .map((entry, index) => ({ entry, index, favorite: favorites.has(entry.instanceId) }))
      .toSorted(
        (left, right) => Number(right.favorite) - Number(left.favorite) || left.index - right.index,
      )
      .map(({ entry }) => entry);
  }, [favoriteProviderIds, props.instanceEntries]);

  // Resolve the active instance entry by exact routing key. The composer
  // resolves fallbacks before rendering this component; if the selected
  // instance disappears, do not infer a replacement from its driver kind.
  const activeEntry = useMemo(() => {
    return (
      orderedInstanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null
    );
  }, [props.activeInstanceId, orderedInstanceEntries]);

  const activeInstanceId = props.activeInstanceId;
  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? [];
  // If the current slug belongs to a different instance (for example after
  // a provider switch or disable), prefer the active instance's first
  // option so the trigger icon and label stay in sync instead of showing
  // a stale foreign slug.
  const selectedModel =
    selectedInstanceOptions.find((option) => option.slug === props.model) ??
    selectedInstanceOptions[0];
  const triggerTitle = selectedModel ? getTriggerDisplayModelName(selectedModel) : props.model;
  const triggerLabel = selectedModel ? getTriggerDisplayModelLabel(selectedModel) : props.model;
  const duplicateDriverCount = orderedInstanceEntries.filter(
    (entry) => activeEntry !== null && entry.driverKind === activeEntry.driverKind,
  ).length;
  const showInstanceBadge = Boolean(activeEntry?.accentColor) || duplicateDriverCount > 1;
  const activeUsage = useMemo(
    () => resolveDriverUsage(props.usageSnapshot, activeEntry?.driverKind ?? null, props.model),
    [props.usageSnapshot, activeEntry, props.model],
  );

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
  };

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const { documentElement, body } = document;
    const previousDocumentOverscrollBehavior = documentElement.style.overscrollBehavior;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;

    documentElement.style.overscrollBehavior = "contain";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const shouldAllowOverlayScroll = (target: EventTarget | null) => {
      return target instanceof Element && target.closest("[data-model-picker-content]");
    };
    const preventBackgroundWheel = (event: WheelEvent) => {
      if (shouldAllowOverlayScroll(event.target)) {
        return;
      }
      event.preventDefault();
    };
    const preventBackgroundTouchMove = (event: TouchEvent) => {
      if (shouldAllowOverlayScroll(event.target)) {
        return;
      }
      event.preventDefault();
    };

    document.addEventListener("wheel", preventBackgroundWheel, { capture: true, passive: false });
    document.addEventListener("touchmove", preventBackgroundTouchMove, {
      capture: true,
      passive: false,
    });

    return () => {
      document.removeEventListener("wheel", preventBackgroundWheel, { capture: true });
      document.removeEventListener("touchmove", preventBackgroundTouchMove, { capture: true });
      documentElement.style.overscrollBehavior = previousDocumentOverscrollBehavior;
      body.style.overflow = previousBodyOverflow;
      body.style.paddingRight = previousBodyPaddingRight;
    };
  }, [isMenuOpen]);

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    props.onInstanceModelChange(instanceId, model);
    setIsMenuOpen(false);
  };

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 justify-between whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80",
              props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56 sm:px-3",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {activeEntry
            ? (() => {
                const activeDotClass = activeUsage
                  ? usageDotFillClass(activeUsage.marker)
                  : undefined;
                const activeRingColor = activeUsage
                  ? usageDotRingColor(activeUsage.marker)
                  : undefined;
                const providerIcon = (
                  <ProviderInstanceIcon
                    driverKind={activeEntry.driverKind}
                    displayName={activeEntry.displayName}
                    accentColor={activeEntry.accentColor}
                    showBadge={showInstanceBadge}
                    className={showInstanceBadge ? "size-5" : "size-4"}
                    iconClassName={cn("size-4", props.activeProviderIconClassName)}
                    indicatorBackground="var(--input)"
                    badgeClassName={cn(
                      "right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3",
                      "px-0.5 text-[7px]",
                    )}
                    {...(activeDotClass ? { statusDotClassName: activeDotClass } : {})}
                    {...(activeRingColor ? { statusDotRingColor: activeRingColor } : {})}
                  />
                );
                return activeUsage ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                      {providerIcon}
                    </TooltipTrigger>
                    <TooltipPopup side="top" className="p-2 text-xs">
                      <AiUsageStats item={activeUsage.item} />
                    </TooltipPopup>
                  </Tooltip>
                ) : (
                  providerIcon
                );
              })()
            : null}
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 overflow-hidden truncate" />}>
              {triggerTitle}
            </TooltipTrigger>
            <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
          </Tooltip>
        </span>
        <span aria-hidden="true" className="flex items-center">
          <ChevronDownIcon aria-hidden="true" className="!ms-0 !-me-1 size-3 shrink-0 opacity-60" />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="border-0 bg-transparent p-0 shadow-none before:hidden [--viewport-inline-padding:0]"
        viewportClassName="!overflow-hidden p-0"
      >
        <ModelPickerContent
          activeInstanceId={activeInstanceId}
          model={props.model}
          lockedProvider={props.lockedProvider}
          lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
          instanceEntries={orderedInstanceEntries}
          usageSnapshot={props.usageSnapshot ?? null}
          {...(props.keybindings ? { keybindings: props.keybindings } : {})}
          modelOptionsByInstance={props.modelOptionsByInstance}
          terminalOpen={props.terminalOpen ?? false}
          onRequestClose={() => setIsMenuOpen(false)}
          {...(props.getModelDisabledReason
            ? { getModelDisabledReason: props.getModelDisabledReason }
            : {})}
          onInstanceModelChange={handleInstanceModelChange}
        />
      </PopoverPopup>
    </Popover>
  );
});
