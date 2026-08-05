// Migration 36 was skipped when pre-restack databases had already recorded
// SessionIdentityClaims as migration 36. Those databases reached migration 38
// before the collision was detected, so replay the idempotent schema change.
export { default } from "./036_ProjectionThreadsPinned.ts";
