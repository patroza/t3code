import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useMemo } from "react";

import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import {
  isAllEnvironmentsSelected,
  isEnvironmentSelected,
  toggleEnvironmentId,
} from "./listEnvironmentFilter";

export interface ListEnvironmentFilterOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function ListEnvironmentFilterControl(props: {
  environments: readonly ListEnvironmentFilterOption[];
  selectedEnvironmentIds: readonly EnvironmentId[];
  onSelectedEnvironmentIdsChange: (next: readonly EnvironmentId[]) => void;
  /** Compact trigger for narrow sidebar; default is board/header-sized. */
  size?: "sm" | "xs";
  className?: string;
  triggerClassName?: string;
  "data-testid"?: string;
}) {
  const {
    environments,
    selectedEnvironmentIds,
    onSelectedEnvironmentIdsChange,
    size = "sm",
    className,
    triggerClassName,
  } = props;

  const allSelected = isAllEnvironmentsSelected(selectedEnvironmentIds);
  const selectedCount = selectedEnvironmentIds.length;

  const triggerLabel = useMemo(() => {
    if (allSelected || environments.length === 0) {
      return "All environments";
    }
    if (selectedCount === 1) {
      const onlyId = selectedEnvironmentIds[0];
      return (
        environments.find((environment) => environment.environmentId === onlyId)?.label ??
        "1 environment"
      );
    }
    return `${selectedCount} environments`;
  }, [allSelected, environments, selectedCount, selectedEnvironmentIds]);

  if (environments.length <= 1) {
    return null;
  }

  return (
    <div className={className}>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size={size}
              className={cn(
                "min-w-0 justify-between gap-1.5 font-normal",
                size === "xs" ? "h-7 px-2 text-xs" : "h-8 px-2.5 text-xs",
                triggerClassName,
              )}
              aria-label="Filter by environment"
              data-testid={props["data-testid"] ?? "list-environment-filter"}
            />
          }
        >
          <span className="min-w-0 flex-1 truncate text-left">{triggerLabel}</span>
          <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-60" />
        </PopoverTrigger>
        <PopoverPopup side="bottom" align="start" className="w-56" viewportClassName="p-1">
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 hover:bg-accent hover:text-foreground"
            onClick={() => onSelectedEnvironmentIdsChange([])}
          >
            <span
              className={cn(
                "inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm border border-input",
                allSelected && "border-primary bg-primary text-primary-foreground",
              )}
            >
              {allSelected ? <CheckIcon className="size-2.5" /> : null}
            </span>
            <span className="flex-1 truncate">All environments</span>
          </button>
          <div className="my-1 h-px bg-border/70" />
          {environments.map((environment) => {
            const checked = isEnvironmentSelected(
              selectedEnvironmentIds,
              environment.environmentId,
            );
            return (
              <button
                key={environment.environmentId}
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/90 hover:bg-accent hover:text-foreground"
                onClick={() => {
                  onSelectedEnvironmentIdsChange(
                    toggleEnvironmentId(selectedEnvironmentIds, environment.environmentId),
                  );
                }}
              >
                <span
                  className={cn(
                    "inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm border border-input",
                    checked && "border-primary bg-primary text-primary-foreground",
                  )}
                >
                  {checked ? <CheckIcon className="size-2.5" /> : null}
                </span>
                <span className="flex-1 truncate">{environment.label}</span>
              </button>
            );
          })}
        </PopoverPopup>
      </Popover>
    </div>
  );
}
