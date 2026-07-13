import {
  getHostResourcePressure,
  getHostResourceRatioPressure,
  type HostResourcePressure,
} from "@t3tools/client-runtime/state/hostResourcePresentation";
import type { EnvironmentId } from "@t3tools/contracts";
import { CloudIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

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

function pressureClass(pressure: HostResourcePressure): string {
  if (pressure === "critical") return "text-destructive";
  if (pressure === "warning") return "text-warning";
  return "text-muted-foreground";
}

function meterFillClass(pressure: HostResourcePressure): string {
  if (pressure === "critical") return "bg-destructive";
  if (pressure === "warning") return "bg-warning";
  return "bg-muted-foreground";
}

function ResourceMetric(props: {
  readonly label: string;
  readonly value: string;
  readonly ratio: number | null;
  readonly description: string;
  readonly valueWidthClass?: string;
}) {
  const ratio = props.ratio === null ? 0 : Math.min(1, Math.max(0, props.ratio));
  const pressure = getHostResourceRatioPressure(ratio);
  return (
    <span
      className={cn("inline-flex items-center gap-1", pressureClass(pressure))}
      aria-label={props.description}
    >
      <span className="relative h-2.5 w-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span
          className={cn("absolute inset-x-0 bottom-0 rounded-full", meterFillClass(pressure))}
          style={{ height: `${ratio * 100}%` }}
        />
      </span>
      <span className="w-[1ch]">{props.label}</span>
      <span className={cn("w-[4ch] text-right", props.valueWidthClass)}>{props.value}</span>
    </span>
  );
}

export function HostResourceStatus(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
  readonly showRefresh?: boolean;
  readonly unavailableLabel?: boolean;
  readonly remote?: boolean;
  readonly className?: string;
}) {
  const { data, error, isPending, refresh } = useHostResourceSnapshot(
    props.environmentId,
    props.connected,
  );
  const liveRefreshInterval = useRef<number | null>(null);
  const stopLiveRefresh = useCallback(() => {
    if (liveRefreshInterval.current === null) return;
    window.clearInterval(liveRefreshInterval.current);
    liveRefreshInterval.current = null;
  }, []);
  const startLiveRefresh = useCallback(() => {
    if (!props.connected || liveRefreshInterval.current !== null) return;
    refresh();
    liveRefreshInterval.current = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 1_000);
  }, [props.connected, refresh]);
  useEffect(() => stopLiveRefresh, [stopLiveRefresh]);
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

  const loadOne = data.loadAverage?.m1 ?? null;
  const loadRatio = loadOne !== null && data.logicalCores ? loadOne / data.logicalCores : null;
  const summary = (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-[10px] tabular-nums",
        pressureClass(getHostResourcePressure(data)),
      )}
    >
      <ResourceMetric
        label="C"
        value={formatPercent(data.cpuPercent)}
        ratio={data.cpuPercent === null ? null : data.cpuPercent / 100}
        description={`CPU ${formatPercent(data.cpuPercent)}`}
      />
      <span aria-hidden>·</span>
      <ResourceMetric
        label="M"
        value={formatPercent(data.memoryUsedPercent)}
        ratio={data.memoryUsedPercent === null ? null : data.memoryUsedPercent / 100}
        description={`Memory ${formatPercent(data.memoryUsedPercent)}`}
      />
      <span aria-hidden>·</span>
      <ResourceMetric
        label="L"
        value={loadOne === null ? "—" : loadOne.toFixed(1)}
        ratio={loadRatio}
        description={`Load ${loadOne === null ? "unavailable" : loadOne.toFixed(1)}`}
        valueWidthClass="w-[5ch]"
      />
    </span>
  );

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1 [-webkit-app-region:no-drag]",
        props.className,
      )}
      onPointerEnter={startLiveRefresh}
      onPointerLeave={stopLiveRefresh}
    >
      {props.remote ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className={cn(
                  "inline-flex shrink-0 text-muted-foreground",
                  pressureClass(getHostResourcePressure(data)),
                )}
                aria-label={`Remote host: ${data.hostname ?? props.environmentLabel}`}
              >
                <CloudIcon className="size-3" aria-hidden />
              </span>
            }
          />
          <TooltipPopup side="bottom">{data.hostname ?? props.environmentLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
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
