/**
 * Re-exports the shared pure logic so that existing web imports continue to
 * work without changes. The implementation lives in @t3tools/client-runtime so
 * it is available to web + mobile (and other clients).
 *
 * See packages/client-runtime/src/state/aiUsagePresentation.ts for the real
 * code and documentation.
 */

export {
  findUsageItem,
  formatPaceNote,
  formatResetsIn,
  formatWindowValue,
  hasUsageMarker,
  mapDriverToUsageProvider,
  resolveDriverUsage,
  resolveDriverUsages,
  type DriverUsage,
  type UsageFill,
  type UsageMarker,
  USAGE_OUTLOOK_PERCENT,
  USAGE_WARN_PERCENT,
  usageDotFillClass,
  usageDotRingColor,
  usageMarkerForItem,
  usageProviderLabel,
  usageProvidersForDriver,
  usageRank,
  worstUsagePercent,
} from "@t3tools/client-runtime/state/aiUsagePresentation";
