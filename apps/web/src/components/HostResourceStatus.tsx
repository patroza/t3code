import { getHostResourcePressure } from "@t3tools/client-runtime/state/hostResourcePresentation";
import type { EnvironmentId } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useHostResourceSnapshot } from "../hooks/useHostResourceSnapshot";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

function formatBytes(value: number | null): string {
  if (value === null) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let scaled = value;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled.toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

function pressureClass(pressure: ReturnType<typeof getHostResourcePressure>): string {
  if (pressure === "critical") return "text-destructive";
  if (pressure === "warning") return "text-warning";
  return "text-muted-foreground";
}

export function HostResourceStatus(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
  readonly showRefresh?: boolean;
  readonly unavailableLabel?: boolean;
  readonly showHostname?: boolean;
  readonly className?: string;
}) {
  const { data, error, isPending, refresh } = useHostResourceSnapshot(
    props.environmentId,
    props.connected,
  );
  if (!props.connected) return null;

  if (!data || data.status === "unavailable") {
    if (!props.unavailableLabel) return null;
    return (
      <div
        className={cn(
          "flex items-center gap-1.5 text-[10px] text-muted-foreground",
          props.className,
        )}
      >
        <span>{isPending ? "Reading host resources…" : "Host resources unavailable"}</span>
        {props.showRefresh ? (
          <button
            type="button"
            aria-label={`Refresh host resources for ${props.environmentLabel}`}
            className="inline-flex size-5 items-center justify-center rounded hover:bg-accent hover:text-foreground"
            onClick={refresh}
          >
            <RefreshCwIcon className={cn("size-3", isPending && "animate-spin")} />
          </button>
        ) : null}
      </div>
    );
  }

  const tone = pressureClass(getHostResourcePressure(data));
  const loadOne = data.loadAverage?.m1 ?? null;
  const summary = (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-[10px] tabular-nums",
        tone,
      )}
    >
      {props.showHostname ? (
        <>
          <span className="max-w-24 truncate font-sans">
            {data.hostname ?? props.environmentLabel}
          </span>
          <span aria-hidden>·</span>
        </>
      ) : null}
      <span>CPU {formatPercent(data.cpuPercent)}</span>
      <span aria-hidden>·</span>
      <span>MEM {formatPercent(data.memoryUsedPercent)}</span>
      <span aria-hidden>·</span>
      <span>LOAD {loadOne === null ? "—" : loadOne.toFixed(1)}</span>
    </span>
  );

  return (
    <div className={cn("flex min-w-0 items-center gap-1", props.className)}>
      <Tooltip>
        <TooltipTrigger render={summary} />
        <TooltipPopup side="bottom" className="max-w-80 p-2 text-xs">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <span className="text-muted-foreground">Host</span>
            <span>{data.hostname ?? props.environmentLabel}</span>
            <span className="text-muted-foreground">CPU</span>
            <span>
              {formatPercent(data.cpuPercent)} across {data.logicalCores ?? "—"} logical cores
            </span>
            <span className="text-muted-foreground">Memory</span>
            <span>
              {formatBytes(data.memoryUsedBytes)} / {formatBytes(data.memoryTotalBytes)} used
            </span>
            <span className="text-muted-foreground">Load</span>
            <span>
              {data.loadAverage
                ? `${data.loadAverage.m1.toFixed(2)} / ${data.loadAverage.m5.toFixed(2)} / ${data.loadAverage.m15.toFixed(2)}`
                : "—"}
            </span>
            <span className="text-muted-foreground">Updated</span>
            <span>{new Date(data.checkedAt).toLocaleTimeString()}</span>
          </div>
        </TooltipPopup>
      </Tooltip>
      {props.showRefresh ? (
        <button
          type="button"
          aria-label={`Refresh host resources for ${props.environmentLabel}`}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={refresh}
        >
          <RefreshCwIcon className={cn("size-3", isPending && "animate-spin")} />
        </button>
      ) : null}
      {error ? <span className="sr-only">{error}</span> : null}
    </div>
  );
}
