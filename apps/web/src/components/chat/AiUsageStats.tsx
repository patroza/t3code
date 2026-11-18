import { T } from "gt-react";
import { useGT as useCopyTranslation } from "gt-react";
import type { AiUsageProviderStatus } from "@t3tools/contracts";

import {
  formatPaceNote,
  formatResetsIn,
  formatWindowValue,
  isEnforcedUsageWindow,
  usageMarkerForItem,
  usageProviderLabel,
} from "../../aiUsageState";
import { cn } from "~/lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";

function barColorClass(percent: number, enforced: boolean): string {
  // Extra-usage / credit pools are context, not caps: a full one is neutral.
  if (!enforced) return "bg-muted-foreground/40";
  if (percent >= 100) return "bg-destructive";
  if (percent >= 80) return "bg-warning";
  return "bg-muted-foreground/60";
}

/**
 * Per-provider usage stats: one row per rolling window with its value, reset-in
 * time and any pace warning. The default (tooltip) form shows a slim usage bar
 * per window; the `compact` form drops the bars and the plain reset lines to
 * stay small inside the model-picker menu so it never crowds out the list.
 */
export function AiUsageStats(props: {
  item: AiUsageProviderStatus;
  className?: string;
  compact?: boolean;
  nowMs?: number;
}) {
  const translateCopy = useCopyTranslation();

  const { item, compact = false } = props;
  const nowMinute = useNowMinute();
  const nowMs = props.nowMs ?? Date.parse(`${nowMinute}:00Z`);
  const marker = usageMarkerForItem(item);
  return (
    <div className={cn("flex min-w-44 flex-col", compact ? "gap-1" : "gap-1.5", props.className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{usageProviderLabel(item.provider)}</span>
        {item.plan ? (
          <span className="text-3xs uppercase tracking-wide text-muted-foreground">
            {item.plan}
          </span>
        ) : null}
      </div>
      {item.ok && item.windows.length > 0 ? (
        <div className={cn("flex flex-col", compact ? "gap-0.5" : "gap-1.5")}>
          {item.windows.map((window) => {
            const resets = formatResetsIn(window.resets_at, nowMs);
            const pace = formatPaceNote(window);
            const enforced = isEnforcedUsageWindow(window);
            // In compact mode only surface a sub-line when there's a pace
            // warning worth acting on; plain reset times stay in the hover form.
            const showSubLine = compact ? Boolean(pace) : Boolean(resets || pace);
            return (
              <div key={window.id} className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{window.label}</span>
                  <span className={cn("tabular-nums", !enforced && "text-muted-foreground")}>
                    {formatWindowValue(window)}
                  </span>
                </div>
                {!compact && typeof window.percent === "number" ? (
                  <div className="h-1 w-full overflow-hidden rounded-full bg-muted-foreground/15">
                    <div
                      className={cn("h-full rounded-full", barColorClass(window.percent, enforced))}
                      style={{ width: `${Math.max(0, Math.min(100, window.percent))}%` }}
                    />
                  </div>
                ) : null}
                {showSubLine ? (
                  <div className="text-3xs text-muted-foreground">
                    {resets ? translateCopy("resets in {value0}", { value0: resets }) : null}
                    {resets && pace ? " · " : null}
                    {pace}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-3xs text-muted-foreground">
          {item.error ?? translateCopy("usage unavailable")}
        </div>
      )}
      {item.stale ? (
        <div className="text-3xs text-muted-foreground">
          <T>Stale. Showing last known usage</T>
        </div>
      ) : null}
      {marker.fill === "critical" ? (
        <div className="text-3xs font-medium text-destructive">
          <T>limit reached</T>
        </div>
      ) : marker.fill === "warn" ? (
        <div className="text-3xs font-medium text-warning">
          <T>close to limit</T>
        </div>
      ) : marker.outlookAtRisk ? (
        <div className="text-3xs font-medium text-warning">
          <T>usable now · weekly on track to overshoot</T>
        </div>
      ) : null}
    </div>
  );
}
